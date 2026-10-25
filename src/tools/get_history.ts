// Layer 2. The `get_history` tool (¶4.11) for a post, a comment, a wiki page, a lens or a summary: its publicly visible versions,
// its original, one version's text and the word diff of two. Request 1 reads the document through the resolution aliases of
// ¶3.1.2 (`historyDocOps`), which is also its visibility check (P17): `ids/resolve` reads it, so its outcomes, error wording,
// eviction and negative cache are resolve's; a publicly deleted comment has no public history, so it is refused as `bad_input`
// (P5). The list (request 2 on) is read only for the confirmed document (`PublicDocId`): raw pages of
// 1,000 rows at offsets 0, 1000 and 2000, then keyset windows below the oldest row seen (Q26), until a raw page is not full, the
// call's needs are met, or no request may start (`loadVersions`, cached 10 minutes and extended by later calls). Each page is
// labelled again together with the rows before it (image copies folded, repeated versions marked), and the original is read
// from that labelled list. Texts are fetched only for ids of that visible list, several in one request (`loadTexts`, cached 6
// hours; P17, Q71), and diffs are computed here (Q98). A list page is a `list` stream over the rows fetched so far; a text or a
// diff is a `slice` stream whose state keeps the revision ids it shows, so a continuation shows the same versions. When the
// list cannot be read far enough before the call's cap or its 40 s mark (¶2.2 step 5), the page shows the head lines without
// rows and ends `Stopped early` with a cursor that repeats it. The list's length is never stated from the forum's `totalCount`,
// which only decides whether a raw page was full (P10).
// `phrases` (step 8) checks each phrase in the original (or the earliest public version) and the current text, read together in
// one request, and finds the version that added one by a k-ary search over the visible rows between them, at most 2 rounds per
// call; an interval still open is carried in the cursor as row indexes, with the list's fingerprint, and the continuation runs
// up to 2 more rounds over the same cached list. `user` pages a person's wiki edits (`loadUserWikiEdits`: one light set of at most
// 2,000 rows, sorted here, rows failing P12 (c) dropped whole) as a `list`, the same set `get_user` hands off to.
import { z } from "zod";
import { CONFIG } from "../config";
import { matchInText, processBody } from "../domain/markdown";
import {
  allListed, findIntroduction, labelRevisions, originalOf, toRevisionRecord, wordDiff, type DiffResult, type IntroSeries, type IntroState,
} from "../domain/revisions";
import { isPlaceholder, maskPostRef, maskTagRef, wikiEditPage } from "../domain/visibility";
import { badInput, CallStopped, forumError, internalError, notFound, ToolError } from "../errors";
import { historyDocOps } from "../forum/templates/get_history";
import { revisionListOp, revisionTextOp } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { echoOf, negativeKey, readResolution, resolve } from "../ids/resolve";
import { fingerprint, listPage, sliceAfter, slicePosition } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, driftNote, emptyText, fmtInt, matchLine } from "../render/messages";
import { commentRefText, matchHitItem, placeText, postRefText, revisionLine, tagRefText, wikiEditPageText } from "../render/records";
import { day, isoMs } from "../text/dates";
import { classify, contains } from "../text/phrases";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResult, AliasResults, CallContext, ClassifiedPhrase, Consumed, CursorEntry, CursorState, Fingerprint, Footer, GqlOp, PageItem,
  PageSpec, ParsedRef, PublicDocId, RawCommentRef, RawMdocRef, RawPostRef, RawRevRow, RawTagRef, Resolved, RevisionDoc, RevisionRecord,
  Services, StopReason, StreamState, ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, rowsOf, setting } from "./common";
import { aliasData, loadUserWikiEdits } from "./loaders";

export type GetHistoryParams = {
  post?: string; comment?: string; tag?: string; user?: string; revision?: string; compare_to?: string; phrases?: string[]; match?: string;
  sort: "new" | "old"; limit: number; cursor?: string; max_tokens: number;
};

/** The publicly visible versions of one document, newest first and labelled, and where the list continues when it is not complete. */
interface VersionList {
  doc: RevisionDoc;
  rows: RevisionRecord[];
  /** A raw page that was not full has been read: every public version is listed (¶4.11 step 3). */
  complete: boolean;
  /** The next raw page: an `offset` page, or a keyset window `beforeMs` (exclusive) skipping the `seen` ids at its boundary. */
  next?: { offset?: number; beforeMs?: number; seen: string[] };
}

type ListState = Extract<StreamState, { kind: "list" }>;
type SliceState = Extract<StreamState, { kind: "slice" }>;
type DocParam = "post" | "comment" | "tag";
type Sort = GetHistoryParams["sort"];

/** The document whose history is read: confirmed public (P17), with the field its versions are stored under (R7, §7.1). */
type HistoryDoc = RevisionDoc & { publicId: PublicDocId; fieldName: "contents" | "description" };

/** Request 1's documents, as `historyDocOps` selects them. */
type PostDoc = RawPostRef & { postedAt: string; contents: { version: string; editedAt: string } | null };
type CommentDoc = RawCommentRef & { post: RawPostRef | null; tag: RawTagRef | null };

const TITLE = "How was this edited? What did the original say? What wiki pages did X edit?";
/** ¶4.11, verbatim. */
const DESCRIPTION_QUOTE =
  "Edit history of a post, a comment, or a wiki page's text, or the wiki edits of a person: exactly one of post, comment, tag (a lens slug or summary_id gives that lens's or summary's own history) or user (wiki edits only; post and comment histories are read one post or comment at a time). Without revision: the publicly visible versions, newest first (sort old for oldest first; limit counts versions), each with revision_id, version, date, editor, the forum's own count of characters added and removed (it can differ from the change between the versions listed) and labels such as \"2019 import snapshot\", \"image copy to CDN\", \"before publication\"; plus which version is the original, the one current when the post or comment was published (if the posting date was reset later, that version may already include early edits). With user: their wiki edits, newest first, each with its page (for people with more than 2,000 wiki revisions, only the first 2,000 the forum returns can be ordered, and the last page says so). revision=<revision_id>|original|current returns that version's text (match=<text> keeps only the paragraphs containing it; match ignores accents and punctuation, phrases does not); adding compare_to=<revision_id>|original|previous|current returns the word-level changes between the two versions instead (computed here). phrases=[…] checks each phrase separately in the original and the current text and, if it was added later, finds the first version containing it (assuming it was not removed and re-added); long histories may need the cursor to finish. Limits: texts from before 13 February 2019 exist only as a migration snapshot dated to the original posting time, so their original wording and earlier edits are not available; some later posts' visible history starts after publication (\"published text not available\"); version numbers have gaps and can repeat (always use revision ids); \"all public versions listed\" is never a complete edit timeline; titles have no history.";

const DOC_TASK = "reading the document";
const LIST_TASK = "reading the version list";
const TEXT_TASK = "reading the version texts";

const DOC_PARAMS: readonly DocParam[] = ["post", "comment", "tag"];
/** ¶4.11 Parameters: with `user`, only `sort`, `limit`, `cursor` and `max_tokens` apply; these are refused, in this order. */
const NOT_WITH_USER = ["revision", "compare_to", "phrases", "match"] as const satisfies readonly (keyof GetHistoryParams)[];
/** Request 1's aliases and the bare aliases `ids/resolve` reads them by. */
const RESOLVE_ALIASES: readonly (readonly [string, string])[] = [
  ["p", "p"], ["ps", "s"], ["pl", "l"], ["c", "c"], ["cl", "c"], ["t", "t"], ["m", "m"], ["lp", "b"],
];

const TITLE_CAP = CONFIG.render.caps.title;
const VERSION_CAP = 40;
const SEP = " · ";
const RAW_PAGE = CONFIG.paging.revisionPage;

/** ¶4.11 step 6: `revision` (and `compare_to`) words; the rest are revision ids. */
const REVISION_WORDS = ["original", "current"] as const;
const COMPARE_WORDS = ["original", "previous", "current"] as const;

/** ¶4.11 step 6, P17: an id outside the visible list is refused, never fetched, never placed. */
const NOT_A_VERSION = "not a public version of this text";
const VERSION_FIX = "Use a revision_id from this text's version list, or original or current.";
const COMPARE_FIX = "Use a revision_id from this text's version list, or original, previous or current.";
/** The list can't be read further: the forum's offsets end at 2,000 (¶3.6). */
const UNREACHABLE = "the forum's paging can't reach older versions of this text";
const ORIGINAL_UNREACHABLE = "Original: not determined; older versions are beyond the forum's paging";
const EMPTY_TEXT = "This version has no text.";
/** ¶4.11 Errors and empty results: a document whose every stored row is hidden. */
const NO_VERSIONS = emptyText({ kind: "subject", what: "versions of", subject: "this text" });

/** ¶4.11 step 8: at most this many rounds of the phrase search per call, each one request of up to `PROBES` texts. */
const PHRASE_ROUNDS = 2;
const PROBES = 10;
/** ¶4.11 step 8: the verdict of a phrase found in the original, by what the original is. */
const AT_PUBLICATION = "present at publication";
const IN_SNAPSHOT = "present in the oldest kept text (a February-2019 snapshot); original wording not recorded";
const IN_OLDEST = "present in the oldest public version";
const IN_NEITHER = "not in the original or the current text";
const NOT_READDED = "assuming it was not removed and re-added";
/** The `next:` text of a phrase search that continues. */
const NEXT_ROUNDS = "the phrase search, 2 more rounds";

/** ¶4.11 step 2: the end of a person's wiki edits when the second raw page was also full. */
const OVER_2000 =
  "this person has more than 2,000 wiki revisions, and the forum's order for them is not documented; only the first 2,000 it returns are listed, newest first";

const quoted = (s: string | null | undefined): string => `"${oneLine(s, TITLE_CAP)}"`;
const versionText = (v: string): string => `v${oneLine(v, VERSION_CAP)}`;
/** An ISO time as `get_history` prints every time (`YYYY-MM-DDTHH:MM:SS.SSSZ`); undefined for an unreadable one. */
function timeText(iso: string | null | undefined): string | undefined {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? isoMs(ms) : undefined;
}

// the version list (steps 2–5)

/** The `rev` cache entry: the labelled rows, where the list continues, and when its first page was read. */
interface StoredVersions { rows: RevisionRecord[]; complete: boolean; next?: VersionList["next"]; fetchedAt: number }

/** Whether the list can be read no further: every public version is listed, or the forum's paging cannot reach the rest. */
function exhausted(list: VersionList): boolean {
  return list.complete || list.next === undefined;
}

/** ¶4.11 Ordering: `editedAt`, newer first, ties by id descending. */
function newestFirst(a: RevisionRecord, b: RevisionRecord): number {
  if (a.editedMs !== b.editedMs) return b.editedMs - a.editedMs;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** ¶4.11 Ordering for `sort: old`: `editedAt`, older first, ties by id descending. */
function oldestFirst(rows: readonly RevisionRecord[]): RevisionRecord[] {
  return [...rows].sort((a, b) => (a.editedMs !== b.editedMs ? a.editedMs - b.editedMs : newestFirst(a, b)));
}

/** The request for the raw page `next` names: an offset page (`l`), or a keyset window (`k`, Q26). */
function pageOp(doc: HistoryDoc, next: NonNullable<VersionList["next"]>): GqlOp {
  if (next.beforeMs === undefined) return revisionListOp("l", doc.publicId, doc.fieldName, { offset: next.offset ?? 0, enableTotal: true });
  return revisionListOp("k", doc.publicId, doc.fieldName, {
    before: isoMs(next.beforeMs), ...(next.offset ? { offset: next.offset } : {}), enableTotal: true,
  });
}

/** The ids at instant `ms` among the listed rows and a raw page's rows (image copies folded away included). */
function idsAt(ms: number, rows: readonly RevisionRecord[], raw: readonly RawRevRow[]): string[] {
  const listed = rows.filter((r) => r.editedMs === ms).map((r) => r.id);
  return [...new Set([...listed, ...raw.filter((r) => Date.parse(r.editedAt) === ms).map((r) => r._id)])];
}

/**
 * Where the list continues after a full raw page `raw` read at `at` (¶4.11 step 3, Q26): the next offset up to 2,000, then a
 * keyset window `before: <oldest editedAt seen> + 1 ms` that skips the ids already seen at that instant; a window whose page
 * moved below its bound no further is paged by offset inside it. `undefined` when no request can reach more.
 */
function advance(at: NonNullable<VersionList["next"]>, raw: readonly RawRevRow[], rows: readonly RevisionRecord[]): VersionList["next"] {
  const window = (oldest: number): VersionList["next"] => ({ beforeMs: oldest + 1, seen: idsAt(oldest, rows, raw) });
  const offset = (at.offset ?? 0) + RAW_PAGE;
  const bound = at.beforeMs;
  if (bound === undefined) {
    if (offset <= CONFIG.paging.maxOffset) return { offset, seen: [] };
    const oldest = rows.at(-1)?.editedMs;
    return oldest === undefined ? undefined : window(oldest);
  }
  const older = raw.map((r) => Date.parse(r.editedAt)).filter((t) => Number.isFinite(t) && t < bound - 1);
  if (older.length > 0) return window(Math.min(...older));
  return offset <= CONFIG.paging.maxOffset ? { beforeMs: bound, offset, seen: at.seen } : undefined;
}

/**
 * ¶4.11 steps 2–5: the publicly visible versions of a confirmed document, newest first and labelled. The list comes from the
 * `rev` cache (key `<docId>:<fieldName>`, 10 minutes from its first page) and is read further only as far as `opts` need:
 * `untilId` until that row is listed, `untilOriginal` until the original is determined, `minRows` until that many rows, `all`
 * until complete; with no option, the first page when nothing is cached. Reading stops at the first raw page that is not full
 * (`complete`), or as soon as no request may start (the call's cap or its 40 s mark): the rows read so far are kept, and a
 * later call extends them. Every page is labelled together with the rows before it.
 */
async function loadVersions(
  doc: RevisionDoc & { publicId: PublicDocId; fieldName: "contents" | "description" }, ctx: CallContext, svc: Services,
  opts: { untilId?: string; untilOriginal?: boolean; minRows?: number; all?: boolean } = {},
): Promise<VersionList> {
  const key = `${doc.id}:${doc.fieldName}`;
  const stored = svc.caches.get<StoredVersions>("rev", key);
  // Labelled again on reading: idempotent, and it applies this call's document (P7: no editor on a hideAuthor document).
  let rows = stored === undefined ? [] : labelRevisions(stored.rows, doc);
  let complete = stored?.complete ?? false;
  let next: VersionList["next"] = stored === undefined ? { offset: 0, seen: [] } : stored.next;
  const fetchedAt = stored?.fetchedAt ?? svc.now();
  let read = stored !== undefined;
  const wanted = (): boolean =>
    !read ||
    opts.all === true ||
    (opts.untilId !== undefined && !rows.some((r) => r.id === opts.untilId)) ||
    (opts.untilOriginal === true && originalOf(rows, doc, complete).status === "not yet") ||
    (opts.minRows !== undefined && rows.length < opts.minRows);

  while (!complete && next !== undefined && wanted()) {
    if (!ctx.mayStartRequest()) break;
    const op = pageOp(doc, next);
    let data: unknown;
    try {
      data = aliasData(await svc.gql([op], ctx, LIST_TASK), op.alias, LIST_TASK, ctx);
    } catch (e) {
      if (e instanceof CallStopped) break;
      throw e;
    }
    const raw = rowsOf<RawRevRow>(data);
    const totalCount = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : null;
    const seen = new Set([...rows.map((r) => r.id), ...next.seen]);
    const fresh = raw.filter((r) => !seen.has(r._id)).map((r) => toRevisionRecord(r, doc));
    rows = labelRevisions([...rows, ...fresh].sort(newestFirst), doc);
    if (allListed({ rows: raw.length, limit: RAW_PAGE, totalCount })) {
      complete = true;
      next = undefined;
    } else {
      next = advance(next, raw, rows);
    }
    read = true;
    const ttl = Math.max(1, CONFIG.cache.ttlMs.rev - (svc.now() - fetchedAt));
    svc.caches.set<StoredVersions>("rev", key, { rows, complete, ...(next !== undefined && { next }), fetchedAt }, ttl);
  }
  return { doc, rows, complete, ...(next !== undefined && { next }) };
}

/**
 * ¶4.11 step 6, P17, Q71: the Markdown of revisions `ids`, each one of `list.rows` (anything else is a bug of the caller, refused
 * before anything is sent). Cached texts (`revtext`, 6 hours) cost nothing; the rest are fetched in one request, `r1`…`rN` in
 * the order given. A revision the forum no longer returns, or one of another document, is left out of the map.
 */
export async function loadTexts(ids: readonly string[], list: VersionList, ctx: CallContext, svc: Services): Promise<ReadonlyMap<string, string>> {
  const visible = new Set(list.rows.map((r) => r.id));
  if (ids.some((id) => !visible.has(id))) throw internalError("get_history", "revision text requested outside the visible list");
  const texts = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const cached = svc.caches.get<string>("revtext", id);
    if (cached === undefined) missing.push(id);
    else texts.set(id, cached);
  }
  if (missing.length === 0) return texts;
  const ops = missing.map((id, i) => revisionTextOp(`r${i + 1}`, ctx.confirmPublic("revision", id)));
  const results = await svc.gql(ops, ctx, TEXT_TASK);
  missing.forEach((id, i) => {
    const data = aliasData(results, `r${i + 1}`, TEXT_TASK, ctx);
    const result = isRecord(data) ? data.result : undefined;
    if (!isRecord(result) || result._id !== id || result.documentId !== list.doc.id) return;
    const markdown = typeof result.markdown === "string" ? result.markdown : "";
    svc.caches.set("revtext", id, markdown);
    texts.set(id, markdown);
  });
  return texts;
}

// request 1: the document (step 1)

/** What request 1 opened: the document, how it is named, and the version it reports as current (a post's `contents`). */
interface Opened {
  doc: HistoryDoc;
  /** `post "<title>" (post_id …, LW only)`, `comment comment_id … (AF) on …`, `wiki page "…" (tag_slug …)`, `lens "…" (…) of …`. */
  subject: string;
  /** The title line's subject: the subject without its parenthesized facts (`post "<title>"`). */
  title: string;
  /** The request-echo item of the document. */
  echo: string;
  current?: { version: string; editedAt: string };
}

/** Request 1's answers under the bare aliases `ids/resolve` reads. */
function resolveAnswers(results: AliasResults): AliasResults {
  const answers = new Map<string, AliasResult>();
  for (const [from, to] of RESOLVE_ALIASES) {
    const answer = results.get(from);
    if (answer !== undefined) answers.set(to, answer);
  }
  return answers;
}

/** P1: a comment's place, by `tagId` first; a hidden post or page is named by nothing. */
function commentPlace(c: CommentDoc): string {
  if (c.tagId != null) {
    const tag = maskTagRef(c.tag);
    return placeText(tag.hidden ? { kind: "hidden tag" } : { kind: "tag", tag });
  }
  const post = maskPostRef(c.post);
  return placeText(post.hidden ? { kind: "hidden post" } : { kind: "post", post });
}

/** The parse notes of the caller's reference, after ` · `, as `echoOf` prints notes. */
const notesOf = (ref: ParsedRef): string => (ref.notes.length > 0 ? `${SEP}${ref.notes.join(SEP)}` : "");

/**
 * Step 1's outcomes once `ids/resolve` found a publicly visible document: a post or comment with its publication time and
 * `hideAuthor` (P7), a page with its `description`, a lens or summary (its own `contents`) named under its page (P12). A
 * publicly deleted comment is a placeholder: public, but its history is not (P5).
 */
function openedFrom(param: DocParam, ref: ParsedRef, resolved: Resolved, ctx: CallContext): Opened {
  const open = (doc: RevisionDoc, fieldName: HistoryDoc["fieldName"], named: Omit<Opened, "doc">): Opened => ({
    doc: { ...doc, publicId: ctx.confirmPublic("doc", doc.id), fieldName }, ...named,
  });
  switch (resolved.kind) {
    case "post": {
      const d = resolved.doc as PostDoc;
      const post = maskPostRef(d);
      if (post.hidden) throw internalError("get_history", "a resolved post that is not public");
      return open({ kind: "post", id: d._id, hideAuthor: d.hideAuthor, postedAt: d.postedAt, af: d.af }, "contents", {
        subject: `post ${postRefText(post)}`, title: `post ${quoted(d.title)}`, echo: echoOf(param, resolved),
        ...(d.contents != null && { current: { version: d.contents.version, editedAt: d.contents.editedAt } }),
      });
    }
    case "comment": {
      const c = resolved.doc as CommentDoc;
      if (isPlaceholder(c)) throw badInput("comment", "this comment has no public history");
      return open({ kind: "comment", id: c._id, hideAuthor: c.hideAuthor, postedAt: c.postedAt, af: c.af }, "contents", {
        subject: `comment ${commentRefText({ id: c._id, af: c.af })} ${commentPlace(c)}`, title: `comment comment_id ${c._id}`,
        echo: echoOf(param, resolved),
      });
    }
    case "tag": {
      const t = resolved.doc as RawTagRef;
      const page = maskTagRef(t);
      if (page.hidden) throw internalError("get_history", "a resolved wiki page that is not public");
      return open({ kind: "tag", id: t._id, hideAuthor: false }, "description", {
        subject: `wiki page ${tagRefText(page)}`, title: `wiki page ${quoted(t.name)}`, echo: echoOf(param, resolved),
      });
    }
    case "lens":
    case "summary": {
      // ¶4.11 step 1, P12: a lens's or summary's own history, named under its page as a wiki edit of it is (¶4.7 step 6).
      const m = resolved.doc as RawMdocRef;
      const lens = resolved.kind === "lens";
      const part = wikiEditPage({ collectionName: "MultiDocuments", tag: null, lens: lens ? m : null, summary: lens ? null : m });
      if (part === undefined) throw internalError("get_history", `a resolved ${resolved.kind} without a public page`);
      const subject = wikiEditPageText(part);
      return open({ kind: resolved.kind, id: m._id, hideAuthor: false }, "contents", {
        subject, title: part.part === "lens" ? `lens ${quoted(part.lens?.title)}` : "summary", echo: `tag → ${subject}${notesOf(ref)}`,
      });
    }
    default:
      throw internalError("get_history", `a ${resolved.kind} is not a document with a history`);
  }
}

/**
 * Request 1 (step 1): the document through its resolution aliases; a remembered `not_found` or `not_public` costs no request.
 * Unknown or hidden → `not_found`, refused → `not_public` (resolve's wording, eviction and negative cache).
 */
async function openDocument(param: DocParam, ref: ParsedRef, ctx: CallContext, svc: Services): Promise<Opened> {
  const negative = svc.caches.get<{ category: ToolError["category"]; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const results = await svc.gql(historyDocOps(ref, param), ctx, DOC_TASK);
  return openedFrom(param, ref, readResolution(ref, param, "", resolveAnswers(results), ctx, svc), ctx);
}

// what was asked

/**
 * The parameters that shape a page, stored in its cursor; `revision` and `compareTo` as parsed (a word, or a revision id), each
 * phrase as ¶3.2.1 classifies it.
 */
interface Ask { revision?: string; compareTo?: string; phrases?: readonly ClassifiedPhrase[]; match?: string; sort: Sort; limit: number }

/** ¶3.2.1 rules 1–5 and 7, before any request: each phrase classified (loose phrases are fine: the check is local). */
function classified(phrases: readonly string[] | undefined): ClassifiedPhrase[] | undefined {
  return phrases?.map((phrase) => classify(phrase, "phrases"));
}

/** A phrase as a cursor compares it: as classified (rule 1), so a phrase given again with other quote marks still matches. */
const givenOf = (phrases: readonly ClassifiedPhrase[] | undefined): string[] | undefined => phrases?.map((phrase) => phrase.given);

function effectiveOf(param: DocParam, docId: string, ask: Ask): Record<string, unknown> {
  return {
    post: param === "post" ? docId : undefined, comment: param === "comment" ? docId : undefined, tag: param === "tag" ? docId : undefined,
    user: undefined, revision: ask.revision, compare_to: ask.compareTo, phrases: givenOf(ask.phrases), match: ask.match, sort: ask.sort,
    limit: ask.limit,
  };
}

/**
 * ¶3.6: the effective values of a `get_history {user}` cursor, which `get_user`'s hand-off mints too: the person's id, `sort` and
 * `limit`; every other parameter but `cursor` and `max_tokens` is an own key left undefined, so one given again is compared.
 */
export function historyUserEffective(p: GetHistoryParams, userId: string): Record<string, unknown> {
  return {
    post: undefined, comment: undefined, tag: undefined, user: userId, revision: undefined, compare_to: undefined, phrases: undefined,
    match: undefined, sort: p.sort, limit: p.limit,
  };
}

function parseRevision(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseRef("revision", value, ["revision"], { words: REVISION_WORDS }).value;
}

function parseCompareTo(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseRef("compare_to", value, ["revision"], { words: COMPARE_WORDS }).value;
}

/** ¶4.11 Parameters, in this order, before any request. */
function checkRules(p: GetHistoryParams): void {
  if (p.user !== undefined) {
    const refused = NOT_WITH_USER.find((name) => p[name] !== undefined);
    if (refused !== undefined) {
      throw badInput(refused, "not available with user (a person's wiki edits)", "Use only sort, limit, cursor and max_tokens with user.");
    }
  }
  if (p.phrases !== undefined && (p.revision !== undefined || p.compare_to !== undefined)) {
    throw badInput("phrases", "can't be combined with revision or compare_to", "Leave revision out to check phrases.");
  }
  if (p.compare_to !== undefined && p.revision === undefined) {
    throw badInput("compare_to", "needs revision", 'Give revision too, e.g. revision: "original", compare_to: "current".');
  }
  if (p.match !== undefined && p.compare_to !== undefined) {
    throw badInput("match", "can't be combined with compare_to", "Use match with revision alone.");
  }
  if (p.match !== undefined && p.revision === undefined) {
    throw badInput("match", "needs revision", "Give revision to search one version's text.");
  }
}

/**
 * ¶3.7 request echo: the document as resolved, the revision parameters and phrases when given, `sort` and `limit` for a version
 * list.
 */
function requestEcho(o: Opened, ask: Ask, echo: CallContext): string[] {
  const out = [o.echo];
  if (ask.revision !== undefined) out.push(`revision ${ask.revision}`);
  if (ask.compareTo !== undefined) out.push(`compare_to ${ask.compareTo}`);
  if (ask.phrases !== undefined) out.push(`phrases ${ask.phrases.map((phrase) => `"${phrase.given}"`).join(", ")}`);
  if (ask.match !== undefined) out.push(`match "${oneLine(ask.match, 200)}"`);
  if (ask.revision === undefined && ask.phrases === undefined) out.push(setting(echo, "sort", ask.sort), setting(echo, "limit", ask.limit));
  return out;
}

/** One call's page inputs. */
interface PageInput {
  opened: Opened;
  ask: Ask;
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

function cursorFor(svc: Services, x: PageInput, state: CursorState): string {
  return mint(svc, "get_history", x.args, x.effective, state);
}

// the head lines

/** `History of <subject> · published <time> · current v<version> (<time>)`: the published time of posts and comments. */
function historyLine(o: Opened, list: VersionList): string {
  const parts = [`History of ${o.subject}`];
  const published = timeText(o.doc.postedAt);
  if (published !== undefined) parts.push(`published ${published}`);
  // A post reports its current version itself; anything else, by its newest visible row.
  const newest = list.rows[0];
  const current = o.current ?? (newest === undefined ? undefined : { version: newest.version, editedAt: newest.editedAt });
  if (current !== undefined) {
    const at = timeText(current.editedAt);
    parts.push(`current ${versionText(current.version)}${at === undefined ? "" : ` (${at})`}`);
  }
  return parts.join(SEP);
}

/** `revision_id … · v… · <time>`. */
const rowRef = (r: RevisionRecord): string => `revision_id ${r.id}${SEP}${versionText(r.version)}${SEP}${isoMs(r.editedMs)}`;

/** ¶4.11 step 5: the earliest public version of a text whose published version is not public. */
function notAvailable(earliest: RevisionRecord): string {
  return `Original: published text not available: the earliest public version (${versionText(earliest.version)}, ${isoMs(earliest.editedMs)}) is from after publication`;
}

/**
 * ¶4.11 step 5: the original of a list still being read is found by `revision: "original"`, which reads on until it is
 * determined; the list's cursor pages the versions, not the original.
 */
function originalPointer(o: Opened): string {
  const param: DocParam = o.doc.kind === "post" || o.doc.kind === "comment" ? o.doc.kind : "tag";
  return `Original: not determined yet; get_history {${param}: ${JSON.stringify(o.doc.id)}, revision: "original"} reads further`;
}

/** The original as `originalOf` determines it from the labelled list, and whether it is a 2019 snapshot. */
function originalLine(o: Opened, list: VersionList): { line?: string; snapshot: boolean } {
  const result = originalOf(list.rows, o.doc, list.complete);
  switch (result.status) {
    case "found": {
      const label = o.doc.postedAt !== undefined ? "Original (as published)" : "Original (oldest public version)";
      return { line: `${label}: ${rowRef(result.row)}`, snapshot: result.snapshot };
    }
    case "not yet":
      return { line: exhausted(list) ? ORIGINAL_UNREACHABLE : originalPointer(o), snapshot: false };
    case "not available":
      return { ...(result.earliest !== undefined && { line: notAvailable(result.earliest) }), snapshot: false };
  }
}

/** `N public versions (k automatic image copies folded in) · all public versions listed · newest first`, or `… fetched so far …`. */
function countLine(list: VersionList, sort: Sort): string {
  const n = list.rows.length;
  const versions = `${fmtInt(n)} public version${n === 1 ? "" : "s"}`;
  const dir = sort === "old" ? "oldest first" : "newest first";
  if (!list.complete) return `${versions} fetched so far${SEP}${dir}`;
  const folded = list.rows.reduce((sum, r) => sum + r.cdnCopiesFolded, 0);
  const copies = folded === 0 ? "" : ` (${fmtInt(folded)} automatic image ${folded === 1 ? "copy" : "copies"} folded in)`;
  return `${versions}${copies}${SEP}all public versions listed${SEP}${dir}`;
}

const isSnapshot = (r: RevisionRecord): boolean => r.labels.includes("2019 import snapshot");

// the version list (no revision)

async function listMode(x: PageInput, state: ListState | undefined, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { opened, ask } = x;
  const index = state?.index ?? 0;
  // `sort: old` needs the whole list; `new` only the rows of this page (not more, to settle the original).
  const list = await loadVersions(opened.doc, ctx, svc, ask.sort === "old" ? { all: true } : { minRows: index + ask.limit });
  const original = originalLine(opened, list);
  const head = [historyLine(opened, list), ...(original.line === undefined ? [] : [original.line]), countLine(list, ask.sort)];
  const request = requestEcho(opened, ask, x.echo);
  // The fingerprint (drift) is taken only over a complete list: one still being read grows by design.
  const first0: ListState = state ?? { kind: "list", shown: 0, index: 0 };

  // ¶2.2 step 5: the rows this page needs were not read before the call's cap or its 40 s mark.
  if (!exhausted(list) && (ask.sort === "old" || list.rows.length < index + ask.limit)) {
    const cursor = cursorFor(svc, x, { streams: [first0], current: 0 });
    return reply({ tool: "get_history", subject: opened.title, request, notes: [], head, items: [] }, maxTokens, svc, () => ({
      kind: "stopped", why: ctx.stopped ?? "time limit", tool: "get_history", cursor,
    }));
  }

  const ordered = ask.sort === "old" ? oldestFirst(list.rows) : list.rows;
  const page = listPage(ordered, state, ask.limit, (r) => r.id, list.complete ? (r) => r.editedMs : undefined);
  const shown0 = state?.shown ?? 0;
  const count = page.items.length;
  const total = list.complete ? ordered.length : undefined;
  const ended = exhausted(list);
  // No version at all is said only of a complete list; one the forum's paging cannot reach further ends with that footer alone.
  const empty = list.rows.length === 0 && list.complete ? [NO_VERSIONS] : [];
  const notes = [
    ...(count > 0 ? [CAVEAT["C-CHANGEMETRICS"]] : []),
    ...(original.snapshot || page.items.some(isSnapshot) ? [CAVEAT["C-PRE2019"]] : []),
    ...(page.driftNote === undefined ? [] : [page.driftNote]),
  ];
  const position = count === 0
    ? undefined
    : (c: Consumed): string => positionText("items", shown0 + 1, shown0 + Math.max(1, Math.min(c.items, count)), total);
  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, count);
    if (n === count && page.ended && ended) return list.complete ? { kind: "end" } : { kind: "reachable", reason: UNREACHABLE };
    const at = n === 0 ? first0 : (page.after[n - 1] as ListState);
    const to = shown0 + n + ask.limit;
    return {
      kind: "more", tool: "get_history", cursor: cursorFor(svc, x, { streams: [at], current: 0 }),
      next: nextText("items", shown0 + n + 1, total === undefined ? to : Math.min(to, total)),
    };
  };
  return reply(
    {
      tool: "get_history", subject: opened.title, request, ...(position !== undefined && { position }),
      oneItem: shown0 === 0 && count === 1 && page.ended && ended, notes, head: [...head, ...empty],
      items: page.items.map((r) => ({ text: revisionLine(r) })),
    },
    maxTokens, svc, footerFor,
  );
}

// texts and diffs (steps 6–7)

/** How a revision parameter came out: its row, a stop before the list reached it, or a line to show instead of a text. */
type Located =
  | { kind: "row"; row: RevisionRecord; list: VersionList }
  | { kind: "stopped"; list: VersionList }
  | { kind: "line"; line: string; list: VersionList };

/** The row of `revision` or `compare_to`: `current`, `original`, or a revision id, looked up only in the visible list (P17). */
async function locate(o: Opened, param: "revision" | "compare_to", value: string, ctx: CallContext, svc: Services): Promise<Located> {
  if (value === "current") {
    const list = await loadVersions(o.doc, ctx, svc);
    const row = list.rows[0];
    if (row !== undefined) return { kind: "row", row, list };
    return exhausted(list) ? { kind: "line", line: NO_VERSIONS, list } : { kind: "stopped", list };
  }
  if (value === "original") {
    const list = await loadVersions(o.doc, ctx, svc, { untilOriginal: true });
    const result = originalOf(list.rows, o.doc, list.complete);
    if (result.status === "found") return { kind: "row", row: result.row, list };
    if (result.status === "not available") {
      return { kind: "line", line: result.earliest === undefined ? NO_VERSIONS : notAvailable(result.earliest), list };
    }
    return exhausted(list) ? { kind: "line", line: ORIGINAL_UNREACHABLE, list } : { kind: "stopped", list };
  }
  const list = await loadVersions(o.doc, ctx, svc, { untilId: value });
  const row = list.rows.find((r) => r.id === value);
  if (row !== undefined) return { kind: "row", row, list };
  if (!exhausted(list)) return { kind: "stopped", list };
  throw badInput(param, NOT_A_VERSION, param === "revision" ? VERSION_FIX : COMPARE_FIX);
}

/** `compare_to: previous`: the next older visible row after `row`, reading the list further when `row` is its last row so far. */
async function previousOf(o: Opened, row: RevisionRecord, list: VersionList, ctx: CallContext, svc: Services): Promise<Located> {
  const at = list.rows.findIndex((r) => r.id === row.id);
  const older = at >= 0 ? list.rows[at + 1] : undefined;
  if (older !== undefined) return { kind: "row", row: older, list };
  const longer = await loadVersions(o.doc, ctx, svc, { minRows: at + 2 });
  const again = longer.rows.findIndex((r) => r.id === row.id);
  const found = again >= 0 ? longer.rows[again + 1] : undefined;
  if (found !== undefined) return { kind: "row", row: found, list: longer };
  if (!exhausted(longer)) return { kind: "stopped", list: longer };
  throw badInput("compare_to", `no public version is older than revision_id ${row.id}`, VERSION_FIX);
}

/** A text as shown (¶3.7 clean-up: widgets and `data:` images replaced; no suggestion removal without the HTML, P15). */
function cleanText(markdown: string, version: string): string {
  return blockText(processBody({ markdown, dialogue: false, version }).md);
}

/** ¶4.11 step 7: the changed paragraphs, each region after its context paragraph, regions apart by a `…` line. */
function diffText(d: DiffResult): string {
  const parts: string[] = [];
  d.paragraphs.forEach((p, i) => {
    if (i > 0 && p.context !== undefined) parts.push("…");
    if (p.context !== undefined) parts.push(p.context);
    parts.push(p.text);
  });
  return parts.join("\n\n");
}

/** What a text or diff page shows: its rows (one, or the base and the other), the head lines and the items. */
interface Shown { rows: RevisionRecord[]; head: string[]; items: PageItem[] }

/** Text mode: the version's revision line and its text, fenced, or the paragraphs `match` keeps. */
function textShown(row: RevisionRecord, markdown: string, match: string | undefined): Shown {
  const text = cleanText(markdown, row.version);
  const head = [revisionLine(row)];
  if (match !== undefined) {
    const { total, hits } = matchInText(text, match);
    return { rows: [row], head: [...head, matchLine(hits.length, total, "paragraphs", match)], items: hits.map(matchHitItem) };
  }
  if (text.trim() === "") return { rows: [row], head: [...head, EMPTY_TEXT], items: [] };
  return { rows: [row], head, items: [{ text, fence: `revision_id ${row.id}, ${versionText(row.version)}` }] };
}

/** Diff mode: both revision lines, the summary against the older version, and the changed paragraphs in one fenced item. */
function diffShown(a: RevisionRecord, b: RevisionRecord, texts: ReadonlyMap<string, string>): Shown {
  const [base, other] = newestFirst(a, b) > 0 ? [a, b] : [b, a];
  const rows = base.id === other.id ? [base] : [base, other];
  const d = wordDiff(cleanText(texts.get(base.id)!, base.version), cleanText(texts.get(other.id)!, other.version));
  const paragraphs = `${fmtInt(d.changed)} paragraph${d.changed === 1 ? "" : "s"} changed`;
  const summary = `+${fmtInt(d.added)} / −${fmtInt(d.removed)} words against ${versionText(base.version)}, ${paragraphs}`;
  const items = d.changed === 0 ? [] : [{ text: diffText(d), fence: `diff ${versionText(base.version)} → ${versionText(other.version)}` }];
  return { rows, head: [...rows.map(revisionLine), summary], items };
}

/** The revision ids a text or diff page shows, kept in its cursor so that a continuation shows the same versions. */
interface TextIds { rev: string; cmp?: string }

/** The part of a text or diff page below its head lines. */
type TextBody = Pick<PageSpec, "notes" | "items" | "position">;

function textIdsOf(data: unknown): TextIds | undefined {
  if (!isRecord(data) || typeof data.rev !== "string") return undefined;
  return { rev: data.rev, ...(typeof data.cmp === "string" && { cmp: data.cmp }) };
}

async function textMode(x: PageInput, start: SliceState | undefined, ids: TextIds | undefined, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { opened, ask } = x;
  const request = requestEcho(opened, ask, x.echo);
  /** One page: the history line and `lines`, then the text `body` gives (none by default). */
  const page = (list: VersionList, lines: readonly string[], footerFor: (c: Consumed) => Footer, body: TextBody = { notes: [], items: [] }): ToolOutput =>
    reply({ tool: "get_history", subject: opened.title, request, ...body, head: [historyLine(opened, list), ...lines] }, maxTokens, svc, footerFor);
  const end = (): Footer => ({ kind: "end" });
  // A stop shows the head and continues where this page started: its versions are looked up again.
  const stopped = (list: VersionList): ToolOutput =>
    page(list, [], () => ({
      kind: "stopped", why: ctx.stopped ?? "time limit", tool: "get_history",
      cursor: cursorFor(svc, x, { streams: [{ kind: "slice", shown: 0, block: 0, offset: 0 }], current: 0 }),
    }));
  const notAVersion = (i: number): ToolError => (i === 0 ? badInput("revision", NOT_A_VERSION, VERSION_FIX) : badInput("compare_to", NOT_A_VERSION, COMPARE_FIX));

  // A continuation names its versions by id; a first page by the caller's words or ids.
  const first = await locate(opened, "revision", ids?.rev ?? ask.revision!, ctx, svc);
  if (first.kind === "stopped") return stopped(first.list);
  if (first.kind === "line") return page(first.list, [first.line], end);
  let second: Located | undefined;
  const compareTo = ids?.cmp ?? ask.compareTo;
  if (compareTo !== undefined) {
    second = compareTo === "previous"
      ? await previousOf(opened, first.row, first.list, ctx, svc)
      : await locate(opened, "compare_to", compareTo, ctx, svc);
    if (second.kind === "stopped") return stopped(second.list);
    if (second.kind === "line") return page(second.list, [second.line], end);
  }
  // The list may have grown while the second row was looked up; both rows must still be listed (an image copy folds away).
  const list = second?.list ?? first.list;
  const rows = [first.row, ...(second?.kind === "row" ? [second.row] : [])];
  rows.forEach((r, i) => {
    if (!list.rows.some((l) => l.id === r.id)) throw notAVersion(i);
  });

  let texts: ReadonlyMap<string, string>;
  try {
    texts = await loadTexts(rows.map((r) => r.id), list, ctx, svc);
  } catch (e) {
    if (e instanceof CallStopped) return stopped(list);
    throw e;
  }
  rows.forEach((r, i) => {
    if (!texts.has(r.id)) throw notAVersion(i);
  });
  const shown = rows.length === 1 ? textShown(rows[0]!, texts.get(rows[0]!.id)!, ask.match) : diffShown(rows[0]!, rows[1]!, texts);
  const notes = [CAVEAT["C-CHANGEMETRICS"], ...(shown.rows.some(isSnapshot) ? [CAVEAT["C-PRE2019"]] : [])];
  const kept: TextIds = { rev: first.row.id, ...(rows[1] !== undefined && { cmp: rows[1].id }) };
  const slice = slicePosition(shown.items, start);
  const footerFor = (c: Consumed): Footer => {
    const next = sliceAfter(c, start, shown.items.length, kept.rev);
    if (next === undefined) return { kind: "end" };
    const cursor = cursorFor(svc, x, { streams: [next], current: 0, data: { ...kept } });
    return { kind: "more", tool: "get_history", cursor, next: slice.next(c) };
  };
  return page(list, shown.head, footerFor, { notes, items: slice.items, ...(slice.position !== undefined && { position: slice.position }) });
}

// phrases (step 8)

/** What a phrase-search cursor carries: the version list's fingerprint and each phrase's interval (row indexes, never text). */
interface PhraseCursor { fingerprint?: Fingerprint; intervals?: unknown }

const sameFingerprint = (a: Fingerprint, b: Fingerprint): boolean => a.count === b.count && a.newestMs === b.newestMs;

/**
 * The cursor's intervals when they still index `rows` (the visible rows from the original to the current one, oldest first): the
 * list's fingerprint is unchanged and every interval lies inside it; otherwise undefined, and the search starts again.
 */
function carriedIntervals(cont: PhraseCursor | undefined, now: Fingerprint, rows: number): IntroState | undefined {
  if (cont?.fingerprint === undefined || !sameFingerprint(cont.fingerprint, now) || !isRecord(cont.intervals)) return undefined;
  const state: IntroState = {};
  for (const [key, interval] of Object.entries(cont.intervals)) {
    if (!isRecord(interval)) return undefined;
    const { lo, hi } = interval;
    if (typeof lo !== "number" || typeof hi !== "number" || !Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
    if (lo < 0 || lo >= hi || hi >= rows) return undefined;
    state[key] = { lo, hi };
  }
  return state;
}

/** A phrase search's cursor state: one `list` stream with the list's fingerprint, and the intervals once the search has begun. */
function phraseState(fp: Fingerprint | undefined, intervals: unknown): CursorState {
  return {
    streams: [{ kind: "list", shown: 0, index: 0, ...(fp !== undefined && { fingerprint: fp }) }],
    current: 0,
    ...(intervals !== undefined && { data: { intervals } }),
  };
}

/**
 * ¶4.11 step 8: each phrase checked (rule 6, exact) in the original and the current text, read in one request; for a phrase
 * absent from the original and present now, the first version containing it, by `findIntroduction` over the visible rows from
 * the original to the current one, at most 2 rounds per call (fewer near the call's request cap). An interval still open is
 * carried in the cursor (`data.intervals`, with the list's fingerprint, so that a changed list starts the search again); a stop
 * during the rounds keeps the intervals from before them. Without a public original (a history that starts after publication),
 * the earliest public version stands in for it, and the page says so.
 */
async function phraseMode(x: PageInput, cont: PhraseCursor | undefined, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { opened, ask } = x;
  const doc = opened.doc;
  const phrases = ask.phrases ?? [];
  const checked = `Phrases checked in ${opened.subject}:`;
  const page = (head: readonly string[], notes: readonly string[], footerFor: (c: Consumed) => Footer): ToolOutput =>
    reply({ tool: "get_history", subject: opened.title, request: requestEcho(opened, ask, x.echo), notes, head, items: [] }, maxTokens, svc, footerFor);
  // A stop before the search goes on keeps the cursor's own state, so that the intervals found so far are not lost.
  const stopped = (why: StopReason): ToolOutput => {
    const cursor = cursorFor(svc, x, phraseState(cont?.fingerprint, cont?.intervals));
    return page([checked], [], () => ({ kind: "stopped", why, tool: "get_history", cursor }));
  };

  const list = await loadVersions(doc, ctx, svc, { untilOriginal: true });
  const original = originalOf(list.rows, doc, list.complete);
  let baseline: RevisionRecord;
  let inBaseline: string;
  const unavailable: string[] = [];
  switch (original.status) {
    case "found":
      baseline = original.row;
      inBaseline = original.snapshot ? IN_SNAPSHOT : doc.postedAt === undefined ? IN_OLDEST : AT_PUBLICATION;
      break;
    case "not available":
      if (original.earliest === undefined) return page([checked, NO_VERSIONS], [], () => ({ kind: "end" }));
      baseline = original.earliest;
      inBaseline = `present in the earliest public version (${versionText(baseline.version)}, after publication); the published text is not available`;
      unavailable.push(notAvailable(baseline));
      break;
    case "not yet":
      if (!exhausted(list)) return stopped(ctx.stopped ?? "time limit");
      return page([checked, ORIGINAL_UNREACHABLE], [], () => ({ kind: "reachable", reason: UNREACHABLE }));
  }
  const current = list.rows[0] ?? baseline;
  let texts: ReadonlyMap<string, string>;
  try {
    texts = await loadTexts([baseline.id, current.id], list, ctx, svc);
  } catch (e) {
    if (e instanceof CallStopped) return stopped(e.reason);
    throw e;
  }
  const then = texts.get(baseline.id);
  const now = texts.get(current.id);
  if (then === undefined || now === undefined) throw forumError(TEXT_TASK, "a version's text was not returned");

  const verdicts = new Map<string, string>();
  const added: ClassifiedPhrase[] = [];
  for (const phrase of phrases) {
    if (contains(then, phrase) === "exact") verdicts.set(phrase.given, inBaseline);
    else if (contains(now, phrase) !== "exact") verdicts.set(phrase.given, IN_NEITHER);
    else added.push(phrase);
  }

  // The visible rows from the baseline to the current one, oldest first: each added phrase is absent at the first, present at the last.
  const rows = list.rows.slice(0, list.rows.findIndex((r) => r.id === baseline.id) + 1).reverse();
  const fp = fingerprint(list.rows, (r) => r.editedMs);
  const carried = carriedIntervals(cont, fp, rows.length);
  // ¶3.6 drift: the list changed since the cursor was issued, so its intervals no longer index it and the search starts again.
  const was = cont?.fingerprint;
  const drift = was !== undefined && !sameFingerprint(was, fp) && added.length > 0 ? driftNote(Math.max(0, fp.count - was.count)) : undefined;
  let search: Awaited<ReturnType<typeof findIntroduction>> = { found: {}, between: {}, state: {} };
  let stop: StopReason | undefined;
  if (added.length > 0) {
    const series: IntroSeries[] = [{ key: doc.id, rows, phrases: added }];
    const fetchTexts = (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => loadTexts(ids, list, ctx, svc);
    const rounds = Math.max(0, Math.min(PHRASE_ROUNDS, ctx.maxRequests - ctx.requestsUsed));
    // The rounds run one at a time from the intervals the round before left (the cursor's to begin with), so a round refused by
    // the cap or the 40 s mark keeps what the earlier ones narrowed; the first pass sends nothing (adjacent rows need no text).
    search = await findIntroduction(series, fetchTexts, { rounds: 0, probes: PROBES, ...(carried !== undefined && { state: carried }) });
    for (let round = 0; round < rounds && Object.keys(search.between).length > 0; round++) {
      try {
        search = await findIntroduction(series, fetchTexts, { rounds: 1, probes: PROBES, state: search.state });
      } catch (e) {
        if (!(e instanceof CallStopped)) throw e;
        stop = e.reason;
        break;
      }
    }
    if (stop === undefined && rounds < PHRASE_ROUNDS) stop = "request cap";
  }
  for (const phrase of added) {
    const key = `${doc.id}|${phrase.given}`;
    const found = search.found[key];
    const between = search.between[key];
    if (found !== undefined) {
      verdicts.set(phrase.given, `first appears in ${versionText(found.version)} (revision_id ${found.id}, ${day(found.editedMs)}), ${NOT_READDED}`);
    } else if (between !== undefined) {
      verdicts.set(phrase.given, `first appears between ${versionText(between.from.version)} and ${versionText(between.to.version)}; continue with the cursor`);
    }
  }

  const evidence: RevisionRecord[] = [];
  for (const row of [baseline, current, ...added.map((phrase) => search.found[`${doc.id}|${phrase.given}`])]) {
    if (row !== undefined && !evidence.some((r) => r.id === row.id)) evidence.push(row);
  }
  const head = [
    checked, ...phrases.map((phrase) => `"${phrase.given}": ${verdicts.get(phrase.given)}`), ...unavailable, "Evidence:", ...evidence.map(revisionLine),
  ];
  const notes = [
    CAVEAT["C-CHANGEMETRICS"],
    ...(evidence.some(isSnapshot) ? [CAVEAT["C-PRE2019"]] : []),
    ...(drift !== undefined ? [drift] : []),
  ];
  const open = Object.keys(search.between).length > 0;
  const cursor = open ? cursorFor(svc, x, phraseState(fp, search.state)) : undefined;
  return page(head, notes, (): Footer => {
    if (cursor === undefined) return { kind: "end" };
    if (stop !== undefined) return { kind: "stopped", why: stop, tool: "get_history", cursor };
    return { kind: "more", tool: "get_history", cursor, next: NEXT_ROUNDS };
  });
}

// a person's wiki edits (user)

/** One `user` page's inputs: the person as resolved, the order and page size, and what its cursors store. */
interface UserInput {
  person: Resolved;
  sort: Sort;
  limit: number;
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/**
 * ¶4.11 user mode: a person's wiki edits, newest first (`sort: old`: oldest first, ties by id descending), `limit` a page, each a
 * revision line that ends with the page and part it edited (¶4.7 step 6), paged as a `list` over the one light set. The last page
 * of a person with more than 2,000 wiki revisions says that only the first 2,000 are listed. A stop before the set is read shows
 * the head and continues with a cursor that reads it again.
 */
async function userMode(x: UserInput, state: ListState | undefined, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { person, sort, limit } = x;
  const name = `"${person.name}"`;
  const named = `${name} (${person.slug !== undefined ? `user_slug ${person.slug}` : `user_id ${person.id}`})`;
  const subject = `wiki edits by ${name}`;
  const request = [echoOf("user", person), setting(x.echo, "sort", sort), setting(x.echo, "limit", limit)];
  const head = [`Wiki edits by ${named}`];
  const first0: ListState = state ?? { kind: "list", shown: 0, index: 0 };
  const cursorAt = (at: StreamState): string => mint(svc, "get_history", x.args, x.effective, { streams: [at], current: 0 });

  let edits: { rows: RevisionRecord[]; over2000: boolean };
  try {
    edits = await loadUserWikiEdits(person.id, ctx, svc);
  } catch (e) {
    if (!(e instanceof CallStopped)) throw e;
    const cursor = cursorAt(first0);
    return reply({ tool: "get_history", subject, request, notes: [], head, items: [] }, maxTokens, svc, () => ({
      kind: "stopped", why: e.reason, tool: "get_history", cursor,
    }));
  }
  const rows = sort === "old" ? oldestFirst(edits.rows) : edits.rows;
  const page = listPage(rows, state, limit, (r) => r.id, (r) => r.editedMs);
  const shown0 = state?.shown ?? 0;
  const count = page.items.length;
  // Past 2,000 the set is not the person's whole list, so its size is not given as a total.
  const total = edits.over2000 ? undefined : rows.length;
  const empty = rows.length === 0 ? [emptyText({ kind: "filtered", items: "wiki edits", filters: `by ${named}` })] : [];
  const notes = [
    ...(count > 0 ? [CAVEAT["C-CHANGEMETRICS"]] : []),
    ...(page.items.some(isSnapshot) ? [CAVEAT["C-PRE2019"]] : []),
    ...(page.driftNote === undefined ? [] : [page.driftNote]),
  ];
  const position = count === 0
    ? undefined
    : (c: Consumed): string => positionText("items", shown0 + 1, shown0 + Math.max(1, Math.min(c.items, count)), total);
  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, count);
    if (n === count && page.ended) return edits.over2000 ? { kind: "reachable", reason: OVER_2000 } : { kind: "end" };
    const at = n === 0 ? first0 : (page.after[n - 1] as ListState);
    return {
      kind: "more", tool: "get_history", cursor: cursorAt(at), next: nextText("items", shown0 + n + 1, Math.min(shown0 + n + limit, rows.length)),
    };
  };
  return reply(
    {
      tool: "get_history", subject, request, ...(position !== undefined && { position }), oneItem: shown0 === 0 && count === 1 && page.ended,
      notes, head: [...head, ...empty], items: page.items.map((r) => ({ text: revisionLine(r) })),
    },
    maxTokens, svc, footerFor,
  );
}

/** User mode's first page: the person resolved as `get_user` resolves them (cached after `find` or `get_user`). */
async function userFirstPage(p: GetHistoryParams, user: string, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const person = await resolve(parseRef("user", user, ["user"]), "user", ctx, svc);
  const x: UserInput = { person, sort: p.sort, limit: p.limit, echo: ctx, args: givenArgs(p, ctx), effective: historyUserEffective(p, person.id) };
  return userMode(x, undefined, p.max_tokens, ctx, svc);
}

/**
 * A `user` cursor (its own, or `get_user`'s hand-off): the parameters given again are compared before any request, the person
 * once resolved again (from the resolution cache, or with one request: ¶3.6, the visibility check of every continuation).
 */
async function userContinuation(entry: CursorEntry, p: GetHistoryParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { user: string; sort: Sort; limit: number };
  checkContinuation(entry, {
    post: p.post, comment: p.comment, tag: p.tag, revision: p.revision, compare_to: p.compare_to, phrases: p.phrases, match: p.match,
    sort: p.sort, limit: p.limit,
  }, ctx);
  const gave = ctx.given.has("user") && p.user !== undefined;
  const person = await resolve(parseRef("user", gave ? p.user! : stored.user, ["user"]), "user", ctx, svc);
  if (gave) checkContinuation(entry, { user: person.id }, ctx);
  if (person.id !== stored.user) throw notFound("user", "id", stored.user);
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "list") throw internalError("get_history", "a wiki-edit cursor without a list state");
  const x: UserInput = {
    person, sort: stored.sort, limit: stored.limit, echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
    args: { ...entry.args }, effective: { ...entry.effective },
  };
  return userMode(x, state, p.max_tokens, ctx, svc);
}

// first page and continuation

async function firstPage(p: GetHistoryParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  checkRules(p);
  const phrases = classified(p.phrases);
  if (p.user !== undefined) return userFirstPage(p, p.user, ctx, svc);
  const ask: Ask = {
    revision: parseRevision(p.revision), compareTo: parseCompareTo(p.compare_to), phrases, match: p.match, sort: p.sort, limit: p.limit,
  };
  const param = DOC_PARAMS.find((k) => p[k] !== undefined);
  if (param === undefined) throw internalError("get_history", "no document parameter");
  const ref = parseRef(param, p[param]!, [param]);
  const opened = await openDocument(param, ref, ctx, svc);
  const x: PageInput = { opened, ask, echo: ctx, args: givenArgs(p, ctx), effective: effectiveOf(param, opened.doc.id, ask) };
  if (ask.phrases !== undefined) return phraseMode(x, undefined, p.max_tokens, ctx, svc);
  return ask.revision === undefined ? listMode(x, undefined, p.max_tokens, ctx, svc) : textMode(x, undefined, undefined, p.max_tokens, ctx, svc);
}

async function continuation(entry: CursorEntry, p: GetHistoryParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  if (typeof entry.effective.user === "string") return userContinuation(entry, p, ctx, svc);
  const stored = entry.effective as {
    post?: string; comment?: string; tag?: string; revision?: string; compare_to?: string; phrases?: string[]; match?: string; sort: Sort; limit: number;
  };
  const param = DOC_PARAMS.find((k) => typeof stored[k] === "string");
  if (param === undefined) throw internalError("get_history", "a cursor without a document");
  // ¶3.6: the parameters given again are compared before any request, the document once it is resolved.
  const early: Record<string, unknown> = {
    user: p.user, revision: parseRevision(p.revision), compare_to: parseCompareTo(p.compare_to), phrases: givenOf(classified(p.phrases)),
    match: p.match, sort: p.sort, limit: p.limit,
  };
  for (const other of DOC_PARAMS) if (other !== param) early[other] = p[other];
  checkContinuation(entry, early, ctx);
  const gaveDoc = ctx.given.has(param) && p[param] !== undefined;
  const ref = parseRef(param, gaveDoc ? p[param]! : stored[param]!, [param]);
  const opened = await openDocument(param, ref, ctx, svc);
  if (gaveDoc) checkContinuation(entry, { [param]: opened.doc.id }, ctx);
  // A bare id is also tried as a slug: another document holding that slug is not the cursor's, which is then gone.
  if (opened.doc.id !== stored[param]) throw notFound(param === "tag" ? "wiki page" : param, "id", stored[param]!);

  const ask: Ask = {
    revision: stored.revision, compareTo: stored.compare_to, phrases: classified(stored.phrases), match: stored.match, sort: stored.sort,
    limit: stored.limit,
  };
  const x: PageInput = {
    opened, ask, echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) }, args: { ...entry.args }, effective: { ...entry.effective },
  };
  const state = entry.state.streams[entry.state.current];
  if (ask.phrases !== undefined) {
    if (state === undefined || state.kind !== "list") throw internalError("get_history", "a phrase cursor without a list state");
    const data = entry.state.data;
    return phraseMode(x, { ...(state.fingerprint !== undefined && { fingerprint: state.fingerprint }), intervals: data?.intervals }, p.max_tokens, ctx, svc);
  }
  if (ask.revision === undefined) {
    if (state === undefined || state.kind !== "list") throw internalError("get_history", "a version-list cursor without a list state");
    return listMode(x, state, p.max_tokens, ctx, svc);
  }
  if (state === undefined || state.kind !== "slice") throw internalError("get_history", "a text cursor without a slice state");
  const ids = textIdsOf(entry.state.data);
  return textMode(x, ids === undefined ? undefined : state, ids, p.max_tokens, ctx, svc);
}

// the tool

const schema = z.strictObject({
  post: P.post().optional(),
  comment: P.comment().optional(),
  tag: P.tag().optional(),
  user: P.user().optional(),
  revision: P.revision().optional(),
  compare_to: P.compareTo().optional(),
  phrases: P.phrases().optional(),
  match: P.match().optional(),
  sort: P.sort("get_history"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetHistoryParams> = {
  name: "get_history",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  oneOf: [["post", "comment", "tag", "user"]],
  run(p, ctx, svc) {
    const entry = openContinuation("get_history", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
