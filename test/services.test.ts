import { describe, it, expect } from "vitest";
import { createServices } from "../src/services";
import { createLog } from "../src/log";
import { CONFIG } from "../src/config";
import { CURSOR_RE } from "../src/paging/cursor";
import { postByIdOp } from "../src/forum/templates/shared";
import { createCallContext } from "../src/call/context";
import { createClock } from "./support/clock";
import { createFakeForum } from "./fakeForum";
import { servicesFor } from "./support/services";

function stub() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response(JSON.stringify({ data: { p: { result: null } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const svc = createServices({ fetchImpl, now: clock.now, sleep: clock.sleep, random: () => 0.5,
    log: createLog({ write: () => {}, debug: false }), http: { spacingMs: 0 }, randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => [0xab, 0x0c, 0xef][i % 3]) });
  return { calls, clock, svc };
}

describe("createServices", () => {
  it("nonce is 6 lowercase hex characters from randomBytes(3)", () => {
    expect(stub().svc.nonce()).toBe("ab0cef");
  });
  it("gql runs through the injected fetchImpl with the D12 User-Agent", async () => {
    const { calls, clock, svc } = stub();
    const res = await svc.gql([postByIdOp("p", "uMQ3cqWDPHhjtiesc", "_id")], createCallContext("get_post", { now: clock.now }), "reading the post");
    expect(res.get("p")).toEqual({ data: { result: null } });
    expect(calls[0].url).toBe("https://www.lesswrong.com/graphql");
    expect(calls[0].headers["user-agent"]).toBe(CONFIG.http.userAgent);
  });
  it("evictResponses drops a cached raw response", async () => {
    const { calls, clock, svc } = stub();
    const ctx = createCallContext("get_post", { now: clock.now }); const op = postByIdOp("p", "uMQ3cqWDPHhjtiesc", "_id");
    await svc.gql([op], ctx, "t"); await svc.gql([op], ctx, "t");
    expect(calls).toHaveLength(1);
    svc.evictResponses(ctx.cacheKeys);
    await svc.gql([op], ctx, "t");
    expect(calls).toHaveLength(2);
  });
  it("named caches use the namespace TTLs on the injected clock", () => {
    const { clock, svc } = stub();
    svc.caches.set("resolve", "post:x", 1);
    clock.advance(1_799_999); expect(svc.caches.get("resolve", "post:x")).toBe(1);
    clock.advance(1); expect(svc.caches.get("resolve", "post:x")).toBeUndefined();
  });
  it("the cursor store issues c_ tokens", () => {
    expect(stub().svc.cursors.issue("find", {}, {}, { streams: [], current: 0 })).toMatch(CURSOR_RE);
  });
  it("without randomBytes, nonces and cursor tokens come from node:crypto", () => {
    const svc = createServices({ fetchImpl: async () => new Response(""), now: () => 0, sleep: async () => {}, random: () => 0.5,
      log: createLog({ write: () => {}, debug: false }) });
    const state = { streams: [], current: 0 };
    expect(svc.nonce()).toMatch(/^[0-9a-f]{6}$/);
    expect(svc.cursors.issue("find", {}, {}, state)).not.toBe(svc.cursors.issue("find", {}, {}, state));
  });
  it("without an http override it uses CONFIG.http: request starts are 3,000 ms apart", async () => {
    const clock = createClock("2026-10-22T12:00:00.000Z");
    const starts: number[] = [];
    const fetchImpl = async () => {
      starts.push(clock.now());
      return new Response(JSON.stringify({ data: { a: { result: null } } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const svc = createServices({ fetchImpl, now: clock.now, sleep: clock.sleep, random: () => 0.5, log: createLog({ write: () => {}, debug: false }) });
    const ctx = createCallContext("get_post", { now: clock.now });
    await svc.gql([postByIdOp("a", "uMQ3cqWDPHhjtiesc", "_id")], ctx, "t");
    await svc.gql([postByIdOp("a", "RkznxXmmh9b5ovdSq", "_id")], ctx, "t");
    expect(starts[1] - starts[0]).toBe(CONFIG.http.spacingMs);
    expect(CONFIG.http.spacingMs).toBe(3000);
  });
});

describe("servicesFor", () => {
  const T0 = Date.parse("2026-10-22T12:00:00.000Z");
  const idle = () => createFakeForum({ fixtures: [], lint: false });

  it("is deterministic: a byte counter from 0 feeds nonces and cursors", () => {
    const a = servicesFor(createFakeForum({ fixtures: [] })), b = servicesFor(createFakeForum({ fixtures: [] }));
    expect([a.nonce(), a.nonce()]).toEqual(["000102", "030405"]);
    expect(b.nonce()).toBe("000102");
  });
  it("nonces and cursor tokens draw from the one counter", () => {
    const svc = servicesFor(idle());
    expect(svc.nonce()).toBe("000102");
    const token = svc.cursors.issue("find", {}, {}, { streams: [], current: 0 });
    expect(token).toBe("c_" + Buffer.from(Uint8Array.from({ length: 16 }, (_, i) => 3 + i)).toString("base64url"));
    expect(svc.nonce()).toBe("131415");
  });
  it("starts its clock at 2026-10-22T12:00:00.000Z, and uses the clock it is given instead", () => {
    expect(servicesFor(idle()).now()).toBe(T0);
    const clock = createClock("2030-01-01T00:00:00.000Z");
    const svc = servicesFor(idle(), { clock });
    expect(svc.now()).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    svc.caches.set("resolve", "k", 1);
    clock.advance(CONFIG.cache.ttlMs.resolve - 1); expect(svc.caches.get("resolve", "k")).toBe(1);
    clock.advance(1); expect(svc.caches.get("resolve", "k")).toBeUndefined();
    expect(svc.now()).toBe(clock.now());
  });
  it("sends requests with spacing 0, and an http override replaces it", async () => {
    const run = async (http?: { spacingMs: number }) => {
      const clock = createClock("2026-10-22T12:00:00.000Z");
      const svc = servicesFor(idle(), { clock, http });
      const ctx = createCallContext("get_post", { now: clock.now });
      await svc.gql([postByIdOp("a", "uMQ3cqWDPHhjtiesc", "_id")], ctx, "t");
      await svc.gql([postByIdOp("a", "RkznxXmmh9b5ovdSq", "_id")], ctx, "t");
      return clock.now() - T0;
    };
    expect(await run()).toBe(0);
    expect(await run({ spacingMs: 3000 })).toBe(3000);
  });
  it("reads the forum only through the fake forum", async () => {
    const forum = idle();
    const svc = servicesFor(forum);
    await svc.gql([postByIdOp("a", "uMQ3cqWDPHhjtiesc", "_id")], createCallContext("get_post", { now: svc.now }), "t");
    expect(forum.requests).toHaveLength(1);
    expect(forum.requests[0].endpoint).toBe("graphql");
  });
  it("logLines collects the log's lines, debug lines included", () => {
    const logLines: string[] = [];
    const svc = servicesFor(idle(), { logLines });
    svc.log.debug("probe", { n: 2 });
    svc.log.info("hello");
    expect(logLines).toEqual(["[lesswrong-mcp] debug probe n=2", "[lesswrong-mcp] hello"]);
  });
  it("wrapCursors replaces the cursor store the services expose", () => {
    const calls: string[] = [];
    const svc = servicesFor(idle(), {
      wrapCursors: (inner) => ({
        issue: (...args) => { calls.push("issue"); return inner.issue(...args); },
        take: (...args) => { calls.push("take"); return inner.take(...args); },
      }),
    });
    const token = svc.cursors.issue("find", { query: "x" }, { query: "x" }, { streams: [], current: 0 });
    expect(svc.cursors.take("find", token).args).toEqual({ query: "x" });
    expect(calls).toEqual(["issue", "take"]);
  });
});
