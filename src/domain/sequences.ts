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

/**
 * ¶4.9, Q20: a collection's books in number order, which is trusted only when every book has a number and no two share
 * one (`Collection.books` has no tie-break, §11.5); otherwise the forum's order, flagged unreliable.
 */
export function bookOrder(books: readonly RawBook[]): { order: RawBook[]; reliable: boolean } {
  const numbers = books.map((b) => b.number);
  const reliable = numbers.every((n) => typeof n === "number") && new Set(numbers).size === numbers.length;
  const order = [...books];
  if (reliable) order.sort((a, b) => (a.number as number) - (b.number as number));
  return { order, reliable };
}

/**
 * ¶4.9, P4, P14: the ids of a collection's visible sequences, book by book in `bookOrder`. Within a book, `sequenceIds`
 * gives the order (it is used for nothing else); an id counts only when the book's `sequences` holds a listable entry
 * for it. Listable sequences the ids do not name follow, in the order of `sequences`.
 */
export function collectionSequenceOrder(c: RawCollection): { ids: string[]; reliable: boolean } {
  const { order, reliable } = bookOrder(c.books);
  const ids: string[] = [];
  for (const book of order) {
    const named = new Set(book.sequenceIds);
    for (const id of book.sequenceIds) {
      if (sequenceListable(book.sequences.find((s) => s._id === id))) ids.push(id);
    }
    for (const s of book.sequences) {
      if (!named.has(s._id) && sequenceListable(s)) ids.push(s._id);
    }
  }
  return { ids, reliable };
}

/**
 * ¶4.9, Q101: the sequence before or after `sequenceId` in its collection, across book boundaries. When the book order
 * is not reliable (bestoflesswrong) no neighbour can be named and the result says so. Otherwise `id` is absent at either
 * end of the collection and for a sequence the collection does not list (a hidden one included).
 */
export function adjacentSequence(c: RawCollection, sequenceId: string, dir: "prev" | "next"): { id?: string; reliable: boolean } {
  const { ids, reliable } = collectionSequenceOrder(c);
  if (!reliable) return { reliable: false };
  const i = ids.indexOf(sequenceId);
  const id = i === -1 ? undefined : ids[dir === "prev" ? i - 1 : i + 1];
  return id === undefined ? { reliable: true } : { id, reliable: true };
}
