import { describe, expect, it } from "vitest";
import { backAndForths, buildForest, parentOf, placeOf, toCommentRecord } from "../../src/domain/comments";
import type { RawCommentList, RawCommentRef, RawCommentTree, Thread, TreeNode } from "../../src/types";
import {
  AGI_FOREST, OLD_DISCUSSION, agiRuinForest, commentRow, flatForestRows, oldDiscussionForest, rawCommentList, rawCommentRef,
  rawPostRef, rawTagRef, replyRow, rowId, rowUser,
} from "../support/builders";

const T = "2022-06-19T10:00:00.000Z";
const forest = (comments: RawCommentTree[], o: { answers?: RawCommentTree[]; postAf?: boolean; hideCommentKarma?: boolean } = {}) =>
  buildForest({ comments, answers: o.answers ?? [], postAf: o.postAf ?? false, hideCommentKarma: o.hideCommentKarma ?? false });
const idsOf = (nodes: readonly TreeNode[]) => nodes.map((n) => n.c.id);
const rooted = (threads: readonly Thread[], id: string) => threads.find((t) => t.rootId === id)!;

describe("toCommentRecord", () => {
  it("¶3.8.1 maps the COMMENT_TREE fields; the thread root is topLevelCommentId ?? _id", () => {
    const r = toCommentRecord(replyRow("r", 1, T, "p", "root", {
      retracted: true, reviewingForReview: "2022", shortform: true, isPinnedOnProfile: true,
      af: true, baseScore: 12, voteCount: 7, afBaseScore: 9, contents: { wordCount: 42, markdown: "Line one\r\nLine two\u2028three" },
    }));
    expect(r).toMatchObject({
      id: rowId("r"), postedAt: T, postedMs: Date.parse(T), edited: false,
      parentId: rowId("p"), rootId: rowId("root"), answer: false, retracted: true, reviewYear: "2022",
      quickTake: true, pinnedOnProfile: true, debateTurn: false, af: true, karma: 12, votes: 7, afKarma: 9, karmaHidden: false,
      wordCount: 42, body: "Line one\nLine two\nthree",
    });
    expect(r.author).toMatchObject({ kind: "user", id: rowUser(1)._id, slug: "user-1" });
    expect(r.placeholder).toBeUndefined();
    expect(r.place).toBeUndefined();
    expect(r.parent).toBeUndefined();
    expect(toCommentRecord(commentRow("solo", 1, T)).rootId).toBe(rowId("solo"));
  });

  it("a body only once its Markdown is fetched; a placeholder carries no word count (P5)", () => {
    expect(toCommentRecord(commentRow("nb", 1, T, { contents: { wordCount: 10 } }))).not.toHaveProperty("body");
    expect(toCommentRecord(commentRow("nc", 1, T, { contents: null }))).not.toHaveProperty("body");
    expect(toCommentRecord(commentRow("eb", 1, T, { contents: { wordCount: 0, markdown: "" } })).body).toBe("");
    expect(toCommentRecord(commentRow("pw", 1, T, { deleted: true, deletedPublic: true, contents: { wordCount: 3, markdown: "x y z" } })).wordCount).toBe(0);
  });

  it("Q50.21 edited only when lastEditedAt − postedAt > 60 s", () => {
    const after = (ms: number) => new Date(Date.parse(T) + ms).toISOString();
    expect(toCommentRecord(commentRow("e0", 1, T, { lastEditedAt: after(60_000) })).edited).toBe(false);
    expect(toCommentRecord(commentRow("e1", 1, T, { lastEditedAt: after(60_001) })).edited).toBe(true);
    expect(toCommentRecord(commentRow("e2", 1, T, { lastEditedAt: null })).edited).toBe(false);
  });

  it("Q50.20 Q118 P8 user null reads account not publicly visible", () => {
    expect(toCommentRecord(commentRow("d", null, T)).author).toEqual({ kind: "none", why: "account not publicly visible" });
  });

  it("P7 Q116 a hideAuthor comment has no author", () => {
    expect(toCommentRecord(commentRow("h", 1, T, { hideAuthor: true })).author).toEqual({ kind: "none", why: "author not publicly visible" });
  });

  it("P5 D8 a publicly deleted comment is a placeholder: date and reason only", () => {
    const r = toCommentRecord(commentRow("x", 1, T, {
      deleted: true, deletedPublic: true, deletedReason: "Requested account deletion", moderatorHat: true,
      baseScore: 9, voteCount: 6, afBaseScore: 4, extendedScore: { agreement: -4, agreementVoteCount: 5 },
      contents: { wordCount: 3, markdown: "secret text" },
    }));
    expect(r).toMatchObject({
      placeholder: { reason: "Requested account deletion" }, author: { kind: "none", why: "comment placeholder" },
      postedAt: T, karma: null, votes: null, afKarma: null, karmaHidden: false, moderatorHat: false,
    });
    expect(r.body).toBeUndefined();
    expect(r.reactions.hasVoteData).toBe(false);
    expect(r.reactions.agreement).toBeUndefined();
  });

  it("P18 Q105 Q50.23 hidden comment karma: karma, votes, AF karma, agreement and reactions are null, never 0", () => {
    const own = toCommentRecord(commentRow("h1", 1, T, { hideKarma: true, baseScore: null, voteCount: 4, afBaseScore: null }));
    const post = toCommentRecord(
      commentRow("h2", 1, T, { baseScore: 5, voteCount: 4, afBaseScore: 3, extendedScore: { agreement: 2, agreementVoteCount: 3 } }),
      { hideCommentKarma: true },
    );
    for (const r of [own, post]) {
      expect(r).toMatchObject({ karmaHidden: true, karma: null, votes: null, afKarma: null });
      expect(r.reactions).toMatchObject({ reacts: [], hasVoteData: false });
      expect(r.reactions.agreement).toBeUndefined();
    }
  });

  it("C4 the moderator mark survives only on attributable comments", () => {
    expect(toCommentRecord(commentRow("m1", 1, T, { moderatorHat: true })).moderatorHat).toBe(true);
    expect(toCommentRecord(commentRow("m2", 1, T, { moderatorHat: true, hideAuthor: true })).moderatorHat).toBe(false);
    expect(toCommentRecord(commentRow("m3", null, T, { moderatorHat: true })).moderatorHat).toBe(false);
  });

  it("Q100 Q50.19 Comment.author and Comment.postVersion are never read", () => {
    const plain = commentRow("v", 1, T);
    const stale = Object.assign(commentRow("v", 1, T), { author: "Stale Name", postVersion: "1.3.0" }) as RawCommentTree;
    expect(toCommentRecord(stale)).toEqual(toCommentRecord(plain));
  });
});

describe("placeOf and parentOf (list form, ¶3.8.1)", () => {
  const AGI_REF = rawPostRef({ _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities", af: true });
  const INTERP = rawTagRef({ _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai" });
  const CONTAINER = rawPostRef({ _id: "shortformC0000001", title: "Sample Author's Shortform", slug: "sample-author-s-shortform", af: false, shortform: true });
  /** A made-up post, the one these tests make rejected. */
  const SAMPLE_REF = rawPostRef({ _id: "samplePost0000001", title: "A sample post", slug: "a-sample-post", af: true });
  const listRow = (o: Partial<RawCommentList>): RawCommentList => rawCommentList({
    _id: rowId("l"), postedAt: T, postId: AGI_REF._id, tagId: null, post: AGI_REF, tag: null, parentCommentId: null, parentComment: null, shortform: false, ...o,
  });
  const parentRow = (o: Partial<RawCommentRef>): RawCommentRef => rawCommentRef({
    _id: rowId("par"), postedAt: "2022-06-01T00:00:00.000Z", af: false, user: rowUser(2), userId: rowUser(2)._id,
    deleted: false, deletedPublic: false, rejected: false, authorIsUnreviewed: false, hideAuthor: false, ...o,
  });
  const reply = (p: RawCommentRef | null) => listRow({ parentCommentId: rowId("par"), parentComment: p });

  it("P1 a wiki-discussion comment is placed by tagId first", () => {
    expect(placeOf(listRow({ postId: null, post: null, tagId: INTERP._id, tag: INTERP })))
      .toMatchObject({ kind: "tag", tag: { hidden: false, id: "56yXXrcxRjrQs6z9R", slug: "interpretability-ml-and-ai" } });
    expect(placeOf(listRow({ tagId: INTERP._id, tag: null }))).toEqual({ kind: "hidden tag" });
    expect(placeOf(listRow({ postId: null, post: null, tagId: INTERP._id, tag: rawTagRef({ ...INTERP, adminOnly: true }) }))).toEqual({ kind: "hidden tag" });
  });

  it("Q69 P1 P2 a comment on a post that is not publicly visible names no post", () => {
    expect(placeOf(listRow({ post: null }))).toEqual({ kind: "hidden post" });
    expect(placeOf(listRow({ postId: SAMPLE_REF._id, post: rawPostRef({ ...SAMPLE_REF, rejected: true }) }))).toEqual({ kind: "hidden post" });
  });

  it("P3 an unlisted post is named; a quick-takes container makes the comment a quick take", () => {
    expect(placeOf(listRow({}))).toMatchObject({ kind: "post", post: { hidden: false, id: "uMQ3cqWDPHhjtiesc", af: true } });
    expect(placeOf(listRow({ post: rawPostRef({ ...AGI_REF, unlisted: true }) }))).toMatchObject({ kind: "post", post: { hidden: false, unlisted: true } });
    expect(placeOf(listRow({ postId: CONTAINER._id, post: CONTAINER }))).toMatchObject({ kind: "quick take", post: { id: "shortformC0000001" } });
    expect(toCommentRecord(listRow({ postId: CONTAINER._id, post: CONTAINER })).quickTake).toBe(true);
  });

  it("P1 a list row is a quick take through its masked place only: not via a hidden container or a tag comment's post join", () => {
    const hiddenContainer = listRow({ postId: CONTAINER._id, post: rawPostRef({ ...CONTAINER, rejected: true }), shortform: false });
    expect(placeOf(hiddenContainer)).toEqual({ kind: "hidden post" });
    expect(toCommentRecord(hiddenContainer).quickTake).toBe(false);
    const onTag = listRow({ postId: CONTAINER._id, post: CONTAINER, tagId: INTERP._id, tag: INTERP, shortform: false });
    expect(placeOf(onTag)).toMatchObject({ kind: "tag" });
    expect(toCommentRecord(onTag).quickTake).toBe(false);
  });

  it("P2 P5 P6 a hidden parent shows no id", () => {
    expect(parentOf(listRow({}))).toEqual({ kind: "none" });
    const hidden = [null, parentRow({ rejected: true }), parentRow({ deleted: true, deletedPublic: false }), parentRow({ authorIsUnreviewed: true, postedAt: "2023-04-04T18:54:35.895Z" })];
    for (const p of hidden) expect(parentOf(reply(p))).toEqual({ kind: "hidden" });
    expect(parentOf(reply(parentRow({ authorIsUnreviewed: true, postedAt: "2023-04-04T18:54:35.894Z" })))).toMatchObject({ kind: "comment", id: rowId("par") });
  });

  it("P5 P7 a placeholder parent is a deleted comment with its id; an anonymous parent keeps only its id and AF status", () => {
    expect(parentOf(reply(parentRow({ deleted: true, deletedPublic: true })))).toEqual({ kind: "deleted", id: rowId("par") });
    expect(parentOf(reply(parentRow({ hideAuthor: true, af: true })))).toEqual({ kind: "comment", id: rowId("par"), af: true, author: { kind: "none", why: "author not publicly visible" } });
    expect(parentOf(reply(parentRow({})))).toMatchObject({ kind: "comment", id: rowId("par"), af: false, author: { kind: "user", id: rowUser(2)._id } });
  });

  it("toCommentRecord fills place and parent for list rows", () => {
    const r = toCommentRecord(reply(parentRow({})));
    expect(r.place).toMatchObject({ kind: "post" });
    expect(r.parent).toMatchObject({ kind: "comment", id: rowId("par") });
  });
});

describe("buildForest (¶4.4 steps 3–5)", () => {
  it("roots are topLevelCommentId ?? _id and siblings are in time order", () => {
    const f = forest([
      replyRow("b", 2, "2022-06-19T10:20:00.000Z", "r", "r"), commentRow("r", 1, T),
      replyRow("a1", 1, "2022-06-19T10:30:00.000Z", "a", "r"), replyRow("a", 3, "2022-06-19T10:10:00.000Z", "r", "r"),
    ]);
    expect(f.threads).toHaveLength(1);
    expect(idsOf(f.threads[0].nodes)).toEqual([rowId("r"), rowId("a"), rowId("a1"), rowId("b")]);
    expect(idsOf(f.threads[0].root.children)).toEqual([rowId("a"), rowId("b")]);
  });

  it("Q52 an orphan goes under its root, flagged; with no root it is its own thread; no node carries the missing parent", () => {
    const f = forest([
      commentRow("r", 1, T), replyRow("o", 2, "2022-06-19T11:00:00.000Z", "missing", "r"),
      replyRow("o2", 3, "2022-06-19T12:00:00.000Z", "missing", "missingroot"),
    ]);
    expect(f.byId.get(rowId("o"))!.orphan).toBe(true);
    expect(idsOf(f.threads[0].root.children)).toEqual([rowId("o")]);
    expect(f.threads.map((t) => t.rootId)).toEqual([rowId("r"), rowId("o2")]);
    expect(f.byId.get(rowId("o2"))!.orphan).toBe(true);
    expect(f.byId.has(rowId("missing"))).toBe(false);
  });

  it("P2 P5 P6 defence in depth: rejected, privately deleted and post-cutoff unreviewed rows are dropped, orphaning their replies", () => {
    const f = forest([
      commentRow("r", 1, "2023-04-01T00:00:00.000Z"),
      replyRow("rej", 2, "2023-04-02T00:00:00.000Z", "r", "r", { rejected: true }),
      replyRow("priv", 3, "2023-04-02T01:00:00.000Z", "r", "r", { deleted: true, deletedPublic: false }),
      replyRow("unrev", 4, "2023-04-04T18:54:35.895Z", "r", "r", { authorIsUnreviewed: true }),
      replyRow("early", 5, "2023-04-04T18:54:35.894Z", "r", "r", { authorIsUnreviewed: true }),
      replyRow("kid", 6, "2023-04-05T00:00:00.000Z", "priv", "r"),
    ]);
    expect([...f.byId.keys()].sort()).toEqual([rowId("early"), rowId("kid"), rowId("r")].sort());
    expect(f.count).toBe(3);
    expect(f.byId.get(rowId("kid"))!.orphan).toBe(true);
  });

  it("Q110 a reader reply to a debate turn is its own thread, flagged with the turn's author; turns never become nodes", () => {
    const turn = rawCommentRef({
      _id: rowId("turn"), postId: "qbcuk8WwFnTZcXTd6", postedAt: "2023-09-06T00:00:00.000Z", af: false, debateResponse: true,
      user: rowUser(5), userId: rowUser(5)._id, deleted: false, deletedPublic: false, rejected: false, authorIsUnreviewed: false, hideAuthor: false,
    });
    const f = buildForest({
      comments: [
        replyRow("rr", 2, "2023-10-03T00:00:00.000Z", "turn", "turn", { postId: "qbcuk8WwFnTZcXTd6" }),
        commentRow("turn2", 5, "2023-09-07T00:00:00.000Z", { postId: "qbcuk8WwFnTZcXTd6", debateResponse: true }),
      ],
      answers: [], debateTurns: [turn], postAf: false, hideCommentKarma: false,
    });
    const node = f.byId.get(rowId("rr"))!;
    expect(node.orphan).toBe(false);
    expect(node.debateReplyTo).toMatchObject({ kind: "user", id: rowUser(5)._id });
    expect(f.threads.map((t) => t.rootId)).toEqual([rowId("rr")]);
    expect(f.byId.has(rowId("turn2"))).toBe(false);
  });

  it("Q110 P2 P5 a reply whose missing parent is a debate turn that is not public is an orphan: no debateReplyTo, and the turn's author appears nowhere", () => {
    const turn = (id: string, o: Partial<RawCommentRef>) => rawCommentRef({
      _id: rowId(id), postId: "qbcuk8WwFnTZcXTd6", postedAt: "2023-09-06T00:00:00.000Z", af: false, debateResponse: true,
      user: rowUser(5), userId: rowUser(5)._id, deleted: false, deletedPublic: false, rejected: false, authorIsUnreviewed: false, hideAuthor: false, ...o,
    });
    const f = buildForest({
      comments: [
        replyRow("rd", 2, "2023-10-03T00:00:00.000Z", "deletedTurn", "deletedTurn", { postId: "qbcuk8WwFnTZcXTd6" }),
        replyRow("rj", 3, "2023-10-04T00:00:00.000Z", "rejectedTurn", "rejectedTurn", { postId: "qbcuk8WwFnTZcXTd6" }),
      ],
      answers: [],
      debateTurns: [turn("deletedTurn", { deleted: true, deletedPublic: false }), turn("rejectedTurn", { rejected: true })],
      postAf: false, hideCommentKarma: false,
    });
    for (const id of ["rd", "rj"]) {
      const node = f.byId.get(rowId(id))!;
      expect(node.orphan).toBe(true);
      expect(node.debateReplyTo).toBeUndefined();
    }
    expect(f.threads.map((t) => t.rootId)).toEqual([rowId("rd"), rowId("rj")]);
    expect(JSON.stringify(f.threads)).not.toContain(rowUser(5)._id);
  });

  it("answers are A-thread roots; their replies hang under them", () => {
    const f = forest([commentRow("c", 1, T)], {
      answers: [
        commentRow("ans", 2, "2022-06-19T09:00:00.000Z", { answer: true }),
        replyRow("ar", 3, "2022-06-19T09:30:00.000Z", "ans", "ans"),
      ],
    });
    expect(rooted(f.threads, rowId("ans"))).toMatchObject({ answer: true, size: 2 });
    expect(rooted(f.threads, rowId("c")).answer).toBe(false);
    expect(idsOf(rooted(f.threads, rowId("ans")).root.children)).toEqual([rowId("ar")]);
  });

  it("P5 placeholders keep their place without author or body; retracted comments keep their text", () => {
    const f = forest([
      commentRow("r", 1, T),
      replyRow("ph", 2, "2022-06-19T10:10:00.000Z", "r", "r", { deleted: true, deletedPublic: true, deletedReason: "Comment deleted by its author", contents: null }),
      replyRow("k", 3, "2022-06-19T10:20:00.000Z", "ph", "r"),
      replyRow("rt", 4, "2022-06-19T10:30:00.000Z", "r", "r", { retracted: true, contents: { wordCount: 2, markdown: "still readable" } }),
    ]);
    expect(idsOf(f.byId.get(rowId("r"))!.children)).toEqual([rowId("ph"), rowId("rt")]);
    expect(idsOf(f.byId.get(rowId("ph"))!.children)).toEqual([rowId("k")]);
    expect(f.byId.get(rowId("ph"))!.c).toMatchObject({ author: { kind: "none", why: "comment placeholder" }, placeholder: { reason: "Comment deleted by its author" } });
    expect(f.byId.get(rowId("ph"))!.c.body).toBeUndefined();
    expect(f.byId.get(rowId("rt"))!.c).toMatchObject({ retracted: true, body: "still readable" });
  });

  it("P19 participants count attributable people only; metrics come from the tree", () => {
    const f = forest([
      commentRow("r", 1, T, { af: true, baseScore: 30, voteCount: 15, afBaseScore: 12 }),
      replyRow("x2", 2, "2022-06-19T10:10:00.000Z", "r", "r"),
      replyRow("x1", 1, "2022-06-19T10:20:00.000Z", "r", "r"),
      replyRow("anon", 3, "2022-06-19T10:30:00.000Z", "r", "r", { hideAuthor: true }),
      replyRow("del", null, "2022-06-19T10:40:00.000Z", "r", "r"),
      replyRow("ph", 4, "2022-06-19T10:50:00.000Z", "r", "r", { deleted: true, deletedPublic: true, contents: null }),
      commentRow("lw", 5, "2022-06-20T00:00:00.000Z", { af: false, afBaseScore: 5 }),
    ]);
    expect(rooted(f.threads, rowId("r"))).toMatchObject({
      size: 6, participants: 2, rootKarma: 30, rootAfKarma: 12, af: true, answer: false, contested: 0,
      postedMs: Date.parse(T), newestMs: Date.parse("2022-06-19T10:50:00.000Z"),
    });
    expect(rooted(f.threads, rowId("lw"))).toMatchObject({ rootAfKarma: null, af: false });
  });

  it("forest flags: count, AF count, vote data, truncation at 5,000 rows, the post's settings passed through", () => {
    const f = forest([commentRow("r", 1, T, { af: true }), commentRow("v", 2, T, { extendedScore: { agreement: 2, agreementVoteCount: 3 } })], { postAf: true });
    expect(f).toMatchObject({ count: 2, afCount: 1, hasVoteData: true, truncated: false, postAf: true, hideCommentKarma: false });
    const hidden = forest([commentRow("v", 2, T, { extendedScore: { agreement: 2, agreementVoteCount: 3 } })], { hideCommentKarma: true });
    expect(hidden).toMatchObject({ hideCommentKarma: true, hasVoteData: false });
    expect(hidden.byId.get(rowId("v"))!.c.karmaHidden).toBe(true);
    expect(forest(flatForestRows(5000, T)).truncated).toBe(true);
  });
});

describe("backAndForths (¶3.8.6)", () => {
  /** One reply chain: comment i replies to comment i − 1; "anon" is user 1 writing with hideAuthor. */
  function chain(authors: readonly (number | "anon")[]): Thread {
    const rows = authors.map((a, i) => {
      const at = new Date(Date.parse(T) + i * 60_000).toISOString();
      const o = a === "anon" ? { hideAuthor: true } : {};
      const user = a === "anon" ? 1 : a;
      return i === 0 ? commentRow("k0", user, at, o) : replyRow(`k${i}`, user, at, `k${i - 1}`, "k0", o);
    });
    return forest(rows).threads[0];
  }

  it("two people alternating over 6 comments are one back-and-forth", () => {
    expect(backAndForths(chain([1, 2, 1, 2, 1, 2]))).toEqual([{
      a: expect.objectContaining({ kind: "user", id: rowUser(1)._id }), b: expect.objectContaining({ kind: "user", id: rowUser(2)._id }),
      replies: 6, fromId: rowId("k0"), toId: rowId("k5"), rootId: rowId("k0"),
    }]);
  });

  it("three alternating comments are not one", () => {
    expect(backAndForths(chain([1, 2, 1]))).toEqual([]);
  });

  it("a new pair starts at the last comment of the old pair", () => {
    expect(backAndForths(chain([1, 2, 3, 2, 3, 2]))).toEqual([{
      a: expect.objectContaining({ id: rowUser(2)._id }), b: expect.objectContaining({ id: rowUser(3)._id }),
      replies: 5, fromId: rowId("k1"), toId: rowId("k5"), rootId: rowId("k0"),
    }]);
  });

  it("P19 an anonymous comment breaks the chain", () => {
    expect(backAndForths(chain([1, 2, "anon", 2, 1]))).toEqual([]);
  });

  it("branches that share a start count once, keeping the longest", () => {
    const at = (m: number) => new Date(Date.parse(T) + m * 60_000).toISOString();
    const t = forest([
      commentRow("k0", 1, at(0)), replyRow("k1", 2, at(1), "k0", "k0"), replyRow("k2", 1, at(2), "k1", "k0"),
      replyRow("k3", 2, at(3), "k2", "k0"), replyRow("k4", 2, at(4), "k2", "k0"), replyRow("k5", 1, at(5), "k4", "k0"),
    ]).threads[0];
    expect(backAndForths(t)).toEqual([expect.objectContaining({ replies: 5, fromId: rowId("k0"), toId: rowId("k5") })]);
  });
});

describe("the AGI-Ruin-shaped forest (¶C, §8.4, §8.12)", () => {
  const A = AGI_FOREST.ids;
  const f = buildForest({ ...agiRuinForest(), postAf: true, hideCommentKarma: false });
  const nodes = [...f.byId.values()];

  it("731 publicly visible comments in 158 threads, 214 people, 17 placeholders, 148 AF comments", () => {
    expect(f).toMatchObject({ count: 731, afCount: 148, truncated: false, hasVoteData: true, postAf: true });
    expect(f.threads).toHaveLength(158);
    expect(nodes.filter((n) => n.c.placeholder).length).toBe(17);
    expect(new Set(nodes.flatMap((n) => (n.c.author.kind === "user" ? [n.c.author.id] : []))).size).toBe(214);
  });

  it("thread 1: 18 comments, 7 people, root karma 299 and AF karma 87, contested 6, newest 2022-06-20T10:02:00.000Z", () => {
    const t1 = rooted(f.threads, A.p0);
    expect(t1).toMatchObject({ size: 18, participants: 7, rootKarma: 299, rootAfKarma: 87, af: true, contested: 6, newestMs: Date.parse("2022-06-20T10:02:00.000Z") });
    expect(backAndForths(t1)).toEqual([{
      a: expect.objectContaining({ id: AGI_FOREST.paul._id }), b: expect.objectContaining({ id: AGI_FOREST.ey._id }),
      replies: 6, fromId: A.p0, toId: A.e5, rootId: A.p0,
    }]);
  });

  it("Q52 the orphan sits under its root; Q105 the hidden-karma root has null karma; the deleted account's root is unattributed", () => {
    expect(f.byId.get(A.orphan)!.orphan).toBe(true);
    expect(rooted(f.threads, A.orphanRoot).size).toBe(2);
    expect(f.byId.has(A.missingParent)).toBe(false);
    expect(rooted(f.threads, A.hiddenRoot).rootKarma).toBeNull();
    expect(f.byId.get(A.hiddenRoot)!.c.karmaHidden).toBe(true);
    expect(f.byId.get(A.deletedAccountRoot)!.c.author).toEqual({ kind: "none", why: "account not publicly visible" });
  });

  it("C4 P7 P19 the moderator mark shows only on the attributable comment; the anonymous reply names nobody", () => {
    expect(f.byId.get(A.e3)!.c.moderatorHat).toBe(true);
    expect(f.byId.get(A.x1)!.c.moderatorHat).toBe(false);
    expect(f.byId.get(A.y1)!.c).toMatchObject({ moderatorHat: false, author: { kind: "none", why: "author not publicly visible" } });
  });

  it("the old discussion (§13.3) has no vote data and no signals", () => {
    const o = buildForest({ ...oldDiscussionForest(), postAf: false, hideCommentKarma: false });
    const O = OLD_DISCUSSION.ids;
    expect(o).toMatchObject({ count: 12, hasVoteData: false });
    expect(o.threads.map((t) => [t.rootId, t.size, t.participants, t.contested])).toEqual([
      [O.c1, 4, 3, 0], [O.c5, 3, 3, 0], [O.c8, 3, 3, 0], [O.c11, 2, 2, 0],
    ]);
  });
});
