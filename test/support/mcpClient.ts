// MCP clients for the tests and scripts: the only test or script module that imports the SDK (C5). `connectInMemory` links a
// client to a `createServer` result in-process; `connectStdioClient` spawns a server process (the bundle, or the entry point under
// tsx) and talks to it over stdio, collecting its stderr and its transport errors (the lines on its stdout that are not JSON-RPC).
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, type Server } from "@modelcontextprotocol/server";

/** The part of the SDK client the tests use. */
export interface McpClientLike {
  /** The serverInfo of the initialize result. */
  getServerVersion(): { name: string; version: string } | undefined;
  /** The instructions of the initialize result. */
  getInstructions(): string | undefined;
  listTools(): Promise<{ tools: { name: string; title?: string; description?: string; inputSchema: unknown; annotations?: unknown }[] }>;
  callTool(
    p: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
}

const CLIENT_INFO = { name: "lesswrong-mcp-test", version: "1.0.0" };

/** A client connected to `server` (a `createServer` result) over an in-memory transport pair; `close` closes both sides. */
export async function connectInMemory(server: unknown): Promise<{ client: McpClientLike; close(): Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO);
  await (server as Server).connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await (server as Server).close();
    },
  };
}

/**
 * The SDK's stdio transport with a tap on the child's stdout that reports every line that is not JSON. The SDK's read buffer
 * skips such a line without a word (a stray console.log of the server or of a dependency), yet ¶9.4 fails any output on
 * stdout other than JSON-RPC. A line that is JSON but not a JSON-RPC message the SDK reports itself, through `onerror`.
 * Blank lines are not output. A last line without its newline is checked when stdout ends.
 */
class TappedStdioTransport extends StdioClientTransport {
  private readonly reportStray: (message: string) => void;

  constructor(params: StdioServerParameters, reportStray: (message: string) => void) {
    super(params);
    this.reportStray = reportStray;
  }

  override async start(): Promise<void> {
    await super.start();
    // The child's stdout has no public accessor (its stderr has), and no data can have arrived before this continuation.
    const stdout = (this as unknown as { _process?: { stdout: Readable | null } })._process?.stdout;
    if (!stdout) return;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const check = (line: string): void => {
      if (line.trim() === "") return;
      try {
        JSON.parse(line);
      } catch (e) {
        this.reportStray(e instanceof Error ? e.message : String(e));
      }
    };
    stdout.on("data", (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) check(line.replace(/\r$/, ""));
    });
    stdout.on("end", () => check(pending + decoder.end()));
  }
}

/**
 * A client of the server process `command args`, spawned with `env` on top of the SDK's safe default environment.
 * `stderr()` is everything the process wrote to stderr so far; `transportErrors()` lists every error of the client
 * transport so far: each line on the server's stdout that is not a JSON-RPC message (the smoke test of the bundle checks
 * that there is none) and any other error the transport reports.
 */
export async function connectStdioClient(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ client: McpClientLike; close(): Promise<void>; stderr(): string; transportErrors(): string[] }> {
  const errors: string[] = [];
  const transport = new TappedStdioTransport({ command, args, env, stderr: "pipe" }, (message) => errors.push(message));
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client(CLIENT_INFO);
  client.onerror = (e) => {
    errors.push(e instanceof Error ? e.message : String(e));
  };
  try {
    await client.connect(transport);
  } catch (e) {
    // A server that dies before it answers surfaces only as "Connection closed"; its stderr says why.
    if (e instanceof Error && stderr.trim() !== "") throw new Error(`${e.message}\nthe server's stderr:\n${stderr.trim()}`, { cause: e });
    throw e;
  }
  return {
    client,
    close: () => client.close(),
    stderr: () => stderr,
    transportErrors: () => [...errors],
  };
}
