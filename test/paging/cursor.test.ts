// test/paging/cursor.test.ts
import { describe, expect, it } from "vitest";
import { CURSOR_RE, checkCursorParams, createCursorStore } from "../../src/paging/cursor";
import { ToolError } from "../../src/errors";
import { createClock } from "../support/clock";
import type { CursorEntry, CursorState } from "../../src/types";

const BAD_CURSOR = "This cursor is unknown: the server restarted since it was issued, it expired, or it belongs to another tool. Repeat the original call without a cursor.";
const STATE: CursorState = { streams: [{ kind: "offset", shown: 10, offset: 20, lastId: "r0019" }], current: 0 };
const MIN = 60_000;
const counter = () => { let n = 0; return (k: number) => Uint8Array.from({ length: k }, () => n++ & 0xff); };
function expectError(f: () => unknown, category: string, message: string): void {
  let err: unknown;
  try { f(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ToolError);
  expect((err as ToolError).category).toBe(category);
  expect((err as ToolError).message).toBe(message);
}

describe("cursor tokens (C1, ¶3.6)", () => {
  it("C1 issues c_ + 22 base64url characters made from randomBytes(16)", () => {
    const sizes: number[] = [];
    const rb = counter();
    const store = createCursorStore({ now: () => 0, randomBytes: (n) => { sizes.push(n); return rb(n); } });
    expect(store.issue("list_posts", {}, {}, STATE)).toBe("c_AAECAwQFBgcICQoLDA0ODw");
    expect(store.issue("list_posts", {}, {}, STATE)).toBe("c_EBESExQVFhcYGRobHB0eHw");
    expect(sizes).toEqual([16, 16]);
    expect(CURSOR_RE.source).toBe("^c_[A-Za-z0-9_-]{22}$");
  });
  it("C1 never repeats a token: a colliding draw is drawn again", () => {
    let calls = 0;
    const store = createCursorStore({ now: () => 0, randomBytes: (n) => (calls++ < 2 ? new Uint8Array(n) : Uint8Array.from({ length: n }, () => 7)) });
    const a = store.issue("search", {}, {}, STATE);
    const b = store.issue("search", {}, {}, STATE);
    expect(a).toBe("c_AAAAAAAAAAAAAAAAAAAAAA");
    expect(b).not.toBe(a);
    expect(CURSOR_RE.test(b)).toBe(true);
  });
  it("C1 stops after 16 draws that all hit held tokens: an internal error, never a duplicate", () => {
    let calls = 0;
    // A source that always answers 16 zero bytes. The guard turns a redraw loop without a bound into a failing test
    // instead of a synchronous hang that the test timeout cannot interrupt.
    const zeros = (n: number) => {
      if (++calls > 64) throw new Error("runaway redraw loop");
      return new Uint8Array(n);
    };
    const store = createCursorStore({ now: () => 0, randomBytes: zeros });
    const held = store.issue("search", {}, {}, STATE);
    expect(held).toBe("c_AAAAAAAAAAAAAAAAAAAAAA");
    expect(calls).toBe(1);
    expectError(() => store.issue("search", {}, {}, STATE), "internal", "Unexpected failure in search (no unused cursor token after 16 draws). Please report this.");
    expect(calls).toBe(17);
    expect(store.take("search", held).tool).toBe("search");
  });
  it("C1 1,000 tokens from node:crypto are distinct and well-formed", () => {
    const store = createCursorStore({ now: () => 0 });
    const tokens = Array.from({ length: 1000 }, () => store.issue("find", {}, {}, STATE));
    expect(new Set(tokens).size).toBe(1000);
    expect(tokens.every((t) => CURSOR_RE.test(t))).toBe(true);
  });
});

describe("cursor store (C1, ¶3.6)", () => {
  it("round-trips the entry", () => {
    const store = createCursorStore({ now: () => 1_000 });
    const effective = { tag: "sYm3HiWcfZvrGu3ui", sort: "top", limit: 10, af_only: false };
    const t = store.issue("list_posts", { tag: "ai" }, effective, STATE);
    expect(store.take("list_posts", t)).toEqual({ tool: "list_posts", args: { tag: "ai" }, effective, state: STATE, issuedAt: 1_000 });
  });
  it("the same token used twice continues from the same place; stored state is a copy", () => {
    const store = createCursorStore({ now: () => 0 });
    const state = structuredClone(STATE);
    const t = store.issue("list_posts", {}, {}, state);
    (state.streams[0] as { offset: number }).offset = 999;
    const first = store.take("list_posts", t);
    (first.state.streams[0] as { offset: number }).offset = 555;
    expect(store.take("list_posts", t).state).toEqual(STATE);
  });
  it("the arguments and effective values are copies too, on the way in and on the way out", () => {
    const store = createCursorStore({ now: () => 0 });
    const args = { phrases: ["mesa optimizer"] };
    const effective = { phrases: ["mesa optimizer"], limit: 10 };
    const t = store.issue("search", args, effective, STATE);
    args.phrases.push("changed");
    effective.limit = 99;
    const first = store.take("search", t);
    (first.args.phrases as string[]).push("also changed");
    (first.effective as { limit: number }).limit = 77;
    const again = store.take("search", t);
    expect(again.args).toEqual({ phrases: ["mesa optimizer"] });
    expect(again.effective).toEqual({ phrases: ["mesa optimizer"], limit: 10 });
  });
  it("C1 malformed, altered and unknown tokens are bad_cursor", () => {
    const store = createCursorStore({ now: () => 0, randomBytes: counter() });
    const t = store.issue("list_posts", {}, {}, STATE);
    for (const bad of ["", "c_short", "x".repeat(24), t + "A", t.slice(0, -1) + "x", "c_AAECAwQFBgcICQoLDA0OD!"]) {
      expectError(() => store.take("list_posts", bad), "bad_cursor", BAD_CURSOR);
    }
  });
  it("C1 a token with a trailing newline is malformed, not the token it ends with", () => {
    const store = createCursorStore({ now: () => 0, randomBytes: counter() });
    const t = store.issue("list_posts", {}, {}, STATE);
    expectError(() => store.take("list_posts", t + "\n"), "bad_cursor", BAD_CURSOR);
  });
  it("C1 a token presented to another tool is bad_cursor, also a hand-off cursor minted for list_posts by get_tag", () => {
    const store = createCursorStore({ now: () => 0 });
    const t = store.issue("list_posts", { tag: "interpretability-ml-and-ai" }, { tag: "56yXXrcxRjrQs6z9R", sort: "top", limit: 10, af_only: false }, STATE);
    expectError(() => store.take("get_tag", t), "bad_cursor", BAD_CURSOR);
    expect(store.take("list_posts", t).tool).toBe("list_posts");
  });
  it("C1 a fresh store stands for a restart", () => {
    const t = createCursorStore({ now: () => 0 }).issue("search", {}, {}, STATE);
    expectError(() => createCursorStore({ now: () => 0 }).take("search", t), "bad_cursor", BAD_CURSOR);
  });
  it("C1 expires 60 minutes after issue, however often it is used", () => {
    const clock = createClock("2026-10-22T12:00:00.000Z");
    const store = createCursorStore({ now: () => clock.now() });
    const t = store.issue("get_comments", {}, {}, STATE);
    clock.advance(30 * MIN);
    expect(store.take("get_comments", t).tool).toBe("get_comments");
    clock.advance(29 * MIN);
    expect(store.take("get_comments", t).tool).toBe("get_comments");
    clock.advance(2 * MIN);
    expectError(() => store.take("get_comments", t), "bad_cursor", BAD_CURSOR);
  });
  it("C1 is alive until the last millisecond before 60 minutes after issue, and gone at the 60th minute", () => {
    const clock = createClock("2026-10-22T12:00:00.000Z");
    const store = createCursorStore({ now: () => clock.now() });
    const t = store.issue("get_comments", {}, {}, STATE);
    clock.advance(60 * MIN - 1);
    expect(store.take("get_comments", t).tool).toBe("get_comments");
    clock.advance(1);
    expectError(() => store.take("get_comments", t), "bad_cursor", BAD_CURSOR);
  });
  it("C1 evicts the least recently used entry past 1,000", () => {
    const store = createCursorStore({ now: () => 0 });
    const tokens = Array.from({ length: 1001 }, () => store.issue("find", {}, {}, STATE));
    expectError(() => store.take("find", tokens[0]), "bad_cursor", BAD_CURSOR);
    expect(store.take("find", tokens[1]).tool).toBe("find");
    expect(store.take("find", tokens[1000]).tool).toBe("find");
  });
  it("C1 using a token makes it recently used: the unused entry is the one evicted", () => {
    const store = createCursorStore({ now: () => 0, maxEntries: 2 });
    const a = store.issue("find", {}, {}, STATE);
    const b = store.issue("find", {}, {}, STATE);
    store.take("find", a);
    const c = store.issue("find", {}, {}, STATE);
    expectError(() => store.take("find", b), "bad_cursor", BAD_CURSOR);
    expect(store.take("find", a).tool).toBe("find");
    expect(store.take("find", c).tool).toBe("find");
  });
  it("honours its own maxEntries and ttlMs options", () => {
    const clock = createClock("2026-10-22T12:00:00.000Z");
    const store = createCursorStore({ now: () => clock.now(), ttlMs: 5_000, maxEntries: 1 });
    const a = store.issue("find", {}, {}, STATE);
    const b = store.issue("find", {}, {}, STATE);
    expectError(() => store.take("find", a), "bad_cursor", BAD_CURSOR);
    clock.advance(4_999);
    expect(store.take("find", b).tool).toBe("find");
    clock.advance(1);
    expectError(() => store.take("find", b), "bad_cursor", BAD_CURSOR);
  });
});

describe("parameters given with a cursor (¶3.6)", () => {
  const entry: CursorEntry = {
    tool: "list_posts", args: { tag: "interpretability-ml-and-ai" },
    effective: { tag: "56yXXrcxRjrQs6z9R", sort: "top", limit: 10, af_only: false, phrases: ["mesa optimizer"], items: [{ kind: "post", query: "x" }] },
    state: STATE, issuedAt: 0,
  };
  const tail = ". Pass only the cursor to continue, or repeat the call without it to start over.";
  it("accepts a repeated default, a pasted hand-off call and equal structured values; ignores cursor and max_tokens", () => {
    expect(() => checkCursorParams(entry, { sort: "top" })).not.toThrow();
    expect(() => checkCursorParams(entry, { tag: "56yXXrcxRjrQs6z9R", sort: "top", cursor: "c_AAECAwQFBgcICQoLDA0ODw", max_tokens: 4000 })).not.toThrow();
    expect(() => checkCursorParams(entry, { phrases: ["mesa optimizer"], items: [{ query: "x", kind: "post" }] })).not.toThrow();
  });
  it("refuses a conflicting parameter with the spec's message", () => {
    expectError(() => checkCursorParams(entry, { sort: "new" }), "bad_input", 'this cursor was issued for different parameters (sort: cursor has "top", call has "new")' + tail);
    expectError(() => checkCursorParams(entry, { limit: 20 }), "bad_input", "this cursor was issued for different parameters (limit: cursor has 10, call has 20)" + tail);
    expectError(() => checkCursorParams(entry, { user: "nmk3nLpQE89dMRzzN" }), "bad_input", 'this cursor was issued for different parameters (user: cursor has none, call has "nmk3nLpQE89dMRzzN")' + tail);
    expectError(() => checkCursorParams(entry, { phrases: ["mesa optimizers"] }), "bad_input", 'this cursor was issued for different parameters (phrases: cursor has ["mesa optimizer"], call has ["mesa optimizers"])' + tail);
  });
  it("names the first mismatch in the order the parameters were given", () => {
    expectError(() => checkCursorParams(entry, { limit: 20, sort: "new" }), "bad_input", "this cursor was issued for different parameters (limit: cursor has 10, call has 20)" + tail);
    expectError(() => checkCursorParams(entry, { sort: "new", limit: 20 }), "bad_input", 'this cursor was issued for different parameters (sort: cursor has "top", call has "new")' + tail);
  });
  it("compares arrays by position and objects by key, strictly", () => {
    const e: CursorEntry = { ...entry, effective: { phrases: ["a", "b"], items: [{ kind: "post", query: "x" }], flag: false, none: null } };
    expect(() => checkCursorParams(e, { phrases: ["a", "b"] })).not.toThrow();
    for (const given of [
      { phrases: ["b", "a"] }, { phrases: ["a"] }, { phrases: ["a", "b", "c"] }, { phrases: "a,b" },
      { items: [{ kind: "post" }] }, { items: [{ kind: "post", query: "x", extra: 1 }] }, { items: [{ kind: "post", query: "y" }] },
      { items: { 0: { kind: "post", query: "x" } } }, { flag: 0 }, { flag: "false" }, { none: undefined }, { none: {} },
    ]) {
      expect(() => checkCursorParams(e, given), JSON.stringify(given)).toThrow(ToolError);
    }
  });
  it("shows an absent value as none and cuts a long value to 60 characters on one line", () => {
    const long = ["x".repeat(80)];
    expectError(() => checkCursorParams(entry, { phrases: long }), "bad_input",
      `this cursor was issued for different parameters (phrases: cursor has ["mesa optimizer"], call has ["${"x".repeat(57)}…)` + tail);
    expectError(() => checkCursorParams(entry, { user: "a\u{2028}b" }), "bad_input", 'this cursor was issued for different parameters (user: cursor has none, call has "a b")' + tail);
  });
  it("looks parameters up among the entry's own values only", () => {
    expectError(() => checkCursorParams(entry, { constructor: "x" }), "bad_input", 'this cursor was issued for different parameters (constructor: cursor has none, call has "x")' + tail);
    expectError(() => checkCursorParams(entry, { toString: "x" }), "bad_input", 'this cursor was issued for different parameters (toString: cursor has none, call has "x")' + tail);
  });
});
