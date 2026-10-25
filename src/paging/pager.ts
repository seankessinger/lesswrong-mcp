// Layer 3. The pager of ¶3.6: it turns a source of raw forum pages into the items of one reply plus the stream state to
// continue from. A raw page can come back short or empty in the middle of a list, so the pager advances by the raw page size
// it asked for, never by the rows it got, and decides the end only from the fullness test of a bounded selector
// (`totalCount`, used internally only, §4.5; P10) or, for site-wide lists, from the empty-page rule. Offset streams stop at
// offset 2000 (C-DEPTH, with the source's own hint of what shortens the list); `new`/`old` streams page by keyset on
// `postedAt`, re-anchoring before they pass offset 2000, and the depth guard ends unnarrowed site-wide ones after 500 items.
// Optional refills stop, with `stopped`, once the call may start no new request (¶7). Scan-then-keep runs the
// same engine in fixed raw pages with a page limit per call. Whole sets fetched once (light scans, capped at one raw page
// of 2,000 rows unless a declared exception reads more) are sorted locally and paged as `list` streams with a drift
// fingerprint over the visible rows; feed, search and slice streams have their own small state rules, and a slice page
// knows its items and its place in the whole text (`text 1–31 %`).
import { CONFIG } from "../config";
import { CallStopped, internalError, tooBroad } from "../errors";
import { END_DEPTH_GUARD, SHORT_PAGE_NOTE, driftNote, endDepth, filterKeptNote } from "../render/messages";
import type { CallContext, Consumed, DateRange, Fingerprint, PageItem, StopReason, StreamState } from "../types";

type OffsetState = Extract<StreamState, { kind: "offset" }>;
type KeysetState = Extract<StreamState, { kind: "keyset" }>;
type ListState = Extract<StreamState, { kind: "list" }>;
type SliceState = Extract<StreamState, { kind: "slice" }>;

/** The raw page size for a reply of `limit` items: `min(100, max(2 × limit, 20))`. */
export function rawPageSize(limit: number): number {
  return Math.min(CONFIG.paging.rawPageMax, Math.max(2 * limit, CONFIG.paging.rawPageMin));
}

/** One raw page as a source returns it. */
export interface RawPage<T> {
  /** What the forum returned: the visible rows of the raw page, in the forum's order. */
  rows: readonly T[];
  /** The raw page size requested (the `limit` sent). */
  rawCount: number;
  /** Only on a page sent with `enableTotal`: the forum's total. */
  totalCount?: number | null;
}

/** A list paged by raw offset. The source sends `enableTotal: true` exactly when `bounded && first`. */
export interface OffsetSource<T> {
  kind: "offset";
  bounded: boolean;
  /** ¶3.6: the hint added to the C-DEPTH end line, a `DEPTH_HINT` of parameters the tool accepts here; none when nothing it accepts shortens the list. */
  endHint?: string;
  fetch(offset: number, size: number, first: boolean, ctx: CallContext): Promise<RawPage<T>>;
  idOf(row: T): string;
}

/**
 * A `new`/`old` list paged by keyset on `postedAt`: windows bounded by `after` (inclusive) and `before` (exclusive), each
 * paged by raw offset. The source sends `enableTotal: true` exactly when `bounded && first`.
 */
export interface KeysetSource<T> {
  kind: "keyset";
  dir: "new" | "old";
  bounded: boolean;
  range: DateRange;
  /** A site-wide list in date order with no narrowing filter: it ends after 500 items (¶3.6 depth guard). */
  depthGuard: boolean;
  /** ¶3.6: the hint added to the C-DEPTH end line, a `DEPTH_HINT` of parameters the tool accepts here; none when nothing it accepts shortens the list. */
  endHint?: string;
  fetch(window: { after?: number; before?: number }, offset: number, size: number, first: boolean, ctx: CallContext): Promise<RawPage<T>>;
  idOf(row: T): string;
  timeOf(row: T): number;
}

export type PagedSource<T> = OffsetSource<T> | KeysetSource<T>;

/** What one call collected. Counts are of rows checked and kept, never forum totals (P10). */
export interface Collected<T> {
  items: T[];
  /** `after[i]`: the state that continues right after `items[i]`. */
  after: StreamState[];
  /** The state that continues where this call stopped reading (after its last item, or after its last raw page); undefined once ended. */
  resume?: StreamState;
  /** The state the call started from. */
  first: StreamState;
  ended: boolean;
  /** The `End of reachable results` reason when the end is a limit (C-DEPTH, the depth guard), not the list's end. */
  endLine?: string;
  /** The short-page note: neutral, or naming the requested filter that caused it. */
  note?: string;
  stopped?: StopReason;
  checked: number;
  kept: number;
  /** Offset streams can shift between pages as votes arrive (C-DRIFT); keyset streams cannot. */
  drift: boolean;
}

/**
 * Collects up to `want` rows that pass `keep`, from `start` (the beginning of the list when undefined), in raw pages of
 * `rawPageSize(want)`, refilling short pages while the call may start requests.
 */
export function collect<T>(
  source: PagedSource<T>,
  start: StreamState | undefined,
  want: number,
  keep: (row: T) => boolean,
  ctx: CallContext,
  opts: { filterName?: string; unit?: string } = {},
): Promise<Collected<T>> {
  return runPages(source, start, want, keep, ctx, { ...opts, size: rawPageSize(want), maxPages: Infinity });
}

/**
 * Scan, then keep (¶3.6): where a filter applies only locally (`af_only` on comments, or on the `frontpage` feed), light
 * rows are read in raw pages of `rows` (default 500), at most `pages` (default 3) per call, and only the rows `keep`
 * accepts are items. Reaching the page limit ends the page short, with the filter's note and a cursor, not `stopped`.
 */
export function scanThenKeep<T>(
  source: PagedSource<T>,
  start: StreamState | undefined,
  want: number,
  keep: (row: T) => boolean,
  ctx: CallContext,
  opts: { rows?: number; pages?: number; filterName?: string; unit?: string } = {},
): Promise<Collected<T>> {
  return runPages(source, start, want, keep, ctx, {
    size: opts.rows ?? CONFIG.paging.scanRows,
    maxPages: opts.pages ?? CONFIG.paging.scanPagesMax,
    filterName: opts.filterName,
    unit: opts.unit,
  });
}

/** The state after the first `shown` items: the call's start for 0, the resume state after them all, undefined at the end. */
export function stateAfter<T>(c: Collected<T>, shown: number): StreamState | undefined {
  if (shown >= c.items.length) return c.ended ? undefined : c.resume;
  if (shown === 0) return c.first;
  return c.after[shown - 1];
}

// ---------- the engine

interface EngineOptions {
  /** The raw page size. */
  size: number;
  /** Raw pages per call; reaching it is a short page, not `stopped`. */
  maxPages: number;
  filterName?: string;
  unit?: string;
}

/** The fullness test on a window's first raw page of a bounded selector; undefined when unknown (no total came back). */
type Fullness = { full: true; total: number } | { full: false } | undefined;

/** One fetched raw page: `rows` are those not shown before, `at` its raw offset, `opens` whether it was sent with `first`. */
interface Fetched<T> { page: RawPage<T>; rows: readonly T[]; at: number; opens: boolean }

/** After a whole raw page: the state to resume at, or the end (with its `End of reachable results` line when a limit ends it). */
type Passed = { ended: false; resume: StreamState } | { ended: true; endLine?: string };

/** The half of the engine that depends on the stream kind: where the next raw page is and how states are made. */
interface Walk<T> {
  first: StreamState;
  next(size: number, ctx: CallContext): Promise<Fetched<T>>;
  /** Called for every row checked, in order. */
  examined(row: T): void;
  /** The state right after `row`, the `shown`th item of the stream; `last`: the page's last row. */
  afterItem(row: T, shown: number, last: boolean, f: Fetched<T>): StreamState;
  /** Moves past the whole page `f`. */
  pass(f: Fetched<T>, shown: number): Passed;
}

/**
 * The one paging engine (¶3.6). `scanThenKeep` runs it with its own raw page size and page limit; `collect` runs it
 * with `rawPageSize(want)` and no page limit.
 */
async function runPages<T>(
  source: PagedSource<T>,
  start: StreamState | undefined,
  want: number,
  keep: (row: T) => boolean,
  ctx: CallContext,
  opts: EngineOptions,
): Promise<Collected<T>> {
  const walk = walkFor(source, start);
  const { first } = walk;
  const s0 = first.shown;
  const drift = source.kind === "offset";
  const guarded = source.kind === "keyset" && source.depthGuard;
  if (guarded) {
    want = Math.min(want, CONFIG.paging.depthGuard - s0);
    if (want <= 0) return { items: [], after: [], first, ended: true, endLine: END_DEPTH_GUARD, checked: 0, kept: 0, drift };
  }

  const items: T[] = [];
  const after: StreamState[] = [];
  let resume: StreamState | undefined;
  let ended = false;
  let endLine: string | undefined;
  let stopped: StopReason | undefined;
  let checked = 0;
  let pages = 0;
  let fullness: Fullness;
  let emptyRun = 0; // raw pages in a row, in this window, that returned no rows

  paging: for (;;) {
    if (pages > 0) {
      if (pages >= opts.maxPages) break;
      if (!ctx.mayStartRequest()) {
        stopped = ctx.stopped;
        break;
      }
    }
    // The call's first page is mandatory; a refill that can no longer start (the 40 s mark passed while it waited for the
    // transport) ends the page as `stopped`, like one refused before it was sent.
    const f = await walk.next(opts.size, ctx).catch((e: unknown) => {
      if (pages > 0 && e instanceof CallStopped) return e;
      throw e;
    });
    if (f instanceof CallStopped) {
      stopped = f.reason;
      break;
    }
    pages++;
    if (f.opens) {
      fullness = source.bounded ? fullnessOf(f.page) : undefined;
      emptyRun = 0;
    }
    emptyRun = f.page.rows.length === 0 ? emptyRun + 1 : 0;
    const pageEnds = fullness === undefined
      ? emptyRun > CONFIG.paging.emptyPageRetries
      : !fullness.full || f.at + f.page.rawCount >= fullness.total;

    for (let i = 0; i < f.rows.length; i++) {
      const row = f.rows[i];
      checked++;
      walk.examined(row);
      if (!keep(row)) continue;
      items.push(row);
      const last = i === f.rows.length - 1;
      const state = walk.afterItem(row, s0 + items.length, last, f);
      after.push(state);
      if (items.length === want && !last) {
        resume = state;
        break paging;
      }
    }

    if (pageEnds) {
      ended = true;
      break;
    }
    const passed = walk.pass(f, s0 + items.length);
    if (passed.ended) {
      ended = true;
      endLine = passed.endLine;
      break;
    }
    resume = passed.resume;
    if (items.length === want) break;
  }

  if (guarded && !ended && s0 + items.length >= CONFIG.paging.depthGuard) {
    ended = true;
    endLine = END_DEPTH_GUARD;
  }
  let note: string | undefined;
  if (!ended && items.length > 0 && items.length < want) {
    note = opts.filterName !== undefined && checked > items.length
      ? filterKeptNote(opts.filterName, items.length, checked, opts.unit ?? "items")
      : SHORT_PAGE_NOTE;
  }
  return {
    items, after, resume: ended ? undefined : resume, first, ended, endLine, note, stopped, checked, kept: items.length, drift,
  };
}

/** The fullness test (§4.5). */
function fullnessOf(page: RawPage<unknown>): Fullness {
  if (typeof page.totalCount !== "number") return undefined;
  return page.totalCount >= page.rawCount ? { full: true, total: page.totalCount } : { full: false };
}

/** The walk for `source` from `start`, or from the list's beginning; a start state of another kind is a bug in the caller. */
function walkFor<T>(source: PagedSource<T>, start: StreamState | undefined): Walk<T> {
  if (source.kind === "offset") {
    const first: StreamState = start ?? { kind: "offset", shown: 0, offset: 0 };
    if (first.kind !== "offset") throw internalError("pager", `start state of kind ${first.kind} for the offset source`);
    return offsetWalk(source, first);
  }
  const first: StreamState = start ?? { kind: "keyset", shown: 0, dir: source.dir, boundaryMs: null, idsAtBoundary: [], windowOffset: 0 };
  if (first.kind !== "keyset") throw internalError("pager", `start state of kind ${first.kind} for the keyset source`);
  if (first.dir !== source.dir) throw internalError("pager", `start state in direction ${first.dir} for the ${source.dir} source`);
  return keysetWalk(source, first);
}

/**
 * Offset streams: the next raw page is at `offset`; a row is resumed after by re-reading its raw page and skipping the
 * rows up to the last id shown (Q15). The stream ends at offset 2000 with C-DEPTH.
 */
function offsetWalk<T>(source: OffsetSource<T>, first: OffsetState): Walk<T> {
  let offset = first.offset;
  let callFirst = true;
  return {
    first,
    async next(size, ctx) {
      const at = offset;
      const opens = callFirst;
      const page = await source.fetch(at, size, opens, ctx);
      callFirst = false;
      let rows = page.rows;
      if (opens && first.lastId !== undefined) {
        const shownTo = rows.findIndex((r) => source.idOf(r) === first.lastId);
        if (shownTo >= 0) rows = rows.slice(shownTo + 1);
      }
      return { page, rows, at, opens };
    },
    examined() {},
    afterItem(row, shown, last, f) {
      return { kind: "offset", shown, offset: last ? f.at + f.page.rawCount : f.at, lastId: source.idOf(row) };
    },
    pass(f, shown) {
      const next = f.at + f.page.rawCount;
      if (next > CONFIG.paging.maxOffset) return { ended: true, endLine: endDepth(source.endHint) };
      offset = next;
      return { ended: false, resume: { kind: "offset", shown, offset } };
    },
  };
}

/**
 * Keyset streams (Q26): a window holds the rows up to its anchor time (`new`: `before: anchor + 1 ms`; `old`: `after:
 * anchor`), less the ids already shown at exactly that time, and is paged by raw offset, so a short or empty raw page is
 * stepped over. Before passing offset 2000 the walk re-anchors a new window at the last row checked. A row is resumed after
 * by a new window anchored at its own time.
 */
function keysetWalk<T>(source: KeysetSource<T>, first: KeysetState): Walk<T> {
  const { dir, range } = source;
  let anchor = first.boundaryMs;
  let anchorIds: readonly string[] = first.idsAtBoundary;
  let windowOffset = first.windowOffset;
  let windowFirst = true;
  let windowLastTime: number | undefined; // the time of the last row checked in the current window
  // The last shown boundary: the time of the last item shown and every id shown at exactly that time.
  let shownAt: { time: number | null; ids: readonly string[] } = { time: anchor, ids: anchorIds };
  const idsShownAt = (t: number | null, otherwise: readonly string[]) => (shownAt.time === t ? shownAt.ids : otherwise);
  const resumeState = (shown: number): StreamState => ({
    kind: "keyset", shown, dir, boundaryMs: anchor, idsAtBoundary: [...anchorIds], windowOffset,
  });

  return {
    first,
    async next(size, ctx) {
      const at = windowOffset;
      const opens = windowFirst;
      const window = dir === "new"
        ? bounds(range.start, anchor === null ? range.endExclusive : anchor + 1)
        : bounds(anchor ?? range.start, range.endExclusive);
      const page = await source.fetch(window, at, size, opens, ctx);
      windowFirst = false;
      const skip = new Set(anchorIds);
      const rows = anchor === null || skip.size === 0
        ? page.rows
        : page.rows.filter((r) => !(source.timeOf(r) === anchor && skip.has(source.idOf(r))));
      return { page, rows, at, opens };
    },
    examined(row) {
      windowLastTime = source.timeOf(row);
    },
    afterItem(row, shown) {
      const t = source.timeOf(row);
      shownAt = { time: t, ids: [...idsShownAt(t, []), source.idOf(row)] };
      return { kind: "keyset", shown, dir, boundaryMs: t, idsAtBoundary: [...shownAt.ids], windowOffset: 0 };
    },
    pass(f, shown) {
      const next = f.at + f.page.rawCount;
      if (next <= CONFIG.paging.maxOffset) {
        windowOffset = next;
        // Items shown at the anchor time stay skipped wherever the stream resumes, so they are never shown twice.
        anchorIds = idsShownAt(anchor, anchorIds);
        return { ended: false, resume: resumeState(shown) };
      }
      // No row was checked in this window to re-anchor at, so the forum's 2000-offset cap ends what is reachable, not the list.
      if (windowLastTime === undefined) return { ended: true, endLine: endDepth(source.endHint) };
      anchor = windowLastTime;
      anchorIds = idsShownAt(anchor, []);
      windowOffset = 0;
      windowFirst = true;
      windowLastTime = undefined;
      return { ended: false, resume: resumeState(shown) };
    },
  };
}

/** A window with only the bounds that are set. */
function bounds(after: number | undefined, before: number | undefined): { after?: number; before?: number } {
  return { ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) };
}

// ---------- whole sets: local sorts and list streams

/**
 * The order of a locally sorted set (¶3.3): by `key`, higher first (`desc`, the default) or lower first (`asc`), with a
 * null key after every number in both directions; ties newer first (`timeOf` descending), then `_id` descending.
 */
export function compareLocal<T>(
  key: (t: T) => number | null,
  timeOf: (t: T) => number,
  idOf: (t: T) => string,
  dir: "desc" | "asc" = "desc",
): (a: T, b: T) => number {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) {
      if (ka === null) return 1;
      if (kb === null) return -1;
      return (ka < kb ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    const ia = idOf(a);
    const ib = idOf(b);
    return ia === ib ? 0 : ia < ib ? 1 : -1;
  };
}

/** The drift fingerprint of a visible set (¶3.6, P10): its row count and newest date (`newestMs` 0 for an empty set). */
export function fingerprint<T>(set: readonly T[], timeOf: (t: T) => number): Fingerprint {
  let newestMs = set.length === 0 ? 0 : -Infinity;
  for (const x of set) newestMs = Math.max(newestMs, timeOf(x));
  return { count: set.length, newestMs };
}

/**
 * One page of a whole set fetched once and ordered locally (`list` state, ¶3.6). `set` is the visible set, after
 * `domain/visibility` and the filter re-checks, so hidden rows change neither the fingerprint nor the note (P10). The
 * page resumes right after the last id shown, or at the stored index when that item is gone. The drift note comes with a
 * changed fingerprint (compared when both the state and this call have one: `timeOf` given) or a lost last item; its N
 * counts the visible rows added, and is 0 without fingerprints. `after[i]` continues right after `items[i]`.
 */
export function listPage<T>(
  set: readonly T[],
  state: ListState | undefined,
  want: number,
  idOf: (t: T) => string,
  timeOf?: (t: T) => number,
): { items: T[]; after: StreamState[]; ended: boolean; driftNote?: string } {
  const s0 = state?.shown ?? 0;
  const cur = timeOf === undefined ? undefined : fingerprint(set, timeOf);
  let start = 0;
  let lost = false;
  if (state !== undefined) {
    const { lastId } = state;
    const at = lastId === undefined ? -1 : set.findIndex((x) => idOf(x) === lastId);
    start = at >= 0 ? at + 1 : state.index;
    lost = lastId !== undefined && at < 0;
  }
  const items = set.slice(start, start + want);
  const after: StreamState[] = items.map((x, i) => ({
    kind: "list", shown: s0 + i + 1, index: start + i + 1, lastId: idOf(x), ...(cur === undefined ? {} : { fingerprint: { ...cur } }),
  }));
  const page = { items, after, ended: start + items.length >= set.length };
  const was = state?.fingerprint;
  const both = was !== undefined && cur !== undefined;
  const changed = both && (was.count !== cur.count || was.newestMs !== cur.newestMs);
  if (!changed && !lost) return page;
  return { ...page, driftNote: driftNote(both ? Math.max(0, cur.count - was.count) : 0) };
}

// ---------- light scans

/**
 * A light scan (¶3.6): the whole set as light rows, in raw pages at offsets 0, `rawCount`, 2 × `rawCount`, …, at most
 * `maxPages` (default 1), the first sent with `first` (so a bounded selector's carries `enableTotal`). The first page
 * decides by the fullness test (§4.5): not full, it held the whole set; full, the scan reads on until the forum's total is
 * covered (a selector with no total reads on while its pages come back full). When the
 * pages run out first, the set is over the cap: `too_broad` with the tool's own hint, or, for the declared exceptions
 * (the sequences set, a person's wiki edits), the rows read so far, `truncated`. Callers send `limit:
 * CONFIG.paging.lightScanCap` for the common cap. Later pages are mandatory, so nothing here checks the call's caps: the
 * transport's `ctx.beginRequest()` refuses them past the request cap or the 40 s mark.
 */
export async function lightScan<T>(
  fetch: (offset: number, first: boolean) => Promise<RawPage<T>>,
  opts: { overCap: { why: string; how: string } | "truncate"; maxPages?: number },
): Promise<{ rows: T[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 1;
  const rows: T[] = [];
  let total: number | undefined;
  for (let pages = 1, offset = 0; ; pages++) {
    const page = await fetch(offset, pages === 1);
    for (const row of page.rows) rows.push(row);
    if (pages === 1) {
      if ((page.totalCount ?? page.rows.length) < page.rawCount) return { rows, truncated: false };
      total = page.totalCount ?? undefined;
    }
    offset += page.rawCount;
    const more = total === undefined ? page.rows.length >= page.rawCount : offset < total;
    if (!more) return { rows, truncated: false };
    if (pages >= maxPages) {
      if (opts.overCap === "truncate") return { rows, truncated: true };
      throw tooBroad(opts.overCap.why, opts.overCap.how);
    }
  }
}

// ---------- search, feed and slice streams

/** Whether 0-based search page `page` is within the forum's search depth: `page × hitsPerPage + hitsPerPage ≤ 10,000` (¶3.6, §5.6). */
export function searchPageAllowed(page: number, hitsPerPage: number): boolean {
  return page * hitsPerPage + hitsPerPage <= CONFIG.search.maxDepth;
}

/** A feed stream ends when the forum answers `cutoff: null`, which is never sent back: it would restart the feed (§14.3, Q19). */
export function feedEnded(cutoff: string | null): boolean {
  return cutoff === null;
}

/**
 * The `slice` state after a page that showed `c` (¶3.6): `c.items` whole blocks after `start` (the first block when
 * undefined), then the character offset `c.sliceTo` reached inside the next block (absolute in that block's text), with
 * the version of the text shown; undefined once all `total` blocks are shown. An empty slice (`sliceTo` equal to the
 * start's own offset) and a page that showed nothing whole and reached no offset both stay where they started.
 */
export function sliceAfter(c: Consumed, start: SliceState | undefined, total: number, version?: string): SliceState | undefined {
  const block = (start?.block ?? 0) + c.items;
  if (block >= total) return undefined;
  const offset = c.sliceTo !== undefined ? c.sliceTo : c.items === 0 ? start?.offset ?? 0 : 0;
  return { kind: "slice", shown: (start?.shown ?? 0) + c.items, block, offset, ...(version === undefined ? {} : { version }) };
}

/** A page of a `slice` stream: the items it shows and its place in the whole text. */
export interface SlicePosition {
  /** The items from the start's block on, the first resumed at the start's offset (`from`; none at offset 0). */
  items: PageItem[];
  /** The `Position:` text after a page that showed `c`: `text <from>–<to> %`; undefined when the items hold no text. */
  position?: (c: Consumed) => string;
  /** The `next:` text after a page that showed `c`: `text from <n> %`. */
  next: (c: Consumed) => string;
}

/**
 * ¶3.6, ¶3.7: the page of a `slice` stream that starts at `start` (the first page when undefined), over `all` the items of the
 * text, which a continuation rebuilds the same way. A percentage counts the characters of all the items, rounded down: the
 * page's start is at least 1 %, and its end is 100 % once the last character is reached, never below its start. Pure: the
 * functions read only `Consumed` and what is computed here once.
 */
export function slicePosition(all: readonly PageItem[], start: SliceState | undefined): SlicePosition {
  const startBlock = start?.block ?? 0;
  const startOffset = start?.offset ?? 0;
  const items = all.slice(startBlock).map((it, j) => (j === 0 && startOffset > 0 ? { ...it, from: startOffset } : it));
  const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);
  const lengths = all.map((it) => it.text.length);
  const total = sum(lengths);
  const before = (block: number): number => sum(lengths.slice(0, block));
  const startChars = before(startBlock) + startOffset;
  const reached = (c: Consumed): number => before(startBlock + c.items) + (c.sliceTo ?? 0);
  const pct = (chars: number): number => Math.floor((chars * 100) / total);
  const position = total === 0 ? undefined : (c: Consumed): string => {
    const from = Math.max(1, pct(startChars));
    const end = reached(c);
    return `text ${from}–${end >= total ? 100 : Math.max(from, pct(end))} %`;
  };
  return { items, ...(position !== undefined && { position }), next: (c) => `text from ${pct(reached(c))} %` };
}
