// Layer 2. The `get_sequence` tool (¶4.9): a sequence's posts in reading order, a collection's books and their sequences, and a
// post's position with its neighbours. A collection is one request (its id is hard-coded, §11.5); its books are in number order
// only when every book has a distinct number, its sequences follow the book's order (P14), and hidden ones are dropped
// (P4). A sequence takes up to three requests. Request 1 reads the sequence, with the post given as `post` and that post's
// canonical sequence, through the resolution aliases of ¶3.1.2 (`ids/resolve` reads them, so the outcomes, error wording, eviction
// and negative cache are resolve's); a continuation whose sequence is cached with its description skips it. Request 2, for the
// confirmed sequence only (P17), reads the chapters in the view's order, the site's stats and, with `post`, the collections
// listing. Request 3 reads the chapters of the adjacent sequence to name the neighbour of a post at the end of its sequence, and
// is sent only while a request may start (¶2.2 step 5). The posts are a `list` stream over the ordered posts, each chapter or
// book header repeated where a page starts mid-chapter or mid-book. A marked post starts the first page at its chapter and puts
// its position and neighbours in the `Position:` line; a page that stopped before request 3 is shown again by its cursor. The
// description of a sequence or collection is fenced in the head of the first page, within a quarter of the budget: a longer one is
// cut and says so, so that the posts stay on page 1.
// Once the sequence is confirmed, a failure of its chapters is the call's error, while the stats, the listing and the neighbour
// request each fail into a `Partial:` line (¶3.9); a deadline or cap stop is not an error.
import { z } from "zod";
import { CONFIG } from "../config";
import { toPostRecord } from "../domain/posts";
import {
  adjacentSequence, bookOrder, collectionSequenceOrder, neighbours, readingOrder, toSequenceRecord, type OrderedPost,
} from "../domain/sequences";
import { sequenceUrl } from "../domain/urls";
import { maskPostRef, maskSeqRef, sequencePublic } from "../domain/visibility";
import { badInput, CallStopped, internalError, isToolError, ToolError } from "../errors";
import { collectionOp, getSequenceRequest1Ops, getSequenceRequest2Ops } from "../forum/templates/get_sequence";
import { sequenceChaptersOp } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { cachedResolution, echoOf, negativeKey, readResolution, resolve } from "../ids/resolve";
import { fingerprint, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { Budget, estimateTokens, sliceText } from "../render/budget";
import { fence, renderPage } from "../render/layout";
import { CAVEAT, CUT_IN_CODE, emptyText, FLAG, fmtInt, partialLine } from "../render/messages";
import { personText, postLine, postRefText, seqRefText, sequenceLine } from "../render/records";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResult, AliasResults, CallContext, CollectionSlug, Consumed, CursorEntry, Footer, PageItem, PageSpec, ParsedRef, PublicSequenceId,
  RawBook, RawChapter, RawCollection, RawPostCard, RawSeqCard, RawSeqRef, Resolved, SequenceRecord, Services, StreamState, ToolDef,
  ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, rowsOf, setting } from "./common";
import { aliasData, bookSequenceTitle, collectionsCached, crossText, DIR_WORD, loadCollectionsListing, UNORDERED, type Dir } from "./loaders";

type GetSequenceParams = { sequence?: string; post?: string; af_only: boolean; limit: number; cursor?: string; max_tokens: number };

type ListState = Extract<StreamState, { kind: "list" }>;

const TITLE = "What is in this sequence or collection, in order?";
/** ¶4.9, verbatim. */
const DESCRIPTION_QUOTE =
  "A sequence (an ordered series of posts) or one of the site's 5 collections: rationality (Rationality: A-Z, \"The Sequences\"), codex, hpmor, highlights, bestoflesswrong. sequence = id, URL (/s/<id>, /s/<id>/p/<post>), or a collection slug or URL; sequences have no slugs. For a sequence: title, ids, author, AF status, curated rank, description, the site's word count and reading time (~), and its posts chapter by chapter in the order of the forum's chapter list (the sequence page's own order can differ when chapters are unnumbered), each with ids, title, author, date and karma; limit counts posts. post=<post> (or a /s/<id>/p/<post> URL; giving both with different posts is an error) marks that post: the first page then starts at the chapter containing it and always shows its position with the previous and next posts (call without post to read from the start). At the first or last post of a sequence that belongs to a collection whose books are all numbered, the neighbour is the last or first post of the adjacent sequence in the collection's book order; for bestoflesswrong, whose books are partly unnumbered, the adjacent sequence can't be determined reliably and none is given. If the post is not in this sequence you are told so: a post can be in several sequences, and get_post names only the site's canonical one. For a collection: its description and its books, each with its sequences (open each with get_sequence); limit counts sequences. Books are in number order; where the forum leaves books unnumbered they are listed in the forum's order, which it does not define. af_only keeps only AF posts (or, for a collection, AF sequences), in the same order. Posts that are not publicly visible are left out, as on the site; posts the sequence includes that are reachable by link only are shown, flagged; sequences that are not in the site's sequence lists open by id and are flagged.";

const SEQUENCE_TASK = "reading the sequence";
const CHAPTERS_TASK = "reading the sequence's posts";
const COLLECTION_TASK = "reading the collection";
const NEIGHBOUR_TASK = "reading the neighbouring sequence";
/** The `Partial:` section of each part that can fail without losing the posts. */
const SECTION = { stats: "site word count and reading time", neighbour: "neighbouring sequence" } as const;

const TITLE_CAP = CONFIG.render.caps.title;
const NAME_CAP = CONFIG.render.caps.name;
const SEP = " · ";
const LESSWRONG = "https://www.lesswrong.com";
/** ¶4.9: the note on a collection whose books are not all numbered, which are listed in the order the forum returned them. */
const UNNUMBERED_NOTE = "Books are listed in the order the forum returned them; the forum defines no order for unnumbered books.";
/** Request 3's alias for the sequence before (`ach_prev`) or after (`ach_next`) this one. */
const NEIGHBOUR_ALIAS: Readonly<Record<Dir, string>> = { prev: "ach_prev", next: "ach_next" };
/** What request 3 reads of a neighbouring sequence: enough to order its posts and name the first or last. */
const NEIGHBOUR_FIELDS = "_id number posts { ...POST_REF postedAt }";

const titleText = (s: string | null | undefined): string => `"${oneLine(s, TITLE_CAP)}"`;
/** A whole count with its noun: `1 chapter`, `3 chapters`. */
const counted = (n: number, one: string): string => `${fmtInt(n)} ${n === 1 ? one : `${one}s`}`;
/** A date's epoch milliseconds for the drift fingerprint; 0 for a missing or unreadable one, so the fingerprint stays comparable. */
function timeOf(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

// what was asked

/** The parameters that shape a page, stored in its cursor. */
interface Ask { afOnly: boolean; limit: number }

/**
 * ¶3.6: the effective values a cursor compares; every parameter but `cursor` and `max_tokens` is an own key. `subject` is a
 * sequence's id or a collection's slug (a sequence needs no resolution to be compared: it has only ids), `post` the id of the
 * marked post.
 */
function effectiveOf(subject: string, postId: string | undefined, ask: Ask): Record<string, unknown> {
  return { sequence: subject, post: postId, af_only: ask.afOnly, limit: ask.limit };
}

/** ¶3.7 request echo: the identifiers as resolved, `af_only` when given, `limit` always. */
function requestEcho(identifiers: readonly string[], ask: Ask, echo: CallContext): string[] {
  return [...identifiers, ...(ask.afOnly ? ["af_only true"] : []), setting(echo, "limit", ask.limit)];
}

/** One reply with one nonce: the fence of the description and the page's own use it (¶3.7). */
function render(build: (nonce: string) => PageSpec, maxTokens: number, svc: Services, footerFor: (c: Consumed) => Footer): ToolOutput {
  const nonce = svc.nonce();
  return { text: renderPage(build(nonce), maxTokens, nonce, footerFor).text, isError: false };
}

/**
 * The share of a page's budget the description may take. It is a head line, which a page always keeps, so a longer one would push
 * the posts to page 2 (and the budget guard would cut it wherever it fell, possibly inside the fence): it is cut here instead,
 * as a capped block is (¶3.7), at the share the outline gets.
 */
const DESCRIPTION_SHARE = CONFIG.render.shares.outline;

/**
 * The line after a cut description. The cursor continues the posts, not the text (the description is on the first page only,
 * ¶4.9), so this points at the one thing that shows more of it.
 */
function descriptionCut(words: number, inCode: boolean): string {
  return `[… description cut: about ${fmtInt(words)} more words; a larger max_tokens shows more]${inCode ? ` ${CUT_IN_CODE}` : ""}`;
}

/**
 * The description of a sequence or collection, fenced as forum text; nothing when it has none. The fenced block (and the line that
 * says it is cut) takes at most `DESCRIPTION_SHARE` of the page's budget: a longer text is cut at a paragraph or sentence end
 * (`sliceText`) and followed by `descriptionCut`, outside the fence.
 */
function descriptionBlock(label: string, markdown: string | null | undefined, nonce: string, maxTokens: number): string[] {
  if (markdown == null || markdown.trim() === "") return [];
  const text = blockText(markdown);
  const room = new Budget(maxTokens).share(DESCRIPTION_SHARE) - estimateTokens(fence(label, "", nonce));
  if (sliceText(text, Math.max(0, room)).next === undefined) return [fence(label, text, nonce)];
  // The marker is charged before the cut is found (its widest form, and the joining newlines of both lines).
  const cut = sliceText(text, Math.max(0, room - estimateTokens(descriptionCut(9_999_999, true)) - 1));
  return [fence(label, cut.text, nonce), descriptionCut(cut.moreWords, cut.inCode)];
}

/** A cursor that continues `x` at the `list` state `state`; `data` (ids and flags only, never forum text) rides along when given. */
function cursorFor(svc: Services, x: { args: Record<string, unknown>; effective: Record<string, unknown> }, state: ListState, data?: Record<string, unknown>): string {
  return mint(svc, "get_sequence", x.args, x.effective, { streams: [state], current: 0, ...(data !== undefined && { data }) });
}

// a collection

/** One sequence of a collection, with the book it is in. */
interface CollectionItem { book: RawBook; card: RawSeqCard }

/** `Book 2 · "How to Actually Change Your Mind"`, `Book · "…"` for an unnumbered book; titles are trimmed (§11.5). */
function bookHeader(book: RawBook): string {
  const title = oneLine(book.title, TITLE_CAP);
  const head = typeof book.number === "number" ? `Book ${fmtInt(book.number)}` : "Book";
  return title === "" ? head : `${head}${SEP}"${title}"`;
}

/** The collection of `slug` with its books: one request, an alias error is the call's error. */
async function readCollection(slug: CollectionSlug, ctx: CallContext, svc: Services): Promise<RawCollection> {
  const data = aliasData(await svc.gql([collectionOp(CONFIG.collections[slug])], ctx, COLLECTION_TASK), "c", COLLECTION_TASK, ctx);
  const result = isRecord(data) ? data.result : undefined;
  if (!isRecord(result)) throw internalError(ctx.tool, `get_sequence_collection: no document for ${slug}`);
  const books = (Array.isArray(result.books) ? result.books : []).filter(isRecord).map((b) => ({
    ...b,
    sequenceIds: Array.isArray(b.sequenceIds) ? b.sequenceIds : [],
    sequences: (Array.isArray(b.sequences) ? b.sequences : []).filter(isRecord),
  }));
  return { ...result, books } as unknown as RawCollection;
}

/**
 * P4, P14: the listable sequences of each book in `bookOrder`, each in `sequenceIds` order (`collectionSequenceOrder` per book, so
 * that no ordering rule is written twice), and whether the books' order is the forum's own.
 */
function collectionItems(c: RawCollection): { items: CollectionItem[]; reliable: boolean } {
  const { order, reliable } = bookOrder(c.books);
  const items = order.flatMap((book) =>
    collectionSequenceOrder({ ...c, books: [book] }).ids.flatMap((id) => {
      const card = book.sequences.find((s) => s._id === id);
      return card === undefined ? [] : [{ book, card: card as RawSeqCard }];
    }),
  );
  return { items, reliable };
}

interface CollectionPageInput {
  collection: RawCollection;
  slug: CollectionSlug;
  resolved: Resolved;
  ask: Ask;
  state?: ListState;
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

function collectionPage(x: CollectionPageInput, maxTokens: number, svc: Services): ToolOutput {
  const { collection, slug, ask, state } = x;
  const all = collectionItems(collection);
  const kept = ask.afOnly ? all.items.filter((i) => i.card.af) : all.items;
  const removed = all.items.length - kept.length;
  const idOf = (i: CollectionItem): string => i.card._id;
  const when = (i: CollectionItem): number => timeOf(i.card.createdAt);
  const page = listPage(kept, state, ask.limit, idOf, when);
  const first = state === undefined;
  const shown0 = state?.shown ?? 0;
  const first0: ListState = state ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(kept, when) };
  const count = page.items.length;
  const title = oneLine(collection.title, TITLE_CAP);

  const items: PageItem[] = page.items.map((item, j) => {
    const previous = page.items[j - 1];
    const line = sequenceLine(toSequenceRecord(item.card));
    return { text: previous === undefined || previous.book._id !== item.book._id ? `${bookHeader(item.book)}\n${line}` : line };
  });
  const header = `Collection "${title}"${SEP}collection_slug ${slug}${SEP}${LESSWRONG}/${slug}`;
  const removedLine = ask.afOnly ? `af_only removed ${counted(removed, "sequence")} not on the Alignment Forum` : undefined;
  const empty = count === 0 && first
    ? emptyText({ kind: "filtered", items: "sequences", filters: `in collection "${title}"${ask.afOnly ? ", AF only" : ""}` })
    : undefined;
  const notes = [
    ...(all.reliable ? [] : [UNNUMBERED_NOTE]),
    ...(count > 0 ? [CAVEAT["C-COUNTER"]] : []),
    ...(page.driftNote === undefined ? [] : [page.driftNote]),
  ];
  const position = count === 0
    ? undefined
    : (c: Consumed): string => positionText("sequences", shown0 + 1, shown0 + Math.max(1, Math.min(c.items, count)), kept.length);

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, count);
    if (n === count && page.ended) return { kind: "end" };
    const cursor = cursorFor(svc, x, n === 0 ? first0 : page.after[n - 1]! as ListState);
    return { kind: "more", tool: "get_sequence", cursor, next: nextText("sequences", shown0 + n + 1, Math.min(shown0 + n + ask.limit, kept.length)) };
  };
  return render(
    (nonce) => ({
      tool: "get_sequence", subject: `collection "${title}"`, request: requestEcho([echoOf("sequence", x.resolved)], ask, x.echo),
      ...(position !== undefined && { position }), oneItem: shown0 === 0 && count === 1 && page.ended, notes,
      head: [
        header, ...(removedLine === undefined ? [] : [removedLine]),
        ...(first ? descriptionBlock("collection description", collection.contents?.markdown, nonce, maxTokens) : []),
        ...(empty === undefined ? [] : [empty]),
      ],
      items,
    }),
    maxTokens, svc, footerFor,
  );
}

// request 1: the sequence and the marked post

/** The marked post as request 1 resolved it. */
interface MarkedPost {
  resolved: Resolved;
  /** The post's canonical sequence as request 1 joined it, null when it has none. */
  canonical: RawSeqRef | null;
}

/** What request 1 opened (or the cache gave): the sequence, confirmed public (P17), and the marked post when one was given. */
interface Opened {
  resolved: Resolved;
  doc: RawSeqCard;
  id: PublicSequenceId;
  post?: MarkedPost;
}

/** The answers of request 1 that belong to the post, under the aliases `ids/resolve` reads a post by (`p`, `s`, `l`). */
function postAnswers(results: AliasResults): AliasResults {
  const answers = new Map<string, AliasResult>();
  for (const [from, to] of [["p", "p"], ["ps", "s"], ["pl", "l"]] as const) {
    const answer = results.get(from);
    if (answer !== undefined) answers.set(to, answer);
  }
  return answers;
}

/** Whether a cached resolution holds the sequence as request 1 selects it, with its description. */
function hasDescription(doc: unknown): boolean {
  return isRecord(doc) && isRecord(doc.contents) && typeof doc.contents.markdown === "string";
}

/**
 * ¶4.9 request 1 (and its skip): the sequence through its resolution alias, with `post` when one is given. A remembered
 * `not_found` or `not_public` costs no request, and so does a sequence cached with its description when no post is to be checked.
 * Unknown → `not_found`, refused → `not_public` (resolve's wording, eviction and negative cache), a post by the usual rules for a
 * post parameter (P1–P3).
 */
async function openSequence(ref: ParsedRef, postRef: ParsedRef | undefined, ctx: CallContext, svc: Services): Promise<Opened> {
  const open = (resolved: Resolved, post?: MarkedPost): Opened => ({
    resolved, doc: resolved.doc as RawSeqCard, id: ctx.confirmPublic("sequence", resolved.id), ...(post !== undefined && { post }),
  });
  const negative = svc.caches.get<{ category: ToolError["category"]; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  if (postRef === undefined) {
    const cached = cachedResolution(ref, ctx, svc);
    if (cached !== undefined && hasDescription(cached.doc)) return open(cached);
  }
  const results = await svc.gql(getSequenceRequest1Ops(ref.value, postRef), ctx, SEQUENCE_TASK);
  const resolved = readResolution(ref, "sequence", "", results, ctx, svc);
  if (postRef === undefined) return open(resolved);
  const post = readResolution(postRef, "post", "", postAnswers(results), ctx, svc);
  const canonical = isRecord(post.doc) && isRecord(post.doc.canonicalSequence) ? (post.doc.canonicalSequence as unknown as RawSeqRef) : null;
  return open(resolved, { resolved: post, canonical });
}

/** ¶4.9: `post` and the post part of a sequence URL name different posts. */
function postConflict(post: string, postPart: string): ToolError {
  return badInput("post", `"${oneLine(post, 100)}" differs from the post in the sequence URL ("${postPart}")`, "Give one of them.");
}

/**
 * The post to mark: `post`, else the post part of the sequence URL. Both given and both ids, but not the same: `bad_input` before
 * any request. A slug or LW1 id is compared by the id it resolves to, once request 1 has answered (`checkMarked`).
 */
function postRefOf(post: string | undefined, ref: ParsedRef): ParsedRef | undefined {
  if (post === undefined) return ref.postPart === undefined ? undefined : parseRef("post", ref.postPart, ["post"]);
  const given = parseRef("post", post, ["post"]);
  if (ref.postPart !== undefined && (given.form === "id" || given.form === "idOrSlug") && given.value !== ref.postPart) {
    throw postConflict(post, ref.postPart);
  }
  return given;
}

/** The late half of the conflict check: the post `post` resolved to is not the URL's. */
function checkMarked(post: string | undefined, ref: ParsedRef, opened: Opened): void {
  if (post !== undefined && ref.postPart !== undefined && opened.post !== undefined && opened.post.resolved.id !== ref.postPart) {
    throw postConflict(post, ref.postPart);
  }
}

// request 2 and the neighbours

/** One part of an answer: its data (undefined when the forum had nothing), or `ok: false` when it failed. */
type Part = { ok: true; data: unknown } | { ok: false };

/** The part `alias` of `results`; an alias error is that part's `Partial:` line, with the error as the forum gave it. */
function partOf(results: AliasResults, alias: string, section: string, partials: string[]): Part {
  const r = results.get(alias);
  if (r === undefined) return { ok: false };
  if (!("error" in r)) return { ok: true, data: r.data };
  if (r.error === "not_found" || r.error === "not_public") return { ok: true, data: undefined };
  partials.push(partialLine(section, new ToolError(r.error, r.message)));
  return { ok: false };
}

/** The site's figures (Q102): rounded, and only a pair of numbers. */
function statsOf(data: unknown): { words: number; minutes: number } | undefined {
  if (!isRecord(data) || typeof data.totalWordCount !== "number" || typeof data.totalReadTime !== "number") return undefined;
  return { words: Math.round(data.totalWordCount), minutes: Math.round(data.totalReadTime) };
}

/** What each side of a marked post reads, and whether request 3 could not start. */
interface Sides { prev?: string; next?: string; stopped: boolean }

/** The entries on either side of a post in an order. */
interface Near { prev?: OrderedPost; next?: OrderedPost }

/**
 * Where the marked post sits: among the posts listed (`found`, after `af_only`) and in the sequence as the site has it (`whole`).
 * The two differ only under `af_only`, whose `found` lacks the non-AF posts `whole` still holds.
 */
interface Located { found: Near; whole: Near; afOnly: boolean }

/**
 * ¶4.9 Position: the neighbours of a post located in the sequence. Inside the sequence a neighbour is the post itself. At an end
 * of the sequence, when it belongs to a collection (and the listing could be read), the adjacent sequence in the collection's book
 * order is named: its first or last post once request 3 has read its chapters, and the sequence alone when request 3 cannot start
 * or fails; bestoflesswrong, whose books are partly unnumbered, gives none; the ends of the collection, `none`. `af_only` removes
 * posts and moves no end: a side with only non-AF posts beyond the marked post is `none` (nothing more to list that way, and no
 * request 3), and at a real end the neighbour is the adjacent sequence's first or last AF post (the sequence alone when it has none).
 */
async function neighbourSides(
  at: Located, record: SequenceRecord, listing: RawCollection[] | undefined, partials: string[], ctx: CallContext, svc: Services,
): Promise<Sides> {
  const sides: Sides = { stopped: false };
  const slug = record.collectionSlug === undefined ? undefined : oneLine(record.collectionSlug, NAME_CAP);
  const wanted: { dir: Dir; id: string; title: string | null }[] = [];
  for (const dir of ["prev", "next"] as const) {
    const near = at.found[dir];
    if (near !== undefined) {
      sides[dir] = postRefText(maskPostRef(near.post));
      continue;
    }
    // Only posts af_only removed lie this way: the marked post is not at the end of the sequence.
    if (at.whole[dir] !== undefined) {
      sides[dir] = "none";
      continue;
    }
    // At an end. A sequence outside every collection has no neighbour, and so has one the listing does not hold; an unreadable
    // listing (its Partial line says so) leaves the side out.
    if (slug === undefined) {
      sides[dir] = "none";
      continue;
    }
    if (listing === undefined) continue;
    const collection = listing.find((c) => c.slug === record.collectionSlug);
    const adjacent = collection === undefined ? undefined : adjacentSequence(collection, record.id, dir);
    if (collection === undefined || adjacent === undefined) sides[dir] = "none";
    else if (!adjacent.reliable) sides[dir] = `the adjacent sequence in ${slug} ${UNORDERED}`;
    else if (adjacent.id === undefined) sides[dir] = "none";
    else wanted.push({ dir, id: adjacent.id, title: bookSequenceTitle(collection, adjacent.id) });
  }
  if (wanted.length === 0) return sides;

  // The sequence alone, for a request that cannot start or fails.
  const named = (w: (typeof wanted)[number]): string => `in the ${DIR_WORD[w.dir]} sequence of ${slug}: ${titleText(w.title)} (sequence_id ${w.id})`;
  for (const w of wanted) sides[w.dir] = named(w);
  if (!ctx.mayStartRequest()) return { ...sides, stopped: true };
  // P17: an adjacent sequence is a `Book.sequences` row of the listing, so it is confirmed public.
  const ops = wanted.map((w) => sequenceChaptersOp(NEIGHBOUR_ALIAS[w.dir], ctx.confirmPublic("sequence", w.id), NEIGHBOUR_FIELDS));
  let answer: AliasResults;
  try {
    answer = await svc.gql(ops, ctx, NEIGHBOUR_TASK);
  } catch (e) {
    if (e instanceof CallStopped) return { ...sides, stopped: true };
    if (!isToolError(e)) throw e;
    partials.push(partialLine(SECTION.neighbour, e));
    return sides;
  }
  // One section: request 3 reads both ends, and its failures are one Partial line.
  const failures: string[] = [];
  for (const w of wanted) {
    const part = partOf(answer, NEIGHBOUR_ALIAS[w.dir], SECTION.neighbour, failures);
    if (!part.ok) continue;
    // af_only keeps AF posts only, here too: an adjacent sequence with none is named alone.
    const order = readingOrder(rowsOf<RawChapter>(part.data)).filter((o) => !at.afOnly || o.post.af);
    const post = w.dir === "next" ? order[0] : order.at(-1);
    if (post !== undefined) sides[w.dir] = crossText(post.post, w.dir, slug!, w.title);
  }
  if (failures.length > 0) partials.push(failures[0]!);
  return sides;
}

// a sequence

/** The marked post of a page: its id, whether the page shows its position, and its canonical sequence when request 1 read it. */
interface Mark { id: string; position: boolean; canonical?: RawSeqRef | null }

interface SequencePageInput {
  opened: Opened;
  ask: Ask;
  mark?: Mark;
  /** A continuation's list state; a marked page's is made from its chapter. */
  state?: ListState;
  /** The first page of a call, or a page shown again after a stop. */
  first: boolean;
  /** The marked post's echo, when this call resolved it. */
  postEcho?: string;
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** `Chapter 2 · "Biases"`; the number is the chapter's place in the forum's list. */
function chapterHeader(o: OrderedPost): string {
  const title = oneLine(o.chapterTitle, TITLE_CAP);
  return title === "" ? `Chapter ${o.chapterIndex + 1}` : `Chapter ${o.chapterIndex + 1}${SEP}"${title}"`;
}

/** `Sequence "<title>" — <author> · sequence_id … · <url> · collection_slug … · AF | LW only · hidden … · curated rank N`. */
function sequenceHeader(r: SequenceRecord): string {
  const facts = [`sequence_id ${r.id}`, sequenceUrl(r.id, r.af)];
  if (r.collectionSlug !== undefined) facts.push(`collection_slug ${oneLine(r.collectionSlug, NAME_CAP)}`);
  facts.push(r.af ? FLAG.AF : FLAG.LW_ONLY);
  if (r.hiddenFromLists) facts.push(FLAG.HIDDEN_SEQUENCE);
  if (r.curatedOrder !== null) facts.push(`curated rank ${fmtInt(r.curatedOrder)}`);
  return `Sequence ${titleText(r.title)} — ${personText(r.author)}${SEP}${facts.join(SEP)}`;
}

/** ¶4.9 Page with `post`: the chapters and posts before the page's first, which the page does not show. */
function beforeNote(chapters: number, posts: number): string {
  const which = chapters === 1 ? "Chapter 1" : `Chapters 1–${fmtInt(chapters)}`;
  const range = posts === 1 ? "post 1" : `posts 1–${fmtInt(posts)}`;
  return `${which} (${range}) ${chapters === 1 ? "comes" : "come"} before this; call get_sequence without post to read from the start.`;
}

/** What request 2 gave: the chapters, the site's figures when they came, and what `placeMarked` needs of the answer. */
interface ChaptersRead {
  chapters: RawChapter[];
  figures?: { words: number; minutes: number };
  results: AliasResults;
  /** Whether the collections listing rode along (`results` then holds its `col` alias). */
  listingAsked: boolean;
}

/**
 * Request 2: the chapters (an alias error is the call's error), the stats (a `Partial:` line when they fail) and, when the
 * page shows the position of a marked post in a sequence of a collection whose listing is not cached, that listing.
 */
async function readChapters(
  opened: Opened, record: SequenceRecord, wantsPosition: boolean, partials: string[], ctx: CallContext, svc: Services,
): Promise<ChaptersRead> {
  const listingAsked = wantsPosition && record.collectionSlug !== undefined && !collectionsCached(svc);
  const results = await svc.gql(getSequenceRequest2Ops({ sequenceId: opened.id, listing: listingAsked }), ctx, CHAPTERS_TASK);
  const chapters = rowsOf<RawChapter>(aliasData(results, "ch", CHAPTERS_TASK, ctx));
  const stats = partOf(results, "st", SECTION.stats, partials);
  const figures = stats.ok ? statsOf(stats.data) : undefined;
  return { chapters, results, listingAsked, ...(figures !== undefined && { figures }) };
}

/** Where a marked post is: the lines it adds to the head, its `Position:` text, the index its page starts at, and whether request 3 could not start. */
interface Placed { lines: string[]; position?: string; start?: number; stopped: boolean }

/**
 * ¶4.9 Position and Page with `post`: the marked post is looked up in the (filtered) reading order, never through the forum's
 * `nextPost`/`prevPost` (Q101). Found: its place and neighbours (the ends are those of the whole sequence, also under `af_only`),
 * and the page starts at the first post of its chapter, with a note of what comes before. Not found: said so, with the post's
 * canonical sequence when it has a public one; a post that `af_only` removed is said to be left out instead, because it is in the
 * sequence.
 */
async function placeMarked(
  mark: Mark, listed: readonly OrderedPost[], order: readonly OrderedPost[], afOnly: boolean, record: SequenceRecord, read: ChaptersRead,
  partials: string[], ctx: CallContext, svc: Services,
): Promise<Placed> {
  const found = neighbours(listed, mark.id);
  if (found === undefined) {
    if (order.some((o) => o.post._id === mark.id)) {
      return { lines: ["This post is in this sequence but not on the Alignment Forum, so af_only leaves it out."], stopped: false };
    }
    const canonical = mark.canonical != null && sequencePublic(mark.canonical)
      ? [`The site's canonical sequence for this post: ${seqRefText(maskSeqRef(mark.canonical))}`]
      : [];
    return { lines: ["This post is not in this sequence.", ...canonical], stopped: false };
  }
  const chapter = listed[found.index]!.chapterIndex;
  const start = listed.findIndex((o) => o.chapterIndex === chapter);
  let listing: RawCollection[] | undefined;
  if (record.collectionSlug !== undefined) {
    // A `col` alias that failed has its Partial line already; a listing not asked for is read from the cache, never sent.
    const readable = read.listingAsked ? partOf(read.results, "col", SECTION.neighbour, partials).ok : collectionsCached(svc);
    if (readable) listing = await loadCollectionsListing(ctx, svc, read.listingAsked ? read.results : undefined);
  }
  // The ends are those of the whole sequence: af_only removes posts, it does not move the ends.
  const sides = await neighbourSides({ found, whole: neighbours(order, mark.id) ?? found, afOnly }, record, listing, partials, ctx, svc);
  const side = (dir: Dir): string[] => (sides[dir] === undefined ? [] : [`${DIR_WORD[dir]}: ${sides[dir]}`]);
  return {
    lines: start > 0 ? [beforeNote(chapter, start)] : [],
    position: [`post ${fmtInt(found.index + 1)} of ${fmtInt(listed.length)}`, ...side("prev"), ...side("next")].join(SEP),
    start,
    stopped: sides.stopped,
  };
}

async function sequencePage(x: SequencePageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { opened, ask, mark } = x;
  const record = toSequenceRecord(opened.doc);
  const wantsPosition = mark !== undefined && mark.position;

  const partials: string[] = [];
  const read = await readChapters(opened, record, wantsPosition, partials, ctx, svc);
  const { chapters, figures } = read;
  const order = readingOrder(chapters);
  const listed = ask.afOnly ? order.filter((o) => o.post.af) : order;
  const removed = order.length - listed.length;
  const when = (o: OrderedPost): number => timeOf(o.post.postedAt);

  const placed: Placed = wantsPosition ? await placeMarked(mark, listed, order, ask.afOnly, record, read, partials, ctx, svc) : { lines: [], stopped: false };
  const { stopped } = placed;
  const startState: ListState | undefined = placed.start === undefined
    ? x.state
    : { kind: "list", shown: placed.start, index: placed.start, fingerprint: x.state?.fingerprint ?? fingerprint(listed, when) };
  const page = listPage(listed, startState, ask.limit, (o) => o.post._id, when);
  const shown0 = startState?.shown ?? 0;
  const first0: ListState = startState ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(listed, when) };
  const count = page.items.length;

  const records = page.items.map((o) => toPostRecord(o.post as RawPostCard));
  const items: PageItem[] = page.items.map((o, j) => {
    const marked = mark !== undefined && o.post._id === mark.id;
    const line = postLine(records[j]!, { prefix: `${marked ? "→ " : ""}${listed.indexOf(o) + 1}. ` });
    const previous = page.items[j - 1];
    return { text: previous === undefined || previous.chapterIndex !== o.chapterIndex ? `${chapterHeader(o)}\n${line}` : line };
  });

  const identifiers = [echoOf("sequence", opened.resolved), ...(x.postEcho === undefined ? [] : [x.postEcho])];
  const empty = count === 0 && x.first
    ? (order.length === 0
      ? emptyText({ kind: "subject", what: "posts in", subject: titleText(record.title) })
      : emptyText({ kind: "filtered", items: "posts", filters: "AF only" }))
    : undefined;
  const countsLine = [counted(chapters.length, "chapter"), counted(order.length, "publicly visible post")]
    .concat(figures === undefined ? [] : [`~${counted(figures.words, "word")}`, `~${fmtInt(figures.minutes)} min reading (site figures)`])
    .join(SEP);
  const notes = [
    ...(count > 0 || (x.first && figures !== undefined) ? [CAVEAT["C-COUNTER"]] : []),
    ...(ask.afOnly || records.some((r) => r.af) ? [CAVEAT["C-KARMA"]] : []),
    ...(records.some((r) => !r.status.frontpage) ? [CAVEAT["C-FRONTPAGE"]] : []),
    ...(page.driftNote === undefined ? [] : [page.driftNote]),
  ];
  const position = placed.position ?? (count === 0
    ? undefined
    : (c: Consumed): string => positionText("posts", shown0 + 1, shown0 + Math.max(1, Math.min(c.items, count)), listed.length));

  // A page whose request 3 could not start is shown again by its cursor, from its first post, with the marked post's position.
  const markedData = mark === undefined ? undefined : { marked: mark.id };
  const footerFor = (c: Consumed): Footer => {
    if (stopped) {
      const cursor = cursorFor(svc, x, first0, { ...markedData, again: 1 });
      return { kind: "stopped", why: ctx.stopped ?? "time limit", tool: "get_sequence", cursor };
    }
    const n = Math.min(c.items, count);
    if (n === count && page.ended) return { kind: "end" };
    const cursor = cursorFor(svc, x, n === 0 ? first0 : page.after[n - 1]! as ListState, markedData);
    return { kind: "more", tool: "get_sequence", cursor, next: nextText("posts", shown0 + n + 1, Math.min(shown0 + n + ask.limit, listed.length)) };
  };
  return render(
    (nonce) => ({
      tool: "get_sequence", subject: titleText(record.title), request: requestEcho(identifiers, ask, x.echo),
      ...(position !== undefined && { position }), oneItem: placed.position === undefined && shown0 === 0 && count === 1 && page.ended, notes,
      head: [
        sequenceHeader(record),
        ...(x.first ? [countsLine] : []),
        ...(x.first && ask.afOnly ? [`af_only removed ${counted(removed, "post")} not on the Alignment Forum`] : []),
        ...placed.lines, ...partials,
        ...(x.first ? descriptionBlock("sequence description", opened.doc.contents?.markdown, nonce, maxTokens) : []),
        ...(empty === undefined ? [] : [empty]),
      ],
      items,
    }),
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

/** `post` makes no sense for a collection, which has sequences and no posts. */
const collectionWithPost = () => badInput("post", "can't be combined with a collection", "Give a sequence with post, or a collection without it.");

async function firstPage(p: GetSequenceParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const ref = parseRef("sequence", p.sequence!, ["sequence"]);
  const ask: Ask = { afOnly: p.af_only, limit: p.limit };
  const args = givenArgs(p, ctx);
  if (ref.form === "collection") {
    if (p.post !== undefined) throw collectionWithPost();
    const slug = ref.value as CollectionSlug;
    const resolved = await resolve(ref, "sequence", ctx, svc);
    const collection = await readCollection(slug, ctx, svc);
    return collectionPage({ collection, slug, resolved, ask, echo: ctx, args, effective: effectiveOf(slug, undefined, ask) }, p.max_tokens, svc);
  }
  const opened = await openSequence(ref, postRefOf(p.post, ref), ctx, svc);
  checkMarked(p.post, ref, opened);
  const post = opened.post;
  return sequencePage(
    {
      opened, ask, first: true, echo: ctx, args, effective: effectiveOf(opened.resolved.id, post?.resolved.id, ask),
      ...(post !== undefined && { mark: { id: post.resolved.id, position: true, canonical: post.canonical }, postEcho: echoOf("post", post.resolved) }),
    },
    p.max_tokens, ctx, svc,
  );
}

async function continuation(entry: CursorEntry, p: GetSequenceParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { sequence: string; post?: string; af_only: boolean; limit: number };
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "list") throw internalError("get_sequence", "a cursor without a list state");
  const data = isRecord(entry.state.data) ? entry.state.data : {};
  const gaveSequence = ctx.given.has("sequence") && p.sequence !== undefined;
  const ref = parseRef("sequence", gaveSequence ? p.sequence! : stored.sequence, ["sequence"]);
  // ¶3.6: a sequence, a collection and the other parameters are compared before any request; a post once it is resolved.
  const given = { afOnly: p.af_only, limit: p.limit };
  const early = { sequence: ref.value, af_only: given.afOnly, limit: given.limit };
  checkContinuation(entry, early, ctx);
  const ask: Ask = { afOnly: stored.af_only, limit: stored.limit };
  const echo: CallContext = { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) };
  const args = { ...entry.args };
  const effective = { ...entry.effective };

  if (ref.form === "collection") {
    if (ctx.given.has("post")) throw collectionWithPost();
    const slug = ref.value as CollectionSlug;
    const resolved = await resolve(ref, "sequence", ctx, svc);
    const collection = await readCollection(slug, ctx, svc);
    return collectionPage({ collection, slug, resolved, ask, state, echo, args, effective }, p.max_tokens, svc);
  }

  const postRef = ctx.given.has("post") || gaveSequence ? postRefOf(ctx.given.has("post") ? p.post : undefined, ref) : undefined;
  const opened = await openSequence(ref, postRef, ctx, svc);
  checkMarked(ctx.given.has("post") ? p.post : undefined, ref, opened);
  if (postRef !== undefined) {
    checkContinuation(entry, effectiveOf(ref.value, opened.post?.resolved.id, given), { ...ctx, given: new Set([...ctx.given, "post"]) });
  }
  const markedId = typeof data.marked === "string" ? data.marked : undefined;
  const again = data.again === 1;
  return sequencePage(
    {
      opened, ask, first: again, echo, args, effective, state,
      ...(markedId !== undefined && {
        mark: { id: markedId, position: again, ...(opened.post !== undefined && { canonical: opened.post.canonical }) },
        postEcho: opened.post !== undefined ? echoOf("post", opened.post.resolved) : `post → post_id ${markedId}`,
      }),
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  sequence: P.sequence().optional(),
  post: P.post().optional(),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetSequenceParams> = {
  name: "get_sequence",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["sequence"],
  run(p, ctx, svc) {
    const entry = openContinuation("get_sequence", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
