import { describe, it, expect } from "vitest";
import { createHarness, expectClean } from "../support/harness";
import { SAMPLE_PERSON, smallAgiRuinForest, forestEntries, rawCommentTree, deepThread30, gqlEntry, rawCommentList, rawCommentRef, rawPostRef, samplePersonEntry } from "../support/builders";
import { createCallContext } from "../../src/call/context";
import { rememberResolution, resolve, resolvedFrom } from "../../src/ids/resolve";
import type { RawCommentTree } from "../../src/types";
import type { FixtureEntry } from "../support/fixtures";

const FAMS = ["posts", "comments", "joins", "users", "tags"] as const;
const H = (extra: FixtureEntry[] = smallAgiRuinForest()) => createHarness({ families: FAMS, extra });
const cursorOf = (text: string) => /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(text)?.[1];
const replyIds = (text: string) => text.split("\n").filter((l) => l.startsWith("▶ ")).map((l) => /comment_id (\w{17})/.exec(l)![1]);
const GLM_REF = rawPostRef({ _id: "R5g8YT25G9DXJJ48n", title: "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior", slug: "glm-5-3-sometimes-considers-how-train-time-actions-shape", af: false });
const paul = { _id: "paulfchristianoId", slug: "paulfchristiano", displayName: "paulfchristiano" };
const carol = { _id: "carolUserId000001", slug: "carol", displayName: "Carol" };

/** A chain of `n` replies on the GLM post, each answering the one before (`deepChain000000000` the root), 60 words each. */
function deepChain(n: number): RawCommentTree[] {
  const id = (i: number): string => "deepChain" + String(i).padStart(8, "0");
  const markdown = Array.from({ length: 60 }, (_, j) => `word${j % 7}`).join(" ");
  return Array.from({ length: n }, (_, i) => rawCommentTree({
    _id: id(i), postId: GLM_REF._id, af: false, parentCommentId: i === 0 ? null : id(i - 1), topLevelCommentId: i === 0 ? null : id(0),
    postedAt: new Date(Date.parse("2025-02-01T00:00:00.000Z") + i * 3_600_000).toISOString(), extendedScore: null, voteCount: 2,
    contents: { wordCount: 60, markdown },
  }));
}

describe("get_comments: comment target, user and match", () => {
  it("Q51 P2 P5 P6 hidden comment targets read like unknown ids", async () => {
    for (const id of ["privDeletedCmnt01", "rejectedCmnt00001", "unrevAfterCmnt001"])
      expect((await H().call("get_comments", { comment: id })).text).toBe(`Error (not_found): No publicly visible comment has the id "${id}".`);
  });
  it("◆ the comment's thread only, ranked by sort, which changes only the reported rank", async () => {
    const out = (await H().call("get_comments", { comment: "replyPaul00000001", sort: "old" })).text;
    expect(out).toContain("thread 3 of 3 by old");
    expect(out).toContain('## T1 · root by "paulfchristiano"');
    expect(out).toMatch(/◆.*comment_id replyPaul00000001|comment_id replyPaul00000001.*◆/);
    expect(out).not.toContain("rootAnn0000000001");
  });
  it("P1 a comment on a hidden post is shown alone, flagged; no discussion is requested", async () => {
    const h = H(); const out = (await h.call("get_comments", { comment: "onHiddenPostCmnt1" })).text;
    expect(out).toContain("on a post that is not publicly visible");
    expect(h.forum.requests).toHaveLength(1);
    // ¶3.5: with no discussion around it, a lone non-AF comment reads `LW only`, as its echo and the one-line forms do, never
    // `not on AF` (the mark of a non-AF comment inside an AF post's discussion).
    expect(out).toContain("(LW only)");
    expect(out).toMatch(/^▶ ◆ .* · karma 3 \(2 votes\) · LW only · on a post that is not publicly visible · comment_id onHiddenPostCmnt1$/m);
    expect(out).not.toContain("not on AF");
  });
  it("P1 P12 P17 a wiki-discussion comment's thread comes from its page's forest, confirmed by the join", async () => {
    const h = H(forestEntries({ tag: "sYm3HiWcfZvrGu3ui" }, [rawCommentTree({ _id: "wikiDiscussCmnt01", tagId: "sYm3HiWcfZvrGu3ui", postId: null })]));
    const out = (await h.call("get_comments", { comment: "wikiDiscussCmnt01" })).text;
    expect(h.forum.requests[1].body).toContain('tagDiscussionComments: {tagId: \\"sYm3HiWcfZvrGu3ui\\"}');
    expect(out).toContain('on wiki page "AI" (tag_slug ai)');
    expect((await h.call("get_comments", { comment: "wikiHiddenCmnt001" })).text).toContain("on a wiki page that is not publicly visible");
  });
  it("¶5b example 2: the reply map with 'replied back'; ★ marks; only the person's threads", async () => {
    const h = H(); await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" });
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", user: "paulfchristiano" })).text;
    expect(h.forum.requests.length - n).toBeLessThanOrEqual(1);
    expect(out).toContain('Reply map for "paulfchristiano" (user_slug paulfchristiano)');
    expect(out).toContain('  ★ comment_id rootPaul000000001 (T1 · 2022-06-19 · AF karma 87 · "Paul\'s root comment about takeoff."):');
    expect(out).toContain('     ↳ T1.1 · "Carol" (user_slug carol) · comment_id replyC00000000001 · not on AF · replied back: yes (comment_id replyPaul00000001)');
    expect(out).toContain("Position: threads 1–1 of 1");
    expect(out).not.toContain("## T2");
  });
  it("P7 P19 D8 placeholders and anonymous comments never count as the person's; unattributed repliers have no name", async () => {
    // A made-up person, whose own placeholder and anonymous comment are the ones that must not count.
    const p = "uMQ3cqWDPHhjtiesc", sam = SAMPLE_PERSON;
    const h = H([samplePersonEntry(), ...forestEntries({ post: p }, [
      rawCommentTree({ _id: "rootSample0000001", postId: p, userId: sam._id, user: sam, af: true }),
      // Carol's reply is off AF, so it reads "not on AF" in this AF post's discussion.
      rawCommentTree({ _id: "replyC00000000001", postId: p, parentCommentId: "rootSample0000001", topLevelCommentId: "rootSample0000001", userId: carol._id, user: carol, af: false }),
      rawCommentTree({ _id: "samplePlacehold01", postId: p, parentCommentId: "replyC00000000001", topLevelCommentId: "rootSample0000001", userId: sam._id, user: sam, deleted: true, deletedPublic: true }),
      rawCommentTree({ _id: "sampleAnon0000001", postId: p, parentCommentId: "rootSample0000001", topLevelCommentId: "rootSample0000001", userId: sam._id, user: sam, hideAuthor: true })])]);
    const out = (await h.call("get_comments", { post: p, user: sam.slug })).text;
    expect(out).toContain("comment_id replyC00000000001 · not on AF · replied back: no");
    expect(out).toContain("· unattributed (author not publicly visible) · comment_id sampleAnon0000001");
    expect(out).not.toContain("★ comment_id samplePlacehold01");
    expect(out).not.toContain("★ comment_id sampleAnon0000001");
  });
  it("match: the matching comments with their thread root and parent", async () => {
    const h = H();
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", match: "reply" })).text;
    expect(out).toContain('2 of 6 comments contain "reply".');
    expect(out).toContain("thread root: comment_id rootPaul000000001");
    expect(out).toContain("thread root: comment_id rootBob0000000001");
    expect((await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", match: "zzqq" })).text).toContain('0 of 6 comments contain "zzqq".');
  });
  it("comment + match searches only that thread; comment + user limits the map to it", async () => {
    const h = H();
    expect((await h.call("get_comments", { comment: "rootBob0000000001", match: "orphaned" })).text).toContain('1 of 2 comments contain "orphaned".');
    const out = (await h.call("get_comments", { comment: "replyPaul00000001", user: "paulfchristiano" })).text;
    expect(out).toContain("★ comment_id rootPaul000000001");
    expect(out).not.toContain("rootBob0000000001");
  });
  it("¶3.1.2 a lens slug as tag stands for its page: the page's discussion is read and the echo names the lens", async () => {
    const h = H(forestEntries({ tag: "RkznxXmmh9b5ovdSq" }, [rawCommentTree({ _id: "bayesDiscussCmnt1", tagId: "RkznxXmmh9b5ovdSq", postId: null })]));
    const out = (await h.call("get_comments", { tag: "bayes-rule-guide" })).text;
    expect(h.forum.requests.some((r) => r.body.includes('tagDiscussionComments: {tagId: \\"RkznxXmmh9b5ovdSq\\"}'))).toBe(true);
    expect(out).toContain('lens bayes-rule-guide → page "Bayes\' rule"');
    expect(out).toContain("comment_id bayesDiscussCmnt1");
  });
  it("Q54 a reply inside an answer thread: its A thread, with A labels and the target marked", async () => {
    const q = "22xf8GmwqGzHbiuLg";
    const answer = rawCommentTree({ _id: "qAnswer0000000001", postId: q, answer: true, baseScore: 5 });
    const reply = rawCommentTree({ _id: "qAnswerReply00001", postId: q, parentCommentId: "qAnswer0000000001", topLevelCommentId: "qAnswer0000000001" });
    const qRef = rawPostRef({ _id: q, title: "What are the best arguments for and against a fast takeoff?", slug: "what-are-the-best-arguments-for-and-against-a-fast-takeoff", question: true, af: false });
    const h = H([gqlEntry({ root: "comment", id: "qAnswerReply00001" }, { result: rawCommentList({ ...reply, post: qRef, tag: null, parentComment: rawCommentRef({ _id: "qAnswer0000000001", postId: q }) }) }, "§8.8"),
      ...forestEntries({ post: q }, [rawCommentTree({ _id: "qComment000000001", postId: q, baseScore: 90 })], [answer, reply])]);
    const out = (await h.call("get_comments", { comment: "qAnswerReply00001" })).text;
    expect(out).toContain("## A1 · ");
    expect(out).toMatch(/◆.*comment_id qAnswerReply00001|comment_id qAnswerReply00001.*◆/);
    expect(out).toContain("comment_id qAnswer0000000001");
    expect(out).not.toContain("qComment000000001");
  });
  it("¶4.4 step 9 comment= on a thread larger than the page: page 1 shows the chain from the root to the target", async () => {
    const rows = deepThread30();
    const target = rows[29];
    const h = H([gqlEntry({ root: "comment", id: target._id }, { result: rawCommentList({ ...target, post: GLM_REF, tag: null, parentComment: rawCommentRef({ _id: rows[4]._id, postId: GLM_REF._id }) }) }, "§8.12"),
      ...forestEntries({ post: GLM_REF._id }, rows)]);
    const p1 = (await h.call("get_comments", { comment: target._id, max_tokens: 2000 })).text;
    expect(p1).toContain("◆");
    for (const r of [rows[0], rows[1], rows[2], rows[3], rows[4], target]) expect(p1).toContain(`comment_id ${r._id}`);
  });
  it("the reply map's 25 % sub-cap continues with the cursor before any thread", async () => {
    const p = "uMQ3cqWDPHhjtiesc";
    const rows = Array.from({ length: 40 }, (_, i) => [
      rawCommentTree({ _id: `mapRoot${String(i).padStart(10, "0")}`, postId: p, userId: paul._id, user: paul, postedAt: `2022-06-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00.000Z` }),
      rawCommentTree({ _id: `mapReply${String(i).padStart(9, "0")}`, postId: p, parentCommentId: `mapRoot${String(i).padStart(10, "0")}`, topLevelCommentId: `mapRoot${String(i).padStart(10, "0")}`, userId: carol._id, user: carol })]).flat();
    const h = H(forestEntries({ post: p }, rows));
    const p1 = (await h.call("get_comments", { post: p, user: "paulfchristiano", max_tokens: 2000 })).text;
    expect(p1).toContain("(continued with the cursor)");
    const c = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    const p2 = (await h.call("get_comments", { cursor: c })).text;
    const first = /★ comment_id (mapRoot\d{10})/.exec(p2)![1];
    expect(p1).not.toContain(`★ comment_id ${first}`);
    expect(p2.indexOf(`★ comment_id ${first}`)).toBeLessThan(p2.indexOf("## T") === -1 ? Infinity : p2.indexOf("## T"));
  });
  it("¶4.4 step 8: the reply map resumed inside one entry's replies: every ↳ line once and in order across pages, the entry's own line repeated on each page that resumes it", async () => {
    const p = GLM_REF._id;
    const root = rawCommentTree({ _id: "mapRootManyReply1", postId: p, af: false, userId: paul._id, user: paul, postedAt: "2025-03-01T00:00:00.000Z" });
    const replies = Array.from({ length: 40 }, (_, i) => rawCommentTree({
      _id: `manyReply${String(i).padStart(8, "0")}`, postId: p, af: false, parentCommentId: root._id, topLevelCommentId: root._id, userId: carol._id, user: carol,
      postedAt: new Date(Date.parse("2025-03-01T01:00:00.000Z") + i * 3_600_000).toISOString(),
    }));
    const h = H(forestEntries({ post: p }, [root, ...replies]));
    const pages = [(await h.call("get_comments", { post: p, user: "paulfchristiano", max_tokens: 2000 })).text];
    for (let c = cursorOf(pages.at(-1)!); c && pages.length < 40; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, max_tokens: 2000 })).text);
    const arrows = pages.map((t) => t.split("\n").filter((l) => l.startsWith("     ↳ ")).map((l) => /comment_id (\w{17})/.exec(l)![1]));
    expect(arrows.flat()).toEqual(replies.map((r) => r._id)); // every reply once, in reading order, none skipped or repeated
    const mapPages = arrows.flatMap((ids, i) => (ids.length > 0 ? [i] : []));
    expect(mapPages.length).toBeGreaterThan(2); // the map is resumed inside the entry's replies at least twice
    for (const i of mapPages) expect(pages[i]).toContain("  ★ comment_id mapRootManyReply1 (T1 · 2025-03-01 · ");
    for (const i of mapPages.slice(0, -1)) expect(pages[i]).toMatch(/\(next: reply map from comment 1\)\.$/);
    // The thread itself follows the map and is shown once (its header repeats only as `(continued)`).
    expect(pages.flatMap((t) => t.split("\n")).filter((l) => l.startsWith('## T1 · root by "paulfchristiano"') && !l.endsWith(" (continued)"))).toHaveLength(1);
    expect(pages.flatMap(replyIds).filter((id) => id === "mapRootManyReply1")).toHaveLength(1);
    expect(pages.at(-1)).toContain("End of results.");
    expectClean(h);
  });

  it("¶4.4 step 9: the rest of a thread read from its target follows with the cursor, every comment exactly once, ◆ once", async () => {
    const rows = deepThread30();
    const target = rows[29];
    const h = H([gqlEntry({ root: "comment", id: target._id }, { result: rawCommentList({ ...target, post: GLM_REF, tag: null, parentComment: rawCommentRef({ _id: rows[4]._id, postId: GLM_REF._id }) }) }, "§8.12"),
      ...forestEntries({ post: GLM_REF._id }, rows)]);
    const pages = [(await h.call("get_comments", { comment: target._id, max_tokens: 2000 })).text];
    for (let c = cursorOf(pages[0]); c && pages.length < 40; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, max_tokens: 2000 })).text);
    expect(pages.length).toBeGreaterThan(2);
    expect(replyIds(pages[0])[0]).toBe(target._id); // page 1 starts at the target, under the chain from the root
    const seen = pages.flatMap(replyIds);
    for (const r of rows) expect(seen.filter((id) => id === r._id), r._id).toHaveLength(1);
    expect(pages.join("\n").match(/◆/g)).toHaveLength(1);
    expect(pages[1]).toContain(" (continued)");
    expect(pages.at(-1)).toContain("End of results.");
    expectClean(h);
  });
  it("match: limit counts matching comments, and the cursor continues them", async () => {
    const h = H();
    const p1 = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", match: "reply", limit: 1 })).text;
    expect(p1).toContain("Position: comments 1–1 of 2");
    expect(replyIds(p1)).toEqual(["replyC00000000001"]);
    expect(p1).toMatch(/\(next: comments 2–2\)\.$/);
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)! })).text;
    expect(replyIds(p2)).toEqual(["orphanReply000001"]);
    expect(p2).toContain('2 of 6 comments contain "reply".');
    expect(p2).toContain("End of results.");
    expectClean(h);
  });
  it("P17 a comment cached without its COMMENT_LIST fields is read again; its thread's discussion is confirmed by the join", async () => {
    const h = H();
    await resolve({ kind: "comment", form: "id", value: "replyPaul00000001", given: "id", notes: [] }, "comment", createCallContext("get_comments", { now: h.clock.now }), h.services);
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { comment: "replyPaul00000001" })).text;
    expect(h.forum.requests[n].body).toContain("...COMMENT_LIST");
    expect(out).toMatch(/◆ T1\.1\.1 .*comment_id replyPaul00000001/);
    // A continuation-ready COMMENT_LIST document is then cached: the same call again sends nothing.
    const m = h.forum.requests.length;
    await h.call("get_comments", { comment: "replyPaul00000001" });
    expect(h.forum.requests.length).toBe(m);
    expectClean(h);
  });
  it("P1 P12 P17 a wiki-discussion comment: the page's discussion is requested only after the join confirmed it (request lint)", async () => {
    const h = H(forestEntries({ tag: "sYm3HiWcfZvrGu3ui" }, [rawCommentTree({ _id: "wikiDiscussCmnt01", tagId: "sYm3HiWcfZvrGu3ui", postId: null, af: false })]));
    const out = (await h.call("get_comments", { comment: "wikiDiscussCmnt01" })).text;
    expect(out).toContain('Wiki page: "AI" (tag_slug ai) · https://www.lesswrong.com/w/ai');
    expect(out).toMatch(/▶ ◆ T1 · .*comment_id wikiDiscussCmnt01/);
    expectClean(h);
  });
  it("¶2.3 a comment newer than the cached discussion is shown alone, saying why; the discussion is not read again", async () => {
    const p = "uMQ3cqWDPHhjtiesc";
    const late = rawCommentTree({ _id: "lateReply00000001", postId: p, af: false, parentCommentId: "rootAnn0000000001", topLevelCommentId: "rootAnn0000000001",
      postedAt: "2022-07-01T00:00:00.000Z", extendedScore: null, contents: { wordCount: 3, markdown: "A late reply." } });
    const h = H([gqlEntry({ root: "comment", id: late._id }, { result: rawCommentList({ ...late, post: rawPostRef(), tag: null, parentComment: rawCommentRef({ _id: "rootAnn0000000001" }) }) }, "§8.2"), ...smallAgiRuinForest()]);
    await h.call("get_comments", { post: p });
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { comment: late._id })).text;
    expect(h.forum.requests.length - n).toBe(1); // the comment's own check; the forest comes from the cache
    expect(out).toContain("This comment is not in its discussion as read by this server, which keeps a discussion for up to 10 minutes, so it is shown alone.");
    expect(out).toMatch(/▶ ◆ .*comment_id lateReply00000001/);
    expect(out).toContain("> A late reply.");
  });

  it("D1 P5 a target the forum stopped returning since it was resolved reads like an unknown id, now and on the next call", async () => {
    const bodies = (smallAgiRuinForest().find((e) => (e.match as { view?: string }).view === "default")!.result as { results: { _id: string }[] }).results;
    const h = H([gqlEntry({ root: "comments", view: "default" }, { results: bodies.filter((r) => r._id !== "replyPaul00000001") }, "§8.7"), ...smallAgiRuinForest()]);
    const notFound = 'Error (not_found): No publicly visible comment has the id "replyPaul00000001".';
    expect((await h.call("get_comments", { comment: "replyPaul00000001" })).text).toBe(notFound);
    const n = h.forum.requests.length;
    expect((await h.call("get_comments", { comment: "replyPaul00000001" })).text).toBe(notFound);
    expect(h.forum.requests.length).toBe(n);
  });

  // P14: a root-less orphan (its parent and its root both missing) is its own thread; the match item names that thread's root,
  // which is the orphan itself, and says its parent is not publicly visible, never printing either missing id.
  it("P14 match on a root-less orphan prints neither its missing parent's nor its missing root's id", async () => {
    const g = "R5g8YT25G9DXJJ48n";
    const h = H(forestEntries({ post: g }, [
      rawCommentTree({ _id: "keptRoot000000001", postId: g, af: false, baseScore: 9, extendedScore: null, contents: { wordCount: 3, markdown: "A kept root." } }),
      rawCommentTree({ _id: "rootlessOrphan001", postId: g, af: false, parentCommentId: "PLANTEDparent0001", topLevelCommentId: "PLANTEDroot000001",
        baseScore: 4, extendedScore: null, contents: { wordCount: 4, markdown: "A rootless orphaned remark." } }),
    ]));
    const out = (await h.call("get_comments", { post: g, match: "orphaned" })).text;
    expect(out).toContain('1 of 2 comments contain "orphaned".');
    expect(out).toContain("thread root: comment_id rootlessOrphan001");
    expect(out).toContain("parent comment not publicly visible");
    expect(out).not.toContain("PLANTED");
    expectClean(h);
  });

  // A comment target from the resolution cache (kept 30 minutes) that the discussion read for this call does not list is read
  // again before anything of it is shown (P2, P5, P6): hidden now, it is `not_found`.
  it("D1 P2 P5 a cached comment target its discussion no longer lists is read again; privately deleted since, it reads like an unknown id", async () => {
    const g = GLM_REF._id;
    const root = rawCommentTree({ _id: "keptRoot000000001", postId: g, af: false, extendedScore: null, contents: { wordCount: 3, markdown: "A kept root." } });
    const gone = rawCommentTree({ _id: "nowDeletedCmnt001", postId: g, af: false, parentCommentId: root._id, topLevelCommentId: root._id,
      extendedScore: null, contents: { wordCount: 5, markdown: "Words its author deleted since." } });
    const h = H([gqlEntry({ root: "comment", id: gone._id }, { result: rawCommentList({ ...gone, post: GLM_REF, tag: null, parentComment: rawCommentRef({ _id: root._id, postId: g }) }) }, "§8.2"),
      ...forestEntries({ post: g }, [root, gone])]);
    // (1) The comment is resolved (kept 30 minutes) and its discussion read (kept 10 minutes).
    expect((await h.call("get_comments", { comment: gone._id })).text).toContain("deleted since");
    // (2) Its author deletes it privately; (3) 11 minutes on, the discussion is read again without it, and so is the comment.
    h.clock.advance(11 * 60_000);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [root] }, a: { results: [] } } }) });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes('comment(selector: {_id: \\"nowDeletedCmnt001\\"}'), body: JSON.stringify({ data: { c: { result: null } } }) });
    const n = h.forum.requests.length;
    const notFound = 'Error (not_found): No publicly visible comment has the id "nowDeletedCmnt001".';
    expect((await h.call("get_comments", { comment: gone._id })).text).toBe(notFound);
    expect(h.forum.requests.length - n).toBe(2); // the discussion, then the comment read again
    expect(h.forum.requests.at(-1)!.body).toContain('comment(selector: {_id: \\"nowDeletedCmnt001\\"}');
    // Remembered (¶2.3): the next call answers from the negative cache.
    expect((await h.call("get_comments", { comment: gone._id })).text).toBe(notFound);
    expect(h.forum.requests.length - n).toBe(2);
    expectClean(h);
  });
  it("¶2.3 a cached comment target its discussion does not list, still public when read again, is shown alone, saying why", async () => {
    const p = "uMQ3cqWDPHhjtiesc";
    const late = rawCommentTree({ _id: "lateReply00000001", postId: p, af: false, parentCommentId: "rootAnn0000000001", topLevelCommentId: "rootAnn0000000001",
      postedAt: "2022-07-01T00:00:00.000Z", extendedScore: null, contents: { wordCount: 3, markdown: "A late reply." } });
    const doc = rawCommentList({ ...late, post: rawPostRef(), tag: null, parentComment: rawCommentRef({ _id: "rootAnn0000000001" }) });
    const h = H([gqlEntry({ root: "comment", id: late._id }, { result: doc }, "§8.2"), ...smallAgiRuinForest()]);
    await h.call("get_comments", { post: p });
    rememberResolution("comment", late._id, resolvedFrom("comment", doc), h.services);
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { comment: late._id })).text;
    expect(h.forum.requests.length - n).toBe(1); // the comment read again; the discussion comes from the cache
    expect(out).toContain("This comment is not in its discussion as read by this server, which keeps a discussion for up to 10 minutes, so it is shown alone.");
    expect(out).toContain("> A late reply.");
    expectClean(h);
  });
  it("D1 a cached comment target given by its LW1 address is read again by that address; hidden since, both of its keys are forgotten", async () => {
    const lw1 = "lw1Post0000000016";
    const other = rawCommentTree({ _id: "lw1OtherCmnt00001", postId: lw1, af: false, extendedScore: null, contents: { wordCount: 3, markdown: "Another LW1 comment." } });
    const old = rawCommentTree({ _id: "KXduPDa5T9qJfs4vL", postId: lw1, af: false, extendedScore: null, postedAt: "2009-03-01T00:00:00.000Z", contents: { wordCount: 4, markdown: "An old LW1 remark." } });
    const h = H(forestEntries({ post: lw1 }, [other, old]));
    const url = "https://www.lesswrong.com/lw/g/some_title/109";
    // (1) Resolved by its LW1 address (cached under it and under its id), its discussion read; (2) then hidden.
    expect((await h.call("get_comments", { comment: url })).text).toContain("comment_id KXduPDa5T9qJfs4vL");
    h.clock.advance(11 * 60_000);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [other] }, a: { results: [] } } }) });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("legacyIdComment"), body: JSON.stringify({ data: { c: { results: [] } } }) });
    const out = (await h.call("get_comments", { comment: url })).text;
    expect(out).toMatch(/^Error \(not_found\)/);
    expect(out).not.toContain("KXduPDa5T9qJfs4vL");
    expect(h.services.caches.get("resolve", "comment:KXduPDa5T9qJfs4vL")).toBeUndefined();
    expect(h.services.caches.get("resolve", "comment:legacy:109")).toBeUndefined();
    const n = h.forum.requests.length;
    expect((await h.call("get_comments", { comment: url })).text).toBe(out);
    expect(h.forum.requests.length).toBe(n);
    expectClean(h);
  });

  // ¶4.4 (its `comment` + `user` rule wins over its rule that `user` filters threads first): with `comment`, the comment chooses
  // the thread, so `user` only limits the reply map; when the person did not write in that thread, the rank counts every thread
  // and the map is one line saying it is empty.
  it("comment + user: the comment's thread is shown with ◆ even when the person did not write in it; the reply map says so", async () => {
    const out = (await H().call("get_comments", { comment: "rootBob0000000001", user: "paulfchristiano" })).text;
    expect(out).toMatch(/◆ T1 · .*comment_id rootBob0000000001/);
    expect(out).toContain("thread 3 of 3 by top");
    expect(out).toContain('No comments by "paulfchristiano" (user_slug paulfchristiano) in this thread; the reply map is empty.');
    expect(out).not.toContain("Most active commenters");
    expect(out).not.toContain("No threads match");
    expect(out).not.toContain("Reply map for");
  });

  // The `↑` chain of a lead, and of a comment target's first item, is held to a quarter of the page, so ◆ is on page 1 and every
  // continuation shows part of a comment; a cursor never names its own page.
  it("a 40-deep reply chain at max_tokens 2000: comment= shows ◆ on page 1, and the cursor reaches the end, every comment once", async () => {
    const rows = deepChain(40);
    const target = rows[39];
    const h = H([gqlEntry({ root: "comment", id: target._id }, { result: rawCommentList({ ...target, post: GLM_REF, tag: null, parentComment: rawCommentRef({ _id: rows[38]._id, postId: GLM_REF._id }) }) }, "§8.12"),
      ...forestEntries({ post: GLM_REF._id }, rows)]);
    const pages = [(await h.call("get_comments", { comment: target._id, max_tokens: 2000 })).text];
    for (let c = cursorOf(pages[0]); c && pages.length < 60; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, max_tokens: 2000 })).text);
    expect(pages[0]).toMatch(/▶ ◆ .*comment_id deepChain00000039/);
    expect(pages[0]).toContain("  ↑ T1 · ");
    expect(pages[0]).toMatch(/ {2}↑ … \d+ more ancestors\n/);
    expect(pages.at(-1)).toContain("End of results.");
    const seen = pages.flatMap(replyIds);
    for (const r of rows) expect(seen.filter((id) => id === r._id), r._id).toHaveLength(1);
    expect(pages.join("\n").match(/◆/g)).toHaveLength(1);
    expectClean(h);
  });
  it("a target cut under its bounded chain resumes exactly where it stopped, even when the continuation's max_tokens differs", async () => {
    const rows = deepChain(40);
    const words = Array.from({ length: 1500 }, (_, j) => `w${j}`).join(" ");
    rows[39] = { ...rows[39], contents: { wordCount: 1500, markdown: words } };
    const target = rows[39];
    const h = H([gqlEntry({ root: "comment", id: target._id }, { result: rawCommentList({ ...target, post: GLM_REF, tag: null, parentComment: rawCommentRef({ _id: rows[38]._id, postId: GLM_REF._id }) }) }, "§8.12"),
      ...forestEntries({ post: GLM_REF._id }, rows)]);
    const p1 = (await h.call("get_comments", { comment: target._id, max_tokens: 2000 })).text;
    expect(p1).toMatch(/▶ ◆ .*comment_id deepChain00000039/);
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)! })).text; // at the default max_tokens: a larger chain allowance
    const numbers = (p: string) => [...p.matchAll(/\bw(\d+)\b/g)].map((m) => Number(m[1]));
    expect([...numbers(p1), ...numbers(p2)]).toEqual(Array.from({ length: 1500 }, (_, j) => j));
    expectClean(h);
  });
  it("a 40-deep reply chain at max_tokens 2000: the discussion pages to its end, every comment once, under bounded leads", async () => {
    const rows = deepChain(40);
    const h = H(forestEntries({ post: GLM_REF._id }, rows));
    const pages = [(await h.call("get_comments", { post: GLM_REF._id, max_tokens: 2000 })).text];
    for (let c = cursorOf(pages[0]); c && pages.length < 60; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, max_tokens: 2000 })).text);
    expect(pages.at(-1)).toContain("End of results.");
    const seen = pages.flatMap(replyIds);
    for (const r of rows) expect(seen.filter((id) => id === r._id), r._id).toHaveLength(1);
    expect(pages.some((p) => / {2}↑ … \d+ more ancestors\n/.test(p))).toBe(true);
    expectClean(h);
  });
});
