import { describe, expect, it } from "vitest";
import { bookSequenceTitle, crossText, DIR_WORD, UNORDERED } from "../../src/tools/loaders";
import type { RawBook, RawCollection } from "../../src/types";
import { rawPostRef, rawSeqRef } from "../support/builders";

// The neighbour wording get_post (¶4.3 steps 4-5) and get_sequence (¶4.9 Position) share: one definition, so that the two tools
// cannot print the adjacency sentence differently.
const book = (id: string, sequences: [string, string][]): RawBook => ({
  _id: id, title: id, number: 1, postedAt: "2018-12-01T00:00:00.000Z",
  sequenceIds: sequences.map(([s]) => s), sequences: sequences.map(([s, title]) => rawSeqRef({ _id: s, title })),
});
const collection = (books: RawBook[]): RawCollection => ({ _id: "oneQyj4pw77ynzwAF", slug: "rationality", title: "Rationality: A-Z", books });

describe("loaders: the neighbour wording shared by get_post and get_sequence", () => {
  it("crossText puts the spec phrase inside the post reference's parentheses, after its flags", () => {
    const first = rawPostRef({ _id: "fbFirstPost000001", title: "Making Beliefs Pay Rent (in Anticipated Experiences)", af: false });
    expect(crossText(first, "next", "rationality", "Fake Beliefs"))
      .toBe('"Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    const last = rawPostRef({ _id: "pwLastPost0000001", title: "The Last Post", af: true, unlisted: true });
    expect(crossText(last, "prev", "codex", "Predictably Wrong"))
      .toBe('"The Last Post" (post_id pwLastPost0000001, AF, reachable by link only, in the previous sequence of codex: "Predictably Wrong")');
  });

  it("crossText prints the slug and the sequence title on one line, the title cut at the 300-character cap, a missing title as empty quotes", () => {
    const post = rawPostRef({ _id: "fbFirstPost000001", title: "T", af: false });
    expect(crossText(post, "next", "ration\nality", "Fake\nBeliefs")).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of ration ality: "Fake Beliefs")');
    expect(crossText(post, "next", "rationality", null)).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "")');
    const long = crossText(post, "next", "rationality", "x".repeat(400));
    expect(long).toBe(`"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "${"x".repeat(299)}…")`);
  });

  it("crossText leaves a post that is not publicly visible as its plain reference, with no note and nothing of the post", () => {
    const hidden = crossText(rawPostRef({ _id: "rejectedPost00001", title: "Secret", rejected: true }), "next", "rationality", "Fake Beliefs");
    expect(hidden).toBe("a post that is not publicly visible");
  });

  it("bookSequenceTitle finds a sequence in any book of the collection, and gives null for one the collection does not list", () => {
    const c = collection([book("b1", [["seqOne000000000001", "One"]]), book("b2", [["seqTwo000000000002", "Two"], ["seqThree0000000003", "Three"]])]);
    expect(bookSequenceTitle(c, "seqOne000000000001")).toBe("One");
    expect(bookSequenceTitle(c, "seqThree0000000003")).toBe("Three");
    expect(bookSequenceTitle(c, "seqNone0000000000")).toBeNull();
  });

  it("the direction words and the unordered tail are the spec's", () => {
    expect(DIR_WORD).toEqual({ prev: "previous", next: "next" });
    expect(UNORDERED).toBe("can't be determined reliably (the forum defines no order for its unnumbered books)");
  });
});
