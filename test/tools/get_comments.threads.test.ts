import { describe, it, expect } from "vitest";
import { subjectOps } from "../../src/forum/templates/get_comments";
import { createCallContext } from "../../src/call/context";
import { resolve, resolvedFrom } from "../../src/ids/resolve";
import { CAVEAT } from "../../src/render/messages";
import { NO_VOTE_DATA_LINE, NO_SIGNALS_LINE } from "../../src/domain/threads";
import { createHarness, expectClean } from "../support/harness";
import { smallAgiRuinForest, forestEntries, rawCommentTree, rawUserRef, deepThread30, gqlEntry, glmComments as glm, rawPostRef, rawPostCard } from "../support/builders";
import { loadForest } from "../../src/tools/loaders";
import { estimateTokens } from "../../src/render/budget";
import type { FixtureEntry } from "../support/fixtures";
import type { ParsedRef, RawCommentTree } from "../../src/types";

const FAMS = ["posts", "comments", "joins", "users", "tags"] as const;
const H = (extra: FixtureEntry[] = smallAgiRuinForest()) => createHarness({ families: FAMS, extra });
const ref = (kind: ParsedRef["kind"], form: ParsedRef["form"], value: string): ParsedRef => ({ kind, form, value, given: form === "slug" ? "slug" : "id", notes: [] });
const GLM = "R5g8YT25G9DXJJ48n";
const cursorOf = (text: string) => /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(text)?.[1];
const replyIds = (text: string) => text.split("\n").filter((l) => l.startsWith("▶ ")).map((l) => /comment_id (\w{17})/.exec(l)![1]);
const agiForestRows = () => (smallAgiRuinForest().find((e) => (e.match as { view?: string }).view === "postCommentsOld")!.result as { results: RawCommentTree[] }).results;
const agiBodyRows = () => (smallAgiRuinForest().find((e) => (e.match as { view?: string }).view === "default")!.result as { results: RawCommentTree[] }).results;
/** Every page of a call; each continuation repeats max_tokens, since a cursor alone continues at the default size (as in get_post). */
async function allPages(h: ReturnType<typeof H>, args: Record<string, unknown>): Promise<string[]> {
  const pages = [(await h.call("get_comments", args)).text];
  const size = args.max_tokens === undefined ? {} : { max_tokens: args.max_tokens };
  for (let c = cursorOf(pages[0]); c && pages.length < 40; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, ...size })).text);
  return pages;
}
/** The pages that follow `page`, each continuation at `max_tokens`. */
async function pagesAfter(h: ReturnType<typeof H>, page: string, max_tokens: number): Promise<string[]> {
  const pages: string[] = [];
  for (let c = cursorOf(page); c && pages.length < 40; c = cursorOf(pages.at(-1)!)) pages.push((await h.call("get_comments", { cursor: c, max_tokens })).text);
  return pages;
}
const chainId = (i: number) => `glmChain${String(i).padStart(9, "0")}`;
/** The thread header lines (`## …`) of some pages, the repeated `(continued)` ones left out. */
const headerLines = (pages: string[]) => pages.flatMap((p) => p.split("\n")).filter((l) => l.startsWith("## ") && !l.endsWith(" (continued)"));
/** A one-comment thread on the GLM post. */
const loneRoot = (_id: string, baseScore: number, postedAt: string) =>
  rawCommentTree({ _id, postId: GLM, af: false, baseScore, voteCount: 5, extendedScore: null, postedAt, contents: { wordCount: 3, markdown: `Root ${_id}.` } });
/** Every comment of deepThread30 (and `extra`) shown exactly once over `pages`, its root's header once. */
function expectDeepThreadOnce(pages: string[], extra: string[] = []): void {
  const seen = pages.flatMap(replyIds);
  for (const id of [...Array.from({ length: 29 }, (_, i) => chainId(i + 1)), ...extra]) expect(seen.filter((x) => x === id), id).toHaveLength(1);
  expect(headerLines(pages).filter((l) => l.includes(`comment_id ${chainId(0)}`))).toHaveLength(1);
}

describe("get_comments: threads", () => {
  it("get_comments_subject: exact text of the subject aliases", () => {
    expect(subjectOps({ post: ref("post", "id", "uMQ3cqWDPHhjtiesc") }).map((o) => o.text)).toEqual([
      'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_CARD hideCommentKarma } }']);
    expect(subjectOps({ tag: ref("tag", "id", "56yXXrcxRjrQs6z9R") })[0].text).toBe('t: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_CARD } }');
    expect(subjectOps({ comment: ref("comment", "id", "HRDoDnHv8bvoW7oPZ") })[0].text).toBe('c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_LIST } }');
    // The person's display name is read too, so the empty-user message can name them; the karma too, so the ¶3.7 echo of every
    // later tool that finds the person in the resolution cache shows it.
    expect(subjectOps({ user: ref("user", "slug", "paulfchristiano") })[0].text).toBe('u: GetUserBySlug(slug: "paulfchristiano") { _id slug displayName karma }');
  });
  it("¶3.7 the person's echo carries their karma here, and in a later tool that finds them in the resolution cache", async () => {
    const noComments = gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: "nmk3nLpQE89dMRzzN", sortBy: "new" } }, { results: [], totalCount: 0 }, "§9.4");
    const h = H([...smallAgiRuinForest(), noComments]);
    const first = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", user: "eliezer_yudkowsky" })).text;
    expect(first).toContain('user → "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky, user_id nmk3nLpQE89dMRzzN, karma 170,469)');
    const n = h.forum.requests.length;
    const later = (await h.call("list_comments", { user: "eliezer_yudkowsky" })).text;
    expect(later).toContain('user → "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky, user_id nmk3nLpQE89dMRzzN, karma 170,469)');
    expect(h.forum.requests.slice(n).some((r) => r.body.includes("GetUserBySlug"))).toBe(false);
  });
  it("get_comments_subject: each form reads through the bare aliases ids/resolve reads", () => {
    const aliases = (target: Parameters<typeof subjectOps>[0]) => subjectOps(target).map((o) => o.alias);
    expect(aliases({ post: ref("post", "idOrSlug", "uMQ3cqWDPHhjtiesc") })).toEqual(["p", "s"]);
    expect(aliases({ post: ref("post", "slug", "agi-ruin-a-list-of-lethalities") })).toEqual(["s"]);
    expect(aliases({ post: ref("post", "legacy", "2bz") })).toEqual(["l"]);
    expect(aliases({ tag: ref("tag", "idOrSlug", "56yXXrcxRjrQs6z9R") })).toEqual(["t", "m", "a", "b"]);
    expect(aliases({ tag: ref("tag", "slug", "ai") })).toEqual(["a", "b"]);
    expect(aliases({ comment: ref("comment", "legacy", "109") })).toEqual(["c"]);
    expect(aliases({ user: ref("user", "idOrSlug", "paulfchristianoId") })).toEqual(["i", "u"]);
    expect(aliases({ post: ref("post", "id", "uMQ3cqWDPHhjtiesc"), user: ref("user", "id", "paulfchristianoId") })).toEqual(["p", "i"]);
    expect(subjectOps({ tag: ref("tag", "slug", "ai") })[1].text)
      .toBe('b: TagPreview(slug: "ai") { tag { ...TAG_CARD } lens { ...MDOC_REF } summaries { _id deleted tabTitle } }');
  });

  it("Q14 Q50.3 Q50.18 ¶5b example 1: whole threads ranked locally by root karma; counts from the tree; 3 requests cold", async () => {
    const h = H(); const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })).text;
    expect(h.forum.requests).toHaveLength(3);
    expect(h.forum.requests[1].body).toContain("postCommentsOld");
    expect(h.forum.requests[1].body).toContain("answersAndReplies");
    expect(out).toContain("Position: threads 1–3 of 3");
    expect(out).toContain('Post: AF (AF karma 156) · https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities · comments not on AF are marked "not on AF"');
    expect(out).toContain("Counted: 6 publicly visible comments in 3 threads, 4 people (site counter ~717)");
    const t1 = out.indexOf('## T1 · root by "paulfchristiano" (user_slug paulfchristiano) · comment_id rootPaul000000001 · karma 299');
    const t2 = out.indexOf('## T2 · root by "Ann" (user_slug ann) · comment_id rootAnn0000000001');
    const t3 = out.indexOf('## T3 · root by "Bob" (user_slug bob) · comment_id rootBob0000000001');
    expect(t1).toBeGreaterThan(0); expect(t2).toBeGreaterThan(t1); expect(t3).toBeGreaterThan(t2);
    expect(out).toMatch(/▶ T1\.1 · "Carol" \(user_slug carol\) .*not on AF.*comment_id replyC00000000001/);
    expect(out).toContain("> Carol's reply.");
    for (const c of ["C-COUNTER", "C-KARMA", "C-LABELS"] as const) expect(out).toContain(CAVEAT[c]);
    expect(out).toContain("Marked as crux: T1 (comment_id rootPaul000000001, crux 1, AF karma 87)");
    expectClean(h);
  });
  it("Q52 P14 an orphan stays under its root, flagged, without the missing parent's id", async () => {
    const out = (await H().call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })).text;
    expect(out).toContain("parent comment not publicly visible");
    expect(out).not.toContain("privDeletedCmnt01");
  });
  it("Q110 P5 a reply to a debate turn is its own thread, flagged with the turn's author; a placeholder turn names nobody", async () => {
    const D = "qbcuk8WwFnTZcXTd6";
    const h = H(forestEntries({ post: D }, [
      rawCommentTree({ _id: "turnReply00000001", postId: D, af: false, extendedScore: null, parentCommentId: "kwaTurn0000000001", topLevelCommentId: "kwaTurn0000000001" }),
      rawCommentTree({ _id: "turnReply00000002", postId: D, af: false, extendedScore: null, parentCommentId: "kwaTurn0000000002", topLevelCommentId: "kwaTurn0000000002", postedAt: "2023-09-07T00:00:00.000Z" }),
    ]));
    const out = (await h.call("get_comments", { post: D })).text;
    expect(h.forum.requests[1].body).toContain("debateResponses");
    expect(out).toContain("Position: threads 1–2 of 2");
    expect(out).toMatch(/reply to a debate turn by "Thomas Kwa" · comment_id turnReply00000001/);
    expect(out).toMatch(/reply to a debate turn by "comment placeholder" · comment_id turnReply00000002/);
    expect(out).not.toContain("PLANTED");
    expectClean(h);
  });
  it("one forest serves every sort: a warm call sends nothing", async () => {
    const h = H(); await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" });
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", sort: "contested" })).text;
    expect(h.forum.requests).toHaveLength(3);
    expect(out).toContain('## T1 · root by "Bob"');
    expect(out).toContain("Disagreement signals:");
    expect(out).toMatch(/  - T1 · "Bob" \(user_slug bob\) · comment_id rootBob0000000001 .*disagree 3/);
  });
  it("D2 af_only keeps threads with an AF comment whole, never reorders, counts AF comments", async () => {
    const out = (await H().call("get_comments", { post: "uMQ3cqWDPHhjtiesc", af_only: true })).text;
    expect(out).toContain("Position: threads 1–2 of 2");
    expect(out).not.toContain("rootBob0000000001");
    expect(out).toContain("comment_id replyC00000000001"); // non-AF reply kept inside an AF thread
    expect(out).toContain("AF only: 3 AF comments counted in 2 threads kept whole (site counter ~145 AF comments)");
  });
  it("af_only with no AF comment is the filtered-list template", async () => {
    const h = H(forestEntries({ post: "R5g8YT25G9DXJJ48n" }, glm(2)));
    expect((await h.call("get_comments", { post: "R5g8YT25G9DXJJ48n", af_only: true })).text)
      .toContain("No threads match: AF only (no comment in this discussion is on the Alignment Forum; site counter ~0 AF comments).");
  });
  it("¶3.8.6 the no-data lines", async () => {
    const out = (await H(forestEntries({ post: "R5g8YT25G9DXJJ48n" }, glm(2))).call("get_comments", { post: "R5g8YT25G9DXJJ48n", sort: "contested" })).text;
    expect(out).toContain(NO_VOTE_DATA_LINE);
    expect(out).toContain(NO_SIGNALS_LINE);
  });
  it("Q54 answers are always fetched and answer threads come first", async () => {
    const q = "22xf8GmwqGzHbiuLg";
    const h = H(forestEntries({ post: q }, [rawCommentTree({ _id: "qComment000000001", postId: q, baseScore: 90 })],
      [rawCommentTree({ _id: "qAnswer0000000001", postId: q, answer: true, baseScore: 5 }),
       rawCommentTree({ _id: "qAnswerReply00001", postId: q, parentCommentId: "qAnswer0000000001", topLevelCommentId: "qAnswer0000000001" })]));
    const out = (await h.call("get_comments", { post: q })).text;
    expect(out.indexOf("## A1 · ")).toBeGreaterThan(0);
    expect(out.indexOf("## A1 · ")).toBeLessThan(out.indexOf("## T1 · "));
  });
  it("the 5,000-row note", async () => {
    expect((await H(forestEntries({ post: "R5g8YT25G9DXJJ48n" }, glm(5000))).call("get_comments", { post: "R5g8YT25G9DXJJ48n" })).text)
      .toContain("This discussion has more than 5,000 comments; only the oldest 5,000 are used");
  });
  it("phase B: above 400 KB only this page's bodies and the signal quotes are fetched", async () => {
    const big = smallAgiRuinForest().map((e) => JSON.parse(JSON.stringify(e).replace('"wordCount":40', '"wordCount":70000')) as FixtureEntry);
    const h = H(big); await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 });
    const bodies = h.forum.requests[2].body;
    expect(bodies).toContain("rootPaul000000001");
    expect(bodies).toContain("rootBob0000000001"); // quoted in the signals block
    expect(bodies).not.toContain("rootAnn0000000001");
  });
  it("¶2.3 bodies fetched later are kept in the forest's entry, which keeps the expiry its rows had", async () => {
    const big = smallAgiRuinForest().map((e) => JSON.parse(JSON.stringify(e).replace('"wordCount":40', '"wordCount":70000')) as FixtureEntry);
    const h = H(big);
    const p1 = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 })).text;
    expect(p1).not.toContain("replyC00000000001"); // its body was not fetched: the page ends before it
    h.clock.advance(300_000);
    const n = h.forum.requests.length;
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)! })).text;
    expect(h.forum.requests.length - n).toBe(1);
    expect(p2).toContain("> Carol's reply.");
    const entry = h.services.caches.get<{ bodies: Record<string, string> }>("forest", "post:uMQ3cqWDPHhjtiesc")!;
    expect(Object.keys(entry.bodies)).toContain("replyC00000000001");
    h.clock.advance(300_001); // ten minutes after the rows were fetched, not after the bodies
    expect(h.services.caches.get("forest", "post:uMQ3cqWDPHhjtiesc")).toBeUndefined();
  });
  it("paging: a list cursor over threads; the outline lists the threads not shown; the continuation needs no request", async () => {
    const h = H(); const p1 = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 })).text;
    expect(p1).toContain("Position: threads 1–1 of 3");
    expect(p1).toContain("Other threads (by top):");
    expect(p1).toContain('T2 · "Ann" (user_slug ann) · comment_id rootAnn0000000001');
    const m = /More available: call get_comments with cursor "(c_[A-Za-z0-9_-]{22})" \(next: threads 2–2\)\.$/.exec(p1)!;
    const n = h.forum.requests.length;
    const p2 = (await h.call("get_comments", { cursor: m[1] })).text;
    expect(p2).toContain('## T2 · root by "Ann"');
    expect(p2).not.toContain("## T1 ·");
    expect(h.forum.requests.length).toBe(n); // subject from the resolution cache, forest and bodies from the forest cache
  });
  it("¶3.7 Position counts threads: a page of one single-comment thread among several keeps it; only a discussion of one single-comment thread has none; one thread of several comments has it, shown whole or in parts", async () => {
    const positionOf = (page: string) => page.split("\n").find((l) => l.startsWith("Position: "));
    // The golden `get_comments page 2`: with limit 1, the second page is Ann's one-comment thread.
    const pages = await allPages(H(), { post: "uMQ3cqWDPHhjtiesc", limit: 1 });
    expect(pages[1]).toContain('## T2 · root by "Ann"');
    expect(pages.map(positionOf)).toEqual(["Position: threads 1–1 of 3", "Position: threads 2–2 of 3", "Position: threads 3–3 of 3"]);
    // A discussion of one comment: the reply is one item shown whole.
    const single = (await H(forestEntries({ post: GLM }, [loneRoot("loneThreadRoot001", 7, "2025-01-01T00:00:00.000Z")])).call("get_comments", { post: GLM })).text;
    expect(single).toContain("comment_id loneThreadRoot001");
    expect(positionOf(single)).toBeUndefined();
    // A discussion of one thread of two comments, shown whole: the page lists both, so it keeps `threads 1–1 of 1`.
    const reply = rawCommentTree({ _id: "loneThreadReply01", postId: GLM, af: false, parentCommentId: "loneThreadRoot001", topLevelCommentId: "loneThreadRoot001",
      baseScore: 2, voteCount: 1, extendedScore: null, postedAt: "2025-01-02T00:00:00.000Z", contents: { wordCount: 2, markdown: "A reply." } });
    const whole = (await H(forestEntries({ post: GLM }, [loneRoot("loneThreadRoot001", 7, "2025-01-01T00:00:00.000Z"), reply])).call("get_comments", { post: GLM })).text;
    expect(whole).toContain("comment_id loneThreadReply01");
    expect(whole).toContain("End of results.");
    expect(positionOf(whole)).toBe("Position: threads 1–1 of 1");
    // ¶5b example 2: the user filter leaves T1 alone (three comments, all shown), which keeps its Position.
    const paul = (await H().call("get_comments", { post: "uMQ3cqWDPHhjtiesc", user: "paulfchristiano" })).text;
    expect(paul).toContain("comment_id replyPaul00000001");
    expect(paul).not.toContain("## T2");
    expect(positionOf(paul)).toBe("Position: threads 1–1 of 1");
    // One thread larger than a page: no page shows it whole, so every page says where it is.
    const parts = await allPages(H(forestEntries({ post: GLM }, deepThread30())), { post: GLM, max_tokens: 2000 });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.split("\n")[2]).toBe("Position: threads 1–1 of 1");
    // A page that resumes inside the only thread and shows its one remaining comment whole is still a part of that thread.
    const words = Array.from({ length: 600 }, (_, j) => `w${j % 10}`).join(" ");
    const halves = [
      rawCommentTree({ _id: "halfThreadRoot001", postId: GLM, af: false, baseScore: 7, voteCount: 5, extendedScore: null, postedAt: "2025-01-01T00:00:00.000Z", contents: { wordCount: 600, markdown: words } }),
      rawCommentTree({ _id: "halfThreadReply01", postId: GLM, af: false, parentCommentId: "halfThreadRoot001", topLevelCommentId: "halfThreadRoot001",
        baseScore: 2, voteCount: 1, extendedScore: null, postedAt: "2025-01-02T00:00:00.000Z", contents: { wordCount: 600, markdown: words } }),
    ];
    const two = await allPages(H(forestEntries({ post: GLM }, halves)), { post: GLM, max_tokens: 2000 });
    expect(two.map(replyIds)).toEqual([["halfThreadRoot001"], ["halfThreadReply01"]]);
    expect(two[1]).toContain("(continued)");
    expect(two[1]).toContain("End of results.");
    expect(two.map(positionOf)).toEqual(["Position: threads 1–1 of 1", "Position: threads 1–1 of 1"]);
  });

  it("a wiki page's discussion", async () => {
    const h = H(forestEntries({ tag: "sYm3HiWcfZvrGu3ui" }, [rawCommentTree({ _id: "wikiDiscussCmnt01", tagId: "sYm3HiWcfZvrGu3ui", postId: null })]));
    const out = (await h.call("get_comments", { tag: "ai" })).text;
    // ¶3.5: a wiki page has no AF status, so its header says how its unmarked comments read, as a non-AF post's does.
    expect(out).toContain('Wiki page: "AI" (tag_slug ai) · https://www.lesswrong.com/w/ai · comments without an AF mark are not on AF');
    expect(h.forum.requests[1].body).toContain("tagDiscussionComments");
  });
  it("P17 the forest is never requested for a post that is not publicly visible", async () => {
    const h = H(); const out = (await h.call("get_comments", { post: "draftPost00000001" })).text;
    expect(out).toMatch(/^Error \(not_public\): /);
    expect(h.forum.requests.some((r) => r.body.includes("postCommentsOld"))).toBe(false);
  });
  it("Q105 P18 hidden comment karma prints 'karma not publicly visible', never 0", async () => {
    const out = (await H(forestEntries({ post: "hiddenKarmaPost01" }, glm(2, { postId: "hiddenKarmaPost01", baseScore: null, afBaseScore: null, hideKarma: true })))
      .call("get_comments", { post: "hiddenKarmaPost01" })).text;
    expect(out).toContain("karma not publicly visible");
    expect(out).not.toMatch(/karma 0\b/);
    expect(out).toContain("No thread root's karma is publicly visible here, so threads are ranked by date.");
    // ¶3.8.6: the author hid the scores; the no-vote-data line would blame the discussion's age for it.
    expect(out).not.toContain(NO_VOTE_DATA_LINE);
    expect(out).not.toContain(NO_SIGNALS_LINE);
  });
  it("¶3.8.6 the Changed someone's mind line lists comments with a net changemind reaction", async () => {
    const out = (await H(forestEntries({ post: GLM }, [rawCommentTree({ _id: "mindChanged000001", postId: GLM, af: false, baseScore: 12, voteCount: 4,
      extendedScore: { reacts: { changemind: [{ userId: "reactorUser000001", displayName: "Reactor", karma: 50, reactType: "created" }] }, agreement: 0, agreementVoteCount: 0 } })])).call("get_comments", { post: GLM })).text;
    expect(out).toContain("Changed someone's mind: T1 (comment_id mindChanged000001, changemind 1)");
  });
  it("¶3.5 in an AF discussion a non-AF comment's signal, crux and mind-change lines carry not on AF; an AF comment's its AF karma", async () => {
    const agi = "uMQ3cqWDPHhjtiesc";
    const out = (await H().call("get_comments", { post: agi, sort: "contested" })).text;
    expect(out).toContain('  - T1 · "Bob" (user_slug bob) · comment_id rootBob0000000001 · karma 8 · not on AF · disagree 3 · > "Bob\'s contrarian take."');
    expect(out).toContain("Marked as crux: T2 (comment_id rootPaul000000001, crux 1, AF karma 87)");
    // A non-AF comment readers marked as a crux and as having changed a mind, on the AF post.
    const reactor = { userId: "reactorUser000001", displayName: "Reactor", karma: 50, reactType: "created" };
    const marked = rawCommentTree({ _id: "lwCruxOnAfPost001", postId: agi, af: false, baseScore: 12, voteCount: 4,
      extendedScore: { reacts: { crux: [reactor], changemind: [reactor] }, agreement: 0, agreementVoteCount: 0 } });
    const t = (await H(forestEntries({ post: agi }, [marked])).call("get_comments", { post: agi })).text;
    expect(t).toContain("Marked as crux: T1 (comment_id lwCruxOnAfPost001, crux 1, not on AF)");
    expect(t).toContain("Changed someone's mind: T1 (comment_id lwCruxOnAfPost001, changemind 1, not on AF)");
    // In a non-AF discussion the lines carry no mark (the header says comments without one are not on AF).
    const lw = (await H(forestEntries({ post: GLM }, [rawCommentTree({ ...marked, _id: "lwCruxOnLwPost001", postId: GLM })])).call("get_comments", { post: GLM })).text;
    expect(lw).toContain("Marked as crux: T1 (comment_id lwCruxOnLwPost001, crux 1)");
  });

  it("¶3.6 a cursor with the original arguments repeated (the post as a URL this time) continues; a different sort is refused", async () => {
    const h = H();
    const cursor = cursorOf((await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 })).text)!;
    expect((await h.call("get_comments", { post: "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin", sort: "top", limit: 1, cursor })).text)
      .toContain('## T2 · root by "Ann"');
    expect((await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", sort: "contested", cursor })).text).toBe(
      'Error (bad_input): this cursor was issued for different parameters (sort: cursor has "top", call has "contested"). Pass only the cursor to continue, or repeat the call without it to start over.',
    );
  });

  it("¶4.4 paging inside a thread larger than the page: header and ancestor chain repeated, every comment exactly once", async () => {
    const h = H(forestEntries({ post: GLM }, deepThread30()));
    const pages = await allPages(h, { post: GLM, max_tokens: 2000 });
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[1]).toContain("## T1 · root by");
    expect(pages[1]).toContain(" (continued)");
    expect(pages[1]).toMatch(/^  ↑ T1 · .* · comment_id glmChain000000000$/m);
    const seen = pages.flatMap(replyIds);
    for (let i = 1; i <= 29; i++) expect(seen.filter((id) => id === `glmChain${String(i).padStart(9, "0")}`)).toHaveLength(1);
    expect(pages.flatMap((p) => p.split("\n")).filter((l) => l.startsWith("## T1 · root by") && !l.endsWith(" (continued)"))).toHaveLength(1);
    for (const p of pages) expect(estimateTokens(p)).toBeLessThanOrEqual(1900);
  });

  it("¶3.7 rule 3 a 44 KB comment is cut and resumed on the next page", async () => {
    const body = Array.from({ length: 1700 }, (_, i) => `Sentence number ${i} is here.`).join(" ") + " Final sentence.";
    const h = H(forestEntries({ post: GLM }, [rawCommentTree({ _id: "glmHugeCmnt000001", postId: GLM, baseScore: 40, voteCount: 9, extendedScore: null, contents: { wordCount: 8500, markdown: body } })]));
    const p1 = (await h.call("get_comments", { post: GLM, max_tokens: 8000 })).text;
    expect(p1).toContain("[… continues: about ");
    expect(p1).not.toContain("Final sentence.");
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)! })).text;
    expect(p2).toContain(" (continued)");
    expect(p2).toContain("Final sentence.");
  });

  it("a page that ended inside a thread resumes after the last comment_id shown, even when a reply landed earlier in that thread", async () => {
    const rows = deepThread30();
    const early = rawCommentTree({ ...rows[1], _id: "glmChainEarly0001", parentCommentId: rows[0]._id, topLevelCommentId: rows[0]._id, postedAt: "2025-01-01T00:30:00.000Z" });
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [...rows, early] }, "§8.12");
    const h = H([bodies, ...forestEntries({ post: GLM }, rows)]);
    const p1 = (await h.call("get_comments", { post: GLM, max_tokens: 2000 })).text;
    const shown1 = replyIds(p1);
    h.clock.advance(600_001); // the forest expired; the re-fetched forest has a new reply before every shown one
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [...rows, early] }, a: { results: [] } } }) });
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)! })).text;
    const shown2 = replyIds(p2);
    expect(shown2.filter((id) => shown1.includes(id))).toEqual([]);
    const order = rows.slice(1).map((r) => r._id);
    expect(shown2[0]).toBe(order[order.indexOf(shown1.at(-1)!) + 1]);
  });

  // The cursor names the thread it resumes (threadId); a re-fetched forest that ranks threads differently never applies that
  // thread's place to another one, and never drops a thread ranked after the list's place.
  it("a thread re-ranked between the previous thread and the one a page ended inside is shown; that thread still resumes after its last comment_id", async () => {
    const rows = deepThread30();
    const top = loneRoot("topRoot0000000001", 50, "2024-12-01T00:00:00.000Z");
    const fresh = loneRoot("newRoot0000000001", 20, "2025-02-01T00:00:00.000Z");
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [top, ...rows, fresh] }, "§8.12");
    const h = H([bodies, ...forestEntries({ post: GLM }, [top, ...rows])]);
    const p1 = (await h.call("get_comments", { post: GLM, max_tokens: 2000 })).text;
    expect(headerLines([p1])[1]).toContain(`comment_id ${chainId(0)}`); // page 1 ended inside the deep thread, ranked second
    expect(replyIds(p1).length).toBeGreaterThan(0);
    h.clock.advance(600_001); // the forest expired; the new root ranks between the top root and the deep thread
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [top, ...rows, fresh] }, a: { results: [] } } }) });
    const later = await pagesAfter(h, p1, 2000);
    expect(later[0]).toContain("The list changed since the previous page (1 new item); positions may have shifted.");
    expect(later.slice(1).filter((p) => p.includes("The list changed"))).toEqual([]);
    expect(headerLines(later).filter((l) => l.includes("comment_id newRoot0000000001"))).toHaveLength(1);
    expect(headerLines(later).filter((l) => l.includes("comment_id topRoot0000000001"))).toHaveLength(0);
    expectDeepThreadOnce([p1, ...later]);
    expect(cursorOf(later.at(-1)!)).toBeUndefined();
  });
  it("a thread re-ranked before the thread a page ended inside, beyond this page's limit: the resume data waits in the cursor until a page begins with that thread", async () => {
    const rows = deepThread30();
    const fresh = loneRoot("newRoot0000000001", 20, "2025-02-01T00:00:00.000Z");
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [...rows, fresh] }, "§8.12");
    const h = H([bodies, ...forestEntries({ post: GLM }, rows)]);
    const p1 = (await h.call("get_comments", { post: GLM, max_tokens: 2000, limit: 1 })).text;
    expect(replyIds(p1).length).toBeGreaterThan(0);
    h.clock.advance(600_001);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [...rows, fresh] }, a: { results: [] } } }) });
    const later = await pagesAfter(h, p1, 2000);
    expect(headerLines([later[0]])).toEqual([expect.stringContaining("comment_id newRoot0000000001")]);
    expect(later[0].split("\n")[2]).toBe("Position: threads 1–1 of 2"); // one single-comment thread of two (¶3.7)
    expect(later[1]).toMatch(/^## T2 · root by .* · comment_id glmChain000000000 .* \(continued\)$/m);
    expectDeepThreadOnce([p1, ...later]);
  });
  it("sort active: the thread a page ended inside moves above the list's place after a new reply; it resumes after its last comment_id, then the list continues where it was", async () => {
    const rows = deepThread30();
    const busy = loneRoot("busyRoot000000001", 5, "2025-06-01T00:00:00.000Z");
    const quiet = loneRoot("quietRoot00000001", 5, "2024-01-01T00:00:00.000Z");
    const late = rawCommentTree({ ...rows[29], _id: "glmChainLate00001", parentCommentId: chainId(4), topLevelCommentId: chainId(0), postedAt: "2025-07-01T00:00:00.000Z" });
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [busy, quiet, ...rows, late] }, "§8.12");
    const h = H([bodies, ...forestEntries({ post: GLM }, [busy, quiet, ...rows])]);
    const p1 = (await h.call("get_comments", { post: GLM, sort: "active", max_tokens: 2000 })).text;
    expect(headerLines([p1]).map((l) => /comment_id (\w{17})/.exec(l)![1])).toEqual(["busyRoot000000001", chainId(0)]);
    h.clock.advance(600_001); // the deep thread's new reply is now the discussion's latest: it ranks first
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [busy, quiet, ...rows, late] }, a: { results: [] } } }) });
    const later = await pagesAfter(h, p1, 2000);
    expect(later[0]).toContain("The list changed since the previous page (0 new items); positions may have shifted.");
    expect(later[0]).toMatch(/^## T1 · root by .* · comment_id glmChain000000000 .* \(continued\)$/m);
    expect(later[0]).toMatch(/\(next: threads 1–1\)\.$/); // the next page holds that thread alone
    expect(later.slice(1).filter((p) => p.includes("The list changed"))).toEqual([]); // only the page that found the move says so
    expectDeepThreadOnce([p1, ...later], ["glmChainLate00001"]);
    expect(headerLines([p1, ...later]).filter((l) => l.includes("comment_id busyRoot000000001"))).toHaveLength(1);
    expect(headerLines(later).filter((l) => l.includes("comment_id quietRoot00000001"))).toHaveLength(1);
    expect(cursorOf(later.at(-1)!)).toBeUndefined();
  });

  it("a held thread whose list anchor is deleted meanwhile notes the change once; the later held pages keep the list's place and say nothing new", async () => {
    const rows = deepThread30();
    const busy = loneRoot("busyRoot000000001", 5, "2025-06-01T00:00:00.000Z");
    const quiet = loneRoot("quietRoot00000001", 5, "2024-01-01T00:00:00.000Z");
    const late = rawCommentTree({ ...rows[29], _id: "glmChainLate00001", parentCommentId: chainId(4), topLevelCommentId: chainId(0), postedAt: "2025-07-01T00:00:00.000Z" });
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [busy, quiet, ...rows, late] }, "§8.12");
    const h = H([bodies, ...forestEntries({ post: GLM }, [busy, quiet, ...rows])]);
    const forestAnswer = (comments: RawCommentTree[]) => JSON.stringify({ data: { c: { results: comments }, a: { results: [] } } });
    const p1 = (await h.call("get_comments", { post: GLM, sort: "active", max_tokens: 2000 })).text;
    expect(headerLines([p1]).map((l) => /comment_id (\w{17})/.exec(l)![1])).toEqual(["busyRoot000000001", chainId(0)]);
    // The deep thread's new reply ranks it first: page 2 holds it above the list's place (after busy) and notes the move.
    h.clock.advance(600_001);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: forestAnswer([busy, quiet, ...rows, late]) });
    const p2 = (await h.call("get_comments", { cursor: cursorOf(p1)!, max_tokens: 2000 })).text;
    expect(p2).toContain("The list changed since the previous page");
    expect(p2).toMatch(/\(next: threads 1–1\)\.$/);
    // Then busy, the thread the list's place is anchored after, is deleted: the next held page notes that change, once.
    h.clock.advance(600_001);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: forestAnswer([quiet, ...rows, late]) });
    const later = await pagesAfter(h, p2, 2000);
    expect(later.length).toBeGreaterThan(3);
    expect(later[0]).toContain("The list changed since the previous page");
    expect(later.slice(1).filter((p) => p.includes("The list changed"))).toEqual([]);
    expectDeepThreadOnce([p1, p2, ...later], ["glmChainLate00001"]);
    expect(later.at(-1)).toContain("End of results.");
  });

  it("¶2.3 ¶3.6 a continuation after the forest expired fetches it again, keeps its place and adds the drift note; a subject refused meanwhile is not_public", async () => {
    const dan = rawCommentTree({ _id: "rootDan0000000001", postId: "uMQ3cqWDPHhjtiesc", baseScore: 1, voteCount: 1, afBaseScore: 0, af: false, extendedScore: null,
      postedAt: "2022-06-25T00:00:00.000Z", userId: "danUserId00000001", user: rawUserRef({ _id: "danUserId00000001", slug: "dan", displayName: "Dan" }) });
    // The default view answers Dan's body too, so the re-fetched forest keeps him (D1).
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [...agiBodyRows(), { ...dan, contents: { wordCount: 2, markdown: "A late root comment." } }] }, "§8.2");
    const h = H([bodies, ...smallAgiRuinForest()]);
    const p1 = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 })).text;
    const cursor = cursorOf(p1)!;
    const n = h.forum.requests.length;
    h.clock.advance(600_001);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), body: JSON.stringify({ data: { c: { results: [...agiForestRows(), dan] }, a: { results: [] } } }) });
    const p2 = (await h.call("get_comments", { cursor })).text;
    expect(h.forum.requests.length - n).toBe(2); // the forest and the bodies; the subject comes from the 30-minute resolution cache
    expect(p2).toContain('## T2 · root by "Ann"');
    expect(p2).not.toContain("## T1 ·");
    expect(p2).toContain("The list changed since the previous page (1 new item); positions may have shifted.");
    h.clock.advance(31 * 60_000); // the resolution expired too
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("hideCommentKarma"), body: JSON.stringify({ data: { p: null }, errors: [{ message: "app.operation_not_allowed", path: ["p"] }] }) });
    const m = h.forum.requests.length;
    expect((await h.call("get_comments", { cursor })).text).toMatch(/^Error \(not_public\): /);
    expect(h.forum.requests.slice(m).some((r) => r.body.includes("postCommentsOld"))).toBe(false);
  });

  it("¶2.2 step 5 a slow forest: Stopped early with a cursor; the forest is cached and the continuation sends only the bodies", async () => {
    const h = H();
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("postCommentsOld"), delayMs: 41_000 });
    const p1 = await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" });
    expect(p1.isError).toBe(false);
    expect(p1.text.split("\n").at(-1)).toMatch(/^Stopped early \(time limit\); call get_comments with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    // The page holds the head lines the forest gives and no thread: no header, no body, nothing printed from a hit alone
    expect(p1.text).toMatch(/^Post: AF /m);
    expect(p1.text).toMatch(/^Counted: \d+ publicly visible comments/m);
    expect(p1.text).not.toMatch(/^(## |▶ |> )/m);
    expect(h.services.caches.get("forest", "post:uMQ3cqWDPHhjtiesc")).toBeDefined();
    const n = h.forum.requests.length;
    const p2 = await h.call("get_comments", { cursor: cursorOf(p1.text)! });
    expect(h.forum.requests.length - n).toBe(1);
    expect(h.forum.requests.at(-1)!.body).toContain("commentIds");
    expect(p2.text).toContain('## T1 · root by "paulfchristiano"');
  });

  it("D1 a comment the default view no longer returns is dropped; its reply is flagged and its id printed nowhere", async () => {
    const rows = [
      rawCommentTree({ _id: "keptRoot000000001", postId: GLM, baseScore: 30, voteCount: 5, extendedScore: null, contents: { wordCount: 2, markdown: "Kept root." } }),
      rawCommentTree({ _id: "PLANTEDgoneCmnt01", postId: GLM, parentCommentId: "keptRoot000000001", topLevelCommentId: "keptRoot000000001", baseScore: 5, extendedScore: null, contents: { wordCount: 2, markdown: "Gone." } }),
      rawCommentTree({ _id: "keptReply00000001", postId: GLM, parentCommentId: "PLANTEDgoneCmnt01", topLevelCommentId: "keptRoot000000001", baseScore: 3, extendedScore: null, contents: { wordCount: 2, markdown: "Kept reply." } }),
    ];
    const bodies = gqlEntry({ root: "comments", view: "default" }, { results: [rows[0], rows[2]] }, "§8.7");
    const out = (await H([bodies, ...forestEntries({ post: GLM }, rows)]).call("get_comments", { post: GLM })).text;
    expect(out).toContain("comment_id keptReply00000001");
    expect(out).toContain("parent comment not publicly visible");
    expect(out).not.toContain("PLANTEDgoneCmnt01");
    expect(out).toContain("Counted: 2 publicly visible comments");
  });

  // A subject resolved earlier with fewer fields (find, search, resolve's default selection) is completed by the request that
  // has to be sent anyway.
  it("a cached subject without the POST_CARD fields: the forest request reads them in its p alias, no extra request", async () => {
    const h = H();
    await resolve(ref("post", "id", "uMQ3cqWDPHhjtiesc"), "post", createCallContext("get_comments", { now: h.clock.now }), h.services);
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })).text;
    expect(h.forum.requests.length - n).toBe(2); // the forest (with p) and the bodies
    expect(h.forum.requests[n].body).toContain("postCommentsOld");
    expect(h.forum.requests[n].body).toContain('p: post(selector: {_id: \\"uMQ3cqWDPHhjtiesc\\"}, allowNull: true) { result { ...POST_CARD hideCommentKarma } }');
    expect(out).toContain("Counted: 6 publicly visible comments in 3 threads, 4 people (site counter ~717)");
    expectClean(h);
  });
  it("with the forest cached too, the post's header fields cost one request of their own", async () => {
    const h = H(); await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" });
    h.services.caches.set("resolve", "post:uMQ3cqWDPHhjtiesc", resolvedFrom("post", rawPostRef()));
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })).text;
    expect(h.forum.requests.length - n).toBe(1);
    expect(h.forum.requests[n].body).toContain("hideCommentKarma");
    expect(h.forum.requests[n].body).not.toContain("postCommentsOld");
    expect(out).toContain("Counted: 6 publicly visible comments in 3 threads, 4 people (site counter ~717)");
  });
  // A POST_CARD resolution (find, search) has the six header fields; its missing hideCommentKarma reads false (P18 holds
  // through the forum's null comment scores), so no companion request is sent.
  it("¶5b example 2: a POST_CARD resolution and a forest cached the way find caches them cost only the bodies request", async () => {
    const h = H();
    h.services.caches.set("resolve", "post:uMQ3cqWDPHhjtiesc", resolvedFrom("post", rawPostCard({
      _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities", af: true, afBaseScore: 156, commentCount: 717, afCommentCount: 145,
    })));
    const ctx = createCallContext("find", { now: h.clock.now });
    await loadForest({ kind: "post", id: ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc"), af: true, hideCommentKarma: false, debate: false }, ctx, h.services);
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })).text;
    expect(h.forum.requests.length - n).toBe(1);
    expect(h.forum.requests[n].body).toContain("commentIds");
    expect(h.forum.requests.some((r) => r.body.includes("hideCommentKarma"))).toBe(false);
    expect(out).toContain("Post: AF (AF karma 156)");
    expect(out).toContain("(site counter ~717)");
  });
  it("phase B under 400 KB: every body is fetched once and kept in the forest's cache entry", async () => {
    const h = H(); await h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", limit: 1 });
    const entry = h.services.caches.get<{ bodies: Record<string, string> }>("forest", "post:uMQ3cqWDPHhjtiesc")!;
    expect(Object.keys(entry.bodies).sort()).toEqual(
      ["orphanReply000001", "replyC00000000001", "replyPaul00000001", "rootAnn0000000001", "rootBob0000000001", "rootPaul000000001"]);
    expect(entry.bodies.rootPaul000000001).toBe("Paul's root comment about takeoff.");
  });
});
