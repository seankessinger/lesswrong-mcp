import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../../src/errors";
import type { CallContext } from "../../src/types";
import { caught } from "../support/errors";
import { httpRig, jsonResponse, req } from "../support/httpStub";

const UA =
  "lesswrong-mcp/1.0.0 (read-only research extension for Claude Desktop; single user; one request at a time)";
const OK = () => jsonResponse({ data: { a: 1 } });
const limited = (until: string, status = 429) =>
  `The forum is limiting requests (HTTP ${status}). This server sends nothing to it until ${until}; try again after that.`;
const pending = (c: { init: RequestInit }) =>
  new Promise<Response>((_resolve, reject) =>
    c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason)),
  );

describe("endpoints and headers", () => {
  it("S1 Q67 Q50.45 D12 sends only POST to the two LessWrong endpoints, redirect manual, with exactly the four headers", async () => {
    const rig = httpRig(OK);
    await rig.http.fetch(req('{"q":1}'), rig.ctx());
    await rig.http.fetch(req('{"queries":[]}', "search"), rig.ctx("search"));
    expect(rig.calls.map((c) => c.url)).toEqual([
      "https://www.lesswrong.com/graphql",
      "https://www.lesswrong.com/api/search",
    ]);
    for (const c of rig.calls) {
      expect(c.init.method).toBe("POST");
      expect(c.init.redirect).toBe("manual");
      expect(c.init.headers).toEqual({
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip",
      });
    }
    expect(rig.calls.map((c) => c.body)).toEqual(['{"q":1}', '{"queries":[]}']);
  });

  it("S1 Q67 refuses to be configured with any URL other than the two LessWrong endpoints", () => {
    for (const config of [
      { graphqlUrl: "https://www.alignmentforum.org/graphql" },
      { graphqlUrl: "https://www.lesswrong.com/api/post" },
      { searchUrl: "https://www.lesswrong.com/api/search?type=posts" },
    ])
      expect(() => httpRig(OK, { config })).toThrow(
        "Unexpected failure in http (endpoint not allowed). Please report this.",
      );
  });
});

describe("single flight and spacing", () => {
  it("Q136 D13 one request in flight, first in first out, 3,000 ms between request starts", async () => {
    const rig = httpRig(async () => {
      await Promise.resolve();
      await Promise.resolve();
      return OK();
    });
    const t0 = rig.clock.now();
    await Promise.all([1, 2, 3].map((n) => rig.http.fetch(req(`{"n":${n}}`), rig.ctx())));
    expect(rig.calls.map((c) => c.at - t0)).toEqual([0, 3000, 6000]);
    expect(rig.calls.map((c) => c.body)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(rig.inFlightMax()).toBe(1);
  });

  it("D13 ¶7 two calls at once share the queue: requests interleave 3,000 ms apart, never overlap, each call counts only its own", async () => {
    const rig = httpRig(async () => {
      await rig.clock.sleep(2000); // each answer takes 2 s of fake time
      return OK();
    });
    const t0 = rig.clock.now();
    const ctxA = rig.ctx("get_user");
    const ctxB = rig.ctx("get_comments");
    const three = async (who: string, ctx: CallContext) => {
      for (let i = 1; i <= 3; i++) await rig.http.fetch(req(`{"${who}":${i}}`), ctx);
    };
    await Promise.all([three("a", ctxA), three("b", ctxB)]);
    expect(rig.calls.map((c) => c.at - t0)).toEqual([0, 3000, 6000, 9000, 12000, 15000]);
    expect(rig.calls.map((c) => c.body)).toEqual(['{"a":1}', '{"b":1}', '{"a":2}', '{"b":2}', '{"a":3}', '{"b":3}']);
    expect(rig.inFlightMax()).toBe(1);
    expect([ctxA.requestsUsed, ctxB.requestsUsed]).toEqual([3, 3]);
  });

  it("¶7 a call whose 40 s mark passes while it waits behind another call's request sends nothing", async () => {
    const rig = httpRig(async () => {
      await rig.clock.sleep(41_000);
      return OK();
    });
    const ctxA = rig.ctx("get_comments");
    const ctxB = rig.ctx("get_user");
    const [a, b] = await Promise.allSettled([rig.http.fetch(req('{"a":1}'), ctxA), rig.http.fetch(req('{"b":1}'), ctxB)]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { reason: "time limit" } });
    expect(rig.calls).toHaveLength(1);
  });

  it("D13 adaptive spacing doubles after a non-JSON 200 up to 30 s and halves after 10 consecutive successes", async () => {
    let n = 0;
    const rig = httpRig(() => (n++ < 4 ? new Response("<html>challenge</html>", { status: 200 }) : OK()));
    for (let i = 0; i < 15; i++) await rig.http.fetch(req(`{"i":${i}}`), rig.ctx()).catch(() => undefined);
    const gaps = rig.calls.slice(1).map((c, i) => c.at - rig.calls[i].at);
    expect(gaps).toEqual([
      6000, 12000, 24000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 15000,
    ]);
  });
});

describe("rate limits (Q136)", () => {
  it("Q136 a 429 with Retry-After in seconds pauses the whole process: later calls get rate_limited at once, with no request", async () => {
    let first = true;
    const rig = httpRig(() => {
      if (!first) return OK();
      first = false;
      return jsonResponse({}, 429, { "retry-after": "120" });
    });
    const e1 = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(e1).toBeInstanceOf(ToolError);
    expect(e1).toMatchObject({ category: "rate_limited", message: limited("2026-10-22 12:02 UTC (about 2 min)") });
    rig.clock.advance(60_000);
    const e2 = await caught(rig.http.fetch(req('{"other":1}'), rig.ctx("search")));
    expect(e2).toMatchObject({ category: "rate_limited", message: limited("2026-10-22 12:02 UTC (about 1 min)") });
    expect(rig.calls).toHaveLength(1);
    rig.clock.advance(60_000);
    await rig.http.fetch(req('{"other":1}'), rig.ctx());
    expect(rig.calls).toHaveLength(2);
  });

  it.each([
    ["Thu, 22 Oct 2026 12:05:00 GMT", "2026-10-22 12:05 UTC (about 5 min)"],
    ["3600", "2026-10-22 12:15 UTC (about 15 min)"],
  ])("Q136 a 503 with Retry-After %s pauses until %s (HTTP date; capped at 15 minutes)", async (ra, until) => {
    const rig = httpRig(() => jsonResponse({}, 503, { "retry-after": ra }));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(e).toMatchObject({ category: "rate_limited", message: limited(until, 503) });
    expect(rig.calls).toHaveLength(1);
  });

  it.each(["1.5", "-1", "5 GMT"])(
    "Q136 a Retry-After of %s is neither whole seconds nor an HTTP date, so it counts as absent: the escalating pause applies",
    async (ra) => {
      const rig = httpRig(() => jsonResponse({}, 503, { "retry-after": ra }));
      const e = await caught(rig.http.fetch(req(), rig.ctx()));
      expect(e).toMatchObject({ category: "rate_limited", message: limited("2026-10-22 12:01 UTC (about 1 min)", 503) });
      expect(rig.calls).toHaveLength(1);
    },
  );

  it("Q136 without Retry-After the pauses escalate 1, 5, 15, 15 minutes, and reset after 30 minutes without an episode", async () => {
    const rig = httpRig(() => jsonResponse({}, 503));
    const until = async () => {
      const e = await caught(rig.http.fetch(req(`{"t":${rig.clock.now()}}`), rig.ctx()));
      return (e as ToolError).message.match(/until (.+ UTC) \(about (\d+) min\)/)!.slice(1);
    };
    expect(await until()).toEqual(["2026-10-22 12:01 UTC", "1"]);
    rig.clock.advance(60_000);
    expect(await until()).toEqual(["2026-10-22 12:06 UTC", "5"]);
    rig.clock.advance(300_000);
    expect(await until()).toEqual(["2026-10-22 12:21 UTC", "15"]);
    rig.clock.advance(900_000);
    expect(await until()).toEqual(["2026-10-22 12:36 UTC", "15"]);
    rig.clock.advance(31 * 60_000);
    expect(await until()).toEqual(["2026-10-22 12:53 UTC", "1"]);
    expect(rig.calls).toHaveLength(5);
  });

  it("Q136 ¶7 a 429 whose pause ends within 10 s is retried inside the call; the retries are not charged to the call's cap", async () => {
    const statuses = [429, 429, 200];
    const rig = httpRig((_c, i) => (statuses[i] === 200 ? OK() : jsonResponse({}, 429, { "retry-after": "5" })), {
      config: { spacingMs: 0 },
    });
    const ctx = rig.ctx();
    const res = await rig.http.fetch(req(), ctx);
    expect(res.status).toBe(200);
    expect(rig.calls.map((c) => c.at - rig.calls[0].at)).toEqual([0, 5000, 10000]);
    expect(ctx.requestsUsed).toBe(1);
  });

  it("¶7 a call with maxRequests 1 gets its in-call 429 retry: a 429 Retry-After 5 then 200 → 200, 2 fetches, requestsUsed 1", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? jsonResponse({}, 429, { "retry-after": "5" }) : OK()), { config: { spacingMs: 0 } });
    const ctx = rig.ctx("get_post", { maxRequests: 1 });
    expect((await rig.http.fetch(req(), ctx)).status).toBe(200);
    expect(rig.calls).toHaveLength(2);
    expect(ctx.requestsUsed).toBe(1);
    expect(ctx.mayStartRequest()).toBe(false);
  });

  it("Q136 at most two in-call retries: a third 429 is rate_limited", async () => {
    const rig = httpRig(() => jsonResponse({}, 429, { "retry-after": "5" }), { config: { spacingMs: 0 } });
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(3);
    expect(e).toMatchObject({ category: "rate_limited", message: limited("2026-10-22 12:01 UTC (about 1 min)") });
  });

  it("Q136 no in-call retry when the pause would end after the 40 s mark", async () => {
    const rig = httpRig(() => jsonResponse({}, 429, { "retry-after": "5" }), { config: { spacingMs: 0 } });
    const ctx = rig.ctx();
    rig.clock.advance(36_000);
    const e = await caught(rig.http.fetch(req(), ctx));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({ category: "rate_limited" });
  });
});

describe("retries and failures (¶7 table)", () => {
  it("a 502 with an empty body is retried once after 3 s plus up to 20 % jitter, then forum_error", async () => {
    const rig = httpRig(() => new Response("", { status: 502 }));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls.map((c) => c.at - rig.calls[0].at)).toEqual([0, 3300]);
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (HTTP 502). Try again later.",
    });
  });

  it("a 500 then a 200 succeeds on the retry", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? new Response("", { status: 500 }) : OK()));
    expect((await rig.http.fetch(req(), rig.ctx())).status).toBe(200);
    expect(rig.calls).toHaveLength(2);
  });

  it("¶7 a call with maxRequests 1 gets its transient retry: an empty 502 then 200 → 200, 2 fetches, requestsUsed 1", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? new Response("", { status: 502 }) : OK()));
    const ctx = rig.ctx("get_post", { maxRequests: 1 });
    expect((await rig.http.fetch(req(), ctx)).status).toBe(200);
    expect(rig.calls).toHaveLength(2);
    expect(ctx.requestsUsed).toBe(1);
    expect(ctx.mayStartRequest()).toBe(false);
  });

  it("¶7 a call with maxRequests 1 gets its transient retry: a network error then 200 → 200, 2 fetches, requestsUsed 1", async () => {
    const rig = httpRig((_c, i) => {
      if (i === 0) throw new TypeError("fetch failed");
      return OK();
    });
    const ctx = rig.ctx("get_post", { maxRequests: 1 });
    expect((await rig.http.fetch(req(), ctx)).status).toBe(200);
    expect(rig.calls).toHaveLength(2);
    expect(ctx.requestsUsed).toBe(1);
  });

  it("¶7 D13 a transient retry keeps the spacing between request starts: with spacing 5 s the retry starts at 5 s, not 3.3 s", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? new Response("", { status: 502 }) : OK()), { config: { spacingMs: 5000 } });
    expect((await rig.http.fetch(req(), rig.ctx())).status).toBe(200);
    expect(rig.calls.map((c) => c.at - rig.calls[0].at)).toEqual([0, 5000]);
  });

  it("¶7 D13 a transient retry is counted in the session windows", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? new Response("", { status: 502 }) : OK()), {
      config: { spacingMs: 0, sessionWindows: [{ ms: 600_000, requests: 2, bytes: 104_857_600, label: "10 minutes" }] },
    });
    expect((await rig.http.fetch(req('{"n":1}'), rig.ctx())).status).toBe(200);
    expect(rig.calls).toHaveLength(2);
    expect(await caught(rig.http.fetch(req('{"n":2}'), rig.ctx()))).toMatchObject({ category: "politeness_cap" });
    expect(rig.calls).toHaveLength(2);
  });

  it("¶7 a transient retry whose delay crosses the 40 s mark is refused as time limit and not sent", async () => {
    const rig = httpRig(() => new Response("", { status: 502 }));
    const ctx = rig.ctx();
    rig.clock.advance(38_000);
    await expect(rig.http.fetch(req(), ctx)).rejects.toMatchObject({ reason: "time limit" });
    expect(rig.calls).toHaveLength(1);
    expect(ctx.stopped).toBe("time limit");
  });

  it("Q86 a search 500 after its retry is forum_error \"the forum's search failed\"", async () => {
    const rig = httpRig(() => new Response("", { status: 500 }));
    const e = await caught(rig.http.fetch(req('{"queries":[]}', "search"), rig.ctx("search")));
    expect(rig.calls).toHaveLength(2);
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while searching (the forum's search failed). Try again later.",
    });
  });

  it("a 500 with a JSON body is not retried", async () => {
    const rig = httpRig(() => jsonResponse({ errors: [] }, 500));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({ message: "The forum returned an error while loading the post (HTTP 500). Try again later." });
  });

  it("S1 a 3xx is never followed and never retried", async () => {
    const rig = httpRig(
      () => new Response(null, { status: 302, headers: { location: "https://www.alignmentforum.org/" } }),
    );
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (the forum redirected the request). Try again later.",
    });
  });

  it("a non-JSON 200 (possible bot check) is forum_error with no retry", async () => {
    const rig = httpRig(() => new Response("<html>challenge</html>", { status: 200 }));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({
      category: "forum_error",
      message:
        "The forum returned an error while loading the post (unexpected non-JSON response (possibly bot protection)). Try again later.",
    });
  });

  it("a non-JSON 400 on the GraphQL endpoint (a bot check served as a 4xx) is forum_error with no retry and doubles the spacing, like a non-JSON 200", async () => {
    const rig = httpRig((_c, i) => (i === 0 ? new Response("<html>challenge</html>", { status: 400 }) : OK()));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({
      category: "forum_error",
      message:
        "The forum returned an error while loading the post (unexpected non-JSON response (possibly bot protection)). Try again later.",
    });
    await rig.http.fetch(req('{"n":2}'), rig.ctx());
    expect(rig.calls[1].at - rig.calls[0].at).toBe(6000);
  });

  it("§5 a text 400 from the search endpoint is the forum's own error shape: returned to the caller, the spacing unchanged", async () => {
    const rig = httpRig((_c, i) =>
      i === 0 ? new Response("Invalid facet: x", { status: 400, headers: { "content-type": "text/plain" } }) : OK(),
    );
    expect(await rig.http.fetch(req("{}", "search"), rig.ctx("search"))).toMatchObject({ status: 400, text: "Invalid facet: x" });
    await rig.http.fetch(req('{"n":2}'), rig.ctx());
    expect(rig.calls[1].at - rig.calls[0].at).toBe(3000);
  });

  it("any other status is forum_error HTTP <status>, not retried", async () => {
    const rig = httpRig(() => new Response("", { status: 404 }));
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(1);
    expect(e).toMatchObject({ message: "The forum returned an error while loading the post (HTTP 404). Try again later." });
  });

  it("S7 a 400 is returned to the caller, GraphQL JSON and search text alike", async () => {
    const rig = httpRig((c) =>
      c.url.endsWith("/graphql")
        ? jsonResponse({ errors: [{ message: "x" }] }, 400)
        : new Response("Invalid facet: x", { status: 400, headers: { "content-type": "text/plain" } }),
    );
    expect(await rig.http.fetch(req(), rig.ctx())).toMatchObject({ status: 400, text: '{"errors":[{"message":"x"}]}' });
    expect(await rig.http.fetch(req("{}", "search"), rig.ctx("search"))).toMatchObject({
      status: 400,
      text: "Invalid facet: x",
    });
    expect(rig.calls).toHaveLength(2);
  });

  it("¶7 a network error then an empty 502 makes exactly two fetches, then forum_error (HTTP 502): one transient retry per fetch, whichever failure used it", async () => {
    const rig = httpRig((_c, i) => {
      if (i === 0) throw new TypeError("fetch failed");
      return new Response("", { status: 502 });
    });
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(2);
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (HTTP 502). Try again later.",
    });
  });

  it.each([
    [504, () => new Response("", { status: 504 }), 2, "HTTP 504"],
    [0, () => Response.error(), 1, "the forum redirected the request"],
  ])("¶7 status %i: %i fetches, then forum_error (%s)", async (_status, answer, fetches, short) => {
    const rig = httpRig(answer);
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls).toHaveLength(fetches);
    expect(e).toMatchObject({ category: "forum_error", message: `The forum returned an error while loading the post (${short}). Try again later.` });
  });

  it("a network error is retried once after 3 s plus jitter, then forum_error", async () => {
    const rig = httpRig(() => {
      throw new TypeError("fetch failed");
    });
    const e = await caught(rig.http.fetch(req(), rig.ctx()));
    expect(rig.calls.map((c) => c.at - rig.calls[0].at)).toEqual([0, 3300]);
    expect(e).toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (network error). Try again later.",
    });
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t network-error 0ms 0B miss", "[lesswrong-mcp] t network-error 0ms 0B miss"]);
  });
});

describe("time, cancellation, budget, logs", () => {
  it("the per-request timeout is min(45 s, time left before 50 s), from setTimeout, never retried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rig = httpRig(pending);
      const ctx = rig.ctx();
      rig.clock.advance(20_000);
      let settled: unknown = "pending";
      const p = rig.http.fetch(req(), ctx).then(
        () => (settled = "resolved"),
        (e) => (settled = e),
      );
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toMatchObject({
        category: "timeout",
        message:
          "The forum did not answer in time while loading the post (about 50 s per call). Large discussions can be slow; try again, or narrow the request.",
      });
      expect(rig.calls).toHaveLength(1);
      // The rig's FakeClock does not move with vi's timers, so the line reads 0ms.
      expect(rig.logLines).toEqual(["[lesswrong-mcp] t timeout 0ms 0B miss"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("¶7 the spacing wait ends at the call's 40 s mark: a call whose next slot lies past the mark stops at the mark, not at the slot", async () => {
    const rig = httpRig(OK, { config: { spacingMs: 30_000 } });
    const t0 = rig.clock.now();
    const ctx = rig.ctx(); // started at t0: its mark is t0 + 40 s
    rig.clock.advance(25_000);
    await rig.http.fetch(req('{"other":1}'), rig.ctx()); // starts at t0 + 25 s, so the next slot is t0 + 55 s
    await expect(rig.http.fetch(req(), ctx)).rejects.toMatchObject({ reason: "time limit" });
    expect(rig.clock.now() - t0).toBe(40_000);
    expect(ctx.stopped).toBe("time limit");
    expect(rig.calls).toHaveLength(1);
  });

  it("¶7 a call queued behind a hung request stops at its own 40 s mark, before that request's 45 s timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rig = httpRig(pending, { config: { spacingMs: 30_000 } });
      const ctxA = rig.ctx("get_comments");
      const ctxB = rig.ctx("get_user");
      const a = caught(rig.http.fetch(req('{"a":1}'), ctxA));
      let settled: unknown = "pending";
      const b = rig.http.fetch(req('{"b":1}'), ctxB).then(
        () => (settled = "resolved"),
        (e) => (settled = e),
      );
      // A's request goes out at t0 (its timeout is then the full 45 s); B queues behind it.
      await vi.advanceTimersByTimeAsync(0);
      expect(rig.calls).toHaveLength(1);
      rig.clock.advance(39_999);
      await vi.advanceTimersByTimeAsync(39_999);
      expect(settled).toBe("pending");
      rig.clock.advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ reason: "time limit" });
      expect(ctxB.stopped).toBe("time limit");
      expect(rig.calls).toHaveLength(1);
      // The hung request itself still times out at 45 s.
      rig.clock.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await a).toMatchObject({ category: "timeout" });
      await b;
      expect(rig.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never uses AbortSignal.timeout", () => {
    expect(readFileSync("src/forum/http.ts", "utf8")).not.toContain("AbortSignal.timeout");
  });

  it("MCP cancellation aborts the request in flight and rejects with the signal's reason", async () => {
    const rig = httpRig(pending);
    const ac = new AbortController();
    const reason = new Error("cancelled by the client");
    const p = caught(rig.http.fetch(req(), rig.ctx("get_post", { signal: ac.signal })));
    await vi.waitFor(() => expect(rig.calls).toHaveLength(1));
    ac.abort(reason);
    expect(await p).toBe(reason);
    expect(rig.calls[0].init.signal!.aborted).toBe(true);
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t cancelled 0ms 0B miss"]);
  });

  it("a call cancelled while waiting in the queue never sends", async () => {
    let release!: () => void;
    const rig = httpRig((_c, i) => (i === 0 ? new Promise<Response>((r) => (release = () => r(OK()))) : OK()));
    const first = rig.http.fetch(req('{"n":1}'), rig.ctx());
    const ac = new AbortController();
    const reason = new Error("cancelled");
    const second = caught(rig.http.fetch(req('{"n":2}'), rig.ctx("get_post", { signal: ac.signal })));
    await vi.waitFor(() => expect(rig.calls).toHaveLength(1));
    ac.abort(reason);
    release();
    await first;
    expect(await second).toBe(reason);
    expect(rig.calls).toHaveLength(1);
  });

  it("¶7 ctx.beginRequest() runs before each send: the request cap and the 40 s rule stop the call with no request", async () => {
    const rig = httpRig(OK);
    const ctx = rig.ctx("get_post", { maxRequests: 1 });
    await rig.http.fetch(req('{"n":1}'), ctx);
    await expect(rig.http.fetch(req('{"n":2}'), ctx)).rejects.toMatchObject({ reason: "request cap" });
    const late = rig.ctx();
    rig.clock.advance(40_001);
    await expect(rig.http.fetch(req('{"n":3}'), late)).rejects.toMatchObject({ reason: "time limit" });
    expect(rig.calls).toHaveLength(1);
  });

  it("¶7 logs one stderr line per answer: label, status, ms, bytes, hit or miss", async () => {
    const rig = httpRig(OK);
    await rig.http.fetch(req(), rig.ctx());
    expect(rig.logLines).toEqual(["[lesswrong-mcp] t 200 0ms 16B miss"]);
  });
});
