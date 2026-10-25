import { describe, it, expect } from "vitest";
import { searchHydrateOps } from "../../src/forum/templates/search";
import { documentFor } from "../../src/forum/templates/op";
import { estimateBytes } from "../../src/forum/search";
import { CAVEAT } from "../../src/render/messages";
import { createHarness, expectClean } from "../support/harness";
import { ANON_AUTHOR, gqlEntry, rawPostCard, rawSeqCard, rawUserCard, searchEntry } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";

const FAMS = ["posts", "comments", "joins", "users", "tags", "sequences", "search"] as const;
const H = (extra: FixtureEntry[] = []) => createHarness({ families: FAMS, extra });
const call = async (args: Record<string, unknown>, h = H()) => ({ h, out: await h.call("search", args) });
const bodies = (h: ReturnType<typeof H>) => h.forum.requests.filter((r) => r.endpoint === "search").map((r) => JSON.parse(r.body));

describe("search", () => {
  it("search_hydrate: exact text of every kind's hydrate", () => {
    const ops = [...searchHydrateOps("post", ["uMQ3cqWDPHhjtiesc"]), ...searchHydrateOps("comment", ["HRDoDnHv8bvoW7oPZ"]), ...searchHydrateOps("user", ["nmk3nLpQE89dMRzzN"]),
      ...searchHydrateOps("tag", ["56yXXrcxRjrQs6z9R"]), ...searchHydrateOps("sequence", ["5g5TkQTe9rmPS5vvM"])];
    expect(documentFor("search_hydrate", ops).startsWith('query search_hydrate { p: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc"]}}, limit: 1) { results { ...POST_CARD } } c1: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_LIST } } u: users(selector: {usersByUserIds: {userIds: ["nmk3nLpQE89dMRzzN"]}}, limit: 1) { results { ...USER_CARD howOthersCanHelpMe { markdown } howICanHelpOthers { markdown } } } t1: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_CARD } } s: sequences(selector: {default: {sequenceIds: ["5g5TkQTe9rmPS5vvM"]}}, limit: 1) { results { ...SEQ_CARD } } }')).toBe(true);
    expect(searchHydrateOps("post", [])).toEqual([]);
  });

  it("Q25 refused sorts per kind, with the reason", async () => {
    expect((await call({ kind: "sequence", query: "rationality", sort: "top" })).out.text)
      .toBe("Error (bad_input): sort: kind sequence can't be sorted by top (the forum's sequences index has no karma order). Use relevance, new or old.");
    expect((await call({ kind: "tag", query: "rationality", sort: "new" })).out.text)
      .toBe("Error (bad_input): sort: kind tag is sorted by relevance only (imported pages carry Arbital-era dates, and a page's karma is the likes on the page itself). Use relevance.");
  });
  it("facet-table refusals, with the reason", async () => {
    const t = async (a: Record<string, unknown>) => (await call(a)).out.text;
    expect(await t({ kind: "sequence", query: "x", user: "eliezer_yudkowsky" })).toBe("Error (bad_input): user: kind sequence can't be filtered by author. For a person's sequences use list_sequences {user}.");
    expect(await t({ kind: "user", query: "x", tag: "ai" })).toBe("Error (bad_input): tag: kind user can't be filtered by tag. Use kind post or comment.");
    expect(await t({ kind: "post", query: "x", post: "uMQ3cqWDPHhjtiesc" })).toBe('Error (bad_input): post: only kind comment can be filtered by post. Set kind "comment".');
    expect(await t({ kind: "tag", query: "x", af_only: true })).toBe("Error (bad_input): af_only: wiki pages have no AF status. Remove af_only for kind tag.");
    expect(await t({ kind: "user", query: "x", date_from: "2024" })).toBe("Error (bad_input): date_from: kind user has no posting date to filter. Dates filter kinds post and comment only.");
  });
  it("Q39 search takes one tag", async () => {
    expect((await call({ query: "x", tag: ["ai", "rationality"] })).out.text).toMatch(/^Error \(bad_input\): tag: /);
  });
  it("query or phrases is required unless a filter is combined with sort new, old or top", async () => {
    expect((await call({})).out.text).toBe("Error (bad_input): query: give query or phrases. Or combine a filter (user, tag, post) with sort new, old or top to list everything matching the filters.");
    const { h } = await call({ user: "eliezer_yudkowsky", sort: "new" });
    expect(bodies(h)[0].options).toEqual({ emptyStringSearchResults: "default" });
    expect(bodies(h)[0].queries[0]).toMatchObject({ indexName: "posts_newest_first", params: { query: "", hitsPerPage: 10, page: 0, facetFilters: [["userId:nmk3nLpQE89dMRzzN"]] } });
  });
  it("a query with no letter or digit left after sanitizing counts as absent: without phrases or a filter listing it is refused, and nothing is sent", async () => {
    for (const query of ["'", "-"]) {
      const { h, out } = await call({ query });
      expect(out.text).toBe(`Error (bad_input): query: ${JSON.stringify(query)} leaves nothing to search for (no letters or digits). Give words to search for, or use phrases.`);
      expect(h.forum.requests).toHaveLength(0);
    }
  });
  it("¶8 a query that is not well-formed text is refused before anything is sent", async () => {
    const { h, out } = await call({ query: "ab\u{D800}" });
    expect(out.text).toBe("Error (bad_input): query: contains a character that is not valid text (an unpaired surrogate). Remove it and try again.");
    expect(h.forum.requests).toHaveLength(0);
  });
  it("Q29 a loose phrase with a date or karma sort is refused", async () => {
    expect((await call({ phrases: ["GPT-4.5"], sort: "new" })).out.text)
      .toBe('Error (bad_input): phrases: "GPT-4.5" has punctuation inside a word or accented letters, which the forum\'s search deletes, so it is searched loosely. Loose phrases work only with sort relevance.');
  });
  it("Q29 loose mode: sent as plain words, every hit checked exactly, k of m reported", async () => {
    const { h, out } = await call({ phrases: ["GPT-4.5"] });
    expect(bodies(h)[0].queries[0].params.query).toBe("GPT 4 5");
    expect(out.text).toContain("post_id gpt45Exact0000001");
    expect(out.text).not.toContain("gpt45Loose0000001");
    expect(out.text).toContain("1 of the first 2 hits contain the exact phrase");
  });
  it("Q135 the apostrophe rule: searched without the possessive, the other form labelled", async () => {
    const { h, out } = await call({ phrases: ["Newcomb's problem"] });
    expect(bodies(h)[0].queries[0].params.query).toBe('"Newcomb problem"');
    expect(out.text).toContain('searched as: "Newcomb problem"');
    expect(out.text).toContain('matches without the possessive ("Newcomb problem")');
  });
  it("Q41 Q45 Q46 the loose count is shown; karma comes from the hydrate, not the hit; hit bodies are discarded", async () => {
    const { h, out } = await call({ phrases: ["inner alignment"], limit: 1 });
    expect(out.text).toContain("about 569 matches (the forum's loose count)");
    expect(out.text).toContain("karma 1,055");
    expect(out.text).not.toContain("karma 170");
    expect(out.text).not.toContain("PLANTED-BODY-TAIL");
    expect(out.text).toContain(CAVEAT["C-SEARCH"]);
    expectClean(h);
  });
  it("phrase hits that matched only elsewhere are dropped and counted; a deadline stops the second round", async () => {
    const h = H(); h.forum.inject({ endpoint: "graphql", delayMs: 41_000 });
    const out = (await h.call("search", { phrases: ["inner alignment"], limit: 3 })).text;
    expect(out).toContain("1 hit matched only on the title, author name or formatting and was dropped");
    expect(out).toMatch(/Stopped early \(time limit\); call search with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });
  it("Q43 Q50.42 P16 P1 comment hits take post titles only from the hydrated join", async () => {
    const out = (await call({ kind: "comment", query: "orthogonality" })).out.text;
    expect(out).toContain("on a post that is not publicly visible");
    expect(out).not.toContain("PLANTED-HIDDEN-TITLE");
    expect(out).not.toContain("draftPost00000001");
  });
  it("Q122 P2 P3 a comment's joined post passes the visibility rules", async () => {
    const out = (await call({ kind: "comment", query: "joined" })).out.text;
    expect(out).not.toContain("rejectedPost00001");
    expect(out).toContain("reachable by link only");
  });
  it("Q126 P16 with a tag filter, only comment hits on public posts show and no count is shown", async () => {
    const out = (await call({ kind: "comment", query: "orthogonality", tag: "ai" })).out.text;
    expect(out).toContain("comment_id HRDoDnHv8bvoW7oPZ");
    expect(out).not.toContain("onHiddenPostCmnt1");
    expect(out).not.toContain("the forum's loose count");
  });
  it("¶4.2 step 8 P16 with a tag filter, a wiki-discussion comment is not shown either: it is not on a publicly visible post", async () => {
    const extra = [searchEntry({ index: "comments", query: "wiki talk", page: 0, hitsPerPage: 20, facetFilters: [["tags:sYm3HiWcfZvrGu3ui"]] }, {
      hits: [
        { objectID: "wikiDiscussCmnt01", _id: "wikiDiscussCmnt01", body: "A comment on wiki talk.", _snippetResult: { body: { value: "A comment on **wiki** **talk**." } } },
        { objectID: "HRDoDnHv8bvoW7oPZ", _id: "HRDoDnHv8bvoW7oPZ", body: "Where I agree and disagree; wiki talk aside.", _snippetResult: { body: { value: "**wiki** **talk** aside." } } },
      ],
      nbHits: 2,
    }, "§5.4, §5.7, §8.11")];
    const { h, out } = await call({ kind: "comment", query: "wiki talk", tag: "ai" }, H(extra));
    expect(out.text).toContain("comment_id HRDoDnHv8bvoW7oPZ");
    expect(out.text).not.toContain("wikiDiscussCmnt01");
    expect(out.text).not.toContain("the forum's loose count");
    expectClean(h);
  });
  it("Q47 hits the hydrate refuses or the rules hide are dropped", async () => {
    const out = (await call({ kind: "comment", query: "refused" })).out.text;
    expect(out).not.toContain("unrevAfterCmnt001");
    expect(out).toContain("comment_id unrevBeforeCmnt01");
  });
  it("Q121 debate turns among comment hits are flagged", async () => {
    const out = (await call({ kind: "comment", query: "debate" })).out.text;
    expect(out).toContain("comment_id debateTurnCmnt001");
    expect(out).toContain("debate turn");
  });
  it("Q48 Q124 P7 anonymous-author hits never name the author", async () => {
    const a = (await call({ query: "corrigibility" })).out.text;
    expect(a).toContain("post_id anonPost000000001");
    expect(a).toContain("author not publicly visible");
    expect(a).not.toMatch(/PLANTED|anon-author|anonAuthorUser001/);
    // The made-up owner of the fixtures' anonymous items, given as the user filter.
    const owner = gqlEntry({ root: "GetUserBySlug", args: { slug: ANON_AUTHOR.slug } }, rawUserCard({ ...ANON_AUTHOR, groups: [] }), "§9.1");
    expect((await call({ query: "corrigibility", user: ANON_AUTHOR.slug }, H([owner]))).out.text).not.toContain("anonPost000000001");
  });
  it("Q80 Q125 P13 user hits are judged on the fields this server reads", async () => {
    const out = (await call({ kind: "user", query: "Berkeley" })).out.text;
    expect(out).toContain("user_id berkeleyBioUser01");
    expect(out).not.toContain("locationOnlyUser1");
    // the head ends with the forum's count: the dropped person adds no line
    expect(out).toContain('about 2 matches (the forum\'s loose count)\n• "Bay Area Reader"');
  });
  it("¶4.2 step 2 in loose mode exclude is applied here to people too: a person whose fields hold the excluded word is dropped", async () => {
    const ids = ["godelLogicUser001", "godelNumberUser01"];
    const user = (id: string, slug: string, bio: string) => ({ ...rawUserCard({ _id: id, slug, displayName: slug, karma: 40, groups: null, biography: { plaintextDescription: bio } }), howOthersCanHelpMe: null, howICanHelpOthers: null });
    const extra = [
      searchEntry({ index: "users", query: "Gödel", page: 0, hitsPerPage: 10 }, { hits: ids.map((id) => ({ objectID: id, _id: id })), nbHits: 2 }, "§5.2, §5.3"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: ids }, limit: 2 }, { results: [user(ids[0]!, "godel-logic", "I write on Gödel and logic."), user(ids[1]!, "godel-numbers", "Gödel numbering, mostly.")] }, "§9.1"),
    ];
    const { h, out } = await call({ kind: "user", phrases: ["Gödel"], exclude: ["logic"] }, H(extra));
    expect(bodies(h)[0].queries[0].params.query).toBe("Gödel");   // loose mode: no -logic is sent (it would delete the phrase's letters)
    expect(out.text).toContain("user_id godelNumberUser01");
    expect(out.text).not.toContain("godelLogicUser001");
    expectClean(h);
  });
  it("¶4.2 step 6 people who fail a phrase check are dropped and counted as phrase drops", async () => {
    const extra = [searchEntry({ index: "users", query: '"Berkeley"', page: 0, hitsPerPage: 10 }, {
      hits: [
        { objectID: "locationOnlyUser1", _id: "locationOnlyUser1", displayName: "Location Only", mapLocationAddress: "Berkeley, CA", _snippetResult: { mapLocationAddress: { value: "**Berkeley**, CA" } } },
        { objectID: "berkeleyBioUser01", _id: "berkeleyBioUser01", displayName: "Bay Area Reader", bio: "<p>I live near Berkeley</p>", _snippetResult: { bio: { value: "I live near **Berkeley**" } } },
      ],
      nbHits: 2,
    }, "§5.3, §5.7")];
    const { h, out } = await call({ kind: "user", phrases: ["Berkeley"] }, H(extra));
    expect(bodies(h)[0].queries[0].params.query).toBe('"Berkeley"');
    expect(out.text).toContain("user_id berkeleyBioUser01");
    expect(out.text).not.toContain("locationOnlyUser1");
    expect(out.text).toContain("1 hit matched only on the title, author name or formatting and was dropped");
    expectClean(h);
  });
  it("¶3.7 a one-hit page of a longer list prints its position; a one-hit total prints none", async () => {
    const { out: one } = await call({ phrases: ["inner alignment"], limit: 1 });
    expect(one.text).toContain("\nPosition: hits 1–1\n");
    const extra = [searchEntry({ index: "posts_karma", query: "lethalities", page: 0, hitsPerPage: 10 },
      { hits: [{ objectID: "uMQ3cqWDPHhjtiesc", _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", body: "lethalities", _snippetResult: { body: { value: "lethalities" } } }], nbHits: 1 }, "§5.8")];
    const { out: whole } = await call({ query: "lethalities", sort: "top" }, H(extra));
    expect(whole.text).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(whole.text).not.toContain("Position:");
  });
  it("¶4.2 a filter listing whose query is punctuation only echoes what was removed and no bare searched-as line", async () => {
    const { h, out } = await call({ user: "eliezer_yudkowsky", sort: "new", query: "'" });
    expect(out.isError).toBe(false);
    expect(bodies(h)[0].queries[0].params.query).toBe("");
    const request = out.text.split("\n")[1]!;
    expect(request).toMatch(/· query: removed [^·]+ ·/);
    expect(request).not.toContain("searched as");
    expect(out.text.split("\n")[0]).toBe("search — post hits (filters only)");
  });
  it("P18 sort top on comments drops hits under hidden karma, with the caveat", async () => {
    const out = (await call({ kind: "comment", query: "hidden karma", sort: "top" })).out.text;
    expect(out).not.toContain("hiddenKarmaCmnt01");
    expect(out).toContain(CAVEAT["C-HIDDEN-KARMA-ORDER"]);
  });
  it("P1 a post filter that is not publicly visible fails before any search", async () => {
    const { h, out } = await call({ kind: "comment", query: "x", post: "draftPost00000001" });
    expect(out.text).toMatch(/^Error \(not_public\): The forum refuses to show the post with the id "draftPost00000001"/);
    expect(h.forum.requests.some((r) => r.endpoint === "search")).toBe(false);
  });
  it("C-COAUTHOR-SEARCH with user; no count under an author scope", async () => {
    const out = (await call({ query: "lethalities", user: "eliezer_yudkowsky" })).out.text;
    expect(out).toContain(CAVEAT["C-COAUTHOR-SEARCH"]);
    expect(out).not.toContain("the forum's loose count");
  });
  it("¶4.2 the empty template restates the filters by name, not in the echo's arrow form, and its first hint starts a sentence", async () => {
    const byUser = (await call({ query: "zzqqzz", user: "eliezer_yudkowsky" })).out.text;
    expect(byUser).toContain('\nNo post hits match: zzqqzz, by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky). The user filter misses coauthored posts.\n');
    expect(byUser).not.toMatch(/^No post hits match:.*→/m);
    // A hint that starts with a parameter name is kept as written: `af_only` has no capital.
    const dated = (await call({ query: "zzqqzz", date_from: "2024-03", date_to: "2024-03", af_only: true })).out.text;
    expect(dated).toContain("\nNo post hits match: zzqqzz, AF only, posted 2024-03-01 to 2024-03-31 UTC. af_only and date filters narrow a lot.\n");
    const onPost = (await call({ kind: "comment", query: "zzqqzz", tag: "ai", post: "uMQ3cqWDPHhjtiesc" })).out.text;
    expect(onPost).toContain('\nNo comment hits match: zzqqzz, tagged "AI" (tag_slug ai), on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc).\n');
  });
  it("¶3.7 the dates are echoed as settings naming the period in UTC, as in list_posts, list_comments and get_feed", async () => {
    const { h, out } = await call({ query: "lethalities", date_from: "2024-03", date_to: "2024-03" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(" · date_from 2024-03-01T00:00:00.000Z · date_to 2024-03-31T23:59:59.999Z · sort relevance (default) · ");
    expect(bodies(h)[0].queries[0].params.numericFilters).toEqual(["publicDateMs>=1709251200000", "postedAt<1711929600000"]);
  });
  it("¶7 limit 50: pages added to the same POST stay within the 4 MB estimate; ≤ 5 requests", async () => {
    const extra = [0, 1, 2, 3, 4].map((page) => searchEntry({ index: "posts", query: "fifty", page, hitsPerPage: 10 }, { hits: [], nbHits: 0, nbPages: 0 }, "§5.1"));
    const h = H(extra);
    await h.call("search", { query: "fifty", limit: 50 });
    const qs = bodies(h)[0].queries;
    expect(qs.map((q: { params: { page: number } }) => q.params.page)).toEqual([0, 1, 2, 3, 4]);
    expect(estimateBytes(qs)).toBeLessThanOrEqual(4_194_304);
    expect(h.forum.requests.length).toBeLessThanOrEqual(5);
  });
  it("Q46 sort top notes that the order uses the index's karma while the karma shown is live", async () => {
    const extra = [searchEntry({ index: "posts_karma", query: "lethalities", page: 0, hitsPerPage: 10 },
      { hits: [{ objectID: "uMQ3cqWDPHhjtiesc", _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", body: "lethalities", _snippetResult: { body: { value: "lethalities" } } }], nbHits: 1 }, "§5.8")];
    const out = (await call({ query: "lethalities", sort: "top" }, H(extra))).out.text;
    expect(out).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(out).toContain("sort top ranks by karma as of the search index's last update; the karma shown is live, so the order can look slightly off.");
  });
  it("empty: the filtered-list template with the query as sent", async () => {
    expect((await call({ phrases: ["zzqq qqzz"] })).out.text).toContain('No post hits match: "zzqq qqzz".');
  });

  it("a second round fills the page when the first page's hits were dropped: one search and one hydrate each", async () => {
    const { h, out } = await call({ phrases: ["inner alignment"], limit: 2 });
    expect(out.text).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(out.text).toContain("post_id innerAlignPost001");
    expect(bodies(h).map((b) => b.queries.map((q: { params: { page: number } }) => q.params.page))).toEqual([[0], [1]]);
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["search", "graphql", "search", "graphql"]);
    expectClean(h);
  });
  it("¶3.6 a continuation resumes after the last hit shown; the cursor keeps every parameter but cursor and max_tokens, and a repeated one must match", async () => {
    const h = H();
    const first = (await h.call("search", { phrases: ["inner alignment"], limit: 1 })).text;
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(first)![1]!;
    expect(Object.keys(h.services.cursors.take("search", cursor).effective).sort())
      .toEqual(["af_only", "date_from", "date_to", "exclude", "kind", "limit", "phrases", "post", "query", "sort", "tag", "user"]);
    const next = (await h.call("search", { cursor, phrases: ["inner alignment"] })).text;
    expect(next).toContain("post_id innerAlignPost001");
    expect(next).not.toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(next).toContain("1 hit matched only on the title, author name or formatting and was dropped");
    expect((await h.call("search", { cursor, kind: "comment" })).text).toBe(
      'Error (bad_input): this cursor was issued for different parameters (kind: cursor has "post", call has "comment"). Pass only the cursor to continue, or repeat the call without it to start over.',
    );
    expectClean(h);
  });
  it("Q22 Q23 the forum's depth error ends the results with the search-depth line, not an error", async () => {
    const h = H();
    h.forum.inject({
      endpoint: "search", when: (b) => b.includes('"page":1'), status: 400,
      body: "search_phase_execution_exception: Result window is too large, from + size must be less than or equal to: [10000]",
    });
    const out = (await h.call("search", { phrases: ["inner alignment"], limit: 2 })).text;
    expect(out).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(out).toMatch(/End of reachable results: the forum's search stops at 10,000 results; add filters or phrases\.$/);
  });
  it("kind tag: hits are hydrated one tag(_id) alias each and shown as tag cards with the forum's snippet", async () => {
    const extra = [searchEntry({ index: "tags", query: "superposition", page: 0, hitsPerPage: 10, facetFilters: [] }, {
      hits: [{ objectID: "56yXXrcxRjrQs6z9R", _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", description: "Superposition lets a model store more features.",
        _snippetResult: { description: { value: "**Superposition** lets a model store more features." } } }],
      nbHits: 1,
    }, "§5.3, §10.2")];
    const { h, out } = await call({ kind: "tag", query: "superposition" }, H(extra));
    expect(h.forum.requests.map((r) => r.endpoint)).toEqual(["search", "graphql"]);
    expect(JSON.parse(h.forum.requests[1]!.body).query).toContain('t1: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_CARD } }');
    expect(out.text.split("\n")[0]).toBe('search — tag hits for "superposition"');
    expect(out.text).toContain('"Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R');
    expect(out.text).toContain('  snippet: "**Superposition** lets a model store more features."');
    expect(out.text.endsWith("End of results.")).toBe(true);
    expectClean(h);
  });
  it("kind sequence: hits are hydrated in one sequenceIds list and shown as sequence lines", async () => {
    const extra = [
      searchEntry({ index: "sequences", query: "alignment basics", page: 0, hitsPerPage: 20, facetFilters: [] }, {
        hits: [{ objectID: "SeqLightB00000001", _id: "SeqLightB00000001", title: "Alignment Basics", plaintextDescription: "The alignment basics, in order.",
          _snippetResult: { plaintextDescription: { value: "The **alignment** **basics**, in order." } } }],
        nbHits: 1,
      }, "§5.3, §11.1"),
      gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: ["SeqLightB00000001"] }, limit: 1 },
        { results: [rawSeqCard({ _id: "SeqLightB00000001", title: "Alignment Basics", af: true, postsCount: 7 })] }, "§11.1"),
    ];
    const { h, out } = await call({ kind: "sequence", query: "alignment basics" }, H(extra));
    expect(JSON.parse(h.forum.requests[1]!.body).query).toContain('s: sequences(selector: {default: {sequenceIds: ["SeqLightB00000001"]}}, limit: 1) { results { ...SEQ_CARD } }');
    expect(out.text).toContain("sequence_id SeqLightB00000001");
    expect(out.text).toContain('"Alignment Basics"');
    expect(out.text).toContain('  snippet: "The **alignment** **basics**, in order."');
    expectClean(h);
  });
  it("¶3.5 af_only is re-checked on the hydrated record: a non-AF post among the hits and a non-member person are dropped", async () => {
    const posts = ["uMQ3cqWDPHhjtiesc", "lwOnlyPost0000001"];
    const people = ["afMemberUser00001", "quinnLowUser00001"];
    const user = (id: string, slug: string, groups: string[] | null) => ({ ...rawUserCard({ _id: id, slug, displayName: slug, karma: 40, groups, biography: { plaintextDescription: "I think about lethalities." } }), howOthersCanHelpMe: null, howICanHelpOthers: null });
    const extra = [
      searchEntry({ index: "posts", query: "lethalities", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: posts.map((id) => ({ objectID: id, _id: id, body: "lethalities" })), nbHits: 2 }, "§5.4"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: posts }, limit: 2 }, { results: [rawPostCard(), rawPostCard({ _id: "lwOnlyPost0000001", title: "PLANTED-LW-ONLY", slug: "lw-only", af: false })] }, "§6.1"),
      searchEntry({ index: "users", query: "lethalities", page: 0, hitsPerPage: 10, facetFilters: [["af:true"]] }, { hits: people.map((id) => ({ objectID: id, _id: id })), nbHits: 2 }, "§5.4"),
      gqlEntry({ root: "users", view: "usersByUserIds", terms: { userIds: people }, limit: 2 }, { results: [user(people[0]!, "af-member", ["alignmentForum"]), user(people[1]!, "quinn-low", null)] }, "§9.1"),
    ];
    const h = H(extra);
    const p = (await h.call("search", { query: "lethalities", af_only: true })).text;
    expect(bodies(h)[0].queries[0].params.facetFilters).toEqual([["af:true"]]);
    expect(p).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(p).not.toContain("PLANTED-LW-ONLY");
    const u = (await h.call("search", { kind: "user", query: "lethalities", af_only: true })).text;
    expect(u).toContain("user_id afMemberUser00001");
    expect(u).not.toContain("quinnLowUser00001");
    expectClean(h);
  });
  it("¶2.2 step 5 a search answered after the 40 s mark leaves no time for the mandatory hydrate: the timeout error", async () => {
    const h = H(); h.forum.inject({ endpoint: "search", delayMs: 41_000, times: 1 });
    const out = await h.call("search", { phrases: ["inner alignment"] });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("Error (timeout): The forum did not answer in time while running search (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
    expect(h.forum.requests).toHaveLength(1);
  });
  it("Q128 the author and tag facets go out lint-clean", async () => {
    for (const args of [{ user: "eliezer_yudkowsky", sort: "new" }, { kind: "comment", query: "orthogonality", tag: "ai" }]) expectClean((await call(args)).h);
  });
});
