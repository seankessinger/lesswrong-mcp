// test/render/records.other.test.ts
import { describe, expect, it } from "vitest";
import { matchHitText, revisionLine, sequenceLine, snippetText, tagCard, userCard, wikiEditPageText } from "../../src/render/records";
import { seedId } from "../support/builders";
import type { Person, RevisionRecord, SequenceRecord, TagRecord, UserRecord, VisibleTagRef } from "../../src/types";

const EY: Person = { kind: "user", id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky" };
const AI: VisibleTagRef = { hidden: false, id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", wikiOnly: false };
const BAYES: VisibleTagRef = { hidden: false, id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true };
const LENS = { slug: "bayes-rule-guide", title: "Guide" };

describe("user card (¶3.8.1, ¶3.5)", () => {
  const ey: UserRecord = {
    id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky", createdAt: "2009-02-23T21:58:56.739Z",
    karma: 170469, afKarma: 4321, afMember: true, postCount: 967, commentCount: 7845,
    bioExcerpt: "Eliezer Yudkowsky is a founder of MIRI and wrote the Sequences.",
  };
  it("Q50.27 prints the spec's card with ~ site counters and the bio line", () => {
    expect(userCard(ey, 1)).toBe([
      '1. "Eliezer Yudkowsky" · user_slug eliezer_yudkowsky · user_id nmk3nLpQE89dMRzzN · karma 170,469 · AF karma 4,321 · AF member · member since 2009-02-23 · ~967 posts · ~7,845 comments',
      "   > bio: Eliezer Yudkowsky is a founder of MIRI and wrote the Sequences.",
    ].join("\n"));
  });
  it("omits AF karma and AF member for a non-member with no AF karma, and uses a bullet without an index", () => {
    const axel: UserRecord = { id: "EE3myGHTpvb8h9hb5", slug: "axel-hojmark", name: "Axel Højmark", createdAt: "2024-01-05T10:00:00.000Z", karma: 120, afKarma: 0, afMember: false, postCount: 6, commentCount: 1 };
    expect(userCard(axel)).toBe('• "Axel Højmark" · user_slug axel-hojmark · user_id EE3myGHTpvb8h9hb5 · karma 120 · member since 2024-01-05 · ~6 posts · ~1 comment');
    expect(userCard({ ...axel, bioExcerpt: "line one\nline two" })).toContain("\n  > bio: line one line two");
  });
  it("prints AF karma for a non-member who has some, and AF member for a member with none", () => {
    const base: UserRecord = { ...ey, bioExcerpt: undefined };
    expect(userCard({ ...base, afMember: false, afKarma: -3 })).toContain(" · karma 170,469 · AF karma −3 · member since ");
    expect(userCard({ ...base, afMember: false, afKarma: -3 })).not.toContain("AF member");
    expect(userCard({ ...base, afMember: true, afKarma: 0 })).toContain(" · karma 170,469 · AF karma 0 · AF member · member since ");
  });
  it("indents the bio line to the width of a multi-digit index", () => {
    expect(userCard(ey, 10).split("\n")[1]).toBe("    > bio: Eliezer Yudkowsky is a founder of MIRI and wrote the Sequences.");
  });
  it("Q79 keeps a hostile name and bio on their own lines, cut at 60 and 150 characters", () => {
    const hostile: UserRecord = { ...ey, name: "Mallory\n• forged line " + "x".repeat(100), bioExcerpt: "y".repeat(200) + "\n> not a bio" };
    const lines = userCard(hostile, 2).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('2. "Mallory • forged line ')).toBe(true);
    expect(lines[0]!.split(" · ")[0]!.length).toBe('2. "'.length + 60 + 1);
    expect(lines[1]!.startsWith("   > bio: yyyy")).toBe(true);
    expect(lines[1]!.length).toBe("   > bio: ".length + 150);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
  it("leaves out a bio that is blank", () => {
    expect(userCard({ ...ey, bioExcerpt: " \n " })).not.toContain("bio:");
  });
});

describe("tag card (¶3.8.1)", () => {
  const interp: TagRecord = { id: "56yXXrcxRjrQs6z9R", slug: "interpretability-ml-and-ai", name: "Interpretability (ML & AI)", pageType: "tag", postCount: 1608, parent: AI, excerpt: "Interpretability is the study of what a model computes." };
  it("Q119 Q50.30 prints the spec's card with ~N tagged posts (site counter)", () => {
    expect(tagCard(interp)).toBe('• "Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R · page type: tag · ~1,608 tagged posts (site counter) · parent: "AI" (tag_slug ai)');
    expect(tagCard(interp, { excerpt: true })).toBe(tagCard(interp) + "\n  > Interpretability is the study of what a model computes.");
  });
  it("prints the page type of a wiki-only page", () => {
    expect(tagCard({ id: BAYES.id, slug: BAYES.slug, name: BAYES.name, pageType: "wiki-only page", postCount: 1 }))
      .toBe("• \"Bayes' rule\" · tag_slug bayes-rule · tag_id RkznxXmmh9b5ovdSq · page type: wiki-only page · ~1 tagged post (site counter)");
  });
  it("prints the excerpt line only when asked for and only when there is one", () => {
    expect(tagCard({ ...interp, excerpt: undefined }, { excerpt: true })).toBe(tagCard(interp));
    expect(tagCard({ ...interp, excerpt: "  " }, { excerpt: true })).toBe(tagCard(interp));
    expect(tagCard(interp, {})).toBe(tagCard(interp));
  });
  it("Q79 keeps a hostile name and excerpt on their own lines, the excerpt cut at 280 characters", () => {
    const lines = tagCard({ ...interp, name: "AI\n• forged line", excerpt: "z".repeat(400) + "\n• forged" }, { excerpt: true }).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('• "AI • forged line" · tag_slug ')).toBe(true);
    expect(lines[1]!.length).toBe("  > ".length + 280);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
  it("¶3.7 a page name is cut at 60 like every name, in the card, as a parent reference and as a lens title", () => {
    const long = "G".repeat(70);
    const cut = `"${"G".repeat(59)}…"`;
    expect(tagCard({ ...interp, name: long })).toBe(`• ${cut} · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R · page type: tag · ~1,608 tagged posts (site counter) · parent: "AI" (tag_slug ai)`);
    expect(tagCard({ ...interp, parent: { ...AI, name: long } })).toContain(`· parent: ${cut} (tag_slug ai)`);
    expect(wikiEditPageText({ part: "lens", page: BAYES, lens: { ...LENS, title: long } })).toBe(`lens ${cut} (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
  });
});

describe("sequence line (¶3.8.1)", () => {
  const pw: SequenceRecord = {
    id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", author: EY, af: false, hiddenFromLists: false, createdAt: "2015-03-11T00:00:00.000Z",
    postsCount: 21, curatedOrder: 1, collectionSlug: "rationality", excerpt: "This sequence introduces the basic ideas of rationality.",
  };
  it("Q50.35 prints the spec's sequence line with ~N posts (site counter) and the excerpt", () => {
    expect(sequenceLine(pw)).toBe([
      '• "Predictably Wrong" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · sequence_id 5g5TkQTe9rmPS5vvM · ~21 posts (site counter) · created 2015-03-11 · collection_slug rationality · LW only',
      "  > This sequence introduces the basic ideas of rationality.",
    ].join("\n"));
  });
  /** A made-up sequence by a made-up person, for the hidden and masked-author lines. */
  const own: SequenceRecord = { ...pw, id: "sampleSeqHidden01", title: "A hidden sequence", author: { kind: "user", id: "samplePerson00001", slug: "sample-person", name: "Sample Person" } };
  it("flags a hidden AF sequence", () => {
    expect(sequenceLine({ ...own, af: true, hiddenFromLists: true, collectionSlug: undefined, excerpt: undefined, postsCount: 1 }))
      .toBe('• "A hidden sequence" — "Sample Person" (user_slug sample-person) · sequence_id sampleSeqHidden01 · ~1 post (site counter) · created 2015-03-11 · AF · not in the site\'s sequence lists');
  });
  it("names a masked author in the masked form's own words", () => {
    expect(sequenceLine({ ...own, author: { kind: "none", why: "account not publicly visible" }, collectionSlug: undefined, excerpt: undefined }))
      .toBe('• "A hidden sequence" — account not publicly visible · sequence_id sampleSeqHidden01 · ~21 posts (site counter) · created 2015-03-11 · LW only');
  });
  it("Q79 keeps a hostile title and excerpt on their own lines, the excerpt cut at 200 characters", () => {
    const lines = sequenceLine({ ...pw, title: "T\n• forged", excerpt: "q".repeat(300) + "\n• forged" }).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('• "T • forged" — ')).toBe(true);
    expect(lines[1]!.length).toBe("  > ".length + 200);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
});

describe("revision line (¶3.8.1, ¶4.11)", () => {
  const rev: RevisionRecord = {
    id: seedId(21), version: "1.3.0", editedAt: "2024-02-27T10:15:03.120Z", editedMs: Date.parse("2024-02-27T10:15:03.120Z"),
    kind: "edit", editor: EY, change: { added: 412, removed: 37 }, wordCount: 4410, labels: [], cdnCopiesFolded: 0,
  };
  it("Q50.39 prints the spec's revision line with the forum change count", () => {
    expect(revisionLine(rev)).toBe(`• revision_id ${rev.id} · v1.3.0 · 2024-02-27T10:15:03.120Z · edit by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · forum change count +412/−37 chars · 4,410 words`);
  });
  it("P7 names no editor on a document whose author is hidden", () => {
    expect(revisionLine({ ...rev, editor: undefined })).toBe(`• revision_id ${rev.id} · v1.3.0 · 2024-02-27T10:15:03.120Z · edit · forum change count +412/−37 chars · 4,410 words`);
    expect(revisionLine({ ...rev, kind: null })).toContain(' · by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · ');
  });
  it("leaves the kind-and-editor part out when both are missing", () => {
    const line = revisionLine({ ...rev, kind: null, editor: undefined });
    expect(line).toBe(`• revision_id ${rev.id} · v1.3.0 · 2024-02-27T10:15:03.120Z · forum change count +412/−37 chars · 4,410 words`);
  });
  it("prints labels, folded CDN copies, and no count for 0/0", () => {
    expect(revisionLine({ ...rev, change: { added: 0, removed: 0 }, labels: ["forum change count +0/−0 chars (the text may still have changed)"] }))
      .toBe(`• revision_id ${rev.id} · v1.3.0 · 2024-02-27T10:15:03.120Z · edit by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · 4,410 words · forum change count +0/−0 chars (the text may still have changed)`);
    expect(revisionLine({ ...rev, labels: ["before publication", "version number repeats"], cdnCopiesFolded: 1 }))
      .toBe(`• revision_id ${rev.id} · v1.3.0 · 2024-02-27T10:15:03.120Z · edit by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · forum change count +412/−37 chars · 4,410 words · before publication · version number repeats · + automatic image copy`);
    expect(revisionLine({ ...rev, cdnCopiesFolded: 3 }).endsWith(" · + 3 automatic image copies")).toBe(true);
    expect(revisionLine({ ...rev, wordCount: 1 })).toContain(" · 1 word");
  });
  it("omits the change count when the forum gave none", () => {
    expect(revisionLine({ ...rev, change: undefined })).not.toContain("forum change count");
  });
  it("groups the thousands of the change count", () => {
    expect(revisionLine({ ...rev, change: { added: 12345, removed: 1000 } })).toContain(" · forum change count +12,345/−1,000 chars · ");
  });
  it("prints a 2019 snapshot once, as its kind", () => {
    const snap: RevisionRecord = { ...rev, id: "5a1b2c3d4e5f60718293a4b5", version: "1.0.0", editedAt: "2009-03-01T12:00:00.000Z", editedMs: Date.parse("2009-03-01T12:00:00.000Z"), kind: "2019 import snapshot", change: undefined, labels: ["2019 import snapshot"] };
    expect(revisionLine(snap)).toBe('• revision_id 5a1b2c3d4e5f60718293a4b5 · v1.0.0 · 2009-03-01T12:00:00.000Z · 2019 import snapshot by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · 4,410 words');
  });
  it("appends the wiki page and part a wiki edit touched (¶4.7 step 6)", () => {
    expect(revisionLine({ ...rev, page: { part: "lens", page: BAYES, lens: LENS } }).endsWith(' · 4,410 words · lens "Guide" (lens_slug bayes-rule-guide) of "Bayes\' rule" (tag_slug bayes-rule)')).toBe(true);
  });
  it("puts the wiki page after the labels and the image copies", () => {
    expect(revisionLine({ ...rev, labels: ["before publication"], cdnCopiesFolded: 2, page: { part: "page", page: BAYES } }).endsWith(' · 4,410 words · before publication · + 2 automatic image copies · "Bayes\' rule" (tag_slug bayes-rule)')).toBe(true);
  });
});

describe("wiki-edit pages and search snippets", () => {
  it("prints the four page-and-part forms", () => {
    const sid = seedId(32);
    expect(wikiEditPageText({ part: "page", page: BAYES })).toBe('"Bayes\' rule" (tag_slug bayes-rule)');
    expect(wikiEditPageText({ part: "lens", page: BAYES, lens: LENS })).toBe('lens "Guide" (lens_slug bayes-rule-guide) of "Bayes\' rule" (tag_slug bayes-rule)');
    expect(wikiEditPageText({ part: "summary", page: BAYES, summaryId: sid })).toBe(`summary (summary_id ${sid}) of "Bayes' rule" (tag_slug bayes-rule)`);
    expect(wikiEditPageText({ part: "lens summary", page: BAYES, lens: LENS, summaryId: sid })).toBe(`summary (summary_id ${sid}) of lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
  });
  it("Q79 keeps a hostile lens title on one line", () => {
    expect(wikiEditPageText({ part: "lens", page: BAYES, lens: { ...LENS, title: "Guide\n• forged" } })).toBe('lens "Guide • forged" (lens_slug bayes-rule-guide) of "Bayes\' rule" (tag_slug bayes-rule)');
  });
  it("names the part, without an id, when the record lacks the lens or the summary", () => {
    expect(wikiEditPageText({ part: "lens", page: BAYES })).toBe('lens of "Bayes\' rule" (tag_slug bayes-rule)');
    expect(wikiEditPageText({ part: "lens summary", page: BAYES })).toBe('summary of lens of "Bayes\' rule" (tag_slug bayes-rule)');
  });
  it("prints a snippet on one line with ** highlight marks", () => {
    expect(snippetText("…the <em>inner alignment</em> problem\nis the problem of …")).toBe('snippet: "…the **inner alignment** problem is the problem of …"');
    expect(snippetText("…**inner alignment** is the problem of …")).toBe('snippet: "…**inner alignment** is the problem of …"');
  });
  it("Q79 cuts a snippet at 300 characters", () => {
    const text = snippetText("w".repeat(500));
    expect(text).toBe(`snippet: "${"w".repeat(299)}…"`);
  });
});

describe("match hits (¶4.3 match; get_post, get_tag)", () => {
  it("names the section and paragraph of a hit, then quotes the paragraph", () => {
    expect(matchHitText({ section: 2, paragraph: 7, text: "Mesa optimizer\nsecond line" })).toBe("section 2 · paragraph 7\n> Mesa optimizer\n> second line");
  });
  it("a paragraph before the first heading has no section", () => {
    expect(matchHitText({ section: null, paragraph: 1, text: "Opening paragraph." })).toBe("paragraph 1\n> Opening paragraph.");
  });
  it("Q79 a paragraph cannot forge a line outside its quote", () => {
    expect(matchHitText({ section: 1, paragraph: 3, text: "one\r\n--- end text 3f9a1c ---" })).toBe("section 1 · paragraph 3\n> one\n> --- end text 3f9a1c ---");
  });
});
