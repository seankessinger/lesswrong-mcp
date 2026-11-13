// Layer 2. The `list_sequences` tool (¶4.10): every public sequence, a person's, or the curated ones. One light set serves every
// mode: `sequences(selector: {default: {}})` as `SEQ_LIGHT` rows in raw pages of 1,000 at offsets 0, 1,000 and 2,000 (the declared
// exception to the 2,000-row light-scan cap, ¶3.6), read through `lightScan` and cached for 10 minutes in the `seqset` cache once
// complete: a deadline or cap stop while the set is being read propagates (an incomplete set would sort wrongly) and nothing is
// cached. A short raw page is not the end; the forum's total, which is never shown (P10), decides. A third raw page that is
// also full means more may exist, and the last page of the list says so.
// The modes (a person's, curated, AF) and the order are applied here (Q70, ¶3.3), hidden sequences are never listed (P4), and
// only the page shown is hydrated with `SEQ_CARD` and printed in the local order (R10). `user` is resolved first (at most one
// request, which is also its visibility check) and again on every continuation (D1).
import { z } from "zod";
import { CONFIG } from "../config";
import { toSequenceRecord } from "../domain/sequences";
import { sequenceListable } from "../domain/visibility";
import { internalError } from "../errors";
import { sequenceSetOp } from "../forum/templates/list_sequences";
import { sequencesByIdsOp } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { echoOf, resolve } from "../ids/resolve";
import { compareLocal, fingerprint, lightScan, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, emptyText, endMostReturned, fmtInt } from "../render/messages";
import { personText, sequenceLine } from "../render/records";
import type {
  CallContext, Consumed, CursorEntry, Footer, PageItem, RawSeqCard, RawSeqLight, Resolved, Services, StreamState, ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, rowsOf, setting } from "./common";
import { aliasData } from "./loaders";

export type ListSequencesParams = {
  user?: string; curated_only: boolean; af_only: boolean; sort: "site_order" | "new" | "old"; limit: number; cursor?: string; max_tokens: number;
};

type Sort = ListSequencesParams["sort"];
type ListState = Extract<StreamState, { kind: "list" }>;

const TITLE = "What sequences exist, by X, or curated?";
/** ¶4.10, verbatim. */
const DESCRIPTION_QUOTE =
  "List sequences: every public sequence (default), a person's (user=…), or the curated ones (curated_only=true; with user, that person's curated ones). limit counts sequences. \"Curated\" means the site gave the sequence a curated rank; the site's curated and community pages show only those with a cover image, while this list includes all. A person's list is the one their profile page shows. sort: site_order (default: newest first for all sequences; the curated rank, higher first, for curated ones, where ties are common; the person's chosen profile order for a person's, also when curated_only is added), new, old (creation date). af_only keeps AF sequences. Each item: ids, title, author, number of posts (~, site counter), created date, AF status and a description excerpt. Open one with get_sequence.";

const SET_TASK = "listing the sequences";
const HYDRATE_TASK = "reading the sequences shown";
const SET_KEY = "all";
const UNIT = "items";
/** ¶4.10: the note on a list that includes sequences without a cover image. */
const COVER_NOTE = "The site's curated and community pages show only sequences with a cover image; this list includes all.";
/** The most rows the set can hold: what the footer says the forum returned when the last raw page is full too. */
const SET_MOST = CONFIG.paging.sequenceSetRows * CONFIG.paging.sequenceSetPages;

const idOf = (r: { _id: string }): string => r._id;
/** A creation date in epoch milliseconds; 0 for an unreadable one, so that orders and fingerprints stay comparable. */
function createdMs(r: { createdAt: string }): number {
  const t = Date.parse(r.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * ¶3.6: the effective values a cursor compares: defaults applied and `user` as the id it resolved to (absent without one).
 * `get_user`'s hand-off stores the same keys.
 */
export function listSequencesEffective(p: ListSequencesParams, ids: { userId?: string }): Record<string, unknown> {
  return { user: ids.userId, curated_only: p.curated_only, af_only: p.af_only, sort: p.sort, limit: p.limit };
}

// the light set

/** The visible rows of the set, and whether the last raw page read was full too (more may exist beyond it). */
interface SequenceSet { rows: RawSeqLight[]; maybeMore: boolean }

/**
 * The whole set of public sequences as light rows (¶4.10): from the `seqset` cache, else up to three raw pages of 1,000. The
 * fullness test is `lightScan`'s (a short first page is the whole set; a full one reads on until its total is covered);
 * `maybeMore` is a separate fact, that the third raw page was also full by its own count (¶3.6), which `lightScan` cannot tell
 * when the total is exactly the rows read.
 * Hidden sequences are dropped here (P4), and the raw total is read for the fullness test only (P10).
 */
export async function loadSequenceSet(ctx: CallContext, svc: Services): Promise<SequenceSet> {
  const cached = svc.caches.get<SequenceSet>("seqset", SET_KEY);
  if (cached !== undefined) return cached;
  const rawCount = CONFIG.paging.sequenceSetRows;
  const lastOffset = (CONFIG.paging.sequenceSetPages - 1) * rawCount;
  let lastPageFull = false;
  const { rows } = await lightScan<RawSeqLight>(
    async (offset) => {
      const o = sequenceSetOp(offset);
      const data = aliasData(await svc.gql([o], ctx, SET_TASK), o.alias, SET_TASK, ctx);
      const page = rowsOf<RawSeqLight>(data);
      const totalCount = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
      if (offset === lastOffset) lastPageFull = (totalCount ?? page.length) >= rawCount;
      return { rows: page, rawCount, ...(totalCount !== undefined && { totalCount }) };
    },
    { overCap: "truncate", maxPages: CONFIG.paging.sequenceSetPages },
  );
  const visible = rows.filter((r) => !r.hidden);
  if (visible.length < rows.length) svc.log.debug("list_sequences rows dropped as hidden", { dropped: rows.length - visible.length });
  const set: SequenceSet = { rows: visible, maybeMore: lastPageFull };
  svc.caches.set("seqset", SET_KEY, set);
  return set;
}

// the modes and the order

/** The comparison of `sort` (¶3.3, ¶4.10): ties newer first, then `_id` descending, in every order. */
function comparison(mode: { userId?: string; curated: boolean }, sort: Sort): (a: RawSeqLight, b: RawSeqLight) => number {
  if (sort === "old") return compareLocal<RawSeqLight>(createdMs, createdMs, idOf, "asc");
  if (sort === "site_order") {
    // A person's own order (curated or not): their profile order, unset first.
    if (mode.userId !== undefined) return compareLocal<RawSeqLight>((r) => r.userProfileOrder ?? -Infinity, createdMs, idOf, "asc");
    if (mode.curated) return compareLocal<RawSeqLight>((r) => r.curatedOrder, createdMs, idOf);
  }
  return compareLocal<RawSeqLight>(createdMs, createdMs, idOf);
}

/**
 * ¶4.10 modes and ordering, applied locally to the set: hidden sequences are never listed (P4); `userId` keeps that person's
 * sequences except those they hid from their profile (`hideFromAuthorPage`, as the site's `userProfile` view does); `curated` keeps
 * the sequences with a curated rank (Q70, one definition in both modes); `af` keeps the AF ones. `site_order` is the person's
 * profile order (unset first, then newest), else the curated rank (higher first), else newest first; `new` and `old` are the
 * creation date. The rows given are not changed.
 */
export function orderSequences(
  rows: readonly RawSeqLight[], mode: { userId?: string; curated: boolean; af: boolean }, sort: Sort,
): RawSeqLight[] {
  const kept = rows.filter((r) =>
    !r.hidden
    && (mode.userId === undefined || (r.userId === mode.userId && !r.hideFromAuthorPage))
    && (!mode.curated || r.curatedOrder !== null)
    && (!mode.af || r.af));
  return kept.sort(comparison(mode, sort));
}

// the page

/** The filters and order of one list: the call's parameters on a first page, the cursor's on a continuation. */
interface Ask { curated: boolean; af: boolean; sort: Sort; limit: number }

interface PageInput {
  ask: Ask;
  /** The person whose sequences these are. */
  user?: Resolved;
  set: SequenceSet;
  /** The cursor's `list` state; undefined on page 1. */
  state?: ListState;
  /** Its `given` decides the request echo's `(default)` marks. */
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** `1 sequence`, `3 sequences`. */
const counted = (n: number): string => `${fmtInt(n)} ${n === 1 ? "sequence" : "sequences"}`;

/** A sequence of the page, hydrated, and where its row stood in the page. */
interface Shown { card: RawSeqCard; at: number }

/**
 * Only the page shown is hydrated (R2, R10): the forum answers in its own order, so each row of the page is looked up by id and
 * printed in the page's order; an id the hydrate dropped (or the forum hides) is skipped.
 */
async function hydrate(page: readonly RawSeqLight[], ctx: CallContext, svc: Services): Promise<Shown[]> {
  const o = sequencesByIdsOp("h", page.map(idOf), "...SEQ_CARD");
  if (o === undefined) return [];
  const cards = rowsOf<RawSeqCard>(aliasData(await svc.gql([o], ctx, HYDRATE_TASK), o.alias, HYDRATE_TASK, ctx));
  const byId = new Map(cards.filter(sequenceListable).map((card) => [card._id, card]));
  const shown = page.flatMap((row, at) => {
    const card = byId.get(row._id);
    return card === undefined ? [] : [{ card, at }];
  });
  if (shown.length < page.length) svc.log.debug("list_sequences rows dropped after the hydrate", { dropped: page.length - shown.length });
  return shown;
}

/** ¶3.7 request echo: the person as resolved, the filters that are on, then the order and the limit. */
function requestEcho(input: PageInput): string[] {
  const { ask, user, echo } = input;
  return [
    ...(user === undefined ? [] : [echoOf("user", user)]),
    ...(ask.curated ? [setting(echo, "curated_only", true)] : []),
    ...(ask.af ? [setting(echo, "af_only", true)] : []),
    setting(echo, "sort", ask.sort),
    setting(echo, "limit", ask.limit),
  ];
}

/** The first line's subject: `all public sequences`, `sequences by "<Name>"`, `curated sequences`, `curated sequences by "<Name>"`. */
function subjectOf(ask: Ask, user: Resolved | undefined): string {
  const what = ask.curated ? "curated sequences" : user === undefined ? "all public sequences" : "sequences";
  return user === undefined ? what : `${what} by "${user.name}"`;
}

/** ¶3.9 filtered-list template: the filters restated with the person resolved, `all public sequences` when there are none. */
function emptyLine(ask: Ask, user: Resolved | undefined): string {
  const filters = [
    ...(user === undefined ? [] : [`by ${personText({ kind: "user", id: user.id, slug: user.slug ?? null, name: user.name })}`]),
    ...(ask.curated ? ["curated"] : []),
    ...(ask.af ? ["AF only"] : []),
  ];
  return emptyText({ kind: "filtered", items: "sequences", filters: filters.length === 0 ? "all public sequences" : filters.join(", ") });
}

/** One page of the ordered set from `state` on, hydrated, with the footer that continues the list or ends it. */
async function pageOf(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { ask, user, set, state } = input;
  const mode = { userId: user?.id, curated: ask.curated };
  const ordered = orderSequences(set.rows, { ...mode, af: ask.af }, ask.sort);
  // ¶3.5: af_only says how many sequences the other filters kept that are not on the Alignment Forum.
  const removed = ask.af ? orderSequences(set.rows, { ...mode, af: false }, ask.sort).length - ordered.length : 0;
  const page = listPage(ordered, state, ask.limit, idOf, createdMs);
  const shown = await hydrate(page.items, ctx, svc);
  const shown0 = state?.shown ?? 0;
  const first: ListState = state ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(ordered, createdMs) };

  /** How many rows of the page `n` printed sequences account for: the rows the hydrate dropped after the last one go with it. */
  const through = (n: number): number => (n >= shown.length ? page.items.length : n === 0 ? 0 : shown[n - 1]!.at + 1);
  const items: PageItem[] = shown.map(({ card }) => ({ text: sequenceLine(toSequenceRecord(card)) }));
  const total = set.maybeMore ? undefined : ordered.length;
  const position = shown.length === 0
    ? undefined
    : (c: Consumed): string => positionText(UNIT, shown0 + 1, shown0 + Math.max(1, through(Math.min(c.items, shown.length))), total);

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, shown.length);
    const done = through(n);
    if (n === shown.length && page.ended) return set.maybeMore ? { kind: "reachable", reason: endMostReturned(SET_MOST) } : { kind: "end" };
    const at = done === 0 ? first : page.after[done - 1]!;
    const cursor = mint(svc, "list_sequences", input.args, input.effective, { streams: [at], current: 0 });
    return { kind: "more", tool: "list_sequences", cursor, next: nextText(UNIT, shown0 + done + 1, Math.min(shown0 + done + ask.limit, ordered.length)) };
  };

  const head = [
    ...(ask.curated || user === undefined ? [COVER_NOTE] : []),
    ...(ask.af ? [`af_only removed ${counted(removed)} not on the Alignment Forum`] : []),
    // ¶3.9: nothing at all on a first page is the filtered-list template; a continuation past the end has nothing to restate.
    ...(page.items.length === 0 && shown0 === 0 ? [emptyLine(ask, user)] : []),
  ];
  const notes = [...(shown.length > 0 ? [CAVEAT["C-COUNTER"]] : []), ...(page.driftNote === undefined ? [] : [page.driftNote])];
  return reply(
    {
      tool: "list_sequences", subject: subjectOf(ask, user), request: requestEcho(input), ...(position !== undefined && { position }),
      oneItem: shown0 === 0 && shown.length === 1 && page.ended, notes, head, items,
    },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

async function userOf(user: string | undefined, ctx: CallContext, svc: Services): Promise<Resolved | undefined> {
  return user === undefined ? undefined : resolve(parseRef("user", user, ["user"]), "user", ctx, svc);
}

async function firstPage(p: ListSequencesParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const user = await userOf(p.user, ctx, svc);
  const set = await loadSequenceSet(ctx, svc);
  const args = givenArgs(p, ctx);
  return pageOf(
    { ask: { curated: p.curated_only, af: p.af_only, sort: p.sort, limit: p.limit }, user, set, echo: ctx, args, effective: listSequencesEffective(p, { userId: user?.id }) },
    p.max_tokens, ctx, svc,
  );
}

async function continuation(entry: CursorEntry, p: ListSequencesParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: a `user` given again is resolved first, so that a slug equals the id it resolves to.
  const given = ctx.given.has("user") ? await userOf(p.user, ctx, svc) : undefined;
  checkContinuation(entry, listSequencesEffective(p, { userId: given?.id }), ctx);
  const stored = entry.effective as { user?: string; curated_only: boolean; af_only: boolean; sort: Sort; limit: number };
  const start = entry.state.streams[0];
  if (start === undefined || start.kind !== "list") throw internalError("list_sequences", "a cursor without a list state");
  // D1 on every continuation: the person is resolved again (the given one was, and is the stored one; else from the cache, or with one request).
  const user = given ?? (await userOf(stored.user, ctx, svc));
  const set = await loadSequenceSet(ctx, svc);
  return pageOf(
    {
      ask: { curated: stored.curated_only, af: stored.af_only, sort: stored.sort, limit: stored.limit }, user, set, state: start,
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  user: P.user().optional(),
  curated_only: P.flag("curated_only"),
  af_only: P.flag("af_only"),
  sort: P.sort("list_sequences"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<ListSequencesParams> = {
  name: "list_sequences",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  run(p, ctx, svc) {
    const entry = openContinuation("list_sequences", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
