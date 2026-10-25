// test/render/records.posts.test.ts
import { describe, expect, it } from "vitest";
import {
  afBlock, agreementText, commentBlock, commentHeader, commentRefText, outlineLine, parentText, personText, placeText,
  postLine, postRefText, quote, seqRefText, statusTexts, tagRefText, threadHeader,
} from "../../src/render/records";
import { sliceText } from "../../src/render/budget";
import { listCutMarker } from "../../src/render/messages";
import { oneLine } from "../../src/text/sanitize";
import { seedId } from "../support/builders";
import type { CommentRecord, Person, PostRecord, RankedThread, ReactEntry, Reactions, StatusFlags, VisiblePostRef, VisibleTagRef } from "../../src/types";

const EY: Person = { kind: "user", id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky" };
const AXEL: Person = { kind: "user", id: "EE3myGHTpvb8h9hb5", slug: "axel-hojmark", name: "Axel Højmark" };
const PAUL: Person = { kind: "user", id: seedId(1), slug: "paulfchristiano", name: "paulfchristiano" };
const NO_SLUG: Person = { kind: "user", id: seedId(2), slug: null, name: "No Slug" };
const ANON: Person = { kind: "none", why: "author not publicly visible" };
const GONE: Person = { kind: "none", why: "account not publicly visible" };
const tag = (name: string, slug: string, id: string): VisibleTagRef => ({ hidden: false, id, name, slug, wikiOnly: false });
const FLAGS: StatusFlags = { frontpage: true, pinned: false, question: false, dialogue: false, debate: false, event: false, shortform: false, subQuestion: false, groupPost: false, unlisted: false, placeholderDate: false };
const AGI_REF: VisiblePostRef = { hidden: false, id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities", af: true, event: false, unlisted: false, question: false, shortform: false };

const AGI_RUIN: PostRecord = {
  id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities",
  url: "https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities",
  authors: [EY],
  postedAt: "2022-06-05T22:05:52.224Z", postedMs: Date.parse("2022-06-05T22:05:52.224Z"), karma: 1055, votes: 612,
  af: true, afKarma: 156, commentCount: 717, afCommentCount: 145,
  status: { ...FLAGS, curatedDate: "2022-06-07T18:00:00.000Z", bestOf: { year: 2022, category: "ai safety", rank: 1 } },
  tags: [
    { tag: tag("AI Risk", "ai-risk", seedId(11)), relevance: 25 }, { tag: tag("Threat Models", "threat-models", seedId(12)), relevance: 12 },
    { tag: tag("AI", "ai", "sYm3HiWcfZvrGu3ui"), relevance: 9 }, { tag: tag("Rationality", "rationality", seedId(13)), relevance: 7 },
    { tag: tag("World Modeling", "world-modeling", seedId(14)), relevance: 5 }, { tag: tag("Corrigibility", "corrigibility", seedId(15)), relevance: 3 },
    { tag: tag("Inner Alignment", "inner-alignment", seedId(16)), relevance: 2 }, { tag: tag("Outer Alignment", "outer-alignment", seedId(17)), relevance: 1 },
    { tag: tag("Deception", "deception", seedId(18)), relevance: 1 },
  ],
  excerpt: "Preamble: (If you're already familiar with all basics and don't want any preamble, skip ahead to Section B …",
};
const GLM: PostRecord = {
  ...AGI_RUIN, id: "R5g8YT25G9DXJJ48n",
  title: "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior",
  url: "https://www.lesswrong.com/posts/R5g8YT25G9DXJJ48n/glm-5-3-sometimes-considers-how-train-time-actions-shape",
  authors: [AXEL, EY], postedAt: "2026-10-14T09:30:00.000Z", postedMs: Date.parse("2026-10-14T09:30:00.000Z"),
  karma: 88, votes: 1, af: false, afKarma: 34, commentCount: 1, afCommentCount: 0,
  status: { ...FLAGS, curatedDate: "2026-10-16T12:00:00.000Z" }, tags: [], excerpt: undefined,
};

/** A made-up post by a made-up person: the subject of the anonymous and deleted-account lines. */
const PERSON: Person = { kind: "user", id: "samplePerson00001", slug: "sample-person", name: "Sample Person" };
const SAMPLE: PostRecord = {
  ...GLM, id: "samplePost0000001", title: "A sample post", url: "https://www.lesswrong.com/posts/samplePost0000001/a-sample-post", authors: [PERSON],
};
/** A made-up comment's id, for parents that are anonymous, deleted or by a deleted account. */
const SAMPLE_COMMENT = "sampleComment0001";

const react = (name: string, net: number): ReactEntry => ({ name, net, created: [], seconded: [], disagreed: [], quotes: [] });
const NONE: Reactions = { reacts: [], likers: [], hasVoteData: false };
const VOTED: Reactions = { reacts: [react("disagree", 2), react("crux", 1), react("typo", 0)], agreement: { score: 45, votes: 30 }, likers: [], hasVoteData: true };
/** A made-up comment shown as a deleted placeholder; `o` is merged over it. */
function placeholderComment(o: Partial<CommentRecord> = {}): CommentRecord {
  return comment({ id: SAMPLE_COMMENT, rootId: SAMPLE_COMMENT, author: { kind: "none", why: "comment placeholder" }, body: undefined, ...o });
}
function comment(o: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: "HRDoDnHv8bvoW7oPZ", author: PAUL,
    postedAt: "2022-06-19T16:02:11.000Z", postedMs: Date.parse("2022-06-19T16:02:11.000Z"), edited: false,
    karma: 299, votes: 120, afKarma: 87, karmaHidden: false, af: true, reactions: NONE,
    parentId: null, rootId: "HRDoDnHv8bvoW7oPZ", answer: false, retracted: false,
    moderatorHat: false, quickTake: false, pinnedOnProfile: false, debateTurn: false,
    wordCount: 4, body: "First line\r\n\r\nThird line", ...o,
  };
}

describe("people and references (¶3.1.3, ¶3.8.1)", () => {
  it("P7 P8 names a person with user_slug, or user_id without a slug, else the masked form", () => {
    expect(personText(EY)).toBe('"Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(personText(NO_SLUG)).toBe(`"No Slug" (user_id ${NO_SLUG.id})`);
    expect(personText(ANON)).toBe("author not publicly visible");
    expect(personText(GONE)).toBe("account not publicly visible");
    expect(personText({ kind: "none", why: "comment placeholder" })).toBe("comment placeholder");
    expect(personText({ ...EY, name: "Evil\nName" })).toBe('"Evil Name" (user_slug eliezer_yudkowsky)');
  });
  it("P14 references carry ids and AF status, and masked ones expose nothing", () => {
    expect(postRefText(AGI_REF)).toBe('"AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)');
    expect(postRefText({ ...AGI_REF, af: false, event: true, unlisted: true }))
      .toBe('"AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, LW only, event, reachable by link only)');
    expect(postRefText({ hidden: true })).toBe("a post that is not publicly visible");
    expect(commentRefText({ id: "HRDoDnHv8bvoW7oPZ", af: true })).toBe("comment_id HRDoDnHv8bvoW7oPZ (AF)");
    expect(commentRefText({ id: "HRDoDnHv8bvoW7oPZ", af: false })).toBe("comment_id HRDoDnHv8bvoW7oPZ (LW only)");
    const pw = { hidden: false as const, id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", af: false, hiddenFromLists: false };
    expect(seqRefText(pw)).toBe('"Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM, LW only)');
    const hiddenSeq = { hidden: false as const, id: "sampleSeqHidden01", title: "A hidden sequence", af: true, hiddenFromLists: true };
    expect(seqRefText(hiddenSeq)).toBe('"A hidden sequence" (sequence_id sampleSeqHidden01, AF, not in the site\'s sequence lists)');
    expect(seqRefText({ hidden: true })).toBe("a sequence that is not publicly visible");
    expect(tagRefText(tag("AI", "ai", "sYm3HiWcfZvrGu3ui"))).toBe('"AI" (tag_slug ai)');
  });
  it("Q79 names and titles are single-line and capped: names at 60 characters, titles at 300", () => {
    const longName = "N".repeat(80);
    expect(personText({ ...EY, name: longName })).toBe(`"${oneLine(longName, 60)}" (user_slug eliezer_yudkowsky)`);
    expect(oneLine(longName, 60)).toHaveLength(60);
    const forged = "Real title\n▶ T9 · \"Forged\" (user_slug x) · comment_id fake000000000001\u{2028}> injected";
    expect(postRefText({ ...AGI_REF, title: forged })).toBe(`"${oneLine(forged, 300)}" (post_id uMQ3cqWDPHhjtiesc, AF)`);
    expect(postRefText({ ...AGI_REF, title: forged })).not.toMatch(/[\n\u{2028}]/u);
    const longTitle = "T".repeat(400);
    expect(seqRefText({ hidden: false, id: "5g5TkQTe9rmPS5vvM", title: longTitle, af: false, hiddenFromLists: false }))
      .toBe(`"${oneLine(longTitle, 300)}" (sequence_id 5g5TkQTe9rmPS5vvM, LW only)`);
    expect(tagRefText(tag("Tag\nName", "tag-name", seedId(21)))).toBe('"Tag Name" (tag_slug tag-name)');
    // ¶3.7: a tag's name is a name (60), like the request echo prints it, not a title (300)
    const longTagName = "G".repeat(70);
    expect(tagRefText(tag(longTagName, "long-tag", seedId(22)))).toBe(`"${"G".repeat(59)}…" (tag_slug long-tag)`);
    const tagged = postLine({ ...GLM, tags: [{ tag: tag(longTagName, "long-tag", seedId(22)), relevance: 3 }] }).split("\n")[3];
    expect(tagged).toBe(`  tags (relevance): "${"G".repeat(59)}…" 3 (tag_slug long-tag)`);
  });
  it("prints agreement as ±N (k agreement votes)", () => {
    expect(agreementText({ score: 45, votes: 30 })).toBe("agreement +45 (30 agreement votes)");
    expect(agreementText({ score: -8, votes: 11 })).toBe("agreement −8 (11 agreement votes)");
    expect(agreementText({ score: 0, votes: 1 })).toBe("agreement 0 (1 agreement vote)");
    expect(agreementText({ score: 1234, votes: 1500 })).toBe("agreement +1,234 (1,500 agreement votes)");
  });
  it("quotes block text line by line, normalizing CR, U+2028 and U+2029", () => {
    expect(quote("a\r\nb\u{2028}\n\nc")).toBe("> a\n> b\n>\n>\n> c");
    expect(quote("one\n--- end text 3f9a1c ---\n\n")).toBe("> one\n> --- end text 3f9a1c ---");
    expect(quote("p\u{2029}q")).toBe("> p\n> q");
  });
});

describe("post list form (¶3.8.1)", () => {
  it("prints the 5 lines of the spec's example, at most 6 tags then +N more", () => {
    expect(postLine(AGI_RUIN, { excerpt: true })).toBe([
      '• "AGI Ruin: A List of Lethalities" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)',
      "  post_id uMQ3cqWDPHhjtiesc · 2022-06-05 · karma 1,055 (612 votes) · ~717 comments · AF (AF karma 156, ~145 AF comments) · curated 2022-06-07 · frontpage · Best of LessWrong 2022 (ai safety, #1)",
      "  https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities",
      '  tags (relevance): "AI Risk" 25 (tag_slug ai-risk) · "Threat Models" 12 (tag_slug threat-models) · "AI" 9 (tag_slug ai) · "Rationality" 7 (tag_slug rationality) · "World Modeling" 5 (tag_slug world-modeling) · "Corrigibility" 3 (tag_slug corrigibility) · +3 more',
      "  > Preamble: (If you're already familiar with all basics and don't want any preamble, skip ahead to Section B …",
    ].join("\n"));
    expect(postLine(AGI_RUIN).split("\n")).toHaveLength(4);
  });

  it("¶3.8.1 the tag list's boundary: exactly 6 tags print with no +0 more; 7 print 6 and +1 more", () => {
    const tagLine = (n: number) => postLine({ ...AGI_RUIN, tags: AGI_RUIN.tags.slice(0, n) }).split("\n")[3];
    expect(tagLine(6)).toMatch(/\(tag_slug corrigibility\)$/);
    expect(tagLine(6)).not.toContain("more");
    expect(tagLine(7)).toMatch(/\(tag_slug corrigibility\) · \+1 more$/);
    expect(tagLine(7).split(" · ")).toHaveLength(7);
  });
  it("Q50.12 a non-AF post shows LW only, never its stored AF karma; coauthors follow the owner; Q50.3 counters carry ~", () => {
    expect(postLine(GLM)).toBe([
      '• "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior" — "Axel Højmark" (user_slug axel-hojmark), "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)',
      "  post_id R5g8YT25G9DXJJ48n · 2026-10-14 · karma 88 (1 vote) · ~1 comment · LW only · curated 2026-10-16 · frontpage",
      "  https://www.lesswrong.com/posts/R5g8YT25G9DXJJ48n/glm-5-3-sometimes-considers-how-train-time-actions-shape",
    ].join("\n"));
    expect(postLine(GLM)).not.toContain("AF karma");
  });
  it("Q50.3 whole counters of 1,000 or more get commas, and ids and dates never do", () => {
    const line = postLine({ ...GLM, commentCount: 7845, karma: 12345, votes: 2001 }).split("\n")[1];
    expect(line).toBe("  post_id R5g8YT25G9DXJJ48n · 2026-10-14 · karma 12,345 (2,001 votes) · ~7,845 comments · LW only · curated 2026-10-16 · frontpage");
  });
  it("P7 P8 an anonymous post names no author; a deleted account prints account not publicly visible", () => {
    expect(postLine({ ...SAMPLE, authors: [ANON] }).split("\n")[0]).toBe('• "A sample post" — author not publicly visible');
    expect(postLine({ ...SAMPLE, authors: [GONE] }).split("\n")[0]).toBe('• "A sample post" — account not publicly visible');
  });
  it("P7 a post line prints people from authors only", () => {
    const anon: PostRecord = { ...SAMPLE, authors: [ANON], excerpt: "An excerpt." };
    const text = postLine(anon, { excerpt: true, prefix: "  2. " });
    expect(text).not.toMatch(/samplePerson00001|sample[- ]person/i);
    expect(text).toContain("— author not publicly visible");
  });
  it("Q79 the title is one line capped at 300 characters, and the excerpt one line capped at 280", () => {
    const title = `First line\n${"x".repeat(400)}`;
    const lines = postLine({ ...GLM, title, excerpt: `Para one\r\n\r\nPara two ${"y".repeat(400)}` }, { excerpt: true }).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`• "${oneLine(title, 300)}" — "Axel Højmark" (user_slug axel-hojmark), "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)`);
    expect(lines[3]).toBe(`  > ${oneLine(`Para one\r\n\r\nPara two ${"y".repeat(400)}`, 280)}`);
    expect(Array.from(lines[3]!.slice(4))).toHaveLength(280);
  });
  it("Q50.5 under sort active: last comment <date> or no comments yet", () => {
    expect(postLine(GLM, { lastComment: "2026-10-20T08:00:00.000Z" }).split("\n")[1]).toBe("  post_id R5g8YT25G9DXJJ48n · 2026-10-14 · karma 88 (1 vote) · ~1 comment · LW only · curated 2026-10-16 · frontpage · last comment 2026-10-20");
    expect(postLine(GLM, { lastComment: null }).split("\n")[1]).toBe("  post_id R5g8YT25G9DXJJ48n · 2026-10-14 · karma 88 (1 vote) · ~1 comment · LW only · curated 2026-10-16 · frontpage · no comments yet");
  });
  it("a prefix replaces the bullet and deepens the indent of the following lines", () => {
    const lines = postLine(GLM, { prefix: "  1. ★ best match (exact title) — " }).split("\n");
    expect(lines[0]).toBe('  1. ★ best match (exact title) — "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior" — "Axel Højmark" (user_slug axel-hojmark), "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(lines[1].startsWith("    post_id R5g8YT25G9DXJJ48n")).toBe(true);
  });
  it("prints status flags in the fixed order", () => {
    expect(statusTexts({
      curatedDate: "2024-01-02T03:04:05.000Z", frontpage: false, pinned: true, bestOf: { year: 2023, category: "ai safety", rank: 4 },
      question: true, linkUrl: "https://example.com/paper", dialogue: true, debate: true, event: true, shortform: true,
      subQuestion: true, groupPost: true, unlisted: true, placeholderDate: true,
    })).toEqual([
      "curated 2024-01-02", "not frontpaged", "pinned", "Best of LessWrong 2023 (ai safety, #4)",
      "question", "linkpost → https://example.com/paper", "dialogue", "debate", "event", "quick takes container",
      "sub-question (not in the site's main lists)", "group post", "reachable by link only", "date may be a placeholder",
    ]);
    expect(statusTexts(FLAGS)).toEqual(["frontpage"]);
  });
  it("Q79 the Best of category is single-line like every forum string", () => {
    expect(statusTexts({ ...FLAGS, bestOf: { year: 2022, category: "ai\nsafety", rank: 2 } })).toEqual(["frontpage", "Best of LessWrong 2022 (ai safety, #2)"]);
  });
  it("prints the AF block", () => {
    expect(afBlock(AGI_RUIN)).toBe("AF (AF karma 156, ~145 AF comments)");
    expect(afBlock({ ...AGI_RUIN, afKarma: null, afCommentCount: 1 })).toBe("AF (~1 AF comment)");
    expect(afBlock(GLM)).toBe("LW only");
  });
});

describe("comment thread form (¶3.8.1, ¶3.5)", () => {
  it("prints the spec's example header and the quoted body", () => {
    expect(commentBlock(comment({ edited: true, reactions: VOTED }), { form: "thread", label: "T3.1", postAf: true })).toBe([
      '▶ T3.1 · "paulfchristiano" (user_slug paulfchristiano) · 2022-06-19 16:02Z · karma 299 (120 votes) · agreement +45 (30 agreement votes) · AF karma 87 · reacts: disagree 2, crux 1 · edited · comment_id HRDoDnHv8bvoW7oPZ',
      "> First line", ">", "> Third line",
    ].join("\n"));
  });
  it("Q50.12 a non-AF comment is 'not on AF' in an AF post's discussion and unmarked elsewhere; never its AF karma", () => {
    const c = comment({ af: false, afKarma: 12 });
    expect(commentHeader(c, { form: "thread", label: "T2", postAf: true })).toBe('▶ T2 · "paulfchristiano" (user_slug paulfchristiano) · 2022-06-19 16:02Z · karma 299 (120 votes) · not on AF · comment_id HRDoDnHv8bvoW7oPZ');
    expect(commentHeader(c, { form: "thread", label: "T2", postAf: false })).toBe('▶ T2 · "paulfchristiano" (user_slug paulfchristiano) · 2022-06-19 16:02Z · karma 299 (120 votes) · comment_id HRDoDnHv8bvoW7oPZ');
  });
  it("P18 hidden comment karma prints 'karma not publicly visible' and no votes, agreement or reactions, never 0", () => {
    const h = comment({ karma: null, votes: null, afKarma: null, karmaHidden: true, reactions: VOTED });
    const line = commentHeader(h, { form: "thread", label: "T4", postAf: true });
    expect(line).toBe('▶ T4 · "paulfchristiano" (user_slug paulfchristiano) · 2022-06-19 16:02Z · karma not publicly visible · AF · comment_id HRDoDnHv8bvoW7oPZ');
    expect(line).not.toMatch(/votes|agreement|reacts|karma 0/);
    expect(commentHeader({ ...h, af: false }, { form: "thread", label: "T4", postAf: true })).toContain("karma not publicly visible · not on AF ·");
  });
  it("C4 'moderator comment' only on attributable comments", () => {
    expect(commentHeader(comment({ moderatorHat: true }), { form: "thread", label: "T1" })).toContain(" · moderator comment · ");
    for (const author of [ANON, GONE]) expect(commentHeader(comment({ id: SAMPLE_COMMENT, rootId: SAMPLE_COMMENT, moderatorHat: true, author }), { form: "thread", label: "T1" })).not.toContain("moderator comment");
    const ph = placeholderComment({ moderatorHat: true, placeholder: { reason: "Spam" } });
    expect(commentHeader(ph, { form: "thread", label: "T1" })).not.toContain("moderator comment");
  });
  it("P5 a deleted placeholder shows its date and reason only, no author, scores, flags or body", () => {
    const ph = placeholderComment({
      placeholder: { reason: "Spam" }, reactions: VOTED,
      edited: true, retracted: true, reviewYear: "2022", quickTake: true, answer: true, pinnedOnProfile: true, debateTurn: true, moderatorHat: true,
    });
    expect(commentBlock(ph, { form: "thread", label: "T3.4", postAf: true })).toBe(`▶ T3.4 · comment placeholder (reason: Spam) · 2022-06-19 16:02Z · comment_id ${SAMPLE_COMMENT}`);
  });
  it("P5 a placeholder still carries the caller's position notes (the reply to a private comment is marked), but none of its own flags", () => {
    const ph = placeholderComment({
      placeholder: { reason: "Spam" }, reactions: VOTED,
      edited: true, retracted: true, reviewYear: "2022", quickTake: true, answer: true, pinnedOnProfile: true, debateTurn: true, moderatorHat: true,
    });
    expect(commentBlock(ph, { form: "thread", label: "T3.4", postAf: true, extraFlags: ["parent comment not publicly visible"] }))
      .toBe(`▶ T3.4 · comment placeholder (reason: Spam) · 2022-06-19 16:02Z · parent comment not publicly visible · comment_id ${SAMPLE_COMMENT}`);
    expect(commentBlock(ph, { form: "list", extraFlags: ["parent comment not publicly visible"] }))
      .toBe(`▶ comment placeholder (reason: Spam) · 2022-06-19 16:02Z · parent comment not publicly visible · comment_id ${SAMPLE_COMMENT}`);
  });
  it("prints the marker, then flags in the fixed order, then extra flags", () => {
    const c = comment({ answer: true, reviewYear: "2022", quickTake: true, debateTurn: true, moderatorHat: true, retracted: true, edited: true, pinnedOnProfile: true });
    expect(commentHeader(c, { form: "thread", label: "A1", marker: "★", extraFlags: ["parent comment not publicly visible", 'reply to a debate turn by "Thomas Kwa"'] }))
      .toBe('▶ ★ A1 · "paulfchristiano" (user_slug paulfchristiano) · 2022-06-19 16:02Z · karma 299 (120 votes) · AF karma 87 · answer · review (2022) · quick take · debate turn · moderator comment · retracted · edited · pinned on profile · parent comment not publicly visible · reply to a debate turn by "Thomas Kwa" · comment_id HRDoDnHv8bvoW7oPZ');
  });
  it("prints an unfetched body as the header alone, and an empty body as one bare quote line", () => {
    expect(commentBlock(comment({ body: undefined }), { form: "thread", label: "T1" }).split("\n")).toHaveLength(1);
    expect(commentBlock(comment({ body: "" }), { form: "thread", label: "T1" }).split("\n")[1]).toBe(">");
  });
  it("P14 a comment prints its own comment_id only", () => {
    const c = comment({ parentId: "hiddenParentId001", rootId: "hiddenRootId00001" });
    const text = commentBlock(c, { form: "thread", label: "T1.1", postAf: true });
    for (const secret of ["hiddenParentId001", "hiddenRootId00001"]) expect(text).not.toContain(secret);
    expect(text).toContain("comment_id HRDoDnHv8bvoW7oPZ");
  });
});

describe("comment list form (¶3.8.1)", () => {
  const id = seedId(3);
  const list = comment({
    id, author: EY, postedAt: "2026-10-19T14:02:40.000Z", postedMs: Date.parse("2026-10-19T14:02:40.000Z"),
    karma: 31, votes: 12, af: false, afKarma: 2, reactions: { reacts: [], agreement: { score: 6, votes: 4 }, likers: [], hasVoteData: true },
    body: "A reply.", place: { kind: "post", post: AGI_REF }, parent: { kind: "comment", id: "HRDoDnHv8bvoW7oPZ", af: true, author: PAUL },
  });
  it("prints the spec's example: LW only, the place and the parent", () => {
    expect(commentBlock(list, { form: "list" })).toBe([
      `▶ "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · 2026-10-19 14:02Z · karma 31 (12 votes) · agreement +6 (4 agreement votes) · LW only · comment_id ${id}`,
      '  on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF) · reply to "paulfchristiano" (user_slug paulfchristiano, comment_id HRDoDnHv8bvoW7oPZ, AF)',
      "> A reply.",
    ].join("\n"));
    expect(commentHeader({ ...list, af: true, afKarma: 12 }, { form: "list" }).split("\n")[0]).toContain(" · AF karma 12 · ");
  });
  it("P18 a list-form comment under hidden karma is 'karma not publicly visible · AF' or 'karma not publicly visible · LW only'", () => {
    const h = { ...list, karma: null, votes: null, afKarma: null, karmaHidden: true, reactions: VOTED };
    expect(commentHeader({ ...h, af: true }, { form: "list" }).split("\n")[0])
      .toBe(`▶ "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · 2026-10-19 14:02Z · karma not publicly visible · AF · comment_id ${id}`);
    expect(commentHeader({ ...h, af: false }, { form: "list" }).split("\n")[0]).toContain(" · karma not publicly visible · LW only · ");
  });
  it("P1 places a comment by tagId first, and quick takes as 'quick take' without a duplicate flag", () => {
    expect(placeText({ kind: "tag", tag: tag("Bayes' rule", "bayes-rule", "RkznxXmmh9b5ovdSq") })).toBe('on wiki page "Bayes\' rule" (tag_slug bayes-rule)');
    expect(placeText({ kind: "quick take", post: AGI_REF })).toBe("quick take");
    expect(placeText({ kind: "hidden post" })).toBe("on a post that is not publicly visible");
    expect(placeText({ kind: "hidden tag" })).toBe("on a wiki page that is not publicly visible");
    const qt = commentHeader({ ...list, quickTake: true, place: { kind: "quick take", post: AGI_REF }, parent: { kind: "none" } }, { form: "list" });
    expect(qt.split("\n")).toEqual([
      `▶ "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · 2026-10-19 14:02Z · karma 31 (12 votes) · agreement +6 (4 agreement votes) · LW only · comment_id ${id}`,
      "  quick take",
    ]);
  });
  it("P1 P14 a comment on a hidden post or wiki page prints the place alone", () => {
    const hiddenIds = { parentId: "hiddenParentId001", rootId: "hiddenRootId00001" };
    const onPost = commentBlock({ ...list, ...hiddenIds, place: { kind: "hidden post" }, parent: { kind: "hidden" } }, { form: "list" });
    const onTag = commentBlock({ ...list, ...hiddenIds, place: { kind: "hidden tag" }, parent: { kind: "hidden" } }, { form: "list" });
    expect(onPost.split("\n")[1]).toBe("  on a post that is not publicly visible · parent comment not publicly visible");
    expect(onTag.split("\n")[1]).toBe("  on a wiki page that is not publicly visible · parent comment not publicly visible");
    for (const text of [onPost, onTag]) for (const secret of Object.values(hiddenIds)) expect(text).not.toContain(secret);
  });
  it("P14 names a parent by id only when it is visible", () => {
    const pid = SAMPLE_COMMENT;
    expect(parentText({ kind: "none" })).toBe("");
    expect(parentText({ kind: "comment", id: pid, af: false, author: NO_SLUG })).toBe(`reply to "No Slug" (user_id ${NO_SLUG.id}, comment_id ${pid}, LW only)`);
    expect(parentText({ kind: "comment", id: pid, af: false, author: ANON })).toBe(`reply to a comment whose author is not publicly visible (comment_id ${pid}, LW only)`);
    expect(parentText({ kind: "comment", id: pid, af: true, author: GONE })).toBe(`reply to a comment whose author is not publicly visible (comment_id ${pid}, AF)`);
    expect(parentText({ kind: "deleted", id: pid })).toBe(`reply to a comment placeholder (comment_id ${pid})`);
    expect(parentText({ kind: "hidden" })).toBe("parent comment not publicly visible");
  });
  it("cuts a list-form body at about 1,500 tokens with the list cut marker", () => {
    const long = "This is a sentence of the comment. ".repeat(600).trim();
    const c = comment({ body: long, place: { kind: "hidden post" }, parent: { kind: "hidden" } });
    expect(commentBlock(c, { form: "list" })).toBe([
      commentHeader(c, { form: "list" }), quote(sliceText(long, 1500).text), listCutMarker("HRDoDnHv8bvoW7oPZ"),
    ].join("\n"));
    expect(commentHeader(c, { form: "list" }).split("\n")[1]).toBe("  on a post that is not publicly visible · parent comment not publicly visible");
    expect(commentBlock(c, { form: "list", bodyCapTokens: 200 })).toBe([
      commentHeader(c, { form: "list" }), quote(sliceText(long, 200).text), listCutMarker("HRDoDnHv8bvoW7oPZ"),
    ].join("\n"));
  });
  it("adds no cut marker when the cut leaves nothing to read: a rest of whitespace only", () => {
    const body = `Opening line.${"\u{00a0}".repeat(300)}`;
    const cut = sliceText(body, 20);
    expect(cut.next).toBeDefined();
    expect(cut.moreWords).toBe(0);
    const c = comment({ body });
    expect(commentBlock(c, { form: "list", bodyCapTokens: 20 })).toBe([commentHeader(c, { form: "list" }), quote(cut.text)].join("\n"));
  });
  it("a body that fits whole has no marker", () => {
    expect(commentBlock(comment({ body: "Short." }), { form: "list" })).not.toContain("[… cut");
  });
  it("a placeholder in list form has a header and its place, and no body", () => {
    const ph = placeholderComment({ placeholder: { reason: null }, place: { kind: "post", post: AGI_REF }, parent: { kind: "none" } });
    expect(commentBlock(ph, { form: "list" })).toBe([
      `▶ comment placeholder · 2022-06-19 16:02Z · comment_id ${SAMPLE_COMMENT}`,
      '  on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)',
    ].join("\n"));
  });
});

describe("thread header and outline line (¶3.8.1)", () => {
  const root = comment({ edited: true, reactions: VOTED });
  const thread = (o: Partial<RankedThread["thread"]> = {}): RankedThread["thread"] => ({
    rootId: root.id, root: { c: root, children: [], orphan: false }, answer: false, nodes: [], size: 18, participants: 7,
    rootKarma: 299, rootAfKarma: 87, af: true, postedMs: root.postedMs, newestMs: Date.parse("2022-07-01T08:00:00.000Z"), contested: 4, ...o,
  });
  it("prints the spec's thread header", () => {
    expect(threadHeader({ label: "T1", rank: 1, thread: thread() }, true))
      .toBe('## T1 · root by "paulfchristiano" (user_slug paulfchristiano) · comment_id HRDoDnHv8bvoW7oPZ · karma 299 · AF karma 87 · 18 comments · 7 people · contested 4 · newest 2022-07-01');
  });
  it("marks a non-AF root in an AF post, omits contested 0, and pluralizes", () => {
    const r2 = comment({ af: false });
    expect(threadHeader({ label: "T2", rank: 2, thread: thread({ root: { c: r2, children: [], orphan: false }, size: 1, participants: 1, contested: 0, af: false }) }, true))
      .toBe('## T2 · root by "paulfchristiano" (user_slug paulfchristiano) · comment_id HRDoDnHv8bvoW7oPZ · karma 299 · not on AF · 1 comment · 1 person · newest 2022-07-01');
  });
  it("P18 a hidden-karma root prints karma not publicly visible", () => {
    const h = comment({ karma: null, votes: null, afKarma: null, karmaHidden: true });
    expect(threadHeader({ label: "T3", rank: 3, thread: thread({ root: { c: h, children: [], orphan: false }, rootKarma: null, rootAfKarma: null }) }, true))
      .toBe('## T3 · root by "paulfchristiano" (user_slug paulfchristiano) · comment_id HRDoDnHv8bvoW7oPZ · karma not publicly visible · AF · 18 comments · 7 people · contested 4 · newest 2022-07-01');
  });
  it("the AF mark is the root's own: an AF comment deeper in a non-AF root's thread does not mark it", () => {
    const r2 = comment({ af: false });
    const t = thread({ root: { c: r2, children: [], orphan: false }, rootAfKarma: null, af: true });
    expect(threadHeader({ label: "T2", rank: 2, thread: t }, false)).not.toMatch(/AF/);
    expect(threadHeader({ label: "T2", rank: 2, thread: t }, true)).toContain(" · not on AF · ");
  });
  it("P5 a placeholder root names the placeholder and prints no karma or AF mark", () => {
    const ph = placeholderComment({ placeholder: { reason: "Spam" }, karma: null, votes: null, afKarma: null });
    const t = thread({ rootId: SAMPLE_COMMENT, root: { c: ph, children: [], orphan: false }, rootKarma: null, rootAfKarma: null });
    expect(threadHeader({ label: "T5", rank: 5, thread: t }, true))
      .toBe(`## T5 · root by comment placeholder (reason: Spam) · comment_id ${SAMPLE_COMMENT} · 18 comments · 7 people · contested 4 · newest 2022-07-01`);
    expect(outlineLine({ label: "T5", rank: 5, thread: t }, true))
      .toBe(`T5 · comment placeholder (reason: Spam) · comment_id ${SAMPLE_COMMENT} · 18 comments · contested 4 · 2022-06-19`);
  });
  it("P14 a root-less orphan's thread prints its own comment_id only", () => {
    const orphan = comment({ id: "orphanReply00001", rootId: "missingRoot00001", parentId: "missingParent001" });
    const t = thread({ rootId: "orphanReply00001", root: { c: orphan, children: [], orphan: true } });
    for (const text of [threadHeader({ label: "T7", rank: 7, thread: t }, true), outlineLine({ label: "T7", rank: 7, thread: t }, true)]) {
      expect(text).toContain("comment_id orphanReply00001");
      expect(text).not.toContain("missingRoot00001");
      expect(text).not.toContain("missingParent001");
    }
  });
  it("prints the outline line with the opening 60 characters of the root, when fetched", () => {
    const r12 = comment({ af: false, postedAt: "2022-06-08T10:00:00.000Z", postedMs: Date.parse("2022-06-08T10:00:00.000Z"), body: "This is the opening of a long comment that keeps going on." });
    const rt: RankedThread = { label: "T12", rank: 12, thread: thread({ root: { c: r12, children: [], orphan: false }, rootKarma: 45, size: 9, contested: 2, af: false }) };
    expect(outlineLine(rt, false)).toBe('T12 · "paulfchristiano" (user_slug paulfchristiano) · comment_id HRDoDnHv8bvoW7oPZ · karma 45 · 9 comments · contested 2 · 2022-06-08 · "This is the opening of a long comment that keeps going on."');
    const longBody = "word ".repeat(40);
    expect(outlineLine({ ...rt, thread: { ...rt.thread, root: { ...rt.thread.root, c: { ...r12, body: longBody } } } }, false).endsWith(` · "${oneLine(longBody, 60)}"`)).toBe(true);
    expect(outlineLine({ ...rt, thread: { ...rt.thread, root: { ...rt.thread.root, c: { ...r12, body: undefined } } } }, false).endsWith(" · 2022-06-08")).toBe(true);
    expect(outlineLine({ label: "T1", rank: 1, thread: thread() }, true)).toContain(" · karma 299 · AF karma 87 · 18 comments · ");
  });
  it("Q79 the opening of the root is one line even when the body has line breaks", () => {
    const r = comment({ body: "Line one\r\nLine two\u{2028}Line three" });
    const line = outlineLine({ label: "T2", rank: 2, thread: thread({ root: { c: r, children: [], orphan: false }, contested: 0 }) }, false);
    expect(line.endsWith(' · "Line one Line two Line three"')).toBe(true);
    expect(line).not.toMatch(/[\r\n\u{2028}]/u);
  });
});
