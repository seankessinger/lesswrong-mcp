import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { INSTRUCTIONS, ANNOTATIONS, CANCELLED, listTools, callTool, createServer } from "../src/server";
import { abortableSleep, fetchFor } from "../src/index";
import { TOOLS } from "../src/tools/registry";
import { P, CONVENTIONS_LINE } from "../src/params/vocabulary";
import { notFound, CallStopped } from "../src/errors";
import { postByIdOp } from "../src/forum/templates/shared";
import { connectInMemory, connectStdioClient } from "./support/mcpClient";
import { createHarness, expectClean } from "./support/harness";
import type { ToolDef, CallContext, Services } from "../src/types";

let seen: CallContext | undefined;
let behaviour: "ok" | "notFound" | "time" | "cap" | "crash" = "ok";
const stub: ToolDef<{ post?: string; comment?: string; tag?: string; limit: number; cursor?: string; max_tokens: number }> = {
  name: "get_post", title: "Stub", description: "Stub tool.\n\n" + CONVENTIONS_LINE,
  schema: z.strictObject({ post: P.post().optional(), comment: P.comment().optional(), tag: P.tag().optional(), limit: P.limit(), cursor: P.cursor().optional(), max_tokens: P.maxTokens() }),
  required: ["post"], oneOf: [["post", "comment", "tag"]],
  async run(p, ctx, svc) {
    seen = ctx;
    if (behaviour === "notFound") throw notFound("post", "id", p.post!);
    if (behaviour === "time") throw new CallStopped("time limit");
    if (behaviour === "cap") throw new CallStopped("request cap");
    if (behaviour === "crash") throw new Error("boom at /Users/x/src/a.ts:3:7");
    const res = await svc.gql([postByIdOp("p", p.post!, "...POST_REF")], ctx, "reading the post");
    const doc = (res.get("p") as { data: { result: { title: string } } }).data.result;
    return { text: `get_post — "${doc.title}"\nRequest: post\nEnd of results.`, isError: false };
  },
};
const run = async (args: unknown, how: typeof behaviour = "ok", tool: typeof stub = stub) => {
  behaviour = how; const h = createHarness({ families: ["posts"], tools: [tool] });
  return { h, out: await h.call("get_post", args as Record<string, unknown>) };
};
const noGroup: typeof stub = { ...stub, oneOf: undefined }; // the same tool without an exactly-one group

describe("server", () => {
  it("¶2.4 INSTRUCTIONS start and end with their fixed sentences", () => {
    expect(INSTRUCTIONS.startsWith("Read-only access to LessWrong and the Alignment Forum, as a logged-out visitor sees them.")).toBe(true);
    expect(INSTRUCTIONS.endsWith('or reported as "no publicly visible … has this id".')).toBe(true);
  });
  it("the published tool list and server instructions are pinned", () => {
    expect({ instructions: INSTRUCTIONS, tools: listTools(TOOLS) }).toMatchSnapshot();
  });
  it("the real server's instructions reach the client", async () => {
    const conn = await connectInMemory(createServer({ tools: [], services: {} as Services, now: Date.now }));
    expect(conn.client.getInstructions()).toBe(INSTRUCTIONS);
    await conn.close();
  });
  it("tools/list publishes title, description, the generated JSON Schema with required, and the annotations", async () => {
    const { h } = await run({ post: "uMQ3cqWDPHhjtiesc" });
    const conn = await connectInMemory(createServer({ tools: [stub], services: h.services, now: h.clock.now }));
    const { tools } = await conn.client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "get_post", title: "Stub", description: "Stub tool.\n\n" + CONVENTIONS_LINE, annotations: ANNOTATIONS });
    const schema = tools[0].inputSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["post"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50, default: 10 });
    expect(listTools([stub])[0].inputSchema).toBe(listTools([stub])[0].inputSchema); // generated once
    await conn.close();
  });
  it("an unknown parameter and a bad value return isError with this server's bad_input wording (through MCP)", async () => {
    const { h } = await run({ post: "uMQ3cqWDPHhjtiesc" });
    const conn = await connectInMemory(createServer({ tools: [stub], services: h.services, now: h.clock.now }));
    const a = await conn.client.callTool({ name: "get_post", arguments: { post: "uMQ3cqWDPHhjtiesc", sort: "top" } });
    expect(a.isError).toBe(true);
    expect(a.content[0].text).toMatch(/^Error \(bad_input\): sort is not a parameter of get_post; .*It accepts post, comment, tag, limit, cursor, max_tokens\.$/);
    const b = await conn.client.callTool({ name: "get_post", arguments: { post: "uMQ3cqWDPHhjtiesc", limit: 0 } });
    expect(b.content[0].text).toMatch(/^Error \(bad_input\): limit: .*Use an integer from 1 to 50\.$/);
    await conn.close();
  });
  it("one successful call through the fake forum", async () => {
    const { h, out } = await run({ post: "uMQ3cqWDPHhjtiesc" });
    expect(out).toEqual({ isError: false, text: 'get_post — "AGI Ruin: A List of Lethalities"\nRequest: post\nEnd of results.' });
    expect(seen!.given).toEqual(new Set(["post"]));
    expectClean(h);
  });
  it("'exactly one of' groups are checked before the schema", async () => {
    expect((await run({ post: "a", tag: "b", bogus: 1 })).out.text).toBe("Error (bad_input): give exactly one of post, comment, tag (got: post, tag).");
  });
  it("required parameters unless a cursor is given (a tool without an exactly-one group)", async () => {
    expect((await run({}, "ok", noGroup)).out.text).toBe("Error (bad_input): post: is required. get_post needs post unless a cursor is given.");
  });
  it("with an exactly-one group, giving none of it reports the group, which is checked before required", async () => {
    expect((await run({})).out.text).toBe("Error (bad_input): give exactly one of post, comment, tag (got: none).");
  });
  it("a known parameter sent as \"\" or null counts as not given; an unknown one is still refused whatever its value", async () => {
    const ok = await run({ post: "uMQ3cqWDPHhjtiesc", comment: "", tag: null });
    expect(ok.out.isError).toBe(false);
    expect(seen!.given).toEqual(new Set(["post"]));
    expect((await run({ cursor: "" }, "ok", noGroup)).out.text).toBe("Error (bad_input): post: is required. get_post needs post unless a cursor is given.");
    expect((await run({ post: "uMQ3cqWDPHhjtiesc", cursor: null })).out.isError).toBe(false);
    expect((await run({ post: "uMQ3cqWDPHhjtiesc", sort: "" })).out.text).toMatch(/^Error \(bad_input\): sort is not a parameter of get_post; /);
  });
  it("an unknown tool", async () => {
    const { h } = await run({ post: "x" });
    expect(await callTool({ tools: [stub], services: h.services, now: h.clock.now }, "nope", {})).toEqual({ isError: true,
      text: 'Error (bad_input): tool: "nope" is not a tool of this server. Use one of get_post.' });
  });
  it("the top-level wrapper maps every failure to an error result without stack or paths", async () => {
    expect((await run({ post: "AAAAAAAAAAAAAAAAA" }, "notFound")).out.text).toBe('Error (not_found): No publicly visible post has the id "AAAAAAAAAAAAAAAAA".');
    expect((await run({ post: "x" }, "time")).out.text).toBe("Error (timeout): The forum did not answer in time while running get_post (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
    expect((await run({ post: "x" }, "cap")).out.text).toBe("Error (internal): Unexpected failure in get_post (request cap reached in a mandatory request). Please report this.");
    expect((await run({ post: "x" }, "crash")).out.text).toBe("Error (internal): Unexpected failure in get_post (boom at <path>). Please report this.");
  });
  it("cancellation aborts the request in flight and ends the call; the undelivered result is not reported as a bug", async () => {
    behaviour = "ok"; const h = createHarness({ families: ["posts"], tools: [stub] });
    let inflight: AbortSignal | undefined;
    const hanging = { ...h.forum, fetchImpl: (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      inflight = init.signal!; init.signal!.addEventListener("abort", () => reject(init.signal!.reason)); }) };
    const { servicesFor } = await import("./support/services");
    const ac = new AbortController();
    const p = callTool({ tools: [stub], services: servicesFor(hanging, { clock: h.clock }), now: h.clock.now }, "get_post", { post: "uMQ3cqWDPHhjtiesc" }, ac.signal);
    await new Promise((r) => setTimeout(r, 0)); ac.abort();
    expect(await p).toEqual(CANCELLED);
    expect(CANCELLED.text).not.toContain("Please report this");
    expect(inflight!.aborted).toBe(true);
  });
  it("cancellation through MCP (in-memory transport): the client's abort reaches the request in flight", async () => {
    behaviour = "ok"; const h = createHarness({ families: ["posts"], tools: [stub] });
    let inflight: AbortSignal | undefined;
    const hanging = { ...h.forum, fetchImpl: (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      inflight = init.signal!; init.signal!.addEventListener("abort", () => reject(init.signal!.reason)); }) };
    const { servicesFor } = await import("./support/services");
    const services = servicesFor(hanging, { clock: h.clock });
    const conn = await connectInMemory(createServer({ tools: [stub], services, now: h.clock.now }));
    try {
      const ac = new AbortController();
      const outcome = conn.client.callTool({ name: "get_post", arguments: { post: "uMQ3cqWDPHhjtiesc" } }, { signal: ac.signal })
        .then(() => "resolved", () => "rejected");
      await vi.waitFor(() => expect(inflight).toBeDefined());
      ac.abort();
      expect(await outcome).toBe("rejected");
      await vi.waitFor(() => expect(inflight!.aborted).toBe(true));
    } finally {
      await conn.close();
    }
  });
  it("LESSWRONG_MCP_FETCH_TRIPWIRE=1 refuses every request; otherwise the global fetch is used", async () => {
    await expect(fetchFor({ LESSWRONG_MCP_FETCH_TRIPWIRE: "1" })("https://www.lesswrong.com/graphql", {})).rejects.toThrow("network access is disabled (LESSWRONG_MCP_FETCH_TRIPWIRE=1)");
    expect(fetchFor({})).toBe(globalThis.fetch);
  });
  it("LESSWRONG_MCP_RECORD_DIR changes nothing: the global fetch is used and nothing is written", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lesswrong-mcp-record-")), "recorded");
    const impl = fetchFor({ LESSWRONG_MCP_RECORD_DIR: dir });
    expect(impl).toBe(globalThis.fetch);
    await expect(async () => impl("https://www.lesswrong.com/graphql", {})).rejects.toThrow("network access attempted in tests");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("server: arguments", () => {
  it("arguments that are not a plain object are read as {} (bad_input, never internal)", async () => {
    for (const args of [null, [], "post", 5, true]) {
      expect((await run(args, "ok", noGroup)).out.text).toBe("Error (bad_input): post: is required. get_post needs post unless a cursor is given.");
    }
  });
  it("with a cursor, neither an exactly-one group nor a required parameter is checked", async () => {
    let given: ReadonlySet<string> | undefined;
    const probe: typeof stub = { ...stub, async run(_p, ctx) { given = ctx.given; return { text: "ok", isError: false }; } };
    expect((await run({ cursor: "c_AAAAAAAAAAAAAAAAAAAAAA" }, "ok", probe)).out).toEqual({ text: "ok", isError: false });
    expect(given).toEqual(new Set(["cursor"]));
  });
});

describe("entry point (src/index.ts)", () => {
  it("the real sleep waits its time, and rejects with the signal's reason at once when the signal is already aborted", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = abortableSleep(1000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
      const reason = new Error("cancelled before");
      const ac = new AbortController();
      ac.abort(reason);
      await expect(abortableSleep(1000, ac.signal)).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("the real sleep clears its timer and rejects with the reason on a later abort, and drops its listener when the timer fires", async () => {
    vi.useFakeTimers();
    try {
      const reason = new Error("cancelled during");
      const ac = new AbortController();
      const p = abortableSleep(30_000, ac.signal);
      expect(vi.getTimerCount()).toBe(1);
      ac.abort(reason);
      await expect(p).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      const quiet = new AbortController();
      const remove = vi.spyOn(quiet.signal, "removeEventListener");
      const q = abortableSleep(10, quiet.signal);
      await vi.advanceTimersByTimeAsync(10);
      await q;
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
  it("main() over stdio: logs the Node version to stderr once and serves tools/list, with LESSWRONG_MCP_FETCH_TRIPWIRE=1", async () => {
    const conn = await connectStdioClient(process.execPath, ["--import", "tsx", "src/index.ts"], { LESSWRONG_MCP_FETCH_TRIPWIRE: "1" });
    try {
      expect((await conn.client.listTools()).tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      await vi.waitFor(() => expect(conn.stderr()).toContain("[lesswrong-mcp] node "));
      expect(conn.stderr().split("\n").filter((l) => l.startsWith("[lesswrong-mcp] node "))).toEqual([`[lesswrong-mcp] node ${process.version}`]);
    } finally {
      await conn.close();
    }
  }, 20_000);
});
