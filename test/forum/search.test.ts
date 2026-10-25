// test/forum/search.test.ts
import { describe, expect, it } from "vitest";
import { createCallContext } from "../../src/call/context";
import { FACETS, buildSearch, buildText, createSearch, estimateBytes, indexName, searchBody } from "../../src/forum/search";
import type { ClassifiedPhrase, EsQuery, Http, HttpRequest, SearchSpec } from "../../src/types";
import { loadFamilies } from "../support/fixtures";
import { forumStack } from "../support/forumStack";

const ph = (given: string, sent: string, mode: ClassifiedPhrase["mode"]): ClassifiedPhrase => ({ given, sent, mode, needle: given.toLowerCase() });
const MESA = ph("mesa-optimizer", "mesa optimizer", "exact"); // §5.2: hyphen = space in phrases
const NEWCOMB = ph("Newcomb's problem", "Newcomb problem", "rewritten"); // §5.2 apostrophe rule
const DONT = ph("don't trust", "don trust", "rewritten");
const GPT = ph("GPT-4.5", "GPT 4 5", "loose"); // §5.2: the dot is deleted inside quotes
const GODEL = ph("Gödel", "Gödel", "loose"); // §5.2: non-ASCII deleted inside quotes
const ANDOR = ph("and/or", "and or", "loose");
const RD = ph("R&D", "R D", "loose");
const spec = (o: Partial<SearchSpec>): SearchSpec => ({ index: "posts", sort: "relevance", page: 0, ...o });
const failure = (detail: string) => `Unexpected failure in search (${detail}). Please report this.`;
const q = (query: string, page = 0): EsQuery => ({ indexName: "posts", params: { query, hitsPerPage: 10, page, highlightPreTag: "**", highlightPostTag: "**" } });
/** An Http that answers every search body with `text` (status 200), recording requests and evictions. */
function answering(text: (queryCount: number) => string) {
  const reqs: HttpRequest[] = [];
  const evicted: string[][] = [];
  const http: Http = {
    fetch: async (r) => {
      reqs.push(r);
      const body = text((JSON.parse(r.body) as { queries: unknown[] }).queries.length);
      return { status: 200, text: body, ms: 0, bytes: body.length, cached: false, cacheKey: "http:k" };
    },
    evict: (keys) => void evicted.push([...keys]),
  };
  return { http, reqs, evicted };
}
const emptyResults = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ hits: [], nbHits: 0, page: 0, nbPages: 0, hitsPerPage: 10, index: "posts" })));

describe("query text (¶4.2 step 2, §5.2)", () => {
  it.each([
    ["Q29 Q135 exact and rewritten phrases are quoted", { phrases: [MESA, NEWCOMB, DONT] }, { text: '"mesa optimizer" "Newcomb problem" "don trust"', simple: false, excludeLocally: false }],
    ["Q30 query words, a phrase and an exclude", { query: "corrigibility", phrases: [MESA], exclude: ["shutdown"] }, { text: 'corrigibility "mesa optimizer" -shutdown', simple: false, excludeLocally: false }],
    ["Q30 exclude without phrases switches to advanced mode", { query: "corrigibility", exclude: ["shutdown"] }, { text: "corrigibility -shutdown", simple: false, excludeLocally: false }],
    ["Q29 every phrase loose: simple mode, exclude applied locally", { phrases: [GPT, GODEL, ANDOR, RD], exclude: ["benchmark"] }, { text: "GPT 4 5 Gödel and or R D", simple: true, excludeLocally: true }],
    ["a loose phrase beside an exact one is sent as plain words", { query: "scaling", phrases: [MESA, GPT] }, { text: 'scaling "mesa optimizer" GPT 4 5', simple: false, excludeLocally: false }],
    ["query only", { query: "inner alignment" }, { text: "inner alignment", simple: true, excludeLocally: false }],
    ["nothing at all (filter-only listing)", {}, { text: "", simple: true, excludeLocally: false }],
  ] as const)("%s", (_name, o, expected) => {
    expect(buildText(spec(o as Partial<SearchSpec>))).toEqual(expected);
  });
});

describe("buildSearch", () => {
  it("Q24 index names carry the sort suffix; sequences refuse karma", () => {
    expect([indexName("posts", "relevance"), indexName("posts", "new"), indexName("comments", "old"), indexName("users", "top"), indexName("tags", "relevance"), indexName("sequences", "new")]).toEqual(
      ["posts", "posts_newest_first", "comments_oldest_first", "users_karma", "tags", "sequences_newest_first"],
    );
    expect(() => indexName("sequences", "top")).toThrow(failure("sequences can't be sorted by karma"));
  });

  it("Q128 the per-index facet table", () => {
    expect(FACETS).toEqual({ posts: ["af", "userId", "tags._id"], comments: ["af", "userId", "postId.keyword", "tags"], users: ["af"], tags: ["wikiOnly"], sequences: ["af"] });
    expect(() => buildSearch([spec({ index: "comments", facets: [{ field: "wikiOnly", value: true }] })])).toThrow(failure("facet wikiOnly is not in the table for comments"));
    expect(() => buildSearch([spec({ index: "users", facets: [{ field: "userId", value: "nmk3nLpQE89dMRzzN" }] })])).toThrow(failure("facet userId is not in the table for users"));
    expect(() => buildSearch([spec({ index: "sequences", facets: [{ field: "userId", value: "nmk3nLpQE89dMRzzN" }] })])).toThrow(failure("facet userId is not in the table for sequences"));
    expect(() => buildSearch([spec({ index: "comments", facets: [{ field: "tags._id", value: "56yXXrcxRjrQs6z9R", negate: true }] })])).toThrow(failure("facet tags._id is not in the table for comments"));
  });

  it("Q37 Q35 Q36 comments: one inner array per facet, postId.keyword, and two-field integer date filters", () => {
    expect(
      buildSearch([
        spec({
          index: "comments", sort: "new", query: "orthogonality",
          facets: [{ field: "af", value: true }, { field: "userId", value: "nmk3nLpQE89dMRzzN" }, { field: "postId.keyword", value: "uMQ3cqWDPHhjtiesc" }, { field: "tags", value: "sYm3HiWcfZvrGu3ui" }],
          range: { start: 1704067200000, endExclusive: 1735689600000 },
        }),
      ]),
    ).toEqual([
      {
        indexName: "comments_newest_first",
        params: {
          query: "orthogonality", hitsPerPage: 20, page: 0,
          facetFilters: [["af:true"], ["userId:nmk3nLpQE89dMRzzN"], ["postId.keyword:uMQ3cqWDPHhjtiesc"], ["tags:sYm3HiWcfZvrGu3ui"]],
          numericFilters: ["publicDateMs>=1704067200000", "postedAt<1735689600000"],
          highlightPreTag: "**", highlightPostTag: "**",
        },
      },
    ]);
  });

  it("Q38 the one negated facet is tags._id on posts; facet values must be ids", () => {
    expect(buildSearch([spec({ sort: "top", query: "interpretability", facets: [{ field: "tags._id", value: "56yXXrcxRjrQs6z9R", negate: true }, { field: "userId", value: "nmk3nLpQE89dMRzzN" }] })])[0].params.facetFilters).toEqual(
      [["tags._id:-56yXXrcxRjrQs6z9R"], ["userId:nmk3nLpQE89dMRzzN"]],
    );
    expect(() => buildSearch([spec({ facets: [{ field: "userId", value: "a:b" }] })])).toThrow(failure("facet value for userId is not an id"));
    expect(() => buildSearch([spec({ index: "posts", facets: [{ field: "userId", value: "nmk3nLpQE89dMRzzN", negate: true } as never] })])).toThrow(failure("negated facet userId on posts"));
  });

  it("Q127 page sizes are the per-index caps; a smaller page is allowed, a larger one refused", () => {
    expect((["posts", "comments", "users", "tags", "sequences"] as const).map((index) => buildSearch([spec({ index })])[0].params.hitsPerPage)).toEqual([10, 20, 10, 10, 20]);
    expect(buildSearch([spec({ index: "tags", hitsPerPage: 3, facets: [{ field: "wikiOnly", value: true }] })])[0].params).toMatchObject({ hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] });
    expect(() => buildSearch([spec({ hitsPerPage: 11 })])).toThrow(failure("hitsPerPage 11 over 10 for posts"));
  });

  it("Q22 depth: page × hitsPerPage + hitsPerPage ≤ 10,000; date filters only on posts and comments", () => {
    expect(() => buildSearch([spec({ page: 999 })])).not.toThrow();
    expect(() => buildSearch([spec({ page: 1000 })])).toThrow(failure("page 1000 past the depth of 10,000"));
    expect(() => buildSearch([spec({ index: "users", range: { start: 1704067200000 } })])).toThrow(failure("date filters on users"));
  });

  it("Q127 estimateBytes and the exact POST body", () => {
    const queries = buildSearch([spec({ phrases: [ph("inner alignment", "inner alignment", "exact")] }), spec({ index: "comments", page: 1 })]);
    expect(estimateBytes(queries)).toBe(10 * 30720 + 20 * 3072);
    expect(searchBody(queries.slice(0, 1), "empty")).toBe(
      '{"options":{"emptyStringSearchResults":"empty"},"queries":[{"indexName":"posts","params":{"query":"\\"inner alignment\\"","hitsPerPage":10,"page":0,"highlightPreTag":"**","highlightPostTag":"**"}}]}',
    );
    expect(JSON.parse(searchBody(queries, "default")).options).toEqual({ emptyStringSearchResults: "default" });
  });

  it("Q127 Q24 the estimate keys on the index before its first '_'; an unknown or multi-index name counts at the largest per-hit size", () => {
    expect(estimateBytes([{ ...q("x"), indexName: "users_karma" }, { ...q("x"), indexName: "tags" }, { ...q("x"), indexName: "sequences_oldest_first" }])).toBe(
      10 * 20480 + 10 * 15360 + 10 * 3072,
    );
    expect(estimateBytes([{ ...q("x"), indexName: "posts,comments" }, { ...q("x"), indexName: "constructor" }])).toBe(2 * 10 * 30720);
  });
});

describe("createSearch", () => {
  it("Q27 parses the text/plain JSON answer into one SearchResult per query", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport") });
    const [r] = await createSearch(s.http)([q('"inner alignment"')], s.ctx("search"), "searching");
    expect(r).toEqual({
      hits: [{ objectID: "uMQ3cqWDPHhjtiesc", _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", _snippetResult: { body: { value: "…the **inner alignment** problem…" } } }],
      nbHits: 569, page: 0, nbPages: 57, hitsPerPage: 10, index: "posts",
    });
    expect(JSON.parse(s.forum.requests[0].body)).toEqual({ options: { emptyStringSearchResults: "empty" }, queries: [q('"inner alignment"')] });
  });

  it("Q23 Q22 the depth error ends every query of that body; it is not an error", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport"), lint: false });
    const results = await createSearch(s.http)([q('"inner alignment"', 0), q('"inner alignment"', 1000)], s.ctx("search"), "searching");
    expect(results).toEqual([
      { hits: [], nbHits: 0, page: 0, nbPages: null, hitsPerPage: 10, index: "posts", ended: true },
      { hits: [], nbHits: 0, page: 1000, nbPages: null, hitsPerPage: 10, index: "posts", ended: true },
    ]);
  });

  it("Q86 any other 400 message is an internal error", async () => {
    const http: Http = { fetch: async () => ({ status: 400, text: "Invalid facet: x", ms: 0, bytes: 16, cached: false, cacheKey: "http:k" }), evict: () => {} };
    await expect(createSearch(http)([q("x")], createCallContext("search", { now: () => 0 }), "searching")).rejects.toMatchObject({
      category: "internal",
      message: "Unexpected failure in search (search: Invalid facet: x). Please report this.",
    });
  });

  it("Q86 an empty 500 is retried once, then forum_error \"the forum's search failed\"", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport") });
    s.forum.inject({ endpoint: "search", status: 500, times: 2 });
    await expect(createSearch(s.http)([q('"inner alignment"')], s.ctx("search"), "searching")).rejects.toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while searching (the forum's search failed). Try again later.",
    });
    expect(s.forum.requests).toHaveLength(2);
  });

  it("¶7 Q127 a body over the 4 MB estimate is refused before anything is sent; 13 post pages fit", async () => {
    const reqs: HttpRequest[] = [];
    const empty = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ hits: [], nbHits: 0, page: 0, nbPages: 0, hitsPerPage: 10, index: "posts" })));
    const http: Http = {
      fetch: async (r) => {
        reqs.push(r);
        const n = (JSON.parse(r.body) as { queries: unknown[] }).queries.length;
        return { status: 200, text: empty(n), ms: 0, bytes: 0, cached: false, cacheKey: "http:k" };
      },
      evict: () => {},
    };
    const pages = (n: number) => Array.from({ length: n }, (_, page) => q("x", page));
    const ctx = createCallContext("search", { now: () => 0 });
    await expect(createSearch(http)(pages(14), ctx, "searching")).rejects.toMatchObject({
      category: "internal",
      message: "Unexpected failure in search (search: estimated 4300800 bytes over the 4 MB budget). Please report this.",
    });
    expect(reqs).toHaveLength(0);
    expect(await createSearch(http)(pages(13), ctx, "searching")).toHaveLength(13);
    expect(reqs[0]).toMatchObject({ endpoint: "search", task: "searching", label: "search posts" });
  });

  it("an empty query list sends nothing; emptyString \"default\" lists everything matching the filters", async () => {
    const reqs: HttpRequest[] = [];
    const http: Http = {
      fetch: async (r) => (reqs.push(r), { status: 200, text: JSON.stringify([{ hits: [], nbHits: 0, page: 0, nbPages: 0, hitsPerPage: 10, index: "posts_newest_first" }]), ms: 0, bytes: 0, cached: false, cacheKey: "k" }),
      evict: () => {},
    };
    const ctx = createCallContext("search", { now: () => 0 });
    expect(await createSearch(http)([], ctx, "searching")).toEqual([]);
    expect(reqs).toHaveLength(0);
    await createSearch(http)(buildSearch([spec({ sort: "new", facets: [{ field: "userId", value: "nmk3nLpQE89dMRzzN" }] })]), ctx, "searching", "default");
    expect(JSON.parse(reqs[0].body).options).toEqual({ emptyStringSearchResults: "default" });
  });

  it("the request label names each index once, in the order of the queries", async () => {
    const { http, reqs } = answering(emptyResults);
    const queries = buildSearch([spec({}), spec({ index: "comments", sort: "new" }), spec({ page: 1 })]);
    expect(await createSearch(http)(queries, createCallContext("search", { now: () => 0 }), "searching")).toHaveLength(3);
    expect(reqs[0].label).toBe("search posts,comments_newest_first");
  });

  it.each([
    ["Q27 a body that is not JSON", "{not json", "unexpected non-JSON response (possibly bot protection)"],
    ["fewer results than queries", "[]", "malformed search response"],
    ["an object instead of an array", JSON.stringify({ hits: [] }), "malformed search response"],
    ["a result that is not an object", "[null]", "malformed search response"],
    ["a result without its counts", JSON.stringify([{ hits: [] }]), "malformed search response"],
    ["a hit that is not an object", JSON.stringify([{ hits: [1], nbHits: 1, page: 0, nbPages: 1, hitsPerPage: 10, index: "posts" }]), "malformed search response"],
  ] as const)("¶2.3 a 200 that cannot be read is forum_error and is evicted from the raw-response cache: %s", async (_name, text, short) => {
    const { http, evicted } = answering(() => text);
    await expect(createSearch(http)([q("x")], createCallContext("search", { now: () => 0 }), "searching")).rejects.toMatchObject({
      category: "forum_error",
      message: `The forum returned an error while searching (${short}). Try again later.`,
    });
    expect(evicted).toEqual([["http:k"]]);
  });

  it("§5.6 nbPages may be null (hitsPerPage 0); a readable answer is not evicted", async () => {
    const { http, evicted } = answering(() => JSON.stringify([{ hits: [], nbHits: 569, page: 0, nbPages: null, hitsPerPage: 0, index: "posts", processingTimeMS: 3 }]));
    expect(await createSearch(http)([q("x")], createCallContext("search", { now: () => 0 }), "searching")).toEqual([
      { hits: [], nbHits: 569, page: 0, nbPages: null, hitsPerPage: 0, index: "posts" },
    ]);
    expect(evicted).toEqual([]);
  });
});
