// Offline smoke test of the bundle (¶9.4, ¶10): starts the packed build/bundle/server/index.mjs with Node over stdio, with
// LESSWRONG_MCP_FETCH_TRIPWIRE=1 so that no forum request is possible, and checks what the extension's host would see: the same 16
// tool names as the manifest, every description ending with the conventions line, the wording of one `bad_input` reply,
// nothing but JSON-RPC on stdout, and the Node version line on stderr. Exits non-zero on any failure. Run from the repository
// root after `npm run pack` (npm run smoke). Imported by the tests for smokeChecks; the session runs only as the entry module.
import { existsSync, readFileSync } from "node:fs";
import { ENV_VARS } from "../src/config";
import { LOG_PREFIX } from "../src/log";
import { CONVENTIONS_LINE } from "../src/params/vocabulary";
import { isEntryModule } from "../test/support/entry";
import { connectStdioClient, type McpClientLike } from "../test/support/mcpClient";

const BUNDLE = "build/bundle/server/index.mjs";
/** The reply to `get_post {post: "a title, not an id"}` starts with this: the identifier rule (ids/parse.ts) refuses a title before any request. */
const BAD_INPUT_PREFIX = "Error (bad_input): post: ";
/** The line `src/index.ts` writes to stderr once: the log prefix, then `process.version`. */
const VERSION_LINE_RE = new RegExp(LOG_PREFIX.replace(/[[\]]/g, "\\$&") + "node v\\d+\\.\\d+\\.\\d+");

export interface SmokeInput {
  tools: { name: string; description?: string }[];
  manifestTools: string[];
  call: { isError?: boolean; text: string };
  stderr: string;
  transportErrors: string[];
}

/** The failures of one smoke session, one line each and in the order of the checks; empty when the session is healthy. */
export function smokeChecks(input: SmokeInput): string[] {
  const failures: string[] = [];
  const names = input.tools.map((t) => t.name);
  if (names.length !== input.manifestTools.length || names.some((name, i) => name !== input.manifestTools[i])) {
    failures.push("tools: the server's tool names differ from the manifest's");
  }
  for (const tool of input.tools) {
    if (!(tool.description ?? "").endsWith("\n\n" + CONVENTIONS_LINE)) {
      failures.push(`description: ${tool.name} does not end with the conventions line`);
    }
  }
  if (input.call.isError !== true || !input.call.text.startsWith(BAD_INPUT_PREFIX)) {
    failures.push(`bad_input: expected an isError reply starting ${JSON.stringify(BAD_INPUT_PREFIX)}, got ${JSON.stringify(input.call.text.slice(0, 80))}`);
  }
  if (input.transportErrors.length > 0) {
    failures.push(`stdout: ${input.transportErrors.length} outputs that are not JSON-RPC (first: ${input.transportErrors[0]})`);
  }
  if (!VERSION_LINE_RE.test(input.stderr)) {
    failures.push(`stderr: no "${LOG_PREFIX}node v<x.y.z>" line`);
  }
  return failures;
}

/** Runs the smoke session against the packed bundle; resolves to the process exit code (0 when every check passes). */
export async function main(): Promise<number> {
  if (!existsSync(BUNDLE)) {
    console.error(`smoke: ${BUNDLE} is missing; run npm run pack first`);
    return 1;
  }
  const manifest: { tools: { name: string }[] } = JSON.parse(readFileSync("manifest.json", "utf8"));
  let conn: Awaited<ReturnType<typeof connectStdioClient>> | undefined;
  let tools: Awaited<ReturnType<McpClientLike["listTools"]>>["tools"];
  let res: Awaited<ReturnType<McpClientLike["callTool"]>>;
  try {
    conn = await connectStdioClient(process.execPath, [BUNDLE], { [ENV_VARS.fetchTripwire]: "1" });
    tools = (await conn.client.listTools()).tools;
    res = await conn.client.callTool({ name: "get_post", arguments: { post: "a title, not an id" } });
  } catch (e) {
    console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
    const stderr = conn?.stderr().trim();
    if (stderr) console.error(`smoke: the server's stderr:\n${stderr}`);
    return 1;
  } finally {
    await conn?.close().catch(() => {});
  }
  const stderr = conn.stderr();
  const failures = smokeChecks({
    tools,
    manifestTools: manifest.tools.map((t) => t.name),
    call: { isError: res.isError, text: res.content.find((c) => c.type === "text")?.text ?? "" },
    stderr,
    transportErrors: conn.transportErrors(),
  });
  if (failures.length > 0) {
    for (const failure of failures) console.error(`smoke: ${failure}`);
    return 1;
  }
  console.log(`smoke: OK (${tools.length} tools, bad_input wording, JSON-RPC only, ${VERSION_LINE_RE.exec(stderr)?.[0] ?? ""})`);
  return 0;
}

if (isEntryModule(import.meta.url)) process.exitCode = await main();
