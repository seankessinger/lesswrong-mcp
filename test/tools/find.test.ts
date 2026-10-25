import { describe, it, expect } from "vitest";
import { findSearchSpecs } from "../../src/tools/find";
import { findHydrateOps } from "../../src/forum/templates/find";
import { documentFor } from "../../src/forum/templates/op";
import { buildSearch, estimateBytes } from "../../src/forum/search";
import { cachedResolution } from "../../src/ids/resolve";
import { createCallContext } from "../../src/call/context";
import { createHarness, expectClean } from "../support/harness";
import {
  SAMPLE_PERSON, gqlEntry, manyTagHitsFor, paulCommentsOnAgiRuin, rawPostCard, rawTagCard, rawUserCard, samplePersonEntry, samplePersonOnAgiRuin, searchEntry,
} from "../support/builders";

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

  it("step 2: one query per item and index; hitsPerPage = min(limit, cap); later pages in the same POST", () => {
    const s = (items: Parameters<typeof findSearchSpecs>[0], limit: number, af = false) => findSearchSpecs(items, limit, af).specs.map((x) => [x.index, x.query, x.page, x.hitsPerPage, x.facets ?? []]);
    expect(s([{ kind: "post", query: "AGI Ruin" }], 5)).toEqual([["posts", "AGI Ruin", 0, 5, []]]);
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
    expect(out.text).toMatch(/  2\. "ChristianKl" · user_slug christiankl .*\(search; not a commenter on this post\)/);
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
    expect(outranked).toContain("  an exact-name account exists, but a higher-karma account ranks above it");
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
    expect(close).not.toContain("higher-karma");
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

  it("slug fallback finds a post search hides (negative karma)", async () => {
    const out = (await h0().call("find", { items: [{ kind: "post", query: "A Bad Take On Corrigibility" }] })).text;
    expect(out).toContain("post_id negKarmaPost00001");
    expect(out).toContain("found by slug; not in search, e.g. negative karma");
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
    expect(next).toContain('Item 2 · post "AAAAAAAAAAAAAAAAA"\n  not an id or slug: no publicly visible post has the id or slug "AAAAAAAAAAAAAAAAA"; searched as a title instead\n'
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
