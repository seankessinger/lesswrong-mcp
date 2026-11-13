// test/forum/http.caps.test.ts
import { describe, expect, it, vi } from "vitest";
import { responseKey } from "../../src/forum/http";
import { CallStopped } from "../../src/errors";
import { caught } from "../support/errors";
import { httpRig, jsonResponse, req } from "../support/httpStub";

const A = () => jsonResponse({ data: { a: 1 } }); // 16 bytes
const pause = (n: number, mb: number, window: string, until: string) =>
  `This session has made ${n} forum requests (${mb} MB) in the last ${window}; to stay polite the server pauses until ${until}.`;

describe("response cache (¶2.3)", () => {
  it("¶2.3 responseKey is \"http:\" + SHA-256 of the endpoint, a newline and the exact body", () => {
    expect(responseKey("graphql", "{}")).toBe("http:b57f18b9172a6591fc5dccb29ebd4b888af2c56738b9a2cba9d8b32ccd0b43da");
    expect(responseKey("search", "{}")).toBe("http:ed68d4452bafb4a9f3de7cdf6b46f9d9fe7f0e4e16d97f479f796ef8a1b67d02");
  });

  it("¶2.3 a 200 answer is kept 5 minutes; a repeat comes from the cache, cached: true, charging no request or bytes", async () => {
    const rig = httpRig(A);
    const ctx1 = rig.ctx();
    const r1 = await rig.http.fetch(req("{}"), ctx1);
    expect(r1).toMatchObject({ status: 200, cached: false, bytes: 16, cacheKey: responseKey("graphql", "{}") });
    expect(ctx1.cacheKeys).toEqual([r1.cacheKey]);
    expect([ctx1.requestsUsed, ctx1.bytesUsed]).toEqual([1, 16]);
    const ctx2 = rig.ctx();
    const r2 = await rig.http.fetch(req("{}"), ctx2);
    expect(r2).toEqual({ status: 200, text: '{"data":{"a":1}}', ms: 0, bytes: 16, cached: true, cacheKey: r1.cacheKey });
    expect([ctx2.requestsUsed, ctx2.bytesUsed]).toEqual([0, 0]);
    expect(ctx2.cacheKeys).toEqual([r1.cacheKey]);
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t 200 0ms 16B miss", "[lesswrong-mcp] t 200 0ms 16B hit"]);
    rig.clock.advance(300_001);
    await rig.http.fetch(req("{}"), rig.ctx());
    expect(rig.calls).toHaveLength(2);
  });

  it("¶2.3 a request's ttlMs replaces the 5-minute TTL (feeds)", async () => {
    const rig = httpRig(A);
    const feed = { ...req("{}"), ttlMs: 120_000 };
    await rig.http.fetch(feed, rig.ctx());
    rig.clock.advance(119_999);
    expect((await rig.http.fetch(feed, rig.ctx())).cached).toBe(true);
    rig.clock.advance(2);
    expect((await rig.http.fetch(feed, rig.ctx())).cached).toBe(false);
    expect(rig.calls).toHaveLength(2);
  });

  it("¶2.3 only 200 answers are stored: a 400 is sent again", async () => {
    const rig = httpRig(() => jsonResponse({ errors: [{ message: "x" }] }, 400));
    await rig.http.fetch(req("{}"), rig.ctx());
    const r = await rig.http.fetch(req("{}"), rig.ctx());
    expect(r).toMatchObject({ status: 400, cached: false, cacheKey: responseKey("graphql", "{}") });
    expect(rig.calls).toHaveLength(2);
  });

  it("¶7 the cache is checked again when a request leaves the queue: an identical request is never sent twice", async () => {
    let release!: () => void;
    const rig = httpRig(() => new Promise<Response>((r) => (release = () => r(A()))));
    const a = rig.http.fetch(req("{}"), rig.ctx());
    const b = rig.http.fetch(req("{}"), rig.ctx());
    await vi.waitFor(() => expect(rig.calls).toHaveLength(1));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.cached, rb.cached]).toEqual([false, true]);
    expect(rig.calls).toHaveLength(1);
  });

  it("¶2.3 a cached answer is served even while the forum's pause holds; Http.evict removes stored answers", async () => {
    let n = 0;
    const rig = httpRig(() => (n++ === 0 ? A() : jsonResponse({}, 503)));
    await rig.http.fetch(req("{}"), rig.ctx());
    await caught(rig.http.fetch(req('{"other":1}'), rig.ctx()));
    expect((await rig.http.fetch(req("{}"), rig.ctx())).cached).toBe(true);
    rig.http.evict([responseKey("graphql", "{}")]);
    expect(await caught(rig.http.fetch(req("{}"), rig.ctx()))).toMatchObject({ category: "rate_limited" });
    expect(rig.calls).toHaveLength(2);
  });
});

describe("size caps (¶7)", () => {
  it("¶7 a response over 12 MB is aborted while reading: forum_error \"response too large\", not retried", async () => {
    let cancelled = false;
    const MiB = new Uint8Array(1_048_576).fill(32);
    const rig = httpRig(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(MiB); // never ends: only the cap stops the read
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const ctx = rig.ctx();
    const e = await caught(rig.http.fetch(req(), ctx));
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (response too large). Try again later.",
    });
    expect(cancelled).toBe(true);
    expect(rig.calls).toHaveLength(1);
    expect(ctx.bytesUsed).toBeGreaterThan(12_582_912);
  });

  it("¶7 D13 a body read that fails midway still charges the bytes read to the call and to the session window, and logs them", async () => {
    const MiB = new Uint8Array(1_048_576).fill(32);
    let pulls = 0;
    const rig = httpRig(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulls++ % 2 === 0) c.enqueue(MiB);
              else c.error(new Error("socket reset"));
            },
          }),
          { status: 200 },
        ),
      { config: { spacingMs: 0, sessionWindows: [{ ms: 600_000, requests: 150, bytes: 2_097_152, label: "10 minutes" }] } },
    );
    const ctx = rig.ctx();
    const e = await caught(rig.http.fetch(req(), ctx));
    // Both attempts fail after 1 MB: the ¶7 network-error retry, then forum_error.
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (network error). Try again later.",
    });
    expect(rig.calls).toHaveLength(2);
    expect(ctx.bytesUsed).toBe(2_097_152);
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t network-error 0ms 1048576B miss", "[lesswrong-mcp] t network-error 0ms 1048576B miss"]);
    // The 2 MB count in the session window too: its byte cap now holds.
    expect(await caught(rig.http.fetch(req('{"n":2}'), rig.ctx()))).toMatchObject({ category: "politeness_cap" });
    expect(rig.calls).toHaveLength(2);
  });

  it("¶7 bytes are charged to the call; past 20 MB no further request starts", async () => {
    const rig = httpRig(A);
    const ctx = rig.ctx("get_post", { maxRequests: 10 });
    ctx.charge(20_971_510);
    await rig.http.fetch(req('{"n":1}'), ctx);
    expect(ctx.bytesUsed).toBe(20_971_526);
    await expect(rig.http.fetch(req('{"n":2}'), ctx)).rejects.toBeInstanceOf(CallStopped);
    expect(rig.calls).toHaveLength(1);
  });
});

describe("session caps (D13)", () => {
  it("D13 150 requests in 10 minutes → politeness_cap until the oldest leaves the window, with no request", async () => {
    const rig = httpRig(A, { config: { spacingMs: 0 } });
    const ctx = rig.ctx("get_post", { maxRequests: 1000 });
    for (let i = 0; i < 150; i++) await rig.http.fetch(req(`{"i":${i}}`), ctx);
    const e = await caught(rig.http.fetch(req('{"i":150}'), ctx));
    expect(e).toMatchObject({
      category: "politeness_cap",
      message: pause(150, 0, "10 minutes", "2026-10-22 12:10 UTC"),
    });
    expect(rig.calls).toHaveLength(150);
    rig.clock.advance(600_000);
    await rig.http.fetch(req('{"i":150}'), rig.ctx());
    expect(rig.calls).toHaveLength(151);
  });

  it("D13 the byte window: 2 MB under a 2 MB cap stops the next request", async () => {
    const body = JSON.stringify({ d: "x".repeat(1_048_568) }); // exactly 1,048,576 bytes
    const rig = httpRig(() => jsonResponse(body), {
      config: {
        spacingMs: 0,
        sessionWindows: [
          { ms: 600_000, requests: 150, bytes: 2_097_152, label: "10 minutes" },
          { ms: 86_400_000, requests: 1500, bytes: 524_288_000, label: "24 hours" },
        ],
      },
    });
    await rig.http.fetch(req('{"n":1}'), rig.ctx());
    await rig.http.fetch(req('{"n":2}'), rig.ctx());
    const e = await caught(rig.http.fetch(req('{"n":3}'), rig.ctx()));
    expect(e).toMatchObject({ category: "politeness_cap", message: pause(2, 2, "10 minutes", "2026-10-22 12:10 UTC") });
    expect(rig.calls).toHaveLength(2);
  });

  it("D13 the 24-hour window", async () => {
    const rig = httpRig(A, {
      config: {
        spacingMs: 0,
        sessionWindows: [
          { ms: 600_000, requests: 150, bytes: 104_857_600, label: "10 minutes" },
          { ms: 86_400_000, requests: 3, bytes: 524_288_000, label: "24 hours" },
        ],
      },
    });
    for (let i = 0; i < 3; i++) {
      await rig.http.fetch(req(`{"i":${i}}`), rig.ctx());
      rig.clock.advance(11 * 60_000);
    }
    const e = await caught(rig.http.fetch(req('{"i":3}'), rig.ctx()));
    expect(e).toMatchObject({ category: "politeness_cap", message: pause(3, 0, "24 hours", "2026-10-23 12:00 UTC") });
  });
});

// Beyond the cases above: the declared-length refusal, the charge of non-200 answers, a key recorded once per call,
// cache hits under a full session window, and which pause is reported when several caps are met.
describe("caps: further cases", () => {
  it("¶2.3 a call that stores an answer and then reads it back records the key once", async () => {
    const rig = httpRig(A);
    const ctx = rig.ctx();
    const r1 = await rig.http.fetch(req("{}"), ctx);
    const r2 = await rig.http.fetch(req("{}"), ctx);
    expect([r1.cached, r2.cached]).toEqual([false, true]);
    expect(ctx.cacheKeys).toEqual([responseKey("graphql", "{}")]);
    expect([ctx.requestsUsed, ctx.bytesUsed]).toEqual([1, 16]);
  });

  it("¶7 a Content-Length over 12 MB is refused before the body is read: forum_error \"response too large\", 0 bytes charged", async () => {
    let cancelled = false;
    const rig = httpRig(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"data":{}}'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": "12582913" } },
        ),
    );
    const ctx = rig.ctx();
    const e = await caught(rig.http.fetch(req(), ctx));
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (response too large). Try again later.",
    });
    expect(cancelled).toBe(true);
    expect(rig.calls[0].init.signal!.aborted).toBe(true);
    expect(rig.calls).toHaveLength(1);
    expect([ctx.requestsUsed, ctx.bytesUsed]).toEqual([1, 0]);
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t 200 0ms 0B miss"]);
  });

  it("¶7 a response of exactly the cap is read whole: only a larger one is refused", async () => {
    const rig = httpRig(() => jsonResponse(JSON.stringify({ d: "x".repeat(10) })), { config: { maxResponseBytes: 18 } });
    const r = await rig.http.fetch(req(), rig.ctx());
    expect(r).toMatchObject({ status: 200, text: '{"d":"xxxxxxxxxx"}', bytes: 18, cached: false });
  });

  it("¶7 the bytes of every answer are charged, a 400 and a 503 included; an oversize body is charged as far as it was read", async () => {
    const rig = httpRig((_c, i) =>
      i === 0 ? jsonResponse({ errors: [{ message: "x" }] }, 400) : jsonResponse({ e: 1 }, 503),
    );
    const ctx = rig.ctx();
    await rig.http.fetch(req('{"n":1}'), ctx);
    expect(ctx.bytesUsed).toBe(28);
    await caught(rig.http.fetch(req('{"n":2}'), ctx));
    expect(ctx.bytesUsed).toBe(35);
    expect(ctx.cacheKeys).toEqual([]);

    const small = httpRig(A, { config: { maxResponseBytes: 10 } });
    const ctx2 = small.ctx();
    expect(await caught(small.http.fetch(req(), ctx2))).toMatchObject({ category: "forum_error" });
    expect(ctx2.bytesUsed).toBe(16);
    expect(small.logLines).toEqual(["[lesswrong-mcp] t 200 0ms 16B miss"]);
  });

  it("D13 a cached answer costs no session budget: it is served while a window is full", async () => {
    const rig = httpRig(A, {
      config: {
        spacingMs: 0,
        sessionWindows: [{ ms: 600_000, requests: 2, bytes: 104_857_600, label: "10 minutes" }],
      },
    });
    await rig.http.fetch(req('{"n":1}'), rig.ctx());
    await rig.http.fetch(req('{"n":2}'), rig.ctx());
    expect(await caught(rig.http.fetch(req('{"n":3}'), rig.ctx()))).toMatchObject({ category: "politeness_cap" });
    for (let i = 0; i < 3; i++) expect((await rig.http.fetch(req('{"n":1}'), rig.ctx())).cached).toBe(true);
    expect(rig.calls).toHaveLength(2);
  });

  it("D13 when both caps of a window are met, the pause ends when both are clear again", async () => {
    const rig = httpRig((_c, i) => jsonResponse(i === 0 ? { a: 1 } : JSON.stringify({ d: "x".repeat(1_048_568) })), {
      config: {
        spacingMs: 0,
        sessionWindows: [{ ms: 600_000, requests: 2, bytes: 1_048_576, label: "10 minutes" }],
      },
    });
    await rig.http.fetch(req('{"n":1}'), rig.ctx()); // 12:00, 16 B: the request cap clears at 12:10
    rig.clock.advance(5 * 60_000);
    await rig.http.fetch(req('{"n":2}'), rig.ctx()); // 12:05, 1 MB: the byte cap clears only when it leaves, at 12:15
    const e = await caught(rig.http.fetch(req('{"n":3}'), rig.ctx()));
    expect(e).toMatchObject({ category: "politeness_cap", message: pause(2, 1, "10 minutes", "2026-10-22 12:15 UTC") });
    expect(rig.calls).toHaveLength(2);
  });

  it("D13 when two windows are exceeded, the one whose pause ends later is reported", async () => {
    const rig = httpRig(A, {
      config: {
        spacingMs: 0,
        sessionWindows: [
          { ms: 600_000, requests: 2, bytes: 104_857_600, label: "10 minutes" },
          { ms: 86_400_000, requests: 2, bytes: 524_288_000, label: "24 hours" },
        ],
      },
    });
    await rig.http.fetch(req('{"n":1}'), rig.ctx());
    await rig.http.fetch(req('{"n":2}'), rig.ctx());
    const e = await caught(rig.http.fetch(req('{"n":3}'), rig.ctx()));
    expect(e).toMatchObject({ category: "politeness_cap", message: pause(2, 0, "24 hours", "2026-10-23 12:00 UTC") });
  });
});
