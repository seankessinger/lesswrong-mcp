import { describe, it, expect } from "vitest";
import { tool } from "../../src/tools/get_reactions";
import { reactionItemOp, reactorIdsOp } from "../../src/forum/templates/get_reactions";
import { documentFor } from "../../src/forum/templates/op";
import { estimateTokens } from "../../src/render/budget";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { gqlEntry, manyReactionsEntries, rawMdocRef, rawPostFull, rawTagFull, rawTagRef, rawUserCard, rawUserRef, withExtra } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";

const h0 = () => createHarness({ families: ["posts", "comments", "tags", "users"], extra: manyReactionsEntries() });
const NOTE = "Notes: Reactor and liker names are as of the item's last vote.";
const AGI = '"AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)';

describe("get_reactions", () => {
  it("exactly one of post, comment and tag", () => {
    expect(tool.oneOf).toEqual([["post", "comment", "tag"]]);
  });

  it("get_reactions: the item and reactor templates, exact text; Tag.usersWhoLiked, allVotes and currentUserVote never selected", () => {
    const ops = [reactionItemOp("post", "uMQ3cqWDPHhjtiesc"), reactionItemOp("comment", "HRDoDnHv8bvoW7oPZ"),
      reactionItemOp("tag", "56yXXrcxRjrQs6z9R"), reactionItemOp("lens", "aaaaaaaaaaaaaaaaa"), reactorIdsOp(["nmk3nLpQE89dMRzzN"])!];
    expect(ops.map((o) => o.text)).toEqual([
      'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_REF baseScore voteCount afBaseScore afVoteCount extendedScore user { _id slug displayName } } }',
      'c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_REF baseScore voteCount afBaseScore afVoteCount extendedScore post { ...POST_REF } tag { ...TAG_REF } } }',
      't: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_REF baseScore voteCount extendedScore } }',
      'm: multiDocument(selector: {_id: "aaaaaaaaaaaaaaaaa"}) { result { ...MDOC_REF baseScore voteCount extendedScore } }',
      'ids: users(selector: {usersByUserIds: {userIds: ["nmk3nLpQE89dMRzzN"]}}, limit: 1) { results { _id slug displayName } }',
    ]);
    expect(documentFor("get_reactions", ops).startsWith("query get_reactions { " + ops.map((o) => o.text).join(" ") + " }")).toBe(true);
    expect(reactorIdsOp([])).toBeUndefined();
    for (const o of ops) expect(o.text).not.toMatch(/usersWhoLiked|allVotes|currentUserVote/);
  });

  it("Q76 Q50.11 P8 P11 L10 a comment: nets, reactors by snapshot name with user_slug, account not publicly visible, unnamed entries, quotes; 2 requests", async () => {
    const h = h0();
    const out = await h.call("get_reactions", { comment: "reactsCmnt0000001" });
    expect(out).toEqual({ isError: false, text: [
      "get_reactions — comment reactsCmnt0000001",
      `Request: comment → comment_id reactsCmnt0000001 (AF) by "paulfchristiano" (user_slug paulfchristiano) on ${AGI}`,
      NOTE,
      "karma 299 (120 votes) · AF karma 87 (40 AF votes) · agreement +45 (30 agreement votes)",
      "Reactions:",
      '  disagree 2 — added by "Alice" (user_slug alice); seconded by "Bob" (user_slug bob), account not publicly visible; disputed by "Carol" (user_slug carol) · on: "the first lethality"',
      '  typo 2 — added by 1 unnamed; seconded by "Carol" (user_slug carol)',
      '  crux 1 — added by "Carol" (user_slug carol) · on: "the crux sentence"',
      "End of results.",
    ].join("\n") });
    expect(h.forum.requests).toHaveLength(2);
    const texts = gqlTexts(h.forum);
    expect(texts[0]).toContain(reactionItemOp("comment", "reactsCmnt0000001").text);
    expect(texts[1]).toContain('ids: users(selector: {usersByUserIds: {userIds: ["aliceUserId000001", "bobUserId00000001", "danUserId00000001", "carolUserId000001"]}}, limit: 4)');
    for (const s of ["512", "Robert", "thanks", "PLANTED"]) expect(out.text).not.toContain(s);
    expectClean(h);
  });

  it("Q106 Q50.12 P11 a post: AF karma with AF votes, no agreement line; a net-0 reaction and its quote never shown; a slug costs one resolve request", async () => {
    const h = h0();
    const out = await h.call("get_reactions", { post: "a-post-readers-reacted-to" });
    expect(out.text).toBe([
      'get_reactions — post "A Post Readers Reacted To"',
      'Request: post → "A Post Readers Reacted To" (post_id reactsPost0000001) by "Eliezer Yudkowsky"',
      NOTE,
      "karma 104 (61 votes) · AF karma 40 (17 AF votes)",
      "Reactions:",
      '  insightful 1 — added by "Alice" (user_slug alice) · on: "the key claim"',
      "End of results.",
    ].join("\n"));
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toContain('userIds: ["aliceUserId000001"]}}, limit: 1)');
    expectClean(h);
  });

  it("¶7 a transient 502 on the slug resolution is retried without charging the cap; the call succeeds with 4 fetches", async () => {
    const h = h0();
    h.forum.inject({ status: 502, times: 1 });
    const out = await h.call("get_reactions", { post: "a-post-readers-reacted-to" });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain('  insightful 1 — added by "Alice" (user_slug alice) · on: "the key claim"');
    expect(h.forum.requests).toHaveLength(4);
  });

  it("Q50.46 L10 a wiki page: page score, likers from the page's own extendedScore.usersWhoLiked, never Tag.usersWhoLiked", async () => {
    const h = h0();
    const out = await h.call("get_reactions", { tag: "innerAlignTag0001" });
    expect(out.text).toBe([
      'get_reactions — wiki page "Inner Alignment"',
      'Request: tag → "Inner Alignment" (tag_slug inner-alignment, tag_id innerAlignTag0001)',
      NOTE,
      'page score 31 (23 votes) · likes 4: "Alice" (user_slug alice), "Bob" (user_slug bob), account not publicly visible, 1 unnamed',
      "Reactions:",
      '  important 1 — added by "Bob" (user_slug bob)',
      "End of results.",
    ].join("\n"));
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum).join("\n")).not.toContain("usersWhoLiked");
    expectClean(h);
  });

  it("Q50.46 a lens slug gives that lens's own score and likers, which differ from its page's (P12 page join); ¶3.1.2 the echo says the lens itself was opened, with its lens_slug", async () => {
    const h = h0();
    const out = await h.call("get_reactions", { tag: "inner-alignment-intro" });
    expect(out.text).not.toContain("→ page");
    expect(out.text).toBe([
      'get_reactions — lens "Introduction" of "Inner Alignment"',
      'Request: tag → "Inner Alignment" (tag_slug inner-alignment, tag_id innerAlignTag0001) · lens_slug inner-alignment-intro of page "Inner Alignment"',
      NOTE,
      'lens score 5 (3 votes) · likes 1: "Carol" (user_slug carol)',
      "Reactions: none.",
      "End of results.",
    ].join("\n"));
    expect(h.forum.requests).toHaveLength(3);
    expectClean(h);
  });

  it("a summary_id stands for its page: the page's reactions are read, and the echo keeps the page form", async () => {
    const h = h0();
    const out = await h.call("get_reactions", { tag: "innerAlignSumm001" });
    expect(out.text.split("\n").slice(0, 2)).toEqual([
      'get_reactions — wiki page "Inner Alignment"',
      'Request: tag → "Inner Alignment" (tag_slug inner-alignment, tag_id innerAlignTag0001) · summary_id innerAlignSumm001 → page "Inner Alignment"',
    ]);
    expect(out.text).toContain('page score 31 (23 votes) · likes 4: ');
    expect(h.forum.requests).toHaveLength(3);
    expectClean(h);
  });

  it("Q50.11 no votes from others and no reactions; no reactor request", async () => {
    const h = h0();
    expect((await h.call("get_reactions", { comment: "noVotesCmnt000001" })).text).toBe([
      "get_reactions — comment noVotesCmnt000001",
      `Request: comment → comment_id noVotesCmnt000001 (LW only) by "Alice" (user_slug alice) on ${AGI}`,
      "karma 1 (1 vote) · LW only",
      "No votes from others and no reactions recorded.",
      "End of results.",
    ].join("\n"));
    expect(h.forum.requests).toHaveLength(1);
  });

  it("P18 Q50.23 hidden comment karma: no score, vote count or reaction is printed, never 0", async () => {
    const out = (await h0().call("get_reactions", { comment: "hiddenKarmaCmnt01" })).text;
    expect(out.split("\n").slice(2, 4)).toEqual([
      "karma not publicly visible · LW only",
      "This comment's karma is not publicly visible, so scores and reactions are unavailable.",
    ]);
    expect(out).not.toMatch(/karma 0|votes\)|Reactions/);
  });

  it("P5 a deleted placeholder is bad_input and names nobody", async () => {
    expect((await h0().call("get_reactions", { comment: "placeholderCmnt01" })).text).toBe(
      "Error (bad_input): comment: this comment has no public reactions.");
  });

  it("P1 a comment on a post that is not publicly visible is shown with the post unnamed", async () => {
    const out = (await h0().call("get_reactions", { comment: "hiddenPostReact01" })).text;
    expect(out).toContain('Request: comment → comment_id hiddenPostReact01 (LW only) by "Alice" (user_slug alice) on a post that is not publicly visible');
    expect(out).toContain("karma 4 (3 votes) · LW only\nReactions: none.");
    expect(out).not.toContain("draftPost00000001");
  });

  it("Q82 P2 P12 server-hidden items read like unknown ids; the forum's refusal is not_public", async () => {
    const h = h0();
    const t = async (a: Record<string, unknown>) => (await h.call("get_reactions", a)).text;
    expect(await t({ comment: "rejectedCmnt00001" })).toBe('Error (not_found): No publicly visible comment has the id "rejectedCmnt00001".');
    // ¶8: a bare 17-character string, tried as id and as slug, reads in the slug form with the find hint; hidden and unknown alike
    expect(await t({ post: "AAAAAAAAAAAAAAAAA" })).toBe(
      'Error (not_found): No publicly visible post has the slug "AAAAAAAAAAAAAAAAA". Slugs are case-sensitive; to look up a name use find {items: [{kind: "post", query: "AAAAAAAAAAAAAAAAA"}]}. Renamed posts lose their earlier slugs; the id in a URL always works.');
    expect(await t({ tag: "orphanLens0000001" })).toBe('Error (not_found): No publicly visible wiki page has the slug "orphanLens0000001". Slugs are case-sensitive; to look up a name use find {items: [{kind: "tag", query: "orphanLens0000001"}]}.');
    expect(await t({ tag: "adminOnlyTag00001" })).toBe('Error (not_found): No publicly visible wiki page has the slug "adminOnlyTag00001". Slugs are case-sensitive; to look up a name use find {items: [{kind: "tag", query: "adminOnlyTag00001"}]}.');
    expect(await t({ post: "draftPost00000001" })).toBe(
      'Error (not_public): The forum refuses to show the post with the id "draftPost00000001" to logged-out readers: it is a post that is not publicly visible. Its content can\'t be shown.');
    expectClean(h);
  });

  it("exactly one of post, comment, tag; limit is not a parameter", async () => {
    const h = h0();
    expect((await h.call("get_reactions", { post: "uMQ3cqWDPHhjtiesc", tag: "ai" })).text).toBe(
      "Error (bad_input): give exactly one of post, comment, tag (got: post, tag).");
    expect((await h.call("get_reactions", { post: "uMQ3cqWDPHhjtiesc", limit: 5 })).text).toMatch(
      /^Error \(bad_input\): limit is not a parameter of get_reactions; .* It accepts post, comment, tag, cursor, max_tokens\.$/);
  });

  it("a heavily reacted comment is sliced; the cursor continues it with no new request", async () => {
    const h = h0();
    const p1 = (await h.call("get_reactions", { comment: "manyReactsCmnt001", max_tokens: 2000 })).text;
    expect(estimateTokens(p1)).toBeLessThanOrEqual(1900);
    expect(p1).toContain("  react01 1 — added by \"Alice\" (user_slug alice) · on: \"Passage 1 that readers anchored");
    expect(p1).not.toContain("  react40 1 —");
    expect(p1.split("\n").at(-1)).toMatch(/^More available: call get_reactions with cursor "c_[A-Za-z0-9_-]{22}" \(next: reactions from \d+ %\)\.$/);
    const n = h.forum.requests.length;
    const p2 = (await h.call("get_reactions", { cursor: printedCursor(p1)! })).text;
    expect(p2).toContain("  react40 1 —");
    expect(p2).not.toContain("  react01 1 —");
    expect(p2.endsWith("End of results.")).toBe(true);
    expect(h.forum.requests.length).toBe(n);
  });

  it("a repeated call within 5 minutes sends nothing; a deadline before the reactor request is the timeout error", async () => {
    const h = h0();
    await h.call("get_reactions", { comment: "reactsCmnt0000001" });
    const n = h.forum.requests.length;
    await h.call("get_reactions", { comment: "reactsCmnt0000001" });
    expect(h.forum.requests.length).toBe(n);
    const slow = h0(); slow.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    expect((await slow.call("get_reactions", { comment: "reactsCmnt0000001" })).text).toBe(
      "Error (timeout): The forum did not answer in time while running get_reactions (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
  });
});

const ALICE = "aliceUserId000001";
const BOB = "bobUserId00000001";
const CAROL = "carolUserId000001";
/** A liker the users batch does not return: a deleted account (§9.8). */
const GONE = "goneLikerUser0001";
const LIKED_PAGE = "likedPageTag00001";
const LIKED_LENS = "likedPageLens0001";
const UNNAMED_PAGE = "unnamedLikesTag01";

/**
 * L10 (live check 2026-10-24): a page and a lens whose likers carry their user id as `_id`, the shape the forum returned for every
 * one of 139 `usersWhoLiked` entries; and a page whose one liker carries no id at all. The users batch drops GONE.
 */
const liveShapeLikers = (): FixtureEntry[] => {
  const missing = { message: "app.missing_document" };
  const page = rawTagFull({
    _id: LIKED_PAGE, name: "Liked Page", slug: "liked-page", baseScore: 7, voteCount: 3,
    extendedScore: { reacts: {}, usersWhoLiked: [
      { _id: ALICE, displayName: "Alice" }, { _id: GONE, displayName: "Gone Liker" }, { _id: CAROL, displayName: "Carol" },
    ] },
  });
  const lens = {
    ...rawMdocRef({
      _id: LIKED_LENS, slug: "liked-page-intro", title: "Intro", tabTitle: "Intro",
      parentTag: rawTagRef({ _id: LIKED_PAGE, name: "Liked Page", slug: "liked-page" }),
    }),
    baseScore: 4, voteCount: 2, extendedScore: { reacts: {}, usersWhoLiked: [{ _id: BOB, displayName: "Bob" }] },
  };
  const unnamed = rawTagFull({
    _id: UNNAMED_PAGE, name: "Unnamed Likes", slug: "unnamed-likes", baseScore: 2, voteCount: 1,
    extendedScore: { reacts: {}, usersWhoLiked: [{ displayName: "Nobody Known" }] },
  });
  const user = (id: string, slug: string, displayName: string) => rawUserCard({ _id: id, slug, displayName });
  return [
    gqlEntry({ root: "tag", id: LIKED_PAGE }, { result: page }, "§10.3, §13.3"),
    { source: "§10.2", match: { root: "multiDocument", id: LIKED_PAGE }, error: missing },
    gqlEntry({ root: "multiDocument", id: LIKED_LENS }, { result: lens }, "§10.2, §10.3"),
    { source: "§10.2", match: { root: "tag", id: LIKED_LENS }, error: missing },
    gqlEntry({ root: "tag", id: UNNAMED_PAGE }, { result: unnamed }, "§10.3, §13.3"),
    { source: "§10.2", match: { root: "multiDocument", id: UNNAMED_PAGE }, error: missing },
    gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: [ALICE, GONE, CAROL] }, limit: 3 },
      { results: [user(CAROL, "carol", "Carol"), user(ALICE, "alice", "Alice")] }, "§9.8"),
    gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: [BOB] }, limit: 1 }, { results: [user(BOB, "bob", "Robert")] }, "§9.8"),
  ];
};

describe("get_reactions: likers in the live shape {_id, displayName} (L10)", () => {
  const families = ["posts", "comments", "tags", "users"] as const;
  const harness = () => createHarness({ families, extra: liveShapeLikers() });

  it("L10 P8 a page's likers carried as {_id, displayName} are named with their user_slug by the one usersByUserIds request; an id the batch drops is account not publicly visible", async () => {
    const h = harness();
    const out = await h.call("get_reactions", { tag: LIKED_PAGE });
    expect(out).toEqual({ isError: false, text: [
      'get_reactions — wiki page "Liked Page"',
      `Request: tag → "Liked Page" (tag_slug liked-page, tag_id ${LIKED_PAGE})`,
      NOTE,
      'page score 7 (3 votes) · likes 3: "Alice" (user_slug alice), account not publicly visible, "Carol" (user_slug carol)',
      "Reactions: none.",
      "End of results.",
    ].join("\n") });
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain(`ids: users(selector: {usersByUserIds: {userIds: ["${ALICE}", "${GONE}", "${CAROL}"]}}, limit: 3) { results { _id slug displayName } }`);
    // Q76: liker karma is never shown, though the batch answers it.
    expect(out.text).not.toMatch(/170,?469/);
    expectClean(h);
  });

  it("L10 a lens's likers carried as {_id, displayName} are named by their snapshot name with the batch's user_slug", async () => {
    const h = harness();
    const out = await h.call("get_reactions", { tag: LIKED_LENS });
    expect(out.isError, out.text).toBe(false);
    const lines = out.text.split("\n");
    expect(lines[0]).toBe('get_reactions — lens "Intro" of "Liked Page"');
    expect(lines.slice(2)).toEqual([
      NOTE,
      'lens score 4 (2 votes) · likes 1: "Bob" (user_slug bob)',
      "Reactions: none.",
      "End of results.",
    ]);
    expect(out.text).not.toContain("Robert");
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain(`ids: users(selector: {usersByUserIds: {userIds: ["${BOB}"]}}, limit: 1)`);
    expectClean(h);
  });

  it("L10 naming the likers costs one request more than a page with no named likers, whose entry without an id is counted, not named", async () => {
    const h = harness();
    expect((await h.call("get_reactions", { tag: UNNAMED_PAGE })).text.split("\n")[3]).toBe("page score 2 (1 vote) · likes 1: 1 unnamed");
    const unnamed = h.forum.requests.length;
    expect(unnamed).toBe(1);   // the item request alone: nobody to name
    await h.call("get_reactions", { tag: LIKED_PAGE });
    expect(h.forum.requests.length - unnamed).toBe(unnamed + 1);
    expect(gqlTexts(h.forum).filter((t) => t.includes("usersByUserIds"))).toHaveLength(1);
    expectClean(h);
  });
});

/** A heavily reacted post with a slug: the 40 reactions of `manyReactsCmnt001` on a post, so that its slug can be given again with a cursor. */
const manyReactionsPost = (): FixtureEntry[] => {
  const comment = manyReactionsEntries()[0]!.result as { result: { extendedScore: unknown } };
  const post = withExtra(rawPostFull({
    _id: "manyReactsPost001", title: "Many Reactions", slug: "many-reactions", af: false, baseScore: 5, voteCount: 5, afBaseScore: 0,
    extendedScore: comment.result.extendedScore,
  }), { afVoteCount: 0 });
  return [
    gqlEntry({ root: "post", id: "manyReactsPost001" }, { result: post }, "§13.3"),
    gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "many-reactions" }, limit: 2 }, { results: [post] }, "§3.2"),
  ];
};

/** A wiki page whose slug is 17 letters, so that it can be read as a bare id: only its slug lookup finds it. */
const slugOnlyTag = (): FixtureEntry[] => {
  const page = rawTagFull({ _id: "CounterfactTag0001", name: "Counterfactuality", slug: "counterfactuality", baseScore: 9, voteCount: 4, extendedScore: null });
  const missing = { message: "app.missing_document" };
  return [
    gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "counterfactuality" }, limit: 1 }, { results: [page] }, "§10.2"),
    { source: "§10.2", match: { root: "tag", id: "counterfactuality" }, error: missing },
    { source: "§10.2", match: { root: "multiDocument", id: "counterfactuality" }, error: missing },
  ];
};

describe("get_reactions: identifiers, continuations and failures", () => {
  const families = ["posts", "comments", "tags", "users"] as const;

  it("¶3.1.2 a bare 17-character string is tried as an id and as a slug in the one item request", async () => {
    const h = createHarness({ families, extra: slugOnlyTag() });
    expect((await h.call("get_reactions", { tag: "counterfactuality" })).text).toBe([
      'get_reactions — wiki page "Counterfactuality"',
      'Request: tag → "Counterfactuality" (tag_slug counterfactuality, tag_id CounterfactTag0001)',
      "page score 9 (4 votes) · likes 0",
      "Reactions: none.",
      "End of results.",
    ].join("\n"));
    expect(h.forum.requests).toHaveLength(1);
    expect(gqlTexts(h.forum)[0]).toContain('t: tag(selector: {_id: "counterfactuality"})');
    expect(gqlTexts(h.forum)[0]).toContain('a: tags(selector: {tagBySlug: {slug: "counterfactuality"}}');
    expectClean(h);
  });

  it("¶3.7 the notes of a URL stay in the request echo", async () => {
    const out = (await h0().call("get_reactions", { post: "https://www.lesswrong.com/posts/reactsPost0000001/a-post-readers-reacted-to?commentId=reactsCmnt0000001" })).text;
    expect(out.split("\n")[1]).toBe(
      'Request: post → "A Post Readers Reacted To" (post_id reactsPost0000001) by "Eliezer Yudkowsky" · commentId ignored; pass it as comment to target the comment');
  });

  it("¶3.6 a cursor continues the same page when the item is given again, as a slug too; another item is bad_input", async () => {
    const h = createHarness({ families, extra: [...manyReactionsEntries(), ...manyReactionsPost()] });
    const p1 = (await h.call("get_reactions", { post: "many-reactions", max_tokens: 2000 })).text;
    const cursor = printedCursor(p1)!;
    const alone = (await h.call("get_reactions", { cursor })).text;
    expect(alone).toContain("  react40 1 —");
    const n = h.forum.requests.length;
    expect((await h.call("get_reactions", { cursor, post: "many-reactions" })).text).toBe(alone);
    expect(h.forum.requests.length).toBe(n);
    expect((await h.call("get_reactions", { cursor, post: "manyReactsPost001" })).text).toBe(alone);
    expect((await h.call("get_reactions", { cursor, post: "uMQ3cqWDPHhjtiesc" })).text).toMatch(
      /^Error \(bad_input\): this cursor was issued for different parameters \(post: cursor has "manyReactsPost001", call has "uMQ3cqWDPHhjtiesc"\)\./);
    expect((await h.call("get_reactions", { cursor, comment: "manyReactsCmnt001" })).text).toMatch(
      /^Error \(bad_input\): this cursor was issued for different parameters \(comment: cursor has none, call has "manyReactsCmnt001"\)\./);
  });

  it("¶2.3 a remembered not_found costs no request", async () => {
    const h = h0();
    const first = (await h.call("get_reactions", { post: "AAAAAAAAAAAAAAAAA" })).text;
    const n = h.forum.requests.length;
    expect((await h.call("get_reactions", { post: "AAAAAAAAAAAAAAAAA" })).text).toBe(first);
    expect(h.forum.requests.length).toBe(n);
  });

  it("P18 hidden comment karma sends no reactor request", async () => {
    const h = h0();
    await h.call("get_reactions", { comment: "hiddenKarmaCmnt01" });
    expect(h.forum.requests).toHaveLength(1);
  });

  it("P7 the author of an anonymous post is never named", async () => {
    const post = withExtra(rawPostFull({
      _id: "anonReactsPost001", title: "An Anonymous Reacted Post", slug: "an-anonymous-reacted-post", af: false, hideAuthor: true,
      baseScore: 8, voteCount: 6, afBaseScore: 0, user: rawUserRef({ _id: "aliceUserId000001", slug: "alice", displayName: "Alice" }),
      extendedScore: { reacts: { insightful: [
        { userId: "aliceUserId000001", displayName: "Alice", reactType: "created" },
        { userId: "bobUserId00000001", displayName: "Bob", reactType: "seconded" },
      ] } },
    }), { afVoteCount: 0 });
    const bob = rawUserCard({ _id: "bobUserId00000001", slug: "bob", displayName: "Robert" });
    const h = createHarness({ families, extra: [
      gqlEntry({ root: "post", id: "anonReactsPost001" }, { result: post }, "§6.6"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ["bobUserId00000001"] }, limit: 1 }, { results: [bob] }, "§9.8"),
    ] });
    const out = (await h.call("get_reactions", { post: "anonReactsPost001" })).text;
    expect(out).toBe([
      'get_reactions — post "An Anonymous Reacted Post"',
      'Request: post → "An Anonymous Reacted Post" (post_id anonReactsPost001) by author not publicly visible',
      NOTE,
      "karma 8 (6 votes) · LW only",
      "Reactions:",
      '  insightful 2 — added by author not publicly visible; seconded by "Bob" (user_slug bob)',
      "End of results.",
    ].join("\n"));
    expect(out).not.toMatch(/alice/i);
    expect(gqlTexts(h.forum).join("\n")).not.toContain("aliceUserId000001");
    expectClean(h);
  });

  it("a failed reactor request is the call's error, never a page of accounts not publicly visible", async () => {
    const failing: FixtureEntry = {
      source: "§9.8", match: { root: "users", view: "usersByUserIds", terms: { userIds: ["carolUserId000001"] }, limit: 1 },
      error: { message: "Something went wrong" },
    };
    const h = createHarness({ families, extra: [failing] });
    expect((await h.call("get_reactions", { tag: "innerAlignLens001" })).text).toBe(
      "Error (forum_error): The forum returned an error while naming reactors and likers (Something went wrong). Try again later.");
  });
});
