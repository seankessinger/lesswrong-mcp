import { describe, expect, it } from "vitest";
import { historyDocOps } from "../../src/forum/templates/get_history";
import { loadTexts } from "../../src/tools/get_history";
import { createCallContext } from "../../src/call/context";
import type { ParsedRef } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { gqlEntry, rawPostRef, rawRevRow, revisionHistory as history } from "../support/builders";
import { loadFamilies } from "../support/fixtures";

const LEAN = "zHhGa3iQBQcdSifFL";
const FAMILIES = ["posts", "comments", "tags", "revisions", "users"] as const;
const CHANGE = "Change counts are the forum's own.";
const r = (kind: ParsedRef["kind"], form: ParsedRef["form"], value: string): ParsedRef => ({ kind, form, value, given: "id", notes: [] });

describe("get_history templates and definition", () => {
  it("request 1 per document kind, with exactly the fields each check needs", () => {
    expect(historyDocOps(r("post", "id", LEAN), "post").map((o) => o.text)).toEqual([
      'p: post(selector: {_id: "zHhGa3iQBQcdSifFL"}, allowNull: true) { result { ...POST_REF postedAt hideAuthor collabEditorDialogue debate contents { version editedAt } } }',
    ]);
    expect(historyDocOps(r("post", "slug", "some-slug"), "post")[0].text)
      .toBe('s: posts(selector: {slugPost: {slug: "some-slug"}}, limit: 2) { results { ...POST_REF postedAt hideAuthor collabEditorDialogue debate contents { version editedAt } } }');
    expect(historyDocOps(r("post", "idOrSlug", LEAN), "post").map((o) => o.alias)).toEqual(["p", "s"]);
    expect(historyDocOps(r("tag", "id", "RkznxXmmh9b5ovdSq"), "tag").map((o) => o.text)).toEqual([
      't: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...TAG_REF description { version editedAt } } }',
      'm: multiDocument(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...MDOC_REF contents { version editedAt } } }',
    ]);
    expect(historyDocOps(r("tag", "slug", "bayes-rule-guide"), "tag")[0].text)
      .toBe('b: TagPreview(slug: "bayes-rule-guide") { tag { ...TAG_REF description { version editedAt } } lens { ...MDOC_REF contents { version editedAt } } }');
    expect(historyDocOps(r("tag", "idOrSlug", "RkznxXmmh9b5ovdSq"), "tag").map((o) => o.alias)).toEqual(["t", "m", "b"]);
    expect(historyDocOps(r("post", "id", LEAN), "post")[0].template).toBe("get_history_req1");
  });

  it("parameter rules are bad_input before any request", async () => {
    const h = createHarness({ families: FAMILIES });
    expect((await h.call("get_history", { post: LEAN, tag: "bayes-rule" })).text).toMatch(/^Error \(bad_input\): give exactly one of post, tag/);
    expect((await h.call("get_history", { post: LEAN, compare_to: "current" })).text)
      .toBe('Error (bad_input): compare_to: needs revision. Give revision too, e.g. revision: "original", compare_to: "current".');
    expect((await h.call("get_history", { post: LEAN, revision: "original", compare_to: "current", match: "kernel" })).text)
      .toBe("Error (bad_input): match: can't be combined with compare_to. Use match with revision alone.");
    expect((await h.call("get_history", { post: LEAN, match: "kernel" })).text)
      .toBe("Error (bad_input): match: needs revision. Give revision to search one version's text.");
    expect(h.forum.requests).toHaveLength(0);
  });
});

describe("get_history: the version list", () => {
  it("Q97 two requests; header, the original (not 1.0.0), labels, CDN copies folded, all public versions listed", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain('revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL", fieldName: "contents"}}, limit: 1000, offset: 0, enableTotal: true');
    expect(out.text.split("\n")[0]).toBe('get_history — post "A critical look at Lean4"');
    expect(out.text).toContain('History of post "A critical look at Lean4" (post_id zHhGa3iQBQcdSifFL, LW only) · published 2024-11-02T15:00:00.000Z · current v1.12.0 (2025-01-10T00:00:00.000Z)');
    expect(out.text).toContain("Original (as published): revision_id LeanRev0000000002 · v1.1.0 · 2024-11-02T15:00:00.400Z");
    expect(out.text).toContain("6 public versions (1 automatic image copy folded in) · all public versions listed · newest first");
    expect(out.text).toContain('edit by "Lean Author" (user_slug lean-author) · forum change count +412/−37 chars · 4,410 words');
    expect(out.text).toContain("forum change count +0/−0 chars (the text may still have changed)");
    expect(out.text).toContain("+ automatic image copy");
    expect(out.text).toContain("before publication");
    expect(out.text.match(/version number repeats/g)).toHaveLength(2);
    expect(out.text).not.toContain("revision_id LeanRev0000000006");
    expect(out.text).toContain(CHANGE);
    expect(out.text.indexOf("LeanRev0000000007")).toBeLessThan(out.text.indexOf("LeanRev0000000001"));
    expectClean(h);
  });

  it("sort old lists oldest first", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, sort: "old" });
    expect(out.text.indexOf("revision_id LeanRev0000000001")).toBeLessThan(out.text.indexOf("revision_id LeanRev0000000007"));
    expect(out.text).toContain("oldest first");
  });

  it("P7 Q116 no editor is named on any row of an anonymous post", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: "AnonPostHistory01" });
    expect(out.text).toContain("revision_id ");
    expect(out.text).not.toMatch(/PLANTED|anon-author|anonAuthorUser001/);
  });

  it("wiki pages and lenses: their own field, header and original", async () => {
    const h = createHarness({ families: FAMILIES });
    const page = await h.call("get_history", { tag: "RkznxXmmh9b5ovdSq" });
    expect(gqlTexts(h.forum).at(-1)).toContain('revisionsOnDocument: {documentId: "RkznxXmmh9b5ovdSq", fieldName: "description"}');
    expect(page.text).toContain(`History of wiki page "Bayes' rule" (tag_slug bayes-rule)`);
    expect(page.text).toContain("Original (oldest public version): revision_id BayesRev000000001");
    const lens = await h.call("get_history", { tag: "bayes-rule-guide" });
    expect(gqlTexts(h.forum).at(-1)).toContain('revisionsOnDocument: {documentId: "BayesGuideLens001", fieldName: "contents"}');
    expect(lens.text).toContain(`History of lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
    // ¶3.1.2: the echo says the lens's own history was opened, never that the lens stands for its page
    expect(lens.text.split("\n")[1]).toBe(`Request: tag → lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule) · sort new (default) · limit 10 (default)`);
    expect(lens.text).not.toContain("→ page");
  });

  it("#135 an admin-only page's history opens, flagged, by its slug (TagPreview) as on the site (TagHistoryPage, useTagBySlug)", async () => {
    const row = (n: number) => rawRevRow({ _id: `AdminRev00000000${n}`, documentId: "AdminOnlyPage0001", collectionName: "Tags",
      version: `1.${n - 1}.0`, editedAt: `2025-01-0${n}T00:00:00.000Z`, updateType: "minor", commitMessage: "", changeMetrics: { added: 10, removed: 0 }, wordCount: 3 });
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: "AdminOnlyPage0001", fieldName: "description" }, offset: 0 }, { results: [row(1)], totalCount: 1 }, "test"),
    ] });
    const out = await h.call("get_history", { tag: "admin-only-page" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('History of wiki page "Admin Page" (tag_slug admin-only-page, admin-only (left off posts and out of search))');
    expect(out.text).toContain("revision_id AdminRev000000001");
  });

  it("#257 a wiki page's or lens's current version is its own, even when no public version row has reached it yet", async () => {
    // The page's description (a lens's contents) is already read with request 1; its newest public row can be older.
    const copy = (match: (m: Record<string, unknown>) => boolean, edit: (r: Record<string, unknown>) => void) => {
      const e = JSON.parse(JSON.stringify(loadFamilies(...FAMILIES).find((x) => match(x.match as unknown as Record<string, unknown>))!));
      edit(e.result);
      return e;
    };
    const page = copy((m) => m.root === "tag" && m.id === "RkznxXmmh9b5ovdSq", (r) => {
      (r.result as { description: unknown }).description = { version: "1.4.0", editedAt: "2025-03-03T00:00:00.000Z" };
    });
    const lens = copy((m) => m.root === "TagPreview" && (m.args as { slug?: string } | undefined)?.slug === "bayes-rule-guide", (r) => {
      (r.lens as { contents: unknown }).contents = { markdown: "The guide explains Bayes' rule with examples.", version: "1.3.0", editedAt: "2025-04-04T00:00:00.000Z" };
    });
    const h = createHarness({ families: FAMILIES, extra: [page, lens] });
    const p = await h.call("get_history", { tag: "RkznxXmmh9b5ovdSq" });
    expect(p.text).toContain(`History of wiki page "Bayes' rule" (tag_slug bayes-rule) · current v1.4.0 (2025-03-03T00:00:00.000Z)\n`);
    const l = await h.call("get_history", { tag: "bayes-rule-guide" });
    expect(l.text).toContain(`History of lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule) · current v1.3.0 (2025-04-04T00:00:00.000Z)\n`);
    expectClean(h);
  });

  it("#257 a page whose newest save is an image copy: by id and by slug the header names the copy's version, the page's own", async () => {
    // convertImagesInObject gives the copy the next patch number and rewrites only its html; the markdown read here is unchanged.
    const copyOf = (match: (m: Record<string, unknown>) => boolean, edit: (r: Record<string, unknown>) => void) => {
      const e = JSON.parse(JSON.stringify(loadFamilies(...FAMILIES).find((x) => match(x.match as unknown as Record<string, unknown>))!));
      edit(e.result);
      return e;
    };
    const current = { version: "1.3.1", editedAt: "2025-03-03T00:00:00.000Z" };
    const byId = copyOf((m) => m.root === "tag" && m.id === "RkznxXmmh9b5ovdSq", (r) => { (r.result as { description: unknown }).description = current; });
    const bySlug = copyOf((m) => m.root === "TagPreview" && (m.args as { slug?: string } | undefined)?.slug === "bayes-rule", (r) => {
      (r.tag as { description: unknown }).description = { ...(r.tag as { description: object }).description, ...current };
    });
    const list = copyOf((m) => m.root === "revisions" && (m.terms as { documentId?: string } | undefined)?.documentId === "RkznxXmmh9b5ovdSq", (r) => {
      const rows = r.results as Record<string, unknown>[];
      rows.unshift({ ...rows[0], _id: "BayesCopy00000001", ...current, updateType: "patch", commitMessage: "Move images to CDN", changeMetrics: { added: 40, removed: 40 } });
    });
    const text = (id: string, version: string) => gqlEntry({ root: "revision", id },
      { result: { _id: id, documentId: "RkznxXmmh9b5ovdSq", fieldName: "description", version, editedAt: "2025-03-03T00:00:00.000Z", wordCount: 3, markdown: "Bayes' rule ![](https://example.com/x.png)" } }, "test");
    const h = createHarness({ families: FAMILIES, extra: [byId, bySlug, list, text("BayesCopy00000001", "1.3.1"), text("BayesRev000000002", "1.3.0")] });
    const header = `History of wiki page "Bayes' rule" (tag_slug bayes-rule) · current v1.3.1 (2025-03-03T00:00:00.000Z)\n`;
    expect((await h.call("get_history", { tag: "RkznxXmmh9b5ovdSq" })).text).toContain(header);
    expect((await h.call("get_history", { tag: "bayes-rule" })).text).toContain(header);
    const now = await h.call("get_history", { tag: "RkznxXmmh9b5ovdSq", revision: "current" });
    expect(now.text).toContain("+ automatic image copy");
    expect(now.text).toContain("Bayes' rule ![](https://example.com/x.png)");
    expectClean(h);
  });

  it("a page summary's summary_id: its own history (field contents) under the page it summarizes", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { tag: "InterpSummary0001" });
    expect(gqlTexts(h.forum).at(-1)).toContain('revisionsOnDocument: {documentId: "InterpSummary0001", fieldName: "contents"}');
    expect(out.text).toContain('History of summary (summary_id InterpSummary0001) of "Interpretability (ML & AI)" (tag_slug interpretability-ml-and-ai)');
    expect(out.text).toContain("Original (oldest public version): revision_id InterpSumRev00001");
  });

  it("Q71 P17 hidden posts show no history", async () => {
    const h = createHarness({ families: FAMILIES });
    // ¶8: a bare 17-character string, tried as id and as slug, reads in the slug form with the find hint
    expect((await h.call("get_history", { post: "HiddenDraftPost01" })).text).toMatch(/^Error \(not_found\): No publicly visible post opens by the id or slug "HiddenDraftPost01"\. Slugs are case-sensitive; to look up a name use find \{items: \[\{kind: "post", query: "HiddenDraftPost01"\}\]\}\. Renamed posts/);
    expect(gqlTexts(h.forum).join("\n")).not.toContain("revisions(");
  });

  it("P10 a full first raw page: not all listed yet, nothing said about how many remain; sort old pages to the end", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const h = createHarness({ families: FAMILIES, extra: history("LongHistoryPost01", [
      { offset: 0, rows: 1000, totalCount: 1200, startMs: start },
      { offset: 1000, rows: 200, totalCount: 200, startMs: start - 1000 * 60_000 },
    ]) });
    const first = await h.call("get_history", { post: "LongHistoryPost01" });
    expect(h.forum.requests).toHaveLength(2);
    expect(first.text).toContain("1,000 public versions fetched so far · newest first");
    expect(first.text).not.toContain("all public versions listed");
    expect(first.text).not.toContain("1,200");
    // ¶4.11 step 5: the list's cursor pages the versions, not the original; revision: "original" reads on until it is found.
    expect(first.text).toContain('Original: not determined yet; get_history {post: "LongHistoryPost01", revision: "original"} reads further');
    expect(first.text).not.toContain("continue with the cursor");
    const old = await h.call("get_history", { post: "LongHistoryPost01", sort: "old" });
    expect(gqlTexts(h.forum).at(-1)).toContain("offset: 1000, enableTotal: true");
    expect(old.text).toContain("1,200 public versions · all public versions listed · oldest first");
  });

  it("¶2.2 step 5 sort old needs the whole list: past 40 s the next raw page is not sent and the page stops early with a cursor", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const h = createHarness({ families: FAMILIES, extra: history("LongHistoryPost01", [
      { offset: 0, rows: 1000, totalCount: 1200, startMs: start },
      { offset: 1000, rows: 200, totalCount: 200, startMs: start - 1000 * 60_000 },
    ]) });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("revisionsOnDocument"), delayMs: 41_000, times: 1 });
    const out = await h.call("get_history", { post: "LongHistoryPost01", sort: "old" });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain("1,000 public versions fetched so far");
    expect(out.text).not.toContain("revision_id RevLong");
    expect(out.text).toMatch(/Stopped early \(time limit\); call get_history with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  it("Q26 beyond offset 2000 the list continues by keyset: before = oldest editedAt + 1 ms", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const p3 = start - 2000 * 60_000;
    const oldest = p3 - 999 * 60_000;
    const h = createHarness({ families: FAMILIES, extra: history("VeryLongHistory01", [
      { before: new Date(oldest + 1).toISOString(), rows: 100, totalCount: 100, startMs: oldest - 60_000 },
      { offset: 0, rows: 1000, totalCount: 3100, startMs: start },
      { offset: 1000, rows: 1000, totalCount: 2100, startMs: start - 1000 * 60_000 },
      { offset: 2000, rows: 1000, totalCount: 1100, startMs: p3 },
    ]) });
    const out = await h.call("get_history", { post: "VeryLongHistory01", sort: "old" });
    expect(h.forum.requests).toHaveLength(5);
    expect(gqlTexts(h.forum)[4]).toContain(`k: revisions(selector: {revisionsOnDocument: {documentId: "VeryLongHistory01", fieldName: "contents", before: "${new Date(oldest + 1).toISOString()}"}}, limit: 1000, enableTotal: true)`);
    expect(out.text).toContain("3,100 public versions · all public versions listed · oldest first");
  });

  it("Q26 a keyset window whose raw pages show no row is paged by offset inside it, and the list ends where the forum's offsets do", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const p3 = start - 2000 * 60_000;
    const before = new Date(p3 - 999 * 60_000 + 1).toISOString();
    const h = createHarness({ families: FAMILIES, extra: history("VeryLongHistory01", [
      { before, offset: 0, rows: 0, totalCount: 1000, startMs: 0 },
      { before, offset: 1000, rows: 0, totalCount: 1000, startMs: 0 },
      { before, offset: 2000, rows: 0, totalCount: 1000, startMs: 0 },
      { offset: 0, rows: 1000, totalCount: 4000, startMs: start },
      { offset: 1000, rows: 1000, totalCount: 3000, startMs: start - 1000 * 60_000 },
      { offset: 2000, rows: 1000, totalCount: 2000, startMs: p3 },
    ]) });
    const out = await h.call("get_history", { post: "VeryLongHistory01", sort: "old" });
    expect(h.forum.requests).toHaveLength(7);
    expect(gqlTexts(h.forum)[5]).toContain(`before: "${before}"}}, limit: 1000, offset: 1000, enableTotal: true)`);
    expect(gqlTexts(h.forum)[6]).toContain(`before: "${before}"}}, limit: 1000, offset: 2000, enableTotal: true)`);
    expect(out.text).toContain("3,000 public versions fetched so far · oldest first");
    expect(out.text).toContain("Original: not determined; older versions are beyond the forum's paging");
    expect(out.text).not.toContain("Stopped early");
    expectClean(h);
  });

  it("a text whose three offset pages show no row says the versions are beyond the forum's paging, without claiming there are none", async () => {
    const h = createHarness({ families: FAMILIES, extra: history("VeryLongHistory01", [
      { offset: 0, rows: 0, totalCount: 3000, startMs: 0 }, { offset: 1000, rows: 0, totalCount: 3000, startMs: 0 }, { offset: 2000, rows: 0, totalCount: 3000, startMs: 0 },
    ]) });
    const out = await h.call("get_history", { post: "VeryLongHistory01" });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(4);
    expect(out.text).not.toContain("No publicly visible versions of this text.");
    expect(out.text).toContain("Original: not determined; older versions are beyond the forum's paging");
    expect(out.text).toContain("0 public versions fetched so far · newest first");
    expect(out.text.split("\n").at(-1)).toBe("End of reachable results: the forum's paging can't reach older versions of this text.");
    expectClean(h);
  });

  it("a cached list extended later is labelled again as a whole: an image copy ending one raw page folds into its edit on the next", async () => {
    const start = Date.parse("2025-01-01T00:00:00.000Z");
    const pages = history("LongHistoryPost01", [
      { offset: 0, rows: 1000, totalCount: 1200, startMs: start },
      { offset: 1000, rows: 200, totalCount: 200, startMs: start - 1000 * 60_000 },
    ]);
    const firstPage = (pages[0]!.result as { results: Record<string, unknown>[] }).results;
    firstPage[999] = { ...firstPage[999], updateType: "patch", commitMessage: "Move images to CDN", changeMetrics: { added: 0, removed: 0 } };
    const h = createHarness({ families: FAMILIES, extra: pages });
    expect((await h.call("get_history", { post: "LongHistoryPost01" })).text).toContain("1,000 public versions fetched so far · newest first");
    const old = await h.call("get_history", { post: "LongHistoryPost01", sort: "old" });
    expect(old.text).toContain("1,199 public versions (1 automatic image copy folded in) · all public versions listed · oldest first");
  });

  it("a list cursor: the document given again as an id or a slug continues, another document or value is bad_input, and a stored id that now opens another document is not_found", async () => {
    const lean = loadFamilies("posts").find((e) => "root" in e.match && e.match.root === "post" && e.match.id === LEAN)!.result as { result: unknown };
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "a-critical-look-at-lean4" }, limit: 2 }, { results: [lean.result] }, "§3.2")] });
    const first = await h.call("get_history", { post: LEAN, limit: 2 });
    const cursor = printedCursor(first.text)!;
    const byId = await h.call("get_history", { cursor, post: LEAN });
    expect(byId.isError, byId.text).toBe(false);
    expect(byId.text).toContain("Position: items 3–4 of 6");
    const bySlug = await h.call("get_history", { cursor, post: "a-critical-look-at-lean4" });
    expect(bySlug.isError, bySlug.text).toBe(false);
    expect(bySlug.text).toContain("Position: items 3–4 of 6");
    expect((await h.call("get_history", { cursor, post: "uMQ3cqWDPHhjtiesc" })).text)
      .toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(post: cursor has "zHhGa3iQBQcdSifFL", call has "uMQ3cqWDPHhjtiesc"\)/);
    expect((await h.call("get_history", { cursor, sort: "old" })).text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(sort: /);
    // D1 on every continuation: the stored id is tried again as id and slug; another document holding that slug is not the cursor's.
    h.clock.advance(6 * 60_000);   // past the raw-response cache: the document is asked again
    const other = { ...rawPostRef({ _id: "AnotherLeanPost01", title: "Another post", slug: LEAN, af: false }), postedAt: "2025-01-01T00:00:00.000Z", hideAuthor: false, contents: { version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z" } };
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_history_req1"), body: JSON.stringify({ data: { p: { result: null }, s: { results: [other] } } }) });
    const moved = await h.call("get_history", { cursor });
    expect(moved.text).toBe('Error (not_found): No publicly visible post has the id "zHhGa3iQBQcdSifFL".');
    expect(gqlTexts(h.forum).at(-1)).toContain('p: post(selector: {_id: "zHhGa3iQBQcdSifFL"}');
  });

  it("P17 loadTexts refuses an id outside the visible list before sending anything", async () => {
    const h = createHarness({ families: FAMILIES });
    const ctx = createCallContext("get_history", { now: h.clock.now });
    const list = { doc: { kind: "post" as const, id: LEAN, hideAuthor: false }, rows: [], complete: true };
    await expect(loadTexts(["LeanRev0000000002"], list, ctx, h.services))
      .rejects.toThrow("Unexpected failure in get_history (revision text requested outside the visible list). Please report this.");
    expect(h.forum.requests).toHaveLength(0);
  });
});

describe("get_history: texts and diffs", () => {
  it("¶3.9 a version text the forum fails to read is the call's error, worded with what the request was for", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({
      endpoint: "graphql", when: (b) => b.includes("revision_text"), times: 1,
      body: JSON.stringify({ data: { r1: null }, errors: [{ message: "Something went wrong", path: ["r1"] }] }),
    });
    const out = await h.call("get_history", { post: LEAN, revision: "original" });
    expect(out.text).toBe("Error (forum_error): The forum returned an error while reading the version texts (Something went wrong). Try again later.");
  });

  it("revision original: the text from the visible list, fenced; three requests", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "original" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toContain('r1: revision(selector: {_id: "LeanRev0000000002"}) { result { _id documentId fieldName version editedAt wordCount html } }');
    expect(out.text).toMatch(/--- begin text [0-9a-f]{6} \(revision_id LeanRev0000000002, v1\.1\.0; written by forum users\) ---/);
    expect(out.text).toContain("It has a small kernel.");
    expectClean(h);
  });

  it("P17 an id outside the visible list is bad_input and never fetched", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "NotInTheList00001" });
    expect(out.text).toBe("Error (bad_input): revision: not a public version of this text. Use a revision_id from this text's version list, or original or current.");
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum).join("\n")).not.toContain("revision(selector");
  });

  // #65: a saved version's html carries a dialogue's speaker headers as its page does (handleDialogueHtml runs when it is saved).
  const dialogueVersion = (hideAuthor: boolean, second = "Bob", more = "") => {
    const fams = loadFamilies("posts", "revisions");
    const copy = (pred: (m: Record<string, unknown>) => boolean) => JSON.parse(JSON.stringify(fams.find((e) => pred(e.match as unknown as Record<string, unknown>))!));
    const post = copy((m) => m.root === "post" && m.id === LEAN);
    Object.assign(post.result.result, { collabEditorDialogue: true, hideAuthor });
    const rev = copy((m) => m.root === "revision" && m.id === "LeanRev0000000007");
    const message = (name: string, body: string) => `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2025-01-10T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    rev.result.result.html = message(hideAuthor ? "PLANTED-SPEAKER" : "Alice", `<p>Hello there, Bob.</p>${more}`) + message(hideAuthor ? "PLANTED-SPEAKER" : second, "<p>Hi Alice.</p>");
    return createHarness({ families: FAMILIES, extra: [post, rev] });
  };
  it("#65 revision=current on a named dialogue names each speaker before their words, as get_post does", async () => {
    const h = dialogueVersion(false);
    const out = (await h.call("get_history", { post: LEAN, revision: "current" })).text;
    expect(out).toContain("**Alice:**\n\nHello there, Bob.\n\n**Bob:**\n\nHi Alice.");
    expect((await h.call("get_history", { post: LEAN, revision: "current", match: "Alice" })).text).toMatch(/1 of 2 paragraphs contain "Alice"\./);
  });
  it("#65 phrases read a version's text without its labels, even after the labelled text was read: a speaker's name is not found", async () => {
    const h = dialogueVersion(false, "Carol");
    expect((await h.call("get_history", { post: LEAN, revision: "current" })).text).toContain("**Carol:**");
    expect((await h.call("get_history", { post: LEAN, phrases: ["Carol"] })).text).toContain('"Carol": not in the original or the current text');
  });
  it("the review: match on a named dialogue's version searches its words, an author's own bold line ending in a colon included", async () => {
    const out = (await dialogueVersion(false, "Bob", "<p><strong>Key point:</strong></p>").call("get_history", { post: LEAN, revision: "current", match: "Key point" })).text;
    expect(out).toContain('1 of 3 paragraphs contain "Key point".');
    expect(out).toContain("**Key point:**");
  });
  it("#65 compare_to on a named dialogue names the speaker of the turn a change is in", async () => {
    const fams = loadFamilies("posts", "revisions");
    const copy = (pred: (m: Record<string, unknown>) => boolean) => JSON.parse(JSON.stringify(fams.find((e) => pred(e.match as unknown as Record<string, unknown>))!));
    const post = copy((m) => m.root === "post" && m.id === LEAN);
    Object.assign(post.result.result, { collabEditorDialogue: true, hideAuthor: false });
    const message = (name: string, body: string) => `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2025-01-10T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    const first = copy((m) => m.root === "revision" && m.id === "LeanRev0000000002");
    first.result.result.html = message("Alice", "<p>Hello there, Bob.</p>") + message("Bob", "<p>Hi Alice.</p>");
    const last = copy((m) => m.root === "revision" && m.id === "LeanRev0000000007");
    last.result.result.html = message("Alice", "<p>Hello there, Bob.</p>") + message("Bob", "<p>Hi Alice, how are you?</p>");
    const h = createHarness({ families: FAMILIES, extra: [post, first, last] });
    const out = (await h.call("get_history", { post: LEAN, revision: "original", compare_to: "current" })).text;
    expect(out).toContain("**Bob:**\n\nHi [-Alice.-] {+Alice, how are you?+}");
  });
  it("#65 an anonymous dialogue's versions name nobody (P7)", async () => {
    const out = (await dialogueVersion(true).call("get_history", { post: LEAN, revision: "current" })).text;
    expect(out).toContain("Hello there, Bob.");
    expect(out).not.toContain("PLANTED");
  });

  // An old-style debate post's page shows its turns in place of its body; its history is its own body's, where the debate editor asked authors to
  // write their first dialogue comment (debateEditorPlaceholder), and the forum shows those versions on its revision pages.
  const DEBATE_HISTORY = "Old-style debate post: its history is that of the post's own body, where the debate editor asked authors to write their first dialogue comment; its page shows the debate turns in its place.";
  const flagged = (o: Record<string, unknown>) => {
    const fams = loadFamilies("posts");
    const post = JSON.parse(JSON.stringify(fams.find((e) => (e.match as unknown as Record<string, unknown>).root === "post" && (e.match as unknown as Record<string, unknown>).id === LEAN)!));
    Object.assign(post.result.result, o);
    return createHarness({ families: FAMILIES, extra: [post] });
  };
  it("an old-style debate post's history says, under its history line, whose text it is, in every mode", async () => {
    const h = flagged({ debate: true });
    const modes: Record<string, unknown>[] = [{}, { revision: "current" }, { revision: "original", compare_to: "current" }, { revision: "current", match: "kernel" }];
    for (const args of modes) {
      const out = (await h.call("get_history", { post: LEAN, ...args })).text;
      expect(out, JSON.stringify(args)).toMatch(new RegExp(`\\nHistory of [^\\n]*\\n${DEBATE_HISTORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    }
    const phrases = (await h.call("get_history", { post: LEAN, phrases: ["kernel"] })).text;
    expect(phrases).toContain(`${DEBATE_HISTORY}\nPhrases checked in `);
    expectClean(h);
  });
  it("no debate line on any other post's history", async () => {
    const h = flagged({ debate: false });
    for (const args of [{}, { revision: "current" }, { phrases: ["kernel"] }]) expect((await h.call("get_history", { post: LEAN, ...args })).text).not.toContain("Old-style debate post");
    expectClean(h);
  });
  // A dialogue's versions print no word count.
  it("a dialogue's version lines print no word count; any other post's do", async () => {
    const dialogue = (await flagged({ collabEditorDialogue: true }).call("get_history", { post: LEAN })).text;
    const rows = dialogue.split("\n").filter((l) => l.startsWith("• revision_id "));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).not.toMatch(/ · [\d,]+ words?\b/);
    const plain = (await flagged({ collabEditorDialogue: false }).call("get_history", { post: LEAN })).text;
    const plainRows = plain.split("\n").filter((l) => l.startsWith("• revision_id "));
    expect(plainRows.length).toBe(rows.length);
    for (const row of plainRows) expect(row).toMatch(/ · [\d,]+ words?\b/);
  });
  it("a dialogue's evidence lines under phrases print no word count either", async () => {
    const out = (await flagged({ collabEditorDialogue: true }).call("get_history", { post: LEAN, phrases: ["kernel"] })).text;
    const evidence = out.split("\n").filter((l) => l.startsWith("• revision_id "));
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(row).not.toMatch(/ · [\d,]+ words?\b/);
  });

  // first_use keeps a version's own page text under the version's id; get_history reads a version that has a folded image copy from
  // the copy's page (textId). Their one reader (loaders' revisionTexts) keys the shared cache by the revision whose page was read, so
  // neither serves the other's text: get_history once showed first_use's copy for 6 hours (a February-July 2026 version's [equation], say).
  it("a version with a folded image copy is read from the copy, even after first_use kept the version's own page", async () => {
    const h = createHarness({ families: FAMILIES });
    h.services.caches.set("revtext", "LeanRev0000000005", "OWN-PAGE-TEXT of v1.11.0, as first_use keeps it");
    const out = (await h.call("get_history", { post: LEAN, revision: "LeanRev0000000005" })).text;
    expect(out).not.toContain("OWN-PAGE-TEXT");
    expect(out).toContain("Lean4 has a small trusted kernel.");
    // first_use's entry is left as it was, and get_history's is under the copy's id.
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000005")).toContain("OWN-PAGE-TEXT");
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000006")).toContain("Lean4 has a small trusted kernel.");
    expectClean(h);
  });
  it("get_history keeps a folded copy's page under the copy's id, the entry first_use would read for that row", async () => {
    const h = createHarness({ families: FAMILIES });
    await h.call("get_history", { post: LEAN, revision: "LeanRev0000000005" });
    // The copy's own page is what first_use would read for that row (LeanRev0000000006), so the shared entry means the same to both.
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000006")).toContain("Lean4 has a small trusted kernel.");
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000005")).toBeUndefined();
  });

  // The same for a named dialogue's labelled text (the `#speakers` entry), which only get_history keeps: under the copy's id too.
  it("a named dialogue's labelled text of a version with a folded copy is kept under the copy's id, never a stale row entry", async () => {
    const h = flagged({ collabEditorDialogue: true, hideAuthor: false });
    h.services.caches.set("revtext", "LeanRev0000000005#speakers", "STALE-LABELLED-TEXT under the row's own id");
    const out = (await h.call("get_history", { post: LEAN, revision: "LeanRev0000000005" })).text;
    expect(out).not.toContain("STALE-LABELLED-TEXT");
    expect(out).toContain("Lean4 has a small trusted kernel.");
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000006#speakers")).toContain("Lean4 has a small trusted kernel.");
    expect(h.services.caches.get<string>("revtext", "LeanRev0000000005")).toBeUndefined();
    expectClean(h);
  });

  it("match keeps only the matching paragraphs of one version", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "current", match: "kernel" });
    expect(out.text).toMatch(/1 of \d+ paragraphs contain "kernel"\./);
    expect(out.text).toContain("It has a small trusted kernel.");
    expect(out.text).not.toContain("Don't trust it alone.");
  });

  it("compare_to: both texts in one request, a local word diff against the older version", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "original", compare_to: "current" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toMatch(/r1: revision\(selector: \{_id: "LeanRev000000000[27]"\}\).*r2: revision\(selector: \{_id: "LeanRev000000000[27]"\}\)/s);
    expect(out.text).toMatch(/\+\d+ \/ −\d+ words against v1\.1\.0, \d+ paragraphs? changed/);
    expect(out.text).toContain("{+trusted+}");
    expect(out.text).not.toContain("RevisionsDiff");
  });

  it("compare_to previous is the next older visible row", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "LeanRev0000000004", compare_to: "previous" });
    expect(gqlTexts(h.forum)[2]).toContain('_id: "LeanRev0000000003"');
    expect(out.text).toContain("against v1.10.0");
  });

  it("a long text continues with a slice cursor and costs no new request", async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `Sentence ${i + 1} of the original text.`).join("\n\n");
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "revision", id: "LeanRev0000000002" }, { result: { _id: "LeanRev0000000002", documentId: LEAN, fieldName: "contents", version: "1.1.0", editedAt: "2024-11-02T15:00:00.400Z", wordCount: 12000, markdown: long } }, "§7.4")] });
    const first = await h.call("get_history", { post: LEAN, revision: "original", max_tokens: 3000 });
    expect(first.text).toContain("[… continues: about ");
    const next = await h.call("get_history", { cursor: printedCursor(first.text)! });
    expect(next.text).toMatch(/Sentence \d+ of the original text\./);
    expect(h.forum.requests).toHaveLength(3);
  });
});
