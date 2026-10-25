import { describe, it, expect } from "vitest";
import { smokeChecks, type SmokeInput } from "../../scripts/smoke";
import { CONVENTIONS_LINE } from "../../src/params/vocabulary";
import { TOOL_ORDER } from "../../src/tools/registry";
import { connectStdioClient } from "../support/mcpClient";

const names = [...TOOL_ORDER];
const good: SmokeInput = {
  tools: names.map((name) => ({ name, description: "Something.\n\n" + CONVENTIONS_LINE })),
  manifestTools: names,
  call: { isError: true, text: 'Error (bad_input): post: "a title, not an id" is not an identifier. Use find to turn a title into a post_id.' },
  stderr: "[lesswrong-mcp] node v22.11.0\n[lesswrong-mcp] ready\n",
  transportErrors: [],
};

describe("smoke checks (¶9.4)", () => {
  it("a healthy session has no failures", () => {
    expect(smokeChecks(good)).toEqual([]);
  });
  it("names each failure", () => {
    expect(smokeChecks({ ...good, tools: good.tools.slice(1) })).toEqual(["tools: the server's tool names differ from the manifest's"]);
    expect(smokeChecks({ ...good, tools: [{ name: "find", description: "no conventions" }, ...good.tools.slice(1)] }))
      .toEqual(["description: find does not end with the conventions line"]);
    expect(smokeChecks({ ...good, call: { isError: false, text: "get_post — x" } }))
      .toEqual(['bad_input: expected an isError reply starting "Error (bad_input): post: ", got "get_post — x"']);
    expect(smokeChecks({ ...good, transportErrors: ["Unexpected token 'h', \"hello\" is not valid JSON", "x"] }))
      .toEqual(["stdout: 2 outputs that are not JSON-RPC (first: Unexpected token 'h', \"hello\" is not valid JSON)"]);
    expect(smokeChecks({ ...good, stderr: "" })).toEqual(['stderr: no "[lesswrong-mcp] node v<x.y.z>" line']);
  });
});

/**
 * A stand-in server: answers `initialize` over stdio. When LESSWRONG_MCP_TEST_BEFORE is set it writes that to stdout first, and
 * LESSWRONG_MCP_TEST_LATER 50 ms after it (a second chunk), before the answer; when LESSWRONG_MCP_TEST_AT_END is set it writes that to
 * stdout once its stdin closes.
 */
const STAND_IN_SERVER = `
const env = process.env;
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "initialize") return;
  const result = { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "stand-in", version: "0" } };
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (!env.LESSWRONG_MCP_TEST_BEFORE) return answer();
  process.stdout.write(env.LESSWRONG_MCP_TEST_BEFORE);
  setTimeout(() => { process.stdout.write(env.LESSWRONG_MCP_TEST_LATER ?? ""); answer(); }, 50);
});
rl.on("close", () => {
  if (env.LESSWRONG_MCP_TEST_AT_END) process.stdout.write(env.LESSWRONG_MCP_TEST_AT_END);
});
`;

/** The transport errors of a session with the stand-in server, read after the session is closed. */
async function transportErrorsOf(env: Record<string, string>): Promise<string[]> {
  const conn = await connectStdioClient(process.execPath, ["-e", STAND_IN_SERVER], env);
  await conn.close();
  return conn.transportErrors();
}

describe("connectStdioClient (¶9.4)", () => {
  it("is empty for a server that speaks only JSON-RPC, and returns a copy", async () => {
    const conn = await connectStdioClient(process.execPath, ["-e", STAND_IN_SERVER]);
    try {
      expect(conn.transportErrors()).toEqual([]);
      conn.transportErrors().push("not the connection's own list");
      expect(conn.transportErrors()).toEqual([]);
    } finally {
      await conn.close();
    }
  });
  it("reports a stdout line that is not JSON, which the SDK's read buffer would skip without a word", async () => {
    const errors = await transportErrorsOf({ LESSWRONG_MCP_TEST_BEFORE: "hello\n" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hello");
  });
  it("reports a stdout line that is JSON but not a JSON-RPC message, once", async () => {
    expect(await transportErrorsOf({ LESSWRONG_MCP_TEST_BEFORE: '{"not":"json-rpc"}\n' })).toHaveLength(1);
  });
  it("reports one error per stray line, blank lines aside, and a line that arrives in two chunks once", async () => {
    expect(await transportErrorsOf({ LESSWRONG_MCP_TEST_BEFORE: "one\n\ntwo\r\nthr", LESSWRONG_MCP_TEST_LATER: "ee\n" })).toHaveLength(3);
  });
  it("reports an unterminated last line when the server exits", async () => {
    const errors = await transportErrorsOf({ LESSWRONG_MCP_TEST_AT_END: "bye" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bye");
  });
  it("a server that dies before it answers fails the connection with the stderr it wrote", async () => {
    const dying = 'console.error("boom at start"); process.exit(1);';
    await expect(connectStdioClient(process.execPath, ["-e", dying])).rejects.toThrow(/Connection closed[\s\S]*boom at start/);
  });
});
