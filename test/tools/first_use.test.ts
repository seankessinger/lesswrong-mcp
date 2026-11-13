import { describe, expect, it } from "vitest";
import { firstUseHistoryOps, firstUseHydrateOps } from "../../src/forum/templates/first_use";
import { estimateBytes } from "../../src/forum/search";
import type { PublicDocId, RawRevRow, SearchHit } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor, searchBodies } from "../support/requests";
import { gqlEntry, rawPostCard, rawRevRow, searchEntry } from "../support/builders";
import { estimateTokens } from "../../src/render/budget";
import { loadFamilies } from "../support/fixtures";

const FAMILIES = ["search", "posts", "comments", "revisions", "users"] as const;
const FORMS = ["mesa optimizer", "mesa optimizers", "mesa optimization"];
const NEWCOMB_QUERY = "Newcomb's problem Newcomb's problem Newcomb's problem Newcomb's problem";
const SEARCH = "Search matches each item's current text only, dated by its original posting date, and leaves out posts with negative karma, unlisted posts, retracted comments and comments by authors the site never approved.";

describe("first_use templates", () => {
  it("the hydrate: posts by id with POST_CARD, comments one alias each with their post and tag joins", () => {
    expect(firstUseHydrateOps(["uMQ3cqWDPHhjtiesc"], ["HRDoDnHv8bvoW7oPZ"]).map((o) => o.text)).toEqual([
      'p: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc"]}}, limit: 1) { results { ...POST_CARD } }',
      'c1: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_TREE post { ...POST_REF } tag { ...TAG_REF } parentComment { ...COMMENT_REF } } }',
    ]);
    expect(firstUseHydrateOps([], ["HRDoDnHv8bvoW7oPZ"]).map((o) => o.alias)).toEqual(["c1"]);
    expect(firstUseHydrateOps(["uMQ3cqWDPHhjtiesc"], [])[0].template).toBe("first_use_hydrate");
  });

  it("the history lists: the as-published row (before postedAt + 5 s + 1 ms) and the light list after publication", () => {
    const ops = firstUseHistoryOps([{ key: "0", docId: "uMQ3cqWDPHhjtiesc" as PublicDocId, postedMs: Date.parse("2019-05-31T00:00:00.000Z") }]);
    expect(ops.map((o) => o.text)).toEqual([
      'pub0: revisions(selector: {revisionsOnDocument: {documentId: "uMQ3cqWDPHhjtiesc", fieldName: "contents", before: "2019-05-31T00:00:05.001Z"}}, limit: 50, enableTotal: true) { results { _id version editedAt updateType } totalCount }',
      'aft0: revisions(selector: {revisionsOnDocument: {documentId: "uMQ3cqWDPHhjtiesc", fieldName: "contents", after: "2019-05-31T00:00:05.000Z"}}, limit: 1000, enableTotal: true) { results { ...REV_ROW } totalCount }',
    ]);
    expect(ops[0].template).toBe("first_use_history");
  });
});

describe("first_use: example 4", () => {
  async function mesa(args: Record<string, unknown> = {}) {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("first_use", { forms: FORMS, limit: 5, ...args });
    return { h, out };
  }

  it("Q42 one search POST, hydrate, history lists, texts and the pages of the edits named: 5 requests; the earliest verified use", async () => {
    const { h, out } = await mesa();
    expect(out.isError).toBe(false);
    // The fifth reads the pages of the two edits named, which no probe needed to read.
    expect(h.forum.requests).toHaveLength(5);
    const body = searchBodies(h.forum)[0];
    expect(body.options.emptyStringSearchResults).toBe("empty");
    expect(body.queries.map((q) => `${q.indexName} ${q.params.query} ${q.params.hitsPerPage}`)).toEqual([
      'posts_oldest_first "mesa optimizer" 10', 'comments_oldest_first "mesa optimizer" 20',
      'posts_oldest_first "mesa optimizers" 10', 'comments_oldest_first "mesa optimizers" 20',
      'posts_oldest_first "mesa optimization" 10', 'comments_oldest_first "mesa optimization" 20',
    ]);
    expect(out.text.split("\n")[0]).toBe('first_use — "mesa optimizer" (also: "mesa optimizers", "mesa optimization")');
    expect(out.text).toContain('Earliest verified: post "Risks from Learned Optimization: Introduction" — "evhub" (user_slug evhub) · post_id RloIntroduction01 · AF · 2019-05-31 · present at publication');
    expect(out.text).toContain("Candidates (by effective date; 5 checked):");
    expect(out.text).toContain('comment_id RloComment0000001 (AF) by "evhub" (user_slug evhub) on "Risks from Learned Optimization: Introduction" (post_id RloIntroduction01, AF) · 2019-06-02 · present at publication');
    expect(out.text).toContain('Read the published text: get_history {post: "RloIntroduction01", revision: "original"}');
    expect(out.text).toContain(SEARCH);
    expectClean(h);
  });

  // An old-style debate post's page shows its turns in place of its body; first_use checks the post's own body, so its candidate line says so.
  it("an old-style debate post's candidate line says its page shows the debate turns in place of the body checked", async () => {
    const hydrate = JSON.parse(JSON.stringify(loadFamilies("posts").find((e) => (e.match as unknown as Record<string, unknown>).root === "posts"
      && JSON.stringify(e.match).includes("RloIntroduction01"))!));
    for (const row of hydrate.result.results as Record<string, unknown>[]) if (row._id === "RloIntroduction01") row.debate = true;
    const h = createHarness({ families: FAMILIES, extra: [hydrate] });
    const out = (await h.call("first_use", { forms: FORMS, limit: 5 })).text;
    const mark = "old-style debate post (its page shows the debate turns in place of the body checked here)";
    expect(out).toContain(`Earliest verified: post "Risks from Learned Optimization: Introduction" — "evhub" (user_slug evhub) · post_id RloIntroduction01 · AF · 2019-05-31 · ${mark} · present at publication`);
    // It names the post twice, as the headline and in the candidate list, each with the mark; no other line has it.
    const naming = out.split("\n").filter((l) => l.includes("post_id RloIntroduction01 · AF · 2019-05-31"));
    expect(naming).toHaveLength(2);
    for (const l of naming) expect(l).toContain(mark);
    expect(out.split("\n").filter((l) => l.includes("old-style debate post"))).toHaveLength(2);
    expectClean(h);
  });

  it("a ruled-out old-style debate post is named with the mark too: the text checked is its own body, not its page", async () => {
    const hydrate = JSON.parse(JSON.stringify(loadFamilies("posts").find((e) => (e.match as unknown as Record<string, unknown>).root === "posts"
      && JSON.stringify(e.match).includes("RloIntroduction01"))!));
    for (const row of hydrate.result.results as Record<string, unknown>[]) if (row._id === "WordsNotPhrase001") row.debate = true;
    const h = createHarness({ families: FAMILIES, extra: [hydrate] });
    const out = (await h.call("first_use", { forms: FORMS, limit: 5 })).text;
    expect(out).toContain('"Words present elsewhere" (post_id WordsNotPhrase001, LW only, dated 2019-02-01, old-style debate post: its page shows the debate turns in place of the body checked): its text does not hold the phrase');
    expectClean(h);
  });

  /** RloComment0000001 in a quick take's thread: the quick take itself, or (with `parent`) a reply in it. */
  function inQuickTake(parent?: string) {
    const user = { _id: "EvhubUserId000001", slug: "evhub", displayName: "evhub" };
    const post = { _id: "EvhubShortform001", title: "evhub's Shortform", slug: "evhub-s-shortform", af: true, question: false, rejected: false, unlisted: false, shortform: true, hideAuthor: false, isEvent: false, hiddenRelatedQuestion: false, groupId: null };
    const ref = (id: string) => ({ _id: id, postId: post._id, tagId: null, userId: user._id, postedAt: "2019-06-01T00:00:00.000Z", af: true, deleted: false, deletedPublic: false, deletedReason: null, rejected: false, authorIsUnreviewed: false, hideAuthor: false, hideKarma: false, debateResponse: null, user });
    return gqlEntry({ root: "comment", id: "RloComment0000001" }, { result: {
      ...ref("RloComment0000001"), postedAt: "2019-06-02T00:00:00.000Z", parentCommentId: parent ?? null, topLevelCommentId: parent ?? null, answer: false,
      lastEditedAt: "2019-06-02T00:00:00.100Z", baseScore: 12, voteCount: 6, afBaseScore: 8, extendedScore: null, retracted: false, moderatorHat: false,
      reviewingForReview: null, shortform: true, isPinnedOnProfile: false, contents: { wordCount: 6 }, post, tag: null, parentComment: parent === undefined ? null : ref(parent),
    } }, "§8.13");
  }

  it("#110 a reply in a quick take's thread is placed in a quick take, not called one", async () => {
    const h = createHarness({ families: FAMILIES, extra: [inQuickTake("EvhubQuickTake001")] });
    const out = await h.call("first_use", { forms: FORMS, limit: 5 });
    expect(out.text).toContain('comment_id RloComment0000001 (AF) by "evhub" (user_slug evhub) in a quick take · 2019-06-02 · present at publication');
    expect(out.text).not.toContain("· quick take");
    expectClean(h);
  });

  it("#110 the quick take itself is flagged as one", async () => {
    const h = createHarness({ families: FAMILIES, extra: [inQuickTake()] });
    const out = await h.call("first_use", { forms: FORMS, limit: 5 });
    expect(out.text).toContain('comment_id RloComment0000001 (AF) by "evhub" (user_slug evhub) · quick take · 2019-06-02 · present at publication');
    expectClean(h);
  });

  it("P7 P16 rejected earlier-looking hits: re-dated by their edit history, or named with the reason, never from search fields", async () => {
    const { out } = await mesa();
    expect(out.text).toContain("Earlier-looking hits ruled out:");
    expect(out.text).toContain('"Embedded Agency (full-text version)" (post_id EmbAgencyFullText, AF, dated 2018-11-15): phrase added by an edit on 2020-08-29 (v1.1.0, revision_id EaRevision0000002)');
    expect(out.text).toContain('"Imitation learning considered unsafe?" (post_id ImitationUnsafe01, LW only, dated 2019-01-06): phrase added by an edit on 2019-09-18 (v1.1.0, revision_id IlRevision0000002)');
    expect(out.text).toContain('"Words present elsewhere" (post_id WordsNotPhrase001, LW only, dated 2019-02-01): its text does not hold the phrase');
    // Its search hit matched on its author's name only, and the name it is shown with comes from the hydrate.
    expect(out.text).toContain('"Mesa optimizer" (post_id MesaTitleShell001, LW only, dated 2019-03-01): its text does not hold the phrase');
    expect(out.text).not.toContain("other hit");   // the one other rejected hit is dated after the earliest verified use
    expect(out.text).not.toMatch(/PLANTED-P16/);
  });

  it("P17 history lists only for candidates that passed; texts only from those lists; published text not available", async () => {
    const { h, out } = await mesa();
    const [hydrate, lists, texts] = gqlTexts(h.forum);
    expect(hydrate).toContain('exactPostIds: ["EmbAgencyFullText", "ImitationUnsafe01", "RloIntroduction01", "LaterMesaPost0001", "WordsNotPhrase001", "MesaTitleShell001"]');
    expect(lists.match(/pub\d: revisions/g)).toHaveLength(4);
    expect(lists).not.toContain("WordsNotPhrase001");
    expect(lists).not.toContain("RloComment0000001");
    expect(texts.match(/r\d: revision\(/g)).toHaveLength(3);
    expect(out.text).toMatch(/post "A later mesa post" .* published text not available/);
  });

  it("¶8 ¶3.9 a failing history list is a Partial line; that candidate stays listed without a verdict", async () => {
    const failing = { source: "§7.3", match: { root: "revisions", view: "revisionsOnDocument", terms: { documentId: "RloIntroduction01", before: "2019-05-31T00:00:05.001Z" } }, error: { message: "Something went wrong" } };
    const h = createHarness({ families: FAMILIES, extra: [failing] });
    const out = await h.call("first_use", { forms: FORMS, limit: 5 });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: edit history unavailable (forum_error: Something went wrong).");
    expect(out.text).toMatch(/post "Risks from Learned Optimization: Introduction" .* · not checked \(its edit history is unavailable\)/);
    expect(out.text).toContain("Earliest verified: comment_id RloComment0000001 (AF)");
  });

  it("¶4.12 step 6 an as-published list with no visible row: the published version is not located in this call", async () => {
    const hidden = gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "LaterMesaPost0001", before: "2020-01-01T00:00:05.001Z" } }, { results: [], totalCount: 120 }, "§7.2");
    const out = await createHarness({ families: FAMILIES, extra: [hidden] }).call("first_use", { forms: FORMS, limit: 5 });
    expect(out.text).toContain('published version not located in this call; get_history {post: "LaterMesaPost0001", revision: "original"} reads further');
  });

  it("¶4.12 step 8 a third candidate added by a later edit is not re-dated in this call", async () => {
    const T = "2020-01-01T00:00:00.000Z";
    const extra = [
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "LaterMesaPost0001", before: "2020-01-01T00:00:05.001Z" } },
        { results: [{ _id: "LaterMesaRev00001", version: "1.0.0", editedAt: T, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "LaterMesaPost0001", after: "2020-01-01T00:00:05.000Z" } },
        { results: [rawRevRow({ _id: "LaterMesaRev00002", documentId: "LaterMesaPost0001", version: "1.1.0", editedAt: "2021-01-01T00:00:00.000Z", updateType: "minor" })], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revision", id: "LaterMesaRev00001" }, { result: { _id: "LaterMesaRev00001", documentId: "LaterMesaPost0001", fieldName: "contents", version: "1.0.0", editedAt: T, wordCount: 6, markdown: "An early draft without the phrase." } }, "§7.4"),
    ];
    const out = await createHarness({ families: FAMILIES, extra }).call("first_use", { forms: FORMS, limit: 5 });
    expect(out.text).toContain('added after publication (version not determined; get_history {post: "LaterMesaPost0001", phrases: ["mesa optimizer"]} finds it)');
  });

  it("¶2.2 step 5 past 40 s the texts are not requested: the candidates are listed unchecked and the page stops early", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("first_use_history"), delayMs: 41_000, times: 1 });
    const out = await h.call("first_use", { forms: FORMS, limit: 5 });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text).toContain("not checked yet");
    expect(out.text).not.toContain("Earliest verified:");
    expect(out.text).toMatch(/Stopped early \(time limit\); call first_use with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });
});

/** Posts whose phrase was in the published text: search hits for `query` (page 0, `nbHits` given), their hydrate, history lists and texts. */
function presentPosts(query: string, n: number, opts: { from?: number; title?: (i: number) => string; page?: number; nbHits?: number } = {}) {
  const from = opts.from ?? 0;
  const id = (i: number) => `UsePost${String(from + i).padStart(10, "0")}`;
  // After the 2019 import, so each is checked against its own published text (C-PRE2019).
  const at = (i: number) => new Date(Date.parse("2020-01-01T00:00:00.000Z") + (from + i) * 86_400_000).toISOString();
  const rows = Array.from({ length: n }, (_, i) => i);
  const docs = rows.map((i) => rawPostCard({ _id: id(i), title: opts.title?.(i) ?? `Use ${from + i}`, postedAt: at(i), af: false, tags: [] }));
  return {
    hits: searchEntry({ index: "posts_oldest_first", query, page: opts.page ?? 0 }, {
      hits: rows.map((i) => ({ objectID: id(i), _id: id(i), title: "PLANTED-P16-title", postedAt: at(i), body: `Here ${query.replaceAll('"', "")} is used.` })),
      nbHits: opts.nbHits ?? n,
    }, "§7.7"),
    docs,
    history: rows.flatMap((i) => [
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id(i), before: new Date(Date.parse(at(i)) + 5001).toISOString() } },
        { results: [{ _id: `Pub${id(i).slice(3)}`, version: "1.0.0", editedAt: at(i), updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id(i), after: new Date(Date.parse(at(i)) + 5000).toISOString() } }, { results: [], totalCount: 0 }, "§7.3"),
      gqlEntry({ root: "revision", id: `Pub${id(i).slice(3)}` }, {
        result: { _id: `Pub${id(i).slice(3)}`, documentId: id(i), fieldName: "contents", version: "1.0.0", editedAt: at(i), wordCount: 4, markdown: `Here ${query.replaceAll('"', "")} is used.` },
      }, "§7.4"),
    ]),
  };
}

/** 15 posts whose phrase was in the published text: 10 on search page 0 and 5 on page 1 (`nbHits` 15), and no comment hits. */
function fifteenUses() {
  const one = presentPosts('"third page"', 10, { nbHits: 15 });
  const two = presentPosts('"third page"', 5, { from: 10, page: 1, nbHits: 15 });
  return createHarness({ families: [], extra: [
    two.hits, one.hits, searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    gqlEntry({ root: "posts", view: "default" }, { results: [...one.docs, ...two.docs] }, "§6.1"), ...one.history, ...two.history,
  ] });
}

/** Pages 1 and 2 of `fifteenUses` at limit 5: both answered from search page 0 alone. */
async function twoPages(h: ReturnType<typeof fifteenUses>) {
  const p1 = await h.call("first_use", { forms: ["third page"], limit: 5 });
  const p2 = await h.call("first_use", { cursor: printedCursor(p1.text)! });
  for (const p of [p1, p2]) expect(p.text).not.toContain("The list changed");
  expect(p2.text).toMatch(/More available: call first_use with cursor "c_[A-Za-z0-9_-]{22}" \(next: candidates 11–15\)\.$/);
  expect(searchBodies(h.forum).map((b) => b.queries.map((q) => `${q.indexName} ${q.params.page}`))).toEqual([["posts_oldest_first 0", "comments_oldest_first 0"]]);
  return p2;
}

describe("first_use: paging", () => {
  it("¶3.6 a continuation that reads a further search page adds candidates after the ones read: no changed-list note", async () => {
    const h = fifteenUses();
    const p2 = await twoPages(h);
    const p3 = await h.call("first_use", { cursor: printedCursor(p2.text)! });
    expect(searchBodies(h.forum).slice(1).map((b) => b.queries.map((q) => `${q.indexName} ${q.params.page}`))).toEqual([["posts_oldest_first 1"]]);
    expect(p3.text).toContain("Position: candidates 11–15");
    expect(p3.text).toContain("Candidates (by effective date; 5 checked):");
    expect(p3.text).not.toContain("The list changed");
    expect(p3.text).toMatch(/End of results\.$/);
    // A continuation's candidates are later hits: its earliest verified use is named as that page's, never as the answer
    expect(p3.text).toMatch(/^Earliest verified on this page: post "Use 10"/m);
    expect(p3.text).not.toMatch(/^Earliest verified: /m);
  });

  it("¶2.2 step 5 a stop on that page repeats it from the search pages its cursor had read, with no changed-list note", async () => {
    const h = fifteenUses();
    const p2 = await twoPages(h);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("first_use_history"), delayMs: 41_000, times: 1 });
    const stopped = await h.call("first_use", { cursor: printedCursor(p2.text)! });
    expect(stopped.text).toMatch(/Stopped early \(time limit\); call first_use with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(stopped.text).not.toContain("The list changed");
    const again = await h.call("first_use", { cursor: printedCursor(stopped.text)! });
    expect(again.text).toContain("Position: candidates 11–15");
    expect(again.text).toContain("Candidates (by effective date; 5 checked):");
    expect(again.text).not.toContain("The list changed");
    expect(again.text).toMatch(/End of results\.$/);
  });

  it("¶3.6 a change in the search pages the cursor had read still gives the note, counted over those pages", async () => {
    const h = fifteenUses();
    const p2 = await twoPages(h);
    // Past the raw-response cache, search page 0 is asked again: its 4th hit is gone and the 11th moved up into it, while the
    // last candidate shown (the 10th) stays, so only the fingerprint over the pages read tells the list changed.
    h.clock.advance(300_001);
    const at = (i: number) => new Date(Date.parse("2019-01-01T00:00:00.000Z") + i * 86_400_000).toISOString();
    const hit = (i: number) => ({ objectID: `UsePost${String(i).padStart(10, "0")}`, _id: `UsePost${String(i).padStart(10, "0")}`, title: "PLANTED-P16-title", postedAt: at(i), body: "Here third page is used." });
    h.forum.inject({ endpoint: "search", when: (b) => b.includes('"page":0'), times: 1, body: JSON.stringify([
      { hits: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10].map(hit), nbHits: 14, page: 0, nbPages: 2, hitsPerPage: 10, index: "posts_oldest_first" },
      { hits: [], nbHits: 0, page: 0, nbPages: 0, hitsPerPage: 20, index: "comments_oldest_first" },
    ]) });
    const p3 = await h.call("first_use", { cursor: printedCursor(p2.text)! });
    expect(p3.text).toContain("The list changed since the previous page (0 new items); positions may have shifted.");
    expect(p3.text).toContain("Position: candidates 11–15");
    expect(p3.text).toContain("Candidates (by effective date; 5 checked):");
    expect(p3.text).toContain("post_id UsePost0000000010");
    expect(p3.text).toMatch(/End of results\.$/);
  });

  it("¶3.6 the cursor continues after the checked candidates; the forms given again are compared, other forms are bad_input", async () => {
    const page2 = gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["RloIntroduction01", "WordsNotPhrase001", "MesaTitleShell001"] } },
      { results: [rawPostCard({ _id: "RloIntroduction01", title: "Risks from Learned Optimization: Introduction", slug: "risks-from-learned-optimization-introduction", postedAt: "2019-05-31T00:00:00.000Z", user: { _id: "EvhubUserId000001", slug: "evhub", displayName: "evhub" }, userId: "EvhubUserId000001", tags: [] })] }, "§6.1");
    const h = createHarness({ families: FAMILIES, extra: [page2] });
    const first = await h.call("first_use", { forms: FORMS, limit: 2 });
    const cursor = printedCursor(first.text)!;
    const before = h.forum.requests.length;
    const next = await h.call("first_use", { cursor, forms: FORMS });
    expect(next.isError).toBe(false);
    expect(h.forum.requests.length - before).toBe(3);
    expect(next.text).toContain("Position: candidates 3–4");
    expect(next.text).toContain('Earliest verified on this page: post "Risks from Learned Optimization: Introduction"');
    expect(next.text).toContain("comment_id RloComment0000001 (AF)");
    expect(next.text).toMatch(/More available: call first_use with cursor "c_[A-Za-z0-9_-]{22}" \(next: candidates 5–5\)\./);
    const other = await h.call("first_use", { cursor: printedCursor(next.text)!, forms: ["mesa optimizer"] });
    expect(other.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(forms: /);
  });

  it("¶3.7 a page too small for every candidate shows fewer; each candidate is checked exactly once over the pages", async () => {
    const set = presentPosts('"long phrase"', 12, { title: (i) => `Use ${i} `.padEnd(300, "x") });
    const h = createHarness({ families: [], extra: [
      set.hits, searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      // nbHits 12 at ten hits per page: the continuations read page 1, which answers no more hits.
      searchEntry({ index: "posts_oldest_first", page: 1 }, { hits: [], nbHits: 12 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: set.docs }, "§6.1"), ...set.history,
    ] });
    const checked: string[] = [];
    let out = await h.call("first_use", { forms: ["long phrase"], limit: 12, max_tokens: 2000 });
    for (let page = 0; page < 12; page++) {
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(1900);
      for (const m of out.text.matchAll(/^ {2}\d+\. post .* · post_id (UsePost\d+) · LW only · [\d-]+ · present at publication$/gm)) checked.push(m[1]!);
      const cursor = printedCursor(out.text);
      if (cursor === undefined) break;
      out = await h.call("first_use", { cursor, max_tokens: 2000 });
    }
    expect(out.text).toMatch(/End of results\.$/);
    expect(checked).toHaveLength(12);
    expect(new Set(checked).size).toBe(12);
    expectClean(h);
  });

  it("¶3.9 a failure of the optional second search POST keeps the page-0 candidates: a Partial line, the ten checked, and the cursor reads that page next", async () => {
    const one = presentPosts('"third page"', 10, { nbHits: 15 });
    const two = presentPosts('"third page"', 5, { from: 10, page: 1, nbHits: 15 });
    const h = createHarness({ families: [], extra: [
      two.hits, one.hits, searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [...one.docs, ...two.docs] }, "§6.1"), ...one.history, ...two.history,
    ] });
    // A 500 with a JSON body is not retried by the transport: the second page fails once, and the first call reads it no further.
    h.forum.inject({ endpoint: "search", when: (b) => b.includes('"page":1'), status: 500, body: '{"message":"Internal server error"}', times: 1 });
    const out = await h.call("first_use", { forms: ["third page"], limit: 12 });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("Partial: further search pages unavailable (forum_error: The forum returned an error while searching for the earliest uses (HTTP 500). Try again later).");
    expect(out.text).toContain("Candidates (by effective date; 10 checked):");
    expect(out.text.match(/^ {2}\d+\. post .* · present at publication$/gm)).toHaveLength(10);
    expect(out.text).toContain('Earliest verified: post "Use 0"');
    expect(h.forum.requests).toHaveLength(5);
    expect(out.text).toMatch(/More available: call first_use with cursor "c_[A-Za-z0-9_-]{22}" \(next: candidates 11–22\)\.$/);
    // The next call reads the page the first one could not, and lists its candidates after the ten.
    const next = await h.call("first_use", { cursor: printedCursor(out.text)! });
    expect(next.isError, next.text).toBe(false);
    expect(next.text).not.toContain("Partial:");
    expect(next.text).toContain("Position: candidates 11–15");
    expect(next.text).toMatch(/End of results\.$/);
  });

  it("¶4.12 step 2 a second search POST reads the next page of the queries that had more, only when the candidates run out", async () => {
    const one = presentPosts('"rare phrase"', 1, { nbHits: 25 });
    const two = presentPosts('"rare phrase"', 1, { from: 1, page: 1, nbHits: 25 });
    const h = createHarness({ families: [], extra: [
      two.hits, one.hits, searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [...one.docs, ...two.docs] }, "§6.1"), ...one.history, ...two.history,
    ] });
    const out = await h.call("first_use", { forms: ["rare phrase"], limit: 5 });
    const bodies = searchBodies(h.forum);
    expect(bodies.map((b) => b.queries.map((q) => `${q.indexName} ${q.params.page}`))).toEqual([
      ["posts_oldest_first 0", "comments_oldest_first 0"], ["posts_oldest_first 1"],
    ]);
    expect(out.text).toContain("Candidates (by effective date; 2 checked):");
    expect(out.text).toMatch(/End of reachable results: first_use reads the oldest 20 post hits and 40 comment hits of each form; later uses are not checked\.$/);
    expect(out.text).not.toMatch(/PLANTED-P16/);
  });
});

/**
 * A post published at `postedAt` whose published text lacks the phrase, with `after` later versions a minute apart, the phrase
 * present from the `presentFrom`-th of them on: the search hit, the card, and the history lists and texts of ¶4.12 steps 6–8.
 */
function redatedPost(id: string, postedAt: string, after: number, presentFrom: number, padding = "") {
  const phrase = "redated phrase";
  const posted = Date.parse(postedAt);
  const pubId = `Pub${id.slice(3)}`;
  const rowId = (i: number) => `Rv${id.charAt(11)}${String(i).padStart(14, "0")}`;
  const at = (i: number) => new Date(posted + i * 60_000).toISOString();
  const text = (present: boolean) => (present ? `Here the ${phrase} is used.` : "Nothing here yet.");
  const rows = Array.from({ length: after }, (_, k) => k + 1);
  return {
    hit: { objectID: id, _id: id, title: "PLANTED-P16-title", postedAt, body: text(true) },
    doc: rawPostCard({ _id: id, title: `Redated ${id}`, postedAt, af: false, tags: [] }),
    history: [
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, before: new Date(posted + 5001).toISOString() } },
        { results: [{ _id: pubId, version: "1.0.0", editedAt: postedAt, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, after: new Date(posted + 5000).toISOString() } },
        { results: rows.map((i) => rawRevRow({ _id: rowId(i), documentId: id, version: `1.${i}.0`, editedAt: at(i), updateType: "minor" })), totalCount: after }, "§7.3"),
      gqlEntry({ root: "revision", id: pubId }, { result: { _id: pubId, documentId: id, fieldName: "contents", version: "1.0.0", editedAt: postedAt, wordCount: 3, markdown: text(false) + padding } }, "§7.4"),
      ...rows.map((i) => gqlEntry({ root: "revision", id: rowId(i) }, {
        result: { _id: rowId(i), documentId: id, fieldName: "contents", version: `1.${i}.0`, editedAt: at(i), wordCount: 3, markdown: text(i >= presentFrom) },
      }, "§7.4")),
    ],
  };
}

describe("first_use: the probe rounds", () => {
  it("texts too large for one answer are read in smaller requests", async () => {
    const padding = " Padding of the kind a long post has.".repeat(3000);
    const a = redatedPost("RedatedPostA00001", "2019-03-01T00:00:00.000Z", 1, 1, padding);
    const b = redatedPost("RedatedPostB00001", "2019-03-02T00:00:00.000Z", 1, 1, padding);
    const h = createHarness({ families: [], http: { maxResponseBytes: 150_000 }, extra: [
      searchEntry({ index: "posts_oldest_first", query: '"redated phrase"' }, { hits: [a.hit, b.hit], nbHits: 2 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [a.doc, b.doc] }, "§6.1"), ...a.history, ...b.history,
    ] });
    const out = await h.call("first_use", { forms: ["redated phrase"] });
    expect(out.text).not.toContain("too large");
    expect(out.text).toMatch(/Earliest verified: .* added by an edit on 2019-03-01/);
    expect(gqlTexts(h.forum).filter((t) => t.includes("revision_text")).length).toBeGreaterThan(1);
  });

  it("the unread stretch is measured from the date the phrase arrived, which an edit can move past the posting date", async () => {
    const a = redatedPost("RedatedPostA00001", "2019-03-01T00:00:00.000Z", 3, 2);
    const comment = (id: string) => ({ objectID: id, _id: id, postedAt: "2019-03-01T00:01:00.000Z", body: "Nothing to see.", af: false });
    const h = createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: '"redated phrase"' }, { hits: [a.hit], nbHits: 1 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first", page: 0 }, { hits: [comment("RedatedComment001")], nbHits: 100 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first", page: 1 }, { hits: [comment("RedatedComment002")], nbHits: 100 }, "§7.7"),
      gqlEntry({ root: "posts", view: "default" }, { results: [a.doc] }, "§6.1"), ...a.history,
    ] });
    const out = await h.call("first_use", { forms: ["redated phrase"] });
    expect(out.text).toMatch(/Earliest verified: .* added by an edit on 2019-03-01/);
    expect(out.text).toContain("Not read: comment hits after 2019-03-01, so an earlier use there is possible.");
  });

  it("a candidate whose only version's page lacks the phrase sends no probe request and is not dated", async () => {
    const id = "NoAfterRowsPost01";
    const postedAt = "2019-02-20T00:00:00.000Z";
    const posted = Date.parse(postedAt);
    const h = createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: '"absent phrase"' }, { hits: [{ objectID: id, _id: id, title: "PLANTED-P16-title", postedAt, body: "Here the absent phrase is used." }], nbHits: 1 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [rawPostCard({ _id: id, title: "No later version", postedAt, af: false, tags: [] })] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, before: new Date(posted + 5001).toISOString() } },
        { results: [{ _id: "PubNoAfterRows001", version: "1.0.0", editedAt: postedAt, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, after: new Date(posted + 5000).toISOString() } }, { results: [], totalCount: 0 }, "§7.3"),
      gqlEntry({ root: "revision", id: "PubNoAfterRows001" }, { result: { _id: "PubNoAfterRows001", documentId: id, fieldName: "contents", version: "1.0.0", editedAt: postedAt, wordCount: 3, markdown: "Nothing here yet." } }, "§7.4"),
    ] });
    const out = await h.call("first_use", { forms: ["absent phrase"] });
    expect(out.isError, out.text).toBe(false);
    expect(h.forum.requests).toHaveLength(4);
    expect(gqlTexts(h.forum).filter((t) => t.includes("revision_text"))).toHaveLength(1);
    expect(out.text).toContain("in the forum's search text but not found on its page, so it can't be dated");
    expect(out.text).not.toContain("added after publication");
    expect(out.text).toContain("No candidate checked on this page could be verified.");
    expect(out.text).not.toContain("Partial:");
    expectClean(h);
  });

  /** One post hit and its history: the as-published row, the rows after it, and each row's page text. */
  function onePost(id: string, postedAt: string, form: string, body: string, rows: { id: string; ms: number; text: string; updateType?: RawRevRow["updateType"] }[]) {
    const posted = Date.parse(postedAt);
    const row = (r: (typeof rows)[number]) => ({ _id: r.id, version: `1.${rows.indexOf(r)}.0`, editedAt: new Date(posted + r.ms).toISOString(), updateType: r.updateType === undefined ? "minor" as const : r.updateType });
    return createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: `"${form}"` }, { hits: [{ objectID: id, _id: id, title: "A post", postedAt, body }], nbHits: 1 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [rawPostCard({ _id: id, title: "A post", postedAt, af: false, tags: [] })] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, before: new Date(posted + 5001).toISOString() } }, { results: [row(rows[0]!)], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: id, after: new Date(posted + 5000).toISOString() } },
        { results: rows.slice(1).reverse().map((r) => rawRevRow({ ...row(r), documentId: id, collectionName: "Posts" })), totalCount: rows.length - 1 }, "§7.3"),
      ...rows.map((r) => gqlEntry({ root: "revision", id: r.id }, { result: { ...row(r), documentId: id, fieldName: "contents", wordCount: 3, markdown: r.text } }, "§7.4")),
    ] });
  }

  it("an edit is named only once its page holds the phrase: when no version's page does, the use is not dated", async () => {
    const h = onePost("NotOnPagePost0001", "2020-01-01T00:00:00.000Z", "absent phrase", "Here the absent phrase is used.", [
      { id: "NotOnPageRev00001", ms: 0, text: "Nothing here yet.", updateType: "initial" }, { id: "NotOnPageRev00002", ms: 86_400_000, text: "Still nothing here." },
    ]);
    const out = await h.call("first_use", { forms: ["absent phrase"] });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("in the forum's search text but not found on its page, so it can't be dated");
    expect(out.text).not.toContain("added by an edit");
    expect(out.text).toContain("No candidate checked on this page could be verified.");
    expectClean(h);
  });

  it("an edit whose page holds the phrase is named, after its page is read", async () => {
    const h = onePost("AddedLaterPost001", "2020-01-01T00:00:00.000Z", "later phrase", "Here the later phrase is used.", [
      { id: "AddedLaterRev0001", ms: 0, text: "Nothing here yet.", updateType: "initial" }, { id: "AddedLaterRev0002", ms: 86_400_000, text: "Now the later phrase is here." },
    ]);
    const out = await h.call("first_use", { forms: ["later phrase"] });
    expect(out.text).toContain("Earliest verified: post \"A post\"");
    expect(out.text).toContain("added by an edit on 2020-01-02 (v1.1.0, revision_id AddedLaterRev0002)");
    expect(gqlTexts(h.forum).filter((t) => t.includes("AddedLaterRev0002"))).toHaveLength(1);
    expectClean(h);
  });

  it("a text posted before the 2019 import has only its snapshot's wording, whatever row stands first", async () => {
    const h = onePost("PreImportPost0001", "2019-01-29T12:00:00.000Z", "early phrase", "The early phrase.", [
      { id: "PreImportRev00001", ms: 0, text: "The early phrase.", updateType: null },
    ]);
    const out = await h.call("first_use", { forms: ["early phrase"] });
    expect(out.text).toContain("in the oldest kept text (a February-2019 snapshot); original wording not recorded");
    expect(out.text).not.toContain("present at publication");
  });

  it("a hit holding the phrase only in a quoted passage is not its writer's use", async () => {
    const quoted = { objectID: "QuoteOnlyPost0001", _id: "QuoteOnlyPost0001", title: "Quoted", postedAt: "2010-01-01T00:00:00.000Z", body: "> the quoted phrase here\n\nMy reply to it." };
    const used = { objectID: "UseItPost00000001", _id: "UseItPost00000001", title: "Used", postedAt: "2011-01-01T00:00:00.000Z", body: "I use the quoted phrase here." };
    const posted = Date.parse(used.postedAt);
    const h = createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: '"quoted phrase"' }, { hits: [quoted, used], nbHits: 2 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [rawPostCard({ _id: used._id, title: used.title, postedAt: used.postedAt, af: false, tags: [] }), rawPostCard({ _id: quoted._id, title: quoted.title, postedAt: quoted.postedAt, af: false, tags: [] })] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: used._id, before: new Date(posted + 5001).toISOString() } },
        { results: [{ _id: "UseItRevision0001", version: "1.0.0", editedAt: used.postedAt, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: used._id, after: new Date(posted + 5000).toISOString() } }, { results: [], totalCount: 0 }, "§7.3"),
      gqlEntry({ root: "revision", id: "UseItRevision0001" }, { result: { _id: "UseItRevision0001", documentId: used._id, fieldName: "contents", version: "1.0.0", editedAt: used.postedAt, wordCount: 6, markdown: "I use the quoted phrase here." } }, "§7.4"),
    ] });
    const out = await h.call("first_use", { forms: ["quoted phrase"] });
    expect(out.text).toContain("Earliest verified: post \"Used\"");
    expect(out.text).toContain('"Quoted" (post_id QuoteOnlyPost0001, LW only, dated 2010-01-01): only in a quoted passage');
    expectClean(h);
  });

  interface Row { id: string; ms: number; text: string; updateType?: RawRevRow["updateType"] }
  interface PostSpec { id: string; title: string; postedAt: string; body: string; rows?: Row[] }
  /** Post hits for `query`, their hydrate, and for each post with rows its history: the as-published row, the rows after it, each one's page. */
  function world(query: string, posts: PostSpec[]) {
    const history = (p: PostSpec) => {
      const posted = Date.parse(p.postedAt);
      const rows = p.rows ?? [];
      if (rows.length === 0) return [];
      const row = (r: Row) => ({ _id: r.id, version: `1.${rows.indexOf(r)}.0`, editedAt: new Date(posted + r.ms).toISOString(), updateType: r.updateType === undefined ? "minor" as const : r.updateType });
      return [
        gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: p.id, before: new Date(posted + 5001).toISOString() } }, { results: [row(rows[0]!)], totalCount: 1 }, "§7.3"),
        gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: p.id, after: new Date(posted + 5000).toISOString() } },
          { results: rows.slice(1).reverse().map((r) => rawRevRow({ ...row(r), documentId: p.id, collectionName: "Posts" })), totalCount: rows.length - 1 }, "§7.3"),
        ...rows.map((r) => gqlEntry({ root: "revision", id: r.id }, { result: { ...row(r), documentId: p.id, fieldName: "contents", wordCount: 3, markdown: r.text } }, "§7.4")),
      ];
    };
    return createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query }, { hits: posts.map((p) => ({ objectID: p.id, _id: p.id, title: p.title, postedAt: p.postedAt, body: p.body })), nbHits: posts.length }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: posts.map((p) => rawPostCard({ _id: p.id, title: p.title, postedAt: p.postedAt, af: false, tags: [] })) }, "§6.1"),
      ...posts.flatMap(history),
    ] });
  }
  /** A first row with nothing, then `n` rows a minute apart, the phrase on the page from row `from` on (never when from > n). */
  const series = (prefix: string, n: number, from: number, phrase: string): Row[] => {
    const id = (i: number) => `${prefix}${String(i).padStart(17 - prefix.length, "0")}`;
    return [{ id: id(0), ms: 0, text: "Nothing here yet.", updateType: "initial" },
      ...Array.from({ length: n }, (_, k) => ({ id: id(k + 1), ms: (k + 1) * 60_000, text: k + 1 >= from ? `Here the ${phrase} is used.` : "Nothing here yet." }))];
  };

  it("probes stopped by the time limit name no edit whose page was never read", async () => {
    const P = "redated phrase";
    const h = world(`"${P}"`, [
      { id: "RedatedPostA00001", title: "A", postedAt: "2019-03-01T00:00:00.000Z", body: `Here the ${P} is used.`, rows: series("RvA", 3, 99, P) },
      { id: "RedatedPostB00001", title: "B", postedAt: "2019-04-01T00:00:00.000Z", body: `Here the ${P} is used.`, rows: series("RvB", 40, 20, P) },
    ]);
    let n = 0;
    h.forum.inject({ endpoint: "graphql", when: (b: string) => b.includes("revision_text") && ++n === 2, delayMs: 41_000, times: 1 });
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).not.toMatch(/added by an edit on [\d-]+ \(v1\.3\.0, revision_id RvA0+3\)/);
    expect(out.text).toMatch(/Stopped early/);
  });

  it("a published text that only quotes the phrase is not a use; the edit that first uses it is", async () => {
    const P = "quoted phrase";
    const h = world(`"${P}"`, [{ id: "QuoteThenUse00001", title: "Quote then use", postedAt: "2020-01-01T00:00:00.000Z", body: `> the ${P} here\n\nNow I use the ${P} myself.`, rows: [
      { id: "QuoteThenUseRev01", ms: 0, text: `> the ${P} here\n\nMy reply to it.`, updateType: "initial" },
      { id: "QuoteThenUseRev02", ms: 86_400_000, text: `> the ${P} here\n\nNow I use the ${P} myself.` },
    ] }]);
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).toContain("added by an edit on 2020-01-02 (v1.1.0, revision_id QuoteThenUseRev02)");
    expect(out.text).not.toContain("present at publication");
  });

  it("the edit search reads each version's own words: versions that only quote the phrase are passed over", async () => {
    const P = "quoted phrase";
    const rows: Row[] = [
      { id: "QuoteProbeRev0000", ms: 0, text: "Nothing here yet.", updateType: "initial" },
      ...[1, 2, 3, 4, 5].map((k) => ({ id: `QuoteProbeRev000${k}`, ms: k * 86_400_000, text: k < 5 ? `> the ${P} here\n\nMy reply to it.` : `Now I use the ${P} myself.` })),
    ];
    const h = world(`"${P}"`, [{ id: "QuoteProbePost001", title: "Quotes first", postedAt: "2020-01-01T00:00:00.000Z", body: `Now I use the ${P} myself.`, rows }]);
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).toContain("added by an edit on 2020-01-06 (v1.5.0, revision_id QuoteProbeRev0005)");
  });

  it("when every hit only quotes the phrase, the reply says so rather than that nothing was found", async () => {
    const P = "quoted phrase";
    const h = world(`"${P}"`, [
      { id: "QuoteOnlyPost0001", title: "Quoted", postedAt: "2012-01-01T00:00:00.000Z", body: `> the ${P} here\n\nMy reply to it.` },
      { id: "QuoteOnlyPost0002", title: "Quoted again", postedAt: "2013-01-01T00:00:00.000Z", body: `> they said the ${P}\n\nI disagree.` },
    ]);
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).toContain('The forum\'s search found "quoted phrase" only inside quoted passages (2 hits), never in a writer\'s own words.');
    expect(out.text).not.toContain("found no post");
  });

  it("a title holding the form is a title candidate even when the text holds only the other apostrophe form", async () => {
    const h = world('"Newcomb problem"', [{ id: "TitleOtherForm001", title: "Newcomb problem", postedAt: "2012-01-01T00:00:00.000Z", body: "Newcomb's problem again." }]);
    const out = await h.call("first_use", { forms: ["Newcomb problem"] });
    expect(out.text).toContain("post_id TitleOtherForm001 · LW only · 2012-01-01 · in its title only");
  });

  it("leaving out a quoted line does not join the words around it into the phrase", async () => {
    const P = "mesa optimizer";
    const body = "I talked about mesa\n> a quoted line\noptimizer stuff here.";
    const h = world(`"${P}"`, [{ id: "JoinedLinesPost01", title: "Joined", postedAt: "2020-01-01T00:00:00.000Z", body, rows: [{ id: "JoinedLinesRev001", ms: 0, text: body, updateType: "initial" }] }]);
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).not.toContain("JoinedLinesPost01 · LW only");
    expect(out.text).toContain('The forum\'s search found no post or comment using "mesa optimizer".');
  });

  it("a post from 13 February 2019 with its own first row is checked as published, not as a snapshot", async () => {
    const P = "thirteenth phrase";
    const h = world(`"${P}"`, [{ id: "ThirteenthPost001", title: "On the 13th", postedAt: "2019-02-13T18:00:00.000Z", body: `The ${P} here.`, rows: [{ id: "ThirteenthRev0001", ms: 0, text: `The ${P} here.`, updateType: "initial" }] }]);
    const out = await h.call("first_use", { forms: [P] });
    expect(out.text).toContain("present at publication");
  });

  it("a failure in the second probe round keeps what the first round found: one candidate re-dated, the other not determined, a Partial line", async () => {
    // A: four rows, settled by round 1 (its two interior rows are probed at once); B: twenty-one rows, narrowed by round 1 to an
    // interval of two steps that round 2 would close, when its request fails.
    const a = redatedPost("RedatedPostA00001", "2019-03-01T00:00:00.000Z", 3, 2);
    const b = redatedPost("RedatedPostB00001", "2019-04-01T00:00:00.000Z", 20, 10);
    const h = createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: '"redated phrase"' }, { hits: [a.hit, b.hit], nbHits: 2 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [a.doc, b.doc] }, "§6.1"), ...a.history, ...b.history,
    ] });
    let texts = 0;
    // The third revision-text request (the published texts, round 1, round 2) fails with a JSON body: no transport retry.
    h.forum.inject({ endpoint: "graphql", when: (body) => body.includes("revision_text") && ++texts === 3, status: 500, body: '{"errors":[{"message":"Internal server error"}]}' });
    const out = await h.call("first_use", { forms: ["redated phrase"] });
    expect(out.isError, out.text).toBe(false);
    expect(h.forum.requests).toHaveLength(6);
    expect(out.text).toContain("Partial: edit probes unavailable (forum_error:");
    expect(out.text).toMatch(/post "Redated RedatedPostA00001" .* · added by an edit on 2019-03-01 \(v1\.2\.0, revision_id RvA00000000000002\)/);
    expect(out.text).toMatch(/post "Redated RedatedPostB00001" .* · added after publication \(version not determined; get_history \{post: "RedatedPostB00001", phrases: \["redated phrase"\]\} finds it\)/);
    expect(out.text).toContain('Earliest verified: post "Redated RedatedPostA00001"');
  });
});

describe("first_use: forms, filters and the empty result", () => {
  it("Q29 a form with punctuation that splits words is traced as a quoted phrase", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    const out = await h.call("first_use", { forms: ["R&D"] });
    expect(out.isError).toBe(false);
    expect(searchBodies(h.forum)[0].queries.map((q) => q.params.query)).toEqual(['"R D"', '"R D"']);
    expect(out.text).toContain('forms ["R&D" (searched as "R D")]');
  });

  it.each([
    ["Löb's theorem", "Löb's theorem Löb's theorem Löb's theorem Löb's theorem"],
    ["GPT-4.5", "GPT 4.5 GPT 4.5 GPT 4.5 GPT 4.5"],
    ["Gödel", "Gödel Gödel Gödel Gödel"],
  ])("Q29 %s holds a word no quoted phrase can reach: it is traced unquoted, every word required", async (form, query) => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    const out = await h.call("first_use", { forms: [form] });
    expect(out.isError).toBe(false);
    expect(searchBodies(h.forum)[0].queries.map((q) => q.params.query)).toEqual([query, query]);
  });

  it("no hits for any form: the empty text; include_comments false searches posts only; af_only adds the af facet", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    const out = await h.call("first_use", { forms: ["zzqx frobnicator"], include_comments: false, af_only: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('The forum\'s search found no post using "zzqx frobnicator". Phrase search is exact: try other word forms, or hyphenated and spaced spellings.');
    const body = searchBodies(h.forum)[0];
    expect(body.queries.map((q) => q.indexName)).toEqual(["posts_oldest_first"]);
    expect(body.queries[0].params.facetFilters).toEqual([["af:true"]]);
    expect(h.forum.requests).toHaveLength(1);
  });

  it("the largest request for limit 50 (5 forms, both indexes) stays within the 4 MB estimate", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    await h.call("first_use", { forms: ["alpha beta", "gamma delta", "epsilon zeta", "eta theta", "iota kappa"], limit: 50 });
    const queries = searchBodies(h.forum)[0].queries;
    expect(queries).toHaveLength(10);
    expect(estimateBytes(queries)).toBeLessThanOrEqual(4_194_304);
  });

  /** A forum where `hits` are the post hits and NewcombPossHit001 is the one post holding "Newcomb's problem"; `also` are hydrated with it. */
  function newcombWorld(hits: SearchHit[], commentEntries: ReturnType<typeof searchEntry>[], also: ReturnType<typeof rawPostCard>[] = [], alsoFirst = false) {
    const posted = "2015-01-01T00:00:00.000Z";
    return createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first", query: NEWCOMB_QUERY }, { hits: [
        ...hits,
        { objectID: "NewcombPossHit001", _id: "NewcombPossHit001", title: "Possessive form", postedAt: posted, body: "Newcomb's problem again.", af: false },
      ], nbHits: hits.length + 1 }, "§5.2"),
      ...commentEntries,
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: alsoFirst ? [...also.map((p) => p._id), "NewcombPossHit001"] : ["NewcombPossHit001", ...also.map((p) => p._id)] } }, { results: [rawPostCard({ _id: "NewcombPossHit001", title: "Possessive form", postedAt: posted }), ...also] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "NewcombPossHit001", before: "2015-01-01T00:00:05.001Z" } }, { results: [{ _id: "NewcombRev000001x", version: "1.0.0", editedAt: posted, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "NewcombPossHit001", after: "2015-01-01T00:00:05.000Z" } }, { results: [], totalCount: 0 }, "§7.3"),
      gqlEntry({ root: "revision", id: "NewcombRev000001x" }, { result: { _id: "NewcombRev000001x", documentId: "NewcombPossHit001", fieldName: "contents", version: "1.0.0", editedAt: posted, wordCount: 3, markdown: "Newcomb's problem again." } }, "§7.4"),
    ] });
  }
  const noComments = [searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY }, { hits: [], nbHits: 0 }, "§5.2")];
  const commentHit = (id: string, postedAt: string) => ({ objectID: id, _id: id, postedAt, body: "Newcomb had a problem.", af: false });

  it("Q135 a hit with only the other apostrophe form is set aside as a different form, not counted as a use", async () => {
    const h = newcombWorld([{ objectID: "NewcombPlainHit01", _id: "NewcombPlainHit01", title: "Plain form", postedAt: "2012-01-01T00:00:00.000Z", body: "The Newcomb problem is old.", af: false }], noComments);
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain("post_id NewcombPossHit001");
    expect(out.text).toContain('Not counted (only the other apostrophe form, "Newcomb problem"): 1 hit.');
    expect(out.text).not.toContain("NewcombPlainHit01");
  });

  it("a hit of a loose search without the phrase is counted, not named as an earlier use: it never looked like one", async () => {
    const h = newcombWorld([{ objectID: "NewcombWords00001", _id: "NewcombWords00001", title: "Puzzles", postedAt: "2011-01-01T00:00:00.000Z", body: "Newcomb had a problem.", af: false }], noComments);
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain('Earliest verified: post "Possessive form"');
    expect(out.text).toContain("1 other hit matched the search but not the phrase");
    expect(out.text).not.toContain("NewcombWords00001");
  });

  it("a hit dated after the earliest verified use is not an earlier-looking hit, and is not counted as one", async () => {
    const h = newcombWorld([], [searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY }, { hits: [commentHit("NewcombComment001", "2018-01-01T00:00:00.000Z")], nbHits: 1 }, "§5.2")]);
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).not.toContain("Earlier-looking hits ruled out");
    expect(out.text).not.toContain("other hit");
  });

  it("a hit with a possessive the plain form lacks is reported as such, not as a form built from its first word", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first", query: '"Newcomb problem"' }, { hits: [
        { objectID: "NewcombPossHit001", _id: "NewcombPossHit001", title: "Possessive form", postedAt: "2015-01-01T00:00:00.000Z", body: "Newcomb's problem again.", af: false },
      ], nbHits: 1 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: '"Newcomb problem"' }, { hits: [], nbHits: 0 }, "§5.2"),
    ] });
    const out = await h.call("first_use", { forms: ["Newcomb problem"] });
    expect(out.text).toContain('Not counted (only a possessive form of "Newcomb problem"): 1 hit.');
  });

  it("a form of stop words alone reaches nothing, so it is refused before anything is sent", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("first_use", { forms: ["mesa optimizer", "that's it"] });
    expect(out.text).toBe(`Error (bad_input): forms: "that's it" holds only words the forum's search ignores once each apostrophe and what follows it are dropped. Add a neighbouring word to the phrase, as in "it's raining".`);
    expect(h.forum.requests).toHaveLength(0);
  });

  it("two forms that differ only in how they are searched are both searched", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    await h.call("first_use", { forms: ["cousin it", "cousin_it"], include_comments: false });
    expect(searchBodies(h.forum)[0].queries.map((q) => q.params.query)).toEqual(['"cousin it"', "cousin_it cousin_it cousin_it cousin_it"]);
  });

  it("the echo says which forms are searched loosely", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    const out = await h.call("first_use", { forms: ["Goodhart's law", "GPT-4.5", "R&D", "mesa optimizer"] });
    expect(out.text).toContain('forms ["Goodhart\'s law" (searched loosely), "GPT-4.5" (searched loosely), "R&D" (searched as "R D"), "mesa optimizer"]');
  });

  it("a post with the phrase only in its title is a candidate that can't be verified, not a hit ruled out", async () => {
    const postedAt = "2011-01-01T00:00:00.000Z";
    const h = newcombWorld(
      [{ objectID: "NewcombTitled0001", _id: "NewcombTitled0001", title: "Newcomb's problem", postedAt, body: "Two boxes, one choice.", af: false }],
      noComments, [rawPostCard({ _id: "NewcombTitled0001", title: "Newcomb's problem", postedAt })], true,
    );
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain("post_id NewcombTitled0001 · AF · 2011-01-01 · in its title only; a title's earlier wording isn't recorded, so this isn't verified");
    expect(out.text).not.toContain("only in the title");
  });

  it("a stretch of hits left unread before the earliest verified use is stated", async () => {
    const h = newcombWorld([], [
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 0 }, { hits: [commentHit("NewcombComment001", "2009-01-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 1 }, { hits: [commentHit("NewcombComment002", "2011-02-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
    ]);
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain('Earliest verified: post "Possessive form"');
    expect(out.text).toContain("Not read: comment hits after 2011-02-01, so an earlier use there is possible.");
  });

  it("with several forms, the unread stretch starts at the earliest date any of them stopped at", async () => {
    const paradox = "Newcomb's paradox Newcomb's paradox Newcomb's paradox Newcomb's paradox";
    const h = newcombWorld([], [
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 0 }, { hits: [commentHit("NewcombComment001", "2009-01-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 1 }, { hits: [commentHit("NewcombComment002", "2012-02-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
      searchEntry({ index: "posts_oldest_first", query: paradox }, { hits: [], nbHits: 0 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: paradox, page: 0 }, { hits: [commentHit("NewcombComment003", "2009-02-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: paradox, page: 1 }, { hits: [commentHit("NewcombComment004", "2011-02-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
    ]);
    const out = await h.call("first_use", { forms: ["Newcomb's problem", "Newcomb's paradox"] });
    expect(out.text).toContain("Not read: comment hits after 2011-02-01, so an earlier use there is possible.");
  });

  it("no such line when the reading passed the earliest verified use", async () => {
    const h = newcombWorld([], [
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 0 }, { hits: [commentHit("NewcombComment001", "2016-01-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: NEWCOMB_QUERY, page: 1 }, { hits: [commentHit("NewcombComment002", "2017-01-01T00:00:00.000Z")], nbHits: 100 }, "§5.2"),
    ]);
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain('Earliest verified: post "Possessive form"');
    expect(out.text).not.toContain("Not read:");
  });
});
