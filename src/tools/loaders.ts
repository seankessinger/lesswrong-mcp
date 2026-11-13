// Layer 2. Cached loaders shared by several tools. `loadForest` reads a discussion's comment forest (¶4.4 steps 3–5; `find`'s
// `commented_on`, ¶4.1 step 5, and `get_comments`) once per 10 minutes into the `forest` cache as plain JSON rows (never the
// processed Forest, whose index is a Map) and rebuilds the reply forest on every call, with the bodies fetched so far attached;
// ops that must be read with the forest (a post's header fields) ride along with its request. `loadBodies` is `get_comments`'
// phase B (¶4.4 step 12): the bodies it fetches are kept in the forest's entry, which is stored again so that the cache measures
// its size anew (¶2.3), and a comment the forum no longer returns is dropped from it (D1).
// `loadCollectionsListing` reads COLLECTIONS_LISTING (¶4.0) into the `collections` cache for 24 hours with every book's sequence
// rows in the book's own order, hidden ones kept (the site's next and previous links step into them; a list drops them, P4);
// `bookSequenceRow` and `crossText` find and word the neighbour a post has in the adjacent sequence of that listing, for
// `get_post` (¶4.3 step 5) and `get_sequence` (¶4.9 Position) alike.
// `loadCoreGrouping` reads the tags filed under one core tag (`TagsByCoreTagId`, ¶4.16; `get_tag`'s preview shares it) once per
// 60 minutes into the `coregroup` cache, with the rows that are not listable dropped (P12) and a flag for an answer as long as
// the request allowed. `loadUserWikiEdits` reads a person's wiki edits (`revisionsByUser`, ¶4.11 step 2 and ¶4.7 steps 2–3) as
// one light set of at most two raw pages of 1,000 into the `revuser` cache for 10 minutes, the rows that fail P12 (c) dropped
// whole and the rest sorted by `editedAt`, newest first; `get_history {user}` pages it and `get_user` previews
// it, so `get_user`'s hand-off cursor indexes into the same set. `aliasData` reads one alias of a loader's or a tool's answer:
// the forum's "nothing here" and its refusal read as no data (list members and joins are dropped silently, ¶8), and any other
// alias error becomes the call's error, worded as ¶3.9 says (`failureOf`). A later request of a call, whose failure is a
// `Partial:` line and not the call's error (¶7), is sent by `send` and read part by part with `partOf` and `aliasPart` (get_post,
// get_tag, get_sequence, get_user). `revisionTexts` reads revision texts through the `revtext` cache and `introductionRounds`
// runs the phrase search's rounds, for `get_history` and `first_use` alike.
import { CONFIG } from "../config";
import { buildForest } from "../domain/comments";
import { pageText } from "../domain/markdown";
import { findIntroduction, toRevisionRecord, type IntroSeries, type IntroState } from "../domain/revisions";
import { maskPostRef, revisionRowPublic, sequencePublic, tagListable, wikiEditPage } from "../domain/visibility";
import { CallStopped, forumError, internalError, isTooLarge, isToolError, loginOnly, ToolError } from "../errors";
import {
  collectionsListingOp, commentForestOps, commentsByIdsOps, CORE_GROUPING_LIMIT, coreGroupingOp, revisionsByUserOp, revisionTextOp, tagForestOp,
} from "../forum/templates/shared";
import { compareLocal, lightScan, type RawPage } from "../paging/pager";
import { FLAG, partialLine } from "../render/messages";
import { postRefText } from "../render/records";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResult, AliasResults, CallContext, Forest, GqlOp, PublicPostId, PublicTagId, RawBook, RawCollection, RawCommentRef,
  RawCommentTree, RawPostRef, RawRevRow, RawTagList, RevisionDoc, RevisionRecord, Services, StopReason,
} from "../types";
import { isRecord, rowsOf } from "./common";

/** What a discussion belongs to; its id is confirmed public in this call (P17). */
export type DiscussionSubject =
  | { kind: "post"; id: PublicPostId; af: boolean; hideCommentKarma: boolean; debate: boolean }
  | { kind: "tag"; id: PublicTagId };

/** The cached form of a discussion: the forum's rows as they came, and the bodies fetched so far by comment id. */
interface ForestEntry {
  comments: RawCommentTree[];
  answers: RawCommentTree[];
  debateTurns: RawCommentRef[];
  bodies: Record<string, string>;
  /** When the rows were fetched (epoch ms): an entry stored again with more bodies keeps the expiry its rows have. */
  fetchedAt: number;
}

/**
 * Ops read together with a forest (the header fields of a post whose cached resolution lacks them): sent with the forest
 * request when one is sent, else alone. `read` gives the subject the forest is built for from their answer; it may throw
 * (the subject is no longer public), and the forest is then neither cached nor built.
 */
export interface ForestCompanion {
  ops: readonly GqlOp[];
  task: string;
  read(results: AliasResults): DiscussionSubject;
}

const FOREST_TASK = "loading the discussion";
const BODIES_TASK = "reading the comments";
const COLLECTIONS_TASK = "reading the collections";
const COLLECTIONS_KEY = "all";
const GROUPING_TASK = "reading the tags under a core tag";
const WIKI_EDITS_TASK = "reading the wiki edits";

/** An alias error that is more than "nothing here", as the error of the call (¶3.9 wording; `internal` already names its template). */
export function failureOf(r: Extract<AliasResult, { error: unknown }>, task: string, ctx: CallContext): ToolError {
  switch (r.error) {
    case "internal":
      return internalError(ctx.tool, r.message);
    case "forum_error":
      return forumError(task, r.message);
    case "login_only":
      return loginOnly();
    default:
      return new ToolError(r.error, r.message);
  }
}

/**
 * The data `alias` answered, or `undefined` when the answer has no such alias or the alias reads as nothing (`not_found`,
 * `not_public`); any other alias error is thrown as the call's error, `task` naming what the request was for.
 */
export function aliasData(results: AliasResults, alias: string, task: string, ctx: CallContext): unknown {
  const r = results.get(alias);
  if (r === undefined) return undefined;
  if ("error" in r) {
    if (r.error === "not_found" || r.error === "not_public") return undefined;
    throw failureOf(r, task, ctx);
  }
  return r.data;
}

/** What a later request gave: nothing to send, a stop (deadline or cap), the whole request's failure, or its answer. */
export type Sent = { kind: "none" } | { kind: "stopped"; why: StopReason } | { kind: "failed"; error: ToolError } | { kind: "ok"; results: AliasResults };

/**
 * A later request of a call, whose failure is a `Partial:` line and not the call's error (¶7). `checkFirst`: not sent at all once
 * no request may start, so that not even a cached answer is used (get_post's requests 2 and 3, get_sequence's request 3).
 */
export async function send(ops: readonly GqlOp[], task: string, ctx: CallContext, svc: Services, checkFirst = false): Promise<Sent> {
  if (ops.length === 0) return { kind: "none" };
  if (checkFirst && !ctx.mayStartRequest()) return { kind: "stopped", why: ctx.stopped ?? "time limit" };
  try {
    return { kind: "ok", results: await svc.gql(ops, ctx, task) };
  } catch (e) {
    if (e instanceof CallStopped) return { kind: "stopped", why: e.reason };
    if (isToolError(e)) return { kind: "failed", error: e };
    throw e;
  }
}

/** One part of an answer: its data (`undefined` when the forum had nothing), or not read, with the `Partial:` line of a failure. */
export type Part = { ok: true; data: unknown } | { ok: false; partial?: string };

/**
 * The part `alias` of an answer, for `section`: the forum's "nothing here" (`not_found`, `not_public`) is no data, any other
 * alias error is the part's `Partial:` line with the error as the forum gave it (¶3.9), and an alias the answer lacks is not read.
 * `partials`, when given, also gets the line.
 */
export function aliasPart(results: AliasResults, alias: string, section: string, partials?: string[]): Part {
  const r = results.get(alias);
  if (r === undefined) return { ok: false };
  if (!("error" in r)) return { ok: true, data: r.data };
  if (r.error === "not_found" || r.error === "not_public") return { ok: true, data: undefined };
  return failedPart(partialLine(section, new ToolError(r.error, r.message)), partials);
}

/**
 * The part `alias` of a later request, read only when `ops` asked for it: the failure of the whole request is the part's
 * `Partial:` line; a request not sent or stopped is not read, and says nothing. `partials`, when given, also gets the line.
 */
export function partOf(sent: Sent, ops: readonly GqlOp[], alias: string, section: string, partials?: string[]): Part {
  if (!ops.some((o) => o.alias === alias)) return { ok: false };
  if (sent.kind === "failed") return failedPart(partialLine(section, sent.error), partials);
  return sent.kind === "ok" ? aliasPart(sent.results, alias, section, partials) : { ok: false };
}

function failedPart(partial: string, partials: string[] | undefined): Part {
  partials?.push(partial);
  return { ok: false, partial };
}

/** The entry (and its cache key) each forest was built from, so that `loadBodies` adds to the rows that forest came from. */
const sources = new WeakMap<Forest, { key: string; entry: ForestEntry }>();

/** The reply forest of `entry`'s rows for `subject`, each body fetched so far attached to its comment (never to a placeholder). */
function forestOf(entry: ForestEntry, subject: DiscussionSubject, key: string): Forest {
  const forest = buildForest({
    comments: entry.comments,
    answers: entry.answers,
    debateTurns: entry.debateTurns,
    postAf: subject.kind === "post" && subject.af,
    hideCommentKarma: subject.kind === "post" && subject.hideCommentKarma,
  });
  for (const [id, body] of Object.entries(entry.bodies)) {
    const node = forest.byId.get(id);
    if (node !== undefined && node.c.placeholder === undefined) node.c.body = body;
  }
  sources.set(forest, { key, entry });
  return forest;
}

/**
 * A discussion's reply forest. The rows come from the `forest` cache (key `post:<id>` or `tag:<id>`), else from one request,
 * stored with the default TTL; the forest is rebuilt from them on every call and each cached body is attached to its comment.
 * A `companion`'s ops go with the forest request, or alone when the forest is cached, and its `read` decides the subject the
 * forest is built for.
 */
export async function loadForest(subject: DiscussionSubject, ctx: CallContext, svc: Services, companion?: ForestCompanion): Promise<Forest> {
  const key = `${subject.kind}:${subject.id}`;
  let entry = svc.caches.get<ForestEntry>("forest", key);
  if (entry === undefined) {
    const ops = subject.kind === "post" ? commentForestOps(subject.id, subject.debate) : [tagForestOp(subject.id)];
    const results = await svc.gql([...ops, ...(companion?.ops ?? [])], ctx, FOREST_TASK);
    if (companion !== undefined) subject = companion.read(results);
    const rows = <T>(alias: string): T[] => rowsOf<T>(aliasData(results, alias, FOREST_TASK, ctx));
    entry = {
      comments: rows<RawCommentTree>("c"),
      answers: subject.kind === "post" ? rows<RawCommentTree>("a") : [],
      debateTurns: subject.kind === "post" && subject.debate ? rows<RawCommentRef>("d") : [],
      bodies: {},
      fetchedAt: svc.now(),
    };
    svc.caches.set("forest", key, entry);
  } else if (companion !== undefined) {
    subject = companion.read(await svc.gql(companion.ops, ctx, companion.task));
  }
  return forestOf(entry, subject, key);
}

/**
 * ¶2.3: `entry` stored again, so that the cache measures it with the bodies it now holds, until the expiry its rows already
 * had. Nothing is stored once that expiry has passed, nor over a newer entry another call fetched meanwhile.
 */
function storeAgain(key: string, entry: ForestEntry, svc: Services): void {
  const left = entry.fetchedAt + CONFIG.cache.ttlMs.forest - svc.now();
  if (left <= 0) return;
  const current = svc.caches.get<ForestEntry>("forest", key);
  if (current !== undefined && current !== entry) return;
  svc.caches.set("forest", key, entry, left);
}

/**
 * ¶4.4 step 12, phase B: the bodies of `ids` (comments of a forest `loadForest` built), kept in the forest's cache entry. Ids
 * whose body is cached cost nothing; the rest are read in one request (at most 300 ids per alias, `COMMENT_BODY`) and each
 * body is set on its comment through `blockText`; rows not asked for are ignored, and an alias error is the call's error
 * (`get_comments` is not a multi-part tool, ¶8). An id the answer does not return is a comment the default view no longer
 * shows (privately deleted, rejected or flagged since the forest was cached, D1): its row is dropped from the entry and the
 * forest is rebuilt without it, so its replies become orphans and its id is printed nowhere. Otherwise the forest given is
 * returned, its new bodies set.
 */
export async function loadBodies(
  subject: DiscussionSubject, forest: Forest, ids: readonly string[], ctx: CallContext, svc: Services,
): Promise<Forest> {
  const source = sources.get(forest);
  if (source === undefined) throw internalError(ctx.tool, "loadBodies: a forest loadForest did not build");
  const { key, entry } = source;
  const wanted = [...new Set(ids)].filter((id) => entry.bodies[id] === undefined);
  if (wanted.length === 0) return forest;
  const results = await svc.gql(commentsByIdsOps("b", wanted, "...COMMENT_BODY"), ctx, BODIES_TASK);
  const asked = new Set(wanted);
  const returned = new Set<string>();
  for (const r of results.values()) {
    if ("error" in r) throw failureOf(r, BODIES_TASK, ctx);
    for (const row of rowsOf<{ _id?: unknown; contents?: { markdown?: unknown } | null }>(r.data)) {
      if (typeof row._id !== "string" || !asked.has(row._id)) continue;
      const markdown = row.contents?.markdown;
      // A body the forum returns empty counts as fetched: it is shown as it is and never asked for again.
      entry.bodies[row._id] = blockText(typeof markdown === "string" ? markdown : "");
      returned.add(row._id);
    }
  }
  const gone = new Set(wanted.filter((id) => !returned.has(id)));
  if (gone.size > 0) {
    entry.comments = entry.comments.filter((row) => !gone.has(row._id));
    entry.answers = entry.answers.filter((row) => !gone.has(row._id));
  }
  storeAgain(key, entry, svc);
  if (gone.size > 0) return forestOf(entry, subject, key);
  for (const id of returned) {
    const node = forest.byId.get(id);
    if (node !== undefined && node.c.placeholder === undefined) node.c.body = entry.bodies[id];
  }
  return forest;
}

/**
 * P4, P14: a book's sequence rows in its `sequenceIds` order, one per entry, as the forum's `Book.sequences` loads them (an
 * entry listed twice twice; an entry with no row, not publicly visible, left out). Hidden ones stay, for the neighbours the
 * site's links step into; whatever lists a book's sequences drops them (find's book line).
 */
function orderedBook(book: RawBook): RawBook {
  const rows = (book.sequences ?? []).filter(sequencePublic);
  return { ...book, sequences: (book.sequenceIds ?? []).flatMap((id) => rows.find((s) => s._id === id) ?? []) };
}

/** The collections listing as cached (24 hours), or `undefined`; never a request. */
export function cachedCollectionsListing(svc: Services): RawCollection[] | undefined {
  return svc.caches.get<RawCollection[]>("collections", COLLECTIONS_KEY);
}

/** Whether the collections listing is cached, so that a request that needs it can leave its `col` alias out. */
export function collectionsCached(svc: Services): boolean {
  return cachedCollectionsListing(svc) !== undefined;
}

/**
 * The five collections with their books (¶4.0 COLLECTIONS_LISTING): from the `col` alias of `results` when it has one, else
 * from the `collections` cache, else from one request; every book's rows are in its own order, hidden ones kept, and the
 * result is cached for 24 hours.
 */
export async function loadCollectionsListing(ctx: CallContext, svc: Services, results?: AliasResults): Promise<RawCollection[]> {
  let answer = results?.has("col") ? results : undefined;
  if (answer === undefined) {
    const cached = svc.caches.get<RawCollection[]>("collections", COLLECTIONS_KEY);
    if (cached !== undefined) return cached;
    answer = await svc.gql([collectionsListingOp("col")], ctx, COLLECTIONS_TASK);
  }
  const listing = rowsOf<RawCollection>(aliasData(answer, "col", COLLECTIONS_TASK, ctx)).map((c) => ({
    ...c,
    books: (c.books ?? []).filter(isRecord).map((b) => orderedBook(b as RawBook)),
  }));
  svc.caches.set("collections", COLLECTIONS_KEY, listing);
  return listing;
}

/** The way along a sequence's posts or a collection's sequences: before or after. */
export type Dir = "prev" | "next";
/** The word each direction prints in the sentence that names a neighbour in the adjacent sequence (¶4.3 step 5, ¶4.9 Position). */
export const DIR_WORD: Readonly<Record<Dir, string>> = { prev: "previous", next: "next" };
/** ¶4.3 step 5, ¶4.9 Position: why a collection with unnumbered books (bestoflesswrong) gives no cross-sequence neighbour. */
export const UNORDERED = "can't be determined reliably (the forum defines no order among books that share a number or have none)";

/**
 * P4, P17: the row a collection's books hold for a sequence (a `Book.sequences` row, hidden ones included), or `undefined` when
 * none does: the forum leaves out a sequence a logged-out reader can't open, so such an id is not publicly visible.
 */
export function bookSequenceRow(c: RawCollection, id: string): RawBook["sequences"][number] | undefined {
  for (const book of c.books) {
    const row = book.sequences.find((s) => s._id === id);
    if (row !== undefined) return row;
  }
  return undefined;
}

/**
 * A neighbour in the adjacent sequence: the post reference with `, in the next sequence of <slug>: "<title>"` inside its
 * parentheses (`"…" (post_id …, LW only, in the next sequence of rationality: "Fake Beliefs")`), and the sequence's flag after its
 * title when it is hidden from lists. The slug and the sequence title are single-line fields (¶3.7), the title cut at the title
 * cap; a post that is not publicly visible stays its plain reference.
 */
export function crossText(post: RawPostRef, dir: Dir, slug: string, seq: { title: string | null; hidden: boolean }): string {
  const ref = postRefText(maskPostRef(post));
  const flag = seq.hidden ? `, ${FLAG.HIDDEN_SEQUENCE}` : "";
  const note = `, in the ${DIR_WORD[dir]} sequence of ${oneLine(slug, CONFIG.render.caps.name)}: "${oneLine(seq.title, CONFIG.render.caps.title)}"${flag}`;
  return ref.endsWith(")") ? `${ref.slice(0, -1)}${note})` : ref;
}

/** A set of tag rows read in one request: the listable rows in the forum's order, and whether the forum returned as many as were asked for. */
export interface TagSet {
  rows: RawTagList[];
  /** True when the forum returned the most this server asks for, so that more rows may exist (¶3.6). */
  full: boolean;
}

/**
 * The tags filed under the core tag `coreTagId` (¶4.16, ¶4.8 step 6): from the `coregroup` cache, else from alias `g` of
 * `results` when the caller sent `coreGroupingOp("g", …)` with a request of its own (an alias error is then thrown as the
 * `ToolError` of its category and message, for the caller's `Partial:` line), else from one request of its own (an alias error
 * worded as ¶3.9 says). Rows that are not listable are dropped and wiki-only pages kept (P12); `full` is true when the forum
 * returned 500 rows, counted before any row is dropped. The grouping's `totalCount` is read nowhere (P10). The result is
 * cached for 60 minutes.
 */
export async function loadCoreGrouping(coreTagId: string, ctx: CallContext, svc: Services, results?: AliasResults): Promise<TagSet> {
  const cached = svc.caches.get<TagSet>("coregroup", coreTagId);
  if (cached !== undefined) return cached;
  const given = results?.get("g");
  const answer = given ?? (await svc.gql([coreGroupingOp("g", coreTagId)], ctx, GROUPING_TASK)).get("g");
  if (answer === undefined) throw internalError(ctx.tool, "core_grouping: the answer has no alias g");
  if ("error" in answer) throw given === undefined ? failureOf(answer, GROUPING_TASK, ctx) : new ToolError(answer.error, answer.message);
  if (!isRecord(answer.data) || !Array.isArray(answer.data.tags)) throw internalError(ctx.tool, "core_grouping: no tags in the answer");
  const raw = answer.data.tags.filter(isRecord) as unknown as RawTagList[];
  const set: TagSet = { rows: raw.filter(tagListable), full: raw.length === CORE_GROUPING_LIMIT };
  if (set.rows.length < raw.length) svc.log.debug("core grouping rows dropped as not listable", { dropped: raw.length - set.rows.length });
  svc.caches.set("coregroup", coreTagId, set);
  return set;
}

/** The `revuser` cache entry: a person's public wiki edits, newest first, and whether the second raw page was also full. */
type WikiEdits = { rows: RevisionRecord[]; over2000: boolean };

/** The document a wiki edit changed: its page, or the lens or summary it joins; wiki pages name every editor. */
function wikiEditDoc(raw: RawRevRow): RevisionDoc {
  return { kind: raw.collectionName === "Tags" ? "tag" : raw.lens ? "lens" : "summary", id: raw.documentId, hideAuthor: false };
}

/** ¶4.11 Ordering: `editedAt`, newer first, ties by id descending. */
const newestEditFirst = compareLocal<RevisionRecord>((r) => r.editedMs, (r) => r.editedMs, (r) => r.id);

/**
 * The data of alias `alias` that a caller's own request answered (`get_user`'s `we` and `we2`): no data for the forum's
 * "nothing here", and any other alias error as the `ToolError` of its category and message, for the caller's `Partial:` line.
 */
function callerData(r: AliasResult): unknown {
  if (!("error" in r)) return r.data;
  if (r.error === "not_found" || r.error === "not_public") return undefined;
  throw new ToolError(r.error, r.message);
}

/**
 * ¶4.11 step 2, ¶4.7 steps 2–3, L1: a person's wiki edits, from the `revuser` cache (key: their id, 10 minutes), else as one
 * light set of at most two raw pages of 1,000 (`revisionsByUser`, which takes only `userId`, R7; its order is undocumented, so
 * the set is sorted here by `editedAt`, newest first, ties by id descending). Each page is read from alias `we` / `we2` of
 * `results` when the caller sent them (`get_user`'s requests), else with a request of its own (`w0` / `w1`); the second is read
 * only when the first was full. `over2000`: the second raw page was also full, judged by the first page's `totalCount` (at
 * least 2,000; P10: it is read for nothing else), or by the second page's own rows when no total came back. A row that fails
 * P12 (c) is dropped whole and only counted (P14); the rest name their page (`page`).
 */
export async function loadUserWikiEdits(
  userId: string, ctx: CallContext, svc: Services, results?: AliasResults,
): Promise<{ rows: RevisionRecord[]; over2000: boolean }> {
  const cached = svc.caches.get<WikiEdits>("revuser", userId);
  if (cached !== undefined) return cached;
  const rawCount = CONFIG.paging.revisionPage;
  let total: number | undefined;
  let over2000 = false;
  const read = async (offset: number, first: boolean): Promise<RawPage<RawRevRow>> => {
    const given = results?.get(first ? "we" : "we2");
    const own = first ? "w0" : "w1";
    const data = given !== undefined
      ? callerData(given)
      : aliasData(await svc.gql([revisionsByUserOp(own, userId, offset)], ctx, WIKI_EDITS_TASK), own, WIKI_EDITS_TASK, ctx);
    const rows = rowsOf<RawRevRow>(data);
    if (!first) {
      over2000 = total !== undefined ? total >= 2 * rawCount : rows.length >= rawCount;
      return { rows, rawCount };
    }
    total = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
    return { rows, rawCount, ...(total !== undefined && { totalCount: total }) };
  };
  const scan = await lightScan(read, { overCap: "truncate", maxPages: 2 });

  const seen = new Set<string>();
  const rows: RevisionRecord[] = [];
  let dropped = 0;
  for (const raw of scan.rows) {
    if (seen.has(raw._id)) continue; // a row the forum returned on both pages
    seen.add(raw._id);
    const page = revisionRowPublic(raw) ? wikiEditPage(raw) : undefined;
    if (page === undefined) {
      dropped += 1;
      continue;
    }
    rows.push({ ...toRevisionRecord(raw, wikiEditDoc(raw)), page });
  }
  if (dropped > 0) svc.log.debug("wiki edits dropped as not public", { dropped });
  const edits: WikiEdits = { rows: rows.sort(newestEditFirst), over2000 };
  svc.caches.set("revuser", userId, edits);
  return edits;
}

/** A post's text with no page in the forum's answer (`pageText`). */
export const noPage = (): ToolError =>
  new ToolError("forum_error", "The forum did not return this text's page, so the text is not shown. Try again later.");

/**
 * The texts of several revisions in one request, or in halves when the answer is over the response cap: a post's are its pages, and
 * a long post's page can be many times its Markdown. Its aliases stay as given.
 */
export async function readRevisions(ops: readonly GqlOp[], task: string, ctx: CallContext, svc: Services): Promise<AliasResults> {
  try {
    return await svc.gql(ops, ctx, task);
  } catch (e) {
    if (ops.length < 2 || !isTooLarge(e)) throw e;
    const half = Math.ceil(ops.length / 2);
    const first = await readRevisions(ops.slice(0, half), task, ctx, svc);
    return new Map([...first, ...await readRevisions(ops.slice(half), task, ctx, svc)]);
  }
}

/**
 * A post's text from a forum answer holding its `html`; `undefined` without one. `get_history` and `first_use` read it so;
 * `speakers` names a named dialogue's speakers, as its page does (#65).
 */
export function postText(field: Record<string, unknown>, speakers = false): string | undefined {
  return pageText({ html: typeof field.html === "string" ? field.html : undefined, speakers });
}

/** A revision whose text is wanted: its id, the revision whose page is read (`source`), and the document both are of. */
export interface WantedText { id: string; source: string; docId: string }

/**
 * ¶4.11 step 6, ¶4.12 step 7, P17: the texts of the revisions `wanted`, each of a visible list of a confirmed document, by id.
 * Cached texts (`revtext`, 6 hours) cost nothing; the rest are fetched in one request, `r1`…`rN` in the order given. The cache
 * is keyed by `source`, the revision whose page was read (a post row's folded image copy, else the row), so that `get_history`
 * and `first_use` never serve each other a different page under one id, and a text with its speakers named apart from the same
 * text without them (#65). A post's text is its page; a wiki page's or lens's is its Markdown (an image copy rewrites only the
 * html). A text the forum no longer returns, or one of another document, is left out; `error` is the first problem in alias
 * order: an alias error beyond "nothing here", as the forum gave it, or a post's missing page.
 */
export async function revisionTexts(
  wanted: readonly WantedText[], o: { post: boolean; speakers?: boolean }, task: string, ctx: CallContext, svc: Services,
): Promise<{ texts: Map<string, string>; error?: Extract<AliasResult, { error: unknown }> | "no page" }> {
  const key = (w: WantedText): string => (o.speakers === true ? `${w.source}#speakers` : w.source);
  const texts = new Map<string, string>();
  const missing: WantedText[] = [];
  for (const w of new Map(wanted.map((x) => [x.id, x])).values()) {
    const cached = svc.caches.get<string>("revtext", key(w));
    if (cached === undefined) missing.push(w);
    else texts.set(w.id, cached);
  }
  if (missing.length === 0) return { texts };
  const ops = missing.map((w, i) => revisionTextOp(`r${i + 1}`, ctx.confirmPublic("revision", w.source), o.post));
  const results = await readRevisions(ops, task, ctx, svc);
  let error: Extract<AliasResult, { error: unknown }> | "no page" | undefined;
  missing.forEach((w, i) => {
    const r = results.get(`r${i + 1}`);
    if (r === undefined) return;
    if ("error" in r) {
      if (r.error !== "not_found" && r.error !== "not_public") error ??= r;
      return;
    }
    const result = isRecord(r.data) ? r.data.result : undefined;
    if (!isRecord(result) || result._id !== w.source || result.documentId !== w.docId) return;
    const text = o.post ? postText(result, o.speakers) : typeof result.markdown === "string" ? result.markdown : "";
    if (text === undefined) {
      error ??= "no page";
      return;
    }
    svc.caches.set("revtext", key(w), text);
    texts.set(w.id, text);
  });
  return { texts, ...(error !== undefined && { error }) };
}

/** ¶4.11 step 8, ¶4.12 step 8: at most this many rounds of the phrase search per call, each one request of up to `PROBES` texts. */
const INTRO_ROUNDS = 2;
const PROBES = 10;

/**
 * ¶4.11 step 8, ¶4.12 step 8: the phrase search, `findIntroduction` run one round at a time from the intervals the round before
 * left (`state`, a cursor's, to begin with), at most `INTRO_ROUNDS` rounds and no more than the requests the call has left; the
 * first pass sends nothing (adjacent rows need no text). A round refused by the request cap or the 40 s mark (`stopped`), or
 * whose texts fail (`error`), keeps what the earlier rounds narrowed. Rounds the cap left out, with an interval still open, are a
 * stop too ("request cap").
 */
export async function introductionRounds(
  series: readonly IntroSeries[], fetchTexts: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>, ctx: CallContext, state?: IntroState,
): Promise<{ search: Awaited<ReturnType<typeof findIntroduction>>; stopped?: StopReason; error?: ToolError }> {
  const rounds = Math.max(0, Math.min(INTRO_ROUNDS, ctx.maxRequests - ctx.requestsUsed));
  let search = await findIntroduction(series, fetchTexts, { rounds: 0, probes: PROBES, ...(state !== undefined && { state }) });
  let stopped: StopReason | undefined;
  let error: ToolError | undefined;
  for (let round = 0; round < rounds && Object.keys(search.between).length > 0; round++) {
    try {
      search = await findIntroduction(series, fetchTexts, { rounds: 1, probes: PROBES, state: search.state });
    } catch (e) {
      if (e instanceof CallStopped) stopped = e.reason;
      else if (isToolError(e)) error = e;
      else throw e;
      break;
    }
  }
  if (stopped === undefined && rounds < INTRO_ROUNDS && Object.keys(search.between).length > 0) stopped = "request cap";
  return { search, ...(stopped !== undefined && { stopped }), ...(error !== undefined && { error }) };
}
