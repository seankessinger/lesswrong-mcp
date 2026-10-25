import { describe, expect, it } from "vitest";
import { allListed, labelRevisions, originalOf, toRevisionRecord } from "../../src/domain/revisions";
import type { RawRevRow, RevisionDoc } from "../../src/types";
import { SAMPLE_PERSON, rawRevRow, rawTagRef, rawUserRef } from "../support/builders";

const EY = rawUserRef({ _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" });
const POSTED = "2022-06-05T22:05:52.224Z";
const AGI: RevisionDoc = { kind: "post", id: "uMQ3cqWDPHhjtiesc", hideAuthor: false, postedAt: POSTED, af: true };
const OLD: RevisionDoc = { kind: "post", id: "oldP0000000000001", hideAuthor: false, postedAt: "2010-03-13T10:00:00.000Z", af: false };
const TAG: RevisionDoc = { kind: "tag", id: "56yXXrcxRjrQs6z9R", hideAuthor: false };
/** A made-up anonymous post, and the fields that make a row its revision by its made-up author. */
const ANON_DOC: RevisionDoc = { kind: "post", id: "samplePost0000001", hideAuthor: true, postedAt: POSTED, af: true };
const OF_ANON: Partial<RawRevRow> = { documentId: ANON_DOC.id, userId: SAMPLE_PERSON._id, user: rawUserRef(SAMPLE_PERSON) };
const at = (ms: number) => new Date(Date.parse(POSTED) + ms).toISOString();
const CDN: Partial<RawRevRow> = { updateType: "patch", commitMessage: "Move images to CDN" };
let seq = 0;
/** A visible revision row of AGI Ruin's contents (§7.1 REV_ROW); every field the labels read is explicit. */
const row = (version: string, editedAt: string, o: Partial<RawRevRow> = {}): RawRevRow => rawRevRow({
  _id: `rev${String(++seq).padStart(14, "0")}`, documentId: "uMQ3cqWDPHhjtiesc", collectionName: "Posts",
  version, editedAt, updateType: "minor", commitMessage: "", changeMetrics: { added: 10, removed: 2 }, wordCount: 4410,
  userId: EY._id, user: EY, ...o,
});
const rec = (version: string, editedAt: string, o: Partial<RawRevRow> = {}, doc: RevisionDoc = AGI) => toRevisionRecord(row(version, editedAt, o), doc);
const SNAPSHOT_ID = "5c638b1f7a5d8b2e4c0f1a2b";

describe("toRevisionRecord (¶3.8.1, ¶4.11 step 4)", () => {
  it("the edit kind comes from updateType", () => {
    const kinds = (["initial", "major", "minor", "patch"] as const).map((u) => rec("1.0.0", at(500), { updateType: u }).kind);
    expect(kinds).toEqual(["first version", "published", "edit", "small automatic save"]);
  });

  it("the record keeps its id, version, dates, word count and the forum's change count", () => {
    const r = rec("1.12.0", "2024-02-27T10:15:03.000Z", { changeMetrics: { added: 412, removed: 37 } });
    expect(r).toMatchObject({
      version: "1.12.0",
      editedAt: "2024-02-27T10:15:03.000Z", editedMs: Date.parse("2024-02-27T10:15:03.000Z"), kind: "edit",
      change: { added: 412, removed: 37 }, wordCount: 4410, labels: [], cdnCopiesFolded: 0,
    });
    expect(r.id).toMatch(/^rev\d{14}$/);
    expect(r.editor).toMatchObject({ kind: "user", id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky" });
    expect(r.page).toBeUndefined();
  });

  it("Q50.38 Q97 a 24-hex row with updateType null dated before 2019-02-14 is the 2019 import snapshot", () => {
    expect(rec("1.0.0", "2010-03-13T10:00:00.000Z", { _id: SNAPSHOT_ID, updateType: null, commitMessage: null }, OLD))
      .toMatchObject({ kind: "2019 import snapshot", labels: ["2019 import snapshot"] });
    expect(rec("1.1.0", "2019-03-01T00:00:00.000Z", { _id: "5c78a3b27a5d8b2e4c0f1a2b", updateType: null }, OLD)).toMatchObject({ kind: null, labels: [] });
    expect(rec("1.0.0", "2010-03-13T10:00:00.000Z", { updateType: null }, OLD)).toMatchObject({ kind: null, labels: [] });
  });

  it("Q50.39 C-CHANGEMETRICS 0/0 is labelled, never read as no change; no metrics → no change field", () => {
    expect(rec("1.11.0", at(900_000_000), { changeMetrics: { added: 0, removed: 0 } }).labels)
      .toEqual(["forum change count +0/−0 chars (the text may still have changed)"]);
    expect(rec("1.11.0", at(900_000_000), { changeMetrics: null }).change).toBeUndefined();
  });

  it("an automatic CDN copy is labelled image copy to CDN", () => {
    expect(rec("1.2.1", at(900_000_000), CDN)).toMatchObject({ kind: "small automatic save", labels: ["image copy to CDN"] });
  });

  it("before publication: edited more than 5 s before postedAt", () => {
    expect(rec("1.3.0", at(-5_001)).labels).toEqual(["before publication"]);
    expect(rec("1.3.0", at(-5_000)).labels).toEqual([]);
  });

  it("P7 Q116 no editor on a hideAuthor document; a system revision has none; a deleted editor is account not publicly visible", () => {
    expect(rec("1.1.0", at(900_000_000), OF_ANON, ANON_DOC).editor).toBeUndefined();
    expect(rec("1.1.0", at(900_000_000), { userId: null, user: null }).editor).toBeUndefined();
    expect(rec("1.1.0", at(900_000_000), { user: null }).editor).toEqual({ kind: "none", why: "account not publicly visible" });
  });

  it("a revisionsByUser row carries the wiki page it edited (P12 (c) through wikiEditPage)", () => {
    const tagRow = row("1.6.0", "2025-01-01T00:00:00.000Z", {
      documentId: "56yXXrcxRjrQs6z9R", collectionName: "Tags",
      tag: rawTagRef({ _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai" }), lens: null, summary: null,
    });
    expect(toRevisionRecord(tagRow, TAG).page).toMatchObject({ part: "page", page: { id: "56yXXrcxRjrQs6z9R", slug: "interpretability-ml-and-ai" } });
  });
});

describe("labelRevisions (rows newest first)", () => {
  it("Q50.37 Q97 a repeated version string is labelled on both rows", () => {
    const out = labelRevisions([rec("1.10.0", "2024-05-01T00:00:00.000Z"), rec("1.10.0", "2024-02-01T00:00:00.000Z"), rec("1.9.0", "2024-01-01T00:00:00.000Z")], AGI);
    expect(out.map((r) => r.labels)).toEqual([["version number repeats"], ["version number repeats"], []]);
  });

  it("image copies to the CDN fold into the preceding edit's line; one with no older edit stays a row", () => {
    const rows = [
      rec("1.3.0", "2024-02-27T10:15:03.000Z"), rec("1.2.1", "2023-05-01T00:00:03.000Z", CDN), rec("1.2.0", "2023-05-01T00:00:00.000Z"),
      rec("1.1.2", "2022-07-01T00:00:08.000Z", CDN), rec("1.1.1", "2022-07-01T00:00:01.000Z", CDN), rec("1.1.0", "2022-07-01T00:00:00.000Z"),
      rec("1.0.0", "2022-06-05T22:05:52.791Z", { updateType: "initial" }),
    ];
    expect(labelRevisions(rows, AGI).map((r) => [r.version, r.cdnCopiesFolded])).toEqual([["1.3.0", 0], ["1.2.0", 1], ["1.1.0", 2], ["1.0.0", 0]]);
    expect(labelRevisions([rec("1.1.0", "2022-07-01T00:00:00.000Z"), rec("1.0.1", "2022-06-30T00:00:00.000Z", CDN)], AGI).map((r) => r.version)).toEqual(["1.1.0", "1.0.1"]);
  });

  it("repeats are counted over the rows shown, after folding", () => {
    const rows = [rec("1.2.0", "2023-01-02T00:00:00.000Z"), rec("1.1.1", "2023-01-01T00:00:02.000Z", CDN), rec("1.1.1", "2023-01-01T00:00:01.000Z", CDN), rec("1.1.0", "2023-01-01T00:00:00.000Z")];
    expect(labelRevisions(rows, AGI).map((r) => [r.version, r.labels, r.cdnCopiesFolded])).toEqual([["1.2.0", [], 0], ["1.1.0", [], 2]]);
  });

  it("a page ending in a CDN copy is labelled, then extended with the older rows: the copy folds into the edit it copies and the repeats recompute", () => {
    const page = labelRevisions([rec("1.2.0", at(900_000)), rec("1.1.1", at(600_000), CDN)], AGI);
    expect(page.map((r) => [r.version, r.labels, r.cdnCopiesFolded])).toEqual([["1.2.0", [], 0], ["1.1.1", ["image copy to CDN"], 0]]);
    const all = labelRevisions([...page, rec("1.1.0", at(500_000)), rec("1.1.0", at(100_000))], AGI);
    expect(all.map((r) => [r.version, r.labels, r.cdnCopiesFolded])).toEqual([
      ["1.2.0", [], 0], ["1.1.0", ["version number repeats"], 1], ["1.1.0", ["version number repeats"], 0],
    ]);
  });

  it("P7 every row stays editor-free on a hideAuthor document", () => {
    expect(labelRevisions([rec("1.1.0", at(900_000_000), OF_ANON), rec("1.0.0", at(500), OF_ANON)], ANON_DOC).map((r) => r.editor)).toEqual([undefined, undefined]);
  });

  it("labelling its own output again changes nothing, and the input rows are never mutated", () => {
    const rows = [
      rec("1.2.0", "2023-05-01T00:00:00.000Z"), rec("1.1.0", "2023-01-02T00:00:00.000Z"), rec("1.1.0", "2023-01-01T00:00:03.000Z", CDN),
      rec("1.1.0", "2023-01-01T00:00:00.000Z"),
    ];
    const before = structuredClone(rows);
    const once = labelRevisions(rows, AGI);
    expect(once.map((r) => [r.version, r.labels, r.cdnCopiesFolded]))
      .toEqual([["1.2.0", [], 0], ["1.1.0", ["version number repeats"], 0], ["1.1.0", ["version number repeats"], 1]]);
    expect(labelRevisions(once, AGI)).toEqual(once);
    expect(rows).toEqual(before);
  });
});

describe("originalOf (¶4.11 step 5, §7.3)", () => {
  it("Q97 the original is the newest visible row edited at most 5 s after postedAt", () => {
    const rows = [rec("1.12.0", "2024-02-27T10:15:03.000Z"), rec("1.1.0", "2022-06-06T09:00:00.000Z"), rec("1.0.0", "2022-06-05T22:05:52.791Z", { updateType: "initial" })];
    expect(originalOf(rows, AGI, false)).toEqual({ status: "found", row: rows[2], snapshot: false });
  });

  it("+5 s is inclusive", () => {
    const edge = rec("1.0.0", at(5_000));
    expect(originalOf([edge], AGI, false)).toEqual({ status: "found", row: edge, snapshot: false });
    const late = rec("1.0.0", at(5_001));
    expect(originalOf([late], AGI, true)).toEqual({ status: "not available", earliest: late });
  });

  it("pre-publication saves (§7.2): the newest row at or before publication wins", () => {
    const rows = [rec("1.3.0", at(3_600_000)), rec("1.2.0", at(-60_000)), rec("1.1.0", at(-3_600_000))];
    expect(originalOf(rows, AGI, true)).toMatchObject({ status: "found", row: rows[1] });
  });

  it("C-PRE2019 a pre-2019 post's original is its February-2019 snapshot", () => {
    const snap = rec("1.0.0", "2010-03-13T10:00:00.000Z", { _id: SNAPSHOT_ID, updateType: null, commitMessage: null, documentId: "oldP0000000000001" }, OLD);
    expect(originalOf([snap], OLD, true)).toEqual({ status: "found", row: snap, snapshot: true });
  });

  it("not determined yet until a qualifying row or the whole list; not available when complete and none qualifies", () => {
    expect(originalOf([rec("1.4.0", at(900_000_000)), rec("1.3.0", at(800_000_000))], AGI, false)).toEqual({ status: "not yet" });
    const xts: RevisionDoc = { kind: "post", id: "Xts5wm3akbemk4pDa", hideAuthor: false, postedAt: "2020-11-21T00:00:00.000Z", af: false };
    const only = rec("1.0.0", "2021-11-11T00:00:00.000Z", { documentId: "Xts5wm3akbemk4pDa" }, xts);
    expect(originalOf([only], xts, true)).toEqual({ status: "not available", earliest: only });
  });

  it("¶4.11 step 4 a CDN copy is the original only once the list is complete: the edit it copies may still arrive", () => {
    const page = labelRevisions([rec("1.1.0", at(800_000_000)), rec("1.0.1", at(2_000), CDN)], AGI);
    expect(originalOf(page, AGI, false)).toEqual({ status: "not yet" });
    expect(originalOf(page, AGI, true)).toEqual({ status: "found", row: page[1], snapshot: false });
    const all = labelRevisions([...page, rec("1.0.0", at(300), { updateType: "initial" })], AGI);
    expect(originalOf(all, AGI, false)).toEqual({ status: "found", row: all[1], snapshot: false });
    expect(all[1]).toMatchObject({ version: "1.0.0", cdnCopiesFolded: 1 });
    const unfolded = [rec("1.1.0", at(800_000_000)), rec("1.0.1", at(2_000), CDN), rec("1.0.0", at(300), { updateType: "initial" })];
    expect(originalOf(unfolded, AGI, false)).toEqual({ status: "found", row: unfolded[2], snapshot: false });
  });

  it("tags, lenses and summaries: the original is the oldest public version", () => {
    const rows = ["1.6.0", "1.5.0", "1.1.0"].map((v, i) =>
      rec(v, `2025-0${3 - i}-01T00:00:00.000Z`, { documentId: "56yXXrcxRjrQs6z9R", collectionName: "Tags" }, TAG));
    expect(originalOf(rows, TAG, true)).toEqual({ status: "found", row: rows[2], snapshot: false });
    expect(originalOf(rows, TAG, false)).toEqual({ status: "not yet" });
    expect(originalOf([], TAG, true)).toEqual({ status: "not available" });
  });
});

describe("allListed (¶3.6 fullness test)", () => {
  it("Q50.40 totalCount is used only to tell whether the raw page was full", () => {
    expect(allListed({ rows: 12, limit: 1000, totalCount: 12 })).toBe(true);
    expect(allListed({ rows: 0, limit: 1000, totalCount: 0 })).toBe(true);
    expect(allListed({ rows: 990, limit: 1000, totalCount: 1050 })).toBe(false);
    expect(allListed({ rows: 0, limit: 2, totalCount: 59 })).toBe(false);
    expect(allListed({ rows: 1000, limit: 1000, totalCount: 1000 })).toBe(false);
    expect(allListed({ rows: 40, limit: 1000, totalCount: null })).toBe(true);
    expect(allListed({ rows: 1000, limit: 1000, totalCount: null })).toBe(false);
  });
});
