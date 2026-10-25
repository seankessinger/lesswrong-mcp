// Layer 2. The `list_posts` tool (¶4.5): post lists filtered by person, tag, period, AF and status, best first or by date.
// Before any request the sort's prerequisites and the dates are checked; `user` and `tag` are then resolved together (at
// most one request, which is also their visibility check). One view key per request (R1): `userPosts` with `user` (own and
// coauthored posts, the tag as the Required filter), `tagRelevance` with only `tag`, else the sort's site-wide view, always
// with `excludeEvents: true`. Every row is re-checked against every filter that was asked of the forum (trust but verify,
// Q8, Q55, Q58) and the D1 list rules; only the number dropped is debug-logged. `new`/`old` page by keyset on `postedAt`;
// `top`, `active` and `tag_relevance` without `user` by raw offset up to 2000 (C-DEPTH), their footers carrying C-DRIFT;
// short pages are refilled within the request cap (¶3.6). Under `top` with `min_karma` the list ends at the first row below
// N, since rows arrive in karma order. With `tag` and no `user`, page 1 shows the forum's count when every filter was the
// forum's (P10).
// The light-scan sorts (`af_top`, `curated_date`, and `tag_relevance` with `user`, which `userPosts` cannot order) read the
// whole set once as `POST_LIGHT` rows (at most 2,000, else `too_broad`), sort it here (¶3.3), cache the sorted ids and page
// them as a `list`; only the page shown is fetched in full. With `query` (only with `tag`), page 1 ends with the untagged
// section: one search on `posts_karma` with the one deliberate negated facet (Q38), its hits hydrated by id and checked here
// (visibility, every filter but the tag, the list rules, no anonymous posts, P7); the cursor keeps it as a second (`search`)
// stream, which later pages continue once the tagged list has ended.
import { z } from "zod";
import { CONFIG } from "../config";
import { recheck, type PostFilters } from "../domain/filters";
import { lastCommentOf, toPostRecord } from "../domain/posts";
import { postListable, postPublic } from "../domain/visibility";
import { badInput, CallStopped, internalError } from "../errors";
import { buildSearch } from "../forum/search";
import { listPostsOp, type ListPostsTerms, type PostsView } from "../forum/templates/list_posts";
import { postsByIdsOp } from "../forum/templates/shared";
import { isEntityId } from "../ids/parse";
import { echoOf } from "../ids/resolve";
import {
  collect, compareLocal, fingerprint, lightScan, listPage, searchPageAllowed, stateAfter, type KeysetSource, type OffsetSource,
  type PagedSource, type RawPage,
} from "../paging/pager";
import { CONVENTIONS_LINE, listPostsDefaultSort, P } from "../params/vocabulary";
import { CAVEAT, DEPTH_HINT, emptyText, END_SEARCH_DEPTH, FLAG, fmtInt, SHORT_PAGE_NOTE } from "../render/messages";
import { personText, postLine } from "../render/records";
import { effectiveDate, isoMs, parseRange, toViewTerms } from "../text/dates";
import { sanitizeQuery } from "../text/phrases";
import { oneLine } from "../text/sanitize";
import type {
  CallContext, Consumed, CursorEntry, CursorState, DateRange, Facet, Footer, PageItem, RawPostCard, RawPostLight, SearchHit,
  SearchResult, SearchSpec, Services, SortValue, StopReason, StreamState, ToolDef, ToolOutput,
} from "../types";
import {
  checkContinuation, dateEchoes, type Filters, givenArgs, isRecord, mint, nextText, openContinuation, periodText, positionText, reply, resolveFilters, rowsOf,
  setting, tagFilterText, tagIdOf,
} from "./common";
import { aliasData } from "./loaders";

export type ListPostsParams = {
  user?: string; tag?: string; date_from?: string; date_to?: string; af_only: boolean; curated_only: boolean;
  frontpage_only: boolean; questions_only: boolean; min_karma?: number; sort?: SortValue; query?: string; limit: number;
  cursor?: string; max_tokens: number;
};

const TITLE = "What did X post about T in a period, best first?";
/** ¶4.5, verbatim. */
const DESCRIPTION_QUOTE = "List posts with filters, best first or by date. limit counts posts. Filters: user (their own and coauthored posts; sub-questions and group posts that the site lists only under their author are included, flagged), tag (only posts readers tagged with it, relevance 1 or more), date_from/date_to (posting date), af_only, curated_only, frontpage_only, questions_only, min_karma (karma at least N; the forum's threshold uses a background-updated maximum, so a post that only just reached N can be missing for a while; results are re-checked here). sort: top (karma; the default when tag is given), new (the default otherwise), old, active (latest comment first; each post shows its last comment date, and an uncommented post counts its posting date), tag_relevance (needs tag: how strongly readers tied the post to the tag, not quality), curated_date (needs curated_only), af_top (AF posts by AF karma, then the others by karma; needs user or tag, and at most 2,000 matching posts). query (only with tag): after the tagged posts, posts that match these words and every other filter but are not tagged (site search by karma; it knows only primary authors, so coauthored posts are missed); the first page shows up to 10 of them, and the cursor continues them once the tagged list ends. Event and meetup posts are not listed here; they open by id and can appear in search. Quick-take containers and posts that are not publicly visible are never listed; negative-karma posts are included unless min_karma excludes them. Each post shows ids, title, authors, date, karma and votes, comment count (~), AF and curated/frontpage/pinned/Best-of status, tags with relevance, and an excerpt. With tag and no user, the header also gives the forum's count of the listed posts when every filter was applied by the forum. Paging: new and old go back without limit (site-wide lists filtered by nothing but af_only stop after 500 posts). For the other sorts, the forum can't list beyond about the 2,000th result in this order (narrow the dates to go further), and rankings can shift between pages as votes arrive.";

const LIST_TASK = "listing posts";
const SCAN_TASK = "scanning posts";
const HYDRATE_TASK = "reading the posts shown";
const SEARCH_TASK = "searching for untagged posts";
const SECTION_HYDRATE_TASK = "reading the untagged posts";
/** The alias every list page and light scan is read under; the page shown and the untagged hits are hydrated under `h` and `x`. */
const ALIAS = "l";
const HYDRATE_ALIAS = "h";
const SECTION_ALIAS = "x";
/** How much of a caller's date an echo line quotes. */
const QUOTED_CAP = 60;
/** How much of the query and its removals an echo line or the section's head line quotes (the query's own bound, ¶3.2). */
const QUERY_CAP = 300;
/** ¶4.5, ¶7: the untagged section reads one search page of the posts index's cap (10) per call, and page 1 shows up to that many. */
const SECTION_HITS = CONFIG.search.hitsPerPage.posts;
/** The unit of the untagged section in the position line and the footer. */
const SECTION_UNIT = "untagged matches";
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** ¶4.5 "Errors and empty results": the empty template's suggestions, in this order. */
const SUGGEST = {
  af: "try without af_only",
  dates: "widen date_from/date_to",
  tag: "add query, or use search, for untagged posts",
} as const;

// what one call asks for, and the checks before any request

/** One list as asked: the call's parameters on a first page, the cursor's on a continuation. */
interface Ask {
  user?: string; tag?: string; dateFrom?: string; dateTo?: string; query?: string;
  afOnly: boolean; curatedOnly: boolean; frontpageOnly: boolean; questionsOnly: boolean;
  minKarma?: number; sort: SortValue; limit: number;
}

const askOf = (p: ListPostsParams): Ask => ({
  user: p.user, tag: p.tag, dateFrom: p.date_from, dateTo: p.date_to, query: p.query,
  afOnly: p.af_only, curatedOnly: p.curated_only, frontpageOnly: p.frontpage_only, questionsOnly: p.questions_only,
  minKarma: p.min_karma, sort: p.sort ?? listPostsDefaultSort(p.tag !== undefined), limit: p.limit,
});

/** ¶4.5: the sorts and the query that need another parameter; `bad_input` before any request. */
function checkPrerequisites(ask: Ask): void {
  if (ask.sort === "tag_relevance" && ask.tag === undefined) throw badInput("sort", "tag_relevance needs tag", "Give tag, or use another sort.");
  if (ask.sort === "curated_date" && !ask.curatedOnly) throw badInput("sort", "curated_date needs curated_only", "Add curated_only: true.");
  if (ask.sort === "af_top" && ask.user === undefined && ask.tag === undefined) {
    throw badInput("sort", "af_top needs user or tag (it ranks at most 2,000 matching posts)", "Add user or tag.");
  }
  if (ask.query !== undefined && ask.tag === undefined) {
    throw badInput("query", "needs tag; for word matches without a tag use search", `Try search {query: ${JSON.stringify(oneLine(ask.query, 300))}}.`);
  }
  // As in search (¶3.9 an unsearchable query): nothing would be searched, and the untagged section would be skipped unsaid.
  if (ask.query !== undefined && !WORD_CHAR.test(sanitizeQuery(ask.query).text)) {
    throw badInput("query", `${JSON.stringify(oneLine(ask.query, QUOTED_CAP))} leaves nothing to search for (no letters or digits)`, "Give words to search for, or leave out query.");
  }
}

/**
 * ¶3.6 depth guard: true exactly for a `new`/`old` list with no person, no tag, no dates and no status or karma filter. `af_only`
 * does not narrow. A site-wide list in date order that nothing narrows ends after 500 posts.
 */
export function depthGuarded(
  p: Pick<ListPostsParams, "user" | "tag" | "date_from" | "date_to" | "af_only" | "curated_only" | "frontpage_only" | "questions_only" | "min_karma"> & { sort: SortValue },
): boolean {
  return (p.sort === "new" || p.sort === "old") && p.user === undefined && p.tag === undefined && p.date_from === undefined && p.date_to === undefined
    && !p.curated_only && !p.frontpage_only && !p.questions_only && p.min_karma === undefined;
}

/** The ids the filters resolved to: a lens or summary given as `tag` filters by its page (P12). */
function idsOf(f: Filters): { userId?: string; tagId?: string } {
  return { userId: f.user?.id, tagId: f.tag === undefined ? undefined : tagIdOf(f.tag) };
}

/**
 * ¶3.6: the effective values a cursor compares: defaults applied, `user` and `tag` as the ids they resolved to, dates as the
 * identity of the period they name (never clamped, so a repeated `date_to: "2026"` still matches after the clock moves), the
 * query as it would be sent. Absent values are `undefined`.
 */
export function listPostsEffective(p: ListPostsParams, ids: { userId?: string; tagId?: string }): Record<string, unknown> {
  return {
    user: ids.userId, tag: ids.tagId, date_from: effectiveDate(p.date_from, "from"), date_to: effectiveDate(p.date_to, "to"),
    af_only: p.af_only, curated_only: p.curated_only, frontpage_only: p.frontpage_only, questions_only: p.questions_only,
    min_karma: p.min_karma, sort: p.sort ?? listPostsDefaultSort(!!ids.tagId), query: p.query ? sanitizeQuery(p.query).text : undefined,
    limit: p.limit,
  };
}

// the view, its terms and the re-checks

/** What is sent and how each row is checked. */
interface Plan {
  ask: Ask;
  range: DateRange;
  filters: Filters;
  view: PostsView;
  /** The selector terms without the date bounds, which the stream adds (the period, or a keyset window inside it). */
  terms: ListPostsTerms;
  check: PostFilters;
  /** ¶4.5 light-scan sorts: the whole set as light rows, sorted here and paged as a `list`. */
  scan: boolean;
  /** `new`/`old` page by keyset on `postedAt`; every other sort that is not a light scan by raw offset. */
  keyset?: "new" | "old";
  /** A person's or a tag's posts: a bounded selector, whose first raw page carries `enableTotal` (P10). */
  bounded: boolean;
  /** ¶3.6 depth guard: a site-wide list in date order that nothing but `af_only` narrows. */
  depthGuard: boolean;
  /** Under `top` with `min_karma`: rows arrive in karma order, so the first row below this ends the list. */
  floor?: number;
  /** `query` (only with `tag`) as the untagged section searches it (Q32), with what sanitizing removed. */
  query?: { text: string; removed: string[] };
}

/** ¶4.5 view table: a person's posts, else a tag's, else the sort's site-wide view. */
function viewOf(ask: Ask): PostsView {
  if (ask.user !== undefined) return "userPosts";
  if (ask.tag !== undefined) return "tagRelevance";
  switch (ask.sort) {
    case "new": return "new";
    case "old": return "old";
    case "active": return "recentComments";
    case "curated_date": return "curated";
    default: return "top";
  }
}

/** ¶4.5 `sortedBy` (honoured only by views without their own sort, §6.2); `relevance` only on `tagRelevance`. */
function sortedByOf(sort: SortValue, view: PostsView): ListPostsTerms["sortedBy"] {
  switch (sort) {
    case "new": return "new";
    case "old": return "old";
    case "active": return "recentComments";
    case "tag_relevance": return view === "tagRelevance" ? "relevance" : "top";
    default: return view === "curated" ? undefined : "top";
  }
}

/** ¶4.5, ¶3.6: the sorts the forum cannot do over the set, which a light scan sorts here. */
function isLightScan(ask: Ask): boolean {
  return ask.sort === "af_top" || ask.sort === "curated_date" || (ask.sort === "tag_relevance" && ask.user !== undefined);
}

function planOf(ask: Ask, range: DateRange, filters: Filters): Plan {
  const { userId, tagId } = idsOf(filters);
  const view = viewOf(ask);
  const minKarma = ask.minKarma;
  const scan = isLightScan(ask);
  const terms: ListPostsTerms = {
    ...(view === "userPosts" && { userId }), ...(tagId !== undefined && { tagId }), sortedBy: sortedByOf(ask.sort, view),
    ...(ask.afOnly && { af: true as const }), ...(ask.questionsOnly && { question: true as const }),
    // ¶4.5: under `top` the list ends at the first row below N, so no threshold is sent; N ≤ 0 is a local filter only.
    ...(minKarma !== undefined && minKarma >= 1 && ask.sort !== "top" && { karmaThreshold: minKarma }),
    // With both, curated is the forum's filter and frontpage is checked here; the `curated` view is itself the curated filter, so
    // it carries no filter term at all (a `frontpage` fragment inside it would be sent with no `curated` one to AND with).
    filter: ask.curatedOnly ? (view === "curated" ? undefined : "curated") : ask.frontpageOnly ? "frontpage" : undefined,
  };
  const bounded = userId !== undefined || tagId !== undefined;
  const keyset = !scan && (ask.sort === "new" || ask.sort === "old") ? ask.sort : undefined;
  return {
    ask, range, filters, view, terms, bounded, keyset, scan,
    check: {
      af: ask.afOnly, question: ask.questionsOnly, tagId, curated: ask.curatedOnly, frontpage: ask.frontpageOnly, range, minKarma,
      authorId: userId,
    },
    depthGuard: depthGuarded({
      user: ask.user, tag: ask.tag, date_from: ask.dateFrom, date_to: ask.dateTo, af_only: ask.afOnly, curated_only: ask.curatedOnly,
      frontpage_only: ask.frontpageOnly, questions_only: ask.questionsOnly, min_karma: minKarma, sort: ask.sort,
    }),
    ...(ask.sort === "top" && minKarma !== undefined && { floor: minKarma }),
    ...(ask.query !== undefined && { query: sanitizeQuery(ask.query) }),
  };
}

// the main list: one page of it, and how it continues

/** One page of the main list (tagged, or the only list without `query`): its rows and the states that continue it. */
interface MainPage {
  rows: RawPostCard[];
  /** The state this page started from. */
  first: StreamState;
  /** The state right after the first `n` rows, for `n` below `rows.length`. */
  stateAt(n: number): StreamState;
  /** The state after every row; undefined once the list has ended. */
  resume?: StreamState;
  /** The state after the last row (or `first`): once the list has ended, it keeps only the count of posts shown. */
  last: StreamState;
  /** The `End of reachable results` reason when a limit ended the list (C-DEPTH, the depth guard). */
  endLine?: string;
  stopped?: StopReason;
  /** Offset streams: rankings can shift between pages (their footers carry C-DRIFT). */
  drift: boolean;
  checked: number;
  /** A head line about this page of the list: the short-page note, or a light scan's drift note. */
  note?: string;
  /** The forum's count of a tag's posts, from the call's first raw page when it was full (P10). */
  firstTotal?: number;
}

/** What a call's stream saw beyond its rows. */
interface Seen {
  /** The `totalCount` of the call's first raw page, when it carried `enableTotal` and was full (the ¶3.6 fullness test). */
  firstTotal?: number;
  /** Under `top` with `min_karma`: a row below N was read, so the list has ended. */
  floorReached: boolean;
}

/** One raw page of `terms`: `rawCount` is the limit sent (never the rows returned), `totalCount` only with `enableTotal`. */
async function readPage(
  plan: Plan, terms: ListPostsTerms, offset: number, size: number, total: boolean, ctx: CallContext, svc: Services,
): Promise<RawPage<RawPostCard>> {
  const page = { limit: size, offset, ...(total && { enableTotal: true as const }) };
  const results = await svc.gql([listPostsOp(plan.view, terms, page, "excerpt", ALIAS)], ctx, LIST_TASK);
  const data = aliasData(results, ALIAS, LIST_TASK, ctx);
  const totalCount = total && isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
  return { rows: rowsOf<RawPostCard>(data), rawCount: size, ...(totalCount !== undefined && { totalCount }) };
}

/**
 * The paged source of `plan`. The first raw page of a bounded selector carries `enableTotal` (P10). Once the karma floor is
 * reached nothing more is sent: the remaining raw pages read as empty, so the pager runs to its end without a request.
 */
function sourceOf(plan: Plan, seen: Seen, svc: Services): PagedSource<RawPostCard> {
  let calls = 0;
  const read = async (terms: ListPostsTerms, offset: number, size: number, first: boolean, ctx: CallContext): Promise<RawPage<RawPostCard>> => {
    if (seen.floorReached) return { rows: [], rawCount: size };
    const page = await readPage(plan, terms, offset, size, plan.bounded && first, ctx, svc);
    // ¶4.5, §4.5, §10.4: the fullness test; the total is kept only from a full first page.
    if (calls++ === 0 && page.totalCount != null && page.totalCount >= page.rawCount) seen.firstTotal = page.totalCount;
    return page;
  };
  const idOf = (r: RawPostCard): string => r._id;
  // ¶3.6: every list_posts call accepts date_from/date_to and sort new/old, so the C-DEPTH hint may name them (in date order, the dates alone).
  if (plan.keyset !== undefined) {
    const source: KeysetSource<RawPostCard> = {
      kind: "keyset", dir: plan.keyset, bounded: plan.bounded, range: plan.range, depthGuard: plan.depthGuard, idOf,
      endHint: DEPTH_HINT.datesOnly,
      timeOf: (r) => Date.parse(r.postedAt),
      fetch: (window, offset, size, first, ctx) => read(
        {
          ...plan.terms, ...(window.after !== undefined && { after: isoMs(window.after) }),
          ...(window.before !== undefined && { before: isoMs(window.before) }),
        },
        offset, size, first, ctx,
      ),
    };
    return source;
  }
  const source: OffsetSource<RawPostCard> = {
    kind: "offset", bounded: plan.bounded, idOf, endHint: DEPTH_HINT.dates,
    fetch: (offset, size, first, ctx) => read({ ...plan.terms, ...toViewTerms(plan.range) }, offset, size, first, ctx),
  };
  return source;
}

/** Trust but verify (¶4.5): every requested filter and the D1 list rules, on every row; under a karma floor, its end. */
function keeper(plan: Plan, seen: Seen): (row: RawPostCard) => boolean {
  return (row) => {
    if (seen.floorReached) return false;
    if (plan.floor !== undefined && row.baseScore < plan.floor) {
      seen.floorReached = true;
      return false;
    }
    return recheck(row, plan.check);
  };
}

/** A page of a list the forum orders: keyset or offset, refilled within the request cap (¶3.6). */
async function streamMain(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<MainPage> {
  const seen: Seen = { floorReached: false };
  const col = await collect(sourceOf(plan, seen, svc), start, plan.ask.limit, keeper(plan, seen), ctx);
  const dropped = col.checked - col.kept;
  if (dropped > 0) svc.log.debug("list_posts rows dropped by the re-checks", { dropped });
  // The karma floor ends the list where the pager may still see raw pages ahead.
  const ended = col.ended || seen.floorReached;
  const rows = col.items;
  const endLine = seen.floorReached ? undefined : col.endLine;
  return {
    rows, first: col.first, stateAt: (n) => stateAfter(col, n)!, resume: ended ? undefined : stateAfter(col, rows.length),
    last: rows.length === 0 ? col.first : col.after[rows.length - 1]!, ...(endLine !== undefined && { endLine }),
    ...(col.stopped !== undefined && { stopped: col.stopped }), drift: col.drift, checked: col.checked,
    // A stopped page's footer says why it is short; the neutral note would only repeat "continue with the cursor".
    ...(!ended && rows.length > 0 && col.note !== undefined && col.stopped === undefined && { note: col.note }),
    ...(seen.firstTotal !== undefined && { firstTotal: seen.firstTotal }),
  };
}

// light scans (¶4.5, ¶3.6)

/**
 * A light scan's visible set in its local order: the ids only, the newest posting time for the drift fingerprint, and
 * `local`, the sort and the filters checked only here: another order or local filter over the same terms sent (`af_top` and
 * `tag_relevance` over one person's tagged posts; `frontpage_only` beside `curated_only`; `min_karma` ≤ 0) scans again
 * instead of reading this set.
 */
interface ScanSet { ids: string[]; newestMs: number; local: string }

const postedMs = (r: { postedAt: string }): number => Date.parse(r.postedAt);

/** ¶3.3: the local order of a light-scan sort; ties newer first, then `_id` descending. */
function scanOrder(plan: Plan): (a: RawPostLight, b: RawPostLight) => number {
  const idOf = (r: RawPostLight): string => r._id;
  const byKarma = compareLocal<RawPostLight>((r) => r.baseScore, postedMs, idOf);
  switch (plan.ask.sort) {
    case "af_top": {
      // AF posts by AF karma first, then the others by karma.
      const byAfKarma = compareLocal<RawPostLight>((r) => r.afBaseScore, postedMs, idOf);
      return (a, b) => (a.af !== b.af ? (a.af ? -1 : 1) : a.af ? byAfKarma(a, b) : byKarma(a, b));
    }
    case "curated_date":
      return compareLocal((r) => (r.curatedDate == null ? null : Date.parse(r.curatedDate)), postedMs, idOf);
    case "tag_relevance": {
      // The tag's relevance, then karma; every row kept has a relevance of 1 or more (the re-check).
      const tagId = plan.check.tagId;
      const relevance = (r: RawPostLight): number => (tagId === undefined ? 0 : r.tagRelevance?.[tagId] ?? 0);
      return (a, b) => (relevance(a) === relevance(b) ? byKarma(a, b) : relevance(b) - relevance(a));
    }
    default:
      throw internalError("list_posts", `sort ${plan.ask.sort} is not a light-scan sort`);
  }
}

/**
 * The visible set of a light scan, sorted: from the `scan` cache (key `list_posts:<view>:<terms as sent>`), or read now in
 * one request of at most 2,000 `POST_LIGHT` rows (a full raw page is `too_broad`), re-checked, sorted and cached. A
 * `date_to` clamped to now is keyed by its period's own end, not the clamped instant, which moves with the clock: the key
 * names the period asked for, as the cursor's effective values do, so a continuation reads the set fetched once (¶3.6, ¶2.3).
 */
async function loadScanSet(plan: Plan, ctx: CallContext, svc: Services): Promise<ScanSet> {
  const terms: ListPostsTerms = { ...plan.terms, ...toViewTerms(plan.range) };
  const keyTerms = plan.range.clampedTo === undefined
    ? terms
    : { ...terms, before: isoMs(Date.parse(effectiveDate(plan.ask.dateTo, "to")!) + 1) };
  const key = `list_posts:${plan.view}:${JSON.stringify(keyTerms)}`;
  const local = JSON.stringify([plan.ask.sort, plan.check.frontpage === true, plan.check.minKarma ?? null]);
  const cached = svc.caches.get<ScanSet>("scan", key);
  if (cached !== undefined && cached.local === local) return cached;
  const cap = CONFIG.paging.lightScanCap;
  const { rows } = await lightScan<RawPostLight>(
    async (offset, first) => {
      // Every view a light scan reads is a bounded selector (¶3.6), so its first raw page carries `enableTotal`.
      const page = { limit: cap, ...(offset > 0 && { offset }), ...(first && { enableTotal: true as const }) };
      const data = aliasData(await svc.gql([listPostsOp(plan.view, terms, page, "light", ALIAS)], ctx, SCAN_TASK), ALIAS, SCAN_TASK, ctx);
      const totalCount = first && isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
      return { rows: rowsOf<RawPostLight>(data), rawCount: cap, ...(totalCount !== undefined && { totalCount }) };
    },
    { overCap: { why: `More than ${fmtInt(cap)} posts match`, how: "Narrow with date_from/date_to" } },
  );
  const visible = rows.filter((r) => recheck(r, plan.check)).sort(scanOrder(plan));
  const dropped = rows.length - visible.length;
  if (dropped > 0) svc.log.debug("list_posts rows dropped by the re-checks", { dropped });
  const set: ScanSet = { ids: visible.map((r) => r._id), newestMs: fingerprint(visible, postedMs).newestMs, local };
  svc.caches.set("scan", key, set);
  return set;
}

/** The documents of `ids` in one by-id request (R2, R10: an explicit limit), by id; none for no ids. */
async function hydrate(ids: readonly string[], alias: string, task: string, ctx: CallContext, svc: Services): Promise<Map<string, RawPostCard>> {
  const docs = new Map<string, RawPostCard>();
  const op = postsByIdsOp(alias, ids, "...POST_CARD_EXCERPT");
  if (op === undefined) return docs;
  for (const doc of rowsOf<RawPostCard>(aliasData(await svc.gql([op], ctx, task), alias, task, ctx))) {
    if (typeof doc._id === "string") docs.set(doc._id, doc);
  }
  return docs;
}

/** A page of a light-scan sort: a `list` over the cached sorted ids; only the page shown is fetched in full (R2, R10). */
async function scanMain(plan: Plan, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<MainPage> {
  if (start !== undefined && start.kind !== "list") throw internalError("list_posts", `a ${start.kind} state for a light-scan sort`);
  const set = await loadScanSet(plan, ctx, svc);
  const page = listPage(set.ids, start, plan.ask.limit, (id) => id, () => set.newestMs);
  const docs = await hydrate(page.items, HYDRATE_ALIAS, HYDRATE_TASK, ctx, svc);
  // In the local order; a post hidden since the scan is left out (P2, P3).
  const rows: RawPostCard[] = [];
  const at: number[] = [];   // at[k]: the index in `page.items` of rows[k]
  page.items.forEach((id, j) => {
    const doc = docs.get(id);
    if (doc !== undefined && postListable(doc)) {
      rows.push(doc);
      at.push(j);
    }
  });
  const first: StreamState = start ?? { kind: "list", shown: 0, index: 0 };
  // The states after a page's ids, counting the posts shown.
  const after = (j: number, shown: number): StreamState => ({ ...page.after[j]!, shown: first.shown + shown });
  const last = page.items.length === 0 ? first : after(page.items.length - 1, rows.length);
  return {
    rows, first, stateAt: (n) => (n === 0 ? first : after(at[n - 1]!, n)), ...(!page.ended && { resume: last }), last,
    drift: false, checked: page.items.length, ...(page.driftNote !== undefined && { note: page.driftNote }),
  };
}

// the untagged section of `query` (¶4.5)

type SearchState = Extract<StreamState, { kind: "search" }>;
/** A hit's place in the search: its 0-based page and its index inside that page's hits. */
interface Pos { page: number; index: number }

/** One call's walk of the section: its kept posts and where it continues. */
interface SectionPage {
  items: { row: RawPostCard; pos: Pos }[];
  /** The next hit to read after the walk; undefined once the search has ended. */
  resume?: Pos;
  /** The end is the forum's search depth (¶3.6), not the end of the hits. */
  depth: boolean;
  /** Hits checked after their hydrate. */
  checked: number;
  /** Page 1 only: the section's optional requests could not start (request cap or time limit). */
  stopped?: StopReason;
}

/** One search page of the section: words on `posts_karma`, not tagged, the person and AF facets, the period (Q35, Q36, Q38). */
function sectionSpec(plan: Plan, text: string, page: number): SearchSpec {
  const { userId, tagId } = idsOf(plan.filters);
  if (tagId === undefined) throw internalError("list_posts", "the untagged section without a tag");
  const facets: Facet[] = [
    { field: "tags._id", value: tagId, negate: true },
    ...(userId !== undefined ? [{ field: "userId" as const, value: userId }] : []),
    ...(plan.ask.afOnly ? [{ field: "af" as const, value: true as const }] : []),
  ];
  const dated = plan.range.start !== undefined || plan.range.endExclusive !== undefined;
  return { index: "posts", sort: "top", query: text, facets, ...(dated && { range: plan.range }), page, hitsPerPage: SECTION_HITS };
}

/**
 * ¶4.5: whether a hydrated hit belongs in the section. `recheck` without the tag test applies visibility and listability (P2,
 * P3), events (D11), every other requested filter (AF, dates, questions, curated, frontpage, karma, the person as owner or
 * coauthor) and keeps sub-questions and group posts only with `user`, as in author lists. Anonymous posts are dropped
 * whatever the scope (P7), and so is a post that carries the tag by now.
 */
function sectionKeeps(plan: Plan, doc: RawPostCard | undefined): doc is RawPostCard {
  const tagId = plan.check.tagId;
  if (!postPublic(doc) || !recheck(doc, plan.check, { except: "tag" }) || doc.hideAuthor) return false;
  return tagId === undefined || (doc.tagRelevance?.[tagId] ?? 0) < 1;
}

const hitId = (hit: SearchHit): string | undefined => {
  const id = typeof hit._id === "string" ? hit._id : hit.objectID;
  return typeof id === "string" && isEntityId(id) ? id : undefined;
};

/**
 * One section page: one search page (one POST) and one hydrate, walked from `state` until `want` posts are kept. Every hit of
 * the search page is hydrated but the posts this page's main list holds, so a later page that reads the same search page
 * sends the same hydrate (usually answered from the raw-response cache). On page 1 both requests are optional (`optional`):
 * one that cannot start ends the section as `stopped`, where it began.
 */
async function runSection(
  plan: Plan, state: SearchState, want: number, inMain: ReadonlySet<string>, optional: boolean, ctx: CallContext, svc: Services,
): Promise<SectionPage> {
  const begin: Pos = { page: state.page, index: state.index };
  const stoppedBy = (e: CallStopped): SectionPage => ({ items: [], resume: begin, depth: false, checked: 0, stopped: e.reason });
  const optionalRequest = async <T>(send: () => Promise<T>): Promise<T | CallStopped> => {
    if (optional && !ctx.mayStartRequest()) return new CallStopped(ctx.stopped ?? "request cap");
    try {
      return await send();
    } catch (e) {
      if (optional && e instanceof CallStopped) return e;
      throw e;
    }
  };
  // Never empty: a query with no letter or digit left after sanitizing is refused before any request (checkPrerequisites).
  const text = plan.query?.text ?? "";
  if (!searchPageAllowed(state.page, SECTION_HITS)) return { items: [], depth: true, checked: 0 };

  const searched = await optionalRequest(() => svc.search(buildSearch([sectionSpec(plan, text, state.page)]), ctx, SEARCH_TASK, "empty"));
  if (searched instanceof CallStopped) return stoppedBy(searched);
  const result: SearchResult | undefined = searched[0];
  // The forum's depth error ends the search (Q23).
  if (result === undefined || result.ended === true) return { items: [], depth: result?.ended === true, checked: 0 };
  let next: Pos | undefined = (state.page + 1) * SECTION_HITS < result.nbHits ? { page: state.page + 1, index: 0 } : undefined;
  let depth = false;
  if (next !== undefined && !searchPageAllowed(next.page, SECTION_HITS)) {
    depth = true;
    next = undefined;
  }
  const hits = result.hits.flatMap((hit, index) => {
    const id = hitId(hit);
    return id === undefined ? [] : [{ id, index }];
  });
  const ids = [...new Set(hits.map((h) => h.id).filter((id) => !inMain.has(id)))];
  const docs = await optionalRequest(() => hydrate(ids, SECTION_ALIAS, SECTION_HYDRATE_TASK, ctx, svc));
  if (docs instanceof CallStopped) return stoppedBy(docs);

  const out: SectionPage = { items: [], resume: next, depth, checked: 0 };
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.index < state.index || inMain.has(h.id) || seen.has(h.id)) continue;
    if (out.items.length === want) {
      out.resume = { page: state.page, index: h.index };
      out.depth = false;
      break;
    }
    seen.add(h.id);
    out.checked += 1;
    const doc = docs.get(h.id);
    if (sectionKeeps(plan, doc)) out.items.push({ row: doc, pos: { page: state.page, index: h.index } });
  }
  const kept = out.items.length;
  if (out.checked > kept) svc.log.debug("list_posts untagged hits dropped by the checks", { dropped: out.checked - kept });
  return out;
}

/** The section's head line: the words as searched (Q32: removals said), the tag it excludes, and ` (continued)` after page 1. */
function sectionHeading(plan: Plan, q: NonNullable<Plan["query"]>, continued: boolean): string {
  const removed = q.removed.length === 0 ? "" : ` (query: removed ${oneLine(q.removed.join(", "), QUERY_CAP)})`;
  const tag = plan.filters.tag === undefined ? "" : `, not tagged ${quoted(plan.filters.tag.name)}`;
  return `Also matching ${quoted(oneLine(q.text, QUERY_CAP))}${removed}${tag}${continued ? " (continued)" : ""}`;
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

const quoted = (s: string): string => `"${s}"`;

/** ¶3.7 request echo, in the order of ¶4.5, with the query as searched and what sanitizing removed (Q32). */
function requestEcho(input: PageInput): string[] {
  const { plan, echo } = input;
  const { ask, filters } = plan;
  const out: string[] = [];
  if (filters.user !== undefined) out.push(echoOf("user", filters.user));
  if (filters.tag !== undefined) out.push(echoOf("tag", filters.tag));
  out.push(...dateEchoes(plan.range));
  if (ask.afOnly) out.push("af_only true");
  if (ask.curatedOnly) out.push("curated_only true");
  if (ask.frontpageOnly) out.push("frontpage_only true");
  if (ask.questionsOnly) out.push("questions_only true");
  if (ask.minKarma !== undefined) out.push(`min_karma ${ask.minKarma}`);
  if (ask.query !== undefined && plan.query !== undefined) {
    out.push(`query ${JSON.stringify(oneLine(ask.query, QUERY_CAP))}`);
    if (plan.query.text !== ask.query) out.push(`searched as: ${oneLine(plan.query.text, QUERY_CAP)}`);
    if (plan.query.removed.length > 0) out.push(`query: removed ${oneLine(plan.query.removed.join(", "), QUERY_CAP)}`);
  }
  out.push(setting(echo, "sort", ask.sort), setting(echo, "limit", ask.limit));
  return out;
}

/**
 * ¶3.9 the filtered-list template: the filters with their resolved names, and at most two suggestions that are true here
 * (with `query` the untagged posts were searched too, so suggesting them would be false).
 */
function emptyLine(plan: Plan): string {
  const { ask, filters } = plan;
  const named: string[] = [];
  const u = filters.user;
  if (u !== undefined) named.push(`by ${personText({ kind: "user", id: u.id, slug: u.slug ?? null, name: u.name })}`);
  if (filters.tag !== undefined) {
    const untagged = plan.query === undefined ? "" : ` or untagged and matching ${quoted(oneLine(plan.query.text, QUERY_CAP))}`;
    named.push(`tagged ${tagFilterText(filters.tag)}${untagged}`);
  }
  const period = periodText(plan.range);
  if (period !== undefined) named.push(period);
  if (ask.afOnly) named.push("AF only");
  if (ask.curatedOnly) named.push("curated");
  if (ask.frontpageOnly) named.push("frontpage");
  if (ask.questionsOnly) named.push("questions");
  if (ask.minKarma !== undefined) named.push(`karma ≥ ${fmtInt(ask.minKarma)}`);
  const suggestions = [
    ...(ask.afOnly ? [SUGGEST.af] : []),
    ...(ask.dateFrom !== undefined || ask.dateTo !== undefined ? [SUGGEST.dates] : []),
    ...(ask.tag !== undefined && ask.query === undefined ? [SUGGEST.tag] : []),
  ];
  return emptyText({ kind: "filtered", items: "posts", filters: named.length === 0 ? "no filters" : named.join(", "), suggestions });
}

function subjectOf(filters: Filters): string {
  const by = filters.user === undefined ? "" : ` by ${quoted(filters.user.name)}`;
  const tagged = filters.tag === undefined ? "" : ` tagged ${quoted(filters.tag.name)}`;
  return by === "" && tagged === "" ? "posts site-wide" : `posts${by}${tagged}`;
}

/** A cursor's untagged-section state, checked to be one. */
function sectionStateOf(s: StreamState | undefined): SearchState | undefined {
  if (s === undefined || s.kind === "search") return s;
  throw internalError("list_posts", `a ${s.kind} state for the untagged section`);
}

/**
 * One page. Page 1: the main list, then (with `query`) the untagged section. A continuation whose cursor points at the main
 * list (`current` 0) continues it alone and keeps the section's state as it stood; one pointing at the section (`current` 1,
 * set once the main list has ended) continues the section alone.
 */
async function pageOf(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { plan, state } = input;
  const { ask, filters } = plan;
  const sectionOnly = state !== undefined && state.current === 1;
  const sectionStart: SearchState | undefined = plan.query === undefined
    ? undefined
    : state === undefined ? { kind: "search", shown: 0, page: 0, index: 0 } : sectionStateOf(state.streams[1]);
  const mainStart = state?.streams[0];

  const main = sectionOnly ? undefined : plan.scan ? await scanMain(plan, mainStart, ctx, svc) : await streamMain(plan, mainStart, ctx, svc);
  const runsSection = sectionStart !== undefined && (state === undefined || sectionOnly);
  const sectionWant = sectionOnly ? Math.min(ask.limit, SECTION_HITS) : SECTION_HITS;
  const section = runsSection
    ? await runSection(plan, sectionStart, sectionWant, new Set((main?.rows ?? []).map((r) => r._id)), !sectionOnly, ctx, svc)
    : undefined;

  const mainRows = main?.rows ?? [];
  const sectionRows = (section?.items ?? []).map((it) => it.row);
  const records = [...mainRows, ...sectionRows].map((row) => toPostRecord(row, { excerpt: true }));
  const m = mainRows.length;
  const shownMain0 = main?.first.shown ?? 0;
  const shownSection0 = sectionStart?.shown ?? 0;

  // The section's state after `k` of its items shown on this page; as it stood when it did not run. Undefined: it has ended.
  const sectionAt = (k: number): SearchState | undefined => {
    if (section === undefined) return sectionStart;
    const pos = k < section.items.length ? section.items[k]!.pos : section.resume;
    return pos === undefined ? undefined : { kind: "search", shown: shownSection0 + k, ...pos };
  };
  // What continues after this page if every item fits (the budget only moves where).
  const mainGoesOn = main?.resume !== undefined;
  const sectionGoesOn = sectionAt(sectionRows.length) !== undefined;

  const notes: string[] = [];
  if (filters.tag !== undefined) notes.push(CAVEAT["C-TAGGED"]);
  if (records.length > 0) notes.push(CAVEAT["C-COUNTER"]);
  if (records.some((r) => !r.status.frontpage)) notes.push(CAVEAT["C-FRONTPAGE"]);
  if (ask.afOnly) notes.push(CAVEAT["C-KARMA"]);
  if (ask.minKarma !== undefined && ask.minKarma >= 1 && ask.sort !== "top") notes.push(CAVEAT["C-KARMA-LAG"]);
  if (sectionRows.length > 0 || sectionOnly) notes.push(CAVEAT["C-COAUTHOR-SEARCH"]);
  notes.push(CAVEAT["C-EVENTS"]);

  const head: string[] = [];
  // ¶4.5, P10: the forum's count of a tag's posts, from page 1's first raw page when it was full, only when every filter
  // was the forum's; with `query` it covers the tagged list only.
  const countable = filters.tag !== undefined && filters.user === undefined && !ask.curatedOnly && !ask.frontpageOnly && ask.minKarma === undefined;
  if (countable && state === undefined && main?.firstTotal !== undefined && main.firstTotal > 0) head.push(FLAG.forumCount(main.firstTotal));
  if (main?.note !== undefined) head.push(main.note);
  // The footer can name one end only: when the section goes on, a limit that ended the tagged list is said here.
  if (main?.endLine !== undefined && sectionGoesOn) head.push(`The tagged list ends here: ${main.endLine}.`);
  if (sectionOnly && sectionRows.length > 0 && sectionRows.length < sectionWant && section?.resume !== undefined && section.stopped === undefined) head.push(SHORT_PAGE_NOTE);
  if (records.length === 0) {
    const checked = (main?.checked ?? 0) + (section?.checked ?? 0);
    if (mainGoesOn || sectionGoesOn) {
      if (checked > 0) head.push(emptyText({ kind: "scan", checked }));
    } else if (!sectionOnly && shownMain0 === 0 && (plan.query === undefined || state === undefined)) {
      // Nothing was ever shown: the list, and with `query` (known on page 1 only) the untagged section too, is empty.
      head.push(emptyLine(plan));
    }
  }
  // The section's head line, right above its posts: the last head line when no post of the main list is on the page (so a
  // section post's text, and the offset it may resume at, is the same on every page), else the first line of its first post.
  const heading = plan.query === undefined ? "" : sectionHeading(plan, plan.query, shownSection0 > 0);
  if (sectionOnly || (m === 0 && sectionRows.length > 0)) head.push(heading);

  const active = ask.sort === "active";
  const pageItems: PageItem[] = records.map((rec, j) => {
    const line = postLine(rec, { excerpt: true, ...(active && { lastComment: lastCommentOf(j < m ? mainRows[j]! : sectionRows[j - m]!) }) });
    const text = m > 0 && j === m ? `${heading}\n${line}` : line;
    return { text, ...(j === 0 && input.from !== undefined && { from: input.from }) };
  });
  const position = records.length === 0 ? undefined : (c: Consumed): string => {
    const touched = Math.max(1, Math.min(c.items, records.length) + (c.sliceTo === undefined ? 0 : 1));
    const inMain = Math.min(touched, m);
    const inSection = touched - inMain;
    return [
      ...(inMain > 0 ? [positionText("posts", shownMain0 + 1, shownMain0 + inMain)] : []),
      ...(inSection > 0 ? [positionText(SECTION_UNIT, shownSection0 + 1, shownSection0 + inSection)] : []),
    ].join(" · ");
  };

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, records.length);
    const cursorAt = (streams: StreamState[], current: number, from?: number): string =>
      mint(svc, "list_posts", input.args, input.effective, { streams, current, ...(from !== undefined && { data: { from } }) });
    const withSection = (s: SearchState | undefined): StreamState[] => (s === undefined ? [] : [s]);
    const sectionMore = (s: SearchState, cursor: string): Footer =>
      ({ kind: "more", tool: "list_posts", cursor, next: nextText(SECTION_UNIT, s.shown + 1, s.shown + Math.min(ask.limit, SECTION_HITS)) });
    // A section page that ends inside a post continues at it; only a cursor pointing at the section (`current` 1) opens with it.
    const sectionFrom = (k: number): number | undefined => (k < sectionRows.length ? c.sliceTo : undefined);

    if (main !== undefined) {
      const drift = main.drift ? { drift: true as const } : {};
      const mainMore = (cursor: string, shown: number): Footer =>
        ({ kind: "more", tool: "list_posts", cursor, next: nextText("posts", shownMain0 + shown + 1, shownMain0 + shown + ask.limit), ...drift });
      if (n < m) return mainMore(cursorAt([main.stateAt(n), ...withSection(sectionAt(0))], 0, c.sliceTo), n);
      const k = n - m;
      const sectionNext = sectionAt(k);
      if (main.resume !== undefined) {
        const cursor = cursorAt([main.resume, ...withSection(sectionNext)], 0);
        if (main.stopped !== undefined) return { kind: "stopped", why: main.stopped, tool: "list_posts", cursor, ...drift };
        return mainMore(cursor, m);
      }
      // The main list has ended on this page: the section, when it goes on, is next.
      if (sectionNext !== undefined) {
        const cursor = cursorAt([main.last, sectionNext], 1, sectionFrom(k));
        if (section?.stopped !== undefined) return { kind: "stopped", why: section.stopped, tool: "list_posts", cursor };
        return sectionMore(sectionNext, cursor);
      }
      if (main.endLine !== undefined) return { kind: "reachable", reason: main.endLine };
      return section?.depth === true ? { kind: "reachable", reason: END_SEARCH_DEPTH } : { kind: "end" };
    }
    const sectionNext = sectionAt(n);
    if (sectionNext !== undefined) return sectionMore(sectionNext, cursorAt([state!.streams[0]!, sectionNext], 1, sectionFrom(n)));
    return section?.depth === true ? { kind: "reachable", reason: END_SEARCH_DEPTH } : { kind: "end" };
  };

  return reply(
    {
      tool: "list_posts", subject: subjectOf(filters), request: requestEcho(input), ...(position !== undefined && { position }),
      oneItem: !sectionOnly && shownMain0 === 0 && records.length === 1 && !mainGoesOn && !sectionGoesOn, notes, head, items: pageItems,
    },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

async function firstPage(p: ListPostsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const ask = askOf(p);
  checkPrerequisites(ask);
  const range = parseRange(ask.dateFrom, ask.dateTo, ctx.now());
  const filters = await resolveFilters({ user: ask.user, tag: ask.tag }, ctx, svc);
  const args = givenArgs(p, ctx);
  return pageOf({ plan: planOf(ask, range, filters), echo: ctx, args, effective: listPostsEffective(p, idsOf(filters)) }, p.max_tokens, ctx, svc);
}

/** The list a cursor continues: its stored values, with `user`, `tag` and the dates as first given (to resolve and parse again). */
function storedAsk(entry: CursorEntry): Ask {
  const e = entry.effective as {
    user?: string; tag?: string; af_only?: boolean; curated_only?: boolean; frontpage_only?: boolean; questions_only?: boolean;
    min_karma?: number; sort: SortValue; limit: number;
  };
  const a = entry.args as Partial<ListPostsParams>;
  return {
    user: a.user ?? e.user, tag: a.tag ?? e.tag, dateFrom: a.date_from, dateTo: a.date_to, query: a.query,
    afOnly: e.af_only === true, curatedOnly: e.curated_only === true, frontpageOnly: e.frontpage_only === true, questionsOnly: e.questions_only === true,
    minKarma: e.min_karma, sort: e.sort, limit: e.limit,
  };
}

async function continuation(entry: CursorEntry, p: ListPostsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: `user` and `tag` given again are resolved first, so a slug equals the id it resolves to; dates are compared by
  // the period they name.
  const given = await resolveFilters({ ...(ctx.given.has("user") && { user: p.user }), ...(ctx.given.has("tag") && { tag: p.tag }) }, ctx, svc);
  checkContinuation(entry, listPostsEffective(p, idsOf(given)), ctx);
  const ask = storedAsk(entry);
  // The period is computed again with the current time (the clamp may move); windows already shown are not affected.
  const range = parseRange(ask.dateFrom, ask.dateTo, ctx.now());
  // D1 on every continuation: the filters are resolved again (from the cache, or with one request).
  const filters = await resolveFilters({ user: ask.user, tag: ask.tag }, ctx, svc);
  const data = entry.state.data;
  const from = isRecord(data) && typeof data.from === "number" ? data.from : undefined;
  return pageOf(
    {
      plan: planOf(ask, range, filters), state: entry.state, ...(from !== undefined && { from }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  user: P.user().optional(),
  tag: P.tag().optional(),
  date_from: P.dateFrom().optional(),
  date_to: P.dateTo().optional(),
  af_only: P.flag("af_only"),
  curated_only: P.flag("curated_only"),
  frontpage_only: P.flag("frontpage_only"),
  questions_only: P.flag("questions_only"),
  min_karma: P.minKarma().optional(),
  sort: P.sort("list_posts").optional(),
  query: P.query().optional(),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<ListPostsParams> = {
  name: "list_posts",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  run(p, ctx, svc) {
    const entry = openContinuation("list_posts", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
