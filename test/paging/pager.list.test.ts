import { describe, expect, it } from "vitest";
import {
  compareLocal, feedEnded, fingerprint, lightScan, listPage, scanThenKeep, searchPageAllowed, sliceAfter, slicePosition, stateAfter,
} from "../../src/paging/pager";
import { tooBroad } from "../../src/errors";
import { ctxOf, ids, keysetSource, offsetSource, rows, scanFetch, scanRows, type KeysetCall } from "../support/pagerSources";
import type { StreamState } from "../../src/types";

type ListState = Extract<StreamState, { kind: "list" }>;
interface Item { id: string; t: number }
const idOf = (x: Item) => x.id;
const timeOf = (x: Item) => x.t;
const SET: Item[] = Array.from({ length: 25 }, (_, i) => ({ id: `L${String(i).padStart(2, "0")}`, t: 1_000_000 - i }));

describe("local sorts (¶3.3, Q13)", () => {
  type R = { id: string; t: number; k: number | null };
  const rs: R[] = [{ id: "a1", t: 100, k: 5 }, { id: "b2", t: 300, k: null }, { id: "c3", t: 200, k: 5 }, { id: "d4", t: 200, k: 5 }, { id: "e5", t: 50, k: 9 }];
  it("Q13 sorts by the key with nulls last; ties newer first, then _id descending", () => {
    expect([...rs].sort(compareLocal((r) => r.k, (r) => r.t, (r) => r.id)).map((r) => r.id)).toEqual(["e5", "d4", "c3", "a1", "b2"]);
    expect([...rs].sort(compareLocal((r) => r.k, (r) => r.t, (r) => r.id, "asc")).map((r) => r.id)).toEqual(["d4", "c3", "a1", "e5", "b2"]);
  });
  it("fingerprint counts the set and its newest date", () => {
    expect(fingerprint(rs, (r) => r.t)).toEqual({ count: 5, newestMs: 300 });
    expect(fingerprint([] as R[], (r) => r.t)).toEqual({ count: 0, newestMs: 0 });
  });
});

describe("list paging (¶3.6)", () => {
  it("pages a whole set by index and last id, with the fingerprint", () => {
    const p1 = listPage(SET, undefined, 10, idOf, timeOf);
    expect(p1.items.map(idOf)).toEqual(SET.slice(0, 10).map(idOf));
    expect([p1.ended, p1.driftNote]).toEqual([false, undefined]);
    expect(p1.after[9]).toEqual({ kind: "list", shown: 10, index: 10, lastId: "L09", fingerprint: { count: 25, newestMs: 1_000_000 } });
    const p2 = listPage(SET, p1.after[9] as ListState, 10, idOf, timeOf);
    const p3 = listPage(SET, p2.after[9] as ListState, 10, idOf, timeOf);
    expect(p3.items.map(idOf)).toEqual(["L20", "L21", "L22", "L23", "L24"]);
    expect(p3.ended).toBe(true);
  });
  it("a changed fingerprint adds the drift note and resumes after the last id shown", () => {
    const st = listPage(SET, undefined, 10, idOf, timeOf).after[9] as ListState;
    const p = listPage([{ id: "NEW", t: 2_000_000 }, ...SET], st, 10, idOf, timeOf);
    expect(p.driftNote).toBe("The list changed since the previous page (1 new item); positions may have shifted.");
    expect(p.items[0].id).toBe("L10");
  });
  it("a last item that is gone resumes at the stored index, with the note", () => {
    const st = listPage(SET, undefined, 10, idOf, timeOf).after[9] as ListState;
    const p = listPage(SET.filter((x) => x.id !== "L09"), st, 10, idOf, timeOf);
    expect(p.items[0].id).toBe("L11");
    expect(p.driftNote).toBe("The list changed since the previous page (0 new items); positions may have shifted.");
  });
  it("P10 a hidden row added between two pages changes neither the drift note nor its N", () => {
    const raw = SET.map((x) => ({ ...x, hidden: false }));
    const visible = (rs: typeof raw) => rs.filter((r) => !r.hidden);
    const st = listPage(visible(raw), undefined, 10, idOf, timeOf).after[9] as ListState;
    const p = listPage(visible([{ id: "HID", t: 3_000_000, hidden: true }, ...raw]), st, 10, idOf, timeOf);
    expect(p.driftNote).toBeUndefined();
    expect(p.items[0].id).toBe("L10");
  });
  it("a state with only an index (a hand-off) resumes there; without timeOf only a lost last item adds the note, with N = 0", () => {
    const handOff = listPage(SET, { kind: "list", shown: 10, index: 10 }, 5, idOf, timeOf);
    expect([handOff.items.map(idOf), handOff.driftNote, handOff.after[0]]).toEqual([
      ["L10", "L11", "L12", "L13", "L14"], undefined,
      { kind: "list", shown: 11, index: 11, lastId: "L10", fingerprint: { count: 25, newestMs: 1_000_000 } },
    ]);
    const st = listPage(SET, undefined, 10, idOf).after[9] as ListState;
    expect(st).toEqual({ kind: "list", shown: 10, index: 10, lastId: "L09" });
    expect(listPage([{ id: "NEW", t: 2_000_000 }, ...SET], st, 10, idOf).driftNote).toBeUndefined();
    expect(listPage(SET.filter((x) => x.id !== "L09"), st, 10, idOf).driftNote)
      .toBe("The list changed since the previous page (0 new items); positions may have shifted.");
  });
});

describe("light scans (¶3.6: one cap of 2,000 rows)", () => {
  const over = { why: "More than 2,000 posts match", how: "Narrow with date_from/date_to" };
  it("a first raw page that is not full is the whole set", async () => {
    const log: number[] = [];
    expect(await lightScan(scanFetch(1500, 2000, () => true, log), { overCap: over })).toEqual({ rows: scanRows(1500), truncated: false });
    expect(log).toEqual([0]);
  });
  it("a full raw page is too_broad with the tool's hint, even when few of its rows are shown", async () => {
    for (const visible of [() => true, (i: number) => i % 10 === 0]) {
      await expect(lightScan(scanFetch(2500, 2000, visible), { overCap: over })).rejects.toMatchObject({ category: "too_broad", message: tooBroad(over.why, over.how).message });
    }
  });
  it("the declared exceptions read further raw pages, then truncate: the sequences set (3 × 1,000) and a person's wiki edits (2 × 1,000)", async () => {
    const log: number[] = [];
    expect((await lightScan(scanFetch(764, 1000, () => true, log), { overCap: "truncate", maxPages: 3 })).truncated).toBe(false);
    expect(log).toEqual([0]);
    const log2: number[] = [];
    const r2 = await lightScan(scanFetch(2500, 1000, () => true, log2), { overCap: "truncate", maxPages: 3 });
    expect([r2.rows.length, r2.truncated, log2]).toEqual([2500, false, [0, 1000, 2000]]);
    expect((await lightScan(scanFetch(3500, 1000), { overCap: "truncate", maxPages: 3 })).truncated).toBe(true);
    expect((await lightScan(scanFetch(1500, 1000), { overCap: "truncate", maxPages: 2 })).truncated).toBe(false);
    const r5 = await lightScan(scanFetch(2400, 1000), { overCap: "truncate", maxPages: 2 });
    expect([r5.rows.length, r5.truncated]).toEqual([2000, true]);
  });
  it("a set of exactly two raw pages (total = 2 × rawCount) is read in two fetches, never a third empty one", async () => {
    const log: number[] = [];
    const r = await lightScan(scanFetch(2000, 1000, () => true, log), { overCap: "truncate", maxPages: 3 });
    expect([r.rows.length, r.truncated, log]).toEqual([2000, false, [0, 1000]]);
    const log2: number[] = [];
    expect((await lightScan(scanFetch(2001, 1000, () => true, log2), { overCap: "truncate", maxPages: 3 })).rows).toHaveLength(2001);
    expect(log2).toEqual([0, 1000, 2000]);
  });
  it("a selector sent without enableTotal is full when its rows fill the raw page, and reads on while pages stay full", async () => {
    const noTotal = (f: ReturnType<typeof scanFetch>) => async (offset: number, first: boolean) => ({ ...(await f(offset, first)), totalCount: undefined });
    expect((await lightScan(noTotal(scanFetch(1999, 2000)), { overCap: over })).rows).toHaveLength(1999);
    await expect(lightScan(noTotal(scanFetch(2000, 2000)), { overCap: over })).rejects.toMatchObject({ category: "too_broad" });
    const log: number[] = [];
    const r = await lightScan(noTotal(scanFetch(1500, 1000, () => true, log)), { overCap: "truncate", maxPages: 3 });
    expect([r.rows.length, r.truncated, log]).toEqual([1500, false, [0, 1000]]);
    expect((await lightScan(noTotal(scanFetch(2500, 1000)), { overCap: "truncate", maxPages: 2 })).truncated).toBe(true);
  });
});

describe("scan, then keep (¶3.6, ¶4.6, ¶4.15)", () => {
  it("af_only comment scans read raw pages of 500, at most 3 per call, and say what they kept", async () => {
    const raw = rows(2000, () => false, "s");
    const af = new Set(raw.filter((_, i) => i % 300 === 0).map((r) => r.id));
    const log: KeysetCall[] = [];
    const c = await scanThenKeep(keysetSource(raw, "new", {}, log), undefined, 10, (r) => af.has(r.id), ctxOf(), { filterName: "af_only", unit: "comments" });
    expect(ids(c.items)).toEqual(["s0000", "s0300", "s0600", "s0900", "s1200"]);
    expect(log.map((l) => l.offset)).toEqual([0, 500, 1000]);
    expect(c.note).toBe("af_only kept 5 of the 1,500 comments checked; continue with the cursor.");
    expect([c.stopped, c.ended]).toEqual([undefined, false]);
    expect(stateAfter(c, 5)).toEqual({ kind: "keyset", shown: 5, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset: 1500 });
  });
  it("frontpage with af_only reads raw pages of 100, at most 2 per call", async () => {
    const c = await scanThenKeep(offsetSource(rows(300, () => false, "f"), false), undefined, 10, (r) => Number(r.id.slice(1)) % 30 === 0, ctxOf(), { rows: 100, pages: 2, filterName: "af_only", unit: "posts" });
    expect(c.items).toHaveLength(7);
    expect(c.note).toBe("af_only kept 7 of the 200 posts checked; continue with the cursor.");
    expect(stateAfter(c, 7)).toEqual({ kind: "offset", shown: 7, offset: 200 });
  });
});

describe("search, feed and slice states (¶3.6)", () => {
  it("Q22 allows a search page only while page × hitsPerPage + hitsPerPage ≤ 10,000", () => {
    expect([searchPageAllowed(0, 10), searchPageAllowed(999, 10), searchPageAllowed(1000, 10), searchPageAllowed(499, 20), searchPageAllowed(500, 20)])
      .toEqual([true, true, false, true, false]);
  });
  it("Q19 a feed ends at a null cutoff (which is never sent again)", () => {
    expect(feedEnded(null)).toBe(true);
    expect(feedEnded("2026-10-21T12:00:00.000Z")).toBe(false);
  });
  it("a slice state continues at the next block and character offset, keeping the text's version", () => {
    expect(sliceAfter({ items: 2, blocks: {} }, undefined, 2)).toBeUndefined();
    const s1 = sliceAfter({ items: 1, sliceTo: 4956, blocks: {} }, undefined, 3, "1.2.0");
    expect(s1).toEqual({ kind: "slice", shown: 1, block: 1, offset: 4956, version: "1.2.0" });
    expect(sliceAfter({ items: 0, sliceTo: 9912, blocks: {} }, s1, 3, "1.2.0")).toEqual({ kind: "slice", shown: 1, block: 1, offset: 9912, version: "1.2.0" });
    // An empty slice (sliceTo = the start's own offset) stays where it started, never undefined or offset 0.
    expect(sliceAfter({ items: 0, sliceTo: 9912, blocks: {} }, { kind: "slice", shown: 1, block: 1, offset: 9912 }, 3)).toEqual({ kind: "slice", shown: 1, block: 1, offset: 9912 });
    expect(sliceAfter({ items: 0, sliceTo: 0, blocks: {} }, undefined, 3)).toEqual({ kind: "slice", shown: 0, block: 0, offset: 0 });
    // Nothing shown and no offset reached: the state stays at its start rather than restarting the item.
    expect(sliceAfter({ items: 0, blocks: {} }, { kind: "slice", shown: 1, block: 1, offset: 9912 }, 3)).toEqual({ kind: "slice", shown: 1, block: 1, offset: 9912 });
    expect(sliceAfter({ items: 1, blocks: {} }, { kind: "slice", shown: 1, block: 1, offset: 9912 }, 3)).toEqual({ kind: "slice", shown: 2, block: 2, offset: 0 });
    expect(sliceAfter({ items: 2, blocks: {} }, { kind: "slice", shown: 1, block: 1, offset: 9912 }, 3)).toBeUndefined();
  });

  describe("slicePosition: a slice page's items and its place in the whole text (¶3.7 `text 1–31 %`, `text from 31 %`)", () => {
    // 100 + 300 + 600 = 1,000 characters, so a character count reads as tenths of a percent.
    const ALL = [{ text: "a".repeat(100) }, { text: "b".repeat(300), fence: "wiki, v1.0.0" }, { text: "c".repeat(600) }];
    const at = (block: number, offset: number) => ({ kind: "slice", shown: block, block, offset }) as const;

    it("the first page shows every item from its start, from 1 % (never 0 %)", () => {
      const s = slicePosition(ALL, undefined);
      expect(s.items).toEqual(ALL);
      expect(s.position?.({ items: 1, sliceTo: 150, blocks: {} })).toBe("text 1–25 %");
      expect(s.next({ items: 1, sliceTo: 150, blocks: {} })).toBe("text from 25 %");
    });
    it("a continuation starts at its block, the first item resumed at its offset (fence kept), the rest whole", () => {
      const s = slicePosition(ALL, at(1, 150));
      expect(s.items).toEqual([{ text: "b".repeat(300), fence: "wiki, v1.0.0", from: 150 }, { text: "c".repeat(600) }]);
      expect(s.position?.({ items: 1, blocks: {} })).toBe("text 25–40 %");
      expect(s.position?.({ items: 1, sliceTo: 333, blocks: {} })).toBe("text 25–73 %");
      expect(s.next({ items: 1, sliceTo: 333, blocks: {} })).toBe("text from 73 %");
      // At block 1, offset 0: nothing to resume inside, so no `from`.
      expect(slicePosition(ALL, at(1, 0)).items).toEqual(ALL.slice(1));
    });
    it("the end reads 100 % once the last character is reached, and never falls below the page's start", () => {
      const s = slicePosition(ALL, at(1, 150));
      expect(s.position?.({ items: 2, blocks: {} })).toBe("text 25–100 %");
      // An empty slice, or a page that reached no offset, stays at the start.
      expect(s.position?.({ items: 0, sliceTo: 150, blocks: {} })).toBe("text 25–25 %");
      expect(s.position?.({ items: 0, blocks: {} })).toBe("text 25–25 %");
    });
    it("items without text have no position", () => {
      const s = slicePosition([], undefined);
      expect(s.items).toEqual([]);
      expect(s.position).toBeUndefined();
    });
  });
});
