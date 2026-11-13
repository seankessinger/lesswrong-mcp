import { describe, expect, it } from "vitest";
import { bookSequenceRow, crossText, DIR_WORD, UNORDERED } from "../../src/tools/loaders";
import type { RawBook, RawCollection } from "../../src/types";
import { rawPostRef, rawSeqRef } from "../support/builders";

// The neighbour wording get_post (¶4.3 steps 4-5) and get_sequence (¶4.9 Position) share: one definition, so that the two tools
// cannot print the adjacency sentence differently.
const book = (id: string, sequences: [string, string][]): RawBook => ({
  _id: id, title: id, number: 1, postedAt: "2018-12-01T00:00:00.000Z",
  sequenceIds: sequences.map(([s]) => s), sequences: sequences.map(([s, title]) => rawSeqRef({ _id: s, title })),
});
const collection = (books: RawBook[]): RawCollection => ({ _id: "oneQyj4pw77ynzwAF", slug: "rationality", title: "Rationality: A-Z", books });
/** The adjacent sequence as crossText reads it: its title and whether it is hidden from lists. */
const seqOf = (title: string | null, hidden = false) => ({ title, hidden });

describe("loaders: the neighbour wording shared by get_post and get_sequence", () => {
  it("crossText puts the spec phrase inside the post reference's parentheses, after its flags", () => {
    const first = rawPostRef({ _id: "fbFirstPost000001", title: "Making Beliefs Pay Rent (in Anticipated Experiences)", af: false });
    expect(crossText(first, "next", "rationality", seqOf("Fake Beliefs")))
      .toBe('"Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    const last = rawPostRef({ _id: "pwLastPost0000001", title: "The Last Post", af: true, unlisted: true });
    expect(crossText(last, "prev", "codex", seqOf("Predictably Wrong")))
      .toBe('"The Last Post" (post_id pwLastPost0000001, AF, reachable by link only, in the previous sequence of codex: "Predictably Wrong")');
  });

  it("crossText prints the slug and the sequence title on one line, the title cut at the 300-character cap, a missing title as empty quotes", () => {
    const post = rawPostRef({ _id: "fbFirstPost000001", title: "T", af: false });
    expect(crossText(post, "next", "ration\nality", seqOf("Fake\nBeliefs"))).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of ration ality: "Fake Beliefs")');
    expect(crossText(post, "next", "rationality", seqOf(null))).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "")');
    const long = crossText(post, "next", "rationality", seqOf("x".repeat(400)));
    expect(long).toBe(`"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "${"x".repeat(299)}…")`);
  });

  it("crossText leaves a post that is not publicly visible as its plain reference, with no note and nothing of the post", () => {
    const hidden = crossText(rawPostRef({ _id: "rejectedPost00001", title: "Secret", rejected: true }), "next", "rationality", seqOf("Fake Beliefs", true));
    expect(hidden).toBe("a post that is not publicly visible");
  });

  it("crossText flags a hidden adjacent sequence after its title", () => {
    const post = rawPostRef({ _id: "HidPostFirst00001", title: "Hidden First", af: false });
    expect(crossText(post, "next", "rationality", seqOf("Off the Lists", true)))
      .toBe(`"Hidden First" (post_id HidPostFirst00001, LW only, in the next sequence of rationality: "Off the Lists", not in the site's sequence lists)`);
  });

  it("bookSequenceRow finds a sequence's row in any book of the collection, and nothing for an id no book holds a row for", () => {
    const c = collection([book("b1", [["seqOne000000000001", "One"]]), book("b2", [["seqTwo000000000002", "Two"], ["seqThree0000000003", "Three"]])]);
    expect(bookSequenceRow(c, "seqOne000000000001")?.title).toBe("One");
    expect(bookSequenceRow(c, "seqThree0000000003")).toEqual(rawSeqRef({ _id: "seqThree0000000003", title: "Three" }));
    expect(bookSequenceRow(c, "seqNone0000000000")).toBeUndefined();
  });

  it("the direction words and the unordered tail are the spec's", () => {
    expect(DIR_WORD).toEqual({ prev: "previous", next: "next" });
    expect(UNORDERED).toBe("can't be determined reliably (the forum defines no order among books that share a number or have none)");
  });
});
