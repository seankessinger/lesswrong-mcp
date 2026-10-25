import { describe, expect, it } from "vitest";
import { incomingPostsOp, incomingTagOps, linkBodyOp, linkResolutionOps } from "../../src/forum/templates/get_links";
import { tool } from "../../src/tools/get_links";
import type { FixtureEntry } from "../support/fixtures";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { gqlEntry, lensBacklinksFailure, rawPostCard, rawPostRef, rawTagRef } from "../support/builders";
import { rememberResolution, resolvedFrom } from "../../src/ids/resolve";
import type { ProcessedBody } from "../../src/domain/markdown";
import { DEPTH_HINT, END_DEPTH, endDepth } from "../../src/render/messages";

const HUB = "LinkHubPost000001";
const FAMILIES = ["posts", "lists", "tags", "sequences", "comments", "users", "revisions"] as const;
const FOOTNOTES = "Links inside footnotes are lost in the forum's text conversion.";

describe("get_links templates and definition", () => {
  it("incoming posts: pingbackPosts with the af term, by offset with enableTotal, or the light scan", () => {
    expect(incomingPostsOp("uMQ3cqWDPHhjtiesc", true, { limit: 20, offset: 0, enableTotal: true }, "card").text)
      .toBe('i: posts(selector: {pingbackPosts: {postId: "uMQ3cqWDPHhjtiesc", af: true}}, limit: 20, offset: 0, enableTotal: true) { results { ...POST_CARD } totalCount }');
    expect(incomingPostsOp("uMQ3cqWDPHhjtiesc", false, { limit: 2000, enableTotal: true }, "light").text)
      .toBe('il: posts(selector: {pingbackPosts: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 2000, enableTotal: true) { results { ...POST_LIGHT } totalCount }');
  });

  it("incoming wiki pages and lens pages; the body texts", () => {
    expect(incomingTagOps("56yXXrcxRjrQs6z9R").map((o) => o.text)).toEqual([
      'w: tags(selector: {pingbackWikiPages: {tagId: "56yXXrcxRjrQs6z9R"}}, limit: 500) { results { ...TAG_CARD } }',
      'lp: multiDocuments(selector: {pingbackLensPages: {documentId: "56yXXrcxRjrQs6z9R"}}, limit: 500) { results { ...MDOC_REF } }',
    ]);
    expect(linkBodyOp({ post: "uMQ3cqWDPHhjtiesc" }).text).toBe('pb: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { _id contents { version markdown } } }');
    expect(linkBodyOp({ tag: "56yXXrcxRjrQs6z9R" }).text).toBe('tb: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { _id description { version markdown } } }');
    expect(linkBodyOp({ lens: "aaaaaaaaaaaaaaaaa" }).text).toBe('lb: multiDocument(selector: {_id: "aaaaaaaaaaaaaaaaa"}) { result { _id contents { version markdown } } }');
  });

  it("Q131 the outgoing resolution request, every alias kind", () => {
    expect(linkResolutionOps({ postIds: ["uMQ3cqWDPHhjtiesc"], postSlugs: ["agi-ruin-a-list-of-lethalities"], commentIds: ["HRDoDnHv8bvoW7oPZ"],
      tagSlugs: ["ai", "interpretability-ml-and-ai"], tagOldSlugs: ["1lz"], lensSlugs: ["bayes-rule-guide"], userSlugs: ["eliezer_yudkowsky"],
      sequenceIds: ["5g5TkQTe9rmPS5vvM", "aaaaaaaaaaaaaaaaa"], hydratePostIds: ["zHhGa3iQBQcdSifFL"] }).map((o) => o.text)).toEqual([
      'p: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc"]}}, limit: 1) { results { ...POST_CARD } }',
      'ps1: posts(selector: {slugPost: {slug: "agi-ruin-a-list-of-lethalities"}}, limit: 2) { results { ...POST_CARD } }',
      'c1: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_REF post { ...POST_REF } tag { ...TAG_REF } } }',
      'ts: tags(selector: {tagsBySlugs: {slugs: ["ai", "interpretability-ml-and-ai"]}}, limit: 2) { results { ...TAG_REF } }',
      'tb1: tags(selector: {tagBySlug: {slug: "1lz"}}, limit: 1) { results { ...TAG_REF } }',
      'tp1: TagPreview(slug: "bayes-rule-guide") { tag { ...TAG_REF } lens { ...MDOC_REF } }',
      'u1: GetUserBySlug(slug: "eliezer_yudkowsky") { _id slug displayName deleted }',
      's1: sequence(selector: {_id: "5g5TkQTe9rmPS5vvM"}, allowNull: true) { result { ...SEQ_REF } }',
      's2: sequence(selector: {_id: "aaaaaaaaaaaaaaaaa"}, allowNull: true) { result { ...SEQ_REF } }',
      'h: posts(selector: {default: {exactPostIds: ["zHhGa3iQBQcdSifFL"]}}, limit: 1) { results { ...POST_CARD } }',
    ]);
    expect(linkResolutionOps({ postIds: [], postSlugs: [], commentIds: [], tagSlugs: [], tagOldSlugs: [], lensSlugs: [], userSlugs: [], sequenceIds: [], hydratePostIds: [] })).toEqual([]);
  });

  it("definition: ¶4.13 exactly one of post and tag", () => {
    expect(tool.oneOf).toEqual([["post", "tag"]]);
  });
});

describe("get_links: a post, both directions", () => {
  async function hub(args: Record<string, unknown> = {}, extra: FixtureEntry[] = []) {
    const h = createHarness({ families: FAMILIES, extra });
    const out = await h.call("get_links", { post: HUB, ...args });
    return { h, out };
  }

  it("Q50.13 Q103 four requests; incoming by the forum's order with drift; outgoing parsed from the current text, never pingbacks", async () => {
    const { h, out } = await hub();
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(4);
    const texts = gqlTexts(h.forum);
    expect(texts[1]).toContain('i: posts(selector: {pingbackPosts: {postId: "LinkHubPost000001"}}, limit: 20, offset: 0, enableTotal: true)');
    expect(texts[2]).toContain('pb: post(selector: {_id: "LinkHubPost000001"}');
    expect(texts.join("\n")).not.toContain("pingbacks");
    expect(out.text.split("\n")[0]).toBe('get_links — "A post full of links"');
    expect(out.text).toContain("Incoming (10 shown; the forum lists only linking posts with positive karma, as of each one's last edit)");
    expect(out.text.indexOf("post_id LinkingPost000001")).toBeLessThan(out.text.indexOf("post_id LinkingPost000002"));
    expect(out.text).toContain("event");
    expect(out.text).toContain("Rankings can shift between pages as votes arrive.");
    expect(out.text).toContain("Outgoing: 14 forum links, 3 external links (2 sites)");
    expect(out.text).toContain(FOOTNOTES);
    expectClean(h);
  });

  it("the subject is always read with contents.version, even when an earlier call cached the post's resolution", async () => {
    const h = createHarness({ families: FAMILIES });
    rememberResolution("post", HUB, resolvedFrom("post", rawPostRef({ _id: HUB, title: "A post full of links", slug: "a-post-full-of-links", af: false })), h.services);
    const out = await h.call("get_links", { post: HUB, direction: "outgoing" });
    expect(out.isError).toBe(false);
    expect(gqlTexts(h.forum)[0]).toContain("contents { version }");
    expect(out.text).toContain("Outgoing: 14 forum links, 3 external links (2 sites)");
  });

  it("¶2.2 step 5 past 40 s the outgoing requests are not sent: the incoming lines are shown and the page stops early", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("pingbackPosts"), delayMs: 41_000, times: 1 });
    const out = await h.call("get_links", { post: HUB });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain("Incoming (10 shown;");
    expect(out.text).not.toContain("Outgoing:");
    // ¶3.6 Drift, ¶4.13 Paging: the cursor continues a `top` (offset) list, so the stopped footer carries C-DRIFT as the `more` footer does.
    expect(out.text).toMatch(/Stopped early \(time limit\); call get_links with cursor "c_[A-Za-z0-9_-]{22}" to continue\. Rankings can shift between pages as votes arrive\.$/);
  });

  it("¶3.6 Drift: a stopped page has no C-DRIFT sentence when its cursor does not continue an offset incoming list", async () => {
    const DRIFT = "Rankings can shift between pages as votes arrive.";
    // A wiki-page backlink list is not vote-driven: the stopped page ends without the sentence.
    const tag = createHarness({ families: FAMILIES });
    tag.forum.inject({ endpoint: "graphql", when: (b) => b.includes("pingbackWikiPages"), delayMs: 41_000, times: 1 });
    const stoppedTag = await tag.call("get_links", { tag: "interpretability-ml-and-ai", limit: 1 });
    expect(stoppedTag.isError).toBe(false);
    expect(stoppedTag.text).toContain("Incoming (1 shown; wiki pages whose text links to this page");
    expect(stoppedTag.text).toMatch(/Stopped early \(time limit\); call get_links with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(stoppedTag.text).not.toContain(DRIFT);
    // A `top` list read to its end: only the outgoing part is left, so there is no vote-driven continuation to warn about.
    const rows = [1, 2, 3].map((i) => rawPostCard({ _id: `ShortList00000${i}`, title: `Short ${i}`, slug: `short-${i}`, af: false, baseScore: 10 - i }));
    const whole = [gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB }, limit: 20, offset: 0 }, { results: rows, totalCount: 3 }, "§12")];
    const done = createHarness({ families: FAMILIES, extra: whole });
    done.forum.inject({ endpoint: "graphql", when: (b) => b.includes("pingbackPosts"), delayMs: 41_000, times: 1 });
    const stoppedDone = await done.call("get_links", { post: HUB });
    expect(stoppedDone.isError).toBe(false);
    expect(stoppedDone.text).toContain("Incoming (3 shown;");
    expect(stoppedDone.text).toMatch(/Stopped early \(time limit\); call get_links with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(stoppedDone.text).not.toContain(DRIFT);
  });

  it("P1 P4 P12 Q131 forum links resolved in one request, in order of first appearance; hidden ones masked", async () => {
    const { h, out } = await hub({ direction: "outgoing" });
    const resolution = gqlTexts(h.forum).at(-1)!;
    expect(resolution).toContain('ts: tags(selector: {tagsBySlugs: {slugs: ["ai", "1lz", "bayes-rule-guide"]}}, limit: 3)');
    expect(resolution).toContain('tb2: tags(selector: {tagBySlug: {slug: "1lz"}}, limit: 1)');
    expect(resolution).toContain('tp3: TagPreview(slug: "bayes-rule-guide")');
    const lines = [
      '"Rationality: A-Z" (collection_slug rationality)',
      '"A critical look at Lean4" (post_id zHhGa3iQBQcdSifFL, LW only)',
      '"Cat-Belling Problems" (post_id SwYBLQvo8MddDcCwz, LW only)',
      'comment_id HRDoDnHv8bvoW7oPZ (AF) on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)',
      "a comment link that can't be shown",
      '"AI" (tag_slug ai)',
      `"Bayes' rule" (tag_slug bayes-rule)`,
      `lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`,
      '"Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)',
      '"Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM, LW only)',
      `"A hidden sequence" (sequence_id HiddenSequence001, LW only, not in the site's sequence lists)`,
      "a sequence link that can't be shown",
      "a post link that can't be shown (missing or not publicly visible)",
      "forum link (not resolved): https://www.lesswrong.com/about",
      "arxiv.org (2): https://arxiv.org/abs/1 · https://arxiv.org/abs/2",
      "example.com (1): https://example.com/x",
    ];
    const at = lines.map((l) => out.text.indexOf(l));
    expect(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1]))).toBe(true);
    expect(out.text).not.toMatch(/privDeletedCmnt01|HiddenDraftPost01|deletedSeq0000001|i\.png/);
    expect(h.forum.requests).toHaveLength(3);
  });

  it("a link to a collection prints the collection's title from the listing, read with the resolution request unless it is cached", async () => {
    const { h, out } = await hub({ direction: "outgoing" });
    expect(out.text).toContain('• "Rationality: A-Z" (collection_slug rationality)');
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum).at(-1)).toContain("col: collections(");
    // The listing an earlier call cached (24 hours): the request leaves it out and the title is still printed.
    const again = createHarness({ families: FAMILIES });
    again.services.caches.set("collections", "all", h.services.caches.get("collections", "all"));
    const cached = await again.call("get_links", { post: HUB, direction: "outgoing" });
    expect(cached.text).toContain('• "Rationality: A-Z" (collection_slug rationality)');
    expect(gqlTexts(again.forum).at(-1)).not.toContain("col: collections(");
    // A listing that cannot be read leaves the link by its slug alone, with the other links shown and no Partial line.
    const failing = createHarness({ families: FAMILIES, extra: [{ source: "§11.5", match: { root: "collections", view: "default", limit: 10 }, error: { message: "Something went wrong" } }] });
    const bare = await failing.call("get_links", { post: HUB, direction: "outgoing" });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.text).toContain("• collection_slug rationality");
    expect(bare.text).toContain('"A critical look at Lean4" (post_id zHhGa3iQBQcdSifFL, LW only)');
    expect(bare.text).not.toContain("Partial:");
  });

  it("af_only: the af term on incoming; outgoing post and comment links filtered locally; the echo for the rest", async () => {
    const afRows = [gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB, af: true }, limit: 20, offset: 0 }, { results: [], totalCount: 0 }, "§16")];
    const { h, out } = await hub({ af_only: true }, afRows);
    expect(gqlTexts(h.forum)[1]).toContain('pingbackPosts: {postId: "LinkHubPost000001", af: true}');
    expect(out.text).toContain("af_only does not apply to links to wiki pages, people and other sites");
    expect(out.text).not.toContain("post_id zHhGa3iQBQcdSifFL");
    expect(out.text).toContain("comment_id HRDoDnHv8bvoW7oPZ (AF)");
    expect(out.text).toContain('"AI" (tag_slug ai)');
    expect(out.text).toContain('No posts match: linking to "A post full of links" (post_id LinkHubPost000001), AF only.');
    expect(out.text).toContain("Only links in post bodies of posts with positive karma are counted.");
  });

  it("sort new: a POST_LIGHT light scan sorted locally; only the page hydrated", async () => {
    const { h, out } = await hub({ direction: "incoming", sort: "new" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[1]).toContain('il: posts(selector: {pingbackPosts: {postId: "LinkHubPost000001"}}, limit: 2000, enableTotal: true)');
    expect(gqlTexts(h.forum)[2]).toContain('exactPostIds: ["LinkingPost000002", "LinkingPost000001", "LinkingPost000003"]');
    const at = (n: number) => out.text.indexOf(`post_id LinkingPost00000${n}`);
    expect(at(2)).toBeLessThan(at(1));
    expect(at(1)).toBeLessThan(at(3));
    // `sort: "old"` is the same set the other way round, hydrated in that order
    const oldOrder = ["LinkingPost000003", "LinkingPost000001", "LinkingPost000002"];
    const hydrate = gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: oldOrder } },
      { results: oldOrder.map((id) => rawPostCard({ _id: id, title: `Linking ${id.slice(-1)}`, slug: `linking-${id.slice(-1)}`, af: false })) }, "§12");
    const oh = createHarness({ families: FAMILIES, extra: [hydrate] });
    const old = await oh.call("get_links", { post: HUB, direction: "incoming", sort: "old" });
    expect(gqlTexts(oh.forum)[2]).toContain('exactPostIds: ["LinkingPost000003", "LinkingPost000001", "LinkingPost000002"]');
    const atOld = (n: number) => old.text.indexOf(`post_id LinkingPost00000${n}`);
    expect(atOld(3)).toBeGreaterThan(0);
    expect(atOld(3)).toBeLessThan(atOld(1));
    expect(atOld(1)).toBeLessThan(atOld(2));
  });

  it("¶7 a transient 502 on the subject request is retried without charging the cap: sort new with direction both still gets its mandatory hydrate", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ status: 502, times: 1 });
    const out = await h.call("get_links", { post: HUB, sort: "new", direction: "both" });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("post_id LinkingPost000002");
    expect(out.text).toContain("Outgoing: 14 forum links, 3 external links (2 sites)");
    expect(h.forum.requests).toHaveLength(5);
  });
});

describe("get_links: a wiki page", () => {
  it("L9 P12 incoming wiki pages and lens pages; hidden ones dropped; two requests", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_links", { tag: "interpretability-ml-and-ai", direction: "incoming" });
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain("Incoming (2 shown; wiki pages whose text links to this page, newest page first)");
    expect(out.text).toContain('"Mechanistic interpretability" (tag_slug mechanistic-interpretability)');
    expect(out.text).toContain(`lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
    expect(out.text).not.toMatch(/PLANTED|AdminBacklink0001|NullPageLens00001/);
    expectClean(h);
  });

  it("L9 an error in the lens backlinks is a Partial: line", async () => {
    const h = createHarness({ families: FAMILIES, extra: [lensBacklinksFailure()] });
    const out = await h.call("get_links", { tag: "interpretability-ml-and-ai", direction: "incoming" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: lens backlinks unavailable (forum_error: Something went wrong).");
    expect(out.text).toContain('"Mechanistic interpretability" (tag_slug mechanistic-interpretability)');
  });

  it("sort with tag, af_only with tag and direction incoming, and both targets are bad_input", async () => {
    const h = createHarness({ families: FAMILIES });
    expect((await h.call("get_links", { tag: "ai", sort: "new" })).text)
      .toBe("Error (bad_input): sort: applies to incoming posts only; wiki-page backlinks come in the forum's order (newest page first). Leave sort out with tag.");
    expect((await h.call("get_links", { tag: "ai", direction: "incoming", af_only: true })).text)
      .toBe("Error (bad_input): af_only: wiki pages have no AF status. Leave af_only out, or use direction outgoing or both.");
    expect((await h.call("get_links", { post: HUB, tag: "ai" })).text).toBe("Error (bad_input): give exactly one of post, tag (got: post, tag).");
    expect(h.forum.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The caches, the two streams of a cursor, the budget and the failures.

const BIG = "BigLinksPost00001";
const EY = { _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" };
const WRONG = JSON.stringify({ data: null, errors: [{ message: "Something went wrong" }] });

/** A post whose current text is `markdown`, as the subject request and the text request read it. */
const postWithText = (markdown: string, id = BIG): FixtureEntry =>
  gqlEntry({ root: "post", id }, {
    result: { ...rawPostRef({ _id: id, title: "Many links", slug: "many-links", af: false }), postedAt: "2023-01-01T00:00:00.000Z", user: EY, contents: { version: "1.0.0", markdown } },
  }, "§12");

/** Every page of a call, following the cursor each one prints. */
async function pagesOf(h: ReturnType<typeof createHarness>, first: { text: string }, args: Record<string, unknown> = {}): Promise<string[]> {
  const pages = [first.text];
  for (let cursor = printedCursor(first.text); cursor !== undefined && pages.length < 12; cursor = printedCursor(pages.at(-1)!)) {
    pages.push((await h.call("get_links", { cursor, ...args })).text);
  }
  return pages;
}

describe("get_links: the text, its caches and its failures", () => {
  it("Q50.13 the outgoing text comes from get_post's body cache when it holds it, and this tool writes nothing back", async () => {
    const h = createHarness({ families: FAMILIES });
    const entry: ProcessedBody = { md: "See https://example.org/a and https://www.lesswrong.com/rationality", version: "2.0.0", words: 7, suggestionsRemoved: false, footnotes: true, headings: [] };
    h.services.caches.set("body", `${HUB}@2.0.0`, entry);
    const out = await h.call("get_links", { post: HUB, direction: "outgoing" });
    expect(h.forum.requests).toHaveLength(1);
    expect(out.text).toContain("Outgoing: 1 forum link, 1 external link (1 site)");
    expect(out.text).toContain("• example.org (1): https://example.org/a");
    expect(out.text).toContain(FOOTNOTES);
    expect(h.services.caches.get("body", `${HUB}@2.0.0`)).toEqual(entry);

    const fetched = createHarness({ families: FAMILIES });
    expect((await fetched.call("get_links", { post: HUB, direction: "outgoing" })).isError).toBe(false);
    expect(fetched.services.caches.get("body", `${HUB}@2.0.0`)).toBeUndefined();
  });

  it("¶2.2 step 5 the cursor of a page stopped at 40 s reads the outgoing links next, after the incoming items already shown", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("pingbackPosts"), delayMs: 41_000, times: 1 });
    const first = await h.call("get_links", { post: HUB });
    const second = await h.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("Position: incoming 11–20 · outgoing 1–16 of 16");
    expect(second.text).toContain("post_id LinkingPost000011");
    expect(second.text).not.toContain("post_id LinkingPost000010");
    expect(second.text).toContain("Outgoing: 14 forum links, 3 external links (2 sites)");
    const texts = gqlTexts(h.forum);
    expect(texts).toHaveLength(4);
    expect(texts[2]).toContain("pb: post(");
    expect(texts[3]).toContain("get_links_resolution");
  });

  it("¶3.6 a long outgoing list continues with the cursor: every link once, in order, each page saying where it stands", async () => {
    const sites = Array.from({ length: 150 }, (_, i) => `https://site${i}.example.org/page-${i}`);
    const h = createHarness({ families: FAMILIES, extra: [postWithText(sites.join("\n"))] });
    const pages = await pagesOf(h, await h.call("get_links", { post: BIG, direction: "outgoing", max_tokens: 2000 }), { max_tokens: 2000 });
    expect(pages.length).toBeGreaterThan(1);
    const seen = pages.flatMap((page) => [...page.matchAll(/^• (site\d+)\.example\.org \(1\): /gm)].map((m) => m[1]));
    expect(seen).toEqual(sites.map((_, i) => `site${i}`));
    expect(pages[0]).toContain("Outgoing: 0 forum links, 150 external links (150 sites)");
    expect(pages.slice(1).join("\n")).not.toContain("Outgoing:");
    const from = pages.map((page) => Number(/^Position: outgoing (\d+)–(\d+) of 150$/m.exec(page)?.[1]));
    const to = pages.map((page) => Number(/^Position: outgoing (\d+)–(\d+) of 150$/m.exec(page)?.[2]));
    expect(from[0]).toBe(1);
    expect(to.at(-1)).toBe(150);
    for (let i = 1; i < pages.length; i++) expect(from[i]).toBe(to[i - 1] + 1);
    expect(pages.at(-1)).toMatch(/End of results\.$/);
  });

  it("¶3.6 a text edited between two pages keeps the cursor's place and says so", async () => {
    const sites = Array.from({ length: 150 }, (_, i) => `https://site${i}.example.org/page-${i}`);
    const h = createHarness({ families: FAMILIES, extra: [postWithText(sites.join("\n"))] });
    const first = await h.call("get_links", { post: BIG, direction: "outgoing", max_tokens: 2000 });
    expect(first.text).not.toContain("The text changed");
    h.clock.advance(6 * 60_000);
    const edited = JSON.stringify({ data: { pb: { result: { _id: BIG, contents: { version: "1.1.0", markdown: sites.slice(1).join("\n") } } } } });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_body"), body: edited });
    const second = await h.call("get_links", { cursor: printedCursor(first.text), max_tokens: 2000 });
    expect(second.text).toContain("The text changed since the previous page (now v1.1.0); the outgoing list may have shifted.");
    expect(second.text).toMatch(/^Position: outgoing 55–/m);
  });

  it("a text request that fails is a Partial: line; the incoming items stay and the cursor goes on with them only", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_body"), body: WRONG });
    const out = await h.call("get_links", { post: HUB });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: outgoing links unavailable (forum_error:");
    expect(out.text).toContain("Incoming (10 shown;");
    expect(out.text).not.toContain("Outgoing:");
    expect(out.text).toMatch(/\(next: incoming 11–20\)/);
  });

  it("an answer with an alias error other than not_found or not_public is a Partial: line too, not a list of links that can't be shown", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_resolution"), body: WRONG });
    const out = await h.call("get_links", { post: HUB, direction: "outgoing" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: outgoing links unavailable (forum_error:");
    expect(out.text).not.toContain("can't be shown");
    expect(out.text).toMatch(/End of results\.$/);
  });

  it("the page of sort new is hydrated with the request the outgoing links share, so its failure is the call's", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_resolution"), body: WRONG });
    const out = await h.call("get_links", { post: HUB, direction: "incoming", sort: "new" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Error \(forum_error\): /);
  });

  it("a request that fails on the way (a 500 after its retry) is a Partial: line for the outgoing links, and the call's error for the page they share a request with", async () => {
    const outgoing = createHarness({ families: FAMILIES });
    outgoing.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_resolution"), status: 500, body: "boom", times: 2 });
    const partial = await outgoing.call("get_links", { post: HUB, direction: "outgoing" });
    expect(partial.isError).toBe(false);
    expect(partial.text).toContain("Partial: outgoing links unavailable (forum_error:");
    expect(partial.text).not.toContain("Outgoing:");

    const sorted = createHarness({ families: FAMILIES });
    sorted.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_resolution"), status: 500, body: "boom", times: 2 });
    const failed = await sorted.call("get_links", { post: HUB, direction: "incoming", sort: "new" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/^Error \(forum_error\): /);
  });

  it("D1 a continuation checks the subject again: a post that has since become hidden is not_found", async () => {
    const h = createHarness({ families: FAMILIES });
    const first = await h.call("get_links", { post: HUB, direction: "incoming" });
    h.clock.advance(6 * 60_000);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("post_by_id"), body: JSON.stringify({ data: { p: { result: null }, s: { results: [] } } }) });
    const second = await h.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.text).toMatch(/^Error \(not_found\): /);
  });

  it("¶3.6 given parameters are resolved before they are compared: the same post by URL continues, another direction is bad_input", async () => {
    const h = createHarness({ families: FAMILIES });
    const cursor = printedCursor((await h.call("get_links", { post: HUB })).text);
    const same = await h.call("get_links", { cursor, post: "https://www.lesswrong.com/posts/LinkHubPost000001/a-post-full-of-links", limit: 10 });
    expect(same.isError).toBe(false);
    expect(same.text).toContain("post_id LinkingPost000011");
    const other = await h.call("get_links", { cursor, direction: "outgoing" });
    expect(other.text).toBe('Error (bad_input): this cursor was issued for different parameters (direction: cursor has "both", call has "outgoing"). Pass only the cursor to continue, or repeat the call without it to start over.');
    expect((await h.call("get_links", { cursor, tag: "ai" })).text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(tag: /);
  });
});

describe("get_links: the incoming list", () => {
  it("¶3.5 af_only re-checks the light rows locally, and names what it left out of the outgoing links", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_links", { post: HUB, direction: "incoming", sort: "new", af_only: true });
    expect(out.text).toContain('No posts match: linking to "A post full of links" (post_id LinkHubPost000001), AF only.');
    expect(h.forum.requests).toHaveLength(2);

    const both = await createHarness({ families: FAMILIES }).call("get_links", { post: HUB, direction: "outgoing", af_only: true });
    expect(both.text).toContain("Outgoing: 12 forum links, 3 external links (2 sites); af_only left out 2 links to posts and comments not on the Alignment Forum");
    expect(both.text).toContain("a comment link that can't be shown");
    expect(both.text).toContain("a post link that can't be shown (missing or not publicly visible)");
  });

  it("sort new pages the sorted list: a cursor of kind list, only the page shown hydrated", async () => {
    const cards = ["LinkingPost000001", "LinkingPost000002", "LinkingPost000003"].map((id, i) =>
      rawPostCard({ _id: id, title: `Linking ${i + 1}`, slug: `linking-${i + 1}`, af: false, postedAt: ["2024-03-01", "2025-01-01", "2023-06-01"][i] + "T00:00:00.000Z" }));
    const extra = [
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["LinkingPost000002", "LinkingPost000001"] } }, { results: [cards[0], cards[1]] }, "§12"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["LinkingPost000003"] } }, { results: [cards[2]] }, "§12"),
    ];
    const h = createHarness({ families: FAMILIES, extra });
    const first = await h.call("get_links", { post: HUB, direction: "incoming", sort: "new", limit: 2 });
    expect(first.text).toContain("Incoming (2 shown;");
    expect(first.text).toMatch(/\(next: incoming 3–3\)\.$/);
    expect(first.text).not.toContain("Rankings can shift");
    const second = await h.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.text).toContain("post_id LinkingPost000003");
    expect(second.text).not.toContain("post_id LinkingPost000001");
    expect(second.text).toMatch(/End of results\.$/);
    expect(gqlTexts(h.forum)).toHaveLength(4);
  });

  it("a new/old continuation after the light set's cache lapsed reads the set again and resumes after the last id shown", async () => {
    const cards = ["LinkingPost000001", "LinkingPost000002", "LinkingPost000003"].map((id, i) =>
      rawPostCard({ _id: id, title: `Linking ${i + 1}`, slug: `linking-${i + 1}`, af: false, postedAt: ["2024-03-01", "2025-01-01", "2023-06-01"][i] + "T00:00:00.000Z" }));
    const extra = [
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["LinkingPost000002", "LinkingPost000001"] } }, { results: [cards[0], cards[1]] }, "§12"),
      gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: ["LinkingPost000003"] } }, { results: [cards[2]] }, "§12"),
    ];
    const h = createHarness({ families: FAMILIES, extra });
    const first = await h.call("get_links", { post: HUB, direction: "incoming", sort: "new", limit: 2 });
    expect(first.text).toMatch(/\(next: incoming 3–3\)\.$/);
    h.clock.advance(11 * 60_000);
    const second = await h.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.isError, second.text).toBe(false);
    expect(second.text).toContain("post_id LinkingPost000003");
    expect(second.text).not.toMatch(/post_id LinkingPost00000[12]/);
    expect(second.text).not.toContain("The list changed");
    expect(second.text).toMatch(/End of results\.$/);
    // The scan cache (10 minutes) had lapsed: the set was read once per call, and the sorted list resumed after the last id shown.
    expect(gqlTexts(h.forum).filter((t) => t.includes("il: posts("))).toHaveLength(2);
    expectClean(h);
  });

  it("the heading counts the incoming items that fit: when not all do, the page ends there and the cursor goes on with the rest", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      rawPostCard({ _id: `LongTitle${String(i + 1).padStart(8, "0")}`, title: `T${i + 1} ${"word ".repeat(58)}`.trim(), slug: `long-title-${i + 1}`, af: false, baseScore: 100 - i }));
    const extra = [gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB }, limit: 20, offset: 0 }, { results: rows, totalCount: 12 }, "§12")];
    const h = createHarness({ families: FAMILIES, extra });
    const pages = await pagesOf(h, await h.call("get_links", { post: HUB, max_tokens: 2000 }), { max_tokens: 2000 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const shown = [...page.matchAll(/^• "T\d+ /gm)].length;
      if (shown > 0) expect(page).toContain(`Incoming (${shown} shown;`);
    }
    expect(pages[0]).not.toContain("Outgoing:");
    const ids = pages.flatMap((page) => [...page.matchAll(/post_id (LongTitle\d+)/g)].map((m) => m[1]));
    expect(ids).toEqual(rows.map((r) => r._id));
    expect(pages.join("\n").match(/Outgoing: 14 forum links/g)).toHaveLength(1);
  });

  it("P2 P3 P7 D11 incoming rows: only listable posts, an event stays, no anonymous author named", async () => {
    const anon = { _id: "anonAuthorUser001", slug: "anon-author", displayName: "PLANTED-P7-anonymous" };
    const rows = [
      rawPostCard({ _id: "RejectedLinker0001", title: "PLANTED rejected", slug: "a-rejected-linker", rejected: true, af: false }),
      rawPostCard({ _id: "UnlistedLinker0001", title: "PLANTED unlisted", slug: "an-unlisted-linker", unlisted: true, af: false }),
      rawPostCard({ _id: "ContainerLinker001", title: "PLANTED container", slug: "a-container-linker", shortform: true, af: false }),
      rawPostCard({ _id: "EventLinker0000001", title: "A meetup", slug: "a-meetup", isEvent: true, hideAuthor: true, userId: anon._id, user: anon, af: false }),
      rawPostCard({ _id: "PlainLinker0000001", title: "A plain post", slug: "a-plain-post", af: false }),
    ];
    const extra = [gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB }, limit: 20, offset: 0 }, { results: rows, totalCount: 5 }, "§12")];
    const h = createHarness({ families: FAMILIES, extra });
    const out = await h.call("get_links", { post: HUB, direction: "incoming" });
    expect(out.text).toContain("Incoming (2 shown;");
    expect(out.text).toContain('"A meetup" — author not publicly visible');
    expect(out.text).toContain("post_id EventLinker0000001");
    expect(out.text).toContain("post_id PlainLinker0000001");
    expect(out.text).not.toMatch(/PLANTED|RejectedLinker|UnlistedLinker|ContainerLinker|anonAuthorUser001|anon-author/);
    expect(out.text).toMatch(/End of results\.$/);
  });

  it("when the text request fails on a sorted page, the page is still hydrated, by a request of its own", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_links_body"), body: WRONG });
    const out = await h.call("get_links", { post: HUB, sort: "new" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: outgoing links unavailable (forum_error:");
    expect(out.text.indexOf("post_id LinkingPost000002")).toBeLessThan(out.text.indexOf("post_id LinkingPost000001"));
    const texts = gqlTexts(h.forum);
    expect(texts).toHaveLength(4);
    expect(texts[3]).toMatch(/^query get_links_resolution \{ h: posts\(/);
  });

  it("C-DEPTH a top list ends at offset 2000 with the forum-limit sentence and get_links' own hint: af_only shortens the list (never date_from or sort, which it refuses here)", async () => {
    const rows = [1, 2, 3].map((i) => rawPostCard({ _id: `DeepLinking${String(i).padStart(6, "0")}`, title: `Deep ${i}`, slug: `deep-${i}`, af: true }));
    const extra = [
      gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB }, limit: 20, offset: 2000 }, { results: rows, totalCount: 2500 }, "§12"),
      gqlEntry({ root: "posts", view: "pingbackPosts", terms: { postId: HUB, af: true }, limit: 20, offset: 2000 }, { results: rows, totalCount: 2500 }, "§12"),
    ];
    const h = createHarness({ families: FAMILIES, extra });
    const deep = (afOnly: boolean) => h.services.cursors.issue(
      "get_links", { post: HUB, direction: "incoming", ...(afOnly && { af_only: true }) },
      { post: HUB, tag: undefined, direction: "incoming", sort: "top", af_only: afOnly, limit: 10 },
      { streams: [{ kind: "offset", shown: 1990, offset: 2000 }, { kind: "slice", shown: 0, block: 0, offset: 0 }], current: 0, data: { incoming: true, outgoing: false } },
    );
    const out = await h.call("get_links", { cursor: deep(false) });
    expect(out.text).toContain("Position: incoming 1,991–1,993");
    expect(out.text.split("\n").at(-1)).toBe(`End of reachable results: ${endDepth(DEPTH_HINT.afOnly)}.`);
    expect(out.text).not.toMatch(/date_from|sort new/);
    // with af_only already given nothing the tool accepts shortens the list further: the bare sentence
    const af = await h.call("get_links", { cursor: deep(true) });
    expect(af.text.split("\n").at(-1)).toBe(`End of reachable results: ${END_DEPTH}.`);
  });
});

describe("get_links: a cursor and its subject", () => {
  it("¶2.3 a remembered not_found for the post subject costs no request", async () => {
    const h = createHarness({ families: FAMILIES });
    const first = await h.call("get_links", { post: "AAAAAAAAAAAAAAAAA" });
    expect(first.text).toMatch(/^Error \(not_found\): /);
    expect(h.forum.requests).toHaveLength(1);
    const second = await h.call("get_links", { post: "AAAAAAAAAAAAAAAAA" });
    expect(second.text).toBe(first.text);
    expect(h.forum.requests).toHaveLength(1);
    // A lapsed memory (5 minutes) is asked again.
    h.clock.advance(5 * 60_000 + 1);
    expect((await h.call("get_links", { post: "AAAAAAAAAAAAAAAAA" })).text).toBe(first.text);
    expect(h.forum.requests).toHaveLength(2);
  });

  it("¶3.6 the same arguments in reversed key order give the same first page, and their cursors the same second page", async () => {
    const args = { post: HUB, direction: "both", sort: "top", af_only: false, limit: 10, max_tokens: 15000 };
    const pages = async (given: Record<string, unknown>) => {
      const h = createHarness({ families: FAMILIES });
      const first = await h.call("get_links", given);
      const cursor = printedCursor(first.text)!;
      const stored = Object.keys(h.services.cursors.take("get_links", cursor).args);
      const second = await h.call("get_links", { cursor });
      return [first.text, second.text, stored] as const;
    };
    const [first, second, stored] = await pages(args);
    const [reversedFirst, reversedSecond, reversedStored] = await pages(Object.fromEntries(Object.entries(args).reverse()));
    expect(second).toContain("post_id LinkingPost000011");
    expect(reversedFirst).toBe(first);
    expect(reversedSecond).toBe(second);
    // The cursor stores the given arguments in parameter order, whatever order the caller sent them in.
    expect(stored).toEqual(["post", "direction", "sort", "af_only", "limit"]);
    expect(reversedStored).toEqual(stored);
  });

  it("D1 a cursor whose first string now names another wiki page is not_found, and the other page is not read", async () => {
    const h = createHarness({ families: FAMILIES });
    const first = await h.call("get_links", { tag: "interpretability-ml-and-ai", direction: "incoming", limit: 1 });
    h.clock.advance(31 * 60_000);
    const other = { _id: "OtherInterpPage01", name: "Another page", slug: "interpretability-ml-and-ai", core: false, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false, postCount: 1, parentTag: null, description: { plaintextDescription: "x" } };
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("tag_by_slug"), body: JSON.stringify({ data: { a: { results: [other] }, b: { tag: null, lens: null, summaries: [] } } }) });
    const second = await h.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.text).toBe('Error (not_found): No publicly visible wiki page has the id "56yXXrcxRjrQs6z9R".');
    expect(gqlTexts(h.forum).join("\n")).not.toContain("OtherInterpPage01");
  });
});

describe("get_links: forum links", () => {
  it("P1 a comment is placed by its wiki page first; a hidden post or page is unnamed; a deleted placeholder can't be shown", async () => {
    const md = [
      "https://www.lesswrong.com/posts/draftPost00000001/x/comment/onHiddenPostCmnt1",
      "https://www.lesswrong.com/w/ai/discussion?commentId=wikiDiscussCmnt01",
      "https://www.lesswrong.com/w/ai/discussion?commentId=wikiHiddenCmnt001",
      "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/x/comment/DeletedPubComment",
    ].join("\n");
    const h = createHarness({ families: FAMILIES, extra: [postWithText(md)] });
    const out = await h.call("get_links", { post: BIG, direction: "outgoing" });
    expect(out.text).toContain("• comment_id onHiddenPostCmnt1 (LW only) on a post that is not publicly visible");
    expect(out.text).toContain('• comment_id wikiDiscussCmnt01 (LW only) on wiki page "AI" (tag_slug ai)');
    expect(out.text).toContain("• comment_id wikiHiddenCmnt001 (LW only) on a wiki page that is not publicly visible");
    expect(out.text).toContain("• a comment link that can't be shown");
    expect(out.text).not.toMatch(/draftPost00000001|deletedTag0000001|DeletedPubComment/);
  });

  it("¶4.13 post links by slug are asked for ten at most; the rest are forum links that are not resolved", async () => {
    const md = Array.from({ length: 12 }, (_, i) => `https://www.lesswrong.com/posts/slug/no-such-post-${i + 1}`).join("\n");
    const h = createHarness({ families: FAMILIES, extra: [postWithText(md)] });
    const out = await h.call("get_links", { post: BIG, direction: "outgoing" });
    const request = gqlTexts(h.forum).at(-1)!;
    expect(request).toContain("ps10: posts(selector: {slugPost: {slug: \"no-such-post-10\"}}, limit: 2)");
    expect(request).not.toContain("ps11:");
    expect(out.text.match(/• a post link that can't be shown \(missing or not publicly visible\)/g)).toHaveLength(10);
    expect(out.text).toContain("• forum link (not resolved): https://www.lesswrong.com/posts/slug/no-such-post-11");
    expect(out.text).toContain("• forum link (not resolved): https://www.lesswrong.com/posts/slug/no-such-post-12");
    expect(out.text).toContain("Outgoing: 12 forum links, 0 external links (0 sites)");
  });

  it("¶4.13 comments, people and sequences are asked for twenty each; tags by current slug all, by older slug and as lenses twenty", async () => {
    const pad = (i: number, stem: string, length = 17) => stem + String(i).padStart(length - stem.length, "0");
    const md = Array.from({ length: 22 }, (_, i) => [
      `https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/x/comment/${pad(i, "Cmnt")}`, `https://www.lesswrong.com/w/tag-${i}`,
      `https://www.lesswrong.com/users/user-${i}`, `https://www.lesswrong.com/s/${pad(i, "Seq")}`,
    ].join("\n")).join("\n");
    const h = createHarness({ families: FAMILIES, extra: [postWithText(md)] });
    await h.call("get_links", { post: BIG, direction: "outgoing" });
    const request = gqlTexts(h.forum).at(-1)!;
    for (const alias of ["c20: ", "tb20: ", "tp20: ", "u20: ", "s20: "]) expect(request, alias).toContain(alias);
    for (const alias of ["c21: ", "tb21: ", "tp21: ", "u21: ", "s21: "]) expect(request, alias).not.toContain(alias);
    expect(request).toContain('slugs: ["tag-0", "tag-1"');
    expect(request).toContain('"tag-21"]}}, limit: 22)');
  });
});

describe("get_links: wiki pages and lenses", () => {
  const ADDITIONAL = FAMILIES;

  it("a lens opens its own text for the outgoing links and its page for the incoming ones (P12)", async () => {
    const none = [
      gqlEntry({ root: "tags", view: "pingbackWikiPages", terms: { tagId: "RkznxXmmh9b5ovdSq" } }, { results: [] }, "§10.2"),
      gqlEntry({ root: "multiDocuments", view: "pingbackLensPages", terms: { documentId: "RkznxXmmh9b5ovdSq" } }, { results: [] }, "§10.2"),
    ];
    const h = createHarness({ families: ADDITIONAL, extra: none });
    const out = await h.call("get_links", { tag: "bayes-rule-guide", direction: "incoming" });
    expect(out.text.split("\n")[0]).toBe(`get_links — lens "Guide" of "Bayes' rule"`);
    // ¶3.1.2: the echo says the lens itself was opened; the incoming side is still the page's, and says so
    expect(out.text).not.toContain("→ page");
    expect(out.text.split("\n")[1]).toBe(`Request: tag → "Bayes' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq) · lens_slug bayes-rule-guide of page "Bayes' rule" (incoming links are the page's) · direction incoming · limit 10 (default)`);
    expect(out.text).toContain(`No wiki pages match: linking to "Bayes' rule" (tag_slug bayes-rule).`);
    expect(gqlTexts(h.forum).at(-1)).toContain('pingbackWikiPages: {tagId: "RkznxXmmh9b5ovdSq"}');

    const text = createHarness({ families: ADDITIONAL });
    const outgoing = await text.call("get_links", { tag: "bayes-rule-guide", direction: "outgoing" });
    expect(gqlTexts(text.forum).at(-1)).toContain('lb: multiDocument(selector: {_id: "BayesGuideLens001"})');
    expect(outgoing.text.split("\n")[1]).toBe(`Request: tag → "Bayes' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq) · lens_slug bayes-rule-guide of page "Bayes' rule" · direction outgoing · limit 10 (default)`);
  });

  it("a summary_id stands for its page, or for the lens it summarizes, and the echo says which", async () => {
    const page = createHarness({ families: ADDITIONAL });
    const out = await page.call("get_links", { tag: "InterpSummary0001", direction: "outgoing" });
    expect(out.text.split("\n")[0]).toBe('get_links — "Interpretability (ML & AI)"');
    expect(out.text).toContain('summary_id InterpSummary0001 → page "Interpretability (ML & AI)"');
    expect(gqlTexts(page.forum).at(-1)).toContain('tb: tag(selector: {_id: "56yXXrcxRjrQs6z9R"})');

    const lens = createHarness({ families: ADDITIONAL });
    const viaLens = await lens.call("get_links", { tag: "LensSummary000001", direction: "outgoing" });
    expect(viaLens.text.split("\n")[0]).toBe(`get_links — lens "Guide" of "Bayes' rule"`);
    expect(viaLens.text).toContain(`summary_id LensSummary000001 → lens "Guide" (lens_slug bayes-rule-guide) of page "Bayes' rule"`);
    expect(viaLens.text).not.toContain("→ page");
    expect(gqlTexts(lens.forum).at(-1)).toContain('lb: multiDocument(selector: {_id: "BayesGuideLens001"})');
  });

  it("a page's description is the text of its outgoing links, and its backlinks continue as a list", async () => {
    const page = gqlEntry({ root: "tag", id: "56yXXrcxRjrQs6z9R" }, { result: { _id: "56yXXrcxRjrQs6z9R", description: { version: "3.1.0", markdown: "See [AI](/w/ai) and https://example.org/x." } } }, "§10.2");
    const ai = gqlEntry({ root: "tags", view: "tagsBySlugs", terms: { slugs: ["ai"] } }, { results: [rawTagRef({ _id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", core: true })] }, "§10.2");
    const h = createHarness({ families: ADDITIONAL, extra: [page, ai] });
    const out = await h.call("get_links", { tag: "interpretability-ml-and-ai", direction: "outgoing" });
    expect(out.text).toContain("Outgoing: 1 forum link, 1 external link (1 site)");
    expect(out.text).toContain('• "AI" (tag_slug ai)');
    expect(out.text).toContain("• example.org (1): https://example.org/x");

    const both = createHarness({ families: ADDITIONAL });
    const first = await both.call("get_links", { tag: "interpretability-ml-and-ai", direction: "incoming", limit: 1 });
    expect(first.text).toContain("Incoming (1 shown; wiki pages whose text links to this page, newest page first)");
    expect(first.text).toContain('"Mechanistic interpretability"');
    expect(first.text).toMatch(/\(next: incoming 2–2\)\.$/);
    expect(first.text).not.toContain("Rankings can shift");
    const second = await both.call("get_links", { cursor: printedCursor(first.text) });
    expect(second.text).toContain('lens "Guide" (lens_slug bayes-rule-guide)');
    expect(second.text).not.toContain('"Mechanistic interpretability"');
    expect(second.text).toMatch(/End of results\.$/);
  });
});
