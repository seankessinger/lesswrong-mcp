import { describe, expect, it } from "vitest";
import { createCallContext } from "../../src/call/context";
import { CallStopped } from "../../src/errors";
import type { PublicPostId } from "../../src/types";
import { createClock } from "../support/clock";

const START = "2026-10-22T12:00:00.000Z";

describe("fake clock", () => {
  it("now, advance, and a sleep that advances virtual time", async () => {
    const clock = createClock(START);
    expect(clock.now()).toBe(Date.parse(START));
    clock.advance(1500);
    await clock.sleep(3000);
    expect(clock.now()).toBe(Date.parse(START) + 4500);
  });
  it("sleep rejects with the signal's reason when aborted", async () => {
    const clock = createClock(START);
    const ac = new AbortController();
    ac.abort(new Error("cancelled by the client"));
    await expect(clock.sleep(1000, ac.signal)).rejects.toThrow("cancelled by the client");
    expect(clock.now()).toBe(Date.parse(START));
  });
  it("sleep with a signal that is not aborted still advances time", async () => {
    const clock = createClock(START);
    await clock.sleep(250, new AbortController().signal);
    expect(clock.now()).toBe(Date.parse(START) + 250);
  });
  it("the three functions are closures: safe to pass unbound", async () => {
    const { now, sleep, advance } = createClock(START);
    advance(100);
    await sleep(200);
    expect(now()).toBe(Date.parse(START) + 300);
  });
});

describe("CallContext (¶2.2 step 5, ¶7 cap semantics)", () => {
  it("the per-tool request cap from CONFIG; beginRequest counts and then throws CallStopped", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_post", { now: clock.now });
    expect([ctx.tool, ctx.maxRequests, ctx.requestsUsed, ctx.startedAt]).toEqual(["get_post", 3, 0, Date.parse(START)]);
    ctx.beginRequest();
    ctx.beginRequest();
    ctx.beginRequest();
    expect(ctx.requestsUsed).toBe(3);
    expect(ctx.mayStartRequest()).toBe(false);
    expect(() => ctx.beginRequest()).toThrow(CallStopped);
    expect(ctx.stopped).toBe("request cap");
    expect(ctx.requestsUsed).toBe(3);
    expect(createCallContext("get_history", { now: clock.now }).maxRequests).toBe(7);
    expect(createCallContext("find", { now: clock.now, maxRequests: 1 }).maxRequests).toBe(1);
  });

  it("no new request after 40 s; the reason recorded is the first one met", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_history", { now: clock.now });
    clock.advance(39_999);
    expect(ctx.mayStartRequest()).toBe(true);
    expect(ctx.stopped).toBeUndefined();
    clock.advance(1);
    expect(ctx.mayStartRequest()).toBe(false);
    expect(ctx.stopped).toBe("time limit");
    try {
      ctx.beginRequest();
      throw new Error("expected CallStopped");
    } catch (e) {
      expect(e).toBeInstanceOf(CallStopped);
      expect((e as CallStopped).reason).toBe("time limit");
    }
  });

  it("the first reason met stays recorded: the request cap, then 40 s, is still the request cap", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_post", { now: clock.now, maxRequests: 1 });
    ctx.beginRequest();
    expect(ctx.mayStartRequest()).toBe(false);
    expect(ctx.stopped).toBe("request cap");
    clock.advance(40_000);
    expect(ctx.mayStartRequest()).toBe(false);
    expect(ctx.stopped).toBe("request cap");
    try {
      ctx.beginRequest();
      throw new Error("expected CallStopped");
    } catch (e) {
      expect(e).toBeInstanceOf(CallStopped);
      expect((e as CallStopped).reason).toBe("request cap");
    }
    expect(ctx.requestsUsed).toBe(1);
  });

  it("both limits met at once: the time limit is the reason", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_post", { now: clock.now, maxRequests: 1 });
    ctx.beginRequest();
    clock.advance(40_000);
    expect(ctx.mayStartRequest()).toBe(false);
    expect(ctx.stopped).toBe("time limit");
  });

  it("now() is the injected clock; the methods are closures, safe to destructure", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_post", { now: clock.now });
    const { now, beginRequest, charge, confirmPublic, isConfirmed } = ctx;
    clock.advance(5);
    expect(now()).toBe(Date.parse(START) + 5);
    beginRequest();
    charge(10);
    confirmPublic("tag", "tagId0000000000001");
    expect([ctx.requestsUsed, ctx.bytesUsed, isConfirmed("tag", "tagId0000000000001")]).toEqual([1, 10, true]);
  });

  it("Q16 per-request timeout is min(45 s, time left before the 50 s deadline)", () => {
    const clock = createClock(START);
    const ctx = createCallContext("search", { now: clock.now });
    expect(ctx.requestTimeoutMs()).toBe(45_000);
    clock.advance(10_000);
    expect(ctx.requestTimeoutMs()).toBe(40_000);
    clock.advance(39_000);
    expect(ctx.requestTimeoutMs()).toBe(1_000);
    clock.advance(11_000);
    expect(ctx.requestTimeoutMs()).toBe(0);
  });

  it("20 MB per call: charged bytes stop further requests", () => {
    const ctx = createCallContext("get_comments", { now: createClock(START).now });
    ctx.charge(20_971_519);
    expect(ctx.mayStartRequest()).toBe(true);
    ctx.charge(1);
    expect(ctx.bytesUsed).toBe(20_971_520);
    expect(ctx.mayStartRequest()).toBe(false);
    expect(ctx.stopped).toBe("request cap");
  });

  it("¶7 beginRetry() at the request cap does not throw and leaves requestsUsed: a retry of the same request is not charged", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_tag", { now: clock.now });
    ctx.beginRequest();
    ctx.beginRequest();
    expect(ctx.mayStartRequest()).toBe(false);
    expect(() => ctx.beginRetry()).not.toThrow();
    expect(ctx.requestsUsed).toBe(2);
    expect(() => ctx.beginRequest()).toThrow(CallStopped);
    expect(ctx.requestsUsed).toBe(2);
  });

  it("¶7 beginRetry() after 40 s throws time limit, and past 20 MB throws request cap; it counts no request", () => {
    const clock = createClock(START);
    const ctx = createCallContext("get_post", { now: clock.now, maxRequests: 1 });
    ctx.beginRequest();
    clock.advance(39_999);
    expect(() => ctx.beginRetry()).not.toThrow();
    clock.advance(1);
    try {
      ctx.beginRetry();
      throw new Error("expected CallStopped");
    } catch (e) {
      expect(e).toBeInstanceOf(CallStopped);
      expect((e as CallStopped).reason).toBe("time limit");
    }
    expect(ctx.stopped).toBe("time limit");
    expect(ctx.requestsUsed).toBe(1);

    const heavy = createCallContext("get_comments", { now: createClock(START).now });
    heavy.charge(20_971_520);
    try {
      heavy.beginRetry();
      throw new Error("expected CallStopped");
    } catch (e) {
      expect(e).toBeInstanceOf(CallStopped);
      expect((e as CallStopped).reason).toBe("request cap");
    }
    expect(heavy.requestsUsed).toBe(0);
  });

  it("cancellation: beginRetry throws the signal's reason", () => {
    const ac = new AbortController();
    const ctx = createCallContext("get_post", { now: createClock(START).now, signal: ac.signal });
    ac.abort(new Error("cancelled by the client"));
    expect(() => ctx.beginRetry()).toThrow("cancelled by the client");
    expect(ctx.stopped).toBeUndefined();
  });

  it("cancellation: beginRequest throws the signal's reason", () => {
    const ac = new AbortController();
    const ctx = createCallContext("get_post", { now: createClock(START).now, signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
    ac.abort(new Error("cancelled by the client"));
    expect(() => ctx.beginRequest()).toThrow("cancelled by the client");
    expect(ctx.requestsUsed).toBe(0);
  });

  it("cancellation comes before the caps: a cancelled call with its cap used throws the reason, not CallStopped", () => {
    const ac = new AbortController();
    const ctx = createCallContext("get_post", { now: createClock(START).now, signal: ac.signal, maxRequests: 1 });
    ctx.beginRequest();
    ac.abort(new Error("cancelled by the client"));
    expect(() => ctx.beginRequest()).toThrow("cancelled by the client");
    expect(ctx.stopped).toBeUndefined();
  });

  it("a call given no signal has one that is never aborted", () => {
    const ctx = createCallContext("get_post", { now: createClock(START).now });
    expect(ctx.signal.aborted).toBe(false);
  });

  it("given records the parameter names present; cacheKeys starts empty", () => {
    const ctx = createCallContext("get_comments", { now: createClock(START).now, given: ["post", "sort"] });
    expect([...ctx.given]).toEqual(["post", "sort"]);
    expect(ctx.cacheKeys).toEqual([]);
    expect(createCallContext("get_comments", { now: createClock(START).now }).given.size).toBe(0);
  });

  it("P17 only confirmPublic makes Public ids, one kind at a time", () => {
    const ctx = createCallContext("get_comments", { now: createClock(START).now });
    expect(ctx.isConfirmed("post", "uMQ3cqWDPHhjtiesc")).toBe(false);
    const id: PublicPostId = ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc");
    expect(id).toBe("uMQ3cqWDPHhjtiesc");
    expect(ctx.isConfirmed("post", "uMQ3cqWDPHhjtiesc")).toBe(true);
    expect(ctx.isConfirmed("doc", "uMQ3cqWDPHhjtiesc")).toBe(false);
    // @ts-expect-error a plain string is not a PublicPostId
    const plain: PublicPostId = "uMQ3cqWDPHhjtiesc";
    expect(plain).toBe(id);
  });
});
