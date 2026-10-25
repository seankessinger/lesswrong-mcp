// Layer 2. The `get_comments` tool (¶4.4): a post's or a wiki page's discussion, or the thread of one comment. Step 1 checks the
// subject (P17) from the resolution cache, or with one request that resolves a slug and a person too; a hidden subject is
// `not_public` or `not_found` and its discussion is never requested. A post resolved earlier with fewer fields gets its header
// fields read along with the forest. A comment target is placed by its joins, `tagId` first (P1): a public page's or post's
// discussion (the join confirmed public), else the comment alone, flagged, with no further request; a debate turn points to
// `get_post`. Phase A is the cached forest (`loadForest`), ranked locally by `sort` into labelled threads, filtered by `user`
// and `af_only` (D2: threads kept whole); phase B fetches the bodies (`loadBodies`: all of them up to about 400 KB or with
// `match`, else this page's, the reply map's and the quoted signals', chosen by their estimate to fill the page). The first page
// leads with the disagreement signals and, with `user`, the reply map (capped blocks), and ends with an outline of the threads not
// shown; every page lists whole threads, split by comments when one does not fit, or with `match` the matching comments. The
// cursor holds two `list` streams (¶4.4 Paging): the reply map's place, then the threads' (or the matching comments'), whose data
// keeps the thread (by its root id) and the comment a page ended at: the next page repeats the thread header and the chain of
// ancestors, and resumes after the last comment_id shown, in that thread wherever a forest fetched again ranks it. A comment
// target's thread too large for its first page starts at the target, under the chain from the root (step 9). A chain is held to
// a quarter of the page (its root, `↑ … N more ancestors`, its nearest ancestors), so the comment always reaches the page. With
// `comment`, the comment chooses the thread: `user` only limits the reply map. A cached comment target its discussion does not
// list is read again before it is shown alone. A deadline that passes once the forest has arrived ends the page `Stopped early`
// with the forest cached (¶2.2 step 5).
import { z } from "zod";
import { CONFIG } from "../config";
import { backAndForths, toCommentRecord } from "../domain/comments";
import { commentSignals } from "../domain/reactions";
import {
  labelsOf, markedComments, mostActive, noDataLines, rankThreads, replyMap, selectBodies, signalComments, threadOf,
  type CommentSort, type ReplyMapEntry, type SignalLine,
} from "../domain/threads";
import { postUrl, tagUrl } from "../domain/urls";
import { attributable, pageOf, postPublic, tagPublic } from "../domain/visibility";
import { badInput, CallStopped, internalError, notFound, ToolError } from "../errors";
import { subjectOps } from "../forum/templates/get_comments";
import { parseRef } from "../ids/parse";
import { cachedResolution, dropResolution, echoOf, forgetResolution, negativeKey, readResolution } from "../ids/resolve";
import { fingerprint, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { Budget, lineUnits, UNITS_PER_TOKEN } from "../render/budget";
import { renderPage } from "../render/layout";
import { CAVEAT, driftNote, emptyText, FLAG, fmtInt, matchLine } from "../render/messages";
import { agreementText, commentBlock, commentHeader, outlineLine, parentText, personText, quote, threadHeader } from "../render/records";
import { day } from "../text/dates";
import { foldForMatch } from "../text/phrases";
import { oneLine } from "../text/sanitize";
import type {
  CallContext, Category, CappedBlock, CommentRecord, Consumed, CursorEntry, CursorState, Fingerprint, Footer, Forest, PageItem,
  PageSpec, ParentRef, ParsedRef, Person, PublicPostId, RankedThread, RawCommentList, RawMdocRef, RawPostRef, RawTagRef, Resolved,
  Services, SortValue, StreamState, Thread, ToolDef, ToolOutput, TrailingBlock, TreeNode,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, setting } from "./common";
import { loadBodies, loadForest, type DiscussionSubject, type ForestCompanion } from "./loaders";

type GetCommentsParams = {
  post?: string; comment?: string; tag?: string; user?: string; match?: string; sort: SortValue; af_only: boolean; limit: number;
  cursor?: string; max_tokens: number;
};

type ListState = Extract<StreamState, { kind: "list" }>;
type TargetParam = "post" | "tag" | "comment";

const TOOL = "get_comments";
const TITLE = "What is the discussion, who disagreed, who replied to whom?";
/** ¶4.4, verbatim. */
const DESCRIPTION_QUOTE =
  "Read a discussion as threads, ready for summarizing: exactly one of post (the whole discussion of a post), comment (the thread containing this comment, which is marked ◆; for a comment on a post or wiki page that is not publicly visible, only that comment) or tag (a wiki page's discussion). Returns whole threads, rebuilt from every publicly listed comment, ranked by sort: top (the thread's first comment by karma; default; computed here because the forum's own \"top\" order is distorted), af_top (AF threads by their first comment's AF karma, then the rest), new / old (its date), largest (most comments), contested (most disagreement signals: disagree-type reactions, negative or split agreement votes, split karma votes, and two people replying back and forth; ties by size, then karma), active (most recent reply). Older discussions often have no reactions or agreement votes; the header then says so, and if nothing at all signals disagreement it says that threads were ranked by size and karma, which does not show that nobody disagreed. limit counts threads (with match: matching comments). On question posts the answer threads (A1, A1.1, …) come first; replies inside a thread are in time order and labelled T3, T3.1, T3.1.2. Labels change with sort and filters: refer to comments by comment_id. Each comment shows author, date, karma and vote count, agreement, reader reactions, flags (answer, retracted, edited, comment placeholder, review, quick take, moderator comment), its ids, and its AF karma if it is on AF; in an AF post's discussion, comments not on AF are marked \"not on AF\", and in other discussions comments without an AF mark are not on AF. The first page also lists the strongest disagreement signals, the comments readers marked as cruxes or as having changed their mind (up to 10 of each; every comment's own signals are also shown on it in the threads), and one line for each thread that did not fit, each with its comment_id. user=<person> keeps the threads that person wrote in, marks their comments ★, and lists for each of their comments who replied directly (with ids) and whether the person replied back further down (with ids). match=<text> keeps only the comments containing that text, each with its thread and parent. af_only keeps the threads that contain at least one AF comment; their non-AF comments stay, labelled \"not on AF\". With comment: user limits the reply map to that thread, match searches only that thread, sort only changes the reported rank, and af_only is refused. Position and ranks count the threads left after user and af_only. Replies whose parent comment is not publicly visible are marked \"parent comment not publicly visible\". Comments the site shows as placeholders keep their place without author or text. The header gives the number of comments listed and the site's own counter, which can differ. The debate turns of the 6 old-style debate posts are in get_post.";

const SUBJECT_TASK = "checking the discussion";
const TARGET_PARAMS = ["post", "comment", "tag"] as const satisfies readonly (keyof GetCommentsParams)[];

const SEP = " · ";
const NAME_CAP = CONFIG.render.caps.name;
const TITLE_CAP = CONFIG.render.caps.title;
/** ¶4.4 step 13: the opening of a signal comment's body and a quoted passage are cut to this many characters. */
const SIGNAL_CHARS = CONFIG.render.caps.signalQuote;
/** ¶4.4 step 8: the reply map quotes the opening 80 characters of each of the person's comments. */
const MAP_OPENING_CHARS = 80;
/** ¶4.4 errors: the empty `user` template names at most this many of the most active commenters. */
const MOST_ACTIVE_MAX = 5;
/**
 * Phase B above 400 KB fetches the page's bodies by their estimate (`wordCount × 7` bytes) up to this many bytes per token of
 * `max_tokens`: a page holds about 3.1 characters of prose per token, so this asks for a little more than fits, and the page
 * ends before the first comment whose body was not fetched.
 */
const BODY_BYTES_PER_TOKEN = 4;

const AF_MARKED = 'comments not on AF are marked "not on AF"';
const AF_UNMARKED = "comments without an AF mark are not on AF";
/** ¶4.4 step 2, exact text. */
const TRUNCATED = "This discussion has more than 5,000 comments; only the oldest 5,000 are used.";
/** ¶4.4 step 6, P18. */
const ALL_ROOTS_HIDDEN = "No thread root's karma is publicly visible here, so threads are ranked by date.";
/** ¶4.4 step 6: the sorts under which threads whose root karma is hidden rank after the others, by date. */
const KARMA_SORTS: ReadonlySet<CommentSort> = new Set<CommentSort>(["top", "af_top", "contested"]);
/** The signals `commentSignals` names after the reactions, each printed as its own field. */
const NAMED_SIGNALS: ReadonlySet<string> = new Set(["agreement disputed", "agreement split", "karma split"]);
const SIGNALS_TITLE = "Disagreement signals:";
const SIGNALS_KEY = "signals";
const MAP_KEY = "replyMap";
/**
 * A comment target its discussion's forest does not list: one posted after the cached forest was read (¶2.3 keeps it 10 minutes),
 * or one the forum's discussion views leave out (a debate turn is answered before this). Printed only for a comment this call
 * read itself (from the forum or its 5-minute raw-response cache): one from the resolution cache is read again first.
 */
const NOT_LISTED = `This comment is not in its discussion as read by this server, which keeps a discussion for up to ${CONFIG.cache.ttlMs.forest / 60_000} minutes, so it is shown alone.`;
/**
 * ¶4.4 Paging and step 9: the share of the page the `↑` ancestor lines of a lead, or of a comment target's first item, may take
 * (the outline's quarter). A longer chain keeps its root and its nearest ancestors, with the middle as one line, so the comment
 * itself always reaches the page and a continuation never repeats its own place.
 */
const CHAIN_SHARE = CONFIG.render.shares.outline;
/** A nonce for measuring a page that is never printed (comment pages have no fences, and a nonce's length is fixed). */
const DRY_NONCE = "000000";

/** The cursor's two streams (¶4.4 Paging): the reply map's place, then the threads' (or, with `match`, the matching comments'). */
const MAP_STREAM = 0;
const ITEM_STREAM = 1;

/** A whole count with its noun: `1 thread`, `3 threads`, `4 people`. */
const counted = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;
const idRef = (kind: "post" | "tag" | "user" | "comment", value: string): ParsedRef => ({ kind, form: "id", value, given: "id", notes: [] });
const userPerson = (u: Resolved): Person => ({ kind: "user", id: u.id, slug: u.slug ?? null, name: u.name });

// what was asked

interface Ask { sort: CommentSort; afOnly: boolean; limit: number; match?: string }

/**
 * Where a continuation starts in its item stream: the thread a page ended inside with the comment it resumes at, or with
 * `match` the matching comment that was cut (cursor data). The thread is named by its root id, so a forest fetched again and
 * ranked differently never resumes another thread.
 */
interface Resume {
  threadId?: string;       // the root id of the thread the previous page ended inside
  commentId?: string;      // the last comment shown in that thread (or, with `sliceTo`, the comment that was cut)
  commentIndex?: number;   // its index in the thread's reading order: where to resume when it is gone (the forest was fetched again)
  sliceTo?: number;        // the character offset the cut comment resumes at
  lead?: 1;                // the cut comment's text began with the continuation lead (it was the first of a page that began inside its thread)
  held?: 1;                // minted by a page that already resumed that thread above the list's place (`View.hold`): no new drift
  signals?: number;        // the line the unfinished signals block resumes at
  replyIndex?: number;     // the reply map: how many replies of its current entry earlier pages showed
  fromTarget?: 1;          // a comment target's thread is read from the target on (it did not fit its first page, ¶4.4 step 9)
  chain?: number;          // with `sliceTo`: the token allowance of the `↑` lines in the cut comment's text, so it is rebuilt the same
}
/** The reply map's place: the next of the person's comments, and how many of its replies earlier pages showed. */
interface MapAt { entry: number; reply: number }
/** A continuation's place: the item stream, its data, and the reply map's place while the map is unfinished. */
interface Start { state: ListState; data: Resume; map?: MapAt }

/** The checked target as the effective values and the echo need it. */
interface Target { param: TargetParam; target: Resolved; user?: Resolved }

/** ¶3.6: the effective values a cursor compares; every parameter but `cursor` and `max_tokens` is an own key. */
function effectiveOf(t: Target, ask: Ask): Record<string, unknown> {
  const { param, target } = t;
  return {
    post: param === "post" ? target.id : undefined,
    comment: param === "comment" ? target.id : undefined,
    // A lens or summary counts as its page (¶3.1.2), so the same page given either way continues.
    tag: param === "tag" ? target.pageId ?? target.id : undefined,
    user: t.user?.id,
    match: ask.match,
    sort: ask.sort,
    af_only: ask.afOnly,
    limit: ask.limit,
  };
}

/** ¶3.7 request echo: the subject and the person as resolved, then `match`, `sort`, `af_only` (when given or on) and `limit`. */
function requestEcho(t: Target, ask: Ask, echo: CallContext): string[] {
  const out = [echoOf(t.param, t.target)];
  if (t.user !== undefined) out.push(echoOf("user", t.user));
  if (ask.match !== undefined) out.push(`match "${oneLine(ask.match, 200)}"`);
  out.push(setting(echo, "sort", ask.sort));
  if (ask.afOnly || echo.given.has("af_only")) out.push(setting(echo, "af_only", ask.afOnly));
  out.push(setting(echo, "limit", ask.limit));
  return out;
}

/** The resume data a cursor holds (each field only when well formed; anything else is no data). */
function resumeOf(data: unknown): Resume {
  const d = isRecord(data) ? data : {};
  const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const out: Resume = {};
  if (typeof d.threadId === "string") out.threadId = d.threadId;
  if (typeof d.commentId === "string") out.commentId = d.commentId;
  const commentIndex = count(d.commentIndex);
  if (commentIndex !== undefined) out.commentIndex = commentIndex;
  const sliceTo = count(d.sliceTo);
  if (sliceTo !== undefined) out.sliceTo = sliceTo;
  if (d.lead === 1) out.lead = 1;
  if (d.held === 1) out.held = 1;
  const signals = count(d.signals);
  if (signals !== undefined) out.signals = signals;
  const replyIndex = count(d.replyIndex);
  if (replyIndex !== undefined) out.replyIndex = replyIndex;
  if (d.fromTarget === 1) out.fromTarget = 1;
  const chain = count(d.chain);
  if (chain !== undefined) out.chain = chain;
  return out;
}

/** The stored state of a page: the reply map's place (`current` stays on it while it is unfinished), then the item stream. */
function cursorState(items: ListState, data: Resume, map: MapAt | undefined): CursorState {
  const mapState: ListState = { kind: "list", shown: map?.entry ?? 0, index: map?.entry ?? 0 };
  const all: Resume = { ...data, ...(map !== undefined && map.reply > 0 && { replyIndex: map.reply }) };
  return { streams: [mapState, items], current: map === undefined ? ITEM_STREAM : MAP_STREAM, ...(Object.keys(all).length > 0 && { data: { ...all } }) };
}

/** A continuation's place, from its stored state. */
function startOf(entry: CursorEntry): Start {
  const mapState = entry.state.streams[MAP_STREAM];
  const state = entry.state.streams[ITEM_STREAM];
  if (mapState?.kind !== "list" || state?.kind !== "list") throw internalError(TOOL, "a cursor without its streams");
  const data = resumeOf(entry.state.data);
  const map = entry.state.current === MAP_STREAM ? { entry: mapState.index, reply: data.replyIndex ?? 0 } : undefined;
  return { state, data, ...(map !== undefined && { map }) };
}

// step 1: the subject (P17)

/** A post's header fields (`POST_CARD hideCommentKarma`). */
interface PostHeader { title: string; slug: string; af: boolean; afKarma: number | null; commentCount: number; afCommentCount: number; hideCommentKarma: boolean }
/** A wiki page's name and slug; a lens or summary stands for its page. */
interface PageHeader { name: string; slug: string }
/** A comment target's post, from its `post { POST_REF }` join: it has no header fields (no AF karma, no counter). */
interface JoinedPost { id: string; title: string; slug: string; af: boolean }

/** The six `POST_CARD` fields the header prints; `hideCommentKarma` is not among them (see `postHeaderOf`). */
const POST_HEADER_KEYS = ["title", "slug", "af", "afBaseScore", "commentCount", "afCommentCount"] as const;
/** The `COMMENT_LIST` fields a comment target reads: both joins, the parent join and the body. */
const COMMENT_LIST_KEYS = ["post", "tag", "parentComment", "contents", "baseScore"] as const;
/** Whether a comment document was read with every `COMMENT_LIST` field this tool reads. */
const hasCommentList = (doc: unknown): boolean => isRecord(doc) && COMMENT_LIST_KEYS.every((k) => Object.hasOwn(doc, k));

/**
 * The header fields of a post document, or undefined when it was selected without one of the six `POST_CARD` header fields
 * (resolve's default `POST_REF` selection, cached by another tool): only then are they read again. An absent `hideCommentKarma`
 * (find's and search's `POST_CARD`) reads false; P18 still holds, because under it the forum nulls every comment score,
 * which prints `karma not publicly visible`.
 */
function postHeaderOf(doc: unknown): PostHeader | undefined {
  if (!isRecord(doc) || !POST_HEADER_KEYS.every((k) => Object.hasOwn(doc, k))) return undefined;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    title: typeof doc.title === "string" ? doc.title : "", slug: typeof doc.slug === "string" ? doc.slug : "", af: doc.af === true,
    afKarma: typeof doc.afBaseScore === "number" ? doc.afBaseScore : null, commentCount: n(doc.commentCount),
    afCommentCount: n(doc.afCommentCount), hideCommentKarma: doc.hideCommentKarma === true,
  };
}

/** P12: the page a resolved tag, lens or summary stands for. */
function pageHeaderOf(r: Resolved): PageHeader {
  const page = r.kind === "lens" || r.kind === "summary" ? pageOf(r.doc as RawMdocRef) : null;
  return { name: page?.name ?? r.name, slug: page?.slug ?? r.slug ?? "" };
}

/** §8.9: one of the 6 old-style debate posts, whose forest also reads the turns (to label replies to them). */
const isDebatePost = (id: string): boolean => (CONFIG.debatePostIds as readonly string[]).includes(id);

/** ¶4.4 step 1 for a post: its id confirmed public in this call, its AF status, hidden karma and debate status. */
function postSubject(id: PublicPostId, h: Pick<PostHeader, "af" | "hideCommentKarma">): DiscussionSubject {
  return { kind: "post", id, af: h.af, hideCommentKarma: h.hideCommentKarma, debate: isDebatePost(id) };
}

/** ¶2.3: a `not_found`/`not_public` remembered for this reference is thrown again without a request (`ids/resolve`'s key). */
function throwRemembered(ref: ParsedRef, svc: Services): void {
  const negative = svc.caches.get<{ category: Category; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
}

/**
 * D1, ¶2.3: a comment target the forum stopped returning since it was resolved (privately deleted, rejected): `ids/resolve`
 * drops its resolution and remembers its `not_found` for 5 minutes under its id and the reference given (an LW1 address), so
 * no later call shows it from the cache. The error names the reference given, as `readResolution`'s does.
 */
function forgetComment(ref: ParsedRef, id: string, svc: Services): ToolError {
  return forgetResolution(ref, id, (value) => notFound("comment", "id", value), svc);
}

/** The checked subject of a call. `subject` and `post` change once a forest companion has read the post's header fields. */
interface Checked extends Target {
  subject: DiscussionSubject;
  post?: PostHeader;                // a post target's header fields, once known
  joinedPost?: JoinedPost;          // a comment target's public post
  page?: PageHeader;
  companion?: ForestCompanion;      // reads a post's header fields with the forest
  commentId?: string;               // a comment target: the comment, whose thread alone is shown
  commentRef?: ParsedRef;           // a comment target: the reference it was checked by (read again by it when not listed)
  commentReadNow?: boolean;         // a comment target: read by this call's request (else from the resolution cache)
}

/**
 * ¶4.4 step 1: the subject and the person from the resolution cache; whatever is not cached costs one request, which also reads
 * the header fields a cached post lacks. When everything is cached but the post's header fields, they are read with the forest
 * (or alone, when the forest is cached too). A hidden subject throws, and nothing of its discussion is requested.
 */
async function checkSubject(param: "post" | "tag", ref: ParsedRef, userRef: ParsedRef | undefined, ctx: CallContext, svc: Services): Promise<Checked> {
  throwRemembered(ref, svc);
  if (userRef !== undefined) throwRemembered(userRef, svc);
  let target = cachedResolution(ref, ctx, svc);
  let user = userRef === undefined ? undefined : cachedResolution(userRef, ctx, svc);
  let post = param === "post" && target !== undefined ? postHeaderOf(target.doc) : undefined;
  const userMissing = userRef !== undefined && user === undefined;
  if (target === undefined || userMissing) {
    const ask: Parameters<typeof subjectOps>[0] = {};
    const headerRef = param === "post" && target !== undefined && post === undefined ? idRef("post", target.id) : undefined;
    if (target === undefined) ask[param] = ref;
    if (headerRef !== undefined) ask.post = headerRef;
    if (userMissing) ask.user = userRef;
    const results = await svc.gql(subjectOps(ask), ctx, SUBJECT_TASK);
    if (target === undefined) {
      target = readResolution(ref, param, "", results, ctx, svc);
      if (param === "post") post = postHeaderOf(target.doc);
    } else if (headerRef !== undefined) {
      post = postHeaderOf(readResolution(headerRef, param, "", results, ctx, svc).doc);
    }
    if (userRef !== undefined && userMissing) user = readResolution(userRef, "user", "", results, ctx, svc);
  }
  const base = { param, target, ...(user !== undefined && { user }) };
  if (param === "tag") {
    return { ...base, subject: { kind: "tag", id: ctx.confirmPublic("tag", target.pageId ?? target.id) }, page: pageHeaderOf(target) };
  }
  const id = ctx.confirmPublic("post", target.id);
  if (post !== undefined) return { ...base, subject: postSubject(id, post), post };
  // The cached post lacks its header fields; they ride along with the forest request.
  const headerRef = idRef("post", id);
  const checked: Checked = {
    ...base,
    // Until the companion reads the fields, the subject knows only what the cached reference fields say.
    subject: postSubject(id, { af: target.af === true, hideCommentKarma: false }),
  };
  checked.companion = {
    ops: subjectOps({ post: headerRef }),
    task: SUBJECT_TASK,
    read: (results) => {
      const header = postHeaderOf(readResolution(headerRef, "post", "", results, ctx, svc).doc);
      if (header === undefined) throw internalError(TOOL, "the post's header fields are missing from its answer");
      checked.post = header;
      checked.subject = postSubject(id, header);
      return checked.subject;
    },
  };
  return checked;
}

/** ¶4.4 step 1, P1: where a comment target is read, decided by `tagId` first; a debate turn on a public post is read in `get_post`. */
type Placement =
  | { kind: "tag"; tag: RawTagRef }
  | { kind: "post"; post: RawPostRef }
  | { kind: "turn"; postId: string }
  | { kind: "alone"; flag: string };

function placementOf(doc: Partial<RawCommentList>): Placement {
  if (doc.tagId != null) return tagPublic(doc.tag) ? { kind: "tag", tag: doc.tag } : { kind: "alone", flag: FLAG.ON_HIDDEN_TAG };
  if (!postPublic(doc.post)) return { kind: "alone", flag: FLAG.ON_HIDDEN_POST };
  return doc.debateResponse === true ? { kind: "turn", postId: doc.post._id } : { kind: "post", post: doc.post };
}

/** A checked comment target: its thread in a confirmed-public discussion, a debate turn, or the comment alone. */
type CommentFound =
  | { kind: "thread"; checked: Checked }
  | { kind: "turn"; target: Target; postId: string }
  | { kind: "alone"; target: Target; flag: string };

/**
 * ¶4.4 step 1 for a comment: the comment (with `COMMENT_LIST`, whose joins check its discussion's subject, P1, P17) and the person
 * from the resolution cache, else one request. A cached comment counts only when it was read with every `COMMENT_LIST` field this
 * tool reads (both joins; a lone comment needs its body too). A hidden comment is `not_found` (P2, P5, P6). The public page or
 * post its joins name is confirmed here, from the join; a hidden one leaves the comment alone, with its flag.
 */
async function checkComment(ref: ParsedRef, userRef: ParsedRef | undefined, ctx: CallContext, svc: Services): Promise<CommentFound> {
  throwRemembered(ref, svc);
  if (userRef !== undefined) throwRemembered(userRef, svc);
  const cached = cachedResolution(ref, ctx, svc);
  let target = cached !== undefined && hasCommentList(cached.doc) ? cached : undefined;
  const readNow = target === undefined;
  let user = userRef === undefined ? undefined : cachedResolution(userRef, ctx, svc);
  const userMissing = userRef !== undefined && user === undefined;
  if (target === undefined || userMissing) {
    const results = await svc.gql(subjectOps({ ...(target === undefined && { comment: ref }), ...(userMissing && { user: userRef }) }), ctx, SUBJECT_TASK);
    if (target === undefined) target = readResolution(ref, "comment", "", results, ctx, svc);
    if (userRef !== undefined && userMissing) user = readResolution(userRef, "user", "", results, ctx, svc);
  }
  return foundOf({ param: "comment", target, ...(user !== undefined && { user }) }, ref, readNow, ctx);
}

/** Where a checked comment target is read (P1, P17): its thread in the discussion its public join names (confirmed here), its debate, or alone. */
function foundOf(t: Target, ref: ParsedRef, readNow: boolean, ctx: CallContext): CommentFound {
  const target = t.target;
  const own = { commentId: target.id, commentRef: ref, commentReadNow: readNow };
  const placed = placementOf(target.doc as Partial<RawCommentList>);
  switch (placed.kind) {
    case "turn":
      return { kind: "turn", target: t, postId: placed.postId };
    case "alone":
      return { kind: "alone", target: t, flag: placed.flag };
    case "tag":
      return {
        kind: "thread",
        checked: { ...t, subject: { kind: "tag", id: ctx.confirmPublic("tag", placed.tag._id) }, page: { name: placed.tag.name, slug: placed.tag.slug }, ...own },
      };
    case "post": {
      const p = placed.post;
      const id = ctx.confirmPublic("post", p._id);
      // The join has no `hideCommentKarma`: it reads false; P18 holds through the forum's null scores.
      return {
        kind: "thread",
        checked: { ...t, subject: postSubject(id, { af: p.af, hideCommentKarma: false }), joinedPost: { id, title: p.title, slug: p.slug, af: p.af }, ...own },
      };
    }
  }
}

/**
 * A comment target from the resolution cache (kept 30 minutes) that the discussion read for this call does not list may have been
 * deleted privately, rejected or left unreviewed since (P2, P5, P6). Its cached resolution is dropped and it is read again with
 * one request, by the reference given: hidden now, it is `not_found`, remembered under all of its keys like a target phase B
 * drops (D1); public, it is placed again by its joins.
 */
async function readCommentAgain(c: Checked, ctx: CallContext, svc: Services): Promise<CommentFound> {
  const ref = c.commentRef;
  const id = c.commentId;
  if (ref === undefined || id === undefined) throw internalError(TOOL, "a comment target without its reference");
  dropResolution(ref, id, svc);
  const results = await svc.gql(subjectOps({ comment: ref }), ctx, SUBJECT_TASK);
  let target: Resolved;
  try {
    target = readResolution(ref, "comment", "", results, ctx, svc);
  } catch (e) {
    if (e instanceof ToolError && e.category === "not_found") throw forgetComment(ref, id, svc);
    throw e;
  }
  return foundOf({ param: "comment", target, ...(c.user !== undefined && { user: c.user }) }, ref, true, ctx);
}

// the threads a page lists, and this page's place in them

/**
 * The threads a page lists, ranked and labelled after the filters. For a comment target, its thread alone (labelled `T1`, or
 * `A1` for an answer thread: labels are positions in this result), with that thread's rank among the threads left after `user`.
 */
interface Scope {
  ranked: RankedThread[];
  labels: ReadonlyMap<string, string>;
  /** `userAbsent`: with `user`, the person has no attributable comment in the target's thread (the rank then counts every thread). */
  target?: { id: string; rootId: string; rank: number; of: number; userAbsent?: true };
}

/** ¶4.4 step 9: a thread read from `id` on, then from its root up to `id` (the comment target's thread when it does not fit a page). */
function fromComment(t: Thread, id: string): Thread {
  const i = t.nodes.findIndex((n) => n.c.id === id);
  return i <= 0 ? t : { ...t, nodes: [...t.nodes.slice(i), ...t.nodes.slice(0, i)] };
}

/** ¶4.4 steps 6–10: the threads left after `user` and `af_only`, ranked by `sort`; with a comment target, its thread alone. */
function scopeOf(forest: Forest, ask: Ask, userId: string | undefined, targetId: string | undefined, fromTarget: boolean): Scope {
  const byUser = userId === undefined ? {} : { userId };
  if (targetId === undefined) {
    const ranked = rankThreads(forest, ask.sort, { ...byUser, afOnly: ask.afOnly });
    return { ranked, labels: labelsOf(ranked) };
  }
  const thread = threadOf(forest, targetId);
  if (thread === undefined) return { ranked: [], labels: new Map() };
  // `comment` + `sort` changes only the reported rank; `user` filters threads first, so the rank counts the threads left. The
  // comment chooses the thread, though (¶4.4): when the person did not write in it, `user` cannot filter it out, so the rank
  // counts every thread and the reply map is empty.
  const rankIn = (all: RankedThread[]): RankedThread | undefined => all.find((rt) => rt.thread.rootId === thread.rootId);
  let all = rankThreads(forest, ask.sort, byUser);
  let at = rankIn(all);
  const userAbsent = at === undefined && userId !== undefined;
  if (userAbsent) {
    all = rankThreads(forest, ask.sort);
    at = rankIn(all);
  }
  if (at === undefined) return { ranked: [], labels: new Map() };
  const shown: RankedThread = { thread: fromTarget ? fromComment(thread, targetId) : thread, label: thread.answer ? "A1" : "T1", rank: 1 };
  return {
    ranked: [shown], labels: labelsOf([shown]),
    target: { id: targetId, rootId: thread.rootId, rank: at.rank, of: all.length, ...(userAbsent && { userAbsent: true as const }) },
  };
}

/** One comment of this page's threads, in page order: `k` its thread's index on the page, `i` its index in the thread's order. */
interface Slot { k: number; i: number; node: TreeNode; rt: RankedThread }

interface View {
  forest: Forest;
  ranked: RankedThread[];
  labels: ReadonlyMap<string, string>;
  fingerprint: Fingerprint;
  threads: RankedThread[];      // this page's threads
  at: number;                   // the index in `ranked` of threads[0] (`ranked.length` when there is none)
  slots: Slot[];                // their comments from where this page starts
  from: number;                 // the character offset the first slot resumes at (a comment cut on the previous page)
  textLead: boolean;            // that cut comment's text began with the continuation lead
  inside: boolean;              // this page starts inside a thread
  /**
   * The thread being resumed now ranks above the list's place (under `active`, a reply moved it up): this page holds that
   * thread alone, and every cursor it mints keeps the list's place, so the list continues where it was once the thread ends.
   */
  hold?: { state: ListState; nextRank?: number };
  /** The thread being resumed now ranks after this page's threads: its resume data rides with the cursor until a page begins with it. */
  carry?: Resume;
  drift?: string;
}

/** Where a thread a page ended inside resumes: after `commentId`, at it when it was cut, or at `commentIndex` when it is gone. */
function resumeIn(rt: RankedThread, d: Resume): { first: number; from: number; textLead: boolean; gone: boolean } {
  const nodes = rt.thread.nodes;
  const j = nodes.findIndex((n) => n.c.id === d.commentId);
  if (j >= 0 && d.sliceTo !== undefined) return { first: j, from: d.sliceTo, textLead: d.lead === 1, gone: false };
  if (j >= 0) return { first: j + 1, from: 0, textLead: false, gone: false };
  return { first: Math.min(d.commentIndex ?? 0, nodes.length), from: 0, textLead: false, gone: true };
}

/** The resume data of a thread, without the blocks' places (which each page decides anew). */
function threadResume(d: Resume): Resume {
  const { signals: _signals, replyIndex: _replyIndex, ...rest } = d;
  return rest;
}

/** The resume data a page whose threads come before the thread being resumed passes on (it no longer holds that thread). */
function carriedResume(d: Resume): Resume {
  const { held: _held, ...rest } = threadResume(d);
  return rest;
}

/**
 * ¶4.4 steps 6–10 and Paging: this page's threads of `scope` (`limit` from the list state), and where the thread the previous
 * page ended inside resumes: after the comment that page ended at, at that comment when it was cut, or, when that comment is gone
 * (the forest was fetched again), at its index, with the drift note. The thread is found by its root id wherever it ranks now:
 * normally first in the list's window; when a forest fetched again ranks it elsewhere (drift note), the threads newly before it
 * in the window come first, whole, and it resumes when a page begins with it, or, when it moved above the list's place, it
 * resumes alone and the list then continues where it was. A thread that is gone (no thread has its root id) leaves the window as
 * it is, with the drift note.
 */
function viewOf(forest: Forest, scope: Scope, limit: number, start: Start | undefined): View {
  const { ranked, labels } = scope;
  const newestOf = (rt: RankedThread): number => rt.thread.newestMs;
  const page = listPage(ranked, start?.state, limit, (rt) => rt.thread.rootId, newestOf);
  const window = page.items;
  const at0 = window.length === 0 ? ranked.length : window[0]!.rank - 1;
  let threads = window;
  let at = at0;
  let first = 0;
  let from = 0;
  let textLead = false;
  let moved = false;
  let hold: View["hold"];
  let carry: Resume | undefined;
  const d = start?.data;
  if (start !== undefined && d?.threadId !== undefined && d.commentId !== undefined) {
    const r = ranked.findIndex((rt) => rt.thread.rootId === d.threadId);
    if (r < 0) {
      moved = true; // its thread is gone: the list continues from its place
    } else {
      const rt = ranked[r]!;
      const res = resumeIn(rt, d);
      const done = res.first >= rt.thread.nodes.length; // nothing of it is left to show
      if (r === at0) {
        moved = res.gone;
        if (done) {
          threads = window.slice(1);
          at += 1;
        } else {
          ({ first, from, textLead } = res);
        }
      } else if (r < at0) {
        // Only the page that first finds it there notes the drift; the pages that go on holding it say nothing new.
        moved = d.held !== 1 || res.gone;
        if (!done) {
          threads = [rt];
          at = r;
          ({ first, from, textLead } = res);
          // The list's place, anchored in this forest (after the thread before the window) with its fingerprint, so that only
          // this page carries the drift note: a cursor that kept the previous anchor would find it lost on every held page
          // once that thread is gone.
          hold = {
            state: { kind: "list", shown: start.state.shown, index: at0, ...(at0 > 0 && { lastId: ranked[at0 - 1]!.thread.rootId }), fingerprint: fingerprint(ranked, newestOf) },
            ...(window.length > 0 && { nextRank: window[0]!.rank }),
          };
        }
      } else {
        moved = true;
        threads = window.slice(0, r - at0);
        carry = carriedResume(d);
      }
    }
  }
  const slots = threads.flatMap((rt, k) => {
    const skip = k === 0 ? first : 0;
    return rt.thread.nodes.slice(skip).map((node, x) => ({ k, i: skip + x, node, rt }));
  });
  const drift = page.driftNote ?? (moved ? driftNote(0) : undefined);
  return {
    forest, ranked, labels, fingerprint: fingerprint(ranked, newestOf), threads, at, slots, from, textLead,
    inside: slots.length > 0 && (slots[0]!.i > 0 || from > 0),
    ...(hold !== undefined && { hold }), ...(carry !== undefined && { carry }), ...(drift !== undefined && { drift }),
  };
}

/** The ids of `nodes`, in order, as many as their body estimate fills about one page (at least one). */
function idsFillingPage(nodes: readonly TreeNode[], maxTokens: number): string[] {
  const room = maxTokens * BODY_BYTES_PER_TOKEN;
  const ids: string[] = [];
  let used = 0;
  for (const node of nodes) {
    used += node.c.wordCount * CONFIG.paging.bytesPerWord;
    if (ids.length > 0 && used > room) break;
    ids.push(node.c.id);
  }
  return ids;
}

// the lines

/** `Post: AF (AF karma N) · <url> · <how non-AF comments read>`, or `LW only`; `AF` alone when the AF karma is not known. */
function postLine(id: string, h: { slug: string; af: boolean; afKarma: number | null }): string {
  const af = !h.af ? FLAG.LW_ONLY : h.afKarma === null ? FLAG.AF : `${FLAG.AF} (${FLAG.afKarma(h.afKarma)})`;
  return [`Post: ${af}`, postUrl({ _id: id, slug: h.slug, af: h.af }), h.af ? AF_MARKED : AF_UNMARKED].join(SEP);
}

/** `Wiki page: "<name>" (tag_slug …) · <url> · <how unmarked comments read>` (a wiki page has no AF status, so as a non-AF post's, ¶3.5). */
function pageLine(p: PageHeader): string {
  return [`Wiki page: "${oneLine(p.name, NAME_CAP)}" (tag_slug ${p.slug})`, tagUrl(p.slug), AF_UNMARKED].join(SEP);
}

/** `Counted: N publicly visible comments in M threads, K people[ (site counter ~C)]`: from the tree (Q50.18), people attributable only (P19). */
function countedLine(forest: Forest, post: PostHeader | undefined): string {
  const people = new Set<string>();
  for (const node of forest.byId.values()) {
    if (attributable(node.c) && node.c.author.kind === "user") people.add(node.c.author.id);
  }
  const counter = post === undefined ? "" : ` (site counter ~${fmtInt(post.commentCount)})`;
  return `Counted: ${counted(forest.count, "publicly visible comment")} in ${counted(forest.threads.length, "thread")}, ${counted(people.size, "person", "people")}${counter}`;
}

/** D2, ¶4.4 step 10: the AF comments counted and the threads kept, beside the site's approximate counter. */
function afOnlyLine(forest: Forest, kept: number, post: PostHeader | undefined): string {
  const counter = post === undefined ? "" : ` (site counter ~${counted(post.afCommentCount, "AF comment")})`;
  return `AF only: ${counted(forest.afCount, "AF comment")} counted in ${counted(kept, "thread")} kept whole${counter}`;
}

/** A thread item's caller-made flags (¶4.4 step 4): an orphan's missing parent, or the debate turn a reply answered (Q110). */
function flagsOf(node: TreeNode): string[] {
  const turn = node.debateReplyTo;
  if (turn !== undefined) return [FLAG.replyToDebateTurn(turn.kind === "user" ? turn.name : turn.why)];
  return node.orphan ? [FLAG.PARENT_HIDDEN] : [];
}

/** Each node's parent in the tree; an orphan's is the root it hangs under (P14: never its missing parent). */
function parentsOf(nodes: readonly TreeNode[]): Map<TreeNode, TreeNode> {
  const parent = new Map<TreeNode, TreeNode>();
  for (const n of nodes) for (const child of n.children) parent.set(child, n);
  return parent;
}

/** The tree path from the thread's root to `node`'s parent: an orphan's only ancestor is the root it hangs under (P14). */
function ancestorsOf(nodes: readonly TreeNode[], node: TreeNode): TreeNode[] {
  const parent = parentsOf(nodes);
  const path: TreeNode[] = [];
  for (let p = parent.get(node); p !== undefined; p = parent.get(p)) path.unshift(p);
  return path;
}

/** The token allowance of the `↑` lines on a page of `maxTokens` (`CHAIN_SHARE` of the page's budget, as a capped block's share). */
const chainAllowance = (maxTokens: number): number => new Budget(maxTokens).share(CHAIN_SHARE);

/** The line that stands for the ancestors a bounded chain leaves out (no ids: P14 is unaffected). */
const omittedAncestors = (n: number): string => `  ↑ … ${counted(n, "more ancestor")}`;

/**
 * One `  ↑ <label> · <person> · comment_id …` line per ancestor of a slot's comment, root first, within `allowance` tokens: a
 * chain that does not fit keeps its root and as many of the nearest ancestors as fit, the middle as `  ↑ … N more ancestors`; an
 * allowance of 0 leaves no line. Lines are built from the nearest ancestor up, only while they fit.
 */
function upLines(s: Slot, labels: ReadonlyMap<string, string>, allowance: number): string[] {
  const path = ancestorsOf(s.rt.thread.nodes, s.node);
  if (path.length === 0 || allowance <= 0) return [];
  const line = (a: TreeNode): string => `  ↑ ${labels.get(a.c.id)}${SEP}${personText(a.c.author)}${SEP}comment_id ${a.c.id}`;
  const room = allowance * UNITS_PER_TOKEN;
  const near: string[] = [];   // the nearest ancestors' lines that fit by themselves, farthest first
  const cost: number[] = [];   // cost[k]: the units of the k nearest lines
  let used = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const l = line(path[i]!);
    if (used + lineUnits(l) > room) break;
    used += lineUnits(l);
    near.unshift(l);
    cost.push(used);
  }
  if (near.length === path.length) return near;
  const root = line(path[0]!);
  if (path.length === 1) return [root]; // a root alone is the whole chain: nothing to leave out
  // At least one ancestor is left out; the root, the omission line and the nearest `kept` lines fit, or the root and the omission line alone.
  let kept = Math.min(near.length, path.length - 2);
  while (kept > 0 && lineUnits(root) + lineUnits(omittedAncestors(path.length - 1 - kept)) + cost[kept - 1]! > room) kept -= 1;
  return [root, omittedAncestors(path.length - 1 - kept), ...near.slice(near.length - kept)];
}

/**
 * ¶4.4 Paging: a page that begins inside a thread repeats its header, `(continued)`, and one line per ancestor of its first
 * comment, held to `allowance` tokens.
 */
function leadOf(s: Slot, labels: ReadonlyMap<string, string>, postAf: boolean, allowance: number): string {
  return [`${threadHeader(s.rt, postAf)} (continued)`, ...upLines(s, labels, allowance)].join("\n");
}

/**
 * The `↑` allowances of a page's first item: `text` for the text it prints, which a cut comment resumes in (so a continuation
 * rebuilds it with the allowance stored in its cursor), and `lead` for the lead repeated before a resumed cut (this page's own).
 */
interface Chain { text: number; lead: number }

/** ¶4.4 steps 8–9: the requested comment is marked ◆; the person's attributable comments ★ (P19). */
type Marker = (node: TreeNode) => "★" | "◆" | undefined;
function markerFor(targetId: string | undefined, userId: string | undefined): Marker {
  return (node) => {
    if (node.c.id === targetId) return "◆";
    const a = node.c.author;
    return userId !== undefined && attributable(node.c) && a.kind === "user" && a.id === userId ? "★" : undefined;
  };
}

/**
 * The page's items: one per comment, in page order, the first of a thread after its header (and, when the thread is read from a
 * comment target on, the chain of that comment's ancestors); a page that begins inside a thread begins with the lead, and a
 * comment cut on the previous page is rebuilt as it was (its `↑` lines with `chain.text`) and resumed at its offset under the lead
 * (with `chain.lead`). The page ends before the first comment whose body was not fetched.
 */
function itemsOf(v: View, postAf: boolean, marker: Marker, chain: Chain): PageItem[] {
  const items: PageItem[] = [];
  for (const [x, s] of v.slots.entries()) {
    const c = s.node.c;
    if (c.placeholder === undefined && c.body === undefined) break;
    const mark = marker(s.node);
    const block = commentBlock(c, { form: "thread", label: v.labels.get(c.id)!, postAf, extraFlags: flagsOf(s.node), ...(mark !== undefined && { marker: mark }) });
    // A thread's first comment has `↑` lines only when the thread is read from its target (the target comes first, on page 1).
    const own = s.i === 0 ? [threadHeader(s.rt, postAf), ...upLines(s, v.labels, chain.text), block].join("\n") : block;
    if (x > 0 || !v.inside) {
      items.push({ text: own });
      continue;
    }
    const text = v.from === 0 || v.textLead ? `${leadOf(s, v.labels, postAf, chain.text)}\n${block}` : own;
    items.push(v.from > 0 ? { text, from: v.from, header: leadOf(s, v.labels, postAf, chain.lead) } : { text });
  }
  return items;
}

/**
 * ¶3.5 in the signal, crux, mind-change and reply-map lines: `AF karma N` for an AF comment (`AF` under hidden karma), `not on AF`
 * inside an AF post's discussion, nothing for a non-AF comment elsewhere (the header says those are not on AF).
 */
function mapAfMark(c: CommentRecord, postAf: boolean): string[] {
  if (c.af) return [c.karmaHidden || c.afKarma === null ? FLAG.AF : FLAG.afKarma(c.afKarma)];
  return postAf ? [FLAG.NOT_ON_AF] : [];
}

/** `  - <label> · <person> · comment_id … · karma … · <agreement> [· AF karma N | · not on AF] · <reactions> [· <named signals>] · > "<opening>"[ · on: "<quote>"]`. */
function signalLine(s: SignalLine, postAf: boolean): string {
  const c = s.node.c;
  const fields = [`  - ${s.label}`, personText(c.author), `comment_id ${c.id}`];
  if (c.karma !== null) fields.push(`karma ${fmtInt(c.karma)}`);
  if (c.reactions.agreement !== undefined) fields.push(agreementText(c.reactions.agreement));
  fields.push(...mapAfMark(c, postAf));
  const reacts = s.signals.labels.filter((label) => !NAMED_SIGNALS.has(label));
  if (reacts.length > 0) fields.push(reacts.join(", "));
  fields.push(...s.signals.labels.filter((label) => NAMED_SIGNALS.has(label)));
  const opening = oneLine(c.body, SIGNAL_CHARS);
  if (opening !== "") fields.push(`> "${opening}"`);
  if (s.quote !== undefined) fields.push(`on: "${oneLine(s.quote, SIGNAL_CHARS)}"`);
  return fields.join(SEP);
}

/**
 * ¶4.4 step 13: the comments of the threads left after filters whose reactions of `set` net above 0, at most 10, as
 * `<label> (comment_id …, <reaction> <net>[, AF karma N | , not on AF])` (the AF mark as in the thread form, ¶3.5).
 */
function markedTexts(forest: Forest, labels: ReadonlyMap<string, string>, set: "crux" | "mindChange", postAf: boolean): string[] {
  const word = set === "crux" ? "crux" : "changemind";
  const max = set === "crux" ? CONFIG.render.cruxMax : CONFIG.render.mindChangeMax;
  return markedComments(forest, set, Infinity).filter((n) => labels.has(n.c.id)).slice(0, max).map((n) => {
    const facts = [`comment_id ${n.c.id}`, `${word} ${fmtInt(commentSignals(n.c)[set])}`, ...mapAfMark(n.c, postAf)];
    return `${labels.get(n.c.id)} (${facts.join(", ")})`;
  });
}

/**
 * ¶4.4 step 13: the signals block, a capped block resumed at `from`: the signal comments, the back-and-forths of every thread
 * left, the cruxes and mind changes, then the no-data lines of ¶3.8.6. Undefined when there is nothing to list.
 */
function signalsBlock(forest: Forest, scope: Scope, from: number, postAf: boolean): CappedBlock | undefined {
  const lines = signalComments(forest, scope.labels).map((s) => signalLine(s, postAf));
  for (const rt of scope.ranked) {
    for (const b of backAndForths(rt.thread)) {
      lines.push(`  - back-and-forth: ${personText(b.a)} and ${personText(b.b)}, ${counted(b.replies, "reply", "replies")} in ${rt.label} (comment_id ${b.fromId} → comment_id ${b.toId})`);
    }
  }
  const cruxes = markedTexts(forest, scope.labels, "crux", postAf);
  if (cruxes.length > 0) lines.push(`Marked as crux: ${cruxes.join(", ")}`);
  const minds = markedTexts(forest, scope.labels, "mindChange", postAf);
  if (minds.length > 0) lines.push(`Changed someone's mind: ${minds.join(", ")}`);
  lines.push(...noDataLines(forest, scope.ranked));
  return lines.length === 0 ? undefined : { key: SIGNALS_KEY, title: SIGNALS_TITLE, lines, share: CONFIG.render.shares.signals, from };
}

/** `  ★ comment_id … (<label> · <date>[ · AF karma N | · not on AF] · "<opening 80 characters>"):`, the opening once fetched. */
function mapEntryLine(e: ReplyMapEntry, postAf: boolean): string {
  const c = e.node.c;
  const opening = oneLine(c.body, MAP_OPENING_CHARS);
  const facts = [e.label, day(c.postedAt), ...mapAfMark(c, postAf), ...(opening === "" ? [] : [`"${opening}"`])];
  return `  ★ comment_id ${c.id} (${facts.join(SEP)}):`;
}

/**
 * `     ↳ <label> · <person> · comment_id …[ · AF karma N | · not on AF] · replied back: yes (comment_id …, +N) | no`; an unattributed
 * reply (P19) is `     ↳ <label> · unattributed (<why>) · comment_id …`, with no name.
 */
function mapReplyLine(r: ReplyMapEntry["replies"][number], postAf: boolean): string {
  const c = r.node.c;
  const a = c.author;
  // P19: an author `attributable` refuses (a placeholder, an anonymous comment, a deleted account) is named by its reason only.
  if (a.kind === "none") return `     ↳ ${r.label}${SEP}unattributed (${a.why})${SEP}comment_id ${c.id}`;
  const ids = [...r.repliedBack.map((id) => `comment_id ${id}`), ...(r.more > 0 ? [`+${fmtInt(r.more)}`] : [])];
  const back = ids.length === 0 ? "no" : `yes (${ids.join(", ")})`;
  return [`     ↳ ${r.label}`, personText(a), `comment_id ${c.id}`, ...mapAfMark(c, postAf), `replied back: ${back}`].join(SEP);
}

/**
 * ¶4.4 step 8: the reply map from `at` on, as the capped block's lines, each with the place the map resumes at when a page ends
 * before it. A comment's own line is never printed apart from its first reply (they are one block line), so a page never ends on
 * a comment whose replies it does not list; one resumed inside its replies repeats its own line before them.
 */
function mapLines(entries: readonly ReplyMapEntry[], at: MapAt, postAf: boolean): { lines: string[]; resume: MapAt[] } {
  const lines: string[] = [];
  const resume: MapAt[] = [];
  for (let e = at.entry; e < entries.length; e++) {
    const entry = entries[e]!;
    const r0 = e === at.entry ? Math.min(at.reply, entry.replies.length) : 0;
    const replies = entry.replies.slice(r0).map((r) => mapReplyLine(r, postAf));
    lines.push([mapEntryLine(entry, postAf), ...replies.slice(0, 1)].join("\n"));
    resume.push({ entry: e, reply: r0 });
    for (const [x, line] of replies.slice(1).entries()) {
      lines.push(line);
      resume.push({ entry: e, reply: r0 + 1 + x });
    }
  }
  return { lines, resume };
}

/** The ids of the person's comments from `at` on whose openings the map quotes, as many as fill about one page. */
function mapBodyIds(entries: readonly ReplyMapEntry[], at: MapAt, maxTokens: number): string[] {
  return idsFillingPage(entries.slice(at.entry).map((e) => e.node), maxTokens);
}

/** Items shown, the cut one included. */
const shownCount = (c: Consumed): number => c.items + (c.sliceTo === undefined ? 0 : 1);

/** ¶4.4 step 14: one outline line per ranked thread none of whose comments was printed, in rank order. Pure. */
function outlineOf(v: View, sort: CommentSort, postAf: boolean): TrailingBlock {
  return {
    title: `Other threads (by ${sort}):`,
    share: CONFIG.render.shares.outline,
    lines: (c) => {
      const printed = new Set(v.slots.slice(0, shownCount(c)).map((s) => s.rt.thread.rootId));
      return v.ranked.filter((rt) => !printed.has(rt.thread.rootId)).map((rt) => outlineLine(rt, postAf));
    },
  };
}

/** ¶4.4 step 11: a comment that contains the needle, with its thread. */
interface Hit { node: TreeNode; rt: RankedThread }

/** ¶4.4 step 11, ¶3.2.1: the comments of the scope's threads whose folded text contains the folded needle, in thread order, then position. */
function hitsOf(scope: Scope, needle: string): { hits: Hit[]; searched: number } {
  const folded = foldForMatch(needle);
  const hits: Hit[] = [];
  let searched = 0;
  for (const rt of scope.ranked) {
    for (const node of rt.thread.nodes) {
      searched += 1;
      const body = node.c.placeholder === undefined ? node.c.body : undefined;
      if (folded !== "" && body !== undefined && foldForMatch(body).includes(folded)) hits.push({ node, rt });
    }
  }
  return { hits, searched };
}

/**
 * ¶4.4 step 11, ¶3.7 `match`: a matching comment as a full thread-form record, its thread and parent under its header line
 * (`thread root: comment_id …`, then the ¶3.8.1 parent form from the tree: an orphan's or a debate reply's flag, never the
 * missing parent's id, P14), then its body. `head` is what a continuation repeats before a cut body.
 */
function hitText(h: Hit, labels: ReadonlyMap<string, string>, parents: ReadonlyMap<TreeNode, TreeNode>, postAf: boolean, marker: Marker): { text: string; head: string } {
  const c = h.node.c;
  const mark = marker(h.node);
  const lines = [commentHeader(c, { form: "thread", label: labels.get(c.id)!, postAf, ...(mark !== undefined && { marker: mark }) }), `  thread root: comment_id ${h.rt.thread.rootId}`];
  const flags = flagsOf(h.node);
  const parent = parents.get(h.node);
  if (flags.length > 0) {
    lines.push(...flags.map((f) => `  ${f}`));
  } else if (parent !== undefined) {
    const p = parent.c;
    const ref: ParentRef = p.placeholder !== undefined ? { kind: "deleted", id: p.id } : { kind: "comment", id: p.id, af: p.af, author: p.author };
    lines.push(`  ${parentText(ref)}`);
  }
  const head = lines.join("\n");
  return { text: c.body === undefined || c.placeholder !== undefined ? head : `${head}\n${quote(c.body)}`, head };
}

// one page

/** What every page of a call needs besides its subject: the ask, the echo's `given`, and what a cursor stores. */
interface PageArgs {
  ask: Ask;
  echo: CallContext;                // its `given` decides the request echo's `(default)` marks
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

interface PageInput extends PageArgs {
  checked: Checked;
  start?: Start;                    // a continuation's place; undefined on a first call
}

/** Where the items continue: the item stream's state, the cursor data, and the `next:` text. */
interface Next { state: ListState; data: Resume; label: string }

/** A page ready to render: its spec and its footer (which mints the cursor). */
interface Built { spec: PageSpec; footerFor: (c: Consumed) => Footer }

/** The shared parts of a discussion page: title, echo, notes, head lines, the capped blocks and the footer that continues them. */
interface Frame {
  title: string;
  request: string[];
  blocks: CappedBlock[];
  notesOf(forest: Forest, labelled: boolean): string[];
  headOf(forest: Forest, scope: Scope, drift: string | undefined): string[];
  footerWith(c: Consumed, next: Next | undefined, endState: ListState): Footer;
}

const INITIAL: ListState = { kind: "list", shown: 0, index: 0 };

/** Page 1: nothing shown yet (a first call, or the continuation of a page that stopped before its items). */
function isFirstPage(start: Start | undefined): boolean {
  return start === undefined
    || (start.state.index === 0 && start.state.shown === 0 && start.data.commentId === undefined && start.data.signals === undefined
      && (start.map === undefined || (start.map.entry === 0 && start.map.reply === 0)));
}

/** Whether every one of `slots` comments of `spec` would be shown whole on its page (measured, never printed). */
function showsWhole(spec: PageSpec, slots: number, maxTokens: number): boolean {
  const c = renderPage(spec, maxTokens, DRY_NONCE, () => ({ kind: "end" })).consumed;
  return c.sliceTo === undefined && c.items === slots;
}

/** The subject's line: a post's (with its AF karma once its header fields are known), else the wiki page's. */
function subjectLineOf(c: Checked): string {
  if (c.post !== undefined) return postLine(c.subject.id, c.post);
  if (c.joinedPost !== undefined) return postLine(c.joinedPost.id, { ...c.joinedPost, afKarma: null });
  if (c.page !== undefined) return pageLine(c.page);
  return postLine(c.subject.id, { slug: c.target.slug ?? "", af: c.target.af === true, afKarma: null });
}

async function discussionPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { checked, ask, start } = input;
  const first = isFirstPage(start);
  const userId = checked.user?.id;
  const targetId = checked.commentId;
  const loaded = await loadForest(checked.subject, ctx, svc, checked.companion);
  if (targetId !== undefined && !loaded.byId.has(targetId)) return notListedPage(input, maxTokens, ctx, svc);

  // ¶4.4 step 9: a comment target's thread is read in its own order, unless its first page cannot hold it whole.
  const fromTarget = start?.data.fromTarget === 1;
  const scope0 = scopeOf(loaded, ask, userId, targetId, fromTarget);
  const marker = markerFor(targetId, userId);
  const subjectName = checked.joinedPost?.title ?? checked.page?.name ?? checked.target.name;
  const discussion = checked.page === undefined ? `discussion of "${oneLine(subjectName, TITLE_CAP)}"` : `discussion of wiki page "${oneLine(subjectName, NAME_CAP)}"`;
  const title = targetId === undefined ? discussion : `thread of comment_id ${targetId} in the ${discussion}`;
  const request = requestEcho(checked, ask, input.echo);
  // A post's header fields are known once the forest has been read (`checked.post`, set by the companion).
  const subjectLine = subjectLineOf(checked);
  const notesOf = (forest: Forest, labelled: boolean): string[] => [
    ...(checked.post !== undefined ? [CAVEAT["C-COUNTER"]] : []),
    ...(checked.post?.af === true || checked.joinedPost?.af === true || forest.afCount > 0 ? [CAVEAT["C-KARMA"]] : []),
    ...(labelled ? [CAVEAT["C-LABELS"]] : []),
  ];
  const headOf = (forest: Forest, scope: Scope, drift: string | undefined): string[] => {
    const lines = [subjectLine];
    if (scope.target !== undefined) lines.push(`thread ${fmtInt(scope.target.rank)} of ${fmtInt(scope.target.of)} by ${ask.sort}`);
    else lines.push(countedLine(forest, checked.post));
    // `comment` + `user` when the person did not write in the thread: one line where the reply map would begin (page 1).
    if (scope.target?.userAbsent === true && checked.user !== undefined && first) {
      lines.push(`No comments by ${personText(userPerson(checked.user))} in this thread; the reply map is empty.`);
    }
    if (forest.truncated) lines.push(TRUNCATED);
    if (ask.afOnly) lines.push(afOnlyLine(forest, scope.ranked.length, checked.post));
    if (scope.target === undefined && KARMA_SORTS.has(ask.sort) && scope.ranked.every((rt) => rt.thread.rootKarma === null)) lines.push(ALL_ROOTS_HIDDEN);
    if (drift !== undefined) lines.push(drift);
    return lines;
  };
  /** No comments, or none left after the filters: nothing more is requested. */
  const emptyPage = (forest: Forest): ToolOutput => {
    const empty = forest.count === 0
      ? emptyText({ kind: "subject", what: "comments on", subject: `"${oneLine(subjectName, TITLE_CAP)}"` })
      : filteredEmpty(forest, ask, checked.user, checked.post);
    const head = targetId === undefined ? [subjectLine, countedLine(forest, checked.post), empty] : [subjectLine, empty];
    return reply({ tool: TOOL, subject: title, request, notes: notesOf(forest, false), head, items: [] }, maxTokens, svc, () => ({ kind: "end" }));
  };
  if (loaded.count === 0 || scope0.ranked.length === 0) return emptyPage(loaded);

  // Phase B: the bodies this page needs (all of them up to about 400 KB, or with `match`): the reply map's openings, this
  // page's comments (a comment target's first page may start at the target, so those come first) and the signals' quotes.
  const mapAt = start === undefined ? (userId === undefined ? undefined : { entry: 0, reply: 0 }) : start.map;
  // The signals block belongs to a discussion's threads: not to one comment's thread, nor to the comments `match` keeps.
  const showSignals = targetId === undefined && ask.match === undefined && (first || start?.data.signals !== undefined);
  const tryFromTarget = targetId !== undefined && first && !fromTarget && ask.match === undefined && scope0.target?.rootId !== targetId;
  const bodyScope = tryFromTarget ? scopeOf(loaded, ask, userId, targetId, true) : scope0;
  // With `match` every body is fetched, so no page needs choosing.
  const pageIds = ask.match !== undefined ? [] : [
    ...(mapAt === undefined || userId === undefined ? [] : mapBodyIds(replyMap(loaded, scope0.labels, userId, scope0.target?.rootId), mapAt, maxTokens)),
    ...idsFillingPage(viewOf(loaded, bodyScope, ask.limit, start).slots.map((s) => s.node), maxTokens),
    ...(showSignals ? signalComments(loaded, scope0.labels).map((s) => s.node.c.id) : []),
  ];
  const sel = selectBodies(loaded, { match: ask.match !== undefined, pageIds });

  let forest: Forest;
  try {
    forest = await loadBodies(checked.subject, loaded, sel.ids, ctx, svc);
  } catch (e) {
    if (!(e instanceof CallStopped)) throw e;
    // ¶2.2 step 5: the forest arrived (and is cached) but the bodies request may not start. The page holds the head lines and
    // the cursor starts where this page started, so the continuation sends only phase B.
    const cursor = mint(svc, TOOL, input.args, input.effective, cursorState(start?.state ?? INITIAL, start === undefined ? {} : { ...start.data }, mapAt));
    const spec: PageSpec = { tool: TOOL, subject: title, request, notes: notesOf(loaded, false), head: headOf(loaded, scope0, undefined), items: [] };
    return reply(spec, maxTokens, svc, () => ({ kind: "stopped", why: ctx.stopped ?? e.reason, tool: TOOL, cursor }));
  }
  // A comment the forum no longer returns was dropped (D1): ranks, labels and the page come from the forest rebuilt without it;
  // when that comment is the target itself, it is no longer publicly visible.
  const rebuilt = forest !== loaded;
  if (targetId !== undefined && !forest.byId.has(targetId)) throw forgetComment(checked.commentRef ?? idRef("comment", targetId), targetId, svc);
  const scopeAt = (rotated: boolean): Scope => (!rebuilt && rotated === fromTarget ? scope0 : scopeOf(forest, ask, userId, targetId, rotated));
  const scope = scopeAt(fromTarget);
  if (scope.ranked.length === 0) return emptyPage(forest);
  const postAf = forest.postAf;

  // The capped blocks: the signals (a discussion's first page) and the reply map (with `user`), each resumed where it stopped.
  const sBlock = showSignals ? signalsBlock(forest, scope, first ? 0 : start!.data.signals!, postAf) : undefined;
  const map = mapAt === undefined || checked.user === undefined
    ? undefined
    : mapLines(replyMap(forest, scope.labels, checked.user.id, scope.target?.rootId), mapAt, postAf);
  const mapBlock: CappedBlock | undefined = map === undefined || map.lines.length === 0 || checked.user === undefined
    ? undefined
    : { key: MAP_KEY, title: `Reply map for ${personText(userPerson(checked.user))}:`, lines: map.lines, share: CONFIG.render.shares.replyMap };

  const frame: Frame = {
    title, request, blocks: [...(sBlock === undefined ? [] : [sBlock]), ...(mapBlock === undefined ? [] : [mapBlock])], notesOf, headOf,
    // The blocks left unfinished continue before anything else (the cursor's `current` stays on the map), then the items.
    footerWith: (c, next, endState) => {
      const signalsAt = sBlock === undefined ? undefined : c.blocks[sBlock.key] ?? sBlock.from ?? 0;
      const signalsOpen = sBlock !== undefined && signalsAt !== undefined && signalsAt < sBlock.lines.length;
      const mapShown = mapBlock === undefined ? undefined : c.blocks[MAP_KEY] ?? 0;
      const mapNext = map === undefined || mapShown === undefined || mapShown >= map.lines.length ? undefined : map.resume[mapShown];
      if (next === undefined && !signalsOpen && mapNext === undefined) return { kind: "end" };
      const data: Resume = { ...(next?.data ?? {}), ...(signalsOpen && { signals: signalsAt }) };
      const cursor = mint(svc, TOOL, input.args, input.effective, cursorState(next?.state ?? endState, data, mapNext));
      const label = signalsOpen
        ? `disagreement signals from line ${fmtInt((signalsAt ?? 0) + 1)}`
        : mapNext !== undefined ? `reply map from comment ${fmtInt(mapNext.entry + 1)}` : next!.label;
      return { kind: "more", tool: TOOL, cursor, next: label };
    },
  };

  if (ask.match !== undefined) {
    const m = matchPage(frame, forest, scope, ask.match, ask.limit, start, postAf, marker);
    return reply(m.spec, maxTokens, svc, m.footerFor);
  }
  // ¶4.4 Paging: the `↑` lines take at most a quarter of the page. A comment cut on the previous page is rebuilt with the
  // allowance its text had (stored in the cursor), so that its offset still points where that page stopped.
  const allowance = chainAllowance(maxTokens);
  const pageWith = (s: Scope, rotated: boolean, lead: number): ThreadsBuilt => {
    const v = viewOf(forest, s, ask.limit, start);
    return threadsPage(frame, v, s, ask, start, postAf, marker, rotated, { text: v.from > 0 ? start?.data.chain ?? allowance : lead, lead });
  };
  let pageScope = scope;
  let rotated = fromTarget;
  let built = pageWith(scope, fromTarget, allowance);
  if (tryFromTarget && !showsWhole(built.spec, built.slots, maxTokens)) {
    // ¶4.4 step 9: the thread does not fit its first page, which then starts at the target under the chain from the root.
    pageScope = scopeAt(true);
    rotated = true;
    built = pageWith(pageScope, true, allowance);
  }
  // A page whose `↑` lines leave its first comment no room at all (the head and the blocks fill the rest) drops them and keeps the
  // thread header alone, so that it shows part of that comment and never mints a cursor naming its own place.
  if (built.chained && !progresses(built.spec, maxTokens)) built = pageWith(pageScope, rotated, 0);
  return reply(built.spec, maxTokens, svc, built.footerFor);
}

/** Whether a page shows some of its first item: all of it, or a cut part past the offset it resumes at (measured, never printed). */
function progresses(spec: PageSpec, maxTokens: number): boolean {
  const head = spec.items[0];
  if (head === undefined) return true;
  const c = renderPage(spec, maxTokens, DRY_NONCE, () => ({ kind: "end" })).consumed;
  return c.items > 0 || (c.sliceTo !== undefined && c.sliceTo > (head.from ?? 0));
}

/** A threads page, with the number of comments it holds and whether its first item carries `↑` lines (it is not its thread's root). */
type ThreadsBuilt = Built & { slots: number; chained: boolean };

/**
 * The threads of a page (¶4.4 steps 9–14 and Paging): whole threads, split by comments when one does not fit; the outline of the
 * threads not shown on a discussion's first page. A comment target's thread counts its comments (`Position: comments 1–6 of 30`)
 * and is one item: shown whole from its start, it has no Position line. `fromTarget`: the thread is read from the target on, which
 * every cursor of the page keeps. `chain`: the `↑` allowances of the first item; a cursor that resumes inside it keeps `chain.text`.
 */
function threadsPage(
  f: Frame, v: View, scope: Scope, ask: Ask, start: Start | undefined, postAf: boolean, marker: Marker, fromTarget: boolean, chain: Chain,
): ThreadsBuilt {
  const items = itemsOf(v, postAf, marker, chain);
  const target = scope.target;
  const first = isFirstPage(start);
  const firstTextLead = v.inside && (v.from === 0 || v.textLead);
  const s0 = start?.state.shown ?? 0;
  const order: Resume = fromTarget ? { fromTarget: 1 } : {};
  const size = v.threads[0]?.thread.size ?? 0;
  const stateAt = (index: number, shown: number): ListState => ({
    kind: "list", shown, index, ...(index > 0 && { lastId: v.ranked[index - 1]!.thread.rootId }), fingerprint: { ...v.fingerprint },
  });
  /** The `next:` text: the threads from `rank` (to `to`), or, for a comment target, its comments from index `at` on. */
  const labelOf = (rank: number, at: number, to?: number): string =>
    target !== undefined ? nextText("comments", at + 1, size) : nextText("threads", rank, to ?? Math.min(rank + ask.limit - 1, v.ranked.length));

  /**
   * The next page begins inside slot `s`'s thread, after `commentId` (or at it, cut at `more.sliceTo`): from the list's place a
   * held page keeps (the next page holds the thread again), else from just before that thread.
   */
  const insideNext = (s: Slot, at: number, commentId: string, commentIndex: number, more: Resume = {}): Next => {
    const data: Resume = { ...order, threadId: s.rt.thread.rootId, commentId, commentIndex, ...more };
    if (v.hold === undefined) return { state: stateAt(v.at + s.k, s0 + s.k), data, label: labelOf(s.rt.rank, at) };
    return { state: v.hold.state, data: { ...data, held: 1 }, label: labelOf(s.rt.rank, at, s.rt.rank) };
  };

  /** Where the threads continue after a page that consumed `c`, or undefined when the last thread was shown whole. */
  const threadsNext = (c: Consumed): Next | undefined => {
    if (c.sliceTo !== undefined) {
      const s = v.slots[c.items]!;
      // Only a page's first item is ever cut (fitting rule 3), so its text was built with `chain.text`.
      return insideNext(s, s.i, s.node.c.id, s.i, { sliceTo: c.sliceTo, chain: chain.text, ...(c.items === 0 && firstTextLead && { lead: 1 as const }) });
    }
    if (c.items < v.slots.length) {
      const s = v.slots[c.items]!;
      if (c.items === 0) {
        // Nothing fitted: this page again.
        return { state: start?.state ?? stateAt(v.at, s0), data: { ...threadResume(start?.data ?? {}), ...order }, label: labelOf(s.rt.rank, s.i) };
      }
      // A held page shows one thread, so a page that ends between threads never holds one.
      if (s.i === 0) return { state: stateAt(v.at + s.k, s0 + s.k), data: { ...v.carry }, label: labelOf(s.rt.rank, s.i) };
      const last = v.slots[c.items - 1]!;
      return insideNext(s, s.i, last.node.c.id, last.i);
    }
    if (v.hold !== undefined) return v.hold.nextRank === undefined ? undefined : { state: v.hold.state, data: {}, label: labelOf(v.hold.nextRank, 0) };
    const after = v.at + v.threads.length;
    return after >= v.ranked.length ? undefined : { state: stateAt(after, s0 + v.threads.length), data: { ...v.carry }, label: labelOf(v.ranked[after]!.rank, 0) };
  };

  const position = items.length === 0 ? undefined : (c: Consumed): string => {
    const shown = Math.min(items.length, Math.max(1, shownCount(c)));
    if (target !== undefined) return positionText("comments", v.slots[0]!.i + 1, v.slots[shown - 1]!.i + 1, size);
    return positionText("threads", v.slots[0]!.rt.rank, v.slots[shown - 1]!.rt.rank, v.ranked.length);
  };
  // ¶3.7: the reply is one item only when it is a comment target's thread, or a discussion of one thread of one comment, and this
  // page starts at its beginning (the layout then leaves Position out if every comment is shown whole). A page of one comment
  // among several threads, a thread of several comments (`threads 1–1 of 1`, as in ¶5b example 2) and a page that resumes inside
  // the only thread keep their Position.
  const oneItem = !v.inside && (target !== undefined || (v.ranked.length === 1 && v.slots.length === 1));
  const spec: PageSpec = {
    tool: TOOL, subject: f.title, request: f.request, ...(position !== undefined && { position }), oneItem,
    notes: f.notesOf(v.forest, true), head: f.headOf(v.forest, scope, v.drift),
    ...(f.blocks.length > 0 && { blocks: f.blocks }), items,
    ...(first && target === undefined && { trailing: outlineOf(v, ask.sort, postAf) }),
  };
  const firstSlot = v.slots[0];
  return {
    spec, footerFor: (c) => f.footerWith(c, threadsNext(c), stateAt(v.ranked.length, s0 + v.threads.length)), slots: v.slots.length,
    chained: firstSlot !== undefined && firstSlot.node !== firstSlot.rt.thread.root,
  };
}

/**
 * ¶4.4 step 11: the matching comments of the scope's threads (a comment target: of its thread), `limit` per page, under the match
 * line; a comment cut by the page resumes at its offset under its repeated header lines.
 */
function matchPage(
  f: Frame, forest: Forest, scope: Scope, needle: string, limit: number, start: Start | undefined, postAf: boolean, marker: Marker,
): Built {
  const { hits, searched } = hitsOf(scope, needle);
  const page = listPage(hits, start?.state, limit, (h) => h.node.c.id, (h) => h.node.c.postedMs);
  const after = page.after.filter((s): s is ListState => s.kind === "list"); // `listPage` continues a list with list states
  const parents = parentsOf(scope.ranked.flatMap((rt) => rt.thread.nodes));
  const d = start?.data;
  const from = d?.sliceTo !== undefined && page.items[0]?.node.c.id === d.commentId ? d.sliceTo : 0;
  const items = page.items.map((h, i): PageItem => {
    const { text, head } = hitText(h, scope.labels, parents, postAf, marker);
    return i === 0 && from > 0 ? { text, from, header: head } : { text };
  });
  const at = page.items.length === 0 ? hits.length : after[0]!.index - 1;
  const before = (i: number): ListState => (i === 0 ? start?.state ?? INITIAL : after[i - 1]!);
  const labelAt = (i: number): string => nextText("comments", at + i + 1, Math.min(at + i + limit, hits.length));
  const next = (c: Consumed): Next | undefined => {
    if (c.sliceTo !== undefined) return { state: before(c.items), data: { commentId: page.items[c.items]!.node.c.id, sliceTo: c.sliceTo }, label: labelAt(c.items) };
    if (c.items < page.items.length) return { state: before(c.items), data: c.items === 0 ? threadResume(d ?? {}) : {}, label: labelAt(c.items) };
    return page.ended ? undefined : { state: after.at(-1)!, data: {}, label: labelAt(page.items.length) };
  };
  const position = items.length === 0 ? undefined : (c: Consumed): string =>
    positionText("comments", at + 1, at + Math.min(items.length, Math.max(1, shownCount(c))), hits.length);
  const spec: PageSpec = {
    tool: TOOL, subject: f.title, request: f.request, ...(position !== undefined && { position }), oneItem: hits.length === 1,
    notes: f.notesOf(forest, true), head: [...f.headOf(forest, scope, page.driftNote), matchLine(hits.length, searched, "comments", needle)],
    ...(f.blocks.length > 0 && { blocks: f.blocks }), items,
  };
  return { spec, footerFor: (c) => f.footerWith(c, next(c), after.at(-1) ?? start?.state ?? INITIAL) };
}

/** ¶4.4 errors: the filters left no thread. `af_only` with no AF comment at all says so beside the site's counter. */
function filteredEmpty(forest: Forest, ask: Ask, user: Resolved | undefined, post: PostHeader | undefined): string {
  if (ask.afOnly && forest.afCount === 0) {
    const counter = post === undefined ? "" : `; site counter ~${counted(post.afCommentCount, "AF comment")}`;
    return emptyText({ kind: "filtered", items: "threads", filters: `AF only (no comment in this discussion is on the Alignment Forum${counter})` });
  }
  const filters = ask.afOnly ? ["AF only"] : [];
  const suggestions: string[] = [];
  if (user !== undefined) {
    filters.push(`with comments by ${personText(userPerson(user))}`);
    // P19: the people with the most attributable comments here.
    const active = mostActive(forest, MOST_ACTIVE_MAX).map(({ person, count }) =>
      `"${oneLine(person.name, NAME_CAP)}" (${person.slug ? `user_slug ${person.slug}` : `user_id ${person.id}`}, ${counted(count, "comment")})`);
    if (active.length > 0) suggestions.push(`Most active commenters here: ${active.join(", ")}`);
  }
  return emptyText({ kind: "filtered", items: "threads", filters: filters.join(", "), suggestions });
}

/**
 * ¶4.4 step 1: a comment on a post or wiki page that is not publicly visible, or one its discussion does not list, shown alone
 * and in full (◆, with an explicit AF mark: `AF karma N` or `LW only`, since there is no discussion for `not on AF` to refer to),
 * flagged with where it is (`flag`) or why it is alone (`note`). `match` keeps it only when it contains the needle. Nothing more
 * is requested.
 */
function alonePage(t: Target, ask: Ask, echo: CallContext, maxTokens: number, svc: Services, why: { flag?: string; note?: string }): ToolOutput {
  const c = toCommentRecord(t.target.doc as RawCommentList);
  const block = commentBlock(c, { form: "thread", alone: true, marker: "◆", ...(why.flag !== undefined && { extraFlags: [why.flag] }) });
  const needle = ask.match === undefined ? undefined : foldForMatch(ask.match);
  const kept = needle === undefined || (needle !== "" && c.body !== undefined && c.placeholder === undefined && foldForMatch(c.body).includes(needle));
  const head = [...(why.note === undefined ? [] : [why.note]), ...(ask.match === undefined ? [] : [matchLine(kept ? 1 : 0, 1, "comments", ask.match)])];
  const spec: PageSpec = {
    tool: TOOL, subject: `comment_id ${c.id}${why.flag === undefined ? "" : ` ${why.flag}`}`, request: requestEcho(t, ask, echo),
    notes: c.af ? [CAVEAT["C-KARMA"]] : [], head, items: kept ? [{ text: block }] : [],
  };
  return reply(spec, maxTokens, svc, () => ({ kind: "end" }));
}

/**
 * A comment target its discussion's forest does not list (a path the spec does not define). A comment this call read itself is
 * shown alone, with the note. One from the resolution cache is read again first, with one request (subject 0–1, forest 1, this 1:
 * within the cap of 4): hidden now, it is `not_found`; still public, it is shown wherever its joins now place it (alone with the
 * note, flagged on a hidden post or page, or the pointer to its debate).
 */
async function notListedPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { checked, ask, echo } = input;
  const found: CommentFound = checked.commentReadNow === true ? { kind: "thread", checked } : await readCommentAgain(checked, ctx, svc);
  switch (found.kind) {
    case "turn": return turnPage(found.target, ask, echo, found.postId, maxTokens, svc);
    case "alone": return alonePage(found.target, ask, echo, maxTokens, svc, { flag: found.flag });
    case "thread": return alonePage(found.checked, ask, echo, maxTokens, svc, { note: NOT_LISTED });
  }
}

/** ¶4.4 step 1: a debate turn is read with its debate in `get_post` (§8.9); the turns are not listed here. */
function turnPage(t: Target, ask: Ask, echo: CallContext, postId: string, maxTokens: number, svc: Services): ToolOutput {
  const spec: PageSpec = {
    tool: TOOL, subject: `comment_id ${t.target.id}, a debate turn`, request: requestEcho(t, ask, echo), notes: [],
    head: [`This is a debate turn; read the debate with get_post {post: "${postId}"}.`], items: [],
  };
  return reply(spec, maxTokens, svc, () => ({ kind: "end" }));
}

/** A comment target's page: its thread (a continuation resumes at `start`), the comment alone, or the pointer to its debate. */
function commentPage(found: CommentFound, page: PageArgs, start: Start | undefined, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> | ToolOutput {
  switch (found.kind) {
    case "turn": return turnPage(found.target, page.ask, page.echo, found.postId, maxTokens, svc);
    case "alone": return alonePage(found.target, page.ask, page.echo, maxTokens, svc, { flag: found.flag });
    case "thread": return discussionPage({ checked: found.checked, ...page, ...(start !== undefined && { start }) }, maxTokens, ctx, svc);
  }
}

// first page and continuation

async function firstPage(p: GetCommentsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  if (p.comment !== undefined && p.af_only) {
    throw badInput("af_only", "can't be combined with comment", "One thread is always shown whole, with its AF marks; remove af_only.");
  }
  const param: TargetParam = p.comment !== undefined ? "comment" : p.post !== undefined ? "post" : "tag";
  const ref = parseRef(param, (p.comment ?? p.post ?? p.tag)!, [param]);
  const userRef = p.user === undefined ? undefined : parseRef("user", p.user, ["user"]);
  const ask: Ask = { sort: p.sort as CommentSort, afOnly: p.af_only, limit: p.limit, ...(p.match !== undefined && { match: p.match }) };
  const args = givenArgs(p, ctx);
  if (param === "comment") {
    const found = await checkComment(ref, userRef, ctx, svc);
    const effective = effectiveOf(found.kind === "thread" ? found.checked : found.target, ask);
    return commentPage(found, { ask, echo: ctx, args, effective }, undefined, p.max_tokens, ctx, svc);
  }
  const checked = await checkSubject(param, ref, userRef, ctx, svc);
  return discussionPage({ checked, ask, echo: ctx, args, effective: effectiveOf(checked, ask) }, p.max_tokens, ctx, svc);
}

interface Stored { post?: string; comment?: string; tag?: string; user?: string; match?: string; sort: CommentSort; af_only: boolean; limit: number }

async function continuation(entry: CursorEntry, p: GetCommentsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as Stored & Readonly<Record<string, unknown>>;
  const param: TargetParam | undefined = stored.post !== undefined ? "post" : stored.tag !== undefined ? "tag" : stored.comment !== undefined ? "comment" : undefined;
  const storedId = stored.post ?? stored.tag ?? stored.comment;
  if (param === undefined || storedId === undefined) throw internalError(TOOL, "a cursor without its discussion");
  // ¶3.6 and ¶3.6 "Continuations re-check visibility": the subject given again is resolved (and checked), else the stored id
  // is checked from the resolution cache or with one request; a person given again is resolved to be compared.
  const givenTarget = ctx.given.has(param) ? p[param] : undefined;
  const ref = givenTarget !== undefined ? parseRef(param, givenTarget, [param]) : idRef(param, storedId);
  const userRef = ctx.given.has("user") && p.user !== undefined
    ? parseRef("user", p.user, ["user"])
    : stored.user === undefined ? undefined : idRef("user", stored.user);
  const compare = (t: Target): void => {
    const given = effectiveOf(t, { sort: p.sort as CommentSort, afOnly: p.af_only, limit: p.limit, ...(p.match !== undefined && { match: p.match }) });
    // Another target than the cursor's is a different discussion whatever it names.
    for (const other of TARGET_PARAMS) if (other !== param && ctx.given.has(other)) given[other] = p[other];
    checkContinuation(entry, given, ctx);
  };
  const page: PageArgs = {
    ask: { sort: stored.sort, afOnly: stored.af_only, limit: stored.limit, ...(stored.match !== undefined && { match: stored.match }) },
    echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
    args: { ...entry.args }, effective: { ...entry.effective },
  };
  if (param === "comment") {
    const found = await checkComment(ref, userRef, ctx, svc);
    compare(found.kind === "thread" ? found.checked : found.target);
    return commentPage(found, page, startOf(entry), p.max_tokens, ctx, svc);
  }
  const checked = await checkSubject(param, ref, userRef, ctx, svc);
  compare(checked);
  return discussionPage({ checked, ...page, start: startOf(entry) }, p.max_tokens, ctx, svc);
}

// the tool

const schema = z.strictObject({
  post: P.post().optional(),
  comment: P.comment().optional(),
  tag: P.tag().optional(),
  user: P.user().optional(),
  match: P.match().optional(),
  sort: P.sort("get_comments"),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetCommentsParams> = {
  name: "get_comments",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  oneOf: [["post", "comment", "tag"]],
  async run(p, ctx, svc) {
    const entry = openContinuation("get_comments", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
