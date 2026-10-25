import { describe, it, expect } from "vitest";
import { listPostsEffective } from "../../src/tools/list_posts";
import { listPostsOp } from "../../src/forum/templates/list_posts";
import { documentFor } from "../../src/forum/templates/op";
import { CAVEAT, DEPTH_HINT, END_DEPTH, endDepth, SHORT_PAGE_NOTE } from "../../src/render/messages";
import { createHarness, expectClean } from "../support/harness";
import { SAMPLE_PERSON, gqlEntry, rawPostCard, samplePersonEntry } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";
import type { RawPostCard } from "../../src/types";
import { ANY_FORUM_COUNT } from "../support/text";

const FAMS = ["posts", "lists", "users", "tags"] as const;
const H = (extra: FixtureEntry[] = []) => createHarness({ families: FAMS, extra });
const card = (id: string, o: Partial<RawPostCard> = {}) => rawPostCard({ _id: id, title: `Title ${id}`, slug: id.toLowerCase(), postedAt: "2024-05-01T00:00:00.000Z",
  baseScore: 50, af: false, frontpageDate: "2024-05-02T00:00:00.000Z", contents: { plaintextDescription: "An excerpt." }, ...o });
// the rows at offset 0, then a catch-all `[]` for later raw pages (refills and the empty-page rule of ¶3.6)
const view = (v: string, terms: Record<string, unknown>, results: RawPostCard[], extra: Record<string, unknown> = {}): FixtureEntry[] => [
  gqlEntry({ root: "posts", view: v, terms, offset: 0, ...extra }, { results, totalCount: extra.enableTotal ? results.length : null }, "§6.2"),
  gqlEntry({ root: "posts", view: v, terms }, { results: [], totalCount: 0 }, "§4.4")];
const Y24 = { after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z" };

describe("list_posts: views", () => {
  it("list_posts_userPosts, list_posts_tagRelevance and list_posts_sitewide: exact text", () => {
    const full = { ...Y24, af: true as const, question: true as const, karmaThreshold: 10 };
    expect(documentFor("list_posts_userPosts", [listPostsOp("userPosts", { userId: "nmk3nLpQE89dMRzzN", tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", ...full, filter: "curated" }, { limit: 40, offset: 0, enableTotal: true }, "excerpt")]).startsWith(
      'query list_posts_userPosts { l: posts(selector: {userPosts: {userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z", excludeEvents: true, af: true, question: true, karmaThreshold: 10, filter: "curated", filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 40, offset: 0, enableTotal: true) { results { ...POST_CARD_EXCERPT } totalCount } }')).toBe(true);
    expect(documentFor("list_posts_tagRelevance", [listPostsOp("tagRelevance", { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "relevance", ...full, filter: "frontpage" }, { limit: 40, offset: 0, enableTotal: true }, "excerpt")]).startsWith(
      'query list_posts_tagRelevance { l: posts(selector: {tagRelevance: {tagId: "56yXXrcxRjrQs6z9R", sortedBy: "relevance", after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z", excludeEvents: true, af: true, question: true, karmaThreshold: 10, filter: "frontpage", filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 40, offset: 0, enableTotal: true) { results { ...POST_CARD_EXCERPT } totalCount } }')).toBe(true);
    expect(documentFor("list_posts_sitewide", [
      listPostsOp("new", { sortedBy: "new", ...full, filter: "curated" }, { limit: 40, offset: 0 }, "excerpt", "n"),
      listPostsOp("old", { sortedBy: "old", after: Y24.after }, { limit: 40 }, "excerpt", "o"),
      listPostsOp("top", { sortedBy: "top" }, { limit: 40, offset: 40 }, "excerpt", "t"),
      listPostsOp("recentComments", { sortedBy: "recentComments" }, { limit: 40 }, "excerpt", "r")]).startsWith(
      'query list_posts_sitewide { n: posts(selector: {new: {sortedBy: "new", excludeEvents: true, after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z", af: true, question: true, karmaThreshold: 10, filter: "curated"}}, limit: 40, offset: 0) { results { ...POST_CARD_EXCERPT } } o: posts(selector: {old: {sortedBy: "old", excludeEvents: true, after: "2024-01-01T00:00:00.000Z"}}, limit: 40) { results { ...POST_CARD_EXCERPT } } t: posts(selector: {top: {sortedBy: "top", excludeEvents: true}}, limit: 40, offset: 40) { results { ...POST_CARD_EXCERPT } } r: posts(selector: {recentComments: {sortedBy: "recentComments", excludeEvents: true}}, limit: 40) { results { ...POST_CARD_EXCERPT } } }')).toBe(true);
  });
  it("prerequisite errors", async () => {
    const t = async (a: Record<string, unknown>) => (await H().call("list_posts", a)).text;
    expect(await t({ sort: "tag_relevance" })).toBe("Error (bad_input): sort: tag_relevance needs tag. Give tag, or use another sort.");
    expect(await t({ sort: "curated_date" })).toBe("Error (bad_input): sort: curated_date needs curated_only. Add curated_only: true.");
    expect(await t({ sort: "af_top" })).toBe("Error (bad_input): sort: af_top needs user or tag (it ranks at most 2,000 matching posts). Add user or tag.");
    expect(await t({ query: "interpretability" })).toBe('Error (bad_input): query: needs tag; for word matches without a tag use search. Try search {query: "interpretability"}.');
  });
  it("Q58 D11 ¶5b example 3: author × tag × period through userPosts with the Required filter; coauthored kept; sub-questions and group posts flagged; containers, events and untagged dropped; no count", async () => {
    const rows = [card("ey2024Post0000001", { userId: "nmk3nLpQE89dMRzzN", tagRelevance: { "56yXXrcxRjrQs6z9R": 3 }, baseScore: 90 }),
      card("ey2024Coauthor001", { userId: "habrykaNamesake01", coauthors: [{ _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }], tagRelevance: { "56yXXrcxRjrQs6z9R": 2 }, baseScore: 80 }),
      card("quickTakesBox0001", { shortform: true, userId: "nmk3nLpQE89dMRzzN", tagRelevance: { "56yXXrcxRjrQs6z9R": 1 } }),
      card("ey2024SubQues0001", { hiddenRelatedQuestion: true, question: true, userId: "nmk3nLpQE89dMRzzN", tagRelevance: { "56yXXrcxRjrQs6z9R": 1 }, baseScore: 40 }),
      card("ey2024Group000001", { groupId: "someGroupId000001", userId: "nmk3nLpQE89dMRzzN", tagRelevance: { "56yXXrcxRjrQs6z9R": 1 }, baseScore: 30 }),
      card("ey2024Event000001", { isEvent: true, userId: "nmk3nLpQE89dMRzzN", tagRelevance: { "56yXXrcxRjrQs6z9R": 1 } }),
      card("ey2024Untagged001", { userId: "nmk3nLpQE89dMRzzN", tagRelevance: {} })];
    const h = H(view("userPosts", { userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", ...Y24 }, rows, { limit: 20, enableTotal: true }));
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top" })).text;
    const list = h.forum.requests.find((r) => r.body.includes("userPosts"))!.body;
    expect(list).toContain('filterSettings: {tags: [{tagId: \\"56yXXrcxRjrQs6z9R\\", filterMode: \\"Required\\"}]}');
    expect(list).toContain('after: \\"2024-01-01T00:00:00.000Z\\", before: \\"2025-01-01T00:00:00.000Z\\"');
    for (const id of ["ey2024Post0000001", "ey2024Coauthor001", "ey2024SubQues0001", "ey2024Group000001"]) expect(out).toContain(`post_id ${id}`);
    for (const id of ["quickTakesBox0001", "ey2024Event000001", "ey2024Untagged001"]) expect(out).not.toContain(id);
    expect(out).toContain("sub-question (not in the site's main lists)");
    expect(out).toContain("group post");
    expect(out).not.toMatch(ANY_FORUM_COUNT);
    expect(out).toContain(CAVEAT["C-TAGGED"]); expect(out).toContain(CAVEAT["C-EVENTS"]);
    expectClean(h);
  });
  it("P2 a person's own rejected post is left out of their list", async () => {
    // A made-up person, so that the post is their own and only the visibility rule leaves it out.
    const own = (id: string, o: Partial<RawPostCard> = {}) => card(id, { userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON, tagRelevance: { "56yXXrcxRjrQs6z9R": 2 }, ...o });
    const rows = [own("sampleOwnPost0001"), own("sampleOwnRej00001", { rejected: true, baseScore: 40 })];
    const h = H([samplePersonEntry(), ...view("userPosts", { userId: SAMPLE_PERSON._id, sortedBy: "top", ...Y24 }, rows, { limit: 20, enableTotal: true })]);
    const out = (await h.call("list_posts", { user: SAMPLE_PERSON.slug, tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top" })).text;
    expect(out).toContain("post_id sampleOwnPost0001");
    expect(out).not.toContain("sampleOwnRej00001");
    expectClean(h);
  });
  it("Q55 P10 tagRelevance carries the Required filter, relevance ≥ 1 is re-checked, and the forum count shows only when every filter was the forum's", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => card(`tagRow${String(i).padStart(11, "0")}`, { tagRelevance: { "56yXXrcxRjrQs6z9R": i === 19 ? 0 : 5 }, baseScore: 200 - i }));
    const e = { root: "posts", view: "tagRelevance", terms: { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top" }, limit: 20, offset: 0, enableTotal: true };
    const h = H([gqlEntry(e, { results: rows, totalCount: 1137 }, "§10.4")]);
    const out = (await h.call("list_posts", { tag: "interpretability-ml-and-ai" })).text;
    expect(out).toContain("sort top (default)");
    expect(out).toContain("about 1,137 posts (the forum's count)");
    expect(out).toMatch(ANY_FORUM_COUNT);
    expect(out).not.toContain("tagRow00000000019");
    const h2 = H([gqlEntry({ ...e, terms: { ...e.terms, filter: "frontpage" } }, { results: rows, totalCount: 1137 }, "§10.4")]);
    expect((await h2.call("list_posts", { tag: "interpretability-ml-and-ai", frontpage_only: true })).text).not.toMatch(ANY_FORUM_COUNT);
  });
  it("P10 a tag list whose whole set fits on one short raw page shows no forum count (as get_tag)", async () => {
    // a short raw page's totalCount is not the forum's count of the list (§4.5, §10.4)
    const rows = Array.from({ length: 3 }, (_, i) => card(`afTagRow${String(i).padStart(9, "0")}`, { af: true, tagRelevance: { "56yXXrcxRjrQs6z9R": 2 }, baseScore: 100 - i }));
    const h = H([gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", af: true }, limit: 20, offset: 0, enableTotal: true }, { results: rows, totalCount: 3 }, "§4.5, §16")]);
    const out = (await h.call("list_posts", { tag: "interpretability-ml-and-ai", af_only: true })).text;
    for (const r of rows) expect(out).toContain(`post_id ${r._id}`);
    expect(out).not.toMatch(ANY_FORUM_COUNT);
    expectClean(h);
  });
  it("Q8 L2 every server-side filter is re-checked; curated with frontpage checks frontpage locally", async () => {
    const h = H(view("new", { sortedBy: "new", af: true, filter: "curated", ...Y24 }, [
      card("afCurated00000001", { af: true, curatedDate: "2024-05-03T00:00:00.000Z" }),
      card("notAf000000000001", { af: false, curatedDate: "2024-05-03T00:00:00.000Z" }),
      card("afNotFront0000001", { af: true, curatedDate: "2024-05-03T00:00:00.000Z", frontpageDate: null })]));
    const out = (await h.call("list_posts", { af_only: true, curated_only: true, frontpage_only: true, date_from: "2024", date_to: "2024" })).text;
    expect(out).toContain("post_id afCurated00000001");
    expect(out).not.toContain("notAf000000000001");
    expect(out).not.toContain("afNotFront0000001");
    expect(out).toContain(CAVEAT["C-KARMA"]);
  });
  it("min_karma: under top no threshold and the list ends at the first row below N; otherwise karmaThreshold with C-KARMA-LAG; N ≤ 0 local only", async () => {
    const top = H(view("top", { sortedBy: "top" }, [card("karma200Post00001", { baseScore: 200 }), card("karma50Post000001", { baseScore: 50 }), card("karma150Post00001", { baseScore: 150 })]));
    const t = (await top.call("list_posts", { sort: "top", min_karma: 100 })).text;
    expect(top.forum.requests[0].body).not.toContain("karmaThreshold");
    expect(t).toContain("post_id karma200Post00001"); expect(t).not.toContain("karma150Post00001");
    expect(t.endsWith("End of results.")).toBe(true);
    const nw = H(view("new", { sortedBy: "new", karmaThreshold: 5, ...Y24 }, [card("karma6Post0000001", { baseScore: 6 }), card("karma4Post0000001", { baseScore: 4 })]));
    const n = (await nw.call("list_posts", { sort: "new", min_karma: 5, date_from: "2024", date_to: "2024" })).text;
    expect(n).toContain(CAVEAT["C-KARMA-LAG"]); expect(n).not.toContain("karma4Post0000001");
    const z = H(view("new", { sortedBy: "new", ...Y24 }, [card("karmaNeg000000001", { baseScore: -1 })]));
    await z.call("list_posts", { min_karma: 0, date_from: "2024", date_to: "2024" });
    expect(z.forum.requests[0].body).not.toContain("karmaThreshold");
  });
  it("min_karma under top ends a person's full list at the first row below N, with no request after it", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => card(`floorRow${String(i).padStart(9, "0")}`, { baseScore: i < 2 ? 200 - i : 50 - i, userId: "nmk3nLpQE89dMRzzN" }));
    const h = H([gqlEntry({ root: "posts", view: "userPosts", terms: { userId: "nmk3nLpQE89dMRzzN", sortedBy: "top" } }, { results: rows, totalCount: 1000 }, "§4.5")]);
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", sort: "top", min_karma: 100 })).text;
    expect(h.forum.requests).toHaveLength(2);
    expect(out).toContain("post_id floorRow000000001"); expect(out).not.toContain("floorRow000000002");
    expect(out).not.toContain(CAVEAT["C-KARMA-LAG"]);
    expect(out.endsWith("End of results.")).toBe(true);
  });
  it("Q26 new pages by keyset: before = boundary + 1 ms, ids already shown at the boundary skipped", async () => {
    const t2 = "2024-05-02T00:00:00.000Z";
    const h = H([
      ...view("new", { sortedBy: "new", after: Y24.after, before: "2024-05-02T00:00:00.001Z" }, [card("keysetB0000000001", { postedAt: t2 }), card("keysetC0000000001", { postedAt: t2 })]),
      ...view("new", { sortedBy: "new", ...Y24 }, [card("keysetA0000000001", { postedAt: "2024-05-03T00:00:00.000Z" }), card("keysetB0000000001", { postedAt: t2 }), card("keysetC0000000001", { postedAt: t2 })])]);
    const p1 = (await h.call("list_posts", { date_from: "2024", date_to: "2024", limit: 2 })).text;
    expect(p1).toContain("keysetB0000000001"); expect(p1).not.toContain("keysetC0000000001");
    const c = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    const p2 = (await h.call("list_posts", { cursor: c })).text;
    expect(h.forum.requests.at(-1)!.body).toContain('before: \\"2024-05-02T00:00:00.001Z\\"');
    expect(p2).toContain("keysetC0000000001"); expect(p2).not.toContain("keysetB0000000001");
  });
  it("Q15 offset pages in a vote-driven order carry the drift sentence", async () => {
    const h = H(view("top", { sortedBy: "top" }, Array.from({ length: 20 }, (_, i) => card(`driftRow${String(i).padStart(9, "0")}`, { baseScore: 100 - i }))));
    expect((await h.call("list_posts", { sort: "top", limit: 2 })).text).toMatch(/\(next: posts 3–4\)\. Rankings can shift between pages as votes arrive\.$/);
  });
  it("Q50.5 active: last comment dates, or no comments yet", async () => {
    const h = H(view("recentComments", { sortedBy: "recentComments", ...Y24 }, [
      card("activeA0000000001", { lastCommentedAt: "2024-06-01T00:00:00.000Z", commentCount: 3 }),
      card("activeB0000000001", { lastCommentedAt: "2024-05-01T00:00:00.000Z", commentCount: 0 })]));
    const out = (await h.call("list_posts", { sort: "active", date_from: "2024", date_to: "2024" })).text;
    expect(out).toContain("last comment 2024-06-01"); expect(out).toContain("no comments yet");
  });
  it("Q50.2 maxBaseScore is never selected; Q4 offsets never pass 2000", async () => {
    const h = H(view("top", { sortedBy: "top" }, [card("anyPost0000000001")]));
    await h.call("list_posts", { sort: "top" });
    expect(h.forum.requests[0].body).not.toContain("maxBaseScore");
    expect(h.forum.lintErrors).toEqual([]);
  });
  it("Q4 C-DEPTH: a person's top list pages by raw offset up to 2000, then ends with the reachable footer", async () => {
    // a bounded selector far deeper than 2,000 (totalCount 5000) whose raw pages hold only rows the af re-check drops
    const rows = Array.from({ length: 100 }, (_, i) => card(`deepRow${String(i).padStart(10, "0")}`, { af: false, userId: "nmk3nLpQE89dMRzzN" }));
    const h = H([gqlEntry({ root: "posts", view: "userPosts", terms: { userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", af: true } }, { results: rows, totalCount: 5000 }, "§4.4, §4.5")]);
    let out = (await h.call("list_posts", { user: "eliezer_yudkowsky", af_only: true, sort: "top", limit: 50 })).text;
    for (let calls = 1; calls < 10; calls++) {
      const next = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(out);
      if (next === null) break;
      out = (await h.call("list_posts", { cursor: next[1] })).text;
    }
    const offsets = h.forum.requests.filter((r) => r.body.includes("userPosts")).map((r) => Number(/offset: (\d+)/.exec(r.body)?.[1]));
    expect(offsets).toEqual(Array.from({ length: 21 }, (_, i) => i * 100));
    expect(h.forum.lintErrors).toEqual([]);
    // ¶3.6: the forum-limit sentence with list_posts' own hint, which names only parameters it accepts
    expect(out.endsWith(`End of reachable results: ${endDepth(DEPTH_HINT.dates)}.`)).toBe(true);
    expect(out.endsWith(`End of reachable results: ${END_DEPTH}; narrow with date_from/date_to, or use sort new or old.`)).toBe(true);
    expect(out).not.toMatch(/cursor "c_/);
  });
  it("a short page refills within the cap, then stops early with a cursor", async () => {
    // a bounded selector whose full raw pages (totalCount 1000) hold only rows the af re-check drops; 1000, not 100, so that
    // the five raw pages the cap allows after the resolve (offsets 0–80) do not reach the selector's end
    const rows = Array.from({ length: 20 }, (_, i) => card(`nonAfRow${String(i).padStart(9, "0")}`, { af: false, userId: "nmk3nLpQE89dMRzzN" }));
    const h = H([gqlEntry({ root: "posts", view: "userPosts", terms: { userId: "nmk3nLpQE89dMRzzN", af: true } }, { results: rows, totalCount: 1000 }, "§4.4, §4.5")]);
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", af_only: true })).text;
    expect(h.forum.requests).toHaveLength(6);
    expect(out).toMatch(/Stopped early \(request cap\); call list_posts with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });
  it("¶3.6 a page that is short and also stopped prints the Stopped early footer alone, never the neutral short-page note too", async () => {
    const terms = { userId: "nmk3nLpQE89dMRzzN", af: true };
    const nonAf = (page: number) => Array.from({ length: 20 }, (_, i) => card(`nonAf${page}Row${String(i).padStart(8, "0")}`, { af: false, userId: "nmk3nLpQE89dMRzzN" }));
    const h = H([
      gqlEntry({ root: "posts", view: "userPosts", terms, offset: 0 }, { results: [card("afRow00000000001", { af: true, userId: "nmk3nLpQE89dMRzzN" }), ...nonAf(0).slice(1)], totalCount: 1000 }, "§4.4, §4.5"),
      gqlEntry({ root: "posts", view: "userPosts", terms }, { results: nonAf(1), totalCount: 1000 }, "§4.4, §4.5"),
    ]);
    const out = (await h.call("list_posts", { user: "eliezer_yudkowsky", af_only: true })).text;
    expect(h.forum.requests).toHaveLength(6);
    expect(out).toContain("post_id afRow00000000001");
    expect(out).not.toContain(SHORT_PAGE_NOTE);
    expect(out).toMatch(/Stopped early \(request cap\); call list_posts with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });
  it("listPostsEffective applies the defaults; absent values are undefined; dates are period identities", () => {
    expect(listPostsEffective({ tag: "ai", af_only: false, curated_only: false, frontpage_only: false, questions_only: false, limit: 10, max_tokens: 15000 }, { tagId: "sYm3HiWcfZvrGu3ui" }))
      .toEqual({ user: undefined, tag: "sYm3HiWcfZvrGu3ui", date_from: undefined, date_to: undefined, af_only: false, curated_only: false, frontpage_only: false, questions_only: false, min_karma: undefined, sort: "top", query: undefined, limit: 10 });
    expect(listPostsEffective({ date_from: "2026", date_to: "2026", af_only: false, curated_only: false, frontpage_only: false, questions_only: false, limit: 10, max_tokens: 15000 }, {}))
      .toMatchObject({ date_from: "2026-01-01T00:00:00.000Z", date_to: "2026-12-31T23:59:59.999Z" });
  });
  it("¶3.6 a cursor used later with the same period repeated continues (the clamp moving with now is no conflict); another period is refused, printed as instants", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => card(`y26Row${String(i).padStart(11, "0")}`, { postedAt: "2026-05-01T00:00:00.000Z", tagRelevance: { "sYm3HiWcfZvrGu3ui": 5 }, baseScore: 100 - i }));
    const h = H([gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: "sYm3HiWcfZvrGu3ui", sortedBy: "top", after: "2026-01-01T00:00:00.000Z" }, offset: 0 }, { results: rows, totalCount: 1137 }, "§10.4"),
      gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: "sYm3HiWcfZvrGu3ui", sortedBy: "top", after: "2026-01-01T00:00:00.000Z" } }, { results: [], totalCount: 0 }, "§4.4")]);
    const args = { tag: "ai", date_from: "2026", date_to: "2026", limit: 2 };
    const p1 = (await h.call("list_posts", args)).text;
    expect(p1).toContain("date_to clamped to now (2026-10-22T12:00:00.000Z)");
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1)![1];
    h.clock.advance(60_000);
    const p2 = await h.call("list_posts", { ...args, cursor });
    expect(p2.isError).toBe(false);
    expect((await h.call("list_posts", { ...args, date_to: "2026-12-31", cursor })).isError).toBe(false);
    expect((await h.call("list_posts", { ...args, date_to: "2026-06", cursor })).text).toBe(
      'Error (bad_input): this cursor was issued for different parameters (date_to: cursor has "2026-12-31T23:59:59.999Z", call has "2026-06-30T23:59:59.999Z"). Pass only the cursor to continue, or repeat the call without it to start over.',
    );
  });
});
