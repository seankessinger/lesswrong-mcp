// Layer 2. The `get_feed` tool (¶4.15): the site-level feeds and status lists. This file holds the parts every feed shares (the
// description and the parameters, the refusals, the request echo with each feed's one-line definition, the page, the footers and
// the cursor) and the nine feeds. Two the forum pages by raw offset: `frontpage` (the logged-out home page's `magic` list, an
// approximation: with `af_only` the same query with no `af` term is filtered here, in raw pages of 100, at most 2 per call) and
// `quick_takes` (the `shortformFrontpage` comments). Two it pages by cutoff: `recent_discussion` and `wiki_activity`. Four it
// answers whole in one request, kept here and paged as a `list`: `popular_comments`, `this_week`, `dialogues` and `best_of`.
// And `spotlight` is one item, paged as a `slice` of its text. The offset feeds keep the forum's own order, which is never
// re-sorted (L5); a page of either can come back short (events and rows the visibility rules hide are dropped here), so the
// pager advances by the raw page size and a short page says so (¶3.6), and the offsets end at 2,000 with C-DEPTH. The cutoff feeds
// keep their order too: the cursor names the raw page that holds the next item and the position among that page's shown items, and
// the feed ends when the forum answers `cutoff: null`, which is never sent back (Q19). A whole-list feed that came back with
// exactly the most this server asks for says more may exist (Q129); only `best_of` is sorted here (by review year and rank).
// Every row the forum answers is checked again (D1, trust but verify): only the number dropped is debug-logged (P14).
import { z } from "zod";
import { CONFIG } from "../config";
import { toCommentRecord } from "../domain/comments";
import { lastCommentOf, toPostRecord } from "../domain/posts";
import { toSequenceRecord } from "../domain/sequences";
import { toTagRecord } from "../domain/tags";
import { authorOf, commentPublic, maskTagRef, postListable, postPublic, sequencePublic, tagPublic, wikiEditPage } from "../domain/visibility";
import { badInput, CallStopped, internalError, isToolError, type ToolError } from "../errors";
import { FEED_LIMITS, feedOp } from "../forum/templates/get_feed";
import {
  collect, feedEnded, listPage, scanThenKeep, sliceAfter, slicePosition, stateAfter, type Collected, type OffsetSource,
} from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import {
  CAVEAT, emptyText, endMostReturned, filterKeptNote, FLAG, fmtInt, partialLine, SHORT_PAGE_NOTE, staleCacheCaveat,
} from "../render/messages";
import { commentBlock, personText, postLine, sequenceLine, tagCard, tagRefText } from "../render/records";
import { day, effectiveDate, isoMs, parseRange } from "../text/dates";
import { oneLine } from "../text/sanitize";
import type {
  CallContext, Consumed, CursorEntry, CursorState, DateRange, FeedName, Footer, PageItem, RawCommentList, RawPostCard, RawPostRef, RawSeqCard,
  RawTagCard, RawTagRef, RawUserRef, Services, StopReason, StreamState, ToolDef, ToolOutput,
} from "../types";
import {
  checkContinuation, dateEchoes, givenArgs, isRecord, mint, nextText, openContinuation, periodText, positionText, reply, rowsOf, setting,
} from "./common";
import { aliasData } from "./loaders";

type GetFeedParams = {
  feed?: FeedName; af_only: boolean; date_from?: string; date_to?: string; sort: "new" | "old"; limit: number; cursor?: string; max_tokens: number;
};

const TITLE = "What is on the front page, active, or Best of?";
/** ¶4.15, verbatim: the quote block, one line per entry. */
const DESCRIPTION_QUOTE = [
  "Site-level feeds. limit counts items per page (not accepted for spotlight); every feed continues with the cursor when its items don't fit, and each except best_of keeps the forum's own order. feed:",
  "- frontpage — an approximation of the post list a logged-out visitor sees on the home page: the site's \"hot\" ranking with its default settings as read from the forum's source code; pinned posts first; event posts excluded;",
  "- recent_discussion — posts, quick takes and wiki pages ordered by their newest comment or edit, each with its latest comments (the forum includes only positive-karma comments from the 18 hours before the last comment, so some items show none). The forum leaves out posts with zero or negative karma and posts moderators removed from recent discussion;",
  "- popular_comments — for each frontpage post, at most its single top comment from the last 7 days, if it has karma 15 or more; quick takes and retracted comments are excluded; ordered by the forum's mix of karma and age; up to about 7 minutes old;",
  "- quick_takes — the home page's Quick Takes: frontpage quick takes from the last 5 days, with karma at least 1 once older than 2 hours, ranked by the site's hotness score (updated by a background task, so it can lag);",
  "- this_week — posts curated in the last 7 days, plus posts frontpaged in the last 7 days that were never curated (by curation or frontpage date, not posting date), in the forum's order; events, group posts and posts moderators excluded from recommendations are left out;",
  "- wiki_activity — new tags, wiki edits and wiki discussion comments, newest first (extra tabs and summaries not included);",
  "- dialogues — recently active dialogues, most recently active first, up to about 12 minutes old;",
  "- best_of — Best of LessWrong (Annual Review) winners, from 2018 on, filtered with date_from/date_to on the posting date (a winner's review year is its posting year); sort new (default: newest review year first, then rank) or old;",
  "- spotlight — the home page's current featured item (it changes about daily).",
  "",
  "For frontpage and quick_takes, the forum can't list beyond about the 2,000th result in this order, and rankings can shift between pages as votes arrive. When the forum returns the most items this server asks for (this_week 300, popular_comments and dialogues 100), the last page says more may exist. af_only keeps AF items in the same order (frontpage: the LessWrong pinned posts that are on AF stay first; pages can be short); recent_discussion keeps wiki items, which have no AF status; not available for wiki_activity. For the latest or curated posts use list_posts (sort=new, curated_only=true); for the latest comments use list_comments.",
].join("\n");

/** Each feed's one-line definition (the last part of the request echo) and its window (the empty-feed template, ¶3.9). */
export const FEED_TEXT = {
  frontpage: { definition: "an approximation of the logged-out home page's post list: the site's \"hot\" ranking with its default settings, pinned posts first, event posts excluded", window: "the home page's post list" },
  recent_discussion: { definition: "posts, quick takes and wiki pages ordered by their newest comment or edit, each with its latest comments", window: "recently commented posts, quick takes and wiki pages" },
  popular_comments: { definition: "for each frontpage post, at most its single top comment of 15+ karma from the last 7 days", window: "comments of 15+ karma on frontpage posts in the last 7 days" },
  quick_takes: { definition: "the home page's Quick Takes: frontpage quick takes from the last 5 days, ranked by the site's hotness score", window: "frontpage quick takes from the last 5 days" },
  this_week: { definition: "posts curated in the last 7 days, plus posts frontpaged in the last 7 days that were never curated", window: "posts curated or frontpaged in the last 7 days" },
  wiki_activity: { definition: "new tags, wiki edits and wiki discussion comments, newest first", window: "recent new tags, wiki edits and wiki discussion comments" },
  dialogues: { definition: "recently active dialogues, most recently active first", window: "recently active dialogues" },
  best_of: { definition: "Best of LessWrong (Annual Review) winners from 2018 on", window: "Annual Review winners from 2018 on" },
  spotlight: { definition: "the home page's current featured item (it changes about daily)", window: "the home page's current featured item" },
} as const satisfies Readonly<Record<FeedName, { definition: string; window: string }>>;

/** ¶4.15 Behaviour: with `af_only`, `frontpage` reads raw pages of 100 rows, at most 2 per call (the second is optional). */
const AF_SCAN = { rows: 100, pages: 2 } as const;
const UNIT = "items";
/** A comment in the list form, with its place and parent, as every comment feed prints it. */
const LIST_COMMENT = { form: "list", bodyCapTokens: CONFIG.render.listCommentCapTokens } as const;
const ONLY_BEST_OF = "Only best_of takes date_from, date_to and sort.";
/** ¶4.15: `popular_comments` with `af_only` is filtered here; the AF site's own list is a different window. */
const POPULAR_AF_WINDOW = "af_only: the AF site's own list uses a 30-day window.";
/** ¶4.15: the spotlight's two refusals. Neither names the item, its title or its subtitle. */
const SPOTLIGHT_HIDDEN = "There is no spotlight item to show.";
const SPOTLIGHT_NOT_AF = "The current spotlight is not on the Alignment Forum.";
/** ¶3.6: a sliced spotlight whose item changed before the next page is read again from its start. */
const SPOTLIGHT_CHANGED = "The spotlight changed since the previous page; starting again at the beginning of the new item.";
/** The `End of reachable results` reason of a cutoff feed whose forum answered a raw page with the cutoff and offset it was asked for. */
const REPEATED_PAGE = "the forum repeated a page of this feed, so it can't be read further";

// what one call asks for, and the checks before any request

/** One feed as asked: the call's parameters on a first page, the cursor's on a continuation. */
interface Plan {
  feed: FeedName;
  afOnly: boolean;
  sort: "new" | "old";
  /** Items per page; unused by `spotlight`. */
  limit: number;
  /** `best_of`'s posting-date range; empty for every other feed. */
  range: DateRange;
}

/** A feed that is not the spotlight, which has a page of its own. */
type ListingFeed = Exclude<FeedName, "spotlight">;

/**
 * ¶4.15, before any request and in this order: `date_from`, `date_to` and `sort` belong to `best_of` alone, `spotlight` is one
 * item with no `limit`, and `wiki_activity` items have no AF status. The checks read `given`, so a default is never refused.
 */
function refuse(feed: FeedName, afOnly: boolean, ctx: CallContext): void {
  if (feed !== "best_of") {
    for (const param of ["date_from", "date_to", "sort"] as const) {
      if (ctx.given.has(param)) throw badInput(param, `feed ${feed} takes no ${param}`, ONLY_BEST_OF);
    }
  }
  if (feed === "spotlight" && ctx.given.has("limit")) throw badInput("limit", "feed spotlight takes no limit", "The spotlight is one item.");
  if (feed === "wiki_activity" && afOnly) throw badInput("af_only", "wiki items have no AF status", "Remove af_only for wiki_activity.");
}

/**
 * ¶3.6: the effective values a cursor compares: defaults applied, dates as the identity of the period they name (never clamped,
 * so a repeated `date_to: "2026"` still matches after the clock moves). Absent values are `undefined`; `spotlight` has no limit.
 */
export function getFeedEffective(p: GetFeedParams, feed: FeedName): Record<string, unknown> {
  return {
    feed, af_only: p.af_only, date_from: effectiveDate(p.date_from, "from"), date_to: effectiveDate(p.date_to, "to"), sort: p.sort,
    limit: feed === "spotlight" ? undefined : p.limit,
  };
}

/** `best_of`'s range of posting dates; every other feed has none (the dates were refused before). */
function rangeOf(feed: FeedName, dateFrom: string | undefined, dateTo: string | undefined, now: number): DateRange {
  return feed === "best_of" ? parseRange(dateFrom, dateTo, now) : {};
}

// one page of a feed

/** What every feed yields for the page: its rendered items, and the states that continue the feed. */
interface Listing {
  /** The rendered items, in the forum's order. */
  texts: string[];
  /** The state this page started from. */
  first: StreamState;
  /** The state right after the first `n` items, for `n` below `texts.length`. */
  stateAt(n: number): StreamState;
  /** The state after every item; undefined once the feed has ended. */
  resume?: StreamState;
  /** The `End of reachable results` reason when a limit ended the feed (C-DEPTH). */
  endLine?: string;
  stopped?: StopReason;
  /** Offset feeds can shift between pages as votes arrive (C-DRIFT). */
  drift: boolean;
  /** Rows checked: the `None found among the first N checked` count. */
  checked: number;
  /** The notes this page's items call for and its own, after the feed's caveats: the short-page note (or the note of the filter that shortened it), a `Partial:` line. */
  notes: readonly string[];
}

/** A page of the pager's `Collected` items, each rendered as `render` says. */
function listingOf<T>(c: Collected<T>, render: (row: T) => string): Listing {
  const resume = c.ended ? undefined : stateAfter(c, c.items.length);
  return {
    texts: c.items.map(render), first: c.first, stateAt: (n) => stateAfter(c, n)!, ...(resume !== undefined && { resume }),
    ...(c.endLine !== undefined && { endLine: c.endLine }), ...(c.stopped !== undefined && { stopped: c.stopped }), drift: c.drift,
    checked: c.checked, notes: c.note === undefined ? [] : [c.note],
  };
}

/**
 * The raw offset pages of `frontpage` or `quick_takes`, unbounded: `rawCount` is the limit sent, never the rows returned, and no
 * total is asked for, so the end is decided by the empty-page rule (¶3.6).
 */
function offsetSource<T extends { _id: string }>(feed: "frontpage" | "quick_takes", svc: Services): OffsetSource<T> {
  const task = `reading the ${feed} feed`;
  return {
    kind: "offset", bounded: false, idOf: (row) => row._id,
    async fetch(offset, size, _first, ctx) {
      const o = feedOp(feed, { limit: size, offset });
      return { rows: rowsOf<T>(aliasData(await svc.gql([o], ctx, task), o.alias, task, ctx)), rawCount: size };
    },
  };
}

/** ¶3.8.4, ¶3.5: a visible row passes `visible`, then the `af_only` filter (`afOf` says whether the row is on AF); the number dropped by the first is debug-logged. */
function keeper<T>(plan: Plan, visible: (row: T) => boolean, afOf: (row: T) => boolean, svc: Services): { keep: (row: T) => boolean; log: () => void } {
  let dropped = 0;
  const keep = (row: T): boolean => {
    if (!visible(row)) {
      dropped++;
      return false;
    }
    return !plan.afOnly || afOf(row);
  };
  return { keep, log: () => { if (dropped > 0) svc.log.debug("get_feed rows dropped by the re-checks", { dropped }); } };
}

/** `frontpage` (D10, D11): listable posts that are not events, kept in the forum's order, pinned posts first. */
async function frontpageListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const source = offsetSource<RawPostCard>("frontpage", svc);
  const { keep, log } = keeper<RawPostCard>(plan, (row) => postListable(row) && !row.isEvent, (row) => row.af, svc);
  const col = plan.afOnly
    ? await scanThenKeep(source, start, plan.limit, keep, ctx, { ...AF_SCAN, filterName: "af_only", unit: "posts" })
    : await collect(source, start, plan.limit, keep, ctx);
  log();
  return listingOf(col, (row) => postLine(toPostRecord(row)));
}

/** `quick_takes` (L5): the logged-out set in the forum's hotness order; the comments pass P2, P5 and P6. */
async function quickTakesListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const source = offsetSource<RawCommentList>("quick_takes", svc);
  const { keep, log } = keeper<RawCommentList>(plan, (row) => commentPublic(row), (row) => row.af, svc);
  const col = await collect(source, start, plan.limit, keep, ctx, plan.afOnly ? { filterName: "af_only", unit: "quick takes" } : {});
  log();
  return listingOf(col, (row) => commentBlock(toCommentRecord(row), LIST_COMMENT));
}

// the cutoff feeds: recent_discussion and wiki_activity

type CutoffFeed = Extract<FeedName, "recent_discussion" | "wiki_activity">;
type FeedState = Extract<StreamState, { kind: "feed" }>;

/** A post of recent discussion with its latest comments. */
type RawDiscussed = RawPostCard & { recentComments: RawCommentList[] | null };
/** A quick-takes container of recent discussion: its reference fields, the time of its newest comment, its owner and its latest comments. */
type RawTakes = RawPostRef & { lastCommentedAt: string | null; user: RawUserRef | null; recentComments: RawCommentList[] | null };
/** A wiki edit of either feed. Its `documentId` is selected and never read (P14); only `wiki_activity` selects the editor. */
interface RawWikiEdit {
  _id: string;
  editedAt: string;
  changeMetrics: { added?: number; removed?: number } | null;
  user?: RawUserRef | null;
  tag: RawTagRef | null;
}
/** One item of a cutoff feed: its `type`, and the one field that type fills. */
interface RawFeedItem {
  type: string;
  postCommented?: RawDiscussed | null;
  shortformCommented?: RawTakes | null;
  tagDiscussed?: RawTagRef | null;
  tagRevised?: RawWikiEdit | null;
  tagCreated?: RawTagRef | null;
  tagRevision?: RawWikiEdit | null;
  tagDiscussionComment?: RawCommentList | null;
}
/** One raw page of a cutoff feed; its `cutoff` is `null` once the feed has ended. */
interface RawFeedPage { cutoff: string | null; endOffset: number; results: RawFeedItem[] }
/** Where a raw page starts: the `cutoff` and `endOffset` the page before it answered (`null` and 0 for the first page, which is sent with neither). */
interface PageAt { cutoff: string | null; endOffset: number }
/** An item as it is shown; `edit` marks a wiki edit (C-CHANGEMETRICS). */
interface Shown { text: string; edit: boolean }
/** What the items of one call lost: rows the visibility rules or the type list removed (only their number is logged, P14), and rows `af_only` removed. */
interface Losses { dropped: number; filtered: number }

/** The line of an item whose latest comments the forum did not provide (¶4.15). */
const noRecentComments = (postId: string): string => `  latest comments not provided by the forum; get_comments {post: ${JSON.stringify(postId)}}`;

/** The latest comments of an item that are public (P2, P5, P6), each in the list form. */
function recentCommentsOf(rows: readonly RawCommentList[] | null | undefined, loss: Losses): string[] {
  const out: string[] = [];
  for (const row of rows ?? []) {
    if (!commentPublic(row)) {
      loss.dropped++;
      continue;
    }
    out.push(commentBlock(toCommentRecord(row), LIST_COMMENT));
  }
  return out;
}

/** A `postCommented` item: the post line with its `last comment` date (or `no comments yet`), then its latest comments or the way to read them. */
function discussedPost(raw: RawDiscussed | null | undefined, afOnly: boolean, loss: Losses): Shown | undefined {
  if (raw == null || !postListable(raw)) {
    loss.dropped++;
    return undefined;
  }
  if (afOnly && !raw.af) {
    loss.filtered++;
    return undefined;
  }
  const post = toPostRecord(raw);
  // `lastCommentedAt` starts at `postedAt`, so a post nobody has commented on still arrives as an item (§14.3).
  const last = lastCommentOf(raw);
  const comments = recentCommentsOf(raw.recentComments, loss);
  const rest = comments.length > 0 ? comments : last === null ? [] : [noRecentComments(post.id)];
  return { text: [postLine(post, { lastComment: last }), ...rest].join("\n"), edit: false };
}

/** A `shortformCommented` item: one person's quick takes (the container is public, P2), then their latest comments or the way to read them. */
function discussedTakes(raw: RawTakes | null | undefined, afOnly: boolean, loss: Losses): Shown | undefined {
  if (!postPublic(raw) || raw.unlisted) {
    loss.dropped++;
    return undefined;
  }
  if (afOnly && !raw.af) {
    loss.filtered++;
    return undefined;
  }
  const owner = personText(authorOf(raw.user ?? null, { hideAuthor: raw.hideAuthor }));
  const last = raw.lastCommentedAt ?? null;
  const comments = recentCommentsOf(raw.recentComments, loss);
  const rest = comments.length > 0 ? comments : last === null ? [] : [noRecentComments(raw._id)];
  const head = `• quick takes by ${owner}${last === null ? "" : ` · ${FLAG.lastComment(day(last))}`}`;
  return { text: [head, ...rest].join("\n"), edit: false };
}

/** A `tagDiscussed` item: a wiki page with new discussion comments (P12 (a)). */
function discussedPage(raw: RawTagRef | null | undefined, loss: Losses): Shown | undefined {
  const tag = maskTagRef(raw);
  if (tag.hidden) {
    loss.dropped++;
    return undefined;
  }
  return { text: `• wiki page ${tagRefText(tag)} has new discussion comments — get_comments {tag: ${JSON.stringify(tag.slug)}}`, edit: false };
}

/** A `tagCreated` item (P12 (a)). */
function createdTag(raw: RawTagRef | null | undefined, loss: Losses): Shown | undefined {
  const tag = maskTagRef(raw);
  if (tag.hidden) {
    loss.dropped++;
    return undefined;
  }
  return { text: `• new tag ${tagRefText(tag)}${tag.wikiOnly ? " · wiki-only page" : ""}`, edit: false };
}

/**
 * A `tagRevised` or `tagRevision` item: an edit of a wiki page's own text (P12 (c), D1).
 * `wiki_activity` names the editor; the forum's change count is printed when it gave numbers (C-CHANGEMETRICS).
 */
function wikiEdit(raw: RawWikiEdit | null | undefined, withEditor: boolean, loss: Losses): Shown | undefined {
  const edited = raw == null ? undefined : wikiEditPage({ collectionName: "Tags", tag: raw.tag });
  if (raw == null || edited === undefined) {
    loss.dropped++;
    return undefined;
  }
  const facts = ["wiki edit", tagRefText(edited.page), `revision_id ${raw._id}`, isoMs(Date.parse(raw.editedAt))];
  if (withEditor) facts.push(`by ${personText(authorOf(raw.user ?? null, { hideAuthor: false }))}`);
  const { added, removed } = raw.changeMetrics ?? {};
  if (typeof added === "number" || typeof removed === "number") {
    facts.push(`forum change count +${fmtInt(added ?? 0)}/−${fmtInt(removed ?? 0)} chars`);
  }
  return { text: `• ${facts.join(" · ")}`, edit: true };
}

/** A `tagDiscussionComment` item: a comment on a wiki page that is public, on a page that is public (P2, P5, P6, P12 (a)). */
function wikiComment(raw: RawCommentList | null | undefined, loss: Losses): Shown | undefined {
  if (raw == null || !commentPublic(raw) || !tagPublic(raw.tag)) {
    loss.dropped++;
    return undefined;
  }
  return { text: commentBlock(toCommentRecord(raw), LIST_COMMENT), edit: false };
}

/** The item as shown, or `undefined` when it is dropped (a type that is not rendered, or a row the visibility rules hide) or `af_only` filters it out. */
function shownItem(feed: CutoffFeed, item: RawFeedItem, afOnly: boolean, loss: Losses): Shown | undefined {
  if (feed === "recent_discussion") {
    switch (item.type) {
      case "postCommented": return discussedPost(item.postCommented, afOnly, loss);
      case "shortformCommented": return discussedTakes(item.shortformCommented, afOnly, loss);
      case "tagDiscussed": return discussedPage(item.tagDiscussed, loss);
      case "tagRevised": return wikiEdit(item.tagRevised, false, loss);
    }
  } else {
    switch (item.type) {
      case "tagCreated": return createdTag(item.tagCreated, loss);
      case "tagRevision": return wikiEdit(item.tagRevision, true, loss);
      case "tagDiscussionComment": return wikiComment(item.tagDiscussionComment, loss);
    }
  }
  // `subscribeReminder`, `meetupsPoke` and any type the forum adds later are not rendered.
  loss.dropped++;
  return undefined;
}

/**
 * One raw page. `recent_discussion` asks for at most 20 items (the forum's own page cap, ¶4.15); the first page is sent with neither
 * `cutoff` nor `offset`, a later one with the `cutoff` and `endOffset` the page before answered, never with `cutoff: null` (Q19).
 */
async function readPage(feed: CutoffFeed, limit: number, at: PageAt, ctx: CallContext, svc: Services): Promise<RawFeedPage> {
  const task = `reading the ${feed} feed`;
  const size = feed === "recent_discussion" ? Math.min(limit, FEED_LIMITS.recent_discussion) : limit;
  const o = feedOp(feed, at.cutoff === null ? { limit: size } : { limit: size, cutoff: at.cutoff, offset: at.endOffset });
  const data = aliasData(await svc.gql([o], ctx, task), o.alias, task, ctx);
  const page = isRecord(data) ? data : {};
  // A cutoff that is not a date cannot be sent back: the feed is taken to have ended.
  const cutoff = typeof page.cutoff === "string" && !Number.isNaN(Date.parse(page.cutoff)) ? page.cutoff : null;
  return { cutoff, endOffset: typeof page.endOffset === "number" ? page.endOffset : 0, results: rowsOf<RawFeedItem>(page) };
}

/**
 * `recent_discussion` and `wiki_activity` (¶4.15), in the forum's order. The `feed` state names the raw page that holds the next item
 * (its `cutoff` and `endOffset`, as the page before answered them) and the position of that item among the page's shown items; a
 * page used up goes on at the next raw page, and the feed has ended when the forum answers `cutoff: null`. Every raw page after the
 * first is optional: it is read only while the call may start a request, else the page ends `stopped`; a later page that fails
 * with a `ToolError` is a `Partial:` line and the cursor goes on at that page.
 */
async function cutoffFeedListing(feed: CutoffFeed, plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const first: StreamState = start ?? { kind: "feed", shown: 0, cutoff: null, endOffset: 0, index: 0 };
  if (first.kind !== "feed") throw internalError("get_feed", `start state of kind ${first.kind} for the ${feed} feed`);
  const s0 = first.shown;
  const loss: Losses = { dropped: 0, filtered: 0 };
  const shown: Shown[] = [];
  /** `after[i]` continues right after `shown[i]`; there is none after the last item of a feed that has ended. */
  const after: (FeedState | undefined)[] = [];
  const stateOf = (at: PageAt, index: number): FeedState => ({ kind: "feed", shown: s0 + shown.length, ...at, index });

  let at: PageAt = { cutoff: first.cutoff, endOffset: first.endOffset };
  let index = first.index;
  let resume: FeedState | undefined;
  let ended = false;
  let endLine: string | undefined;
  let stopped: StopReason | undefined;
  let failure: ToolError | undefined;
  let checked = 0;

  paging: for (let pages = 0; ; pages++) {
    if (pages > 0 && !ctx.mayStartRequest()) {
      stopped = ctx.stopped;
      resume = stateOf(at, 0);
      break;
    }
    let page: RawFeedPage;
    try {
      page = await readPage(feed, plan.limit, at, ctx, svc);
    } catch (e) {
      // The call's first page is its subject: its failure is the call's. A later page that cannot start (the 40 s mark passed while
      // it waited for the transport, or before its transport retry) ends the page as `stopped`; any other failure of a later page,
      // a transient failure after its retry included (a retry is not charged to the cap, ¶7), is a `Partial:` line.
      if (pages === 0) throw e;
      if (e instanceof CallStopped) stopped = e.reason;
      else if (isToolError(e)) failure = e;
      else throw e;
      resume = stateOf(at, 0);
      break;
    }
    const items = page.results.flatMap((item) => shownItem(feed, item, plan.afOnly, loss) ?? []);
    checked += page.results.length - Math.min(index, items.length);
    const next: PageAt = { cutoff: page.cutoff, endOffset: page.endOffset };
    // A page answered with the cutoff and endOffset it was asked for would be asked for again, and again (from the raw-response
    // cache, which costs no request, so the cap never ends it): the feed can be read no further (the documented forum never does
    // this, §14.3; trust but verify). Only an anchored page (sent with a cutoff) can repeat.
    const repeated = at.cutoff !== null && next.cutoff === at.cutoff && next.endOffset === at.endOffset;
    const over = feedEnded(page.cutoff) || repeated;
    for (let j = index; j < items.length; j++) {
      shown.push(items[j]!);
      const last = j === items.length - 1;
      const state = last ? (over ? undefined : stateOf(next, 0)) : stateOf(at, j + 1);
      after.push(state);
      if (shown.length === plan.limit && !last) {
        resume = state;
        break paging;
      }
    }
    if (over) {
      ended = true;
      resume = undefined;
      if (repeated) {
        endLine = REPEATED_PAGE;
        svc.log.debug("get_feed a raw page repeated by the forum", { items: page.results.length });
      }
      break;
    }
    // The page is used up: the feed goes on at the next raw page, which is read now only while the page wants more items.
    resume = stateOf(next, 0);
    if (shown.length >= plan.limit) break;
    at = next;
    index = 0;
  }

  if (loss.dropped > 0) svc.log.debug("get_feed rows dropped by the re-checks", { dropped: loss.dropped });
  const notes: string[] = [];
  if (shown.some((s) => s.edit)) notes.push(CAVEAT["C-CHANGEMETRICS"]);
  if (!ended && shown.length > 0 && shown.length < plan.limit) {
    notes.push(loss.filtered > 0 ? filterKeptNote("af_only", shown.length, checked, "items") : SHORT_PAGE_NOTE);
  }
  if (failure !== undefined) notes.push(partialLine(`${feed} items after ${s0 + shown.length}`, failure));
  return {
    texts: shown.map((s) => s.text), first, stateAt: (n) => (n === 0 ? first : after[n - 1]!),
    ...(resume !== undefined && { resume }), ...(endLine !== undefined && { endLine }), ...(stopped !== undefined && { stopped }),
    drift: false, checked, notes,
  };
}

// the whole-list feeds: popular_comments, this_week, dialogues and best_of

type SetFeed = Extract<FeedName, "popular_comments" | "this_week" | "dialogues" | "best_of">;

/** One Annual Review winner as the forum lists it; `post` is `null` when the forum's access check refuses it. */
interface RawWinner {
  postId: string;
  reviewYear: number;
  reviewRanking: number;
  post: RawPostCard | null;
}

/** The one request of a whole-list feed, which the transport keeps for the feed's TTL (2 minutes, an hour for `best_of`): the rows as the forum answered them. */
async function readSet<T>(feed: SetFeed, ctx: CallContext, svc: Services): Promise<T[]> {
  const task = `reading the ${feed} feed`;
  const o = feedOp(feed, {});
  return rowsOf<T>(aliasData(await svc.gql([o], ctx, task), o.alias, task, ctx));
}

/**
 * One page of a whole-list feed: `kept` is the visible set in the order the feed shows it, paged as a `list` (¶3.6). `fetched` is
 * the number of rows the forum answered: exactly the most this server asks for means the feed may go on past them, so the last
 * page ends `more may exist` (Q129) and not `End of results`.
 */
function setListing<T>(
  feed: SetFeed, fetched: number, kept: readonly T[], start: StreamState | undefined, plan: Plan,
  item: { idOf: (row: T) => string; timeOf: (row: T) => number; render: (row: T) => string },
): Listing {
  if (start !== undefined && start.kind !== "list") throw internalError("get_feed", `a ${start.kind} state for the ${feed} feed`);
  const page = listPage(kept, start, plan.limit, item.idOf, item.timeOf);
  const first: StreamState = start ?? { kind: "list", shown: 0, index: 0 };
  const resume = page.ended ? undefined : page.after.at(-1);
  const most = FEED_LIMITS[feed];
  return {
    texts: page.items.map(item.render), first, stateAt: (n) => (n === 0 ? first : page.after[n - 1]!),
    ...(resume !== undefined && { resume }), ...(page.ended && fetched === most && { endLine: endMostReturned(most) }),
    drift: false, checked: page.items.length, notes: page.driftNote === undefined ? [] : [page.driftNote],
  };
}

/** `popular_comments` (Q65): the comments that are public (P2, P5, P6), in the forum's mix of karma and age, in the list form. */
async function popularCommentsListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const rows = await readSet<RawCommentList>("popular_comments", ctx, svc);
  const { keep, log } = keeper<RawCommentList>(plan, (row) => commentPublic(row), (row) => row.af, svc);
  const kept = rows.filter(keep);
  log();
  return setListing("popular_comments", rows.length, kept, start, plan, {
    idOf: (row) => row._id, timeOf: (row) => Date.parse(row.postedAt), render: (row) => commentBlock(toCommentRecord(row), LIST_COMMENT),
  });
}

/**
 * `this_week` and `dialogues` (P2, P3, D11): the posts `visible` says are public, in the forum's order; every row is checked
 * here.
 */
async function postSetListing(
  feed: "this_week" | "dialogues", visible: (row: RawPostCard) => boolean, plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services,
): Promise<Listing> {
  const rows = await readSet<RawPostCard>(feed, ctx, svc);
  const { keep, log } = keeper<RawPostCard>(plan, visible, (row) => row.af, svc);
  const kept = rows.filter(keep);
  log();
  return setListing(feed, rows.length, kept, start, plan, {
    idOf: (row) => row._id, timeOf: (row) => Date.parse(row.postedAt), render: (row) => postLine(toPostRecord(row)),
  });
}

/**
 * `best_of` (Q114, P14): the winners whose post is public, by review year (`new`: the latest first, `old`: the earliest first),
 * then by rank, in the forum's order for equal ones (the forum sorts by the time of its batch, §14.6, and `sort` is stable). The
 * dates filter the post's `postedAt`. Only winners whose post is public are listed (P14).
 */
async function bestOfListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const rows = await readSet<RawWinner>("best_of", ctx, svc);
  const { keep, log } = keeper<RawWinner>(plan, (w) => postListable(w.post), (w) => w.post?.af === true, svc);
  const { start: from, endExclusive } = plan.range;
  const inRange = (postedAt: string): boolean => {
    const ms = Date.parse(postedAt);
    return (from === undefined || ms >= from) && (endExclusive === undefined || ms < endExclusive);
  };
  const dir = plan.sort === "old" ? 1 : -1;
  const kept = rows
    .filter(keep)
    .flatMap((w) => (w.post === null ? [] : [{ year: w.reviewYear, rank: w.reviewRanking, post: w.post }]))
    .filter(({ post }) => inRange(post.postedAt))
    .sort((a, b) => dir * (a.year - b.year) || a.rank - b.rank);
  log();
  return setListing("best_of", rows.length, kept, start, plan, {
    idOf: (w) => w.post._id, timeOf: (w) => Date.parse(w.post.postedAt), render: (w) => postLine(toPostRecord(w.post)),
  });
}

/** The page of `feed` from `start`. */
function listingFor(feed: ListingFeed, plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  switch (feed) {
    case "frontpage": return frontpageListing(plan, start, ctx, svc);
    case "quick_takes": return quickTakesListing(plan, start, ctx, svc);
    case "recent_discussion":
    case "wiki_activity": return cutoffFeedListing(feed, plan, start, ctx, svc);
    case "popular_comments": return popularCommentsListing(plan, start, ctx, svc);
    case "this_week": return postSetListing(feed, (row) => postListable(row) && !row.isEvent, plan, start, ctx, svc);
    case "dialogues": return postSetListing(feed, (row) => postListable(row), plan, start, ctx, svc);
    case "best_of": return bestOfListing(plan, start, ctx, svc);
  }
}

/** The caveats a feed's page always carries (¶3.8.3); a listing adds the ones its items call for. */
function caveatsOf(feed: ListingFeed, afOnly: boolean): string[] {
  switch (feed) {
    case "frontpage": return [CAVEAT["C-FRONTPAGE-APPROX"], CAVEAT["C-COUNTER"]];
    case "quick_takes": return [];
    case "recent_discussion": return [CAVEAT["C-COUNTER"]];
    case "wiki_activity": return [];
    case "popular_comments": return [staleCacheCaveat(5), ...(afOnly ? [POPULAR_AF_WINDOW] : [])];
    case "this_week":
    case "best_of": return [CAVEAT["C-COUNTER"]];
    case "dialogues": return [staleCacheCaveat(10), CAVEAT["C-COUNTER"]];
  }
}

// the page

interface PageInput {
  plan: Plan;
  /** The cursor's state; undefined on page 1. */
  state?: CursorState;
  from?: number;                    // a first item sliced on the previous page resumes at this offset
  echo: CallContext;                // its `given` decides the request echo's `(default)` marks
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** ¶3.9 the feed-window template: the feed's window, and for `best_of` the posting dates asked for. */
function emptyFeed(plan: Plan): string {
  const period = plan.feed === "best_of" ? periodText(plan.range) : undefined;
  const { window } = FEED_TEXT[plan.feed];
  return emptyText({ kind: "feed", feed: plan.feed, window: period === undefined ? window : `${window}, ${period}` });
}

/** ¶3.7 request echo: the feed, `best_of`'s order and range, `af_only` (and `extra`, what the page found about it), the limit, and last the feed's definition. */
function requestEcho(input: PageInput, extra: readonly string[] = []): string[] {
  const { plan, echo } = input;
  const out = [`feed ${plan.feed}`];
  if (plan.feed === "best_of") {
    out.push(setting(echo, "sort", plan.sort), ...dateEchoes(plan.range));
  }
  if (plan.afOnly) out.push(setting(echo, "af_only", true));
  // ¶3.5: wiki items have no AF status, so `af_only` keeps every one of them and the echo says so.
  if (plan.afOnly && plan.feed === "recent_discussion") out.push("af_only does not apply to wiki pages");
  out.push(...extra);
  if (plan.feed !== "spotlight") out.push(setting(echo, "limit", plan.limit));
  out.push(FEED_TEXT[plan.feed].definition);
  return out;
}

/** One page: the listing, its items, and the footer that continues it. */
async function pageOf(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { plan, state } = input;
  const feed = plan.feed;
  if (feed === "spotlight") return spotlightPage(input, maxTokens, ctx, svc);
  const main = await listingFor(feed, plan, state?.streams[0], ctx, svc);
  const shown0 = main.first.shown;
  const count = main.texts.length;
  const goesOn = main.resume !== undefined;

  const head: string[] = [];
  if (count === 0) {
    // ¶3.6: a page with no items that still has a cursor never uses empty-result wording.
    if (goesOn) {
      if (main.checked > 0) head.push(emptyText({ kind: "scan", checked: main.checked }));
    } else if (shown0 === 0 && main.endLine === undefined) {
      head.push(emptyFeed(plan));
    }
  }

  const items: PageItem[] = main.texts.map((text, j) => ({ text, ...(j === 0 && input.from !== undefined && { from: input.from }) }));
  const position = count === 0 ? undefined : (c: Consumed): string => {
    const touched = Math.max(1, Math.min(c.items, count) + (c.sliceTo === undefined ? 0 : 1));
    return positionText(UNIT, shown0 + 1, shown0 + touched);
  };

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, count);
    const cursorAt = (at: StreamState, from?: number): string =>
      mint(svc, "get_feed", input.args, input.effective, { streams: [at], current: 0, ...(from !== undefined && { data: { from } }) });
    const drift = main.drift ? { drift: true as const } : {};
    const more = (cursor: string, shown: number): Footer =>
      ({ kind: "more", tool: "get_feed", cursor, next: nextText(UNIT, shown0 + shown + 1, shown0 + shown + plan.limit), ...drift });
    // The page ends inside the feed (the budget cut it): the cursor continues after the items shown whole, or inside the sliced one.
    if (n < count) return more(cursorAt(main.stateAt(n), c.sliceTo), n);
    if (main.resume !== undefined) {
      const cursor = cursorAt(main.resume);
      if (main.stopped !== undefined) return { kind: "stopped", why: main.stopped, tool: "get_feed", cursor, ...drift };
      return more(cursor, count);
    }
    return main.endLine !== undefined ? { kind: "reachable", reason: main.endLine } : { kind: "end" };
  };

  return reply(
    {
      tool: "get_feed", subject: feed, request: requestEcho(input), ...(position !== undefined && { position }),
      oneItem: shown0 === 0 && count === 1 && !goesOn, notes: [...caveatsOf(feed, plan.afOnly), ...main.notes], head,
      items,
    },
    maxTokens, svc, footerFor,
  );
}

// the spotlight

/** The home page's current featured item as the forum answers it: the one of `post`, `sequence` and `tag` that `documentType` names is filled. */
interface RawSpotlight {
  documentType: string;
  customTitle: string | null;
  customSubtitle: string | null;
  lastPromotedAt: string;
  post: RawPostCard | null;
  sequence: RawSeqCard | null;
  tag: RawTagCard | null;
}

/**
 * What the spotlight page shows: the lines before its record, the record (none when the page says why), the notes and what it adds
 * to the request echo. `version` is the record's version for the `slice` state (¶3.6), given with the record only.
 */
interface Featured {
  head: string[];
  text?: string;
  notes: string[];
  echo: string[];
  version?: string;
}

/**
 * The featured document as its record (P1–P4, P12) with its AF status, which a wiki page does not have; `undefined` when the
 * visibility rules mask it, its join came back `null`, or its type is not one of the three. An unlisted post (P3) and a hidden
 * sequence (P4, D7) are public: their records carry the flag.
 */
function featuredRecord(s: RawSpotlight): { text: string; af?: boolean } | undefined {
  switch (s.documentType) {
    case "Post": return postPublic(s.post) ? { text: postLine(toPostRecord(s.post)), af: s.post.af } : undefined;
    case "Sequence": return sequencePublic(s.sequence) ? { text: sequenceLine(toSequenceRecord(s.sequence)), af: s.sequence.af } : undefined;
    case "Tag": return tagPublic(s.tag) ? { text: tagCard(toTagRecord(s.tag), { excerpt: true }) } : undefined;
    default: return undefined;
  }
}

/** `Spotlight "<title>" · "<subtitle>" · promoted <day>`; the title and subtitle are single-line forum text, and a missing one is left out. */
function spotlightLine(s: RawSpotlight): string {
  const title = oneLine(s.customTitle, CONFIG.render.caps.title);
  const subtitle = oneLine(s.customSubtitle, CONFIG.render.caps.title);
  return [`Spotlight${title === "" ? "" : ` "${title}"`}`, ...(subtitle === "" ? [] : [`"${subtitle}"`]), `promoted ${day(s.lastPromotedAt)}`].join(" · ");
}

/** The spotlight as `data` answered it (`null`: there is none): the empty-feed template, a refusal that names nothing (P1, P2, P12), or its title line and record. */
function featuredPage(data: unknown, plan: Plan, svc: Services): Featured {
  if (!isRecord(data)) return { head: [emptyFeed(plan)], notes: [], echo: [] };
  const s = data as unknown as RawSpotlight;
  const record = featuredRecord(s);
  if (record === undefined) {
    svc.log.debug("get_feed rows dropped by the re-checks", { dropped: 1 });
    return { head: [SPOTLIGHT_HIDDEN], notes: [], echo: [] };
  }
  if (plan.afOnly && record.af === false) return { head: [SPOTLIGHT_NOT_AF], notes: [], echo: [] };
  // ¶3.5: a wiki page has no AF status, so `af_only` keeps it and the echo says so.
  const echo = plan.afOnly && record.af === undefined ? ["af_only does not apply to wiki pages"] : [];
  // The record's version is its kind of document and the time it was last promoted: another item, or the same one promoted again, is another text.
  return { head: [spotlightLine(s)], text: record.text, notes: [CAVEAT["C-COUNTER"]], echo, version: `${s.documentType}@${s.lastPromotedAt}` };
}

/**
 * `spotlight` (P1–P4, P12): one item, paged as a `slice` of its text (¶3.6) in case it does not fit; the page repeats the title
 * line. This server keeps the forum's answer for 30 minutes, so a continuation normally reads the same item. When the spotlight
 * changed in between (the cursor lives longer), the stored character offset belongs to another text: the slice stores the item's
 * version, and a different one starts the new item again from its beginning, with a note.
 */
async function spotlightPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { plan, state } = input;
  const stored = state?.streams[0];
  if (stored !== undefined && stored.kind !== "slice") throw internalError("get_feed", `a ${stored.kind} state for the spotlight`);
  const task = "reading the spotlight";
  const o = feedOp("spotlight", {});
  const page = featuredPage(aliasData(await svc.gql([o], ctx, task), o.alias, task, ctx), plan, svc);
  const changed = stored?.version !== undefined && page.version !== undefined && stored.version !== page.version;
  const start = changed ? undefined : stored;
  const all: PageItem[] = page.text === undefined ? [] : [{ text: page.text }];
  const slice = slicePosition(all, start);
  const footerFor = (c: Consumed): Footer => {
    const next = sliceAfter(c, start, all.length, page.version);
    if (next === undefined) return { kind: "end" };
    const cursor = mint(svc, "get_feed", input.args, input.effective, { streams: [next], current: 0 });
    return { kind: "more", tool: "get_feed", cursor, next: slice.next(c) };
  };
  return reply(
    {
      tool: "get_feed", subject: "spotlight", request: requestEcho(input, page.echo), ...(slice.position !== undefined && { position: slice.position }),
      notes: page.notes, head: [...page.head, ...(changed ? [SPOTLIGHT_CHANGED] : [])], items: slice.items,
    },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

async function firstPage(p: GetFeedParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const feed = p.feed;
  if (feed === undefined) throw internalError("get_feed", "no feed");
  refuse(feed, p.af_only, ctx);
  const range = rangeOf(feed, p.date_from, p.date_to, svc.now());
  const args = givenArgs(p, ctx);
  const plan: Plan = { feed, afOnly: p.af_only, sort: p.sort, limit: p.limit, range };
  return pageOf({ plan, echo: ctx, args, effective: getFeedEffective(p, feed) }, p.max_tokens, ctx, svc);
}

async function continuation(entry: CursorEntry, p: GetFeedParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { feed: FeedName; af_only: boolean; sort: "new" | "old"; limit?: number };
  const first = entry.args as Partial<GetFeedParams>;
  refuse(stored.feed, p.af_only, ctx);
  checkContinuation(entry, getFeedEffective(p, p.feed ?? stored.feed), ctx);
  // The period is computed again with the current time (the clamp may move); pages already shown are not affected.
  const range = rangeOf(stored.feed, first.date_from, first.date_to, svc.now());
  const plan: Plan = { feed: stored.feed, afOnly: stored.af_only, sort: stored.sort, limit: stored.limit ?? p.limit, range };
  const data = entry.state.data;
  const from = isRecord(data) && typeof data.from === "number" ? data.from : undefined;
  return pageOf(
    {
      plan, state: entry.state, ...(from !== undefined && { from }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  feed: P.feed().optional(),
  af_only: P.flag("af_only"),
  date_from: P.dateFrom().optional(),
  date_to: P.dateTo().optional(),
  sort: P.sort("get_feed"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetFeedParams> = {
  name: "get_feed",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["feed"],
  run(p, ctx, svc) {
    const entry = openContinuation("get_feed", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
