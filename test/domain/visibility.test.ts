import { describe, expect, it } from "vitest";
import {
  attributable, authorOf, commentPublic, glossaryTermPublic, isPlaceholder, maskPostRef, maskSeqRef,
  postListable, postPublic, sequenceListable, sequencePublic, userPublic,
} from "../../src/domain/visibility";
import type { Person, RawCommentRef, RawGlossaryTerm } from "../../src/types";
import { SAMPLE_PERSON, rawCommentRef, rawPostRef, rawSeqRef, rawUserRef } from "../support/builders";

/** A made-up person: the author of every comment and post these tests make hidden, anonymous or a placeholder. */
const PERSON = rawUserRef(SAMPLE_PERSON);
const PERSON_NAMED: Person = { kind: "user", id: "samplePerson00001", slug: "sample-person", name: "Sample Person" };
/** The person's id, slug or name. */
const PERSON_RE = /samplePerson00001|sample[- ]person/i;

const AGI_RUIN = rawPostRef({
  _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities",
  af: true, question: false, rejected: false, unlisted: false, shortform: false, hideAuthor: false,
  isEvent: false, hiddenRelatedQuestion: false, groupId: null,
});
const REJECTED_POST = { ...AGI_RUIN, _id: "PLANTEDrejected01", title: "PLANTED-P2-title", slug: "planted-p2-slug", rejected: true };
const UNLISTED_POST = { ...AGI_RUIN, _id: "unlistedPost00001", title: "An unlisted post", slug: "an-unlisted-post", af: false, unlisted: true };

const COMMENT = rawCommentRef({
  _id: "sampleComment0001", postId: "samplePost0000001", tagId: null, userId: "samplePerson00001",
  postedAt: "2022-06-19T16:02:00.000Z", af: true, deleted: false, deletedPublic: false, deletedReason: null,
  rejected: false, authorIsUnreviewed: false, hideAuthor: false, hideKarma: false, debateResponse: false, user: PERSON,
});

/** A comment's author as domain/comments names it: placeholder first, then `hideAuthor`, then the user. */
const commentAuthor = (c: RawCommentRef): Person => authorOf(c.user, { hideAuthor: c.hideAuthor, placeholder: isPlaceholder(c) });

const PW = rawSeqRef({ _id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", af: false, hidden: false });
const HIDDEN_SEQ = rawSeqRef({ _id: "hiddenSeq00000001", title: "A hidden sequence", af: false, hidden: true });

describe("posts, as rows and as joins", () => {
  it("P1 a null joined post is masked; a public one is named with its id, flags and AF status", () => {
    expect(postPublic(null)).toBe(false);
    expect(postPublic(undefined)).toBe(false);
    expect(maskPostRef(null)).toStrictEqual({ hidden: true });
    expect(maskPostRef(undefined)).toStrictEqual({ hidden: true });
    expect(postPublic(AGI_RUIN)).toBe(true);
    expect(maskPostRef(AGI_RUIN)).toStrictEqual({
      hidden: false, id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities",
      slug: "agi-ruin-a-list-of-lethalities", af: true, event: false, unlisted: false, question: false, shortform: false,
    });
  });

  it("P2 Q122 rejected posts are hidden", () => {
    expect(postPublic(REJECTED_POST)).toBe(false);
    expect(postListable(REJECTED_POST)).toBe(false);
    expect(maskPostRef(REJECTED_POST)).toStrictEqual({ hidden: true });
  });

  it("P3 D7 Q122 unlisted posts open by id and are named with their flag as joins, but are never list items", () => {
    expect(postPublic(UNLISTED_POST)).toBe(true);
    expect(postListable(UNLISTED_POST)).toBe(false);
    expect(maskPostRef(UNLISTED_POST)).toMatchObject({ hidden: false, id: "unlistedPost00001", unlisted: true });
  });

  it("P3 postListable keeps public posts and drops quick-takes containers", () => {
    expect(postListable(AGI_RUIN)).toBe(true);
    expect(postListable({ ...AGI_RUIN, shortform: true })).toBe(false);
    expect(postListable(null)).toBe(false);
  });

  it("D11 Q122 a joined event post is named with its event flag", () => {
    expect(maskPostRef({ ...AGI_RUIN, isEvent: true })).toMatchObject({ hidden: false, event: true });
  });
});

describe("comments, as rows and as joins", () => {
  it("P2 Q122 rejected comments are hidden; a null or missing join is never public", () => {
    expect(commentPublic({ ...COMMENT, rejected: true })).toBe(false);
    expect(commentPublic(null)).toBe(false);
    expect(commentPublic(undefined)).toBe(false);
    expect(commentPublic(COMMENT)).toBe(true);
  });

  it("P5 deletedPublic without deleted is an ordinary public comment, not a placeholder", () => {
    const notDeleted = { ...COMMENT, deleted: false, deletedPublic: true };
    expect(isPlaceholder(notDeleted)).toBe(false);
    expect(commentPublic(notDeleted)).toBe(true);
  });

  it("P5 D8 privately deleted comments are hidden; publicly deleted ones are placeholders without an author", () => {
    const privatelyDeleted = { ...COMMENT, deleted: true, deletedPublic: false };
    expect(commentPublic(privatelyDeleted)).toBe(false);

    const placeholder = { ...COMMENT, deleted: true, deletedPublic: true, deletedReason: "Requested account deletion" };
    expect(commentPublic(placeholder)).toBe(true);
    expect(isPlaceholder(placeholder)).toBe(true);
    expect(isPlaceholder(COMMENT)).toBe(false);
    const author = commentAuthor(placeholder);
    expect(author).toStrictEqual({ kind: "none", why: "comment placeholder" });
    expect(JSON.stringify(author)).not.toMatch(PERSON_RE);
  });

  it("P6 Q51 comments by unreviewed authors posted at or after 2023-04-04T18:54:35.895Z are hidden", () => {
    const atCutoff = { ...COMMENT, authorIsUnreviewed: true, postedAt: "2023-04-04T18:54:35.895Z" };
    const justBefore = { ...atCutoff, postedAt: "2023-04-04T18:54:35.894Z" };
    const later = { ...atCutoff, postedAt: "2024-01-01T00:00:00.000Z" };
    const reviewedLater = { ...later, authorIsUnreviewed: false };
    expect(commentPublic(atCutoff)).toBe(false);
    expect(commentPublic(later)).toBe(false);
    expect(commentPublic(justBefore)).toBe(true);
    expect(commentPublic(reviewedLater)).toBe(true);
  });

  it("P6 an unreviewed author's comment whose postedAt does not parse is hidden (fails closed, like the request lint)", () => {
    const undated = { ...COMMENT, authorIsUnreviewed: true, postedAt: "not a date" };
    expect(commentPublic(undated)).toBe(false);
    expect(commentPublic({ ...undated, authorIsUnreviewed: false })).toBe(true);
  });

  it("P7 Q116 the author of a hideAuthor comment is never shown, and the comment stays public", () => {
    const anonymous = { ...COMMENT, hideAuthor: true };
    expect(commentPublic(anonymous)).toBe(true);
    expect(isPlaceholder(anonymous)).toBe(false);
    const author = commentAuthor(anonymous);
    expect(author).toStrictEqual({ kind: "none", why: "author not publicly visible" });
    expect(JSON.stringify(author)).not.toMatch(PERSON_RE);
  });

  it("P8 Q118 a comment whose user is null reads account not publicly visible with no user id", () => {
    const deletedAccount = { ...COMMENT, user: null };
    expect(commentPublic(deletedAccount)).toBe(true);
    const author = commentAuthor(deletedAccount);
    expect(author).toStrictEqual({ kind: "none", why: "account not publicly visible" });
    expect(JSON.stringify(author)).not.toContain("samplePerson00001");
    expect(commentAuthor(COMMENT)).toStrictEqual(PERSON_NAMED);
  });
});

describe("people", () => {
  it("P7 Q116 the author of a hideAuthor post is never shown (no name, id or slug)", () => {
    const person = authorOf(PERSON, { hideAuthor: true });
    expect(person).toStrictEqual({ kind: "none", why: "author not publicly visible" });
    expect(JSON.stringify(person)).not.toMatch(PERSON_RE);
  });

  it("P8 Q118 a null user is account not publicly visible; deleted accounts are not public", () => {
    expect(authorOf(null, { hideAuthor: false })).toStrictEqual({ kind: "none", why: "account not publicly visible" });
    expect(userPublic({ deleted: true })).toBe(false);
    expect(userPublic(null)).toBe(false);
    expect(userPublic(undefined)).toBe(false);
    expect(userPublic({ deleted: false })).toBe(true);
  });

  it("P5 P7 P8 authorOf: placeholder first, then author not publicly visible, then account not publicly visible; otherwise the named user", () => {
    expect(authorOf(PERSON, { hideAuthor: false })).toStrictEqual(PERSON_NAMED);
    expect(authorOf(PERSON, { hideAuthor: true, placeholder: true })).toStrictEqual({ kind: "none", why: "comment placeholder" });
    expect(authorOf(null, { hideAuthor: false, placeholder: true })).toStrictEqual({ kind: "none", why: "comment placeholder" });
    expect(authorOf(null, { hideAuthor: true })).toStrictEqual({ kind: "none", why: "author not publicly visible" });
  });

  it("P19 only comments with a named author are attributable", () => {
    expect(attributable({ author: PERSON_NAMED })).toBe(true);
    for (const why of ["comment placeholder", "author not publicly visible", "account not publicly visible"] as const) {
      expect(attributable({ author: { kind: "none", why } })).toBe(false);
    }
  });
});

describe("sequences", () => {
  it("P4 D7 hidden sequences open by id and are named with their flag, but are never listed", () => {
    expect(sequencePublic(HIDDEN_SEQ)).toBe(true);
    expect(sequenceListable(HIDDEN_SEQ)).toBe(false);
    expect(maskSeqRef(HIDDEN_SEQ)).toStrictEqual({
      hidden: false, id: "hiddenSeq00000001", title: "A hidden sequence", af: false, hiddenFromLists: true,
    });
    expect(sequencePublic(PW)).toBe(true);
    expect(sequenceListable(PW)).toBe(true);
    expect(maskSeqRef(PW)).toStrictEqual({
      hidden: false, id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", af: false, hiddenFromLists: false,
    });
  });

  it("P4 a null sequence join (deleted or draft) is masked", () => {
    expect(sequencePublic(null)).toBe(false);
    expect(sequenceListable(undefined)).toBe(false);
    expect(maskSeqRef(null)).toStrictEqual({ hidden: true });
  });
});

describe("glossary and masking", () => {
  it("P15 glossary terms are public only when approved and not deleted", () => {
    const term = (approved: boolean, deleted: boolean): RawGlossaryTerm => ({
      _id: "glossaryTerm00001", term: "mesa-optimizer", approved, deleted, contents: { markdown: "A learned optimizer." },
    });
    expect(glossaryTermPublic(term(true, false))).toBe(true);
    expect(glossaryTermPublic(term(false, false))).toBe(false);
    expect(glossaryTermPublic(term(true, true))).toBe(false);
    expect(glossaryTermPublic(term(false, true))).toBe(false);
  });

  it("P14 masked references carry nothing but hidden: true; a hidden comment is never public, as a row or a join", () => {
    const masked = [maskPostRef(REJECTED_POST), maskPostRef(null), maskSeqRef(null)];
    for (const m of masked) expect(m).toStrictEqual({ hidden: true });
    expect(JSON.stringify(masked)).not.toMatch(/PLANTED|planted/);
    const hiddenComments = [
      {
        ...COMMENT, _id: "PLANTEDcomment001", rejected: true,
        user: rawUserRef({ _id: "PLANTEDuser000001", slug: "planted-p14-user", displayName: "PLANTED-P14-name" }),
      },
      { ...COMMENT, _id: "PLANTEDcomment001", deleted: true, deletedPublic: false },
    ];
    for (const c of hiddenComments) expect(commentPublic(c)).toBe(false);
  });
});
