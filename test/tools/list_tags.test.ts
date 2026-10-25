import { describe, expect, it } from "vitest";
import { allTagsOp } from "../../src/forum/templates/list_tags";
import { listTagsEffective, tool, type ListTagsParams } from "../../src/tools/list_tags";
import { mint } from "../../src/tools/common";
import { loadCoreGrouping } from "../../src/tools/loaders";
import { createCallContext } from "../../src/call/context";
import { fingerprint } from "../../src/paging/pager";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { aiGrouping, aiGroupingRows, gqlEntry, rawMdocRef, rawTagFull, rawTagRef, tagCatalogue, tagRow, tagRows } from "../support/builders";
import { rememberResolution, resolvedFrom } from "../../src/ids/resolve";

const AI = "sYm3HiWcfZvrGu3ui";
const COUNTER = "Numbers marked ~ are the site's own counters and can differ from what is listed.";
const CORE_TAGS = "rationality, ai, world-modeling, world-optimization, practical, community, site-meta";
const TAG_IDS = /tag_id (TagRow\d{11})/g;

async function pageThrough(h: ReturnType<typeof createHarness>, first: Record<string, unknown>) {
  const pages = [await h.call("list_tags", first)];
  for (let c = printedCursor(pages[0].text); c; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("list_tags", { cursor: c }));
  return pages;
}

const idsOf = (pages: readonly { text: string }[]): string[] => pages.flatMap((p) => [...p.text.matchAll(TAG_IDS)].map((m) => m[1]!));
/** A page's text without the cursor tokens it prints (they differ on every issue). */
const withoutCursors = (text: string): string => text.replace(/c_[A-Za-z0-9_-]{22}/g, "c_…");

describe("list_tags", () => {
  it("template: the whole catalogue in one alias, limit 2000, no enableTotal", () => {
    const o = allTagsOp();
    expect(o.text).toBe("t: tags(selector: {allTagsAlphabetical: {}}, limit: 2000) { results { ...TAG_LIST } }");
    expect(o.template).toBe("list_tags_all");
  });

  it("definition: ¶4.16 effective values", () => {
    expect(listTagsEffective({ tag: "ai", limit: 10, max_tokens: 15000 }, { tagId: AI })).toEqual({ tag: AI, limit: 10 });
    // A key for every parameter but cursor and max_tokens, absent values included.
    expect(Object.hasOwn(listTagsEffective({ limit: 10, max_tokens: 15000 }, {}), "tag")).toBe(true);
  });

  it("Q130 the catalogue is fetched once and paged locally: 1,010 tags in 21 pages of 50, each once", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(1010)] });
    const pages = await pageThrough(h, { limit: 50 });
    expect(pages).toHaveLength(21);
    expect(h.forum.requests).toHaveLength(1);
    const ids = idsOf(pages);
    expect(ids).toHaveLength(1010);
    expect(new Set(ids).size).toBe(1010);
    expect(pages[0].text.split("\n")[0]).toBe("list_tags — all taggable tags");
    expect(pages[0].text).toContain("Position: items 1–50");
    expect(pages[0].text).toContain(COUNTER);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("Q68 2,000 rows back means more may exist; said on the last page only", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(2000)] });
    const pages = await pageThrough(h, { limit: 50 });
    expect(pages).toHaveLength(40);
    expect(pages[0].text).toContain("More available: call list_tags with cursor");
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of reachable results: the forum returned the most this server requests (2,000); more may exist.")).toBe(true);
    expect(pages.slice(0, -1).some((p) => p.text.includes("more may exist"))).toBe(false);
  });

  it("Q68 P10 P12 a core grouping: one isolated TagsByCoreTagId of 500, wiki-only labelled", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(aiGroupingRows(), 4321)] });
    const out = await h.call("list_tags", { tag: "ai" });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(Array.isArray(JSON.parse(h.forum.requests[1].body))).toBe(true);
    expect(gqlTexts(h.forum)[1]).toContain('g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui", limit: 500) { tags { ...TAG_LIST } totalCount }');
    expect(out.text.split("\n")[0]).toBe('list_tags — tags grouped under "AI"');
    expect(out.text).toContain('tag → "AI" (tag_slug ai, tag_id sYm3HiWcfZvrGu3ui');
    expect(out.text).toContain("tag_slug interpretability-ml-and-ai");
    expect(out.text).toContain("~1,608 tagged posts (site counter)");
    expect(out.text).toContain("page type: wiki-only page");
    expect(out.text).not.toContain("PLANTED");
    expect(out.text).not.toMatch(/4,?321/);
    expect(out.text).toContain("limit 10 (default)");
    expect(out.text).not.toContain("  > "); // tag cards without excerpts
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("Q68 a grouping of exactly 500 rows ends with more may exist", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(tagRows(500, { coreTagId: AI }), 500)] });
    const pages = await pageThrough(h, { tag: "ai", limit: 50 });
    expect(pages).toHaveLength(10);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of reachable results: the forum returned the most this server requests (500); more may exist.")).toBe(true);
  });

  it("a non-core tag is bad_input naming the core tag it is grouped under (one tag(_id) lookup)", async () => {
    const h = createHarness({ families: ["tags"] });
    const out = await h.call("list_tags", { tag: "interpretability-ml-and-ai" });
    expect(out.text).toBe(`Error (bad_input): tag: list_tags takes one of the 7 core tags: ${CORE_TAGS}; "Interpretability (ML & AI)" is grouped under "AI".`);
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain('tag(selector: {_id: "sYm3HiWcfZvrGu3ui"}) { result { ...TAG_REF } }');
  });

  it("a cached resolution guarantees only TAG_REF fields: a non-core tag cached without coreTagId has it fetched before its core tag is named", async () => {
    const h = createHarness({ families: ["tags"] });
    rememberResolution("tag", "interpretability-ml-and-ai", resolvedFrom("tag", rawTagRef()), h.services);
    const out = await h.call("list_tags", { tag: "interpretability-ml-and-ai" });
    expect(out.text).toBe(`Error (bad_input): tag: list_tags takes one of the 7 core tags: ${CORE_TAGS}; "Interpretability (ML & AI)" is grouped under "AI".`);
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[0]).toContain('tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_LIST } }');
  });

  it("¶2.2 step 5 a slow resolution leaves no time for the grouping: the timeout error, and no second request", async () => {
    const h = createHarness({ families: ["tags"] });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    expect((await h.call("list_tags", { tag: "ai" })).text).toBe(
      "Error (timeout): The forum did not answer in time while running list_tags (about 50 s per call). Large discussions can be slow; try again, or narrow the request.",
    );
    expect(h.forum.requests).toHaveLength(1);
  });

  it("a tag under no core tag: bad_input without a lookup", async () => {
    const h = createHarness({ families: ["tags"] });
    const out = await h.call("list_tags", { tag: "bayes-rule" });
    expect(out.text).toBe(`Error (bad_input): tag: list_tags takes one of the 7 core tags: ${CORE_TAGS}; "Bayes' rule" is not grouped under a core tag.`);
    expect(h.forum.requests).toHaveLength(1);
  });

  it("the grouping is cached for 60 minutes and shared through loadCoreGrouping", async () => {
    const rows = [tagRow(1, { coreTagId: AI })];
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(rows, 1)] });
    await h.call("list_tags", { tag: "ai" });
    await h.call("list_tags", { tag: "ai" });
    expect(h.forum.requests).toHaveLength(2);
    const ctx = createCallContext("get_tag", { now: h.clock.now });
    expect(await loadCoreGrouping(AI, ctx, h.services)).toEqual({ rows: [rows[0]], full: false });
    expect(h.forum.requests).toHaveLength(2);
  });
});

describe("list_tags: the catalogue and the grouping loaders", () => {
  it("Q130 the catalogue is cached for 60 minutes: alive at 59:59.999, fetched again at 60:00", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(3)] });
    await h.call("list_tags", {});
    h.clock.advance(3_599_999);
    await h.call("list_tags", {});
    expect(h.forum.requests).toHaveLength(1);
    h.clock.advance(1);
    await h.call("list_tags", {});
    expect(h.forum.requests).toHaveLength(2);
  });

  it("Q130 a core grouping is cached for 60 minutes too: alive at 59:59.999, fetched again at 60:00", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping([tagRow(1, { coreTagId: AI })], 1)] });
    const groupings = () => h.forum.requests.filter((r) => r.body.includes("TagsByCoreTagId")).length;
    await h.call("list_tags", { tag: "ai" });
    expect(groupings()).toBe(1);
    h.clock.advance(3_599_999);
    await h.call("list_tags", { tag: "ai" });
    expect(groupings()).toBe(1);
    h.clock.advance(1);
    await h.call("list_tags", { tag: "ai" });
    expect(groupings()).toBe(2);
  });

  it("¶2.3 a continuation after the catalogue's cache lapsed, within the cursor's hour, reads it again and resumes after the last tag shown", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(30)] });
    const first = await h.call("list_tags", {});
    h.clock.advance(40 * 60_000);
    const second = await h.call("list_tags", { cursor: printedCursor(first.text)! });
    expect(h.forum.requests).toHaveLength(1);
    h.clock.advance(25 * 60_000); // 65 minutes after the fetch, 25 after the cursor was issued
    const third = await h.call("list_tags", { cursor: printedCursor(second.text)! });
    expect(h.forum.requests).toHaveLength(2);
    expect(third.text).toContain("Position: items 21–30");
    expect(third.text).toContain("tag_id TagRow00000000020");
    expect(third.text).not.toContain("The list changed");
  });

  it("P12 the catalogue and the grouping list only listable pages and label a wiki-only one", async () => {
    const rows = [tagRow(1), tagRow(2, { adminOnly: true, name: "PLANTED-P12-admin" }), tagRow(3, { deleted: true, name: "PLANTED-P12-deleted" }),
      tagRow(4, { isPlaceholderPage: true, wikiOnly: true, name: "PLANTED-P12-stub" }), tagRow(5, { wikiOnly: true })];
    const h = createHarness({
      families: ["tags"],
      extra: [gqlEntry({ root: "tags", view: "allTagsAlphabetical", limit: 2000 }, { results: rows }, "§10.2"), aiGrouping(rows, 5)],
    });
    const out = await h.call("list_tags", {});
    expect(out.text).not.toContain("PLANTED");
    expect(out.text.match(TAG_IDS)).toHaveLength(2);
    expect(out.text).toContain("page type: wiki-only page");
    const ctx = createCallContext("get_tag", { now: h.clock.now });
    const grouping = await loadCoreGrouping(AI, ctx, h.services);
    expect(grouping.rows.map((r) => r._id)).toEqual([rows[0]!._id, rows[4]!._id]);
    expect(grouping.full).toBe(false);
    // P14: only the number dropped is logged, never a name or an id.
    const dropped = h.logLines.filter((l) => l.includes("not listable"));
    expect(dropped).toHaveLength(2);
    expect(dropped.every((l) => l.includes("dropped") && /\b3\b/.test(l))).toBe(true);
    expect(h.logLines.join("\n")).not.toContain("PLANTED");
    expect(h.logLines.join("\n")).not.toContain(rows[1]!._id);
  });

  it("Q68 `full` counts the rows the forum returned, not those left after the visibility rules: 500 hidden rows are no rows and full", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(tagRows(500, { adminOnly: true, coreTagId: AI }), 500)] });
    const ctx = createCallContext("get_tag", { now: h.clock.now });
    expect(await loadCoreGrouping(AI, ctx, h.services)).toEqual({ rows: [], full: true });
  });

  it("a combined request's alias g is read without a request of its own; its error is thrown as the category and message it carries (get_tag's Partial line)", async () => {
    const h = createHarness({ families: ["tags"] });
    const ctx = createCallContext("get_tag", { now: h.clock.now });
    const rows = [tagRow(1, { coreTagId: AI }), tagRow(2, { coreTagId: AI, adminOnly: true })];
    const ok = new Map([["g", { data: { tags: rows, totalCount: 99 } }]]);
    expect(await loadCoreGrouping(AI, ctx, h.services, ok)).toEqual({ rows: [rows[0]], full: false });
    expect(h.forum.requests).toHaveLength(0);
    const failed = new Map([["g", { error: "forum_error" as const, message: "Something went wrong" }]]);
    await expect(loadCoreGrouping("sYm3HiWcfZvrGu3uj", ctx, h.services, failed)).rejects.toMatchObject({ category: "forum_error", message: "Something went wrong" });
    // Nothing is cached from a failure.
    expect(h.services.caches.get("coregroup", "sYm3HiWcfZvrGu3uj")).toBeUndefined();
  });
});

describe("list_tags: pages, cursors and hand-offs", () => {
  const sevenVisible = (): ReturnType<typeof tagRows> => [
    ...tagRows(7, { coreTagId: AI }).slice(0, 3), tagRow(100, { adminOnly: true, coreTagId: AI, name: "PLANTED-P12-hidden" }),
    ...tagRows(7, { coreTagId: AI }).slice(3),
  ];

  it("Q130 a page cut by max_tokens continues after the last card shown: every tag once", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(300)] });
    const pages = await pageThrough(h, { limit: 50, max_tokens: 2000 });
    expect(pages.length).toBeGreaterThan(6);
    const ids = idsOf(pages);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
    expect(h.forum.requests).toHaveLength(1);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("¶3.6 a printed call pasted back whole continues like the cursor alone; another tag or limit is bad_input", async () => {
    const rationality = rawTagFull({ _id: "RationalityTag001", name: "Rationality", slug: "rationality", core: true, coreTagId: null, parentTag: null });
    const h = createHarness({
      families: ["tags"],
      extra: [
        aiGrouping(sevenVisible(), 8),
        gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "rationality" }, limit: 1 }, { results: [rationality] }, "§10.2"),
        gqlEntry({ root: "TagPreview", args: { slug: "rationality" } }, { tag: rationality, lens: null, summaries: [] }, "§10.2"),
      ],
    });
    const first = await h.call("list_tags", { tag: "ai", limit: 3 });
    const cursor = printedCursor(first.text)!;
    expect(first.text).toContain("Position: items 1–3");
    const alone = await h.call("list_tags", { cursor });
    const whole = await h.call("list_tags", { tag: "ai", limit: 3, cursor });
    expect(alone.text).toContain("Position: items 4–6");
    expect(alone.text).not.toContain("PLANTED");
    expect(alone.text).not.toContain("The list changed");
    expect(withoutCursors(whole.text)).toBe(withoutCursors(alone.text));
    expect(h.forum.requests).toHaveLength(2); // the continuations re-check the core tag from the resolution cache
    // The echo marks `(default)` only what neither call gave.
    expect(alone.text).toContain("limit 3");
    expect(alone.text).not.toContain("limit 3 (default)");
    const otherTag = await h.call("list_tags", { tag: "rationality", cursor });
    expect(otherTag.isError).toBe(true);
    expect(otherTag.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(tag: /);
    const otherLimit = await h.call("list_tags", { limit: 5, cursor });
    expect(otherLimit.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(limit: cursor has 3, call has 5\)/);
  });

  it("¶3.6 a catalogue cursor repeated with the default limit continues; with a core tag it is bad_input", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(30)] });
    const first = await h.call("list_tags", {});
    const cursor = printedCursor(first.text)!;
    expect(first.text).toContain("limit 10 (default)");
    const repeated = await h.call("list_tags", { limit: 10, cursor });
    expect(repeated.text).toContain("Position: items 11–20");
    expect(repeated.text).toContain("· limit 10\n"); // the repeat gave it, so it is no longer marked (default)
    const alone = await h.call("list_tags", { cursor });
    expect(alone.text).toContain("limit 10 (default)");
    const withTag = await h.call("list_tags", { tag: "ai", cursor });
    expect(withTag.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(tag: cursor has none, call has "sYm3HiWcfZvrGu3ui"\)/);
  });

  it("P10 hidden rows are not in the fingerprint: a walk over a grouping with a hidden row shows no drift note and every visible tag once", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(sevenVisible(), 8)] });
    const pages = await pageThrough(h, { tag: "ai", limit: 3 });
    expect(pages).toHaveLength(3);
    expect(idsOf(pages)).toEqual(tagRows(7).map((r) => r._id));
    expect(pages.some((p) => p.text.includes("The list changed"))).toBe(false);
    expect(pages.some((p) => p.text.includes("PLANTED"))).toBe(false);
    // The 7 visible rows of a 500-row request are not "the most requested": no more-may-exist line.
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("¶3.6 Q68 get_tag's hand-off: a list state at index 10 minted with listTagsEffective continues at the 11th tag; a changed fingerprint adds the drift note", async () => {
    const rows = tagRows(25, { coreTagId: AI });
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(rows, 25)] });
    await h.call("list_tags", { tag: "ai" }); // the resolution and the grouping are cached, as after get_tag
    const effective = listTagsEffective(tool.schema.parse({ tag: "ai" }) as ListTagsParams, { tagId: AI });
    const state = (count: number) => ({
      streams: [{ kind: "list" as const, shown: 10, index: 10, lastId: rows[9]!._id, fingerprint: { count, newestMs: fingerprint(rows, () => 0).newestMs } }],
      current: 0,
    });
    const same = await h.call("list_tags", { cursor: mint(h.services, "list_tags", { tag: "ai" }, effective, state(25)) });
    expect(same.text).toContain("tag_id TagRow00000000010");
    expect(same.text).not.toContain("tag_id TagRow00000000009");
    expect(same.text).toContain("Position: items 11–20");
    expect(same.text).not.toContain("The list changed");
    const grown = await h.call("list_tags", { cursor: mint(h.services, "list_tags", { tag: "ai" }, effective, state(23)) });
    expect(grown.text).toContain("The list changed since the previous page (2 new items); positions may have shifted.");
    expect(h.forum.requests).toHaveLength(2);
  });

  it("¶3.9 an empty catalogue is the filtered-list template naming the whole catalogue, as the echo does", async () => {
    const h = createHarness({ families: ["tags"], extra: [tagCatalogue(0)] });
    const out = await h.call("list_tags", {});
    expect(out.isError).toBe(false);
    expect(out.text).toContain("\nNo tags match: all taggable tags.\n");
    expect(out.text).not.toContain("no filters");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
  });
  it("¶3.9 an empty grouping is the filtered-list template, with no cursor", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping([tagRow(1, { adminOnly: true, coreTagId: AI })], 1)] });
    const out = await h.call("list_tags", { tag: "ai" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('No tags match: grouped under "AI".');
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expect(out.text).not.toContain("Position:");
  });

  /** The lens "interpretability-guide" of the non-core page Interpretability (ML & AI); its page join carries TAG_REF only. */
  const guideOfNonCorePage = () => {
    const lens = rawMdocRef({
      _id: "InterpGuideLens01", slug: "interpretability-guide", title: "Guide", tabTitle: "Guide", parentTag: rawTagRef(),
    });
    return [
      gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "interpretability-guide" }, limit: 1 }, { results: [] }, "§10.2"),
      gqlEntry({ root: "TagPreview", args: { slug: "interpretability-guide" } }, { tag: rawTagFull(), lens, summaries: [] }, "§10.2"),
    ];
  };
  const NOT_CORE = `Error (bad_input): tag: list_tags takes one of the 7 core tags: ${CORE_TAGS}; "Interpretability (ML & AI)" is not a core tag.`;

  it("a lens or summary stands for its page: a lens of a non-core page is bad_input naming the page, and a third request is never sent", async () => {
    const h = createHarness({ families: ["tags"], extra: guideOfNonCorePage() });
    const out = await h.call("list_tags", { tag: "interpretability-guide" });
    // Request 1 resolves the lens (its page carries TAG_REF only), request 2 reads the page's coreTagId; naming the core tag would be a third.
    expect(out.text).toBe(NOT_CORE);
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain('x: tag(selector: {_id: "56yXXrcxRjrQs6z9R"}) { result { ...TAG_LIST } }');
  });

  it("¶2.2 step 5 a lens of a non-core page whose resolution passes the 40 s mark: the bad_input without the coreTagId lookup (one request)", async () => {
    const h = createHarness({ families: ["tags"], extra: guideOfNonCorePage() });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const out = await h.call("list_tags", { tag: "interpretability-guide" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(NOT_CORE);
    expect(h.forum.requests).toHaveLength(1);
  });

  it("¶2.2 step 5 a non-core tag whose resolution passes the 40 s mark: the bad_input without the core tag's name (one request)", async () => {
    const h = createHarness({ families: ["tags"] });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const out = await h.call("list_tags", { tag: "interpretability-ml-and-ai" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(NOT_CORE);
    expect(h.forum.requests).toHaveLength(1);
  });

  it("¶4.16 a lens of a core page repeated with the cursor after every cache lapsed: the given tag is the re-check, so at most 2 requests", async () => {
    const aiRef = rawTagRef({ _id: AI, name: "AI", slug: "ai", core: true });
    const aiFull = rawTagFull({ _id: AI, name: "AI", slug: "ai", core: true, coreTagId: null, parentTag: null });
    const lens = rawMdocRef({ _id: "AiGuideLens000001", slug: "ai-guide", parentTag: aiRef });
    const h = createHarness({
      families: ["tags"],
      extra: [
        aiGrouping(tagRows(25, { coreTagId: AI }), 25),
        gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "ai-guide" }, limit: 1 }, { results: [] }, "§10.2"),
        gqlEntry({ root: "TagPreview", args: { slug: "ai-guide" } }, { tag: aiFull, lens, summaries: [] }, "§10.2"),
      ],
    });
    // The resolution of a lens warms the keys of the lens, never `tag:<page id>`, so the cursor's stored id is not in the cache.
    const first = await h.call("list_tags", { tag: "ai-guide", limit: 3 });
    expect(first.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    h.clock.advance(10 * 60_000);
    const second = await h.call("list_tags", { tag: "ai-guide", cursor: printedCursor(first.text)! });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("Position: items 4–6");
    h.clock.advance(51 * 60_000); // 61 minutes after the first call: the resolutions and the grouping have all lapsed
    const sent = h.forum.requests.length;
    const third = await h.call("list_tags", { tag: "ai-guide", cursor: printedCursor(second.text)! });
    expect(third.isError).toBe(false);
    expect(third.text).toContain("Position: items 7–9");
    expect(third.text).not.toContain("The list changed");
    expect(h.forum.requests.length - sent).toBeLessThanOrEqual(2);
    // Resolving the given tag is the D1 re-check, and the echo notes of the first page return with it.
    expect(third.text).toContain('lens ai-guide → page "AI"');
  });

  it("D1 a continuation checks the core tag again: after the resolution lapses (30 min) one request resolves it, and the grouping still comes from its own cache (60 min)", async () => {
    const h = createHarness({ families: ["tags"], extra: [aiGrouping(tagRows(25, { coreTagId: AI }), 25)] });
    const first = await h.call("list_tags", { tag: "ai", limit: 10 });
    expect(h.forum.requests).toHaveLength(2);
    const cursor = printedCursor(first.text)!;
    h.clock.advance(31 * 60_000);
    const next = await h.call("list_tags", { cursor });
    expect(next.isError).toBe(false);
    expect(next.text).toContain("Position: items 11–20");
    expect(next.text).toContain('tag → "AI" (tag_slug ai, tag_id sYm3HiWcfZvrGu3ui');
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).not.toContain("TagsByCoreTagId");
    expectClean(h);
  });
});
