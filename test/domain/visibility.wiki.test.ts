import { describe, expect, it } from "vitest";
import {
  maskTagRef, mdocPublic, pageOf, revisionRowPublic, tagListable, tagPublic, visibleChildren, wikiEditPage,
} from "../../src/domain/visibility";
import type { RawLensRef, RawRevRow, VisibleTagRef } from "../../src/types";
import { rawMdocRef, rawRevRow, rawTagRef } from "../support/builders";

const INTERP = rawTagRef({ _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai", core: false, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false });
const AI = rawTagRef({ _id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", core: true, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false });
const BAYES = rawTagRef({ _id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", core: false, wikiOnly: true, adminOnly: false, deleted: false, isPlaceholderPage: false });
const ADMIN = rawTagRef({ _id: "PLANTEDadminPage1", name: "PLANTED-P12-admin", slug: "planted-p12-admin", core: false, wikiOnly: false, adminOnly: true, deleted: false, isPlaceholderPage: false });
const DELETED = { ...ADMIN, _id: "PLANTEDdeletedTg1", name: "PLANTED-P12-deleted", slug: "planted-p12-deleted", adminOnly: false, deleted: true };
const PLACEHOLDER = rawTagRef({ _id: "placeholderPage01", name: "Some redlink", slug: "some-redlink", core: false, wikiOnly: true, adminOnly: false, deleted: false, isPlaceholderPage: true });

const INTERP_REF: VisibleTagRef = { hidden: false, id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai", wikiOnly: false };
const BAYES_REF: VisibleTagRef = { hidden: false, id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true };

const lensRef = (o: Partial<RawLensRef>): RawLensRef => ({
  _id: "bayesRuleGuide001", slug: "bayes-rule-guide", title: "Guide", tabTitle: "Guide",
  fieldName: "description", deleted: false, parentTag: BAYES, ...o,
});
const LENS = rawMdocRef({
  _id: "bayesRuleGuide001", slug: "bayes-rule-guide", title: "Guide", tabTitle: "Guide", fieldName: "description",
  collectionName: "Tags", deleted: false, parentTag: BAYES, parentLens: null,
});
const PAGE_SUMMARY = rawMdocRef({
  _id: "interpSummary0001", slug: "interp-summary", title: null, tabTitle: "Summary", fieldName: "summary",
  collectionName: "Tags", deleted: false, parentTag: INTERP, parentLens: null,
});
const LENS_SUMMARY = rawMdocRef({
  _id: "guideSummary00001", slug: "guide-summary", title: null, tabTitle: "Summary", fieldName: "summary",
  collectionName: "MultiDocuments", deleted: false, parentTag: null,
  parentLens: lensRef({}),
});

const row = (o: Partial<RawRevRow>): RawRevRow => rawRevRow({
  _id: "revision000000001", documentId: "56yXXrcxRjrQs6z9R", collectionName: "Tags",
  version: "1.6.0", editedAt: "2025-03-01T10:00:00.000Z", updateType: "minor", commitMessage: "",
  changeMetrics: { added: 12, removed: 3 }, wordCount: 900, userId: "samplePerson00001", user: null,
  tag: null, lens: null, summary: null, ...o,
});
const md = (o: Partial<RawRevRow>): RawRevRow =>
  row({ collectionName: "MultiDocuments", documentId: "bayesRuleGuide001", ...o });
const PLANTED_ROW = { documentId: "PLANTED-P12-documentId", commitMessage: "PLANTED-P12-commit" };

describe("tags (P12 (a))", () => {
  it("P12 (a) P1 a null tag join is hidden; deleted and admin-only tags are hidden everywhere", () => {
    for (const t of [null, undefined, ADMIN, DELETED]) {
      expect(tagPublic(t)).toBe(false);
      expect(tagListable(t)).toBe(false);
      expect(maskTagRef(t)).toStrictEqual({ hidden: true });
    }
    expect(JSON.stringify([maskTagRef(ADMIN), maskTagRef(DELETED)])).not.toMatch(/PLANTED|planted/);
  });

  it("P12 wiki-only pages and core tags are public references with the wiki-only flag", () => {
    expect(maskTagRef(BAYES)).toStrictEqual(BAYES_REF);
    expect(maskTagRef(INTERP)).toStrictEqual(INTERP_REF);
    expect(maskTagRef(AI)).toStrictEqual({ hidden: false, id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", wikiOnly: false });
    expect(tagListable(BAYES)).toBe(true);
  });

  it("P12 placeholder pages are public references but never listed", () => {
    expect(tagPublic(PLACEHOLDER)).toBe(true);
    expect(tagListable(PLACEHOLDER)).toBe(false);
    expect(maskTagRef(PLACEHOLDER)).toMatchObject({ hidden: false, wikiOnly: true });
  });
});

describe("lenses and summaries (P12 (b))", () => {
  it("P12 (b) pageOf is the parentTag, else the parent lens's page", () => {
    expect(pageOf(LENS)).toEqual(BAYES);
    expect(pageOf(PAGE_SUMMARY)).toEqual(INTERP);
    expect(pageOf(LENS_SUMMARY)).toEqual(BAYES);
    expect(pageOf({ ...LENS, parentTag: null })).toBeNull();
  });

  it("P12 (b) Q137 a lens is public only if it is not deleted and its page is non-null and public", () => {
    expect(mdocPublic(LENS)).toBe(true);
    expect(mdocPublic({ ...LENS, parentTag: null })).toBe(false);
    expect(mdocPublic({ ...LENS, deleted: true })).toBe(false);
    expect(mdocPublic({ ...LENS, parentTag: ADMIN })).toBe(false);
    expect(mdocPublic({ ...LENS, parentTag: DELETED })).toBe(false);
    expect(mdocPublic(null)).toBe(false);
    expect(mdocPublic(undefined)).toBe(false);
  });

  it("P12 (b) a page's summary needs a public page", () => {
    expect(mdocPublic(PAGE_SUMMARY)).toBe(true);
    expect(mdocPublic({ ...PAGE_SUMMARY, parentTag: null })).toBe(false);
    expect(mdocPublic({ ...PAGE_SUMMARY, deleted: true })).toBe(false);
  });

  it("P12 (b) Q137 a lens's own summary needs a non-null, non-deleted parent lens whose page is public", () => {
    expect(mdocPublic(LENS_SUMMARY)).toBe(true);
    expect(mdocPublic({ ...LENS_SUMMARY, parentLens: lensRef({ deleted: true }) })).toBe(false);
    expect(mdocPublic({ ...LENS_SUMMARY, parentLens: lensRef({ parentTag: ADMIN }) })).toBe(false);
    expect(mdocPublic({ ...LENS_SUMMARY, parentLens: null })).toBe(false);
    expect(mdocPublic({ ...LENS_SUMMARY, parentTag: BAYES, parentLens: null })).toBe(false);
    expect(mdocPublic({ ...LENS_SUMMARY, deleted: true })).toBe(false);
  });

  it("P12 (b) a lens's summary uses whichever page join the forum fills", () => {
    expect(mdocPublic({ ...LENS_SUMMARY, parentTag: BAYES, parentLens: lensRef({ parentTag: null }) })).toBe(true);
  });

  it("Q60 P12 a page's hidden child rows are not shown", () => {
    const rows = [
      { _id: "interpSummary0001", deleted: false, tabTitle: "Summary" },
      { _id: "PLANTEDsummary001", deleted: true, tabTitle: "PLANTED-Q60" },
    ];
    expect(visibleChildren(rows)).toEqual([{ _id: "interpSummary0001", deleted: false, tabTitle: "Summary" }]);
    expect(visibleChildren(null)).toEqual([]);
    expect(visibleChildren(undefined)).toEqual([]);
  });
});

describe("revision rows (P12 (c))", () => {
  it("P12 (c) a Tags row is shown only with a public tag join; otherwise it is dropped whole", () => {
    expect(revisionRowPublic(row({ tag: INTERP }))).toBe(true);
    for (const tag of [null, ADMIN, DELETED]) {
      const r = row({ ...PLANTED_ROW, tag });
      expect(revisionRowPublic(r)).toBe(false);
      expect(wikiEditPage(r)).toBeUndefined();
    }
  });

  it("P12 (c) Q137 a MultiDocuments row needs a public lens or summary join", () => {
    expect(revisionRowPublic(md({ lens: LENS }))).toBe(true);
    expect(revisionRowPublic(md({ summary: PAGE_SUMMARY }))).toBe(true);
    expect(revisionRowPublic(md({ summary: LENS_SUMMARY }))).toBe(true);
    expect(revisionRowPublic(md({ ...PLANTED_ROW }))).toBe(false);
    expect(revisionRowPublic(md({ ...PLANTED_ROW, lens: { ...LENS, deleted: true } }))).toBe(false);
    expect(revisionRowPublic(md({ ...PLANTED_ROW, lens: { ...LENS, parentTag: null } }))).toBe(false);
    expect(revisionRowPublic(md({ ...PLANTED_ROW, summary: { ...LENS_SUMMARY, parentLens: lensRef({ deleted: true }) } }))).toBe(false);
    expect(revisionRowPublic(md({ ...PLANTED_ROW, tag: INTERP }))).toBe(false);
  });

  it("P12 (c) a feed tagRevised or tagRevision item whose tag is null is dropped whole", () => {
    expect(revisionRowPublic({ collectionName: "Tags", tag: null })).toBe(false);
    expect(wikiEditPage({ collectionName: "Tags", tag: null })).toBeUndefined();
    expect(revisionRowPublic({ collectionName: "Tags", tag: AI })).toBe(true);
  });

  it("P12 (c) rows of any other collection, or with no collectionName, are dropped", () => {
    expect(revisionRowPublic(row({ collectionName: "Posts", tag: INTERP }))).toBe(false);
    expect(revisionRowPublic(row({ collectionName: null, tag: INTERP }))).toBe(false);
  });

  it("P12 wikiEditPage names the page and the part of every public wiki edit (¶4.7 step 6)", () => {
    expect(wikiEditPage(row({ tag: INTERP }))).toEqual({ part: "page", page: INTERP_REF });
    expect(wikiEditPage(md({ lens: LENS }))).toEqual({
      part: "lens", page: BAYES_REF, lens: { slug: "bayes-rule-guide", title: "Guide" },
    });
    expect(wikiEditPage(md({ lens: { ...LENS, title: null, tabTitle: "Guide tab" } }))).toEqual({
      part: "lens", page: BAYES_REF, lens: { slug: "bayes-rule-guide", title: "Guide tab" },
    });
    expect(wikiEditPage(md({ summary: PAGE_SUMMARY }))).toEqual({ part: "summary", page: INTERP_REF, summaryId: "interpSummary0001" });
    expect(wikiEditPage(md({ summary: LENS_SUMMARY }))).toEqual({
      part: "lens summary", page: BAYES_REF,
      lens: { slug: "bayes-rule-guide", title: "Guide" }, summaryId: "guideSummary00001",
    });
  });

  it("P12 P14 wikiEditPage is undefined exactly when the row is hidden", () => {
    const rows = [
      row({ tag: INTERP }), row({ tag: null }), row({ tag: ADMIN }), md({ lens: LENS }), md({}),
      md({ summary: LENS_SUMMARY }), md({ summary: { ...LENS_SUMMARY, parentLens: null } }), row({ collectionName: "Posts" }),
    ];
    for (const r of rows) expect(wikiEditPage(r) === undefined).toBe(!revisionRowPublic(r));
  });
});
