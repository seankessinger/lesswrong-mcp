import { describe, expect, it, vi } from "vitest";
import { getTagRequest1Ops, getTagRequest2Ops } from "../../src/forum/templates/get_tag";
import type { FixtureEntry } from "../support/fixtures";
import type { ParsedRef, PublicTagId, RawTagFull } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, handOffCursor, printedCursor } from "../support/requests";
import { deepNewTagEntries, gqlEntry, longWikiPageEntries, rawMdocRef, rawPostCard, rawTagFull, rawTagRef } from "../support/builders";
import { ANY_FORUM_COUNT } from "../support/text";

const FAMILIES = ["tags", "lists", "joins", "posts", "users"] as const;
const SLOW = "Error (timeout): The forum did not answer in time while running get_tag (about 50 s per call). Large discussions can be slow; try again, or narrow the request.";
const ref = (form: ParsedRef["form"], value: string): ParsedRef => ({ kind: "tag", form, value, given: form === "slug" ? "slug" : "id", notes: [] });
const FORUM_COUNT = "about 1,137 posts (the forum's count)";
const AI = "sYm3HiWcfZvrGu3ui";
const INTERP = "56yXXrcxRjrQs6z9R";

describe("get_tag templates", () => {
  it("request 1 by slug: tagBySlug with TAG_FULL and TagPreview with the lens text and its summaries", () => {
    const ops = getTagRequest1Ops(ref("slug", "bayes-rule"));
    expect(ops.map((o) => o.text)).toEqual([
      'a: tags(selector: {tagBySlug: {slug: "bayes-rule"}}, limit: 1) { results { ...TAG_FULL } }',
      'b: TagPreview(slug: "bayes-rule") { tag { ...TAG_FULL } lens { ...MDOC_REF contents { markdown version editedAt } } summaries { _id deleted tabTitle contents { markdown } } }',
    ]);
    expect(ops[0].template).toBe("get_tag_req1_slug");
  });

  it("request 1 by id: tag and multiDocument (summaries, parentTag, parentLens) in one operation; a bare 17-character string sends all four", () => {
    const ops = getTagRequest1Ops(ref("id", "RkznxXmmh9b5ovdSq"));
    expect(ops.map((o) => o.text)).toEqual([
      't: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...TAG_FULL } }',
      'm: multiDocument(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...MDOC_REF contents { markdown version editedAt } summaries { _id deleted tabTitle contents { markdown } } parentTag { ...TAG_FULL } parentLens { contents { markdown version editedAt } summaries { _id deleted tabTitle contents { markdown } } parentTag { ...TAG_FULL } } } }',
    ]);
    expect(ops[0].template).toBe("get_tag_req1_id");
    expect(getTagRequest1Ops(ref("idOrSlug", "RkznxXmmh9b5ovdSq")).map((o) => o.alias)).toEqual(["t", "m", "a", "b"]);
  });

  it("Q55 request 2: Required tag filter, limit + 5, enableTotal, discussion ids and one tag(_id) per Arbital page", () => {
    const ops = getTagRequest2Ops({ tagId: "56yXXrcxRjrQs6z9R" as PublicTagId, sortedBy: "top", af: true, limit: 10, core: false, arbitalIds: ["aaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbb"] });
    expect(ops.map((o) => o.text)).toEqual([
      'p: posts(selector: {tagRelevance: {tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", excludeEvents: true, af: true, filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 15, enableTotal: true) { results { ...POST_CARD contents { plaintextDescription } } totalCount }',
      'dc: comments(selector: {tagDiscussionComments: {tagId: "56yXXrcxRjrQs6z9R"}}, limit: 200) { results { _id } }',
      'ar1: tag(selector: {_id: "aaaaaaaaaaaaaaaaa"}) { result { ...TAG_REF } }',
      'ar2: tag(selector: {_id: "bbbbbbbbbbbbbbbbb"}) { result { ...TAG_REF } }',
    ]);
    expect(ops[0].template).toBe("get_tag_req2_op1");
  });

  it("Q68 the core grouping is its own isolated operation, only for core tags", () => {
    const ops = getTagRequest2Ops({ tagId: "sYm3HiWcfZvrGu3ui" as PublicTagId, sortedBy: "new", af: false, limit: 5, core: true, arbitalIds: [] });
    expect(ops[0].text).toBe('p: posts(selector: {tagRelevance: {tagId: "sYm3HiWcfZvrGu3ui", sortedBy: "new", excludeEvents: true, filterSettings: {tags: [{tagId: "sYm3HiWcfZvrGu3ui", filterMode: "Required"}]}}}, limit: 10, enableTotal: true) { results { ...POST_CARD contents { plaintextDescription } } totalCount }');
    expect(ops.at(-1)!.text).toBe('g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui", limit: 500) { tags { ...TAG_LIST } totalCount }');
    expect(ops.at(-1)!.isolate).toBe(true);
    expect(getTagRequest2Ops({ tagId: "sYm3HiWcfZvrGu3ui" as PublicTagId, sortedBy: "new", af: false, limit: 5, core: false, arbitalIds: [] }).map((o) => o.alias)).toEqual(["p", "dc"]);
  });
});

describe("get_tag: example 6", () => {
  async function interp(args: Record<string, unknown> = {}) {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_tag", { tag: "interpretability-ml-and-ai", ...args });
    return { h, out };
  }

  it("two requests; header with page type, parent, likes, forum count and discussion count", async () => {
    const { h, out } = await interp();
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text.split("\n")[0]).toBe('get_tag — "Interpretability (ML & AI)"');
    expect(out.text).toContain("sort top (default)");
    expect(out.text).toContain('Wiki page "Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R · https://www.lesswrong.com/w/interpretability-ml-and-ai');
    expect(out.text).toContain('Page type: tag · parent: "AI" (tag_slug ai)');
    expect(out.text).toContain("likes 23");
    expect(out.text).toContain(FORUM_COUNT);
    expect(out.text).toMatch(ANY_FORUM_COUNT);
    expect(out.text).toContain('3 discussion comments (get_comments {tag: "interpretability-ml-and-ai"})');
    expect(out.text).toContain("Lenses: none");
    expectClean(h);
  });

  it("Q50.30 the site's postCount is never shown here; Q50.32 the description's editedAt is the wiki text's edit date", async () => {
    const { out } = await interp();
    expect(out.text).not.toContain("1,608");
    expect(out.text).toContain("wiki text last edited 2025-03-01 (v1.6.0)");
  });

  it("Q60 P12 summaries with summary_id; deleted summaries dropped", async () => {
    const { out } = await interp();
    expect(out.text).toContain("summary_id InterpSummary0001");
    expect(out.text).toContain("Interpretability studies what happens inside models.");
    expect(out.text).not.toContain("PLANTED-Q60-summary");
    expect(out.text).not.toContain("DeletedSummary001");
  });

  it("Q55 posts re-checked: relevance 0, event and hidden rows dropped; the first 10 shown with excerpts; the text fenced", async () => {
    const { out } = await interp();
    for (const n of [1, 2, 4, 5, 7, 8, 10, 11, 12, 13]) expect(out.text).toContain(`post_id InterpPost${String(n).padStart(7, "0")}`);
    for (const n of [3, 6, 9, 14, 15]) expect(out.text).not.toContain(`post_id InterpPost${String(n).padStart(7, "0")}`);
    expect(out.text).toMatch(/--- begin text [0-9a-f]{6} \(wiki, v1\.6\.0, edited 2025-03-01; written by forum users\) ---/);
    expect(out.text).toContain("Superposition lets a model store more features than dimensions.");
  });

  it("the list_posts hand-off for top continues at the raw offset after the last post shown", async () => {
    const { h, out } = await interp();
    const cursor = handOffCursor(out.text, "list_posts")!;
    expect(out.text).toContain(`More posts: list_posts {tag: "interpretability-ml-and-ai", sort: "top", cursor: "${cursor}"}`);
    const next = await h.call("list_posts", { cursor });
    expect(next.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toContain("limit: 20, offset: 13");
    expect(next.text).toContain("post_id InterpPost0000014");
    expect(next.text).not.toContain("post_id InterpPost0000013");
    expectClean(h);
  });

  it("the list_posts hand-off for new is a keyset cursor: before boundary + 1 ms, never a deep offset", async () => {
    const { h, out } = await interp({ sort: "new", limit: 3 });
    const cursor = handOffCursor(out.text, "list_posts")!;
    expect(out.text).toContain(`More posts: list_posts {tag: "interpretability-ml-and-ai", sort: "new", limit: 3, cursor: "${cursor}"}`);
    const next = await h.call("list_posts", { cursor });
    const sent = gqlTexts(h.forum).at(-1)!;
    expect(sent).toContain('before: "2026-10-18T12:00:00.001Z"');
    expect(sent).not.toMatch(/offset: [1-9]/);
    expect(next.text).toContain("post_id InterpNew00000004");
    expect(next.text).not.toContain("post_id InterpNew00000003");
  });

  it("af_only filters the posts with the af term; its short raw page shows no forum count (P10) and needs no hand-off", async () => {
    const afRows = Array.from({ length: 3 }, (_, i) => rawPostCard({ _id: `InterpAfPost0000${i}`, af: true, tagRelevance: { "56yXXrcxRjrQs6z9R": 2 } }));
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", af: true }, limit: 15 }, { results: afRows, totalCount: 3 }, "§16")] });
    const out = await h.call("get_tag", { tag: "interpretability-ml-and-ai", af_only: true });
    expect(gqlTexts(h.forum)[1]).toContain("excludeEvents: true, af: true, filterSettings");
    expect(out.text).toContain("post_id InterpAfPost00000");
    expect(out.text).not.toContain("More posts:");
    expect(out.text).not.toMatch(ANY_FORUM_COUNT);
  });

  it("¶3.9 a tag with no visible posts is the filtered-list template, restating af_only", async () => {
    const none = gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: INTERP, sortedBy: "top", af: true }, limit: 15 }, { results: [], totalCount: 0 }, "§10.4");
    const out = await createHarness({ families: FAMILIES, extra: [none] }).call("get_tag", { tag: "interpretability-ml-and-ai", af_only: true });
    expect(out.text).toContain('No posts match: tagged "Interpretability (ML & AI)", AF only.');
    expect(out.text).not.toContain("More posts:");
  });

  it("¶4.8 step 5 a head that leaves the text less than 40 % of the page prints the posts without their excerpts", async () => {
    const words = "word ".repeat(70).trim();
    const rows = Array.from({ length: 15 }, (_, i) => ({
      ...rawPostCard({ _id: `ExcerptPost${String(i).padStart(6, "0")}`, af: false, tagRelevance: { [INTERP]: 4 } }),
      contents: { plaintextDescription: `Excerpt ${i} ${words}` },
    }));
    const extra = [gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: INTERP, sortedBy: "top" }, limit: 15 }, { results: rows, totalCount: 15 }, "§10.4")];
    const small = await createHarness({ families: FAMILIES, extra }).call("get_tag", { tag: "interpretability-ml-and-ai", max_tokens: 2000 });
    const large = await createHarness({ families: FAMILIES, extra }).call("get_tag", { tag: "interpretability-ml-and-ai" });
    for (let i = 0; i < 10; i++) expect(small.text).toContain(`post_id ExcerptPost${String(i).padStart(6, "0")}`);
    expect(small.text).not.toContain("> Excerpt 0");
    expect(large.text).toContain("> Excerpt 0 word");
  });

  it("P12 only visible subtags are listed", async () => {
    const { out } = await interp();
    expect(out.text).toContain('subtags: "Sparse Autoencoders" (tag_slug sparse-autoencoders)');
    expect(out.text).not.toContain("PLANTED");
  });

  it("200 discussion rows print 200+", async () => {
    const many = gqlEntry({ root: "comments", view: "tagDiscussionComments", terms: { tagId: "56yXXrcxRjrQs6z9R" } },
      { results: Array.from({ length: 200 }, (_, i) => ({ _id: `dc${String(i).padStart(15, "0")}` })) }, "§10.7");
    const out = await createHarness({ families: FAMILIES, extra: [many] }).call("get_tag", { tag: "interpretability-ml-and-ai" });
    expect(out.text).toContain('200+ discussion comments (get_comments {tag: "interpretability-ml-and-ai"})');
  });

  it("¶2.2 step 5 a slow request 1: page 1 shows the page without its posts and stops early; the continuation sends request 2", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const p1 = await h.call("get_tag", { tag: "interpretability-ml-and-ai" });
    expect(p1.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(1);
    expect(p1.text).toContain('Wiki page "Interpretability (ML & AI)"');
    expect(p1.text).not.toContain("post_id InterpPost0000001");
    expect(p1.text).toMatch(/Stopped early \(time limit\); call get_tag with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    const p2 = await h.call("get_tag", { cursor: printedCursor(p1.text)! });
    expect(p2.text).toContain("post_id InterpPost0000001");
    expect(p2.text).not.toBe(SLOW);
  });

  it("the list_posts hand-off for new continues past the 2,000th post through keyset windows, never a deep offset", async () => {
    const h = createHarness({ families: FAMILIES, extra: deepNewTagEntries() });
    const first = await h.call("get_tag", { tag: "deep-new-tag", sort: "new", limit: 50 });
    let cursor = handOffCursor(first.text, "list_posts");
    let last = "";
    for (let i = 0; cursor && i < 45; i++) { last = (await h.call("list_posts", { cursor })).text; cursor = printedCursor(last); }
    expect(last).toContain("post_id deepNew0000002049");
    expect(last.trimEnd().endsWith("End of results.")).toBe(true);
    expect(gqlTexts(h.forum).filter((t) => t.includes("tagRelevance")).some((t) => /offset: [1-9]/.test(t))).toBe(false);
  });

  it("section and match work as in get_post; section out of range and section with match are bad_input", async () => {
    const { out: s2 } = await interp({ section: 2 });
    expect(s2.text).toContain("Circuits analysis traces features through layers.");
    expect(s2.text).not.toContain("Scaling these methods is hard.");
    const { out: m } = await interp({ match: "superposition" });
    expect(m.text).toMatch(/1 of \d+ paragraphs contain "superposition"\./);
    // The hit is an item as in get_post: `section N · paragraph M`, then the paragraph quoted (render/records matchHitText).
    expect(m.text).toMatch(/^section \d+ · paragraph \d+\n> Superposition lets a model store more features than dimensions\./m);
    expect(m.text).not.toContain("Circuits analysis");
    const { out: s4 } = await interp({ section: 4 });
    expect(s4.text).toMatch(/^Error \(bad_input\): section: this page has 3 sections/);
    const { out: both } = await interp({ section: 1, match: "models" });
    expect(both.text).toBe("Error (bad_input): match: can't be combined with section. Give section or match, not both.");
  });
});

describe("get_tag: lenses, summaries, wiki-only and Arbital pages", () => {
  it("a wiki-only Arbital page: lenses with lens_slug and word counts, P12 Arbital relations, no posts", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_tag", { tag: "bayes-rule" });
    expect(out.text).toContain("Page type: wiki-only page");
    expect(out.text).toContain("Wiki-only page: it has no tagged posts.");
    expect(out.text).toContain('Lenses (2): lens_slug bayes-rule-guide "Guide" (2,410 words) · lens_slug bayes-rule-fast "Fast" (400 words)');
    expect(out.text).toContain('Related Arbital pages: requires "Probability" (tag_slug probability)');
    expect(out.text).not.toMatch(/PLANTED/);
    expect(gqlTexts(h.forum)[1].match(/ar\d+: tag\(/g)).toHaveLength(3);
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("Q132 a lens slug opens that lens with the lens's own summaries; ¶3.1.2 the echo says the lens was opened", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_tag", { tag: "bayes-rule-guide" });
    expect(out.text.split("\n")[1]).toBe(`Request: tag → "Bayes' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq) · lens_slug bayes-rule-guide of page "Bayes' rule" · sort top (default) · limit 10 (default)`);
    expect(out.text).not.toContain("→ page");
    expect(out.text).toContain(`Lens "Guide" · lens_slug bayes-rule-guide of "Bayes' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq)`);
    expect(out.text).toContain("The guide explains Bayes' rule with examples.");
    expect(out.text).toContain("summary_id GuideSummary0001x");
    expect(out.text).toMatch(/\(lens "Guide", v1\.2\.0, edited 2024-07-07; written by forum users\)/);
  });

  it("a lens id opens the lens (app.missing_document on t is expected); a lens summary's id opens its lens", async () => {
    const h = createHarness({ families: FAMILIES });
    const lens = await h.call("get_tag", { tag: "BayesGuideLens001" });
    expect(lens.isError).toBe(false);
    expect(lens.text).toContain("lens_slug bayes-rule-guide");
    const summary = await h.call("get_tag", { tag: "LensSummary000001" });
    expect(summary.isError).toBe(false);
    expect(summary.text).toContain("The guide explains Bayes' rule with examples.");
    // ¶3.1.2: a lens's summary opens the lens, and the echo says so
    expect(summary.text).toContain(`summary_id LensSummary000001 → lens "Guide" (lens_slug bayes-rule-guide) of page "Bayes' rule"`);
    expect(summary.text).not.toContain("→ page");
  });

  it("P12 admin-only pages and lenses or summaries whose page or lens is hidden read as not found; a deleted page is not_public", async () => {
    const h = createHarness({ families: FAMILIES });
    expect((await h.call("get_tag", { tag: "admin-only-page" })).text).toBe('Error (not_found): No publicly visible wiki page has the slug "admin-only-page".');
    // ¶8: a bare 17-character string, tried as id and as slug, reads in the slug form with the find hint
    expect((await h.call("get_tag", { tag: "AdminPageLens0001" })).text).toBe('Error (not_found): No publicly visible wiki page has the slug "AdminPageLens0001". Slugs are case-sensitive; to look up a name use find {items: [{kind: "tag", query: "AdminPageLens0001"}]}.');
    expect((await h.call("get_tag", { tag: "DeadLensSummary01" })).text).toBe('Error (not_found): No publicly visible wiki page has the slug "DeadLensSummary01". Slugs are case-sensitive; to look up a name use find {items: [{kind: "tag", query: "DeadLensSummary01"}]}.');
    const deleted = await h.call("get_tag", { tag: "DeletedTagPage001" });
    expect(deleted.text).toMatch(/^Error \(not_public\): The forum refuses to show .* it is a wiki page that is not publicly visible/);
    expect(gqlTexts(h.forum).join("\n")).not.toContain("tagRelevance");
  });

  it("¶2.3 a hidden page leaves no raw response behind, and its not_found is remembered for 5 minutes (no second request)", async () => {
    const h = createHarness({ families: FAMILIES });
    const evict = vi.spyOn(h.services, "evictResponses");
    const first = await h.call("get_tag", { tag: "admin-only-page" });
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict.mock.calls[0]![0].length).toBeGreaterThan(0);
    const again = await h.call("get_tag", { tag: "admin-only-page" });
    expect(again.text).toBe(first.text);
    expect(h.forum.requests).toHaveLength(1);
  });
});

describe("get_tag: placeholders and a page's own summary", () => {
  it("an empty placeholder page says so", async () => {
    const out = await createHarness({ families: FAMILIES }).call("get_tag", { tag: "placeholder-page" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("This wiki page is an empty placeholder.");
  });

  it("a page summary's summary_id opens the page it summarizes", async () => {
    const out = await createHarness({ families: FAMILIES }).call("get_tag", { tag: "InterpSummary0001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Wiki page "Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai');
    // ¶3.1.2: the page was opened, so the summary stands for its page in the echo
    expect(out.text).toContain('summary_id InterpSummary0001 → page "Interpretability (ML & AI)"');
  });
});

describe("get_tag: core tags, budget and partial results", () => {
  it("Q68 a core tag previews 10 grouped tags and hands off to list_tags at index 10; totalCount never shown", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_tag", { tag: "ai" });
    expect(out.text).toContain("Page type: core tag");
    expect(out.text).toContain("Tags grouped under this core tag (first 10 of the forum's list):");
    expect(out.text).toContain("tag_slug grouped-10");
    expect(out.text).not.toContain("tag_slug grouped-11");
    expect(out.text).not.toMatch(/4,?321/);
    const cursor = handOffCursor(out.text, "list_tags")!;
    expect(out.text).toContain(`More tags under "AI": list_tags {tag: "ai", cursor: "${cursor}"}`);
    const rest = await h.call("list_tags", { cursor });
    expect(rest.text).toContain("tag_slug grouped-11");
    expect(rest.text).toContain("tag_slug grouped-12");
    expect(rest.text).not.toContain("tag_slug grouped-10");
    expect(h.forum.requests).toHaveLength(2);
  });

  /** A lens of the AI core page, by its slug only (TagPreview returns the lens and its page). */
  const aiLens = (): FixtureEntry[] => {
    const page = rawTagFull({ _id: AI, name: "AI", slug: "ai", core: true, parentTag: null, coreTagId: null });
    const lens = {
      ...rawMdocRef({ _id: "AiOverviewLens001", slug: "ai-overview", title: "Overview", tabTitle: "Overview", parentTag: rawTagRef({ _id: AI, name: "AI", slug: "ai", core: true }) }),
      contents: { markdown: "An overview of AI.", version: "1.0.0", editedAt: "2025-04-04T00:00:00.000Z" },
    };
    return [
      gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "ai-overview" }, limit: 1 }, { results: [] }, "§10.2"),
      gqlEntry({ root: "TagPreview", args: { slug: "ai-overview" } }, { tag: page, lens, summaries: [] }, "§10.2"),
    ];
  };

  it("Q68 a lens of a core page hands off to list_tags, with the cursor alone and with the printed call", async () => {
    const h = createHarness({ families: FAMILIES, extra: aiLens() });
    const out = await h.call("get_tag", { tag: "ai-overview" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Lens "Overview" · lens_slug ai-overview of "AI"');
    const cursor = handOffCursor(out.text, "list_tags")!;
    expect(out.text).toContain(`More tags under "AI": list_tags {tag: "ai-overview", cursor: "${cursor}"}`);
    for (const args of [{ cursor }, { tag: "ai-overview", cursor }, { tag: AI, cursor }]) {
      const rest = await h.call("list_tags", args);
      expect(rest.isError, JSON.stringify(args)).toBe(false);
      expect(rest.text).toContain("tag_slug grouped-11");
      expect(rest.text).not.toContain("tag_slug grouped-10");
    }
    // Every continuation reads the resolution and the grouping from the caches get_tag filled.
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("Q68 a grouping cached before request 2 is used as read: g is not sent, and its expiry during request 2 costs no third request", async () => {
    const h = createHarness({ families: FAMILIES });
    await h.call("list_tags", { tag: "ai" }); // caches the grouping (and the resolution)
    h.clock.advance(60 * 60_000 - 10_000); // the grouping has 10 s left; the resolution has expired
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("tagDiscussionComments"), delayMs: 20_000, times: 1 });
    const out = await h.call("get_tag", { tag: "ai" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("tag_slug grouped-10");
    expect(h.forum.requests).toHaveLength(4);
    expect(gqlTexts(h.forum)[3]).not.toContain("TagsByCoreTagId");
  });

  it("a failed grouping is a Partial: line, not an error", async () => {
    const failing: FixtureEntry = { source: "§4.8", match: { root: "TagsByCoreTagId", args: { coreTagId: "sYm3HiWcfZvrGu3ui" } }, error: { message: "Something went wrong", dataNull: true } };
    const h = createHarness({ families: FAMILIES, extra: [failing] });
    const out = await h.call("get_tag", { tag: "ai" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: tags grouped under this core tag unavailable (forum_error: Something went wrong).");
    expect(out.text).toContain("Page type: core tag");
  });

  it("Partial: a request 2 that fails whole leaves the posts and the discussion count partial, the page and its text shown", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("tagDiscussionComments"), status: 429, times: 1 });
    const out = await h.call("get_tag", { tag: "interpretability-ml-and-ai" });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/^Partial: tagged posts unavailable \(rate_limited: The forum is limiting requests \(HTTP 429\)/m);
    expect(out.text).toMatch(/^Partial: discussion count unavailable \(rate_limited: /m);
    expect(out.text).toContain("Superposition lets a model store more features than dimensions.");
    expect(out.text).not.toContain("post_id InterpPost");
    expect(out.text).not.toContain("discussion comments");
  });

  it("the posts are always on page 1; a long text continues with a slice cursor without repeating them", async () => {
    const h = createHarness({ families: FAMILIES, extra: longWikiPageEntries() });
    const first = await h.call("get_tag", { tag: "long-wiki-page", max_tokens: 4000 });
    for (const i of [1, 2, 3]) expect(first.text).toContain(`post_id LongPagePost0000${i}`);
    expect(first.text).toContain("[… continues: about ");
    expect(first.text).toMatch(/More available: call get_tag with cursor "c_[A-Za-z0-9_-]{22}" \(next: text from \d+ %\)\./);
    const second = await h.call("get_tag", { cursor: printedCursor(first.text)! });
    expect(second.text).not.toContain("LongPagePost");
    expect(second.text).toMatch(/Paragraph \d+ of the long page/);
    expect(h.forum.requests.length).toBeLessThanOrEqual(3);
  });

  it("¶3.6 a continuation pasted back whole with tag continues like the cursor alone; another page is bad_input", async () => {
    const h = createHarness({ families: FAMILIES, extra: longWikiPageEntries() });
    const first = await h.call("get_tag", { tag: "long-wiki-page", max_tokens: 4000 });
    const cursor = printedCursor(first.text)!;
    const alone = await h.call("get_tag", { cursor, max_tokens: 4000 });
    const pasted = await h.call("get_tag", { tag: "long-wiki-page", cursor, max_tokens: 4000 });
    expect(pasted.isError).toBe(false);
    // The same page but for its cursor and its fence nonce.
    const same = (text: string): string => text.replace(/c_[A-Za-z0-9_-]{22}/g, "c_…").replace(/(--- (?:begin|end) text) [0-9a-f]{6}/g, "$1 ……");
    expect(same(pasted.text)).toBe(same(alone.text));
    expect(pasted.text).toMatch(/^Position: text \d+–\d+ %$/m);
    const other = await h.call("get_tag", { tag: "interpretability-ml-and-ai", cursor });
    expect(other.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(tag: /);
  });
});

/** A page with no posts and no discussion, whose text is `description` (null for a page that never had one). */
function bareWikiPageEntries(id: string, slug: string, description: RawTagFull["description"]): FixtureEntry[] {
  const page = rawTagFull({ _id: id, name: `Page ${slug}`, slug, core: false, wikiOnly: true, parentTag: null, coreTagId: null, description });
  return [
    gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug } }, { results: [page] }, "§10.2"),
    gqlEntry({ root: "TagPreview", args: { slug } }, { tag: page, lens: null, summaries: [] }, "§10.2"),
    gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: id } }, { results: [], totalCount: 0 }, "§10.4"),
    gqlEntry({ root: "comments", view: "tagDiscussionComments", terms: { tagId: id } }, { results: [] }, "§10.7"),
  ];
}

describe("get_tag: the text's edge cases", () => {
  it("a page whose text is null reads as an empty text: section is bad_input and match finds nothing, as for an empty string", async () => {
    const h = createHarness({ families: FAMILIES, extra: bareWikiPageEntries("NullTextPage00001", "null-text-page", null) });
    const whole = await h.call("get_tag", { tag: "null-text-page" });
    expect(whole.isError).toBe(false);
    const section = await h.call("get_tag", { tag: "null-text-page", section: 1 });
    expect(section.text).toBe("Error (bad_input): section: this page has no headings. Read it without section, or use match.");
    const match = await h.call("get_tag", { tag: "null-text-page", match: "anything" });
    expect(match.isError).toBe(false);
    expect(match.text).toContain('0 of 0 paragraphs contain "anything".');
    expect(match.text).toContain('match "anything"');
    expectClean(h);
  });
  it("¶3.7 a match hit cut by the page resumes under its `section N · paragraph M` line on the next page", async () => {
    const hit = Array.from({ length: 300 }, (_, i) => `sentence ${i + 1} mentions the needle word again`).join(", ") + ".";
    const description = { plaintextDescription: null, markdown: `# Intro\n\n${hit}`, version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 2400 };
    const h = createHarness({ families: FAMILIES, extra: bareWikiPageEntries("LongHitPage000001", "long-hit-page", description) });
    const pages = [await h.call("get_tag", { tag: "long-hit-page", match: "needle", max_tokens: 2000 })];
    for (let c = printedCursor(pages.at(-1)!.text); c !== undefined && pages.length < 20; c = printedCursor(pages.at(-1)!.text)) {
      pages.push(await h.call("get_tag", { cursor: c, max_tokens: 2000 }));
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.isError).toBe(false);
      expect(p.text).toContain('1 of 1 paragraphs contain "needle".');
      expect(p.text).toMatch(/^section 1 · paragraph 1$/m);
    }
    expect(pages.map((p) => p.text).join("\n").match(/sentence 300 mentions/g)).toHaveLength(1);
    expectClean(h);
  });
  it("¶4.8 Paging: the text edited between pages: the continuation keeps its character position and says so (as get_post's Q50.15)", async () => {
    const entries = longWikiPageEntries();
    const h = createHarness({ families: FAMILIES, extra: entries });
    const first = await h.call("get_tag", { tag: "long-wiki-page", max_tokens: 4000 });
    const cursor = printedCursor(first.text)!;
    const page = (entries[0]!.result as { results: RawTagFull[] }).results[0]!;
    const edited = { ...page, description: { ...page.description!, version: "1.1.0", editedAt: "2025-02-01T00:00:00.000Z" } };
    h.clock.advance(300_001); // the raw-response cache has lapsed: request 1 reaches the forum again
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("long-wiki-page"), body: JSON.stringify({ data: { a: { results: [edited] }, b: { tag: edited, lens: null, summaries: [] } } }) });
    const second = await h.call("get_tag", { cursor, max_tokens: 4000 });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("The wiki text was edited since the previous page (now v1.1.0); continuing at the same position.");
    expect(second.text).toMatch(/^Position: text \d+–\d+ %$/m);
    expect(second.text).toMatch(/Paragraph \d+ of the long page/);
    expect(second.text).not.toContain("LongPagePost");
    // Without an edit the note is absent.
    const same = createHarness({ families: FAMILIES, extra: longWikiPageEntries() });
    const p1 = await same.call("get_tag", { tag: "long-wiki-page", max_tokens: 4000 });
    expect((await same.call("get_tag", { cursor: printedCursor(p1.text)!, max_tokens: 4000 })).text).not.toContain("was edited since the previous page");
  });
});
