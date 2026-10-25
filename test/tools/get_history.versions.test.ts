import { describe, expect, it } from "vitest";
import { historyDocOps } from "../../src/forum/templates/get_history";
import { loadTexts } from "../../src/tools/get_history";
import { createCallContext } from "../../src/call/context";
import type { ParsedRef } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { gqlEntry, rawPostRef, revisionHistory as history } from "../support/builders";
import { loadFamilies } from "../support/fixtures";

const LEAN = "zHhGa3iQBQcdSifFL";
const FAMILIES = ["posts", "comments", "tags", "revisions", "users"] as const;
const CHANGE = "Change counts are the forum's own.";
const r = (kind: ParsedRef["kind"], form: ParsedRef["form"], value: string): ParsedRef => ({ kind, form, value, given: "id", notes: [] });

describe("get_history templates and definition", () => {
  it("request 1 per document kind, with exactly the fields each check needs", () => {
    expect(historyDocOps(r("post", "id", LEAN), "post").map((o) => o.text)).toEqual([
      'p: post(selector: {_id: "zHhGa3iQBQcdSifFL"}, allowNull: true) { result { ...POST_REF postedAt hideAuthor contents { version editedAt } } }',
    ]);
    expect(historyDocOps(r("post", "slug", "some-slug"), "post")[0].text)
      .toBe('ps: posts(selector: {slugPost: {slug: "some-slug"}}, limit: 2) { results { ...POST_REF postedAt hideAuthor contents { version editedAt } } }');
    expect(historyDocOps(r("post", "idOrSlug", LEAN), "post").map((o) => o.alias)).toEqual(["p", "ps"]);
    expect(historyDocOps(r("comment", "id", "HRDoDnHv8bvoW7oPZ"), "comment")[0].text)
      .toBe('c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_REF contents { version } post { ...POST_REF } tag { ...TAG_REF } } }');
    expect(historyDocOps(r("tag", "id", "RkznxXmmh9b5ovdSq"), "tag").map((o) => o.text)).toEqual([
      't: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...TAG_REF description { version editedAt } } }',
      'm: multiDocument(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...MDOC_REF contents { version editedAt } } }',
    ]);
    expect(historyDocOps(r("tag", "slug", "bayes-rule-guide"), "tag")[0].text)
      .toBe('lp: TagPreview(slug: "bayes-rule-guide") { tag { ...TAG_REF } lens { ...MDOC_REF contents { version editedAt } } }');
    expect(historyDocOps(r("tag", "idOrSlug", "RkznxXmmh9b5ovdSq"), "tag").map((o) => o.alias)).toEqual(["t", "m", "lp"]);
    expect(historyDocOps(r("post", "id", LEAN), "post")[0].template).toBe("get_history_req1");
  });

  it("parameter rules are bad_input before any request", async () => {
    const h = createHarness({ families: FAMILIES });
    expect((await h.call("get_history", { post: LEAN, tag: "bayes-rule" })).text).toMatch(/^Error \(bad_input\): give exactly one of post, comment, tag/);
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

  it("comments, wiki pages and lenses: their own field, header and original", async () => {
    const h = createHarness({ families: FAMILIES });
    const comment = await h.call("get_history", { comment: "HRDoDnHv8bvoW7oPZ" });
    expect(comment.text).toContain('History of comment comment_id HRDoDnHv8bvoW7oPZ (AF) on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)');
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

  it("a page summary's summary_id: its own history (field contents) under the page it summarizes", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { tag: "InterpSummary0001" });
    expect(gqlTexts(h.forum).at(-1)).toContain('revisionsOnDocument: {documentId: "InterpSummary0001", fieldName: "contents"}');
    expect(out.text).toContain('History of summary (summary_id InterpSummary0001) of "Interpretability (ML & AI)" (tag_slug interpretability-ml-and-ai)');
    expect(out.text).toContain("Original (oldest public version): revision_id InterpSumRev00001");
  });

  it("Q71 P5 P17 hidden posts and deleted comments show no history", async () => {
    const h = createHarness({ families: FAMILIES });
    // ¶8: a bare 17-character string, tried as id and as slug, reads in the slug form with the find hint
    expect((await h.call("get_history", { post: "HiddenDraftPost01" })).text).toMatch(/^Error \(not_found\): No publicly visible post has the slug "HiddenDraftPost01"\. Slugs are case-sensitive; to look up a name use find \{items: \[\{kind: "post", query: "HiddenDraftPost01"\}\]\}\. Renamed posts/);
    expect((await h.call("get_history", { comment: "DeletedPubComment" })).text)
      .toBe("Error (bad_input): comment: this comment has no public history.");
    expect((await h.call("get_history", { comment: "privDeletedCmnt01" })).text).toBe('Error (not_found): No publicly visible comment has the id "privDeletedCmnt01".');
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
    expect((await h.call("get_history", { cursor, comment: "HRDoDnHv8bvoW7oPZ" })).text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(comment: /);
    expect((await h.call("get_history", { cursor, sort: "old" })).text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(sort: /);
    // D1 on every continuation: the stored id is tried again as id and slug; another document holding that slug is not the cursor's.
    h.clock.advance(6 * 60_000);   // past the raw-response cache: the document is asked again
    const other = { ...rawPostRef({ _id: "AnotherLeanPost01", title: "Another post", slug: LEAN, af: false }), postedAt: "2025-01-01T00:00:00.000Z", hideAuthor: false, contents: { version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z" } };
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("get_history_req1"), body: JSON.stringify({ data: { p: { result: null }, ps: { results: [other] } } }) });
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
  it("revision original: the text from the visible list, fenced; three requests", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, revision: "original" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toContain('r1: revision(selector: {_id: "LeanRev0000000002"}) { result { _id documentId fieldName version editedAt wordCount markdown } }');
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
