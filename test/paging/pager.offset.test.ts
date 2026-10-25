import { describe, expect, it } from "vitest";
import { collect, rawPageSize, stateAfter, type OffsetSource } from "../../src/paging/pager";
import { END_DEPTH, END_DEPTH_GUARD, SHORT_PAGE_NOTE } from "../../src/render/messages";
import { createCallContext } from "../../src/call/context";
import { CallStopped } from "../../src/errors";
import { createClock } from "../support/clock";
import { T0, ctxOf, ids, keysetSource, offsetSource, rows, type KeysetCall, type OffsetCall, type Row } from "../support/pagerSources";
import type { StreamState } from "../../src/types";

const all = () => true;

describe("raw page size (¶3.6)", () => {
  it("is min(100, max(2 × limit, 20))", () => {
    expect([1, 10, 11, 50, 60].map(rawPageSize)).toEqual([20, 20, 22, 100, 100]);
  });
});

describe("offset streams and the fullness test (¶3.6)", () => {
  it("Q5 an empty raw page mid-list is stepped over, not taken as the end", async () => {
    const log: OffsetCall[] = [];
    const c = await collect(offsetSource(rows(25, (i) => i < 20), true, log), undefined, 10, all, ctxOf());
    expect(ids(c.items)).toEqual(["r0020", "r0021", "r0022", "r0023", "r0024"]);
    expect([c.ended, c.endLine]).toEqual([true, undefined]);
    expect(log).toEqual([{ offset: 0, size: 20, first: true }, { offset: 20, size: 20, first: false }]);
  });
  it("Q6 a short raw page of a bounded selector holds every remaining row", async () => {
    const src = offsetSource(rows(15), true);
    const c1 = await collect(src, undefined, 10, all, ctxOf());
    expect(ids(c1.items)).toEqual(ids(rows(10)));
    expect(c1.ended).toBe(false);
    expect(stateAfter(c1, 10)).toEqual({ kind: "offset", shown: 10, offset: 0, lastId: "r0009" });
    const ctx2 = ctxOf();
    const c2 = await collect(src, stateAfter(c1, 10), 10, all, ctx2);
    expect(ids(c2.items)).toEqual(["r0010", "r0011", "r0012", "r0013", "r0014"]);
    expect(c2.ended).toBe(true);
    expect(ctx2.requestsUsed).toBe(1);
  });
  it("Q6 a full raw page continues at offset + raw page size, never + visible rows", async () => {
    const raw = rows(60, (i) => i % 2 === 1);
    let state: StreamState | undefined;
    const offsets: number[] = [];
    const ended: boolean[] = [];
    for (let call = 0; call < 3; call++) {
      const log: OffsetCall[] = [];
      const c = await collect(offsetSource(raw, true, log), state, 10, all, ctxOf());
      offsets.push(...log.map((l) => l.offset));
      ended.push(c.ended);
      state = stateAfter(c, 10);
    }
    expect(offsets).toEqual([0, 20, 40]);
    expect(ended).toEqual([false, false, true]);
    expect(state).toBeUndefined();
  });
  it("Q15 resumes a re-read raw page after the last id shown; offset streams are flagged for drift", async () => {
    const src = offsetSource(rows(100), true);
    const c1 = await collect(src, { kind: "offset", shown: 10, offset: 0, lastId: "r0009" }, 5, all, ctxOf());
    expect(ids(c1.items)).toEqual(["r0010", "r0011", "r0012", "r0013", "r0014"]);
    const c2 = await collect(src, { kind: "offset", shown: 15, offset: 15, lastId: "r0014" }, 5, all, ctxOf()); // a hand-off at the next raw row
    expect(ids(c2.items)).toEqual(["r0015", "r0016", "r0017", "r0018", "r0019"]);
    expect(c1.drift).toBe(true);
    expect((await collect(keysetSource(rows(30), "new"), undefined, 5, all, ctxOf())).drift).toBe(false);
  });
  it("Q4 never sends an offset above 2000 and ends with the C-DEPTH line", async () => {
    const raw = rows(3000);
    const log: OffsetCall[] = [];
    const c1 = await collect(offsetSource(raw, true, log), { kind: "offset", shown: 1990, offset: 1990 }, 10, all, ctxOf());
    expect([c1.items[0].id, c1.items[9].id, c1.ended]).toEqual(["r1990", "r1999", false]);
    const c2 = await collect(offsetSource(raw, true, log), stateAfter(c1, 10), 10, all, ctxOf());
    expect([c2.items[0].id, c2.items[9].id]).toEqual(["r2000", "r2009"]);
    expect([c2.ended, c2.endLine]).toEqual([true, END_DEPTH]);
    expect(log.every((l) => l.offset <= 2000)).toBe(true);
  });
  it("¶3.6 the C-DEPTH end line carries the source's hint when it has one, for offset and keyset streams alike", async () => {
    const withHint = { ...offsetSource(rows(2010), false), endHint: "use x to shorten the list" };
    const c = await collect(withHint, { kind: "offset", shown: 2000, offset: 2000 }, 20, all, ctxOf());
    expect([c.ended, c.endLine]).toEqual([true, `${END_DEPTH}; use x to shorten the list`]);
    const start: StreamState = { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 1990 };
    const k = await collect({ ...keysetSource(rows(2100, (i) => i >= 1990 && i < 2010, "h"), "new"), endHint: "narrow with y" }, start, 10, all, ctxOf());
    expect([k.ended, k.endLine]).toEqual([true, `${END_DEPTH}; narrow with y`]);
  });
  it("refuses a start state of another kind", async () => {
    await expect(collect(offsetSource(rows(5), true), { kind: "list", shown: 0, index: 0 }, 10, all, ctxOf())).rejects.toMatchObject({ category: "internal" });
  });
  it("refuses a keyset start state of the other direction", async () => {
    const start: StreamState = { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 0 };
    await expect(collect(keysetSource(rows(5), "old"), start, 10, all, ctxOf())).rejects.toMatchObject({ category: "internal" });
  });
  it("Q6 a bounded first page that came back without a total is not taken as the end: the empty-page rule decides", async () => {
    const src = offsetSource(rows(45, (i) => i < 15), true);
    const noTotal: OffsetSource<Row> = { ...src, fetch: async (o, s, f, x) => ({ ...(await src.fetch(o, s, f, x)), totalCount: null }) };
    const c = await collect(noTotal, undefined, 10, all, ctxOf());
    expect(ids(c.items)).toEqual(ids(rows(25)).slice(15));
    expect(c.ended).toBe(false);
  });
});

describe("short pages, refills and caps (¶3.6, ¶7)", () => {
  const sparse = () => rows(100, (i) => i % 5 !== 0); // one visible row in five
  it("Q5 refills short raw pages within the request cap", async () => {
    const log: OffsetCall[] = [];
    const c = await collect(offsetSource(sparse(), false, log), undefined, 10, all, ctxOf());
    expect(c.items).toHaveLength(10);
    expect(log.map((l) => l.offset)).toEqual([0, 20, 40]);
    expect(c.note).toBeUndefined();
  });
  it("P10 stops at the request cap with the neutral short-page note and a cursor after every row checked; no count", async () => {
    const c = await collect(offsetSource(sparse(), false), undefined, 10, all, ctxOf(2));
    expect(c.items).toHaveLength(8);
    expect([c.stopped, c.ended, c.note]).toEqual(["request cap", false, SHORT_PAGE_NOTE]);
    expect(stateAfter(c, 8)).toEqual({ kind: "offset", shown: 8, offset: 40 });
    expect(c).not.toHaveProperty("totalCount");
  });
  it("names the requested filter that caused a short page", async () => {
    const c = await collect(offsetSource(sparse(), false), undefined, 10, (r) => r.id !== "r0000" && r.id !== "r0025", ctxOf(2), { filterName: "min_karma", unit: "posts" });
    expect([c.items.length, c.checked, c.kept]).toEqual([6, 8, 6]);
    expect(c.note).toBe("min_karma kept 6 of the 8 posts checked; continue with the cursor.");
  });
  it("stops at the 40 s rule with stopped 'time limit'", async () => {
    const clock = createClock("2024-06-01T00:00:00.000Z");
    const ctx = createCallContext("list_posts", { now: () => clock.now() });
    const src = offsetSource(rows(1000, (i) => i % 20 !== 0), false);
    const timed: OffsetSource<Row> = { ...src, fetch: async (o, s, f, x) => { const p = await src.fetch(o, s, f, x); clock.advance(15_000); return p; } };
    const c = await collect(timed, undefined, 10, all, ctx);
    expect([ctx.requestsUsed, c.items.length, c.stopped]).toEqual([3, 3, "time limit"]);
  });
  it("a refill that passes the 40 s mark while it waits for the transport ends the page stopped, keeping what was collected", async () => {
    const clock = createClock("2024-06-01T00:00:00.000Z");
    const ctx = createCallContext("list_posts", { now: () => clock.now() });
    const src = offsetSource(sparse(), false);
    const queued: OffsetSource<Row> = { ...src, fetch: async (o, s, f, x) => { if (!f) clock.advance(41_000); return src.fetch(o, s, f, x); } };
    const c = await collect(queued, undefined, 10, all, ctx);
    expect([ctx.requestsUsed, c.items.length, c.stopped, c.ended, c.note]).toEqual([1, 4, "time limit", false, SHORT_PAGE_NOTE]);
    expect(stateAfter(c, 4)).toEqual({ kind: "offset", shown: 4, offset: 20 });
  });
  it("the call's first raw page is mandatory: a first page that may not start throws CallStopped", async () => {
    await expect(collect(offsetSource(sparse(), false), undefined, 10, all, ctxOf(0))).rejects.toBeInstanceOf(CallStopped);
  });
  it("ends a site-wide list after an empty raw page and two more", async () => {
    const log: OffsetCall[] = [];
    const c = await collect(offsetSource(rows(80, (i) => i >= 5), false, log), undefined, 10, all, ctxOf());
    expect([c.items.length, c.ended]).toEqual([5, true]);
    expect(log.map((l) => l.offset)).toEqual([0, 20, 40, 60]);
  });
  it("Q5 keeps going when one of the extra raw pages has rows", async () => {
    const c = await collect(offsetSource(rows(80, (i) => i >= 5 && i < 60), false), undefined, 10, all, ctxOf());
    expect(ids(c.items)).toEqual(["r0000", "r0001", "r0002", "r0003", "r0004", "r0060", "r0061", "r0062", "r0063", "r0064"]);
    expect(c.ended).toBe(false);
  });
});

describe("keyset streams for new and old (¶3.6)", () => {
  const T = T0 - 8 * 60_000;
  const tied = (): Row[] => Array.from({ length: 30 }, (_, i) => ({ id: "k" + String(i).padStart(2, "0"), t: i >= 8 && i <= 11 ? T : T0 - i * 60_000 }));
  it("Q26 rows sharing the boundary timestamp are neither lost nor repeated (new: before = boundary + 1 ms)", async () => {
    const c1 = await collect(keysetSource(tied(), "new"), undefined, 10, all, ctxOf());
    expect(ids(c1.items)).toEqual(["k00", "k01", "k02", "k03", "k04", "k05", "k06", "k07", "k11", "k10"]);
    expect(stateAfter(c1, 10)).toEqual({ kind: "keyset", shown: 10, dir: "new", boundaryMs: T, idsAtBoundary: ["k11", "k10"], windowOffset: 0 });
    const log: KeysetCall[] = [];
    const c2 = await collect(keysetSource(tied(), "new", {}, log), stateAfter(c1, 10), 10, all, ctxOf());
    expect(log[0]).toEqual({ window: { after: undefined, before: T + 1 }, offset: 0, first: true });
    expect(ids(c2.items)).toEqual(["k09", "k08", "k12", "k13", "k14", "k15", "k16", "k17", "k18", "k19"]);
  });
  it("Q26 for old the next window starts at the boundary (after is inclusive)", async () => {
    const c1 = await collect(keysetSource(tied(), "old"), undefined, 10, all, ctxOf());
    expect(ids(c1.items)).toEqual(["k29", "k28", "k27", "k26", "k25", "k24", "k23", "k22", "k21", "k20"]);
    const log: KeysetCall[] = [];
    const c2 = await collect(keysetSource(tied(), "old", {}, log), stateAfter(c1, 10), 10, all, ctxOf());
    expect(log[0].window).toEqual({ after: T0 - 20 * 60_000, before: undefined });
    expect(ids(c2.items)).toEqual(["k19", "k18", "k17", "k16", "k15", "k14", "k13", "k12", "k11", "k10"]);
  });
  it("steps by raw offset inside a window and re-anchors at the last row checked before passing offset 2000", async () => {
    const log: KeysetCall[] = [];
    const start: StreamState = { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 1990 };
    const c = await collect(keysetSource(rows(2100, () => false, "w"), "new", {}, log), start, 10, (r) => Number(r.id.slice(1)) % 5 === 0, ctxOf());
    expect(ids(c.items)).toEqual(["w1990", "w1995", "w2000", "w2005", "w2010", "w2015", "w2020", "w2025", "w2030", "w2035"]);
    expect(log.map((l) => [l.offset, l.window.before, l.first])).toEqual([[1990, undefined, true], [0, T0 - 2_009_000 + 1, true], [20, T0 - 2_009_000 + 1, false]]);
  });
  it("Q26 old: before passing offset 2000 the walk re-anchors at the last row checked, and the new window starts at its time (after, inclusive) less that row", async () => {
    const log: KeysetCall[] = [];
    // raw[i] is older with i; in old order the row at offset o is raw[2099 − o], so the page at 1990 holds w0109 … w0090
    const start: StreamState = { kind: "keyset", shown: 0, dir: "old", boundaryMs: null, idsAtBoundary: [], windowOffset: 1990 };
    const c = await collect(keysetSource(rows(2100, () => false, "w"), "old", {}, log), start, 10, (r) => Number(r.id.slice(1)) % 5 === 0, ctxOf());
    expect(ids(c.items)).toEqual(["w0105", "w0100", "w0095", "w0090", "w0085", "w0080", "w0075", "w0070", "w0065", "w0060"]);
    // the new window holds w0090 … w0000; its first raw page gives three more kept rows, its second the rest
    expect(log.map((l) => [l.offset, l.window.after, l.window.before, l.first])).toEqual([[1990, undefined, undefined, true], [0, T0 - 90_000, undefined, true], [20, T0 - 90_000, undefined, false]]);
  });
  it("Q6 a bounded stream's re-anchored window is judged by its own first page's total, not the old window's", async () => {
    const log: KeysetCall[] = [];
    // 2,030 rows: the window at 1990 reports 2,030, of which only every 10th row is kept; past 2000 the walk re-anchors at
    // w2009, whose window holds 21 rows (w2009 … w2029): full first page, total 21, so the second page ends the list.
    const start: StreamState = { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 1990 };
    const c = await collect(keysetSource(rows(2030, () => false, "b"), "new", { bounded: true }, log), start, 10, (r) => Number(r.id.slice(1)) % 10 === 0, ctxOf());
    expect(ids(c.items)).toEqual(["b1990", "b2000", "b2010", "b2020"]);
    expect([c.ended, c.endLine]).toEqual([true, undefined]);
    expect(log.map((l) => [l.offset, l.window.before, l.first])).toEqual([[1990, undefined, true], [0, T0 - 2_009_000 + 1, true], [20, T0 - 2_009_000 + 1, false]]);
  });
  it("Q26 ids shown at a window's boundary time stay skipped when the stream resumes at the window's next raw page", async () => {
    const T = T0 - 60_000;
    // 60 rows at one instant, in the forum's order x59, x58, …, x00; the first raw page (x59–x40) shows only x59 and x58.
    const same: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: "x" + String(i).padStart(2, "0"), t: T, hidden: i >= 40 && i <= 57 }));
    const start: StreamState = { kind: "keyset", shown: 1, dir: "new", boundaryMs: T, idsAtBoundary: ["x59"], windowOffset: 0 };
    const c1 = await collect(keysetSource(same, "new"), start, 10, all, ctxOf(1));
    expect([ids(c1.items), c1.stopped]).toEqual([["x58"], "request cap"]);
    expect(stateAfter(c1, 1)).toEqual({ kind: "keyset", shown: 2, dir: "new", boundaryMs: T, idsAtBoundary: ["x59", "x58"], windowOffset: 20 });
    const c2 = await collect(keysetSource(same, "new"), stateAfter(c1, 1), 10, all, ctxOf());
    expect(ids(c2.items)).toEqual(["x39", "x38", "x37", "x36", "x35", "x34", "x33", "x32", "x31", "x30"]);
    const c3 = await collect(keysetSource(same, "new"), stateAfter(c2, 10), 10, all, ctxOf());
    expect(ids(c3.items)).toEqual(["x29", "x28", "x27", "x26", "x25", "x24", "x23", "x22", "x21", "x20"]);
  });
  it("a window that must re-anchor with no row checked in it ends with the C-DEPTH line, not End of results", async () => {
    const start: StreamState = { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 1990 };
    const log: KeysetCall[] = [];
    const c = await collect(keysetSource(rows(2100, (i) => i >= 1990 && i < 2010, "h"), "new", {}, log), start, 10, all, ctxOf());
    expect([c.items.length, c.ended, c.endLine, log.length]).toEqual([0, true, END_DEPTH, 1]);
  });
  it("a bounded keyset list ends when a window's first raw page is not full", async () => {
    const raw = rows(15, () => false, "b");
    const c1 = await collect(keysetSource(raw, "new", { bounded: true }), undefined, 10, all, ctxOf());
    expect(c1.ended).toBe(false);
    const c2 = await collect(keysetSource(raw, "new", { bounded: true }), stateAfter(c1, 10), 10, all, ctxOf());
    expect(ids(c2.items)).toEqual(["b0010", "b0011", "b0012", "b0013", "b0014"]);
    expect(c2.ended).toBe(true);
  });
  it("the depth guard ends a site-wide date-order list after 500 items", async () => {
    const raw = rows(1000, () => false, "g");
    const start: StreamState = { kind: "keyset", shown: 495, dir: "new", boundaryMs: T0 - 494_000, idsAtBoundary: ["g0494"], windowOffset: 0 };
    const c = await collect(keysetSource(raw, "new", { depthGuard: true }), start, 10, all, ctxOf());
    expect(ids(c.items)).toEqual(["g0495", "g0496", "g0497", "g0498", "g0499"]);
    expect([c.ended, c.endLine]).toEqual([true, END_DEPTH_GUARD]);
    expect((await collect(keysetSource(raw, "new"), start, 10, all, ctxOf())).items).toHaveLength(10);
  });
});

describe("stateAfter", () => {
  it("is the state after the first `shown` items, the call's start for 0, and undefined at the end", async () => {
    const c = await collect(offsetSource(rows(15), true), undefined, 10, all, ctxOf());
    expect(stateAfter(c, 3)).toEqual({ kind: "offset", shown: 3, offset: 0, lastId: "r0002" });
    expect(stateAfter(c, 0)).toEqual({ kind: "offset", shown: 0, offset: 0 });
    expect(c.first).toEqual({ kind: "offset", shown: 0, offset: 0 });
    expect(stateAfter(await collect(offsetSource(rows(5), true), undefined, 10, all, ctxOf()), 5)).toBeUndefined();
  });
});
