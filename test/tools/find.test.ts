import { describe, it, expect } from "vitest";
import { findSearchSpecs } from "../../src/tools/find";
import { findHydrateOps } from "../../src/forum/templates/find";
import { documentFor } from "../../src/forum/templates/op";
import { buildSearch, estimateBytes } from "../../src/forum/search";
import { cachedResolution } from "../../src/ids/resolve";
import { createCallContext } from "../../src/call/context";
import { createHarness, expectClean } from "../support/harness";
import {
  ROB_BENSINGER, SAMPLE_PERSON, forestEntries, gqlEntry, manyTagHitsFor, paulCommentsOnAgiRuin, rawCommentTree, rawPostCard, rawSeqCard, rawTagCard, rawTagFull, rawUserCard,
  robCommentsOnAgiRuin, samplePersonEntry, samplePersonOnAgiRuin, searchEntry,
} from "../support/builders";
import { printedCursor } from "../support/requests";
import { loadFamilies, type FixtureEntry } from "../support/fixtures";

const FAMS = ["posts", "users", "tags", "sequences", "search", "comments"] as const;
const h0 = (extra = paulCommentsOnAgiRuin()) => createHarness({ families: FAMS, extra });
const searchBody = (h: ReturnType<typeof h0>) => JSON.parse(h.forum.requests.find((r) => r.endpoint === "search")!.body);
const paramsOf = (h: ReturnType<typeof h0>) => searchBody(h).queries.map((q: { indexName: string; params: Record<string, unknown> }) => ({ indexName: q.indexName, ...q.params }));

describe("find", () => {
  it("find_graphql: the one hydrate request, exact text and alias rule", () => {
    const text = documentFor("find_graphql", findHydrateOps({ postIds: ["uMQ3cqWDPHhjtiesc", "zHhGa3iQBQcdSifFL"], postSlugs: ["agi-ruin-a-list-of-lethalities"],
      userIds: ["nmk3nLpQE89dMRzzN"], userSlugs: ["paul-christiano", "paulchristiano", "paul_christiano"], tagIds: ["56yXXrcxRjrQs6z9R"], tagSlugs: ["interpretability"],
      sequenceIds: ["5g5TkQTe9rmPS5vvM"], collections: true, commentedOn: { id: "uMQ3cqWDPHhjtiesc" } }));
    expect(text.startsWith('query find_graphql { p: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc", "zHhGa3iQBQcdSifFL"]}}, limit: 2) { results { ...POST_CARD } } ps: posts(selector: {slugPost: {slug: "agi-ruin-a-list-of-lethalities"}}, limit: 2) { results { ...POST_CARD } } u: users(selector: {usersByUserIds: {userIds: ["nmk3nLpQE89dMRzzN"]}}, limit: 1) { results { ...USER_CARD } } ug1: GetUserBySlug(slug: "paul-christiano") { ...USER_CARD } ug2: GetUserBySlug(slug: "paulchristiano") { ...USER_CARD } ug3: GetUserBySlug(slug: "paul_christiano") { ...USER_CARD } t1: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_CARD } } ts: tags(selector: {tagBySlug: {slug: "interpretability"}}, limit: 1) { results { ...TAG_CARD } } tp: TagPreview(slug: "interpretability") { tag { ...TAG_CARD } lens { ...MDOC_REF } } s: sequences(selector: {default: {sequenceIds: ["5g5TkQTe9rmPS5vvM"]}}, limit: 1) { results { ...SEQ_CARD } } col: collections(selector: {default: {}}, limit: 10) { results { _id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } } } } co: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_CARD } } }')).toBe(true);
    expect(findHydrateOps({ postIds: [], postSlugs: ["a-b", "c-d"], userIds: [], userSlugs: [], tagIds: [], tagSlugs: ["x", "y"], sequenceIds: [], collections: false }).map((o) => o.alias))
      .toEqual(["ps", "ps2", "ts", "tp", "ts2", "tp2"]);
  });

  it("step 2: one query per item and index; at least 10 hits are read, up to the cap; later pages in the same POST", () => {
    const s = (items: Parameters<typeof findSearchSpecs>[0], limit: number, af = false) => findSearchSpecs(items, limit, af).specs.map((x) => [x.index, x.query, x.page, x.hitsPerPage, x.facets ?? []]);
    expect(s([{ kind: "post", query: "AGI Ruin" }], 5)).toEqual([["posts", "AGI Ruin", 0, 10, []]]);
    expect(s([{ kind: "sequence", query: "Predictably Wrong" }], 1)).toEqual([["sequences", "Predictably Wrong", 0, 10, []]]);
    expect(s([{ kind: "post", query: "AGI Ruin" }], 25)).toEqual([["posts", "AGI Ruin", 0, 10, []], ["posts", "AGI Ruin", 1, 10, []], ["posts", "AGI Ruin", 2, 10, []]]);
    expect(s([{ kind: "sequence", query: "Predictably Wrong" }], 25)).toEqual([["sequences", "Predictably Wrong", 0, 20, []], ["sequences", "Predictably Wrong", 1, 20, []]]);
    expect(s([{ kind: "user", query: "Paul Christiano" }], 10, true)).toEqual([["users", "Paul Christiano", 0, 10, [{ field: "af", value: true }]]]);
    // ¶4.1 step 1: a bare 17-character query is searched as well as resolved; a URL or a 24-hex id never is.
    expect(s([{ kind: "tag", query: "Superintelligence" }], 10)).toEqual([["tags", "Superintelligence", 0, 10, []], ["tags", "Superintelligence", 0, 3, [{ field: "wikiOnly", value: true }]]]);
    expect(s([{ kind: "post", query: "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin" }, { kind: "sequence", query: "62bf5f5dc581cd211cc67d49" }], 10)).toEqual([]);
  });

  it("Q33 tag items: the wikiOnly query (hitsPerPage 3) and the abbreviation's long form, reported", () => {
    const r = findSearchSpecs([{ kind: "tag", query: "LLMs" }], 10, false);
    expect(r.specs.map((x) => [x.query, x.hitsPerPage, x.facets ?? []])).toEqual([
      ["LLMs", 10, []], ["LLMs", 3, [{ field: "wikiOnly", value: true }]], ["large language models", 10, []]]);
    expect(r.expansions).toEqual([{ item: 1, short: "LLMs", long: "large language models" }]);
  });

  it("¶7 the largest search request for limit 50 stays within the 4 MB estimate", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ kind: "post" as const, query: `title ${i}` }));
    const specs = findSearchSpecs(items, 50, false).specs;
    expect(estimateBytes(buildSearch(specs))).toBeLessThanOrEqual(4_194_304);
    expect(specs.filter((x) => x.page === 0)).toHaveLength(5); // every item's first page is always sent
  });

  it("¶5b example 2: post + commenter in 3 requests (search, hydrate, forest); P19 counts attributable comments only", async () => {
    const h = h0();
    const out = await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Paul Christiano", commented_on: "item:1" }] });
    expect(out.isError).toBe(false);
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["search", "graphql", "graphql"]);
    expect(searchBody(h).options).toEqual({ emptyStringSearchResults: "empty" });
    expect(paramsOf(h)[0]).toMatchObject({ indexName: "posts", query: "AGI Ruin: A List of Lethalities", page: 0, hitsPerPage: 10 });
    expect(out.text.split("\n").slice(0, 2)).toEqual(["find — 2 items", "Request: items 1–2 · limit 10 (default)"]);
    expect(out.text).toContain('Item 1 · post "AGI Ruin: A List of Lethalities"\n  1. ★ best match (exact title) — "AGI Ruin: A List of Lethalities" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(out.text).toMatch(/  2\. "Reevaluating 'AGI Ruin: A List of Lethalities' in 2026" .*\(search; title contains the query\)/);
    expect(out.text).toContain('Item 2 · user "Paul Christiano" (commenters of post_id uMQ3cqWDPHhjtiesc first)');
    expect(out.text).toContain('  1. ★ best match (commented on this post 3 times) — "paulfchristiano" · user_slug paulfchristiano · user_id paulfchristianoId · karma 30,100');
    expect(out.text).toMatch(/  2\. "ChristianKl" · user_slug christiankl .*\(search; commented on this post 1 time\)/);
    expect(out.text.endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("P19 a commenter's own placeholder and anonymous comment are not counted as theirs", async () => {
    // A made-up person, whose three comments sit beside their own placeholder and anonymous comment on the post.
    const P = SAMPLE_PERSON;
    const card = rawUserCard({ ...P, createdAt: "2020-01-01T00:00:00.000Z", karma: 100, afKarma: 0, postCount: 2, commentCount: 5, groups: [] });
    const h = h0([...samplePersonOnAgiRuin(), samplePersonEntry(),
      searchEntry({ index: "users", query: P.displayName, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: P._id, _id: P._id, displayName: P.displayName }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: [P._id] } }, { results: [card] }, "§3.4")]);
    const out = await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: P.displayName, commented_on: "item:1" }] });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`  1. ★ best match (commented on this post 3 times) — "${P.displayName}" · user_slug ${P.slug}`);
    expectClean(h);
  });

  it("D4 every candidate goes into the resolution cache; a repeated call is answered from the caches", async () => {
    const h = h0(); const args = { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Paul Christiano", commented_on: "item:1" }] };
    await h.call("find", args);
    const c = createCallContext("get_comments", { now: h.clock.now });
    expect(cachedResolution({ kind: "post", form: "slug", value: "agi-ruin-a-list-of-lethalities", given: "slug", notes: [] }, c, h.services)?.id).toBe("uMQ3cqWDPHhjtiesc");
    expect(cachedResolution({ kind: "user", form: "slug", value: "paulfchristiano", given: "slug", notes: [] }, c, h.services)?.id).toBe("paulfchristianoId");
    expect(h.services.caches.get("forest", "post:uMQ3cqWDPHhjtiesc")).toBeDefined();
    const n = h.forum.requests.length;
    await h.call("find", args);
    expect(h.forum.requests.length).toBe(n);
  });

  it("Q88 P3 two kept posts sharing a slug are remembered under their ids only, never under the slug", async () => {
    const twins = ["twinPostA00000001", "twinPostB00000001"];
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      searchEntry({ index: "posts", query: "Twin Title", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: twins.map((id) => ({ objectID: id, _id: id, title: "Twin Title" })), nbHits: 2 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: twins }, limit: 2 }, { results: twins.map((id) => rawPostCard({ _id: id, title: "Twin Title", slug: "twin-title" })) }, "§6.1, Q88"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Twin Title" }] })).text;
    for (const id of twins) expect(out).toContain(`post_id ${id}`);
    expect(out).not.toContain("★");   // two exact titles: no best match
    const c = createCallContext("get_post", { now: h.clock.now });
    expect(cachedResolution({ kind: "post", form: "slug", value: "twin-title", given: "slug", notes: [] }, c, h.services)).toBeUndefined();
    for (const id of twins) expect(cachedResolution({ kind: "post", form: "id", value: id, given: "id", notes: [] }, c, h.services)?.id).toBe(id);
    expectClean(h);
  });

  it("commented_on ignored lines; the forest is never requested for a post that is not public", async () => {
    const h = h0();
    const a = await h.call("find", { items: [{ kind: "post", query: "zzqq" }, { kind: "user", query: "Paul Christiano", commented_on: "item:1" }] });
    expect(a.text).toContain("  commented_on ignored: item 1 has no best match");
    const b = await h.call("find", { items: [{ kind: "user", query: "Paul Christiano", commented_on: "draftPost00000001" }] });
    expect(b.text).toContain("  commented_on ignored: that post is not publicly visible");
    expect(h.forum.requests.some((r) => r.body.includes("postCommentsOld"))).toBe(false);
  });

  it("S15 user best match: exact name, karma ≥ 10 and ten times every other candidate", async () => {
    const h = h0();
    expect((await h.call("find", { items: [{ kind: "user", query: "Milo Moses" }] })).text).toContain('  1. ★ best match (exact name) — "Milo Moses"');
    const outranked = (await h.call("find", { items: [{ kind: "user", query: "Milo M." }] })).text;
    expect(outranked).toContain("  an exact-name account exists, but another candidate has higher karma");
    expect(outranked).not.toContain("★");
    const three = (await h.call("find", { items: [{ kind: "user", query: "Pat Namesake" }] })).text;
    expect(three).toContain("  3 accounts have exactly this display name");
    expect(three).not.toContain("★");
  });

  it("S15 an exact-name account that does not dominate and is not outranked: the header says why", async () => {
    const h = h0([
      searchEntry({ index: "users", query: "Quinnlow", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: "quinnLowUser00001", _id: "quinnLowUser00001", displayName: "Quinnlow" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ["quinnLowUser00001"] }, limit: 1 }, { results: [rawUserCard({ _id: "quinnLowUser00001", slug: "quinn-low", displayName: "Quinnlow", karma: 5 })] }, "§3.4, §5.3"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "quinnlow" } }, null, "§9.1"),
      searchEntry({ index: "users", query: "Rivernear", page: 0, hitsPerPage: 10, facetFilters: [] }, {
        hits: [{ objectID: "riverNearUser0001", _id: "riverNearUser0001", displayName: "Rivernear" }, { objectID: "riverNearFan00001", _id: "riverNearFan00001", displayName: "Rivernear Fan" }], nbHits: 2,
      }, "§3.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ["riverNearUser0001", "riverNearFan00001"] }, limit: 2 }, { results: [
        rawUserCard({ _id: "riverNearUser0001", slug: "river-near", displayName: "Rivernear", karma: 100 }),
        rawUserCard({ _id: "riverNearFan00001", slug: "river-near-fan", displayName: "Rivernear Fan", karma: 50 }),
      ] }, "§3.4"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "rivernear" } }, null, "§9.1"),
    ]);
    const low = (await h.call("find", { items: [{ kind: "user", query: "Quinnlow" }] })).text;
    expect(low).toContain('Item 1 · user "Quinnlow"\n  an exact-name account exists, but its karma is below 10\n');
    expect(low).not.toContain("★");
    const close = (await h.call("find", { items: [{ kind: "user", query: "Rivernear" }] })).text;
    expect(close).toContain('Item 1 · user "Rivernear"\n  an exact-name account exists, but its karma is not ten times that of every other candidate\n');
    expect(close).not.toContain("★");
    expect(close).not.toContain("higher karma");
    expectClean(h);
  });

  it("Q89 slug guesses are labelled as possible namesakes", async () => {
    const out = (await h0().call("find", { items: [{ kind: "user", query: "Habryka" }] })).text;
    expect(out).toContain('"Habryka" · user_slug habryka');
    expect(out).toContain("slug match (may be a namesake)");
  });

  it("Q59 tag hits are hydrated with tag(_id) aliases; alias hits rank before plain search hits", async () => {
    const h = h0();
    const out = (await h.call("find", { items: [{ kind: "tag", query: "mech interp" }] })).text;
    const gql = h.forum.requests.find((r) => r.endpoint === "graphql")!.body;
    expect(gql).toContain('t1: tag(selector: {_id: \\"compInSupTag00001\\"})');
    expect(gql).not.toContain("tagsByTagIds");
    expect(out).toMatch(/  1\. "Interpretability \(ML & AI\)" · tag_slug interpretability-ml-and-ai .*\(alias: mechanistic interpretability\)/);
    expect(out).toMatch(/  2\. "Comp-In-Sup" .*\(search\)/);
    expect(out).toContain('Also searched: "mechanistic interpretability" for "mech interp" (item 1)');
  });

  it("#135 an admin-only page among a tag item's search hits is left out, as the site's search leaves it out", async () => {
    const h = h0([
      searchEntry({ index: "tags", query: "store more features", page: 0, hitsPerPage: 10, facetFilters: [] }, {
        hits: [{ objectID: "adminOnlyTag00001", _id: "adminOnlyTag00001", name: "Admin Only Tag" }, { objectID: "56yXXrcxRjrQs6z9R", _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)" }],
        nbHits: 2,
      }, "§3.4, #135"),
      searchEntry({ index: "tags", query: "store more features", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "store more features" }] })).text;
    expect(out).toContain("tag_id 56yXXrcxRjrQs6z9R");
    for (const s of ["adminOnlyTag00001", "Admin Only Tag", "admin-only"]) expect(out).not.toContain(s);
    expectClean(h);
  });

  it("slug fallback finds a post search hides (negative karma)", async () => {
    const out = (await h0().call("find", { items: [{ kind: "post", query: "A Bad Take On Corrigibility" }] })).text;
    expect(out).toContain("post_id negKarmaPost00001");
    expect(out).toContain("found by slug; not among the search hits read");
  });

  it("Q44 an id or URL query is resolved through GraphQL, never search", async () => {
    const h = h0();
    const out = (await h.call("find", { items: [{ kind: "post", query: "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin" }] })).text;
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["graphql"]);
    expect(out).toContain("  1. ★ best match (identifier) — \"AGI Ruin: A List of Lethalities\"");
  });

  it("¶4.1 step 1 a 17-letter word that resolves as no identifier is searched: Superintelligence lists the page under a not-an-id note", async () => {
    const page = rawTagCard({ _id: "superintelTag0001", name: "Superintelligence", slug: "superintelligence", postCount: 210 });
    const h = h0([
      searchEntry({ index: "tags", query: "Superintelligence", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: page._id, _id: page._id, name: page.name }], nbHits: 1 }, "§3.4"),
      searchEntry({ index: "tags", query: "Superintelligence", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, "§3.4"),
      gqlEntry({ root: "tag", id: page._id }, { result: page }, "§10.2"),
      // the word tried as an id (D1: a missing and a hidden id read alike) and as a slug (the catch-alls: no page has it in this case)
      { source: "§10.2", match: { root: "tag", id: "Superintelligence" }, error: { message: "app.missing_document" } },
      { source: "§10.2", match: { root: "multiDocument", id: "Superintelligence" }, error: { message: "app.missing_document" } },
    ]);
    const out = await h.call("find", { items: [{ kind: "tag", query: "Superintelligence" }] });
    expect(out.isError).toBe(false);
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["search", "graphql"]);
    expect(paramsOf(h)[0]).toMatchObject({ indexName: "tags", query: "Superintelligence", page: 0, hitsPerPage: 10 });
    const gql = h.forum.requests[1]!.body;
    expect(gql).toContain('r1t: tag(selector: {_id: \\"Superintelligence\\"})');
    expect(gql).toContain('t1: tag(selector: {_id: \\"superintelTag0001\\"})');
    expect(out.text).toContain('Item 1 · tag "Superintelligence"\n  not an id or slug: no publicly visible wiki page has the id or slug "Superintelligence"; searched as a name instead\n'
      + '  1. ★ best match (exact name) — "Superintelligence" · tag_slug superintelligence · tag_id superintelTag0001');
    expect(out.text).not.toContain("not resolved");
    expect(out.text.endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("¶4.1 step 1 a real 17-character id gives one identifier candidate and lists no search hit", async () => {
    const h = h0([
      searchEntry({ index: "posts", query: "uMQ3cqWDPHhjtiesc", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: "zHhGa3iQBQcdSifFL", _id: "zHhGa3iQBQcdSifFL" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["zHhGa3iQBQcdSifFL"] }, limit: 1 }, { results: [rawPostCard({ _id: "zHhGa3iQBQcdSifFL", title: "PLANTED-F3-hit", slug: "planted-f3-hit" })] }, "§6.1"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "uMQ3cqWDPHhjtiesc" }] })).text;
    expect(out).toContain('Item 1 · post "uMQ3cqWDPHhjtiesc"\n  1. ★ best match (identifier) — "AGI Ruin: A List of Lethalities"');
    expect(out).not.toContain("PLANTED-F3-hit");
    expect(out).not.toContain("not an id");
    expect(out.endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("P3 P4 unlisted posts and hidden sequences resolve by id, flagged, and are never title or listing candidates", async () => {
    const h = h0();
    expect((await h.call("find", { items: [{ kind: "post", query: "unlistedPost00001" }] })).text).toContain("reachable by link only");
    expect((await h.call("find", { items: [{ kind: "sequence", query: "hiddenSeq00000001" }] })).text).toContain("not in the site's sequence lists");
    const book = (await h.call("find", { items: [{ kind: "sequence", query: "Map and Territory" }] })).text;
    expect(book).toContain('★ best match (book in rationality) — book "Map and Territory" in collection_slug rationality');
    expect(book).toContain("sequence_id 5g5TkQTe9rmPS5vvM");
    expect(book).not.toContain("hiddenSeq00000001");
    expect((await h.call("find", { items: [{ kind: "sequence", query: "The Sequences" }] })).text)
      .toContain('★ best match (collection) — "Rationality: A-Z" · collection_slug rationality');
    expect(h.services.caches.get("collections", "all")).toBeDefined();
  });

  it("#109 commented_on a debate post reads its turns, so the discussion it caches labels replies to them in get_comments", async () => {
    // The forest cache is shared: one find loads without the turns would leave get_comments unable to name a turn's author.
    const D = "qbcuk8WwFnTZcXTd6";
    const h = createHarness({ families: FAMS, extra: [
      searchEntry({ index: "users", query: "Thomas Kwa", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 0 }, "test"),
      ...forestEntries({ post: D }, [
        rawCommentTree({ _id: "turnReply00000001", postId: D, af: false, extendedScore: null, parentCommentId: "kwaTurn0000000001", topLevelCommentId: "kwaTurn0000000001", postedAt: "2023-09-06T18:00:00.000Z" }),
      ]),
    ] });
    await h.call("find", { items: [{ kind: "user", query: "Thomas Kwa", commented_on: D }] });
    expect(h.forum.requests.map((r) => r.body).join("\n")).toContain("debateResponses");
    const n = h.forum.requests.length;
    const out = (await h.call("get_comments", { post: D })).text;
    expect(h.forum.requests.slice(n).map((r) => r.body).join("\n")).not.toContain("postCommentsOld");
    expect(out).toMatch(/reply to a debate turn by "Thomas Kwa" · comment_id turnReply00000001/);
  });

  it("#135 an admin-only page's id resolves, flagged: the site opens it from its URL", async () => {
    const out = (await h0().call("find", { items: [{ kind: "tag", query: "adminOnlyTag00001" }] })).text;
    expect(out).toContain('★ best match (identifier) — "Admin Only Tag" · tag_slug admin-only-tag · tag_id adminOnlyTag00001');
    expect(out).toContain("admin-only (left off posts and out of search)");
    expect(out).not.toContain("not resolved");
  });

  it("P4 a book that lists a sequence twice shows it twice, in the book's order, as the forum's Book.sequences returns it", async () => {
    // Book.sequences loads one row per sequenceIds entry, in order, so a repeated id comes back as a repeated row.
    type Row = { _id: string };
    const listing = loadFamilies("sequences").find((e) => "root" in e.match && e.match.root === "collections")!;
    const copy = JSON.parse(JSON.stringify(listing)) as FixtureEntry & { result: { results: { slug: string; books: { number: number | null; sequenceIds: string[]; sequences: Row[] }[] }[] } };
    const book = copy.result.results.find((c) => c.slug === "rationality")!.books.find((b) => b.number === 1)!;
    const [pw, fb] = ["5g5TkQTe9rmPS5vvM", "fakeBeliefsSeq001"].map((id) => book.sequences.find((r) => r._id === id)!);
    book.sequenceIds = [pw!._id, fb!._id, pw!._id];
    book.sequences = [pw!, fb!, pw!];
    const out = (await h0([copy]).call("find", { items: [{ kind: "sequence", query: "Map and Territory" }] })).text;
    expect(out).toContain('book "Map and Territory" in collection_slug rationality: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM, LW only), '
      + '"Fake Beliefs" (sequence_id fakeBeliefsSeq001, LW only), "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM, LW only)\n');
  });

  it("¶4.1 step 4 a bare collection slug as a sequence query matches its collection, as the alias table does", async () => {
    const expected: Record<string, string> = {
      rationality: '"Rationality: A-Z" · collection_slug rationality', codex: '"The Codex" · collection_slug codex',
      highlights: '"Sequence Highlights" · collection_slug highlights', bestoflesswrong: '"Best of LessWrong" · collection_slug bestoflesswrong',
      hpmor: '"Harry Potter and the Methods of Rationality" · collection_slug hpmor',
    };
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      ...[...Object.keys(expected), "Harry Potter and the Methods of Rationality"].map((q) =>   // "hpmor" is an abbreviation too (Q33)
        searchEntry({ index: "sequences", query: q, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 0 }, "§3.4")),
    ]);
    for (const [slug, line] of Object.entries(expected)) {
      const out = (await h.call("find", { items: [{ kind: "sequence", query: slug }] })).text;
      expect(out, slug).toContain(`  1. ★ best match (collection) — ${line}`);
      expect(out, slug).not.toContain("No candidates match");
    }
    // the slug is compared whole and case-insensitively, never as a title fragment
    expect((await h0([searchEntry({ index: "sequences", query: "Codex", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 0 }, "§3.4")])
      .call("find", { items: [{ kind: "sequence", query: "Codex" }] })).text).toContain('★ best match (collection) — "The Codex" · collection_slug codex');
    expectClean(h);
  });

  it("¶4.1 step 5 the parse notes of commented_on are printed under the item header: a comment permalink's commentId is ignored, and said so", async () => {
    const h = h0();
    const out = (await h.call("find", { items: [
      { kind: "user", query: "Paul Christiano", commented_on: "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin?commentId=HRDoDnHv8bvoW7oPZ" },
    ] })).text;
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["search", "graphql", "graphql"]);
    expect(out).toContain('Item 1 · user "Paul Christiano" (commenters of post_id uMQ3cqWDPHhjtiesc first)\n'
      + "  commentId ignored; pass it as comment to target the comment\n"
      + '  1. ★ best match (commented on this post 3 times) — "paulfchristiano"');
    expectClean(h);
  });

  it("af_only: removed candidates are counted; tag items unaffected; all-tag calls refused", async () => {
    const h = h0();
    const glm = (await h.call("find", { items: [{ kind: "post", query: "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior" }], af_only: true })).text;
    expect(glm).toContain('No candidates match: post "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior".');
    expect(glm).toContain("1 non-AF candidate was left out");
    expect(paramsOf(h)[0].facetFilters).toEqual([["af:true"]]);
    expect((await h.call("find", { items: [{ kind: "tag", query: "mech interp" }], af_only: true })).text)
      .toBe("Error (bad_input): af_only: wiki pages have no AF status. Remove af_only; it does not apply to tag items.");
  });

  it("af_only + commented_on: a commenter whose card was not read is left out as unchecked, never counted as non-AF", async () => {
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      searchEntry({ index: "users", query: "Christiano", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: [], nbHits: 0 }, "§3.4, §5.4"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "christiano" } }, null, "§9.1"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Christiano", commented_on: "item:1" }], af_only: true })).text;
    expect(out).toContain("1 commenter was left out because AF membership could not be checked (repeat without af_only to see them)");
    expect(out).not.toContain("non-AF");
    expectClean(h);
  });

  it("af_only + commented_on: with candidates left, non-AF removals and unchecked commenters are separate note lines", async () => {
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      searchEntry({ index: "users", query: "Christiano", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, {
        hits: [{ objectID: "christianoAfMbr01", _id: "christianoAfMbr01", displayName: "Christiano Afmember" }], nbHits: 1,
      }, "§3.4, §5.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ["christianoAfMbr01"] }, limit: 1 }, {
        results: [rawUserCard({ _id: "christianoAfMbr01", slug: "christiano-afmember", displayName: "Christiano Afmember", karma: 200, groups: ["alignmentForum"] })],
      }, "§3.4"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "christiano" } },
        rawUserCard({ _id: "christianoGuess01", slug: "christiano", displayName: "Christiano", karma: 40, groups: [] }), "§9.1"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Christiano", commented_on: "item:1" }], af_only: true })).text;
    expect(out).toContain('Item 2 · user "Christiano" (commenters of post_id uMQ3cqWDPHhjtiesc first)\n  1 non-AF candidate was left out\n'
      + "  1 commenter was left out because AF membership could not be checked (repeat without af_only to see them)\n"
      + '  1. "Christiano Afmember" · user_slug christiano-afmember');
    expectClean(h);
  });

  it("af_only + commented_on: a commenter's card from a slug guess is checked for AF membership", async () => {
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      searchEntry({ index: "users", query: "paulfchristiano", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: [], nbHits: 0 }, "§3.4, §5.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "paulfchristiano", commented_on: "item:1" }], af_only: true })).text;
    expect(out).toContain('★ best match (commented on this post 3 times) — "paulfchristiano" · user_slug paulfchristiano');
    expectClean(h);
  });

  it("af_only never removes collections or books; the echo says so", async () => {
    const h = h0([
      ...paulCommentsOnAgiRuin(),
      searchEntry({ index: "sequences", query: "The Sequences", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: [], nbHits: 0 }, "§3.4, §5.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "sequence", query: "The Sequences" }], af_only: true })).text;
    expect(out).toContain('★ best match (collection) — "Rationality: A-Z" · collection_slug rationality');
    expect(out).not.toContain("non-AF");
    expect(out.split("\n").find((l) => l.startsWith("Request:"))).toContain("af_only does not apply to collections and books");
    expectClean(h);
  });

  it("errors: commented_on outside a user item; item:N out of range", async () => {
    const h = h0();
    expect((await h.call("find", { items: [{ kind: "post", query: "AGI Ruin", commented_on: "uMQ3cqWDPHhjtiesc" }] })).text)
      .toBe("Error (bad_input): commented_on: item 1 is a post item; only user items take commented_on. Move it to a user item.");
    expect((await h.call("find", { items: [{ kind: "post", query: "AGI Ruin" }, { kind: "user", query: "Paul Christiano", commented_on: "item:3" }] })).text)
      .toBe('Error (bad_input): commented_on: "item:3" names no item of this call (it has 2 items). Use item:1 to item:2, counting from 1.');
  });

  it("empty: the filtered-list template with each kind's hint, verbatim (¶4.1)", async () => {
    const h = h0();
    const empty = async (kind: string) => (await h.call("find", { items: [{ kind, query: "zzqq" }] })).text;
    const user = await empty("user");
    expect(user).toContain('No candidates match: user "zzqq".');
    expect(user).toContain('No candidates match: user "zzqq". Check the spelling including accents; if they commented on a known post, add commented_on.');
    const post = await empty("post");
    expect(post).toContain('No candidates match: post "zzqq".');
    expect(post).toContain('No candidates match: post "zzqq". Give the full title, or search {phrases: [...]}.');
    const tag = await empty("tag");
    expect(tag).toContain('No candidates match: tag "zzqq".');
    expect(tag).toContain('No candidates match: tag "zzqq". Spell out abbreviations; there may be no tag for this topic: search {query: …} finds posts by words.');
    const seq = await empty("sequence");
    expect(seq).toContain('No candidates match: sequence "zzqq".');
    expect(seq).toContain('No candidates match: sequence "zzqq". Collections and books are matched by title only.');
  });

  it("exact title and exact name compare composed and decomposed accents alike (NFC)", async () => {
    const decomposed = "Jo\u{301}zsef Ga\u{301}l";
    const h = h0([
      searchEntry({ index: "users", query: decomposed, page: 0, hitsPerPage: 10 }, { hits: [{ objectID: "jozsefGalUser0001", _id: "jozsefGalUser0001", displayName: "József Gál" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ["jozsefGalUser0001"] }, limit: 1 }, { results: [rawUserCard({ _id: "jozsefGalUser0001", slug: "jozsef-gal", displayName: "József Gál", karma: 50 })] }, "§3.4"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "jo-zsef-ga-l" } }, null, "§9.1"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "user", query: decomposed }] })).text;
    expect(out).toContain("★ best match (exact name)");
    expect(out).toContain("user_slug jozsef-gal");
  });

  it("a continuation re-reads its candidates in one request, repeats the item header, and prints a fallen-back word's note and empty line again", async () => {
    const h = createHarness({ families: FAMS, extra: manyTagHitsFor("alignment", 10) });
    const first = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }, { kind: "post", query: "AAAAAAAAAAAAAAAAA" }], max_tokens: 2000 })).text;
    expect(first).not.toContain("Item 2");
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(first)![1];
    const sent = h.forum.requests.length;
    const next = (await h.call("find", { cursor })).text;
    expect(h.forum.requests.length).toBe(sent + 1);
    const reread = JSON.parse(h.forum.requests.at(-1)!.body).query as string;
    expect(reread).toContain('t1: tag(selector: {_id: "manyTag0000000009"})');
    expect(next).toContain('Item 1 · tag "alignment" (continued)\n  9. "alignment topic 9"');
    // ¶4.1 step 1: a bare 17-character string that is neither id nor slug was searched as a title too; nothing matched, so
    // the item prints its note and the empty template, and the continuation resolves nothing again.
    expect(reread).not.toContain("r2p:");
    expect(next).toContain('Item 2 · post "AAAAAAAAAAAAAAAAA"\n  not an id or slug: no publicly visible post opens by the id or slug "AAAAAAAAAAAAAAAAA"; searched as a title instead\n'
      + '  No candidates match: post "AAAAAAAAAAAAAAAAA". Give the full title, or search {phrases: [...]}.');
    expect(next).not.toContain("not resolved");
    expect(next.endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("¶4.1 step 1 a 24-hex id or a URL is never searched; an id the forum refuses keeps its not-resolved line and is resolved again on a continuation", async () => {
    const h = createHarness({ families: FAMS, extra: [
      ...manyTagHitsFor("alignment", 10),
      { source: "§6.1", match: { root: "post", id: "BBBBBBBBBBBBBBBBB" }, error: { message: "app.operation_not_allowed" } },
      searchEntry({ index: "posts", query: "BBBBBBBBBBBBBBBBB", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 0 }, "§3.4"),
    ] });
    const first = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }, { kind: "post", query: "BBBBBBBBBBBBBBBBB" }], max_tokens: 2000 })).text;
    const next = (await h.call("find", { cursor: /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(first)![1] })).text;
    expect(JSON.parse(h.forum.requests.at(-1)!.body).query as string).toContain('r2p: post(selector: {_id: "BBBBBBBBBBBBBBBBB"}, allowNull: true)');
    expect(next).toContain('Item 2 · post "BBBBBBBBBBBBBBBBB"\n  not resolved: Error (not_public): The forum refuses to show the post with the id "BBBBBBBBBBBBBBBBB"');
    expect(next).not.toContain("not an id");
    expectClean(h);
  });

  it("a deadline before the mandatory hydrate request is the timeout error", async () => {
    const h = h0(); h.forum.inject({ endpoint: "search", delayMs: 41_000 });
    expect((await h.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }] })).text)
      .toBe("Error (timeout): The forum did not answer in time while running find (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
  });
});

describe("find: what stays listed when search alone fills the page", () => {
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, k) => prefix + String(k + 1).padStart(17 - prefix.length, "0"));
  const FULL = "End of reachable results: item 1 has more candidates than limit 10.";
  const UNREAD = "End of reachable results: item 1 has more hits than were read.";
  const YVAIN = { _id: "realAccountUser01", slug: "scottalexander", displayName: "Scott Alexander", karma: 46244 };

  /** The users index answers with `hits` (those in `named` hold exactly the query as display name), and the query's one slug guess with `guess`. */
  const people = (query: string, hits: string[], nbHits: number, guess: Parameters<typeof rawUserCard>[0] | null, named: string[] = []) => [
    searchEntry({ index: "users", query, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: hits.map((id) => ({ objectID: id, _id: id, displayName: id })), nbHits }, "§3.4"),
    gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: hits }, limit: hits.length }, {
      results: hits.map((id) => rawUserCard({ _id: id, slug: id.toLowerCase(), displayName: named.includes(id) ? query : `Person ${id}`, karma: 5 })),
    }, "§3.4"),
    gqlEntry({ root: "GetUserBySlug", args: { slug: query.toLowerCase() } }, guess === null ? null : rawUserCard(guess), "§9.1"),
  ];
  const user = (query: string, limit?: number) => ({ items: [{ kind: "user", query }], ...(limit !== undefined && { limit }) });

  it("a person found by a slug guess stays listed: the last plain search hit gives way", async () => {
    const out = (await h0(people("Yvain", ids("plainPerson", 10), 10, YVAIN)).call("find", user("Yvain"))).text;
    expect(out).toContain("user_id realAccountUser01");
    expect(out).toContain("user_id plainPerson000009");
    expect(out).not.toContain("user_id plainPerson000010");
    expect(out).not.toContain("  11. ");
  });

  it("an account that once used the slug is labelled as such", async () => {
    const out = (await h0(people("Yvain", ids("plainPerson", 10), 10, YVAIN)).call("find", user("Yvain"))).text;
    expect(out).toMatch(/ {2}10\. "Scott Alexander" .*\(earlier slug\)/);
  });

  it("an exact name reached only by a slug guess may be a namesake, so it gets no star", async () => {
    const guess = { _id: "guessedNameUser01", slug: "onlyguess", displayName: "Onlyguess", karma: 5000 };
    const out = (await h0(people("Onlyguess", [], 0, guess)).call("find", user("Onlyguess"))).text;
    expect(out).toContain("user_id guessedNameUser01");
    expect(out).not.toContain("★");
  });

  it("a search hit that a slug guess also reached is not a plain hit: it outlasts one that only search found", async () => {
    const hits = ids("plainPerson", 3);
    const guess = { _id: hits[2]!, slug: "janos", displayName: "Someone Else", karma: 5 };
    const out = (await h0(people("Janos", hits, 3, guess)).call("find", user("Janos", 2))).text;
    expect(out).toContain(`user_id ${hits[2]}`);
    expect(out).toContain(`user_id ${hits[0]}`);
    expect(out).not.toContain(`user_id ${hits[1]}`);
  });

  it("a post hit that the slug lookup also reached outlasts one that only search found", async () => {
    const hits = ids("plainPost", 3);
    const hit = (id: string) => ({ objectID: id, _id: id, title: id });
    const h = h0([
      searchEntry({ index: "posts", query: "Eta Theta", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: hits.map(hit), nbHits: 3 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: hits }, limit: 3 }, { results: hits.map((id) => rawPostCard({ _id: id, title: `Post ${id}` })) }, "§3.4"),
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "eta-theta" } }, { results: [rawPostCard({ _id: hits[2]!, title: `Post ${hits[2]}`, slug: "eta-theta" })] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Eta Theta" }], limit: 2 })).text;
    expect(out).toContain(`post_id ${hits[2]}`);
    expect(out).not.toContain(`post_id ${hits[1]}`);
  });

  it("the reply does not say the results ended when a candidate was cut", async () => {
    const out = (await h0(people("Yvain", ids("plainPerson", 10), 10, YVAIN)).call("find", user("Yvain"))).text;
    expect(out.endsWith(FULL)).toBe(true);
    expect(out).not.toContain("End of results.");
  });

  it("the reply does not say the results ended when the forum holds more hits than were read", async () => {
    const out = (await h0(people("Manyhits", ids("plainPerson", 10), 493, null)).call("find", user("Manyhits"))).text;
    expect(out.endsWith(UNREAD)).toBe(true);
  });

  it("hits the forum returned twice are not hits left to read", async () => {
    const page = ids("plainPost", 10);
    const again = [page[9]!, ...ids("otherPost", 5)];
    const shown = [...page, ...again.slice(1)];
    const hit = (id: string) => ({ objectID: id, _id: id, title: id });
    const h = h0([
      searchEntry({ index: "posts", query: "Twice Shown", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: page.map(hit), nbHits: 16 }, "§3.4"),
      searchEntry({ index: "posts", query: "Twice Shown", page: 1, hitsPerPage: 10, facetFilters: [] }, { hits: again.map(hit), nbHits: 16 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: shown }, limit: shown.length }, { results: shown.map((id) => rawPostCard({ _id: id, title: `Post ${id}` })) }, "§3.4"),
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "twice-shown" } }, { results: [] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Twice Shown" }], limit: 16, max_tokens: 40000 })).text;
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("a word that is no id or slug is searched, and its unread hits count", async () => {
    const page = rawTagCard({ _id: "superintelTag0001", name: "Superintelligence", slug: "superintelligence", postCount: 210 });
    const h = h0([
      searchEntry({ index: "tags", query: "Superintelligence", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: page._id, _id: page._id, name: page.name }], nbHits: 50 }, "§3.4"),
      searchEntry({ index: "tags", query: "Superintelligence", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, "§3.4"),
      gqlEntry({ root: "tag", id: page._id }, { result: page }, "§3.4"),
      gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "superintelligence" }, limit: 1 }, { results: [] }, "§3.4"),
      gqlEntry({ root: "TagPreview", args: { slug: "superintelligence" } }, null, "§3.4"),
      { source: "§10.2", match: { root: "tag", id: "Superintelligence" }, error: { message: "app.missing_document" } },
      { source: "§10.2", match: { root: "multiDocument", id: "Superintelligence" }, error: { message: "app.missing_document" } },
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "Superintelligence" }] })).text;
    expect(out).toContain("not an id or slug");
    expect(out.endsWith(UNREAD)).toBe(true);
  });

  it("every page read and everything listed: the results did end, at any limit", async () => {
    const hits = ids("plainPost", 12);
    const hit = (id: string) => ({ objectID: id, _id: id, title: id });
    const h = h0([
      searchEntry({ index: "posts", query: "Long Answer", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: hits.slice(0, 10).map(hit), nbHits: 12 }, "§3.4"),
      searchEntry({ index: "posts", query: "Long Answer", page: 1, hitsPerPage: 10, facetFilters: [] }, { hits: hits.slice(10).map(hit), nbHits: 12 }, "§3.4"),
      searchEntry({ index: "posts", query: "Long Answer", page: 2, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 12 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: hits }, limit: 12 }, { results: hits.map((id) => rawPostCard({ _id: id, title: `Post ${id}` })) }, "§3.4"),
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "long-answer" } }, { results: [] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Long Answer" }], limit: 25, max_tokens: 40000 })).text;
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("every hit read and nothing cut: the results did end", async () => {
    const out = (await h0(people("Fewhits", ids("plainPerson", 3), 3, null)).call("find", user("Fewhits"))).text;
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("an item resolved by its id has no search behind its answer, whatever the forum counts", async () => {
    const h = h0([searchEntry({ index: "posts", query: "uMQ3cqWDPHhjtiesc", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 50 }, "§3.4")]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "uMQ3cqWDPHhjtiesc" }] })).text;
    expect(out).toContain("★ best match (identifier)");
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("an exact name outlasts a plain hit that ranks above it", async () => {
    const hits = [...ids("plainPerson", 2), "exactNameUser0001"];
    const out = (await h0(people("Onlyname", hits, 3, null, ["exactNameUser0001"])).call("find", user("Onlyname", 2))).text;
    expect(out).toContain("user_id exactNameUser0001");
    expect(out).toContain("user_id plainPerson000001");
    expect(out).not.toContain("user_id plainPerson000002");
  });

  it("the hits read do not depend on limit, so neither does the best match", async () => {
    const hits = ids("sameNameUser", 2);
    const h = h0(people("Samesame", hits, 2, null, hits));
    const out = (await h.call("find", user("Samesame", 1))).text;
    expect(paramsOf(h)[0].hitsPerPage).toBe(10);
    expect(out).toContain("2 accounts have exactly this display name");
    expect(out).not.toContain("★");
    expect(out.endsWith("End of reachable results: item 1 has more candidates than limit 1.")).toBe(true);
  });

  /** Two user items at once: the hydrate of both lists is one request. */
  const pair = (a: ReturnType<typeof people>, b: ReturnType<typeof people>, all: string[]) => h0([
    gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: all }, limit: all.length }, { results: all.map((id) => rawUserCard({ _id: id, slug: id.toLowerCase(), displayName: `Person ${id}`, karma: 5 })) }, "§3.4"),
    ...a, ...b,
  ]);
  const twoUsers = (a: string, b: string) => ({ items: [{ kind: "user", query: a }, { kind: "user", query: b }] });

  it("the reply names only the items that have more", async () => {
    const few = ids("plainPerson", 3), many = ids("otherPerson", 3);
    const h = pair(people("Fewhits", few, 3, null), people("Manyhits", many, 90, null), [...few, ...many]);
    const out = (await h.call("find", twoUsers("Fewhits", "Manyhits"))).text;
    expect(out.endsWith("End of reachable results: item 2 has more hits than were read.")).toBe(true);
  });

  it("the reply names every item that has more", async () => {
    const a = ids("plainPerson", 3), b = ids("otherPerson", 3);
    const h = pair(people("Fewhits", a, 80, null), people("Manyhits", b, 90, null), [...a, ...b]);
    const out = (await h.call("find", twoUsers("Fewhits", "Manyhits"))).text;
    expect(out.endsWith("End of reachable results: items 1, 2 have more hits than were read.")).toBe(true);
  });

  it("the reply gives each reason its own items", async () => {
    const a = ids("plainPerson", 10), b = ids("otherPerson", 3);
    const h = pair(people("Yvain", a, 10, YVAIN), people("Manyhits", b, 90, null), [...a, ...b]);
    const out = (await h.call("find", twoUsers("Yvain", "Manyhits"))).text;
    expect(out.endsWith("End of reachable results: item 1 has more candidates than limit 10; item 2 has more hits than were read.")).toBe(true);
  });

  /** Ten wiki pages from the main query and one more that only the wiki-only query finds. */
  const buriedPage = (query: string) => {
    const description = { plaintextDescription: "A page.", markdown: "A page.", version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 2 };
    return [
      searchEntry({ index: "tags", query, page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [{ objectID: "buriedWikiPage001", _id: "buriedWikiPage001", name: "Buried page" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "tag", id: "buriedWikiPage001" }, { result: rawTagFull({ _id: "buriedWikiPage001", name: "Buried page", slug: "buried-page", wikiOnly: true, postCount: 0, parentTag: null, description }) }, "§3.4"),
      ...manyTagHitsFor(query, 10),
    ];
  };

  it("a cursor page ends the same way as a whole reply", async () => {
    const h = h0(buriedPage("alignment"));
    let out = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }], max_tokens: 2000 })).text;
    expect(out).toContain("More available");
    while (out.includes("More available")) out = (await h.call("find", { cursor: printedCursor(out), max_tokens: 2000 })).text;
    expect(out.endsWith(FULL)).toBe(true);
  });

  it("a post found only by its slug stays listed, and is not said to be missing from search", async () => {
    const hits = ids("plainPost", 10);
    const h = h0([
      searchEntry({ index: "posts", query: "Alpha Beta", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: hits.map((id) => ({ objectID: id, _id: id, title: id })), nbHits: 10 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: hits }, limit: 10 }, { results: hits.map((id) => rawPostCard({ _id: id, title: `Post ${id}` })) }, "§3.4"),
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "alpha-beta" } }, { results: [rawPostCard({ _id: "renamedPost000001", title: "A New Name", slug: "alpha-beta" })] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Alpha Beta" }] })).text;
    expect(out).toContain("post_id renamedPost000001");
    expect(out).toContain("found by slug; not among the search hits read");
    expect(out).not.toContain("post_id plainPost00000010");
  });

  it("a wiki page from the wiki-only query stays listed", async () => {
    const h = h0(buriedPage("alignment"));
    const out = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }], max_tokens: 40000 })).text;
    expect(out).toContain("tag_id buriedWikiPage001");
    expect(out).not.toContain("tag_id manyTag0000000010");
  });

  it("a slug the account has now is not an earlier slug, whatever its capitals", async () => {
    const guess = { _id: "mixedCaseUser0001", slug: "Mixed-Case", displayName: "Someone Else", karma: 5 };
    const out = (await h0(people("Mixed-Case", ids("plainPerson", 2), 2, guess)).call("find", user("Mixed-Case"))).text;
    expect(out).toMatch(/"Someone Else" .*\(slug match \(may be a namesake\)\)/);
  });

  it("a wiki page that both queries found keeps its place when a plain hit has to go", async () => {
    const both = "manyTag0000000010";
    const h = h0([
      searchEntry({ index: "tags", query: "alignment", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, {
        hits: [{ objectID: both, _id: both, name: "alignment topic 10" }, { objectID: "buriedWikiPage001", _id: "buriedWikiPage001", name: "Buried page" }], nbHits: 2,
      }, "§3.4"),
      ...buriedPage("alignment").slice(1),
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }], max_tokens: 40000 })).text;
    expect(out).toContain(`tag_id ${both}`);
    expect(out).not.toContain("tag_id manyTag0000000009");
  });

  it("with limit 1 an exact title outlasts a post found only by slug", async () => {
    const h = h0([
      searchEntry({ index: "posts", query: "Gamma Delta", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: "exactTitlePost001", _id: "exactTitlePost001", title: "Gamma Delta" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["exactTitlePost001"] }, limit: 1 }, { results: [rawPostCard({ _id: "exactTitlePost001", title: "Gamma Delta" })] }, "§3.4"),
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "gamma-delta" } }, { results: [rawPostCard({ _id: "renamedPost000002", title: "A New Name", slug: "gamma-delta" })] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "post", query: "Gamma Delta" }], limit: 1 })).text;
    expect(out).toContain("post_id exactTitlePost001");
    expect(out).not.toContain("post_id renamedPost000002");
  });

  it("with limit 1 an exact tag name outlasts a page from the wiki-only query", async () => {
    const description = { plaintextDescription: "A page.", markdown: "A page.", version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 2 };
    const page = (id: string, name: string, slug: string) => gqlEntry({ root: "tag", id }, { result: rawTagFull({ _id: id, name, slug, wikiOnly: false, postCount: 0, parentTag: null, description }) }, "§3.4");
    const h = h0([
      searchEntry({ index: "tags", query: "Epsilon", page: 0, hitsPerPage: 10, facetFilters: [] }, {
        hits: [{ objectID: "topDirectTag00001", _id: "topDirectTag00001", name: "Epsilon rules" }, { objectID: "exactNamedTag0001", _id: "exactNamedTag0001", name: "Epsilon" }], nbHits: 2,
      }, "§3.4"),
      searchEntry({ index: "tags", query: "Epsilon", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [{ objectID: "wikiOnlyPage00001", _id: "wikiOnlyPage00001", name: "Epsilon again" }], nbHits: 1 }, "§3.4"),
      page("exactNamedTag0001", "Epsilon", "epsilon"), page("wikiOnlyPage00001", "Epsilon again", "epsilon-again"), page("topDirectTag00001", "Epsilon rules", "epsilon-rules"),
      gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "epsilon" }, limit: 1 }, { results: [] }, "§3.4"),
      gqlEntry({ root: "TagPreview", args: { slug: "epsilon" } }, null, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "Epsilon" }], limit: 1 })).text;
    expect(out).toContain("tag_id exactNamedTag0001");
    expect(out).not.toContain("tag_id topDirectTag00001");
    expect(out).not.toContain("tag_id wikiOnlyPage00001");
  });

  /** A sequence item: `main` and `alias` are the ids the query and the long form find; the `counted` is the long form's nbHits. */
  const sequences = (query: string, long: string, main: { id: string; title: string }[], alias: { id: string; title: string }[], counted = alias.length) => {
    const all = [...main, ...alias];
    return [
      searchEntry({ index: "sequences", query, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: main.map((x) => ({ objectID: x.id, _id: x.id, title: x.title })), nbHits: main.length }, "§3.4"),
      searchEntry({ index: "sequences", query: long, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: alias.map((x) => ({ objectID: x.id, _id: x.id, title: x.title })), nbHits: counted }, "§3.4"),
      gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: all.map((x) => x.id) }, limit: all.length }, { results: all.map((x) => rawSeqCard({ _id: x.id, title: x.title })) }, "§3.4"),
    ];
  };
  const LONG = "Harry Potter and the Methods of Rationality";

  it("with limit 1 an exact sequence title outlasts a long-form hit", async () => {
    const main = [{ id: "topDirectSeq00001", title: "Something Else" }, { id: "exactTitledSeq001", title: "HPMOR" }];
    const h = h0(sequences("HPMOR", LONG, main, [{ id: "longFormSequence2", title: "Another" }]));
    const out = (await h.call("find", { items: [{ kind: "sequence", query: "HPMOR" }], limit: 1 })).text;
    expect(out).toContain("sequence_id exactTitledSeq001");
    expect(out).not.toContain("sequence_id topDirectSeq00001");
    expect(out).not.toContain("sequence_id longFormSequence2");
  });

  it("the long form's unread hits count as more, as the main query's do", async () => {
    const h = h0(sequences("HPMOR", LONG, [{ id: "exactTitledSeq001", title: "Some Title" }], [{ id: "longFormSequence2", title: "Another" }], 40));
    const out = (await h.call("find", { items: [{ kind: "sequence", query: "HPMOR" }] })).text;
    expect(out.endsWith(UNREAD)).toBe(true);
  });

  it("a second query cannot push out every direct hit: the top one stays", async () => {
    const main = ids("directSequence", 3).map((id) => ({ id, title: `Direct ${id}` }));
    const alias = ids("longFormSeq", 3).map((id) => ({ id, title: `Long ${id}` }));
    // The hpmor collection is listed first and takes one of the four rows.
    const out = (await h0(sequences("HPMOR", LONG, main, alias)).call("find", { items: [{ kind: "sequence", query: "HPMOR" }], limit: 4 })).text;
    expect(out).toContain(`sequence_id ${main[0]!.id}`);
    expect(out).toContain(`sequence_id ${alias[1]!.id}`);
    expect(out).not.toContain(`sequence_id ${main[1]!.id}`);
    expect(out).not.toContain(`sequence_id ${alias[2]!.id}`);
  });

  it("a sequence hit that the long form also reached outlasts one that only the short form found", async () => {
    const main = ids("directSequence", 3).map((id) => ({ id, title: `Direct ${id}` }));
    const h = h0([
      searchEntry({ index: "sequences", query: "HPMOR", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: main.map((x) => ({ objectID: x.id, _id: x.id, title: x.title })), nbHits: 3 }, "§3.4"),
      searchEntry({ index: "sequences", query: LONG, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: main[2]!.id, _id: main[2]!.id, title: main[2]!.title }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: main.map((x) => x.id) }, limit: 3 }, { results: main.map((x) => rawSeqCard({ _id: x.id, title: x.title })) }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "sequence", query: "HPMOR" }], limit: 3 })).text;
    expect(out).toContain(`sequence_id ${main[2]!.id}`);
    expect(out).not.toContain(`sequence_id ${main[1]!.id}`);
  });

  it("a long-form tag hit outlasts a plain hit", async () => {
    const description = { plaintextDescription: "A page.", markdown: "A page.", version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 2 };
    const h = h0([
      searchEntry({ index: "tags", query: "LLM", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, "§3.4"),
      searchEntry({ index: "tags", query: "large language models", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: "longFormTagPage01", _id: "longFormTagPage01", name: "Language Models" }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "tag", id: "longFormTagPage01" }, { result: rawTagFull({ _id: "longFormTagPage01", name: "Language Models", slug: "language-models", postCount: 0, parentTag: null, description }) }, "§3.4"),
      ...manyTagHitsFor("LLM", 10).slice(1),
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "LLM" }], limit: 1, max_tokens: 40000 })).text;
    expect(out).toContain("tag_id longFormTagPage01");
  });

  it("a wiki-only page cannot push out the top direct hit", async () => {
    const out = (await h0(buriedPage("alignment")).call("find", { items: [{ kind: "tag", query: "alignment" }], limit: 1, max_tokens: 40000 })).text;
    expect(out).toContain("tag_id manyTag0000000001");
    expect(out).not.toContain("tag_id buriedWikiPage001");
  });

  it("the wiki-only query's count does not: its pages are among the main query's", async () => {
    const hits = [{ objectID: "manyTag0000000001", _id: "manyTag0000000001", name: "alignment topic 1" }];
    const h = h0([
      searchEntry({ index: "tags", query: "alignment", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits, nbHits: 8 }, "§3.4"),
      searchEntry({ index: "tags", query: "alignment", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits, nbHits: 1 }, "§3.4"),
      ...manyTagHitsFor("alignment", 1),
    ]);
    const out = (await h.call("find", { items: [{ kind: "tag", query: "alignment" }] })).text;
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("a sequence found by an abbreviation's long form stays listed", async () => {
    const hits = ids("plainSequence", 10);
    const long = "Harry Potter and the Methods of Rationality";
    const seq = (id: string, title: string) => rawSeqCard({ _id: id, title });
    const h = h0([
      searchEntry({ index: "sequences", query: "HPMOR", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: hits.map((id) => ({ objectID: id, _id: id, title: id })), nbHits: 10 }, "§3.4"),
      searchEntry({ index: "sequences", query: long, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [{ objectID: "longFormSequence1", _id: "longFormSequence1", title: long }], nbHits: 1 }, "§3.4"),
      gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: [...hits, "longFormSequence1"] }, limit: 11 }, { results: [...hits.map((id) => seq(id, `Sequence ${id}`)), seq("longFormSequence1", long)] }, "§3.4"),
    ]);
    const out = (await h.call("find", { items: [{ kind: "sequence", query: "HPMOR" }], max_tokens: 40000 })).text;
    expect(out).toContain("sequence_id longFormSequence1");
    expect(out).not.toContain("sequence_id plainSequence0010");
  });
});

describe("find: commenters, stars and slug guesses", () => {
  const AGI = "uMQ3cqWDPHhjtiesc";
  const hit = (u: { _id: string; displayName: string }) => ({ objectID: u._id, _id: u._id, displayName: u.displayName });
  const users = (query: string, list: { _id: string; slug: string; displayName: string; karma: number }[]): FixtureEntry[] => [
    searchEntry({ index: "users", query, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: list.map(hit), nbHits: list.length }, "§3.4"),
    ...(list.length === 0 ? [] : [gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: list.map((u) => u._id) } }, {
      results: list.map((u) => rawUserCard({ ...u, createdAt: "2020-01-01T00:00:00.000Z", afKarma: 0, postCount: 1, commentCount: 1, groups: [] })),
    }, "§3.4")]),
  ];
  const noSlug = (slug: string): FixtureEntry => gqlEntry({ root: "GetUserBySlug", args: { slug } }, null, "§9.1");

  it("#15 a search hit who commented on the post is labelled with their comments, listed with the commenters, and not starred for it", async () => {
    // Sample Person's name holds neither word of the query; the users index returned the account anyway, after a non-commenter.
    const other = { _id: "pseudonymOther001", slug: "pseudonym-other", displayName: "Pseudonym Other", karma: 5 };
    const h = h0([...samplePersonOnAgiRuin(), ...users("Pseudonym Writer", [other, { ...SAMPLE_PERSON, karma: 100 }]),
      noSlug("pseudonym-writer"), noSlug("pseudonymwriter"), noSlug("pseudonym_writer")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "Pseudonym Writer", commented_on: AGI }] })).text;
    expect(out).toContain('Item 1 · user "Pseudonym Writer" (commenters of post_id uMQ3cqWDPHhjtiesc first)\n  1. "Sample Person" · user_slug sample-person');
    expect(out).toMatch(/  1\. "Sample Person" .*\(search; commented on this post 3 times\)/);
    expect(out).toMatch(/  2\. "Pseudonym Other" .*\(search; not a commenter on this post\)/);
    expect(out).not.toContain("★");
    expectClean(h);
  });

  it("#14 the only commenter matching the query is not starred when another candidate has exactly the query's name", async () => {
    const exact = { _id: "sampleExactUser01", slug: "sample", displayName: "Sample", karma: 500 };
    const h = h0([...samplePersonOnAgiRuin(), ...users("Sample", [exact]), noSlug("sample")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "Sample", commented_on: AGI }] })).text;
    expect(out).toContain('Item 1 · user "Sample" (commenters of post_id uMQ3cqWDPHhjtiesc first)\n  an exact-name account exists, but it is not a commenter on this post\n  1. "Sample Person"');
    expect(out).toMatch(/  2\. "Sample" · user_slug sample .*\(exact name\)/);
    expect(out).not.toContain("★");
    expectClean(h);
  });

  it("#14 a commenter with exactly the query's name is starred, even when a namesake with that name did not comment", async () => {
    // As on the forum: the people search finds the commenter and an empty account with the same name, which the slug guess finds too.
    const empty = { _id: "robNamesakeUser01", slug: "rob-bensinger", displayName: "Rob Bensinger", karma: 0 };
    const namesake = rawUserCard({ ...empty, createdAt: "2024-06-01T00:00:00.000Z", afKarma: 0, postCount: 0, commentCount: 0, groups: [] });
    const h = h0([...robCommentsOnAgiRuin(), ...users("Rob Bensinger", [{ _id: ROB_BENSINGER._id, slug: "robbbb", displayName: "Rob Bensinger", karma: 20000 }, empty]),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "rob-bensinger" } }, namesake, "§9.1")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "Rob Bensinger", commented_on: AGI }] })).text;
    expect(out).toContain('Item 1 · user "Rob Bensinger" (commenters of post_id uMQ3cqWDPHhjtiesc first)\n  1. ★ best match (commented on this post 3 times) — "Rob Bensinger" · user_slug robbbb');
    expect(out).not.toContain("an exact-name account exists");
    expect(out).toMatch(/  2\. "Rob Bensinger" · user_slug rob-bensinger .*\(exact name\)/);
    expectClean(h);
  });

  it("a commenter reached only by a slug guess (a renamed account) is labelled so and listed with the commenters", async () => {
    const other = { _id: "pseudonymOther001", slug: "pseudonym-other", displayName: "Pseudonym Other", karma: 5 };
    const h = h0([...samplePersonOnAgiRuin(), ...users("Pseudonym Writer", [other]),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "pseudonym-writer" } }, rawUserCard({ ...SAMPLE_PERSON, karma: 100, groups: [] }), "§9.1"),
      noSlug("pseudonymwriter"), noSlug("pseudonym_writer")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "Pseudonym Writer", commented_on: AGI }] })).text;
    expect(out).toMatch(/  1\. "Sample Person" · user_slug sample-person .*\(earlier slug; commented on this post 3 times\)/);
    expect(out).toMatch(/  2\. "Pseudonym Other" .*\(search; not a commenter on this post\)/);
    expect(out).not.toContain("★");
    expectClean(h);
  });

  it("af_only: no commenter is starred as the only match when another matching commenter was left out unchecked", async () => {
    const ck = { _id: "christianKlId0001", slug: "christiankl", displayName: "ChristianKl", karma: 9000 };
    const afSearch = searchEntry({ index: "users", query: "christian", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: [hit(ck)], nbHits: 1 }, "§3.4");
    const card = gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: [ck._id] } }, {
      results: [rawUserCard({ ...ck, createdAt: "2011-05-01T00:00:00.000Z", afKarma: 10, postCount: 1, commentCount: 1, groups: ["alignmentForum"] })],
    }, "§3.4");
    const h = h0([...paulCommentsOnAgiRuin(), afSearch, card, noSlug("christian")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "christian", commented_on: AGI }], af_only: true })).text;
    expect(out).toContain("1 commenter was left out because AF membership could not be checked (repeat without af_only to see them)");
    expect(out).toMatch(/  1\. "ChristianKl" · user_slug christiankl .*\(commented on this post 1 time\)/);
    expect(out).not.toContain("★");
    expectClean(h);
  });

  it("#203 the description names every kind of best match: an identifier, an exact match, the people rule, a matching commenter", async () => {
    const { tool } = await import("../../src/tools/find");
    expect(tool.description).toContain('"best match" is marked only when, among the candidates read, one is clearly right: the identifier given, or the only exact match '
      + "(people: the only account whose display name equals the query and whose karma is at least 10 and ten times that of every other candidate; "
      + "with commented_on, the only matching commenter).");
  });

  it("a handle that starts with _ is tried as a slug, as the forum's slugs can", async () => {
    const h = h0([...users("_ozymandias", []),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "_ozymandias" } }, rawUserCard({ _id: "ozymandiasUser001", slug: "_ozymandias", displayName: "Ozymandias", karma: 900, groups: [] }), "§9.1")]);
    const out = (await h.call("find", { items: [{ kind: "user", query: "_ozymandias" }] })).text;
    expect(out).toMatch(/  1\. "Ozymandias" · user_slug _ozymandias .*\(slug match \(may be a namesake\)\)/);
    expectClean(h);
  });

  it("an old wiki URL is not searched as words: it is refused as what it is, with the page's name to search", async () => {
    const h = h0();
    const out = (await h.call("find", { items: [{ kind: "tag", query: "https://wiki.lesswrong.com/wiki/Paperclip_maximizer" }] })).text;
    expect(out).toContain("is a page of the old LessWrong wiki, which this server doesn't read");
    expect(out).toContain('use find {items: [{kind: "tag", query: "Paperclip maximizer"}]}');
    expect(h.forum.requests.filter((r) => r.endpoint === "search")).toHaveLength(0);
  });

});
