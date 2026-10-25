import { parse } from "graphql";
import { describe, expect, it } from "vitest";
import { documentFor } from "../src/forum/templates/op";
import {
  collectionsListingOp, commentByIdOp, commentForestOps, multiDocumentByIdOp, postByIdOp, postsByIdsOp, revisionListOp, tagByIdOp,
} from "../src/forum/templates/shared";
import type { GqlOp } from "../src/types";
import { createFakeForum, type FakeForum } from "./fakeForum";
import { gqlEntry, rawCommentList, rawMdocRef, rawPostFull, rawPostRef, rawRevRow, rawTagRef, seedId } from "./support/builders";
import { lintGraphql, lintSearch, recordConfirmations, type LintHistory } from "./support/lint";
import { CATALOG, confirmed } from "./support/templateCatalog";

const AGI = "uMQ3cqWDPHhjtiesc";
/** A made-up post, the one these tests make hidden. */
const SAMPLE_POST = "samplePost0000001";
const SAMPLE_POST_REF = { _id: SAMPLE_POST, title: "A sample post", slug: "a-sample-post" };
const fresh = (): LintHistory => ({ confirmed: new Set() });
const L = (query: string, h = fresh()) => lintGraphql(parse(query), h);
const D = (...ops: GqlOp[]) => parse(documentFor("t", ops));

describe("lintGraphql: the ¶9.3 bullets", () => {
  it("R1 Q7 exactly one view key, never a view term", () => {
    expect(L("query t { a: posts(selector: {new: {}, old: {}}, limit: 5) { results { _id } } }")).toContain("R1 a: 2 view keys");
    expect(L("query t { a: posts(limit: 5) { results { _id } } }")).toContain("R1 a: 0 view keys");
    expect(L('query t { a: posts(selector: {new: {view: "top"}}, limit: 5) { results { _id } } }')).toContain("R1 a: view term in posts.new");
  });

  it("R2 Q1 Q2 Q18 an explicit limit within policy, never inside a view", () => {
    expect(L("query t { a: posts(selector: {new: {}}) { results { _id } } }")).toContain("R2 a: no limit on posts");
    expect(L("query t { a: posts(selector: {new: {}}, limit: 6000) { results { _id } } }")).toContain("R2 a: limit 6000 on posts outside 1–5000");
    expect(L('query t { a: comments(selector: {allRecentComments: {limit: "2"}}, limit: 10) { results { _id } } }')).toContain(
      "R2 a: limit term in comments.allRecentComments",
    );
    expect(L("query t { f: RecentDiscussionFeed(limit: 25) { cutoff } }")).toContain("R2 f: limit 25 on RecentDiscussionFeed over 20");
    expect(L('query t { g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui") { totalCount } }')).toContain("R2 g: no limit on TagsByCoreTagId");
  });

  it("Q4 offsets stay within 0–2000", () => {
    expect(L("query t { a: posts(selector: {top: {}}, limit: 5, offset: 2001) { results { _id } } }")).toContain(
      "Q4 a: offset 2001 on posts outside 0–2000",
    );
  });

  it("R4 Q10 Q11 no variables; Date literals and date terms exactly YYYY-MM-DDTHH:MM:SS.SSSZ", () => {
    expect(L("query t($c: Date) { f: RecentDiscussionFeed(limit: 5, cutoff: $c) { cutoff } }")).toContain("R4 t: variables are not allowed");
    expect(L('query t { f: RecentDiscussionFeed(limit: 5, cutoff: "2026-10-21") { cutoff } }')).toContain(
      'R4 f: RecentDiscussionFeed.cutoff "2026-10-21" is not YYYY-MM-DDTHH:MM:SS.SSSZ',
    );
    expect(L('query t { a: posts(selector: {new: {after: "2024-01-01"}}, limit: 5) { results { _id } } }')).toContain(
      'R4 a: posts.new.after "2024-01-01" is not YYYY-MM-DDTHH:MM:SS.SSSZ',
    );
  });

  it("R8 P9 forbidden roots, views, terms and fields", () => {
    expect(L("query t { a: posts(selector: {drafts: {}}, limit: 5) { results { _id } } }")).toContain("R8 a: view posts.drafts is not allowed");
    expect(L("query t { a: LastCuratedDate { lastCuratedDate } }")).toContain("R8 a: root LastCuratedDate is not allowed");
    expect(L("query t { a: comments(selector: {allRecentComments: {authorIsUnreviewed: false}}, limit: 5) { results { _id } } }")).toContain(
      "P9 a: term authorIsUnreviewed in comments.allRecentComments",
    );
    expect(L(`query t { p: post(selector: {_id: "${AGI}"}, allowNull: true) { result { _id htmlBody } } }`)).toContain("R8 Post.htmlBody is denied");
  });

  it("R12 Q122 every join carries its reference fragment", () => {
    expect(L('query t { c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { _id post { _id title } } } }')).toContain(
      "R12 Comment.post (Post) lacks POST_REF",
    );
  });

  it("R8 Q19 no af on RecentDiscussionFeed; R4 Q74 no sortBy on topShortform; R5 Q17 allowNull only on post, comment, sequence", () => {
    expect(L("query t { f: RecentDiscussionFeed(limit: 5, af: true) { cutoff } }")).toContain("R8 f: af on RecentDiscussionFeed");
    expect(L("query t { a: comments(selector: {topShortform: {sortBy: top}}, limit: 5) { results { _id } } }")).toContain("R4 a: sortBy on topShortform");
    expect(L('query t { u: user(selector: {_id: "nmk3nLpQE89dMRzzN"}, allowNull: true) { result { _id } } }')).toContain("R5 u: allowNull on user");
  });

  it("R3 no empty id list", () => {
    expect(L("query t { a: posts(selector: {default: {exactPostIds: []}}, limit: 1) { results { _id } } }")).toContain(
      "R3 a: empty exactPostIds in posts.default",
    );
  });

  it("P10 Q57 enableTotal only on bounded selectors", () => {
    expect(L("query t { a: posts(selector: {new: {}}, limit: 5, enableTotal: true) { results { _id } } }")).toContain("P10 a: enableTotal on posts.new");
    expect(L(`query t { a: posts(selector: {default: {exactPostIds: ["${AGI}"]}}, limit: 1, enableTotal: true) { results { _id } } }`)).toContain(
      "P10 a: enableTotal on posts.default",
    );
  });

  it("R7 fieldName on revisionsOnDocument, only userId on revisionsByUser, the Required filter on tagRelevance", () => {
    const h = fresh();
    h.confirmed.add("doc:zHhGa3iQBQcdSifFL");
    expect(L('query t { l: revisions(selector: {revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL"}}, limit: 10) { results { _id } } }', h)).toContain(
      "R7 l: revisionsOnDocument without fieldName",
    );
    expect(
      L('query t { w: revisions(selector: {revisionsByUser: {userId: "nmk3nLpQE89dMRzzN", after: "2024-01-01T00:00:00.000Z"}}, limit: 10) { results { _id } } }'),
    ).toContain("R7 w: revisionsByUser term after");
    expect(L('query t { a: posts(selector: {tagRelevance: {tagId: "56yXXrcxRjrQs6z9R"}}, limit: 5) { results { _id } } }')).toContain(
      "R7 a: tagRelevance without the Required filter for its tagId",
    );
  });

  it("Q99 changeMetrics only on revision rows", () => {
    expect(L(`query t { p: post(selector: {_id: "${AGI}"}, allowNull: true) { result { _id contents { changeMetrics } } } }`)).toContain(
      "Q99 Revision.changeMetrics under contents",
    );
  });

  it("R11 Q16 at most 100 aliases per operation; C2 every operation validates", () => {
    const aliases = Array.from({ length: 101 }, (_, i) => `a${i}: post(selector: {_id: "${AGI}"}, allowNull: true) { result { _id } }`).join(" ");
    expect(L(`query t { ${aliases} }`)).toContain("R11 t: 101 aliases (at most 100)");
    expect(L(`query t { p: post(selector: {_id: "${AGI}"}, allowNull: true) { result { _id noSuchField } } }`)).toContain(
      'C2 t: Cannot query field "noSuchField" on type "Post".',
    );
  });

  it("C2 R1–R12 every CATALOG entry passes the lint once the subjects of its excluded paths are confirmed", () => {
    const subject = (text: string) => /\b(?:postId|tagId|documentId|sequenceId|_id): "([A-Za-z0-9]+)"/.exec(text)![1];
    for (const entry of CATALOG) {
      const ops = entry.build();
      const h = fresh();
      for (const o of ops) if (o.publicSubject) h.confirmed.add(`${o.publicSubject}:${subject(o.text)}`);
      expect(lintGraphql(parse(documentFor(ops[0].template, ops)), h), entry.name).toEqual([]);
    }
  });
});

describe("recordConfirmations: the P17 sources", () => {
  it("P17 a single-root result that passes the flags confirms its subject under its kind and as doc", () => {
    const h = fresh();
    recordConfirmations(D(postByIdOp("p", AGI, "...POST_REF")), { data: { p: { result: rawPostRef() } } }, h);
    expect([...h.confirmed].sort()).toEqual(["doc:uMQ3cqWDPHhjtiesc", "post:uMQ3cqWDPHhjtiesc"]);
  });

  it("P17 P2 P5 P6 P12 a hidden document confirms nothing; a public comment with a hidden join confirms only itself", () => {
    const h = fresh();
    // A made-up post and comment.
    recordConfirmations(D(postByIdOp("p", SAMPLE_POST, "...POST_REF")), { data: { p: { result: rawPostRef({ ...SAMPLE_POST_REF, rejected: true }) } } }, h);
    const comment = (o: object) => ({ data: { c: { result: { ...rawCommentList({ _id: "sampleComment0001", postId: SAMPLE_POST }), post: null, ...o } } } });
    const c = D(commentByIdOp("c", "sampleComment0001", "...COMMENT_REF post { ...POST_REF } tag { ...TAG_REF }"));
    recordConfirmations(c, comment({ deleted: true, deletedPublic: false }), h);
    recordConfirmations(c, comment({ deleted: true, deletedPublic: true }), h);
    recordConfirmations(c, comment({ authorIsUnreviewed: true, postedAt: "2024-01-01T00:00:00.000Z" }), h);
    recordConfirmations(D(tagByIdOp("t", "56yXXrcxRjrQs6z9R", "...TAG_REF")), { data: { t: { result: rawTagRef({ adminOnly: true }) } } }, h);
    expect([...h.confirmed]).toEqual([]);
    const pub = fresh();
    recordConfirmations(c, comment({ tag: rawTagRef({ adminOnly: true }) }), pub);
    expect([...pub.confirmed].sort()).toEqual(["comment:sampleComment0001", "doc:sampleComment0001"]);
  });

  it("P17 P1 P4 P12 joins: a comment's post and tag, a post's canonicalSequence, a lens's page", () => {
    const h = fresh();
    recordConfirmations(
      D(commentByIdOp("c", "HRDoDnHv8bvoW7oPZ", "...COMMENT_REF post { ...POST_REF } tag { ...TAG_REF }")),
      { data: { c: { result: { ...rawCommentList(), tag: rawTagRef() } } } },
      h,
    );
    expect([...h.confirmed].sort()).toEqual([
      "comment:HRDoDnHv8bvoW7oPZ", "doc:56yXXrcxRjrQs6z9R", "doc:HRDoDnHv8bvoW7oPZ", "doc:uMQ3cqWDPHhjtiesc", "post:uMQ3cqWDPHhjtiesc", "tag:56yXXrcxRjrQs6z9R",
    ]);
    const h2 = fresh();
    const canonical = { _id: "sampleSeqHidden01", title: "A hidden sequence", af: false, hidden: true, canonicalCollectionSlug: null };
    recordConfirmations(D(postByIdOp("p", SAMPLE_POST, "...POST_FULL")), { data: { p: { result: rawPostFull({ ...SAMPLE_POST_REF, canonicalSequence: canonical }) } } }, h2);
    expect(h2.confirmed.has("sequence:sampleSeqHidden01")).toBe(true);
    const h3 = fresh();
    recordConfirmations(D(multiDocumentByIdOp("m", seedId(101), "...MDOC_REF")), { data: { m: { result: rawMdocRef() } } }, h3);
    expect([...h3.confirmed].sort()).toEqual(["doc:RkznxXmmh9b5ovdSq", `doc:${seedId(101)}`, "tag:RkznxXmmh9b5ovdSq"]);
  });

  it("P17 the row sources: exactPostIds rows, Book.sequences rows, revision rows of a confirmed document", () => {
    const h = fresh();
    recordConfirmations(D(postsByIdsOp("h", [AGI], "...POST_REF")!), { data: { h: { results: [rawPostRef()] } } }, h);
    expect(h.confirmed.has("post:uMQ3cqWDPHhjtiesc")).toBe(true);
    const book = { _id: "book1", title: "Map and Territory", subtitle: null, number: 1, postedAt: "2017-01-01T00:00:00.000Z", sequenceIds: ["5g5TkQTe9rmPS5vvM"], sequences: [{ _id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", af: false, hidden: false }] };
    recordConfirmations(D(collectionsListingOp()), { data: { col: { results: [{ _id: "oneQyj4pw77ynzwAF", slug: "rationality", title: "Rationality: A-Z", books: [book] }] } } }, h);
    expect(h.confirmed.has("sequence:5g5TkQTe9rmPS5vvM")).toBe(true);
    const list = D(revisionListOp("l", confirmed("doc", "zHhGa3iQBQcdSifFL"), "contents", {}));
    const answer = { data: { l: { results: [rawRevRow({ _id: "aaaaaaaaaaaaaaaaa" })] } } };
    recordConfirmations(list, answer, h);
    expect(h.confirmed.has("revision:aaaaaaaaaaaaaaaaa")).toBe(false);
    h.confirmed.add("doc:zHhGa3iQBQcdSifFL");
    recordConfirmations(list, answer, h);
    expect(h.confirmed.has("revision:aaaaaaaaaaaaaaaaa")).toBe(true);
  });
});

describe("the fake forum lints every request", () => {
  const fixtures = [
    gqlEntry({ root: "post", id: AGI }, { result: rawPostRef() }, "§4.3"),
    gqlEntry({ root: "comments", view: "postCommentsOld", terms: { postId: AGI } }, { results: [] }, "§8.2"),
    gqlEntry({ root: "comments", view: "answersAndReplies", terms: { postId: AGI } }, { results: [] }, "§8.8"),
  ];
  const send = (f: FakeForum, ops: GqlOp[]) =>
    f.fetchImpl("https://www.lesswrong.com/graphql", { method: "POST", body: JSON.stringify({ query: documentFor(ops[0].template, ops), operationName: ops[0].template }) });
  const forest = () => commentForestOps(confirmed("post", AGI), false);

  it("P17 Q71 an excluded path is clean only after an earlier response confirmed its subject", async () => {
    const early = createFakeForum({ fixtures });
    await send(early, forest());
    expect(early.lintErrors).toEqual([
      "P17 c: comments.postCommentsOld for post uMQ3cqWDPHhjtiesc before a response confirmed it public",
      "P17 a: comments.answersAndReplies for post uMQ3cqWDPHhjtiesc before a response confirmed it public",
    ]);
    const inOrder = createFakeForum({ fixtures });
    await send(inOrder, [postByIdOp("p", AGI, "...POST_REF")]);
    await send(inOrder, forest());
    expect(inOrder.lintErrors).toEqual([]);
    const off = createFakeForum({ fixtures, lint: false });
    await send(off, forest());
    expect(off.lintErrors).toEqual([]);
  });

  it("P17 every operation of an array body is linted before any is answered: a confirmation in one cannot excuse the other", async () => {
    const f = createFakeForum({ fixtures });
    const confirm = [postByIdOp("p", AGI, "...POST_REF")];
    const body = [confirm, forest()].map((ops) => ({ query: documentFor(ops[0].template, ops), operationName: ops[0].template }));
    const res = await f.fetchImpl("https://www.lesswrong.com/graphql", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(f.lintErrors).toEqual([
      "P17 c: comments.postCommentsOld for post uMQ3cqWDPHhjtiesc before a response confirmed it public",
      "P17 a: comments.answersAndReplies for post uMQ3cqWDPHhjtiesc before a response confirmed it public",
    ]);
    // Once that body's answers are in, the confirmation holds for the next request.
    await send(f, forest());
    expect(f.lintErrors).toHaveLength(2);
  });

  it("search bodies are linted too", async () => {
    const f = createFakeForum({ fixtures: [] });
    await f.fetchImpl("https://www.lesswrong.com/api/search", {
      method: "POST",
      body: JSON.stringify({ options: { emptyStringSearchResults: "empty" }, queries: [{ indexName: "posts,comments", params: { query: "x", hitsPerPage: 10, page: 0 } }] }),
    });
    expect(f.lintErrors).toContain("search posts,comments: not one index with a known sort");
  });
});

describe("lintSearch", () => {
  const body = (indexName: string, params: Record<string, unknown> = {}) => ({
    options: { emptyStringSearchResults: "empty" },
    queries: [{ indexName, params: { query: "x", hitsPerPage: 10, page: 0, highlightPreTag: "**", highlightPostTag: "**", ...params } }],
  });

  it("Q24 Q128 one index per query; known sorts; facets only from the per-index table, one value per inner array", () => {
    expect(lintSearch(body("posts"))).toEqual([]);
    expect(lintSearch(body("posts_newest_first", { facetFilters: [["tags._id:-56yXXrcxRjrQs6z9R"], ["userId:nmk3nLpQE89dMRzzN"], ["af:true"]] }))).toEqual([]);
    expect(lintSearch(body("posts,comments"))).toEqual(["search posts,comments: not one index with a known sort"]);
    expect(lintSearch(body("sequences_karma"))).toEqual(["search sequences_karma: sort karma not allowed on sequences"]);
    expect(lintSearch(body("comments", { hitsPerPage: 20, facetFilters: [["postId:uMQ3cqWDPHhjtiesc"]] }))).toEqual([
      'search comments: facet "postId:uMQ3cqWDPHhjtiesc" not in the facet table',
    ]);
    expect(lintSearch(body("comments", { hitsPerPage: 20, facetFilters: [["tags._id:-56yXXrcxRjrQs6z9R"]] }))).toEqual([
      'search comments: facet "tags._id:-56yXXrcxRjrQs6z9R" not in the facet table',
    ]);
    expect(lintSearch(body("comments", { hitsPerPage: 20, facetFilters: [["af:true", "userId:nmk3nLpQE89dMRzzN"]] }))).toEqual([
      "search comments: inner facet array with 2 values",
    ]);
  });

  it("Q127 page sizes within the caps and the 4 MB estimate", () => {
    expect(lintSearch(body("posts", { hitsPerPage: 11 }))).toEqual(["search posts: hitsPerPage 11 over 10"]);
    const big = {
      options: { emptyStringSearchResults: "empty" },
      queries: Array.from({ length: 14 }, (_, page) => ({ indexName: "posts", params: { query: "x", hitsPerPage: 10, page, highlightPreTag: "**", highlightPostTag: "**" } })),
    };
    expect(lintSearch(big)).toEqual(["search: estimated 4300800 bytes over 4194304"]);
  });

  it("Q35 Q36 integer numeric filters on two different fields, posts and comments only; never aroundLatLng", () => {
    expect(lintSearch(body("posts", { numericFilters: ["publicDateMs>=1704067200000", "postedAt<1735689600000"] }))).toEqual([]);
    expect(lintSearch(body("posts", { numericFilters: ["publicDateMs>=2024-01-01"] }))).toEqual([
      'search posts: numeric filter "publicDateMs>=2024-01-01" is not an integer >= or < bound on publicDateMs or postedAt',
    ]);
    expect(lintSearch(body("posts", { numericFilters: ["publicDateMs>=1704067200000", "publicDateMs<1735689600000"] }))).toEqual([
      "search posts: closed date range on one field publicDateMs",
    ]);
    expect(lintSearch(body("users", { numericFilters: ["publicDateMs>=1704067200000"] }))).toEqual(["search users: numeric filters on users"]);
    expect(lintSearch(body("users", { aroundLatLng: "0,0" }))).toEqual(["search users: aroundLatLng"]);
    expect(lintSearch(body("users", { attributesToRetrieve: ["x"] }))).toEqual(["search users: unknown parameter attributesToRetrieve"]);
  });
});
