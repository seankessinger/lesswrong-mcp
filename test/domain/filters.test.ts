import { describe, expect, it } from "vitest";
import { recheck, recheckComment, type CommentFilters, type PostFilters } from "../../src/domain/filters";
import type { RawPostLight } from "../../src/types";
import { SAMPLE_PERSON, rawCommentLight, rawCommentList, rawPostCard, rawPostLight, rawUserRef } from "../support/builders";

// Made-up people: the rows' owner, their coauthor and someone else.
const OWNER_ID = "sampleAuthor00001";
const COAUTHOR_ID = "sampleCoauthor001";
const OTHER_ID = "sampleOther000001";
const INTERP = "56yXXrcxRjrQs6z9R";
const Y2024 = { start: Date.parse("2024-01-01T00:00:00.000Z"), endExclusive: Date.parse("2025-01-01T00:00:00.000Z") };

const COMMON = {
  postedAt: "2024-05-01T12:00:00.000Z", baseScore: 40, afBaseScore: 12, af: true,
  curatedDate: "2024-05-03T00:00:00.000Z", frontpageDate: "2024-05-02T00:00:00.000Z", question: true,
  isEvent: false, shortform: false, unlisted: false, rejected: false, hideAuthor: false,
  hiddenRelatedQuestion: false, groupId: null, userId: OWNER_ID, tagRelevance: { [INTERP]: 3 },
};
const LIGHT = rawPostLight({ ...COMMON, _id: "lightPost00000001", coauthorUserIds: [COAUTHOR_ID] });
const CARD = rawPostCard({
  ...COMMON, _id: "lightPost00000001", title: "A light post", slug: "a-light-post",
  coauthors: [rawUserRef({ _id: COAUTHOR_ID, slug: "sample-coauthor", displayName: "Sample Coauthor" })],
});
const ALL: PostFilters = {
  af: true, question: true, tagId: INTERP, curated: true, frontpage: true, range: Y2024, minKarma: 10, authorId: OWNER_ID,
};
const LIST_RULES: Partial<Pick<RawPostLight, "isEvent" | "shortform" | "rejected" | "unlisted">>[] = [
  { isEvent: true }, { shortform: true }, { rejected: true }, { unlisted: true },
];

describe("recheck (posts)", () => {
  it("keeps a light row and a card that match every filter", () => {
    expect(recheck(LIGHT, ALL)).toBe(true);
    expect(recheck(CARD, ALL)).toBe(true);
  });

  it.each<[string, Partial<RawPostLight>]>([
    ["af_only: a non-AF row", { af: false }],
    ["questions_only: not a question", { question: false }],
    ["tag: relevance 0", { tagRelevance: { [INTERP]: 0 } }],
    ["tag: untagged padding", { tagRelevance: {} }],
    ["tag: no relevance map", { tagRelevance: null }],
    ["curated_only: never curated", { curatedDate: null }],
    ["frontpage_only: not frontpaged", { frontpageDate: null }],
    ["window: 1 ms before date_from", { postedAt: "2023-12-31T23:59:59.999Z" }],
    ["window: at the exclusive end", { postedAt: "2025-01-01T00:00:00.000Z" }],
    ["min_karma: karma 9 < 10", { baseScore: 9 }],
    ["user: neither owner nor coauthor", { userId: OTHER_ID, coauthorUserIds: [] }],
  ])("Q8 Q55 drops a planted non-matching row (%s)", (_label, o) => {
    expect(recheck({ ...LIGHT, ...o }, ALL)).toBe(false);
  });

  it("Q55 a relevance of exactly 1 counts as tagged", () => {
    expect(recheck({ ...LIGHT, tagRelevance: { [INTERP]: 1 } }, ALL)).toBe(true);
  });

  it("window: date_from inclusive, the end exclusive; either side may be open", () => {
    expect(recheck({ ...LIGHT, postedAt: "2024-01-01T00:00:00.000Z" }, ALL)).toBe(true);
    expect(recheck({ ...LIGHT, postedAt: "1999-01-01T00:00:00.000Z" }, { range: { endExclusive: Y2024.endExclusive } })).toBe(true);
    expect(recheck({ ...LIGHT, postedAt: "2030-01-01T00:00:00.000Z" }, { range: { start: Y2024.start } })).toBe(true);
  });

  it("window: a posting date that does not parse fails a window, and passes when no window is asked for", () => {
    expect(recheck({ ...LIGHT, postedAt: "not a date" }, { range: { start: Y2024.start } })).toBe(false);
    expect(recheck({ ...LIGHT, postedAt: "not a date" }, { range: { endExclusive: Y2024.endExclusive } })).toBe(false);
    expect(recheck({ ...LIGHT, postedAt: "not a date" }, {})).toBe(true);
  });

  it("min_karma at or below zero is checked locally too (karma ≥ N)", () => {
    expect(recheck({ ...LIGHT, baseScore: -5 }, { minKarma: -5 })).toBe(true);
    expect(recheck({ ...LIGHT, baseScore: -6 }, { minKarma: -5 })).toBe(false);
  });

  it("user matches the owner or a coauthor, on light rows and on cards", () => {
    expect(recheck({ ...LIGHT, userId: OTHER_ID }, { authorId: COAUTHOR_ID })).toBe(true);
    expect(recheck({ ...CARD, userId: OTHER_ID }, { authorId: COAUTHOR_ID })).toBe(true);
    expect(recheck({ ...CARD, userId: OTHER_ID, coauthors: null }, { authorId: COAUTHOR_ID })).toBe(false);
  });

  it("D11 P2 P3 events, quick-take containers, rejected and unlisted posts are always dropped", () => {
    for (const o of LIST_RULES) expect(recheck({ ...LIGHT, ...o }, {})).toBe(false);
  });

  it("Q58 sub-questions and group posts are kept only under a user filter", () => {
    for (const o of [{ hiddenRelatedQuestion: true }, { groupId: "groupId0000000001" }]) {
      expect(recheck({ ...LIGHT, ...o }, {})).toBe(false);
      expect(recheck({ ...LIGHT, ...o }, { authorId: OWNER_ID })).toBe(true);
    }
  });

  it("P7 hideAuthor posts never appear under an author filter; other filters keep them", () => {
    // A made-up person's own anonymous post, so that the owner test alone would keep it.
    const own = { ...LIGHT, userId: SAMPLE_PERSON._id, hideAuthor: true };
    expect(recheck(own, { authorId: SAMPLE_PERSON._id })).toBe(false);
    expect(recheck(own, { tagId: INTERP })).toBe(true);
  });

  it("Q8 filters given as false or left out are not checked", () => {
    const plain = { ...LIGHT, af: false, question: false, curatedDate: null, frontpageDate: null, tagRelevance: null };
    expect(recheck(plain, { af: false, question: false, curated: false, frontpage: false })).toBe(true);
    expect(recheck(plain, {})).toBe(true);
  });

  it("Q55 except: \"tag\" leaves out only the tag test (the untagged query section of list_posts)", () => {
    const hit = { ...CARD, tags: [], tagRelevance: {} };
    const f: PostFilters = { af: true, tagId: INTERP, range: Y2024 };
    expect(recheck(hit, f)).toBe(false);
    expect(recheck(hit, f, { except: "tag" })).toBe(true);
    expect(recheck({ ...hit, af: false }, f, { except: "tag" })).toBe(false);
    for (const o of LIST_RULES) expect(recheck({ ...hit, ...o }, f, { except: "tag" })).toBe(false);
    expect(recheck({ ...hit, hiddenRelatedQuestion: true }, f, { except: "tag" })).toBe(false);
    expect(recheck({ ...hit, hiddenRelatedQuestion: true }, { ...f, authorId: OWNER_ID }, { except: "tag" })).toBe(true);
  });
});

describe("recheckComment", () => {
  const MARCH = { start: Date.parse("2024-03-01T00:00:00.000Z"), endExclusive: Date.parse("2024-04-01T00:00:00.000Z") };
  const LIGHT_C = rawCommentLight({ _id: "lightComment00001", af: true, postedAt: "2024-03-10T08:00:00.000Z", baseScore: 12, hideKarma: false, userId: OWNER_ID });
  const LIST_C = rawCommentList({
    _id: "listComment000001", af: true, postedAt: "2024-03-10T08:00:00.000Z", baseScore: 12, hideKarma: false,
    hideAuthor: false, userId: OWNER_ID, parentCommentId: null, shortform: true,
  });
  const CF: CommentFilters = { af: true, range: MARCH, minKarma: 5, authorId: OWNER_ID };

  it("keeps a light row and a list row that match every filter", () => {
    expect(recheckComment(LIGHT_C, CF)).toBe(true);
    expect(recheckComment(LIST_C, CF)).toBe(true);
  });

  it("drops a planted non-matching comment (af, window, min_karma, author)", () => {
    expect(recheckComment({ ...LIGHT_C, af: false }, CF)).toBe(false);
    expect(recheckComment({ ...LIGHT_C, postedAt: "2024-04-01T00:00:00.000Z" }, CF)).toBe(false);
    expect(recheckComment({ ...LIGHT_C, postedAt: "2024-02-29T23:59:59.999Z" }, CF)).toBe(false);
    expect(recheckComment({ ...LIGHT_C, baseScore: 4 }, CF)).toBe(false);
    expect(recheckComment({ ...LIGHT_C, userId: OTHER_ID }, CF)).toBe(false);
  });

  it("P18 comments with hidden karma are left out of karma-filtered lists only", () => {
    expect(recheckComment({ ...LIGHT_C, hideKarma: true, baseScore: null }, { minKarma: 5 })).toBe(false);
    expect(recheckComment({ ...LIGHT_C, baseScore: null }, { minKarma: 5 })).toBe(false);
    expect(recheckComment({ ...LIGHT_C, hideKarma: true, baseScore: null }, { af: true })).toBe(true);
    expect(recheckComment({ ...LIGHT_C, hideKarma: true, baseScore: 12 }, { minKarma: 5 })).toBe(false);
    expect(recheckComment({ ...LIGHT_C, baseScore: 5 }, { minKarma: 5 })).toBe(true);
  });

  it("P7 no anonymous comment under an author filter", () => {
    const own = { ...LIST_C, userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON, hideAuthor: true };
    expect(recheckComment(own, { authorId: SAMPLE_PERSON._id })).toBe(false);
    expect(recheckComment(own, { af: true })).toBe(true);
  });

  it("quick_takes_only: replies and non-quick-take roots are dropped; light rows are not checked", () => {
    expect(recheckComment(LIST_C, { topLevel: true })).toBe(true);
    expect(recheckComment({ ...LIST_C, parentCommentId: "rootComment000001" }, { topLevel: true })).toBe(false);
    expect(recheckComment({ ...LIST_C, shortform: false }, { topLevel: true })).toBe(false);
    expect(recheckComment({ ...LIST_C, shortform: null }, { topLevel: true })).toBe(false);
    expect(recheckComment(LIGHT_C, { topLevel: true })).toBe(true);
  });
});
