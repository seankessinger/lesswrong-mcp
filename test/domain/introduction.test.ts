import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findIntroduction, toRevisionRecord, wordDiff, type IntroState } from "../../src/domain/revisions";
import { classify } from "../../src/text/phrases";
import type { RevisionDoc, RevisionRecord } from "../../src/types";
import { rawRevRow } from "../support/builders";

const DOC: RevisionDoc = { kind: "post", id: "uMQ3cqWDPHhjtiesc", hideAuthor: false, postedAt: "2019-05-31T00:00:00.000Z", af: true };
/** n visible rows of one document, oldest first, one day apart (ids `<key>000…<i>`). */
function history(key: string, n: number): RevisionRecord[] {
  return Array.from({ length: n }, (_, i) => toRevisionRecord(rawRevRow({
    _id: key + String(i).padStart(17 - key.length, "0"), documentId: "uMQ3cqWDPHhjtiesc", collectionName: "Posts",
    version: `1.${i}.0`, editedAt: new Date(Date.parse("2019-05-31T00:00:00.000Z") + i * 86_400_000).toISOString(), updateType: "minor",
  }), DOC));
}
/** A fetchTexts stub over fixed texts that records every call (one call = one forum request). */
function texts(entries: readonly (readonly [RevisionRecord, string])[]) {
  const byId = new Map(entries.map(([r, t]) => [r.id, t] as const));
  const calls: string[][] = [];
  const fetch = async (ids: readonly string[]) => { calls.push([...ids]); return new Map(ids.map((id) => [id, byId.get(id)!] as const)); };
  return { calls, fetch };
}
const MESA = classify("mesa optimizer", "phrases");
const INNER = classify("inner optimizer", "phrases");
/** Row i's text: "The <word> kernel is here." for each word whose phrase "<word> kernel" is present from row `at[p]` on. */
const kernels = (words: readonly string[], at: readonly number[], i: number) =>
  words.filter((_, p) => p < at.length && i >= at[p]).map((w) => `The ${w} kernel is here.`).join(" ") || "Nothing yet.";
const phraseAt = (rows: readonly RevisionRecord[], present: (i: number) => boolean) =>
  rows.map((r, i) => [r, present(i) ? "The mesa optimizer appears here." : "The inner optimizer appears here."] as const);

describe("wordDiff (¶4.11 step 7)", () => {
  it("Q98 a local word diff: changed paragraphs only, one paragraph of context, word counts", () => {
    const a = "Para one stays.\n\nThe inner optimizer is bad.\n\nMiddle stays.\n\nRemoved paragraph here.\n\nEnd stays.";
    const b = "Para one stays.\n\nThe mesa optimizer is bad.\n\nMiddle stays.\n\nEnd stays.\n\nA new closing paragraph.";
    expect(wordDiff(a, b)).toEqual({
      paragraphs: [
        { context: "Para one stays.", text: "The [-inner-] {+mesa+} optimizer is bad." },
        { context: "Middle stays.", text: "[-Removed paragraph here.-]" },
        { context: "End stays.", text: "{+A new closing paragraph.+}" },
      ],
      added: 5, removed: 4, changed: 3,
    });
  });

  it("identical texts have no changes; a change in the first paragraph has no context; a region pairs paragraphs in order", () => {
    expect(wordDiff("Same.\n\nText.", "Same.\n\nText.")).toEqual({ paragraphs: [], added: 0, removed: 0, changed: 0 });
    expect(wordDiff("Old start.\n\nSame.", "New start.\n\nSame.")).toEqual({ paragraphs: [{ text: "[-Old-] {+New+} start." }], added: 1, removed: 1, changed: 1 });
    expect(wordDiff("Keep.\n\nOne two.\n\nThree four.", "Keep.\n\nOne five.")).toEqual({
      paragraphs: [{ context: "Keep.", text: "One [-two.-] {+five.+}" }, { text: "[-Three four.-]" }], added: 1, removed: 3, changed: 2,
    });
  });

  it("a paragraph whose words are unchanged (only its whitespace differs) is not changed, and serves as context in its newer form", () => {
    expect(wordDiff("Keep.\n\nA  line\nwrapped here.\n\nOld end.", "Keep.\n\nA line wrapped here.\n\nNew end.")).toEqual({
      paragraphs: [{ context: "A line wrapped here.", text: "[-Old-] {+New+} end." }], added: 1, removed: 1, changed: 1,
    });
    expect(wordDiff("One  two.", "One two.")).toEqual({ paragraphs: [], added: 0, removed: 0, changed: 0 });
  });

  it("a paragraph pair needing more than 1,000 token edits (a rewritten table) is shown removed and added whole", () => {
    const para = (n: number, mark: string) => Array.from({ length: n }, (_, i) => `k${i} ${mark}${i}`).join(" ");
    expect(wordDiff(para(500, "x"), para(500, "y"))).toEqual({
      paragraphs: [{ text: Array.from({ length: 500 }, (_, i) => `k${i} [-x${i}-] {+y${i}+}`).join(" ") }], added: 500, removed: 500, changed: 1,
    });
    expect(wordDiff(para(501, "x"), para(501, "y"))).toEqual({
      paragraphs: [{ text: `[-${para(501, "x")}-] {+${para(501, "y")}+}` }], added: 1002, removed: 1002, changed: 1,
    });
  });

  it("a 130,000-token paragraph with one inserted token diffs without throwing (no spread over a long common run)", () => {
    const words = Array.from({ length: 130_000 }, (_, i) => `w${i}`);
    const a = words.join(" ");
    const b = [...words, "INSERTED"].join(" ");   // one common run of 130,000 tokens, then the insertion
    const d = wordDiff(a, b);
    expect([d.added, d.removed, d.changed]).toEqual([1, 0, 1]);
    expect(d.paragraphs[0]!.text.endsWith("w129999 {+INSERTED+}")).toBe(true);
  });

  it("a text whose paragraph diff needs more than 1,000 edits is diffed as one region, its paragraphs paired in order", () => {
    const n = 600;
    const olds = Array.from({ length: n }, (_, i) => `p${i} old`);
    const news = Array.from({ length: n }, (_, i) => `p${i} new`);
    // X moved from the start to the end: the minimal diff keeps it common (1,200 edits), which is over the bound.
    const d = wordDiff(["X", ...olds].join("\n\n"), [...news, "X"].join("\n\n"));
    expect(d.changed).toBe(n + 1);
    expect(d.paragraphs[0]).toEqual({ text: "[-X-] {+p0 new+}" });
    expect(d.paragraphs[1]).toEqual({ text: "[-p0 old-] {+p1 new+}" });   // the in-order pairing, not the minimal diff's
    expect(d.paragraphs.at(-1)).toEqual({ text: `[-p${n - 1} old-] {+X+}` });
  });
});

describe("findIntroduction (¶4.11 step 8, ¶4.12 step 8)", () => {
  it("121 visible rows resolve exactly in 2 rounds of at most 10 texts", async () => {
    const rows = history("hs", 121);
    const t = texts(phraseAt(rows, (i) => i >= 57));
    const res = await findIntroduction([{ key: "post1", rows, phrases: [MESA] }], t.fetch, { rounds: 2, probes: 10 });
    expect(res.found["post1|mesa optimizer"].id).toBe(rows[57].id);
    expect(res.between).toEqual({});
    expect(res.state).toEqual({ "post1|mesa optimizer": { lo: 56, hi: 57 } });
    expect(t.calls.map((c) => c.length)).toEqual([10, 9]);
    expect(t.calls[0]).toEqual([11, 22, 33, 44, 55, 65, 76, 87, 98, 109].map((i) => rows[i].id));
    for (let k = 1; k <= 120; k++) {
      const each = await findIntroduction([{ key: "p", rows, phrases: [MESA] }], texts(phraseAt(rows, (i) => i >= k)).fetch, { rounds: 2, probes: 10 });
      expect(each.found["p|mesa optimizer"].id).toBe(rows[k].id);
    }
  });

  it("two series (first_use's two candidates) share each round's request", async () => {
    const r1 = history("ha", 121), r2 = history("hb", 30);
    const t = texts([...phraseAt(r1, (i) => i >= 57), ...phraseAt(r2, (i) => i >= 12)]);
    const res = await findIntroduction([{ key: "a", rows: r1, phrases: [MESA] }, { key: "b", rows: r2, phrases: [MESA] }], t.fetch, { rounds: 2, probes: 10 });
    expect([res.found["a|mesa optimizer"].id, res.found["b|mesa optimizer"].id]).toEqual([r1[57].id, r2[12].id]);
    expect(t.calls.map((c) => c.length)).toEqual([20, 10]);
  });

  it("two phrases in one series introduced at different rows are both found: each open interval gets its own share of the round's probes, and each phrase reads only the probes inside its own", async () => {
    const rows = history("hd", 121);
    const text = (i: number) => `${i >= 50 ? "The inner optimizer appears here. " : ""}${i >= 60 ? "The mesa optimizer appears here." : "Nothing yet."}`;
    const t = texts(rows.map((r, i) => [r, text(i)] as const));
    const res = await findIntroduction([{ key: "p", rows, phrases: [MESA, INNER] }], t.fetch, { rounds: 3, probes: 10 });
    expect([res.found["p|mesa optimizer"].id, res.found["p|inner optimizer"].id]).toEqual([rows[60].id, rows[50].id]);
    expect(res.between).toEqual({});
    // round 1 probes the whole history and leaves [44, 55] and [55, 65]; round 2 shares its 10 probes 5 and 5 (spacings
    // 11/6 and 10/6), [44, 55] taking 46, 48, 50, 51, 53 and [55, 65] taking 57, 58, 60, 62, 63, which leaves [48, 50] and
    // [58, 60]; round 3 gives each the one row inside it, 49 and 59
    expect(t.calls).toEqual([
      [11, 22, 33, 44, 55, 65, 76, 87, 98, 109], [46, 48, 50, 51, 53, 57, 58, 60, 62, 63], [49, 59],
    ].map((round) => round.map((i) => rows[i].id)));
  });

  /** "inner optimizer" present from row 30, "mesa optimizer" from row 90. */
  const farApart = (i: number) => `${i >= 30 ? "The inner optimizer appears here. " : ""}${i >= 90 ? "The mesa optimizer appears here." : "Nothing yet."}`;

  it("two phrases introduced far apart in one series resolve exactly in 3 rounds: no probe falls in the gap between their intervals", async () => {
    const rows = history("hg", 121);
    const t = texts(rows.map((r, i) => [r, farApart(i)] as const));
    const res = await findIntroduction([{ key: "p", rows, phrases: [INNER, MESA] }], t.fetch, { rounds: 3, probes: 10 });
    expect([res.found["p|inner optimizer"].id, res.found["p|mesa optimizer"].id]).toEqual([rows[30].id, rows[90].id]);
    expect(res.between).toEqual({});
    expect(res.state).toEqual({ "p|inner optimizer": { lo: 29, hi: 30 }, "p|mesa optimizer": { lo: 89, hi: 90 } });
    expect(t.calls.map((c) => c.length)).toEqual([10, 10, 2]);
    // round 1 probes the whole history and leaves [22, 33] and [87, 98]; round 2 gives each 5 probes (spacing 11/6), none in
    // the gap 33–87, and leaves [29, 31] and [89, 91]; round 3 probes the one row inside each, 30 and 90
    expect(t.calls).toEqual([
      [11, 22, 33, 44, 55, 65, 76, 87, 98, 109], [24, 26, 28, 29, 31, 89, 91, 93, 94, 96], [30, 90],
    ].map((round) => round.map((i) => rows[i].id)));
  });

  it("a continuation from two far-apart intervals narrows both in its first round: every probe lies inside one of them", async () => {
    const rows = history("hh", 121);
    const t = texts(rows.map((r, i) => [r, farApart(i)] as const));
    const state = { "p|inner optimizer": { lo: 29, hi: 33 }, "p|mesa optimizer": { lo: 87, hi: 91 } };
    const res = await findIntroduction([{ key: "p", rows, phrases: [INNER, MESA] }], t.fetch, { rounds: 1, probes: 10, state });
    // each interval has 3 rows inside it, so each takes 3 probes (no more than its rows) and closes in this one round
    expect(t.calls).toEqual([[30, 31, 32, 88, 89, 90].map((i) => rows[i].id)]);
    expect(res.state).toEqual({ "p|inner optimizer": { lo: 29, hi: 30 }, "p|mesa optimizer": { lo: 89, hi: 90 } });
    expect(res.between).toEqual({});
  });

  it("more open intervals than probes: one probe each to the intervals with the most rows inside, ties to the lower row", async () => {
    const rows = history("hi", 121);
    const words = ["alpha", "bravo", "charlie"];
    const t = texts(rows.map((r, i) => [r, kernels(words, [12, 47, 77], i)] as const));
    const series = [{ key: "p", rows, phrases: words.map((w) => classify(`${w} kernel`, "phrases")) }];
    // three intervals of 9 rows inside each and 2 probes: the two lowest take one each, at their middles; the third waits
    const tie = await findIntroduction(series, t.fetch, { rounds: 1, probes: 2, state: {
      "p|alpha kernel": { lo: 10, hi: 20 }, "p|bravo kernel": { lo: 40, hi: 50 }, "p|charlie kernel": { lo: 70, hi: 80 },
    } });
    expect(tie.state).toEqual({ "p|alpha kernel": { lo: 10, hi: 15 }, "p|bravo kernel": { lo: 45, hi: 50 }, "p|charlie kernel": { lo: 70, hi: 80 } });
    // 3, 9 and 8 rows inside: the two widest take one each
    const widest = await findIntroduction(series, t.fetch, { rounds: 1, probes: 2, state: {
      "p|alpha kernel": { lo: 10, hi: 14 }, "p|bravo kernel": { lo: 40, hi: 50 }, "p|charlie kernel": { lo: 70, hi: 79 },
    } });
    expect(widest.state).toEqual({ "p|alpha kernel": { lo: 10, hi: 14 }, "p|bravo kernel": { lo: 45, hi: 50 }, "p|charlie kernel": { lo: 75, hi: 79 } });
    expect(t.calls).toEqual([[15, 45], [45, 75]].map((round) => round.map((i) => rows[i].id)));
  });

  // The property behind the placement, run one round at a time from the previous state as get_history and first_use run it.
  // Bound: with at most 5 phrases there are at most 5 distinct open intervals, and `probes` is drawn at least that large, so
  // every open interval gets k >= 1 probes of its own at lo + round(i * g / (k + 1)), g = hi - lo. Two neighbouring positions
  // (lo and hi included) are at most ceil(g / (k + 1)) <= ceil(g / 2) apart, and a monotone phrase's new interval is one of
  // those pieces (probes from other intervals inside it only cut it finer). So an interval of length g is at most ceil(g / 2)
  // long after a round; from n - 1 it is closed (length 1) after ceil(log2(n - 1)) <= ceil(log2 n) rounds, and the
  // ceil(log2 n) + 2 rounds allowed here leave a margin of 2.
  it("property: every round cuts every open interval to at most half its length (rounded up) with at most `probes` texts, and every phrase is found at its row within ceil(log2 n) + 2 rounds", async () => {
    const all = history("hp", 300);
    const words = ["alpha", "bravo", "charlie", "delta", "echo"] as const;
    const kinds = words.map((w) => classify(`${w} kernel`, "phrases"));
    const input = fc.integer({ min: 2, max: 300 })
      .chain((n) => fc.tuple(fc.constant(n), fc.array(fc.integer({ min: 1, max: n - 1 }), { minLength: 1, maxLength: 5 })))
      .chain(([n, intro]) => fc.record({ n: fc.constant(n), intro: fc.constant(intro), probes: fc.integer({ min: intro.length, max: 10 }) }));
    await fc.assert(fc.asyncProperty(input, async ({ n, intro, probes }) => {
      const rows = all.slice(0, n);
      const byId = new Map(rows.map((r, i) => [r.id, kernels(words, intro, i)] as const));
      const series = [{ key: "p", rows, phrases: kinds.slice(0, intro.length) }];
      const keyOf = (p: number) => `p|${words[p]} kernel`;
      let state: IntroState = Object.fromEntries(intro.map((_, p) => [keyOf(p), { lo: 0, hi: n - 1 }]));
      let res = await findIntroduction(series, texts([]).fetch, { rounds: 0, probes, state });   // no round: nothing is fetched
      for (let round = 0; round < Math.ceil(Math.log2(n)) + 2; round += 1) {
        const calls: string[][] = [];
        const fetch = async (ids: readonly string[]) => { calls.push([...ids]); return new Map(ids.map((id) => [id, byId.get(id)!] as const)); };
        res = await findIntroduction(series, fetch, { rounds: 1, probes, state });
        expect(calls.length).toBeLessThanOrEqual(1);
        expect((calls[0] ?? []).length).toBeLessThanOrEqual(probes);
        intro.forEach((at, p) => {
          const before = state[keyOf(p)], after = res.state[keyOf(p)];
          expect(after.lo < at && at <= after.hi).toBe(true);   // absent at lo, present at hi
          if (before.hi - before.lo <= 1) expect(after).toEqual(before);
          else {
            expect(after.lo >= before.lo && after.hi <= before.hi && after.hi - after.lo < before.hi - before.lo).toBe(true);
            expect(after.hi - after.lo).toBeLessThanOrEqual(Math.ceil((before.hi - before.lo) / 2));
          }
        });
        state = res.state;
      }
      expect(res.between).toEqual({});
      intro.forEach((at, p) => expect(res.found[keyOf(p)].id).toBe(rows[at].id));
    }), { numRuns: 300 });
  }, 10_000);

  it("an interval left after 2 rounds is reported between two versions and continued from the state", async () => {
    const rows = history("hc", 200);
    const first = await findIntroduction([{ key: "p", rows, phrases: [MESA] }], texts(phraseAt(rows, (i) => i >= 150)).fetch, { rounds: 2, probes: 10 });
    expect(first.found).toEqual({});
    expect(first.between["p|mesa optimizer"]).toEqual({ from: rows[148], to: rows[150] });
    expect(first.state).toEqual({ "p|mesa optimizer": { lo: 148, hi: 150 } });
    const t = texts(phraseAt(rows, (i) => i >= 150));
    const next = await findIntroduction([{ key: "p", rows, phrases: [MESA] }], t.fetch, { rounds: 2, probes: 10, state: first.state });
    expect(next.found["p|mesa optimizer"].id).toBe(rows[150].id);
    expect(t.calls).toEqual([[rows[149].id]]);
  });

  it("adjacent rows need no request", async () => {
    const rows = history("hd", 2);
    const t = texts(phraseAt(rows, (i) => i >= 1));
    const res = await findIntroduction([{ key: "p", rows, phrases: [MESA] }], t.fetch, { rounds: 2, probes: 10 });
    expect(res.found["p|mesa optimizer"].id).toBe(rows[1].id);
    expect(t.calls).toEqual([]);
  });

  it("a non-monotone history: the first transition among the probes, assuming the phrase was not removed and re-added", async () => {
    const rows = history("he", 21);
    const t = texts(phraseAt(rows, (i) => i === 3 || i >= 15));
    const res = await findIntroduction([{ key: "p", rows, phrases: [MESA] }], t.fetch, { rounds: 2, probes: 10 });
    expect(res.found["p|mesa optimizer"].id).toBe(rows[15].id);
    expect(t.calls).toEqual([[2, 4, 5, 7, 9, 11, 13, 15, 16, 18].map((i) => rows[i].id), [rows[14].id]]);
  });

  it("only the exact form counts as present: the other apostrophe form does not", async () => {
    const rows = history("hf", 3);
    const t = texts([[rows[0], "Nothing."], [rows[1], "The Newcomb problem is old."], [rows[2], "Newcomb's problem appears."]]);
    const res = await findIntroduction([{ key: "p", rows, phrases: [classify("Newcomb's problem", "phrases")] }], t.fetch, { rounds: 2, probes: 10 });
    expect(res.found["p|Newcomb's problem"].id).toBe(rows[2].id);
  });
});
