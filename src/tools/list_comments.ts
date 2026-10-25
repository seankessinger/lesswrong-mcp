// Layer 2. The `list_comments` tool (¶4.6): comments across the site or by one person, newest or oldest first, best first, or
// quick takes. Before any request the dates and the window rule of site-wide `top` and quick takes are checked; `user` is then
// resolved (at most one request, which is also its visibility check). Four modes, the first that applies wins: quick takes
// (`topShortform` as a light set of at most 2,000 rows), a person's `top` (`allRecentComments` by `new` as a light set), site-wide
// `top` (`allRecentComments` by raw offset up to 2000, in the forum's order, never re-sorted) and the date lists `new`/`old`
// (`allRecentComments` by keyset on `postedAt`). A light set is read once, cached, filtered and ordered here and paged as a
// `list`; only the page shown is hydrated by id. With `af_only`, the offset and keyset lists are scanned as light rows (500
// per page, at most 3 pages) and only the kept ids are hydrated. Every row the forum answers is re-checked here (D1, trust but
// verify, Q8): visibility, deleted placeholders, debate turns, the anonymity rule (P7) and every requested filter; only the
// number dropped is debug-logged (P14). No other list view is used (Q73).
import { z } from "zod";
import { CONFIG } from "../config";
import { parentOf, placeOf, toCommentRecord } from "../domain/comments";
import { recheckComment, type CommentFilters } from "../domain/filters";
import { commentPublic } from "../domain/visibility";
import { internalError } from "../errors";
import { allRecentCommentsOp, topShortformOp, type AllRecentTerms } from "../forum/templates/list_comments";
import { commentsByIdsOps } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { echoOf, resolve } from "../ids/resolve";
import {
  collect, compareLocal, lightScan, listPage, scanThenKeep, stateAfter, type Collected, type KeysetSource, type OffsetSource,
  type PagedSource, type RawPage,
} from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, DEPTH_HINT, emptyText, fmtInt, SHORT_PAGE_NOTE } from "../render/messages";
import { commentBlock, personText } from "../render/records";
import { effectiveDate, isoMs, parseRange, requireWindow, toViewTerms } from "../text/dates";
import type {
  CallContext, Consumed, CursorEntry, CursorState, DateRange, Footer, GqlOp, PageItem, RawCommentLight, RawCommentList, Resolved,
  Services, StopReason, StreamState, ToolDef, ToolOutput,
} from "../types";
import {
  checkContinuation, dateEchoes, givenArgs, isRecord, mint, nextText, openContinuation, periodText, positionText, reply, rowsOf, setting,
} from "./common";
import { aliasData } from "./loaders";

export type ListCommentsParams = {
  user?: string; date_from?: string; date_to?: string; af_only: boolean; quick_takes_only: boolean; min_karma?: number;
  sort: "new" | "old" | "top"; limit: number; cursor?: string; max_tokens: number;
};

type Sort = ListCommentsParams["sort"];

const TITLE = "What has X been commenting on? What is being said lately?";
/** ¶4.6, verbatim. */
const DESCRIPTION_QUOTE = `List comments across the site or by one person: what someone has been commenting on, the latest comments site-wide, or quick takes. limit counts comments. Filters: user, date_from/date_to (posting date), af_only, quick_takes_only (top-level quick takes, i.e. shortform posts, only), min_karma. sort: new (default), old, top (karma). Without user, sort top and quick_takes_only each need both date_from and date_to, at most 31 days apart (e.g. date_from "2024-03-01", date_to "2024-03-31"). Quick takes, and a person's comments by top, are ranked over at most 2,000 matching comments (narrow the dates beyond that). Comments whose karma is not publicly visible are left out of sort top and min_karma. Each comment shows where it is (its post with post_id and AF status, its wiki page, "quick take", or a post or wiki page that is not publicly visible), who it replies to (name and ids; no text), date, karma and votes, agreement, reactions, flags, AF karma or "LW only", its ids and its text (cut at about 1,500 tokens; get_comments comment=<comment_id> shows it whole in its thread). Not listed: comment placeholders and the turns of old-style debates. For one post's discussion use get_comments. Paging: new and old go back without limit (site-wide lists filtered by nothing but af_only stop after 500 comments). For sort top, the forum can't list beyond about the 2,000th result in this order, and rankings can shift between pages as votes arrive.`;

const LIST_TASK = "listing comments";
const SCAN_TASK = "scanning comments";
const HYDRATE_TASK = "reading the comments shown";
/** The aliases of a list page, of the `af_only` scan, of a person's light set, of the quick-take set and of the hydrate (`h1`, …). */
const ALIAS = { list: "l", siteTop: "t", scan: "af", person: "pl", quick: "q", hydrate: "h" } as const;
const UNIT = "items";
/** ¶4.6 "Errors and empty results": the one suggestion of a person's empty list with a date range. */
const SUGGEST_NO_DATES = "try without the date range";
/** `lightScan`'s `overCap` (`tooBroad(why, how)`): the sentence is split at the spec's semicolon. */
const NARROW = "Narrow with date_from/date_to";
const OVER_CAP = {
  quick: { why: `More than ${fmtInt(CONFIG.paging.lightScanCap)} quick takes match`, how: NARROW },
  person: { why: `More than ${fmtInt(CONFIG.paging.lightScanCap)} comments match`, how: NARROW },
} as const;

const quoted = (s: string): string => `"${s}"`;
const postedMs = (r: { postedAt: string }): number => Date.parse(r.postedAt);
const idOf = (r: { _id: string }): string => r._id;

// what one call asks for, and the checks before any request

/** One list as asked: the call's parameters on a first page, the cursor's on a continuation. */
interface Ask {
  user?: string; dateFrom?: string; dateTo?: string;
  afOnly: boolean; quickTakesOnly: boolean; minKarma?: number; sort: Sort; limit: number;
}

const askOf = (p: ListCommentsParams): Ask => ({
  user: p.user, dateFrom: p.date_from, dateTo: p.date_to, afOnly: p.af_only, quickTakesOnly: p.quick_takes_only,
  minKarma: p.min_karma, sort: p.sort, limit: p.limit,
});

/**
 * ¶3.6 depth guard: true exactly for a `new`/`old` list with no person, no dates, no karma floor and not quick takes. `af_only`
 * does not narrow. A site-wide list in date order that nothing narrows ends after 500 comments.
 */
export function depthGuarded(
  p: Pick<ListCommentsParams, "user" | "date_from" | "date_to" | "min_karma" | "quick_takes_only" | "sort">,
): boolean {
  return (p.sort === "new" || p.sort === "old") && p.user === undefined && p.date_from === undefined && p.date_to === undefined
    && p.min_karma === undefined && !p.quick_takes_only;
}

/**
 * ¶3.6: the effective values a cursor compares: defaults applied, `user` as the id it resolved to, dates as the identity of
 * the period they name (never clamped, so a repeated `date_to: "2026"` still matches after the clock moves). Absent values are
 * `undefined`. `get_user`'s hand-off stores the same keys.
 */
export function listCommentsEffective(p: ListCommentsParams, ids: { userId?: string }): Record<string, unknown> {
  return {
    user: ids.userId, date_from: effectiveDate(p.date_from, "from"), date_to: effectiveDate(p.date_to, "to"), af_only: p.af_only,
    quick_takes_only: p.quick_takes_only, min_karma: p.min_karma, sort: p.sort, limit: p.limit,
  };
}

/**
 * The period, and ¶3.4's window rule before any request: site-wide `top` and quick takes (no `user`) need both dates, at most
 * 31 days apart. The tool phrase names the case, so the message does not say that every `list_comments` needs dates.
 */
function rangeOf(ask: Ask, now: number): DateRange {
  const range = parseRange(ask.dateFrom, ask.dateTo, now);
  if (ask.user === undefined && (ask.sort === "top" || ask.quickTakesOnly)) {
    const phrase = ask.quickTakesOnly ? "list_comments with quick_takes_only and no user" : "list_comments with sort top and no user";
    requireWindow(range, CONFIG.paging.windowDaysMax, phrase);
  }
  return range;
}

async function userOf(user: string | undefined, ctx: CallContext, svc: Services): Promise<Resolved | undefined> {
  return user === undefined ? undefined : resolve(parseRef("user", user, ["user"]), "user", ctx, svc);
}

// the plan: mode, filters and the re-checks

/** ¶4.6 behaviour, first match wins. */
type Mode = "quick" | "personTop" | "siteTop" | "dated";

interface Plan {
  ask: Ask;
  range: DateRange;
  user?: Resolved;
  mode: Mode;
  /** `minimumKarma` is sent only from 1 up; a floor of 0 or below is checked here alone. */
  minimumKarma?: number;
  /** A person's comments (or quick takes, with `user`): a bounded selector, whose first raw page carries `enableTotal` (P10). */
  bounded: boolean;
  /** ¶3.6 depth guard of a site-wide `new`/`old` list. */
  depthGuard: boolean;
  /** Under `top` or `min_karma`: a comment whose karma is hidden is left out (P18, C-HIDDEN-KARMA-ORDER). */
  karmaOrder: boolean;
  check: CommentFilters;
}

function modeOf(ask: Ask): Mode {
  if (ask.quickTakesOnly) return "quick";
  if (ask.sort === "top") return ask.user === undefined ? "siteTop" : "personTop";
  return "dated";
}

function planOf(ask: Ask, range: DateRange, user: Resolved | undefined): Plan {
  const { minKarma } = ask;
  return {
    ask, range, ...(user !== undefined && { user }), mode: modeOf(ask),
    ...(minKarma !== undefined && minKarma >= 1 && { minimumKarma: minKarma }),
    bounded: user !== undefined,
    depthGuard: depthGuarded({
      user: ask.user, date_from: ask.dateFrom, date_to: ask.dateTo, min_karma: minKarma, quick_takes_only: ask.quickTakesOnly, sort: ask.sort,
    }),
    karmaOrder: ask.sort === "top" || minKarma !== undefined,
    check: { af: ask.afOnly, range, minKarma, authorId: user?.id, topLevel: ask.quickTakesOnly },
  };
}

/** A light row passes the filters that can be told from its fields (P18, `af_only`, the period, `min_karma`, the person). */
function lightKeeps(plan: Plan, row: RawCommentLight): boolean {
  if (plan.karmaOrder && (row.hideKarma || row.baseScore === null)) return false;
  return recheckComment(row, plan.check);
}

/**
 * A full row passes the D1 rules and every requested filter. Dropped in this order: not public (P2, P5, P6), deleted
 * (placeholders are not listed), a debate turn, the anonymity rule (P7), hidden karma where karma orders or filters (P18), the
 * re-check of what the forum was asked.
 */
function shows(plan: Plan, row: RawCommentList): boolean {
  if (!commentPublic(row)) return false;
  if (row.deleted || row.debateResponse === true) return false;
  if (plan.user !== undefined && row.hideAuthor) return false;
  if (plan.karmaOrder && (row.hideKarma || row.baseScore === null)) return false;
  return recheckComment(row, plan.check);
}

// one page of the list, however it is read

/** What every mode yields for the page: its printable rows, and the states that continue the list. */
interface Listing {
  rows: RawCommentList[];
  /** The state this page started from. */
  first: StreamState;
  /** The state right after the first `n` rows, for `n` below `rows.length`. */
  stateAt(n: number): StreamState;
  /** The state after every row; undefined once the list has ended. */
  resume?: StreamState;
  /** The `End of reachable results` reason when a limit ended the list (C-DEPTH, the depth guard). */
  endLine?: string;
  stopped?: StopReason;
  /** Offset streams can shift between pages as votes arrive (C-DRIFT). */
  drift: boolean;
  checked: number;
  /** A head line about this page of the list: the short-page note, or a light set's drift note. */
  note?: string;
}

/** `state` counting `shown` comments shown: a hydrated row can be dropped after the list counted it. */
const withShown = (state: StreamState, shown: number): StreamState => ({ ...state, shown });

/** The documents of `ids` in one by-id request (R2, R10: an explicit limit), by id; none for no ids. */
async function hydrate(ids: readonly string[], ctx: CallContext, svc: Services): Promise<Map<string, RawCommentList>> {
  const docs = new Map<string, RawCommentList>();
  const ops = commentsByIdsOps(ALIAS.hydrate, ids, "...COMMENT_LIST");
  if (ops.length === 0) return docs;
  const results = await svc.gql(ops, ctx, HYDRATE_TASK);
  for (const o of ops) {
    for (const doc of rowsOf<RawCommentList>(aliasData(results, o.alias, HYDRATE_TASK, ctx))) {
      if (typeof doc._id === "string") docs.set(doc._id, doc);
    }
  }
  return docs;
}

/** Hydrates `ids` and keeps, in their order, the rows that pass `shows`; `at[k]` is the index in `ids` of the kth row kept. */
async function shownRows(
  plan: Plan, ids: readonly string[], ctx: CallContext, svc: Services,
): Promise<{ rows: RawCommentList[]; at: number[] }> {
  const docs = await hydrate(ids, ctx, svc);
  const rows: RawCommentList[] = [];
  const at: number[] = [];
  ids.forEach((id, j) => {
    const doc = docs.get(id);
    if (doc !== undefined && shows(plan, doc)) {
      rows.push(doc);
      at.push(j);
    }
  });
  if (rows.length < ids.length) svc.log.debug("list_comments rows dropped by the re-checks", { dropped: ids.length - rows.length });
  return { rows, at };
}

// ----- the date lists and site-wide top: raw pages, by keyset or by offset

/** The terms of one raw page: the plan's, with the window (or the whole period) as `after`/`before`. */
function termsOf(plan: Plan, bounds: { after?: number; before?: number }): AllRecentTerms {
  return {
    ...(plan.user !== undefined && { userId: plan.user.id }), sortBy: plan.ask.sort,
    ...(bounds.after !== undefined && { after: isoMs(bounds.after) }), ...(bounds.before !== undefined && { before: isoMs(bounds.before) }),
    ...(plan.minimumKarma !== undefined && { minimumKarma: plan.minimumKarma }),
  };
}

/**
 * The paged source of `plan` over full rows or, for the `af_only` scan, light rows. A raw page is `size` rows: `rawCount` is
 * the limit sent, never the rows returned, and `totalCount` comes only from a page sent with `enableTotal`, which a bounded
 * selector's first raw page carries (P10).
 */
function sourceOf<T extends { _id: string; postedAt: string }>(plan: Plan, fields: "list" | "light", svc: Services): PagedSource<T> {
  const alias = fields === "light" ? ALIAS.scan : plan.mode === "siteTop" ? ALIAS.siteTop : ALIAS.list;
  const task = fields === "light" ? SCAN_TASK : LIST_TASK;
  const read = async (terms: AllRecentTerms, offset: number, size: number, first: boolean, ctx: CallContext): Promise<RawPage<T>> => {
    const total = plan.bounded && first;
    const page = { limit: size, ...(offset > 0 && { offset }), ...(total && { enableTotal: true as const }) };
    const data = aliasData(await svc.gql([allRecentCommentsOp(alias, terms, page, fields)], ctx, task), alias, task, ctx);
    const totalCount = total && isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
    return { rows: rowsOf<T>(data), rawCount: size, ...(totalCount !== undefined && { totalCount }) };
  };
  // ¶3.6: every list_comments call accepts date_from/date_to and sort new/old, so the C-DEPTH hint may name them (in date order, the dates alone).
  if (plan.mode === "siteTop") {
    const source: OffsetSource<T> = {
      kind: "offset", bounded: false, idOf, endHint: DEPTH_HINT.dates,
      fetch: (offset, size, first, ctx) => read(termsOf(plan, { after: plan.range.start, before: plan.range.endExclusive }), offset, size, first, ctx),
    };
    return source;
  }
  const source: KeysetSource<T> = {
    kind: "keyset", dir: plan.ask.sort === "old" ? "old" : "new", bounded: plan.bounded, range: plan.range, depthGuard: plan.depthGuard,
    endHint: DEPTH_HINT.datesOnly, idOf, timeOf: postedMs,
    fetch: (window, offset, size, first, ctx) => read(termsOf(plan, window), offset, size, first, ctx),
  };
  return source;
}

/** What a `Collected` run says about the page, over the rows that were printed. */
function listingOf<T>(c: Collected<T>, rows: RawCommentList[], at: readonly number[]): Listing {
  const shown0 = c.first.shown;
  // The pager counts the items it kept; a hydrated row can be dropped after that, so the states count the rows printed.
  const stateAt = (n: number): StreamState => (n === 0 ? c.first : withShown(stateAfter(c, at[n - 1]! + 1)!, shown0 + n));
  const resume = c.ended ? undefined : stateAfter(c, c.items.length);
  return {
    rows, first: c.first, stateAt, ...(resume !== undefined && { resume: withShown(resume, shown0 + rows.length) }),
    ...(c.endLine !== undefined && { endLine: c.endLine }), ...(c.stopped !== undefined && { stopped: c.stopped }), drift: c.drift,
    // A stopped page's footer says why it is short, so the neutral note is left out; the filter's kept-count note stays.
    checked: c.checked, ...(c.note !== undefined && !c.ended && rows.length > 0 && !(c.stopped !== undefined && c.note === SHORT_PAGE_NOTE) && { note: c.note }),
  };
}

/** A page of a list the forum orders, read as full rows: keyset or offset, refilled within the request cap (¶3.6). */
async function streamListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const col = await collect(sourceOf<RawCommentList>(plan, "list", svc), start, plan.ask.limit, (row) => shows(plan, row), ctx);
  const dropped = col.checked - col.kept;
  if (dropped > 0) svc.log.debug("list_comments rows dropped by the re-checks", { dropped });
  return listingOf(col, col.items, col.items.map((_, i) => i));
}

/** ¶3.6 scan, then hydrate: light rows in raw pages of 500, at most 3, keep `af`; only the kept ids are fetched in full. */
async function scanListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  const col = await scanThenKeep(sourceOf<RawCommentLight>(plan, "light", svc), start, plan.ask.limit, (row) => lightKeeps(plan, row), ctx, {
    filterName: "af_only", unit: "comments",
  });
  const dropped = col.checked - col.kept;
  if (dropped > 0) svc.log.debug("list_comments rows dropped by the re-checks", { dropped });
  const { rows, at } = await shownRows(plan, col.items.map(idOf), ctx, svc);
  return listingOf(col, rows, at);
}

// ----- the light sets: quick takes and a person's top

/**
 * The op of the whole set as light rows (one raw page of at most 2,000): quick takes by `topShortform`, a person's comments by
 * `allRecentComments` in date order (ranked here). Dates are `bounds`; `min_karma` is checked here, so the set is the same for
 * every filter and order over these terms.
 */
function lightSetOp(plan: Plan, bounds: { after?: string; before?: string }, offset?: number): GqlOp {
  const page = {
    limit: CONFIG.paging.lightScanCap, ...(offset !== undefined && offset > 0 && { offset }),
    ...(plan.user !== undefined && { enableTotal: true as const }),
  };
  const userId = plan.user?.id;
  if (plan.mode === "quick") return topShortformOp(ALIAS.quick, { ...(userId !== undefined && { userId }), ...bounds }, page);
  return allRecentCommentsOp(ALIAS.person, { userId, sortBy: "new", ...bounds }, page, "light");
}

/**
 * The light set (the `scan` cache, key `<template>:<text of the first raw page>`), or one request of at most 2,000 rows: a full
 * raw page is `too_broad` (Q74, ¶3.6). A `date_to` clamped to now is keyed by the end of its period, not the clamped instant that
 * moves with the clock: the key names the period asked for, as the cursor's effective values do, so a continuation reads the set
 * fetched once. The cached rows are as the forum sent them; filters and order are applied on every call.
 */
async function loadLightSet(plan: Plan, ctx: CallContext, svc: Services): Promise<RawCommentLight[]> {
  const sent = toViewTerms(plan.range);
  const keyed = plan.range.clampedTo === undefined
    ? sent
    : { ...sent, before: isoMs(Date.parse(effectiveDate(plan.ask.dateTo, "to")!) + 1) };
  const keyOp = lightSetOp(plan, keyed);
  const key = `${keyOp.template}:${keyOp.text}`;
  const cached = svc.caches.get<RawCommentLight[]>("scan", key);
  if (cached !== undefined) return cached;
  const { rows } = await lightScan<RawCommentLight>(
    async (offset) => {
      const o = lightSetOp(plan, sent, offset);
      const data = aliasData(await svc.gql([o], ctx, SCAN_TASK), o.alias, SCAN_TASK, ctx);
      const totalCount = plan.bounded && isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
      return { rows: rowsOf<RawCommentLight>(data), rawCount: CONFIG.paging.lightScanCap, ...(totalCount !== undefined && { totalCount }) };
    },
    { overCap: plan.mode === "quick" ? OVER_CAP.quick : OVER_CAP.person },
  );
  svc.caches.set("scan", key, rows);
  return rows;
}

/** ¶3.3: `new` by `postedAt` descending, `old` ascending, `top` by `baseScore` descending; ties newer first, then `_id` descending. */
function setOrder(sort: Sort): (a: RawCommentLight, b: RawCommentLight) => number {
  switch (sort) {
    case "top": return compareLocal<RawCommentLight>((r) => r.baseScore, postedMs, idOf);
    case "old": return compareLocal<RawCommentLight>(postedMs, postedMs, idOf, "asc");
    default: return compareLocal<RawCommentLight>(postedMs, postedMs, idOf);
  }
}

/** A page of a light set: a `list` over the filtered, ordered rows; only the page shown is fetched in full (R2, R10). */
async function setListing(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  if (start !== undefined && start.kind !== "list") throw internalError("list_comments", `a ${start.kind} state for a light set`);
  const rows = await loadLightSet(plan, ctx, svc);
  const set = rows.filter((row) => lightKeeps(plan, row)).sort(setOrder(plan.ask.sort));
  if (rows.length > set.length) svc.log.debug("list_comments rows dropped by the re-checks", { dropped: rows.length - set.length });
  const page = listPage(set, start, plan.ask.limit, idOf, postedMs);
  const shown = await shownRows(plan, page.items.map(idOf), ctx, svc);
  const first: StreamState = start ?? { kind: "list", shown: 0, index: 0 };
  // The states after a page's rows, counting the comments printed.
  const after = (j: number, n: number): StreamState => withShown(page.after[j]!, first.shown + n);
  const last = page.items.length === 0 ? first : after(page.items.length - 1, shown.rows.length);
  return {
    rows: shown.rows, first, stateAt: (n) => (n === 0 ? first : after(shown.at[n - 1]!, n)), ...(!page.ended && { resume: last }),
    drift: false, checked: page.items.length, ...(page.driftNote !== undefined && { note: page.driftNote }),
  };
}

/** The page of `plan` from `start`, by its mode. */
function listingFor(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Listing> {
  switch (plan.mode) {
    case "quick":
    case "personTop":
      return setListing(plan, start, ctx, svc);
    default:
      return plan.ask.afOnly ? scanListing(plan, start, ctx, svc) : streamListing(plan, start, ctx, svc);
  }
}

// the page

interface PageInput {
  plan: Plan;
  /** The cursor's state; undefined on page 1. */
  state?: CursorState;
  from?: number;
  echo: CallContext;                // its `given` decides the request echo's `(default)` marks
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** ¶3.7 request echo, in the order of ¶4.6. */
function requestEcho(input: PageInput): string[] {
  const { plan, echo } = input;
  const { ask, user } = plan;
  const out: string[] = [];
  if (user !== undefined) out.push(echoOf("user", user));
  out.push(...dateEchoes(plan.range));
  if (ask.afOnly) out.push(setting(echo, "af_only", true));
  if (ask.quickTakesOnly) out.push(setting(echo, "quick_takes_only", true));
  if (ask.minKarma !== undefined) out.push(setting(echo, "min_karma", ask.minKarma));
  out.push(setting(echo, "sort", ask.sort), setting(echo, "limit", ask.limit));
  return out;
}

/**
 * ¶3.9 the filtered-list template. A person's list with a date range says so and suggests dropping the range (¶4.6); any other
 * restates the filters, the person included, and suggests nothing.
 */
function emptyLine(plan: Plan): string {
  const { ask, user } = plan;
  const period = periodText(plan.range);
  const others = [
    ...(period === undefined ? [] : [period]),
    ...(ask.afOnly ? ["AF only"] : []),
    ...(ask.quickTakesOnly ? ["quick takes only"] : []),
    ...(ask.minKarma === undefined ? [] : [`karma at least ${fmtInt(ask.minKarma)}`]),
  ];
  if (user !== undefined && period !== undefined) {
    return emptyText({
      kind: "filtered", items: `publicly visible comments by ${quoted(user.name)}`, filters: others.join(", "), suggestions: [SUGGEST_NO_DATES],
    });
  }
  const by = user === undefined ? [] : [`by ${personText({ kind: "user", id: user.id, slug: user.slug ?? null, name: user.name })}`];
  const filters = [...by, ...others];
  return emptyText({ kind: "filtered", items: "comments", filters: filters.length === 0 ? "no filters" : filters.join(", ") });
}

function subjectOf(plan: Plan): string {
  const what = plan.ask.quickTakesOnly ? "quick takes" : "comments";
  return plan.user === undefined ? `${what} site-wide` : `${what} by ${quoted(plan.user.name)}`;
}

/** One page: the listing, its rows in list form, and the footer that continues it. */
async function pageOf(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { plan, state } = input;
  const { ask } = plan;
  const main = await listingFor(plan, state?.streams[0], ctx, svc);
  const shown0 = main.first.shown;
  // The place and the parent are read through the masked joins (P1, P5–P7, P14); a row without a join reads as hidden.
  const records = main.rows.map((row) => ({ ...toCommentRecord(row), place: placeOf(row), parent: parentOf(row) }));
  const goesOn = main.resume !== undefined;

  const notes = plan.karmaOrder ? [CAVEAT["C-HIDDEN-KARMA-ORDER"]] : [];
  const head: string[] = [];
  if (main.note !== undefined) head.push(main.note);
  if (records.length === 0) {
    if (goesOn) {
      if (main.checked > 0) head.push(emptyText({ kind: "scan", checked: main.checked }));
    } else if (shown0 === 0 && main.endLine === undefined) {
      head.push(emptyLine(plan));
    }
  }

  const items: PageItem[] = records.map((rec, j) => ({
    text: commentBlock(rec, { form: "list", bodyCapTokens: CONFIG.render.listCommentCapTokens }),
    ...(j === 0 && input.from !== undefined && { from: input.from }),
  }));
  const position = records.length === 0 ? undefined : (c: Consumed): string => {
    const touched = Math.max(1, Math.min(c.items, records.length) + (c.sliceTo === undefined ? 0 : 1));
    return positionText(UNIT, shown0 + 1, shown0 + touched);
  };

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, records.length);
    const cursorAt = (at: StreamState, from?: number): string =>
      mint(svc, "list_comments", input.args, input.effective, { streams: [at], current: 0, ...(from !== undefined && { data: { from } }) });
    const drift = main.drift ? { drift: true as const } : {};
    const more = (cursor: string, shown: number): Footer =>
      ({ kind: "more", tool: "list_comments", cursor, next: nextText(UNIT, shown0 + shown + 1, shown0 + shown + ask.limit), ...drift });
    // The page ends inside the list (the budget cut it): the cursor continues after the rows shown whole, or inside the sliced one.
    if (n < records.length) return more(cursorAt(main.stateAt(n), c.sliceTo), n);
    if (main.resume !== undefined) {
      const cursor = cursorAt(main.resume);
      if (main.stopped !== undefined) return { kind: "stopped", why: main.stopped, tool: "list_comments", cursor, ...drift };
      return more(cursor, records.length);
    }
    return main.endLine !== undefined ? { kind: "reachable", reason: main.endLine } : { kind: "end" };
  };

  return reply(
    {
      tool: "list_comments", subject: subjectOf(plan), request: requestEcho(input), ...(position !== undefined && { position }),
      oneItem: shown0 === 0 && records.length === 1 && !goesOn, notes, head, items,
    },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

async function firstPage(p: ListCommentsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const ask = askOf(p);
  const range = rangeOf(ask, ctx.now());
  const user = await userOf(ask.user, ctx, svc);
  const args = givenArgs(p, ctx);
  return pageOf({ plan: planOf(ask, range, user), echo: ctx, args, effective: listCommentsEffective(p, { userId: user?.id }) }, p.max_tokens, ctx, svc);
}

/** The list a cursor continues: its stored values, with `user` and the dates as first given (to resolve and parse again). */
function storedAsk(entry: CursorEntry): Ask {
  const e = entry.effective as { user?: string; af_only?: boolean; quick_takes_only?: boolean; min_karma?: number; sort: Sort; limit: number };
  const a = entry.args as Partial<ListCommentsParams>;
  return {
    user: a.user ?? e.user, dateFrom: a.date_from, dateTo: a.date_to, afOnly: e.af_only === true, quickTakesOnly: e.quick_takes_only === true,
    minKarma: e.min_karma, sort: e.sort, limit: e.limit,
  };
}

async function continuation(entry: CursorEntry, p: ListCommentsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: `user` given again is resolved first, so a slug equals the id it resolves to; dates are compared by the period they name.
  const given = ctx.given.has("user") ? await userOf(p.user, ctx, svc) : undefined;
  checkContinuation(entry, listCommentsEffective(p, { userId: given?.id }), ctx);
  const ask = storedAsk(entry);
  // The period is computed again with the current time (the clamp may move); windows already shown are not affected.
  const range = rangeOf(ask, ctx.now());
  // D1 on every continuation: the person is resolved again (from the cache, or with one request).
  const user = await userOf(ask.user, ctx, svc);
  const data = entry.state.data;
  const from = isRecord(data) && typeof data.from === "number" ? data.from : undefined;
  return pageOf(
    {
      plan: planOf(ask, range, user), state: entry.state, ...(from !== undefined && { from }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  user: P.user().optional(),
  date_from: P.dateFrom().optional(),
  date_to: P.dateTo().optional(),
  af_only: P.flag("af_only"),
  quick_takes_only: P.flag("quick_takes_only"),
  min_karma: P.minKarma().optional(),
  sort: P.sort("list_comments"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<ListCommentsParams> = {
  name: "list_comments",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  run(p, ctx, svc) {
    const entry = openContinuation("list_comments", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
