import { describe, expect, it } from "vitest";
import { adjacentSequence, bookOrder, collectionSequenceOrder, neighbours, readingOrder } from "../../src/domain/sequences";
import type { RawBook, RawChapter, RawCollection, RawPostRef, RawSeqRef } from "../../src/types";
import { rawPostRef, rawSeqRef } from "../support/builders";

const post = (id: string, o: Partial<RawPostRef> = {}) => rawPostRef({ _id: id, title: `Post ${id}`, slug: `post-${id.toLowerCase()}`, af: false, ...o });
const PA = post("postA000000000001"), PB = post("postB000000000001", { rejected: true });
const PC = post("postC000000000001", { unlisted: true }), PD = post("postD000000000001");
const CHAPTERS: RawChapter[] = [
  { _id: "chap0000000000001", title: null, number: null, posts: [PA, PB] },
  Object.assign({ _id: "chap0000000000002", title: "Part One", number: 1, posts: [PC, PD] }, { postIds: ["hiddenPost0000001"] }),
];
const seq = (id: string, hidden = false): RawSeqRef => rawSeqRef({ _id: id, title: `Sequence ${id}`, af: false, hidden });
const PW = seq("5g5TkQTe9rmPS5vvM"), S2 = seq("seqB0000000000002"), SH = seq("seqH0000000000003", true), S3 = seq("seqC0000000000004");
const book = (id: string, number: number | null, sequenceIds: string[], sequences: RawSeqRef[]): RawBook =>
  ({ _id: id, title: `Book ${id} `, number, postedAt: "2017-01-01T00:00:00.000Z", sequenceIds, sequences });
const B1 = book("book0000000000001", 1, [PW._id, SH._id, S2._id], [S2, SH, PW]);
const B2 = book("book0000000000002", 2, [S3._id], [S3]);
const RATIONALITY: RawCollection = { _id: "oneQyj4pw77ynzwAF", slug: "rationality", title: "Rationality: A-Z", books: [B2, B1] };
const BEST: RawCollection = {
  _id: "nmk3nLpQE89dMRzzN", slug: "bestoflesswrong", title: "Best of LessWrong",
  books: [book("book0000000000003", null, [S2._id], [S2]), book("book0000000000004", 1, [S3._id], [S3])],
};

describe("reading order (¶4.9, §11.2)", () => {
  it("Q20 Q62 P2 P3 the view's chapter order is kept (null numbers first); hidden posts dropped, unlisted kept", () => {
    expect(readingOrder(CHAPTERS).map((o) => [o.post._id, o.chapterIndex, o.chapterTitle, o.position])).toEqual([
      ["postA000000000001", 0, undefined, 1], ["postC000000000001", 1, "Part One", 2], ["postD000000000001", 1, "Part One", 3],
    ]);
  });

  it("P14 a hidden chapter post leaves no id", () => {
    expect(readingOrder(CHAPTERS).some((o) => o.post._id === "hiddenPost0000001")).toBe(false);
  });

  it("Q101 neighbours come from the fetched order; a post not in the sequence has none", () => {
    const order = readingOrder(CHAPTERS);
    expect(neighbours(order, "postC000000000001")).toEqual({ index: 1, prev: order[0], next: order[2] });
    expect(neighbours(order, "postA000000000001")).toEqual({ index: 0, next: order[1] });
    expect(neighbours(order, "postD000000000001")).toEqual({ index: 2, prev: order[1] });
    expect(neighbours(order, "postB000000000001")).toBeUndefined();
    expect(neighbours(order, "uMQ3cqWDPHhjtiesc")).toBeUndefined();
  });

  it("Q20 the order is never re-sorted by chapter number, and chapterIndex counts chapters that kept no post", () => {
    const chapters: RawChapter[] = [
      { _id: "chap0000000000003", title: "Later", number: 9, posts: [PD] },
      { _id: "chap0000000000004", title: "Empty", number: 1, posts: [PB] },
      { _id: "chap0000000000005", number: null, posts: [PA] },
    ];
    expect(readingOrder(chapters).map((o) => [o.post._id, o.chapterIndex, o.chapterTitle, o.position])).toEqual([
      ["postD000000000001", 0, "Later", 1], ["postA000000000001", 2, undefined, 2],
    ]);
    expect(readingOrder([])).toEqual([]);
  });

  it("P2 an entry holds the forum's post object, and names a chapter title only when the forum gave one", () => {
    const [first, second] = readingOrder([
      { _id: "chap0000000000006", number: null, posts: [PA] },
      { _id: "chap0000000000007", title: null, number: null, posts: [PD] },
    ]);
    expect(first).toStrictEqual({ post: PA, chapterIndex: 0, position: 1 });
    expect(first.post).toBe(PA);
    expect(second).toStrictEqual({ post: PD, chapterIndex: 1, position: 2 });
  });

  it("Q101 a post listed twice is positioned by its first place", () => {
    const order = readingOrder([
      { _id: "chap0000000000008", number: null, posts: [PA, PD] },
      { _id: "chap0000000000009", number: 1, posts: [PA] },
    ]);
    expect(order.map((o) => o.position)).toEqual([1, 2, 3]);
    expect(neighbours(order, "postA000000000001")).toEqual({ index: 0, next: order[1] });
  });
});

describe("collections (§11.5)", () => {
  it("Q20 books are in number order only when every book has a distinct number", () => {
    expect(bookOrder(RATIONALITY.books)).toEqual({ order: [B1, B2], reliable: true });
    expect(bookOrder(BEST.books)).toEqual({ order: BEST.books, reliable: false });
    const twins = [book("book0000000000005", 1, [], []), book("book0000000000006", 1, [], [])];
    expect(bookOrder(twins)).toEqual({ order: twins, reliable: false });
  });

  it("Q20 book numbers sort as numbers and the forum's array is not reordered in place", () => {
    const ten = book("book0000000000007", 10, [], []), two = book("book0000000000008", 2, [], []), one = book("book0000000000009", 1, [], []);
    const given = [ten, two, one];
    expect(bookOrder(given)).toEqual({ order: [one, two, ten], reliable: true });
    expect(given).toEqual([ten, two, one]);
    expect(bookOrder([ten])).toEqual({ order: [ten], reliable: true });
  });

  it("P4 P14 sequences follow the book's order; hidden ones are dropped", () => {
    expect(collectionSequenceOrder(RATIONALITY)).toEqual({ ids: ["5g5TkQTe9rmPS5vvM", "seqB0000000000002", "seqC0000000000004"], reliable: true });
    expect(collectionSequenceOrder(BEST)).toEqual({ ids: ["seqB0000000000002", "seqC0000000000004"], reliable: false });
  });

  it("P4 a listed sequence that sequenceIds does not name follows the named ones; an id without a sequence, and a hidden extra, are dropped", () => {
    const extra = seq("seqE0000000000005"), hiddenExtra = seq("seqF0000000000006", true);
    const c: RawCollection = {
      _id: "ywQvGBSojSQZTMpLh", slug: "hpmor", title: "HPMOR",
      books: [book("book0000000000010", 1, ["seqMissing0000007", S3._id, PW._id], [extra, PW, hiddenExtra, S3])],
    };
    expect(collectionSequenceOrder(c)).toEqual({ ids: ["seqC0000000000004", "5g5TkQTe9rmPS5vvM", "seqE0000000000005"], reliable: true });
  });

  it("Q101 the adjacent sequence crosses book boundaries; none at the ends, for hidden sequences, or in bestoflesswrong", () => {
    expect(adjacentSequence(RATIONALITY, "seqB0000000000002", "next")).toEqual({ id: "seqC0000000000004", reliable: true });
    expect(adjacentSequence(RATIONALITY, "seqC0000000000004", "prev")).toEqual({ id: "seqB0000000000002", reliable: true });
    expect(adjacentSequence(RATIONALITY, "5g5TkQTe9rmPS5vvM", "prev")).toEqual({ reliable: true });
    expect(adjacentSequence(RATIONALITY, "seqC0000000000004", "next")).toEqual({ reliable: true });
    expect(adjacentSequence(RATIONALITY, "seqH0000000000003", "next")).toEqual({ reliable: true });
    expect(adjacentSequence(BEST, "seqB0000000000002", "next")).toEqual({ reliable: false });
  });

  it("Q101 a result without a neighbour has no id key at all", () => {
    expect(adjacentSequence(RATIONALITY, "5g5TkQTe9rmPS5vvM", "prev")).toStrictEqual({ reliable: true });
    expect(adjacentSequence(RATIONALITY, "seqH0000000000003", "prev")).toStrictEqual({ reliable: true });
    expect(adjacentSequence(RATIONALITY, "unknownSequence001", "next")).toStrictEqual({ reliable: true });
    expect(adjacentSequence(BEST, "seqC0000000000004", "prev")).toStrictEqual({ reliable: false });
    expect(adjacentSequence(RATIONALITY, "seqB0000000000002", "next")).toStrictEqual({ id: "seqC0000000000004", reliable: true });
  });
});
