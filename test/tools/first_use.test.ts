import { describe, expect, it } from "vitest";
import { firstUseHistoryOps, firstUseHydrateOps } from "../../src/forum/templates/first_use";
import { estimateBytes } from "../../src/forum/search";
import type { PublicDocId } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor, searchBodies } from "../support/requests";
import { gqlEntry, rawPostCard, rawRevRow, searchEntry } from "../support/builders";
import { estimateTokens } from "../../src/render/budget";

const FAMILIES = ["search", "posts", "comments", "revisions", "users"] as const;
const FORMS = ["mesa optimizer", "mesa optimizers", "mesa optimization"];
const SEARCH = "Search matches each item's current text only, dated by its original posting date, and leaves out posts with negative karma and retracted comments.";

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

  it("Q42 one search POST, hydrate, history lists and texts: 4 requests; the earliest verified use", async () => {
    const { h, out } = await mesa();
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(4);
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

  it("P7 P16 rejected earlier-looking hits: re-dated by their edit history, or named with the reason, never from search fields", async () => {
    const { out } = await mesa();
    expect(out.text).toContain("Earlier-looking hits ruled out:");
    expect(out.text).toContain('"Embedded Agency (full-text version)" (post_id EmbAgencyFullText, AF, dated 2018-11-15): phrase added by an edit on 2020-08-29 (v1.1.0, revision_id EaRevision0000002)');
    expect(out.text).toContain('"Imitation learning considered unsafe?" (post_id ImitationUnsafe01, LW only, dated 2019-01-06): phrase added by an edit on 2019-09-18 (v1.1.0, revision_id IlRevision0000002)');
    expect(out.text).toContain('"Words present elsewhere" (post_id WordsNotPhrase001, LW only, dated 2019-02-01): words present but not as the phrase');
    expect(out.text).toContain('"Mesa optimizer" (post_id MesaTitleShell001, LW only, dated 2019-03-01): only in the title');
    expect(out.text).toContain("1 other hit contained the words but not the phrase");
    expect(out.text).not.toMatch(/PLANTED-P16/);
  });

  it("P17 history lists only for candidates that passed; texts only from those lists; published text not available", async () => {
    const { h, out } = await mesa();
    const [hydrate, lists, texts] = gqlTexts(h.forum);
    expect(hydrate).toContain('exactPostIds: ["EmbAgencyFullText", "ImitationUnsafe01", "RloIntroduction01", "LaterMesaPost0001", "WordsNotPhrase001", "MesaTitleShell001"]');
    expect(lists.match(/pub\d: revisions/g)).toHaveLength(5);
    expect(lists).not.toContain("WordsNotPhrase001");
    expect(texts.match(/r\d: revision\(/g)).toHaveLength(4);
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
  const at = (i: number) => new Date(Date.parse("2019-01-01T00:00:00.000Z") + (from + i) * 86_400_000).toISOString();
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
function redatedPost(id: string, postedAt: string, after: number, presentFrom: number) {
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
      gqlEntry({ root: "revision", id: pubId }, { result: { _id: pubId, documentId: id, fieldName: "contents", version: "1.0.0", editedAt: postedAt, wordCount: 3, markdown: text(false) } }, "§7.4"),
      ...rows.map((i) => gqlEntry({ root: "revision", id: rowId(i) }, {
        result: { _id: rowId(i), documentId: id, fieldName: "contents", version: `1.${i}.0`, editedAt: at(i), wordCount: 3, markdown: text(i >= presentFrom) },
      }, "§7.4")),
    ],
  };
}

describe("first_use: the probe rounds", () => {
  it("a candidate absent at publication with no later public version sends no probe request and reads as not determined", async () => {
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
    expect(out.text).toContain(`added after publication (version not determined; get_history {post: "${id}", phrases: ["absent phrase"]} finds it)`);
    expect(out.text).toContain("No candidate checked on this page could be verified.");
    expect(out.text).not.toContain("Partial:");
    expectClean(h);
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
  it("Q29 a loose form is refused with the ASCII suggestion before any request", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("first_use", { forms: ["Löb's theorem"] });
    expect(out.text).toBe(`Error (bad_input): forms: "Löb's theorem" contains accented letters or punctuation inside a word, which the forum's exact-phrase search deletes, so it can't be traced in date order. Try ASCII spellings writers also use, as further forms: "Lob's theorem".`);
    expect(h.forum.requests).toHaveLength(0);
  });

  it("Q29 a loose form whose ASCII spelling still can't be traced gets no suggestion", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("first_use", { forms: ["αβ test"] });
    expect(out.isError).toBe(true);
    expect(out.text.endsWith("Try ASCII spellings writers also use, as further forms.")).toBe(true);
    expect(h.forum.requests).toHaveLength(0);
  });

  it("no hits for any form: the empty text; include_comments false searches posts only; af_only adds the af facet", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    ] });
    const out = await h.call("first_use", { forms: ["zzqx frobnicator"], include_comments: false, af_only: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('No publicly visible post or comment contains "zzqx frobnicator". Phrase search is exact: try other word forms, or hyphenated and spaced spellings.');
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

  it("Q135 a hit with only the other apostrophe form is set aside as a different form, not counted as a use", async () => {
    const posted = "2015-01-01T00:00:00.000Z";
    const h = createHarness({ families: FAMILIES, extra: [
      searchEntry({ index: "posts_oldest_first", query: "\"Newcomb problem\"" }, { hits: [
        { objectID: "NewcombPlainHit01", _id: "NewcombPlainHit01", title: "Plain form", postedAt: "2012-01-01T00:00:00.000Z", body: "The Newcomb problem is old.", af: false },
        { objectID: "NewcombPossHit001", _id: "NewcombPossHit001", title: "Possessive form", postedAt: posted, body: "Newcomb's problem again.", af: false },
      ], nbHits: 2 }, "§5.2"),
      searchEntry({ index: "comments_oldest_first", query: "\"Newcomb problem\"" }, { hits: [], nbHits: 0 }, "§5.2"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["NewcombPossHit001"] } }, { results: [rawPostCard({ _id: "NewcombPossHit001", title: "Possessive form", postedAt: posted })] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "NewcombPossHit001", before: "2015-01-01T00:00:05.001Z" } }, { results: [{ _id: "NewcombRev000001x", version: "1.0.0", editedAt: posted, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "NewcombPossHit001", after: "2015-01-01T00:00:05.000Z" } }, { results: [], totalCount: 0 }, "§7.3"),
      gqlEntry({ root: "revision", id: "NewcombRev000001x" }, { result: { _id: "NewcombRev000001x", documentId: "NewcombPossHit001", fieldName: "contents", version: "1.0.0", editedAt: posted, wordCount: 3, markdown: "Newcomb's problem again." } }, "§7.4"),
    ] });
    const out = await h.call("first_use", { forms: ["Newcomb's problem"] });
    expect(out.text).toContain("post_id NewcombPossHit001");
    expect(out.text).toContain('Not counted (only the other apostrophe form, "Newcomb problem"): 1 hit.');
    expect(out.text).not.toContain("NewcombPlainHit01");
  });
});
