import { describe, expect, it } from "vitest";
import { buildForest } from "../../src/domain/comments";
import {
  NO_SIGNALS_LINE, NO_VOTE_DATA_LINE, labelsOf, markedComments, mostActive, noDataLines, rankThreads, replyMap,
  selectBodies, signalComments, threadOf, type CommentSort, type ReplyMapEntry,
} from "../../src/domain/threads";
import { oneLine } from "../../src/text/sanitize";
import type { Forest, RawCommentTree } from "../../src/types";
import { AGI_FOREST, OLD_DISCUSSION, agiRuinForest, commentRow, oldDiscussionForest, replyRow, rowId, rowUser } from "../support/builders";

const A = AGI_FOREST.ids;
const O = OLD_DISCUSSION.ids;
const PAUL = AGI_FOREST.paul._id;
const build = (comments: RawCommentTree[], answers: RawCommentTree[] = []) => buildForest({ comments, answers, postAf: true, hideCommentKarma: false });
const agi = () => buildForest({ ...agiRuinForest(), postAf: true, hideCommentKarma: false });
const old = (rows: RawCommentTree[] = oldDiscussionForest().comments) => buildForest({ comments: rows, answers: [], postAf: false, hideCommentKarma: false });
const order = (f: Forest, sort: CommentSort, opts?: { userId?: string; afOnly?: boolean }) =>
  rankThreads(f, sort, opts).map((r) => `${r.label}:${r.thread.rootId}`);
const L = (label: string, stem: string) => `${label}:${rowId(stem)}`;
const react = (n: number) => ({ userId: rowUser(n)._id, displayName: `User ${n}`, karma: 1, reactType: "created" });
/** ¶3.3 sort fixture: roots a–f; e is an answer; d and f hide their karma; c carries one disagree react. */
function small(): Forest {
  return build([
    commentRow("a", 1, "2024-01-01T00:00:00.000Z", { baseScore: 10, voteCount: 5, af: true, afBaseScore: 9 }),
    replyRow("a1", 2, "2024-01-05T00:00:00.000Z", "a", "a", { baseScore: 2, voteCount: 1 }),
    commentRow("b", 3, "2024-01-02T00:00:00.000Z", { baseScore: 50, voteCount: 25, afBaseScore: 40 }),
    commentRow("c", 4, "2024-01-03T00:00:00.000Z", { baseScore: 10, voteCount: 5, af: true, afBaseScore: 20, extendedScore: { reacts: { disagree: [react(5)] }, agreement: 0, agreementVoteCount: 0 } }),
    replyRow("c1", 5, "2024-01-03T01:00:00.000Z", "c", "c", { baseScore: 3, voteCount: 2 }),
    replyRow("c2", 1, "2024-01-03T02:00:00.000Z", "c", "c", { baseScore: 3, voteCount: 2 }),
    commentRow("d", 6, "2024-01-04T00:00:00.000Z", { hideKarma: true, baseScore: null, voteCount: 3, afBaseScore: null }),
    commentRow("f", 8, "2024-01-07T00:00:00.000Z", { hideKarma: true, baseScore: null, voteCount: 2, afBaseScore: null }),
  ], [commentRow("e", 7, "2024-01-06T00:00:00.000Z", { answer: true, baseScore: 1, voteCount: 1 })]);
}

describe("rankThreads (¶3.3, ¶4.4 steps 6–8)", () => {
  it("P18 every sort; answers first; hidden-karma roots last by date under top, af_top and contested", () => {
    const f = small();
    expect(order(f, "top")).toEqual([L("A1", "e"), L("T1", "b"), L("T2", "c"), L("T3", "a"), L("T4", "f"), L("T5", "d")]);
    expect(order(f, "af_top")).toEqual([L("A1", "e"), L("T1", "c"), L("T2", "a"), L("T3", "b"), L("T4", "f"), L("T5", "d")]);
    expect(order(f, "new")).toEqual([L("A1", "e"), L("T1", "f"), L("T2", "d"), L("T3", "c"), L("T4", "b"), L("T5", "a")]);
    expect(order(f, "old")).toEqual([L("A1", "e"), L("T1", "a"), L("T2", "b"), L("T3", "c"), L("T4", "d"), L("T5", "f")]);
    expect(order(f, "largest")).toEqual([L("A1", "e"), L("T1", "c"), L("T2", "a"), L("T3", "f"), L("T4", "d"), L("T5", "b")]);
    expect(order(f, "contested")).toEqual([L("A1", "e"), L("T1", "c"), L("T2", "a"), L("T3", "b"), L("T4", "f"), L("T5", "d")]);
    expect(order(f, "active")).toEqual([L("A1", "e"), L("T1", "f"), L("T2", "a"), L("T3", "d"), L("T4", "c"), L("T5", "b")]);
    expect(rankThreads(f, "top").map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("local ties: largest breaks ties newer first; contested by largest, then top (the old discussion)", () => {
    const f = old();
    expect(order(f, "largest")).toEqual([`T1:${O.c1}`, `T2:${O.c8}`, `T3:${O.c5}`, `T4:${O.c11}`]);
    expect(order(f, "contested")).toEqual([`T1:${O.c1}`, `T2:${O.c5}`, `T3:${O.c8}`, `T4:${O.c11}`]);
    expect(order(f, "top")).toEqual([`T1:${O.c1}`, `T2:${O.c5}`, `T3:${O.c8}`, `T4:${O.c11}`]);
    expect(order(f, "new")).toEqual([`T1:${O.c11}`, `T2:${O.c8}`, `T3:${O.c5}`, `T4:${O.c1}`]);
    expect(order(f, "active")).toEqual([`T1:${O.c11}`, `T2:${O.c8}`, `T3:${O.c5}`, `T4:${O.c1}`]);
  });

  it("Q14 top ranks by root karma from the fetched tree: the promoted karma-8 comment does not jump ahead", () => {
    const top = rankThreads(agi(), "top");
    expect(top).toHaveLength(158);
    expect(top[0].thread.rootId).toBe(A.p0);
    expect(top[152].thread.rootId).toBe(A.promoted);
    expect(top.slice(0, 152).every((r) => r.thread.rootKarma !== null && r.thread.rootKarma >= 8)).toBe(true);
    expect(top[157].thread.rootId).toBe(A.hiddenRoot);
  });

  it("P19 user keeps the threads with an attributable comment by that person, not a placeholder or anonymous one", () => {
    expect(order(agi(), "top", { userId: PAUL })).toEqual([`T1:${A.p0}`, `T2:${A.paulFillerRoot}`]);
    expect(order(small(), "top", { userId: rowUser(1)._id })).toEqual([L("T1", "c"), L("T2", "a")]);
    // Made-up user 1 has a comment of their own in g, only their own placeholder in h and only their own anonymous comment in i.
    const own = build([
      commentRow("g", 2, "2024-02-01T00:00:00.000Z", { baseScore: 30 }), replyRow("g1", 1, "2024-02-02T00:00:00.000Z", "g", "g"),
      commentRow("h", 2, "2024-02-03T00:00:00.000Z", { baseScore: 20 }),
      replyRow("h1", 1, "2024-02-04T00:00:00.000Z", "h", "h", { deleted: true, deletedPublic: true, deletedReason: "Comment deleted by its author", contents: null }),
      commentRow("i", 2, "2024-02-05T00:00:00.000Z", { baseScore: 10 }), replyRow("i1", 1, "2024-02-06T00:00:00.000Z", "i", "i", { hideAuthor: true }),
    ]);
    expect(order(own, "top", { userId: rowUser(1)._id })).toEqual([L("T1", "g")]);
  });

  it("D2 af_only keeps threads containing any AF comment, whole, in the same order", () => {
    const f = build([
      commentRow("x", 1, "2024-01-01T00:00:00.000Z", { baseScore: 9 }),
      replyRow("xa", 2, "2024-01-02T00:00:00.000Z", "x", "x", { af: true }),
      commentRow("y", 3, "2024-01-03T00:00:00.000Z", { baseScore: 50 }),
    ]);
    expect(rankThreads(f, "top", { afOnly: true }).map((r) => [r.label, r.thread.rootId, r.thread.size])).toEqual([["T1", rowId("x"), 2]]);
    expect(order(small(), "top", { afOnly: true })).toEqual([L("T1", "c"), L("T2", "a")]);
  });
});

describe("labels (¶3.8.1)", () => {
  it("T<n> and A<n> with dotted paths; siblings in time order", () => {
    const labels = labelsOf(rankThreads(agi(), "contested"));
    expect(labels.size).toBe(731);
    expect([A.p0, A.e1, A.p2, A.e3, A.p4, A.e5, A.g1, A.g3, A.d2, A.d1, A.b1, A.b2, A.y1, A.x1, A.c1, A.c2, A.f1, A.g2].map((id) => labels.get(id))).toEqual([
      "T1", "T1.1", "T1.1.1", "T1.1.1.1", "T1.1.1.1.1", "T1.1.1.1.1.1", "T1.1.1.1.1.1.1", "T1.1.1.1.1.1.1.1", "T1.1.1.2", "T1.1.2",
      "T1.2", "T1.2.1", "T1.2.2", "T1.3", "T1.4", "T1.4.1", "T1.4.2", "T1.5",
    ]);
    const s = labelsOf(rankThreads(small(), "top"));
    expect([s.get(rowId("e")), s.get(rowId("c2"))]).toEqual(["A1", "T2.2"]);
  });
});

describe("signals (¶3.8.6, ¶4.4 step 13)", () => {
  it("signal lines: contested ≥ 1, by contested then agreement votes; a disagreement quote cut to 100 characters", () => {
    const f = agi();
    const lines = signalComments(f, labelsOf(rankThreads(f, "contested")));
    expect(lines.map((l) => [l.label, l.node.c.id, l.signals.contested, l.signals.labels])).toEqual([
      ["T1", A.p0, 2, ["disagree 2"]],
      ["T1.2", A.b1, 2, ["agreement disputed", "agreement split"]],
      ["T1.2.1", A.b2, 1, ["karma split"]],
    ]);
    expect(lines[0].quote).toBe(oneLine(AGI_FOREST.quote, 100));
    expect(lines[0].quote!.length).toBeLessThanOrEqual(100);
    expect(lines[1].quote).toBeUndefined();
  });

  it("signals come only from the threads left after filters", () => {
    const f = agi();
    expect(signalComments(f, labelsOf(rankThreads(f, "top", { userId: "agiU0000000000007" })))).toEqual([]);
  });

  it("crux and mind-change marks (net > 0)", () => {
    const f = agi();
    expect(markedComments(f, "crux").map((n) => n.c.id)).toEqual([A.p0]);
    expect(markedComments(f, "mindChange").map((n) => n.c.id)).toEqual([A.c1]);
  });

  it("at most 10 signal lines and 10 crux marks, newest first among equals", () => {
    const many = build(Array.from({ length: 12 }, (_, i) =>
      commentRow(`s${i}`, 1, `2024-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, { extendedScore: { reacts: { disagree: [react(9)], crux: [react(8)] } } })));
    const lines = signalComments(many, labelsOf(rankThreads(many, "top")));
    expect(lines).toHaveLength(10);
    expect(lines[0].node.c.id).toBe(rowId("s11"));
    const crux = markedComments(many, "crux");
    expect(crux).toHaveLength(10);
    expect(crux[0].c.id).toBe(rowId("s11"));
  });

  it("¶3.8.6 the no-data lines, exact text, only when nothing carries reactions or agreement votes", () => {
    expect(NO_VOTE_DATA_LINE).toBe("No reactions or agreement votes are recorded on this discussion (older discussions predate them); contested uses split karma votes and back-and-forth replies only.");
    expect(NO_SIGNALS_LINE).toBe("No disagreement signals were found, so threads are ranked by size, then karma. That does not show that nobody disagreed: read the threads.");
    const f = agi();
    expect(noDataLines(f, rankThreads(f, "contested"))).toEqual([]);
    const o = old();
    expect(noDataLines(o, rankThreads(o, "contested"))).toEqual([NO_VOTE_DATA_LINE, NO_SIGNALS_LINE]);
    const split = old(oldDiscussionForest().comments.map((r) => (r._id === O.c2 ? { ...r, baseScore: 1, voteCount: 6 } : r)));
    expect(noDataLines(split, rankThreads(split, "contested"))).toEqual([NO_VOTE_DATA_LINE]);
    // P18: under the post's hideCommentKarma every score is nulled, so no vote data is a choice, not the discussion's age.
    const hidden = buildForest({ comments: oldDiscussionForest().comments, answers: [], postAf: false, hideCommentKarma: true });
    expect(hidden.hasVoteData).toBe(false);
    expect(noDataLines(hidden, rankThreads(hidden, "contested"))).toEqual([]);
  });
});

describe("reply map (¶4.4 step 8) and most active commenters", () => {
  const flat = (entries: readonly ReplyMapEntry[]) => entries.map((e) => ({
    id: e.node.c.id, label: e.label,
    replies: e.replies.map((r) => ({ id: r.node.c.id, label: r.label, back: r.repliedBack, more: r.more })),
  }));

  it("P19 direct replies with ids; replied back = the person's attributable comments in that reply's subtree", () => {
    const f = agi();
    const labels = labelsOf(rankThreads(f, "top", { userId: PAUL }));
    expect(flat(replyMap(f, labels, PAUL))).toEqual([
      { id: A.p0, label: "T1", replies: [
        { id: A.e1, label: "T1.1", back: [A.p2, A.p4], more: 0 },
        { id: A.b1, label: "T1.2", back: [], more: 0 },
        { id: A.x1, label: "T1.3", back: [], more: 0 },
        { id: A.c1, label: "T1.4", back: [A.c2], more: 0 },
        { id: A.g2, label: "T1.5", back: [], more: 0 },
      ] },
      { id: A.p2, label: "T1.1.1", replies: [
        { id: A.e3, label: "T1.1.1.1", back: [A.p4], more: 0 },
        { id: A.d2, label: "T1.1.1.2", back: [], more: 0 },
      ] },
      { id: A.p4, label: "T1.1.1.1.1", replies: [{ id: A.e5, label: "T1.1.1.1.1.1", back: [], more: 0 }] },
      { id: A.c2, label: "T1.4.1", replies: [] },
      { id: A.paulFillerRoot, label: "T2", replies: [
        { id: "agiF0000000000101", label: "T2.1", back: [], more: 0 },
        { id: "agiF0000000000102", label: "T2.2", back: [], more: 0 },
      ] },
    ]);
    expect(replyMap(f, labels, PAUL, A.p0).map((e) => e.node.c.id)).toEqual([A.p0, A.p2, A.p4, A.c2]);
  });

  it("Q52 with rootId the map keeps the comments of that thread: a root-less orphan's thread, not the comments' own rootId", () => {
    const f = build([
      commentRow("o", 1, "2024-06-01T00:00:00.000Z", { parentCommentId: rowId("gp"), topLevelCommentId: rowId("g") }),
      replyRow("o1", 2, "2024-06-01T01:00:00.000Z", "o", "g"),
      replyRow("o2", 1, "2024-06-01T02:00:00.000Z", "o1", "g"),
    ]);
    const labels = labelsOf(rankThreads(f, "top"));
    expect(threadOf(f, rowId("o2"))!.rootId).toBe(rowId("o"));
    expect(flat(replyMap(f, labels, rowUser(1)._id, rowId("o")))).toEqual([
      { id: rowId("o"), label: "T1", replies: [{ id: rowId("o1"), label: "T1.1", back: [rowId("o2")], more: 0 }] },
      { id: rowId("o2"), label: "T1.1.1", replies: [] },
    ]);
    expect(replyMap(f, labels, rowUser(1)._id, rowId("g"))).toEqual([]);
  });

  it("replied back lists at most 5 ids, then +N", () => {
    const f = build([
      commentRow("m", 1, "2024-03-01T00:00:00.000Z"),
      replyRow("r", 2, "2024-03-01T01:00:00.000Z", "m", "m"),
      ...Array.from({ length: 7 }, (_, i) => replyRow(`s${i}`, 1, `2024-03-01T0${i + 2}:00:00.000Z`, i === 0 ? "r" : `s${i - 1}`, "m")),
    ]);
    const [first] = replyMap(f, labelsOf(rankThreads(f, "top")), rowUser(1)._id);
    expect(first.replies.map((r) => [r.repliedBack, r.more])).toEqual([[[rowId("s0"), rowId("s1"), rowId("s2"), rowId("s3"), rowId("s4")], 2]]);
  });

  it("P19 most active commenters count attributable comments only", () => {
    const at = (h: number) => `2024-04-01T${String(h).padStart(2, "0")}:00:00.000Z`;
    const f = build([
      commentRow("a", 1, at(0)), replyRow("b", 1, at(1), "a", "a"), replyRow("c", 1, at(2), "a", "a"),
      replyRow("d", 1, at(3), "a", "a", { hideAuthor: true }), replyRow("e", 2, at(4), "a", "a"), replyRow("f", 2, at(5), "a", "a"),
      replyRow("g", 2, at(6), "a", "a", { deleted: true, deletedPublic: true, contents: null }),
      replyRow("h", 4, at(7), "a", "a"), replyRow("i", 3, at(8), "a", "a"),
    ]);
    expect(mostActive(f, 3).map((m) => [m.person.id, m.count])).toEqual([[rowUser(1)._id, 3], [rowUser(2)._id, 2], [rowUser(3)._id, 1]]);
  });
});

describe("body selection (¶4.4 step 12)", () => {
  const pair = (w1: number, w2: number) => build([
    commentRow("w1", 1, "2024-05-01T00:00:00.000Z", { contents: { wordCount: w1 } }),
    commentRow("w2", 2, "2024-05-02T00:00:00.000Z", { contents: { wordCount: w2 } }),
  ]);

  it("all bodies when the forest's estimate (wordCount × 7 bytes) is at most 409,600 bytes, or with match", () => {
    expect(selectBodies(pair(29_257, 29_257), { match: false, pageIds: [rowId("w1")] })).toEqual({ all: true, ids: [rowId("w1"), rowId("w2")] });
    expect(selectBodies(pair(29_258, 29_257), { match: false, pageIds: [rowId("w2")] })).toEqual({ all: false, ids: [rowId("w2")] });
    expect(selectBodies(pair(29_258, 29_257), { match: true, pageIds: [] }).all).toBe(true);
    expect(selectBodies(old(), { match: false, pageIds: [] })).toEqual({ all: true, ids: Object.values(O) });
  });

  it("the AGI forest (≈ 0.8 MB estimated) fetches only the page's bodies; placeholders and cached bodies are never requested", () => {
    const f = agi();
    expect(selectBodies(f, { match: false, pageIds: [A.p0, A.x1, A.e1] })).toEqual({ all: false, ids: [A.p0, A.e1] });
    f.byId.get(A.e1)!.c.body = "cached";
    expect(selectBodies(f, { match: false, pageIds: [A.p0, A.x1, A.e1] }).ids).toEqual([A.p0]);
    expect(selectBodies(f, { match: true, pageIds: [] }).ids).toHaveLength(713);
  });
});

describe("threadOf and tree-only metrics", () => {
  it("threadOf finds the thread that holds a comment, orphans included", () => {
    const f = agi();
    expect(threadOf(f, A.g3)!.rootId).toBe(A.p0);
    expect(threadOf(f, A.orphan)!.rootId).toBe(A.orphanRoot);
    expect(threadOf(f, rowId("nope"))).toBeUndefined();
  });

  it("Q50.18 descendentCount, lastSubthreadActivity and directChildrenCount are never read", () => {
    const stale = { descendentCount: 99, directChildrenCount: 42, lastSubthreadActivity: "2030-01-01T00:00:00.000Z" };
    const f = build([
      Object.assign(commentRow("q", 1, "2024-01-01T00:00:00.000Z"), stale),
      Object.assign(replyRow("q1", 2, "2024-01-02T00:00:00.000Z", "q", "q"), stale),
      commentRow("z", 3, "2024-01-03T00:00:00.000Z"),
    ]);
    expect(threadOf(f, rowId("q"))).toMatchObject({ size: 2, newestMs: Date.parse("2024-01-02T00:00:00.000Z") });
    expect(order(f, "active")).toEqual([L("T1", "z"), L("T2", "q")]);
  });
});
