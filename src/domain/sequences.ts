// Layer 3. Normalizes a sequence row into a `SequenceRecord` (¶3.8.1) and orders what the forum returns for the
// sequence pages (¶4.9): the reading order of a sequence's chapters, the neighbours of a post in it, and the order of a
// collection's books and sequences. `toSequenceRecord` takes a row that has already passed `sequencePublic` (P4) and
// keeps the `hidden` flag as `hiddenFromLists`. Titles stay as the forum gives them; the renderer cuts them. Pure:
// it never throws and never logs.
import { CONFIG } from "../config";
import type { RawBook, RawChapter, RawCollection, RawPostCard, RawPostRef, RawSeqCard, SequenceRecord } from "../types";
import { excerptOf } from "./posts";
import { authorOf, postPublic, sequenceListable } from "./visibility";

/**
 * ¶3.8.1, P8: the record of a sequence. A sequence without an owner reads `account not publicly visible`. The collection slug
 * is omitted when the forum sends none or an empty string (§11.1); the excerpt is at most 200 characters.
 */
export function toSequenceRecord(raw: RawSeqCard): SequenceRecord {
  const record: SequenceRecord = {
    id: raw._id,
    title: raw.title,
    author: authorOf(raw.user, { hideAuthor: false }),
    af: raw.af,
    hiddenFromLists: raw.hidden,
    createdAt: raw.createdAt,
    postsCount: raw.postsCount,
    curatedOrder: raw.curatedOrder,
  };
  const collectionSlug = raw.canonicalCollectionSlug?.trim();
  if (collectionSlug) record.collectionSlug = collectionSlug;
  const excerpt = excerptOf(raw.contents?.plaintextDescription, CONFIG.render.sequenceExcerptChars);
  if (excerpt !== undefined) record.excerpt = excerpt;
  return record;
}

/** One post of a sequence in reading order: where it sits among the chapters and in the whole list (1-based). */
export interface OrderedPost { post: RawPostRef & Partial<RawPostCard>; chapterIndex: number; chapterTitle?: string; position: number }

/**
 * ¶4.9, Q20: the posts of a sequence in reading order. The chapters arrive in the `SequenceChapters` view's order
 * (`number` ascending, nulls first, as the forum returns them) and stay in it; each chapter's `posts` keep their own
 * order. Hidden posts are dropped (P2); unlisted ones stay (P3). A chapter's posts come only from its `posts` (P14).
 */
export function readingOrder(chapters: readonly RawChapter[]): OrderedPost[] {
  const order: OrderedPost[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    for (const post of chapter.posts) {
      if (!postPublic(post)) continue;
      const entry: OrderedPost = { post, chapterIndex, position: order.length + 1 };
      const chapterTitle = chapter.title ?? undefined;
      if (chapterTitle !== undefined) entry.chapterTitle = chapterTitle;
      order.push(entry);
    }
  });
  return order;
}

/**
 * ¶4.9, Q101: where a post sits in the fetched order and the entries on either side of it; `undefined` when the
 * sequence does not hold it. Never taken from the forum's `nextPost` / `prevPost` (§11.4). A post listed twice is
 * placed at its first entry.
 */
export function neighbours(order: readonly OrderedPost[], postId: string): { index: number; prev?: OrderedPost; next?: OrderedPost } | undefined {
  const index = order.findIndex((o) => o.post._id === postId);
  if (index === -1) return undefined;
  const found: { index: number; prev?: OrderedPost; next?: OrderedPost } = { index };
  if (index > 0) found.prev = order[index - 1];
  if (index < order.length - 1) found.next = order[index + 1];
  return found;
}

/** Two books tie when the forum's sort can't tell them apart: the same number, or none for both. */
const sameNumber = (a: RawBook, b: RawBook): boolean => a.number === b.number;

/**
 * ¶4.9, Q20: a collection's books in the forum's order, as `Collection.books` and the site's next and previous links sort them
 * (`number` ascending, a nullable column, so unnumbered books first: the SQL is `ASC NULLS FIRST`), books that tie keeping the
 * order the forum returned them in. `reliable`: no two books tie, so the forum defines the whole order (§11.5: no tie-break).
 */
export function bookOrder(books: readonly RawBook[]): { order: RawBook[]; reliable: boolean } {
  const key = (b: RawBook): number => (typeof b.number === "number" ? b.number : -Infinity);
  const order = [...books].sort((a, b) => key(a) - key(b));
  const reliable = order.every((b, i) => i === 0 || !sameNumber(b, order[i - 1]!));
  return { order, reliable };
}

/**
 * ¶4.9, P4, P14: the ids of a collection's visible sequences, book by book in `bookOrder`. Within a book, `sequenceIds`
 * gives the order; an id counts only when the book's `sequences` holds a listable entry for it (`Book.sequences` loads one
 * row per `sequenceIds` entry and leaves out what a logged-out reader can't open, so it holds no other row).
 */
export function collectionSequenceOrder(c: RawCollection): { ids: string[]; reliable: boolean } {
  const { order, reliable } = bookOrder(c.books);
  const ids: string[] = [];
  for (const book of order) {
    for (const id of book.sequenceIds) {
      if (sequenceListable(book.sequences.find((s) => s._id === id))) ids.push(id);
    }
  }
  return { ids, reliable };
}

/**
 * ¶4.9, Q101: the sequence before or after `sequenceId` in its collection, as the site's next and previous links step
 * (`getSurroundingSequencePostIdTuples`): one entry along the books' `sequenceIds`, the books in `bookOrder`, whatever that entry
 * is (a hidden sequence, or an id the books hold no row for); the caller looks the entry up. A book that lists no sequence adds
 * nothing to that list, so only books that list some can tie. The step is undefined where the order of books that tie decides it
 * (§11.5): a sequence listed in two of them, whose first place is then undefined, and a step out of or into one. `id` is absent
 * at either end and for a sequence no book lists (the site's next link then goes to the collection's first post: not mirrored).
 */
export function adjacentSequence(c: RawCollection, sequenceId: string, dir: "prev" | "next"): { id?: string; reliable: boolean } {
  const books = bookOrder(c.books).order.filter((b) => b.sequenceIds.length > 0);
  const tied = (b: RawBook): boolean => books.some((other) => other !== b && sameNumber(other, b));
  const at = books.findIndex((b) => b.sequenceIds.includes(sequenceId));
  if (at === -1) return { reliable: true };
  const book = books[at]!;
  if (books.some((other) => other !== book && sameNumber(other, book) && other.sequenceIds.includes(sequenceId))) return { reliable: false };
  const step = dir === "prev" ? -1 : 1;
  const near = book.sequenceIds[book.sequenceIds.indexOf(sequenceId) + step];
  if (near !== undefined) return { id: near, reliable: true };
  if (tied(book)) return { reliable: false };
  const beyond = books[at + step];
  if (beyond === undefined) return { reliable: true };
  if (tied(beyond)) return { reliable: false };
  return { id: dir === "prev" ? beyond.sequenceIds.at(-1)! : beyond.sequenceIds[0]!, reliable: true };
}
