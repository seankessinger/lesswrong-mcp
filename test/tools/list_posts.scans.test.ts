import { describe, it, expect } from "vitest";
import { listPostsOp } from "../../src/forum/templates/list_posts";
import { depthGuarded } from "../../src/tools/list_posts";
import { postsByIdsOp } from "../../src/forum/templates/shared";
import { documentFor } from "../../src/forum/templates/op";
import { CAVEAT } from "../../src/render/messages";
import { createHarness, expectClean } from "../support/harness";
import { SAMPLE_PERSON, gqlEntry, samplePersonEntry, searchEntry, rawPostLight, rawPostCard } from "../support/builders";
import type { FixtureEntry, GraphqlMatch } from "../support/fixtures";
import type { RawPostCard, RawPostLight, RawUserRef } from "../../src/types";

const FAMS = ["posts", "lists", "users", "tags"] as const;
const H = (extra: FixtureEntry[]) => createHarness({ families: FAMS, extra });
const EY = "nmk3nLpQE89dMRzzN", INTERP = "56yXXrcxRjrQs6z9R";
const light = (id: string, o: Partial<RawPostLight> = {}) => rawPostLight({ _id: id, userId: EY, postedAt: "2024-05-01T00:00:00.000Z", ...o });
const card = (id: string, o: Partial<RawPostCard> = {}) => rawPostCard({ _id: id, title: `Title ${id}`, slug: id.toLowerCase(), userId: EY,
  user: { _id: EY, slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }, postedAt: "2024-05-01T00:00:00.000Z", contents: { plaintextDescription: "x" }, ...o });
const scan = (view: string, terms: Record<string, unknown>, rows: RawPostLight[], totalCount = rows.length) =>
  gqlEntry({ root: "posts", view, terms, limit: 2000, enableTotal: true }, { results: rows, totalCount }, "§4.5, ¶3.6");
const hydrate = (docs: RawPostCard[]) => gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: docs.map((d) => d._id) }, limit: docs.length }, { results: [...docs].reverse() }, "§6.1");

describe("list_posts: light scans and the untagged section", () => {
  it("list_posts_light_scans: exact text", () => {
    const ops = [
      listPostsOp("userPosts", { userId: EY, sortedBy: "top", af: true }, { limit: 2000, enableTotal: true }, "light", "a"),
      listPostsOp("userPosts", { userId: EY, tagId: INTERP, sortedBy: "top" }, { limit: 2000, enableTotal: true }, "light", "r"),
      listPostsOp("tagRelevance", { tagId: INTERP, sortedBy: "top" }, { limit: 2000, enableTotal: true }, "light", "g"),
      listPostsOp("curated", {}, { limit: 2000, enableTotal: true }, "light", "c"),
      postsByIdsOp("h", ["uMQ3cqWDPHhjtiesc"], "...POST_CARD_EXCERPT")!];
    expect(documentFor("list_posts_light_scans", ops).startsWith('query list_posts_light_scans { a: posts(selector: {userPosts: {userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", excludeEvents: true, af: true}}, limit: 2000, enableTotal: true) { results { ...POST_LIGHT } totalCount } r: posts(selector: {userPosts: {userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", excludeEvents: true, filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 2000, enableTotal: true) { results { ...POST_LIGHT } totalCount } g: posts(selector: {tagRelevance: {tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", excludeEvents: true, filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 2000, enableTotal: true) { results { ...POST_LIGHT } totalCount } c: posts(selector: {curated: {excludeEvents: true}}, limit: 2000, enableTotal: true) { results { ...POST_LIGHT } totalCount } h: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc"]}}, limit: 1) { results { ...POST_CARD_EXCERPT } } }')).toBe(true);
  });
  it("tag_relevance with user: a userPosts light scan with the Required filter, ranked by relevance; never sortedBy relevance on userPosts", async () => {
    const h = H([scan("userPosts", { userId: EY, sortedBy: "top", filterSettings: { tags: [{ tagId: INTERP, filterMode: "Required" }] } },
        [light("rel10Post00000001", { tagRelevance: { [INTERP]: 10 } }), light("rel30Post00000001", { tagRelevance: { [INTERP]: 30 } }), light("rel20Post00000001", { tagRelevance: { [INTERP]: 20 } })]),
      hydrate([card("rel30Post00000001"), card("rel20Post00000001"), card("rel10Post00000001")])]);
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", sort: "tag_relevance" })).text;
    expect(h.forum.requests.some((r) => r.body.includes('sortedBy: \\"relevance\\"'))).toBe(false);
    expect(out.indexOf("rel30Post00000001")).toBeLessThan(out.indexOf("rel20Post00000001"));
    expect(out.indexOf("rel20Post00000001")).toBeLessThan(out.indexOf("rel10Post00000001"));
    expectClean(h);
  });
  it("Q13 af_top: AF posts by AF karma, then the others by karma; ties newer first", async () => {
    const h = H([scan("userPosts", { userId: EY, sortedBy: "top" }, [
        light("afLowPost00000001", { af: true, afBaseScore: 30, baseScore: 10 }), light("lwHighPost0000001", { af: false, baseScore: 100 }),
        light("afHighPost0000001", { af: true, afBaseScore: 50, baseScore: 5 })]),
      hydrate([card("afHighPost0000001", { af: true }), card("afLowPost00000001", { af: true }), card("lwHighPost0000001")])]);
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", sort: "af_top" })).text;
    const at = (id: string) => out.indexOf(id);
    expect(at("afHighPost0000001")).toBeLessThan(at("afLowPost00000001"));
    expect(at("afLowPost00000001")).toBeLessThan(at("lwHighPost0000001"));
  });
  it("curated_date: the curated view, by curatedDate", async () => {
    const h = H([scan("curated", {}, [
        light("curOld00000000001", { curatedDate: "2020-01-01T00:00:00.000Z", userId: "habrykaNamesake01" }), light("curNew00000000001", { curatedDate: "2025-01-01T00:00:00.000Z", userId: "habrykaNamesake01" })]),
      hydrate([card("curNew00000000001", { curatedDate: "2025-01-01T00:00:00.000Z" }), card("curOld00000000001", { curatedDate: "2020-01-01T00:00:00.000Z" })])]);
    const out = (await h.call("list_posts", { curated_only: true, sort: "curated_date" })).text;
    expect(out.indexOf("curNew00000000001")).toBeLessThan(out.indexOf("curOld00000000001"));
  });
  it("¶4.5 curated_date with curated_only and frontpage_only: the curated view is the curated filter and carries no filter term; frontpage is checked here", async () => {
    const rows = [light("curFrontPost00001", { curatedDate: "2025-01-01T00:00:00.000Z", frontpageDate: "2025-01-01T01:00:00.000Z" }),
      light("curNoFrontPost001", { curatedDate: "2024-01-01T00:00:00.000Z", frontpageDate: null })];
    const h = H([scan("curated", {}, rows), hydrate([card("curFrontPost00001", { curatedDate: "2025-01-01T00:00:00.000Z" })])]);
    const out = (await h.call("list_posts", { curated_only: true, frontpage_only: true, sort: "curated_date" })).text;
    expect(h.forum.requests[0]!.body).toContain('posts(selector: {curated: {excludeEvents: true}}, limit: 2000, enableTotal: true)');
    expect(h.forum.requests[0]!.body).not.toContain("filter:");
    expect(out).toContain("post_id curFrontPost00001");
    expect(out).not.toContain("curNoFrontPost001");
    expectClean(h);
  });
  it("a full raw page of the light scan is too_broad", async () => {
    const h = H([scan("userPosts", { userId: EY, sortedBy: "top" }, [light("anyLight000000001")], 2500)]);
    expect((await h.call("list_posts", { user: "eliezer_yudkowsky", sort: "af_top" })).text)
      .toBe("Error (too_broad): More than 2,000 posts match. Narrow with date_from/date_to.");
  });
  it("Q5 the scan is cached: the next page needs only its hydrate", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => light(`scanRow${String(i).padStart(10, "0")}`, { af: true, afBaseScore: 100 - i }));
    const docs = rows.map((r) => card(r._id, { af: true }));
    const h = H([scan("userPosts", { userId: EY, sortedBy: "top" }, rows), hydrate(docs.slice(0, 10)), hydrate(docs.slice(10))]);
    const p1 = (await h.call("list_posts", { user: "eliezer_yudkowsky", sort: "af_top" })).text;
    const n = h.forum.requests.length;
    const c = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    const p2 = (await h.call("list_posts", { cursor: c })).text;
    expect(h.forum.requests.length).toBe(n + 1);
    expect(p2).toContain("scanRow0000000010");
    expect(h.services.caches.get("scan", `list_posts:userPosts:${JSON.stringify({ userId: EY, sortedBy: "top" })}`)).toBeDefined();
  });
  it("Q5 ¶2.3 a date_to clamped to now keys the scan by its period: a minute later the next page still needs only its hydrate", async () => {
    const postedAt = "2026-05-01T00:00:00.000Z";
    const rows = Array.from({ length: 12 }, (_, i) => light(`scanRow${String(i).padStart(10, "0")}`, { af: true, afBaseScore: 100 - i, postedAt }));
    const docs = rows.map((r) => card(r._id, { af: true, postedAt }));
    // The scan is sent with date_to clamped to the harness clock's start.
    const h = H([scan("userPosts", { userId: EY, sortedBy: "top", after: "2026-01-01T00:00:00.000Z", before: "2026-10-22T12:00:00.000Z" }, rows),
      hydrate(docs.slice(0, 10)), hydrate(docs.slice(10))]);
    const p1 = (await h.call("list_posts", { user: "eliezer_yudkowsky", sort: "af_top", date_from: "2026", date_to: "2026" })).text;
    const n = h.forum.requests.length;
    const c = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    h.clock.advance(60_000);
    const p2 = (await h.call("list_posts", { cursor: c })).text;
    expect(h.forum.requests.length).toBe(n + 1);
    expect(p2).toContain("scanRow0000000010");
  });
  it("¶3.6 depth guard: only an unnarrowed site-wide new/old list; af_only alone does not narrow", () => {
    const base = { af_only: false, curated_only: false, frontpage_only: false, questions_only: false } as const;
    expect(depthGuarded({ ...base, sort: "new" })).toBe(true);
    expect(depthGuarded({ ...base, sort: "old", af_only: true })).toBe(true);
    expect(depthGuarded({ ...base, sort: "new", user: "x" })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", tag: "x" })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", date_from: "2024" })).toBe(false);
    expect(depthGuarded({ ...base, sort: "old", date_to: "2024" })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", curated_only: true })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", frontpage_only: true })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", questions_only: true })).toBe(false);
    expect(depthGuarded({ ...base, sort: "new", min_karma: 1 })).toBe(false);
    expect(depthGuarded({ ...base, sort: "top" })).toBe(false);
  });
  it("¶2.2 step 5 a tag resolution answered after the 40 s mark leaves no time for the mandatory list: the timeout error", async () => {
    const h = H([]); h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const out = await h.call("list_posts", { tag: "interpretability-ml-and-ai", query: "interpretability" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("Error (timeout): The forum did not answer in time while running list_posts (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
    expect(h.forum.requests).toHaveLength(1);
  });
  it("Q32 a query with no letter or digit left after sanitizing is bad_input before any request, as in search", async () => {
    for (const query of ["!!!", "-"]) {
      const h = H([]);
      const out = await h.call("list_posts", { tag: "interpretability-ml-and-ai", query });
      expect(out.text).toBe(`Error (bad_input): query: ${JSON.stringify(query)} leaves nothing to search for (no letters or digits). Give words to search for, or leave out query.`);
      expect(h.forum.requests).toEqual([]);
    }
  });

  const hits = ["ey2024Post0000001", "eyUntagged0000001", "eyEventPost000001", "eyQuickTakes00001", "eySubQuestion0001", "anonNoteOnInterp1", "eyTaggedLate00001", "rejectedPost00001", "unlistedPost00001"];
  const by = (u: RawUserRef) => ({ userId: u._id, user: u });
  /** The hits' documents, all by `person`, its anonymous and rejected posts included. */
  const hitDocs = (person: RawUserRef) => {
    const own = (id: string, o: Partial<RawPostCard>) => card(id, { ...o, ...by(person) });
    return [own("eyUntagged0000001", { tagRelevance: {} }), own("eyEventPost000001", { isEvent: true }), own("eyQuickTakes00001", { shortform: true }),
      own("eySubQuestion0001", { hiddenRelatedQuestion: true, question: true }), own("anonNoteOnInterp1", { hideAuthor: true }),
      own("eyTaggedLate00001", { tagRelevance: { [INTERP]: 2 } }), own("rejectedPost00001", { rejected: true }), own("unlistedPost00001", { unlisted: true })];
  };
  const section = (facets: string[][], ids: string[]) => searchEntry({ index: "posts_karma", query: "interpretability", page: 0, hitsPerPage: 10, facetFilters: facets,
    numericFilters: ["publicDateMs>=1704067200000", "postedAt<1735689600000"] }, { hits: ids.map((id) => ({ objectID: id, _id: id })), nbHits: ids.length, nbPages: 1 }, "§5.4");
  const mainList = (person?: RawUserRef) => gqlEntry({ root: "posts", view: "userPosts", terms: { userId: person?._id ?? EY, sortedBy: "top", after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z" }, limit: 40, offset: 0, enableTotal: true },
    { results: [card("ey2024Post0000001", { tagRelevance: { [INTERP]: 3 }, postedAt: "2024-03-01T00:00:00.000Z", ...(person && by(person)) })], totalCount: 1 }, "§6.2");

  it("¶5b example 3 Q38 Q40 Q57 P7 D11: tagged posts, then the untagged section from search; 4 requests cold", async () => {
    // A made-up person, whose own anonymous post only the anonymity rule leaves out.
    const P = SAMPLE_PERSON;
    const h = H([samplePersonEntry(), mainList(P), section([[`tags._id:-${INTERP}`], [`userId:${P._id}`]], hits), hydrate(hitDocs(P))]);
    const out = (await h.call("list_posts", { user: P.slug, tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: "interpretability" })).text;
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["graphql", "graphql", "search", "graphql"]);
    const q = JSON.parse(h.forum.requests[2].body).queries[0];
    expect(q).toMatchObject({ indexName: "posts_karma", params: { query: "interpretability", hitsPerPage: 10, page: 0,
      facetFilters: [[`tags._id:-${INTERP}`], [`userId:${P._id}`]], numericFilters: ["publicDateMs>=1704067200000", "postedAt<1735689600000"] } });
    expect(out).toContain('Also matching "interpretability", not tagged "Interpretability (ML & AI)"');
    expect(out).toContain(CAVEAT["C-COAUTHOR-SEARCH"]);
    expect(out).toContain("post_id eyUntagged0000001");
    expect(out).toContain("post_id eySubQuestion0001");
    for (const id of ["eyEventPost000001", "eyQuickTakes00001", "anonNoteOnInterp1", "eyTaggedLate00001", "rejectedPost00001", "unlistedPost00001"]) expect(out).not.toContain(id);
    expect(out.split("post_id ey2024Post0000001").length - 1).toBe(1);
    expect(out).not.toContain("the forum's loose count");
    expectClean(h);
  });
  it("without user, sub-questions and group posts are dropped from the untagged section", async () => {
    const tagList = gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: INTERP, sortedBy: "top" }, limit: 20, offset: 0, enableTotal: true }, { results: [], totalCount: 0 }, "§10.4");
    const h = H([tagList, searchEntry({ index: "posts_karma", query: "interpretability", page: 0, hitsPerPage: 10, facetFilters: [[`tags._id:-${INTERP}`]] },
      { hits: [{ objectID: "eySubQuestion0001", _id: "eySubQuestion0001" }, { objectID: "eyUntagged0000001", _id: "eyUntagged0000001" }], nbHits: 2, nbPages: 1 }, "§5.4"),
      hydrate([card("eySubQuestion0001", { hiddenRelatedQuestion: true, question: true }), card("eyUntagged0000001", { tagRelevance: {} })])]);
    const out = (await h.call("list_posts", { tag: "interpretability-ml-and-ai", query: "interpretability" })).text;
    expect(out).toContain("eyUntagged0000001");
    expect(out).not.toContain("eySubQuestion0001");
  });
  it("the section continues with the cursor once the tagged list has ended", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `moreUntagged${String(i).padStart(5, "0")}`);
    const docs = ids.map((id) => card(id, { tagRelevance: {} }));
    const h = H([mainList(), section([[`tags._id:-${INTERP}`], [`userId:${EY}`]], ids), hydrate(docs)]);
    const p1 = (await h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: "interpretability" })).text;
    expect(p1).not.toContain("moreUntagged00010");
    const c = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    const p2 = (await h.call("list_posts", { cursor: c })).text;
    expect(p2).toContain('Also matching "interpretability", not tagged "Interpretability (ML & AI)" (continued)');
    expect(p2).toContain("moreUntagged00010");
    expect(p2).not.toContain("moreUntagged00000");
  });
  it("¶3.6 two streams: the tagged list continues first; once it ends, the section resumes where page 1 left it", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `moreUntagged${String(i).padStart(5, "0")}`);
    const tagged = [1, 2, 3].map((i) => card(`taggedPost0000000${i}`, { tagRelevance: { [INTERP]: 3 }, baseScore: 100 - i }));
    const h = H([gqlEntry({ ...(mainList().match as GraphqlMatch), limit: 20 }, { results: tagged, totalCount: 3 }, "§6.2"),
      section([[`tags._id:-${INTERP}`], [`userId:${EY}`]], ids), hydrate(ids.map((id) => card(id, { tagRelevance: {} })))]);
    const args = { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 2, query: "interpretability" };
    const p1 = (await h.call("list_posts", args)).text;
    expect(p1).toContain("post_id taggedPost00000002"); expect(p1).not.toContain("taggedPost00000003");
    expect(p1).toContain('Also matching "interpretability", not tagged "Interpretability (ML & AI)"\n');
    expect(p1).toContain("post_id moreUntagged00009"); expect(p1).not.toContain("moreUntagged00010");
    expect(p1).toMatch(/\(next: posts 3–4\)\. Rankings can shift between pages as votes arrive\.$/);
    const p2 = (await h.call("list_posts", { cursor: /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1] })).text;
    expect(p2).toContain("post_id taggedPost00000003"); expect(p2).not.toContain("Also matching");
    expect(p2).toMatch(/\(next: untagged matches 11–12\)\.$/);
    const p3 = (await h.call("list_posts", { cursor: /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p2)![1] })).text;
    expect(p3).toContain("(continued)\n• "); expect(p3).toContain("post_id moreUntagged00010"); expect(p3).not.toContain("taggedPost");
    // the continuations re-send page 1's requests, answered from the raw-response cache (the section's hydrate is the same)
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["graphql", "graphql", "search", "graphql"]);
    expectClean(h);
  });
  it("¶7 the section's requests are optional on page 1: at the request cap it stops early, and the cursor shows it from its start", async () => {
    const untaggedRows = Array.from({ length: 20 }, (_, i) => card(`untaggedRow${String(i).padStart(6, "0")}`, { tagRelevance: {} }));
    const ids = ["moreUntagged00000", "moreUntagged00001"];
    const h = H([gqlEntry({ root: "posts", view: "userPosts", terms: (mainList().match as GraphqlMatch).terms }, { results: untaggedRows, totalCount: 80 }, "§4.5"),
      section([[`tags._id:-${INTERP}`], [`userId:${EY}`]], ids), hydrate(ids.map((id) => card(id, { tagRelevance: {} })))]);
    const p1 = (await h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", query: "interpretability" })).text;
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["graphql", "graphql", "graphql", "graphql", "graphql", "search"]);
    expect(p1).toMatch(/Stopped early \(request cap\); call list_posts with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(p1).not.toContain("Also matching");
    const p2 = (await h.call("list_posts", { cursor: /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1] })).text;
    expect(p2).toContain('Also matching "interpretability", not tagged "Interpretability (ML & AI)"\n• ');
    expect(p2).toContain("post_id moreUntagged00000");
    expect(p2.endsWith("End of results.")).toBe(true);
  });
  it("Q32 a rewritten query is echoed with its removals, and the section's head line says so", async () => {
    const P = SAMPLE_PERSON;
    const h = H([samplePersonEntry(), mainList(P), section([[`tags._id:-${INTERP}`], [`userId:${P._id}`]], hits), hydrate(hitDocs(P))]);
    const out = (await h.call("list_posts", { user: P.slug, tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: '"interpretability"' })).text;
    expect(out).toContain('query "\\"interpretability\\"" · searched as: interpretability · query: removed quote characters');
    expect(out).toContain('Also matching "interpretability" (query: removed quote characters), not tagged "Interpretability (ML & AI)"');
  });
  it("both empty: the filtered-list template names the untagged search and does not suggest it", async () => {
    const tagList = gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: INTERP, sortedBy: "top" }, limit: 20, offset: 0, enableTotal: true }, { results: [], totalCount: 0 }, "§10.4");
    const h = H([tagList, searchEntry({ index: "posts_karma", query: "interpretability", page: 0, hitsPerPage: 10, facetFilters: [[`tags._id:-${INTERP}`]] }, { hits: [], nbHits: 0 }, "§5.4")]);
    const out = (await h.call("list_posts", { tag: "interpretability-ml-and-ai", query: "interpretability" })).text;
    expect(out).toContain('No posts match: tagged "Interpretability (ML & AI)" (tag_slug interpretability-ml-and-ai) or untagged and matching "interpretability".\n');
    expect(out).not.toContain("add query");
    expectClean(h);
  });
  it("¶3.3 a cached scan serves only its own order: af_top and tag_relevance over the same posts are sorted each their way", async () => {
    const terms = { userId: EY, sortedBy: "top", filterSettings: { tags: [{ tagId: INTERP, filterMode: "Required" }] } };
    const a = light("afLowRelPost00001", { af: true, afBaseScore: 10, baseScore: 5, tagRelevance: { [INTERP]: 2 } });
    const b = light("lwHighRelPost0001", { af: false, baseScore: 100, tagRelevance: { [INTERP]: 9 } });
    const h = H([scan("userPosts", terms, [a, b]), hydrate([card(a._id), card(b._id)]), hydrate([card(b._id), card(a._id)])]);
    const call = (sort: string) => h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", sort });
    const af = (await call("af_top")).text;
    expect(af.indexOf(a._id)).toBeLessThan(af.indexOf(b._id));
    const rel = (await call("tag_relevance")).text;
    expect(rel.indexOf(b._id)).toBeLessThan(rel.indexOf(a._id));
    expectClean(h);
  });
  it("¶7 the untagged section's search request stays within the 4 MB estimate", async () => {
    const main100 = { ...mainList(), match: { ...(mainList().match as object), limit: 100 } } as FixtureEntry; // limit 50 → raw page 100
    const h = H([main100, section([[`tags._id:-${INTERP}`], [`userId:${EY}`]], [])]);
    await h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 50, query: "interpretability" });
    const { estimateBytes } = await import("../../src/forum/search");
    expect(estimateBytes(JSON.parse(h.forum.requests.find((r) => r.endpoint === "search")!.body).queries)).toBeLessThanOrEqual(4_194_304);
  });
});
