// Layer 2. The `get_user` tool (¶4.7): a person's profile and a snapshot of their recent activity in one call. Request 1 resolves
// the person (`ids/resolve`: cached after `find`; an unknown slug is `not_found` with the slug hint, a deleted account `not_public`,
// P8). Request 2 reads the profile and every section's first raw page at once (forum/templates/get_user), without the wiki-edit
// page when `revuser` already holds the person's set; the profile is the subject, so its failure is the call's error. Request 3,
// only when one part applies, reads the pinned posts, the second wiki-edit page and the AF comments the scan kept. Once the profile
// is shown, a part that fails is a `Partial:` line in its section's place; a deadline stop before request 3 shows the profile and
// request 2's sections and continues as page 1 again (¶2.2 step 5).
// Every row passes D1 and the re-checks of its section (P1, P2, P3, P4, P5, P7, D11): post sections keep sub-questions and group
// posts, flagged (Q58); wiki edits come from `loadUserWikiEdits` (P12). Only counts of what was dropped are logged (P14). Fields
// outside USER_PROFILE (`profileUpdatedAt` and `bio` among them) are never fetched (P13, P10). AF membership is the only group
// shown (D9).
// The page is the profile (the head) and one item per section; each section ends with the call that continues it in its own
// tool, with a minted cursor that starts after the items shown (¶3.6 hand-offs). A page over the budget continues with a `slice`
// cursor at the next section; a bio or help text longer than about 3,000 tokens (or its share of a small page) is cut on page 1,
// and its rest is a block after the sections in that stream. A continuation repeats requests 1–3 as page 1 sent them, so they
// come from the caches.
import { z } from "zod";
import { CONFIG } from "../config";
import { parentOf, placeOf, toCommentRecord } from "../domain/comments";
import { recheck, recheckComment } from "../domain/filters";
import { toPostRecord } from "../domain/posts";
import { toSequenceRecord } from "../domain/sequences";
import { userUrl } from "../domain/urls";
import { toUserProfile } from "../domain/users";
import { commentPublic, postPublic, sequenceListable, userPublic } from "../domain/visibility";
import { CallStopped, forumError, internalError, isToolError, loginOnly, notFound, notPublic, ToolError } from "../errors";
import { AF_COMMENT_SCAN, getUserFollowupOps, getUserMainOps, POSTS_SPARE, PROFILE_SEQUENCES_LIMIT } from "../forum/templates/get_user";
import { isEntityId, parseRef } from "../ids/parse";
import { echoOf, resolve } from "../ids/resolve";
import { fingerprint, sliceAfter } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { Budget, estimateTokens, sliceText } from "../render/budget";
import { fence, renderPage } from "../render/layout";
import { CAVEAT, CUT_IN_CODE, cutMarker, emptyText, FLAG, fmtInt, partialLine } from "../render/messages";
import { commentBlock, postLine, quote, revisionLine, sequenceLine } from "../render/records";
import { day } from "../text/dates";
import { oneLine } from "../text/sanitize";
import type {
  AliasResult, AliasResults, CallContext, Consumed, CursorEntry, CursorState, Footer, GqlOp, PageItem, ParsedRef, RawCommentLight,
  RawCommentList, RawPostCard, RawSeqCard, RawUserProfile, Resolved, RevisionRecord, Services, StopReason, StreamState, ToolDef,
  ToolOutput, UserProfile,
} from "../types";
import { checkContinuation, givenArgs, handOffCall, isRecord, mint, openContinuation, rowsOf, setting } from "./common";
import { historyUserEffective, tool as getHistoryTool, type GetHistoryParams } from "./get_history";
import { listCommentsEffective, tool as listCommentsTool, type ListCommentsParams } from "./list_comments";
import { listPostsEffective, tool as listPostsTool, type ListPostsParams } from "./list_posts";
import { listSequencesEffective, tool as listSequencesTool, type ListSequencesParams } from "./list_sequences";
import { loadUserWikiEdits } from "./loaders";

type GetUserParams = { user?: string; af_only: boolean; limit: number; cursor?: string; max_tokens: number };

type SliceState = Extract<StreamState, { kind: "slice" }>;

const TITLE = "Who is this, and what have they done lately?";
/** ¶4.7, verbatim. */
const DESCRIPTION_QUOTE = `A person's public profile and recent activity in one call. user = id, profile URL or exact slug (case-sensitive). Returns display name, ids, member since, karma and AF karma (live; karma includes votes on their wiki edits and is not the sum of their items' scores), AF membership, post and comment counts (site counters, approximate; the post count excludes coauthored posts), the bio and the "how I can help / how others can help me" texts, job, organization and links, pinned posts, and limit items in each of: top posts by karma, latest posts, latest comments (each with its post and who it replies to), sequences, and recent wiki edits. Coauthored posts are included. Event and meetup posts are not listed here; they open by id and can appear in search. af_only limits the post, comment and sequence sections to AF items (the profile and wiki edits are unchanged; the comment section then checks the person's latest 500 comments). Each section ends with the call that continues it (list_posts, list_comments, list_sequences or get_history, with a cursor that starts after the items shown).`;

const MAIN_TASK = "reading the profile and recent activity";
const FOLLOWUP_TASK = "reading the pinned posts, wiki edits and AF comments";
const NAME_CAP = CONFIG.render.caps.name;
const TITLE_CAP = CONFIG.render.caps.title;
const SEP = " · ";
/** ¶3.5, D9: the one group a profile names. */
const AF_MEMBER = "AF member";
/** ¶4.7 step 2: the end of the wiki-edit section when the second raw page was also full. */
const OVER_2000 = "(over 2,000 wiki revisions; only the first 2,000 the forum returns can be ordered)";
/**
 * The profile texts, head lines every page 1 keeps: the bio (fenced as forum text) and the two help texts (each a `> ` quote
 * under its heading), in this order. Each is cut at `CONFIG.render.bioCapTokens`, and at its share of a smaller page's budget,
 * so that the sections keep the rest of page 1 and a cut never falls inside the bio's fence; the rest of each cut text is a block
 * after the sections, in the same order, and the cursor's data keeps where it starts.
 */
type TextKey = "bio" | "helpMe" | "helpOthers";
const TEXTS: readonly TextKey[] = ["bio", "helpMe", "helpOthers"];
const TEXT_SHARE: Readonly<Record<TextKey, number>> = { bio: 0.4, helpMe: 0.2, helpOthers: 0.2 };
const HELP_HEADING: Readonly<Record<Exclude<TextKey, "bio">, string>> = { helpMe: "How others can help me", helpOthers: "How I can help others" };
/** The cursor data key holding where the rest of a cut text starts. */
const TEXT_FROM_KEY: Readonly<Record<TextKey, string>> = { bio: "bioFrom", helpMe: "helpMeFrom", helpOthers: "helpOthersFrom" };
/** The `next:` text of a footer whose cursor continues with a text's rest. */
const TEXT_NEXT: Readonly<Record<TextKey, string>> = { bio: "the rest of the bio", helpMe: `the rest of ${HELP_HEADING.helpMe}`, helpOthers: `the rest of ${HELP_HEADING.helpOthers}` };
const BIO_LABEL = "bio";
const BIO_REST_LABEL = "bio, continued";
/** The widest line after a cut text, charged before the cut is found. */
const WIDEST_CUT_MARKER = `${cutMarker(9_999_999)} ${CUT_IN_CODE}`;
/** The order the notes are printed in (¶4.7 Output layout). */
const NOTE_ORDER: readonly string[] = [CAVEAT["C-COUNTER"], CAVEAT["C-CHANGEMETRICS"]];

/** The sections, in page order: the blocks 0–5 of the `slice` stream; the blocks after them are the rests of the texts cut on page 1. */
type SectionKey = "pinned" | "top" | "latest" | "comments" | "sequences" | "wiki";
const SECTIONS: readonly SectionKey[] = ["pinned", "top", "latest", "comments", "sequences", "wiki"];
const HEADING: Readonly<Record<SectionKey, string>> = {
  pinned: "Pinned posts", top: "Top posts (by karma)", latest: "Latest posts", comments: "Latest comments", sequences: "Sequences",
  wiki: "Recent wiki edits",
};
/** The `Partial:` section names. */
const PARTIAL_NAME: Readonly<Record<SectionKey, string>> = {
  pinned: "pinned posts", top: "top posts", latest: "latest posts", comments: "latest comments", sequences: "sequences", wiki: "wiki edits",
};

/** A creation date in epoch milliseconds, 0 for an unreadable one: `list_sequences`' own accessor, so fingerprints agree. */
function createdMs(r: { createdAt: string }): number {
  const t = Date.parse(r.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** A whole count with its noun: `1 post`, `967 posts`. */
const counted = (n: number, one: string): string => `${fmtInt(n)} ${n === 1 ? one : `${one}s`}`;

// what was asked

/** The parameters that shape a page, stored in its cursor. */
interface Ask { afOnly: boolean; limit: number }

/** ¶3.6: the effective values a cursor compares, `user` as the id it resolved to; every parameter but `cursor` and `max_tokens`. */
function effectiveOf(userId: string, ask: Ask): Record<string, unknown> {
  return { user: userId, af_only: ask.afOnly, limit: ask.limit };
}

/** ¶3.7 request echo: the person as resolved, `limit`, and with `af_only` that it leaves the wiki edits as they are (¶4.7 step 7). */
function requestEcho(r: Resolved, ask: Ask, echo: CallContext): string[] {
  return [echoOf("user", r), setting(echo, "limit", ask.limit), ...(ask.afOnly ? ["af_only true", "af_only does not apply to wiki edits"] : [])];
}

/** One page's inputs: the person, what was asked, and on a continuation where it starts and what page 1 decided. */
interface PageInput {
  resolved: Resolved;
  /** The reference that resolved, so that a profile refused since is not found by it from the cache again. */
  ref: ParsedRef;
  ask: Ask;
  /** The caller's `user` string, which the hand-offs repeat. */
  callerUser: string;
  /** Whether the caller gave `limit` (the hand-offs repeat only what was given). */
  limitGiven: boolean;
  /** A continuation's slice state; undefined on page 1. */
  start?: SliceState;
  /** Whether page 1's main request carried the wiki-edit page; a continuation sends the same request, which the cache answers. */
  mainWe?: boolean;
  /** Where the rest of each text cut on page 1 starts. */
  restFrom?: Partial<Record<TextKey, number>>;
  /** Its `given` decides the request echo's `(default)` marks. */
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

// the answers

/** One part of a request: its rows (and the raw count the forum gave), or the `Partial:` line of its failure. */
type Part<T> = { ok: true; rows: T[]; totalCount?: number } | { ok: false; partial: string };

/** The part `alias` of an answer, for `key`'s section: no rows for the forum's "nothing here", a `Partial:` line for any other error. */
function partOf<T>(r: AliasResult | undefined, key: SectionKey): Part<T> {
  if (r === undefined) return { ok: true, rows: [] };
  if ("error" in r) {
    if (r.error === "not_found" || r.error === "not_public") return { ok: true, rows: [] };
    return { ok: false, partial: partialLine(PARTIAL_NAME[key], new ToolError(r.error, r.message)) };
  }
  const totalCount = isRecord(r.data) && typeof r.data.totalCount === "number" ? r.data.totalCount : undefined;
  return { ok: true, rows: rowsOf<T>(r.data), ...(totalCount !== undefined && { totalCount }) };
}

/** What the follow-up request gave: not needed, stopped (deadline or cap), failed as a whole, or its answer. */
type Sent = { kind: "none" } | { kind: "stopped"; why: StopReason } | { kind: "failed"; error: ToolError } | { kind: "ok"; results: AliasResults };

async function sendFollowup(ops: readonly GqlOp[], ctx: CallContext, svc: Services): Promise<Sent> {
  if (ops.length === 0) return { kind: "none" };
  try {
    return { kind: "ok", results: await svc.gql(ops, ctx, FOLLOWUP_TASK) };
  } catch (e) {
    if (e instanceof CallStopped) return { kind: "stopped", why: e.reason };
    if (isToolError(e)) return { kind: "failed", error: e };
    throw e;
  }
}

/**
 * The part `alias` of the follow-up for `key`'s section: no rows when it was not asked for, `undefined` when the request was
 * stopped (the section is left out, not shown empty), the request's own failure as the section's `Partial:` line (¶7), else the
 * alias's answer.
 */
function followupPart<T>(sent: Sent, ops: readonly GqlOp[], alias: string, key: SectionKey): Part<T> | undefined {
  if (!ops.some((o) => o.alias === alias)) return { ok: true, rows: [] };
  switch (sent.kind) {
    case "none": return { ok: true, rows: [] };
    case "stopped": return undefined;
    case "failed": return { ok: false, partial: partialLine(PARTIAL_NAME[key], sent.error) };
    case "ok": return partOf<T>(sent.results.get(alias), key);
  }
}

/**
 * ¶2.3, D1: a profile the forum stopped showing since the person was resolved leaves no raw response of this call behind, and
 * its resolution is dropped, so that the next call asks the forum again.
 */
function forget(x: PageInput, e: ToolError, ctx: CallContext, svc: Services): ToolError {
  svc.evictResponses(ctx.cacheKeys);
  const r = x.resolved;
  for (const key of new Set([`user:${x.ref.value}`, `user:${r.id}`, ...(r.slug === undefined ? [] : [`user:${r.slug}`])])) svc.caches.delete("resolve", key);
  return e;
}

/** ¶4.7 step 2: the profile, the subject of the call: unknown is `not_found`, refused is `not_public` (P8), any other failure the call's error. */
function profileOf(results: AliasResults, x: PageInput, ctx: CallContext, svc: Services): RawUserProfile {
  const id = x.resolved.id;
  const r = results.get("u");
  if (r === undefined) throw internalError(ctx.tool, "get_user_main: the answer has no alias u");
  if ("error" in r) {
    switch (r.error) {
      case "not_found": throw forget(x, notFound("user", "id", id), ctx, svc);
      case "not_public": throw forget(x, notPublic(`the user with the id "${id}"`, "user"), ctx, svc);
      case "internal": throw internalError(ctx.tool, r.message);
      case "forum_error": throw forumError(MAIN_TASK, r.message);
      case "login_only": throw loginOnly();
      default: throw new ToolError(r.error, r.message);
    }
  }
  const doc = isRecord(r.data) ? r.data.result : undefined;
  if (!isRecord(doc) || !userPublic(doc as { deleted: boolean })) throw forget(x, notFound("user", "id", id), ctx, svc);
  return doc as unknown as RawUserProfile;
}

/** `lightScan`'s fullness test on the first wiki-edit page: the second page is read exactly when it would be. */
function secondWikiPageNeeded(we: AliasResult | undefined): boolean {
  if (we === undefined || "error" in we) return false;
  const total = isRecord(we.data) && typeof we.data.totalCount === "number" ? we.data.totalCount : undefined;
  return total !== undefined ? total > CONFIG.paging.revisionPage : rowsOf(we.data).length >= CONFIG.paging.revisionPage;
}

// the sections

/** One section as printed (its item's text), the caveats it needs, and how many of its rows D1 or a re-check dropped. */
interface Built { text: string; notes: string[]; dropped: number }

/** What every section reads beyond its own part. */
interface SectionCtx { x: PageInput; userId: string; ctx: CallContext; svc: Services }

const partialSection = (partial: string): Built => ({ text: partial, notes: [], dropped: 0 });

/**
 * A section's text: the heading, the item lines, the lines after them and the hand-off. With no items it is "none publicly
 * visible", or, when the hand-off still continues it, the scan line (¶3.6: no empty-result wording before a cursor).
 */
function sectionText(key: SectionKey, lines: readonly string[], after: readonly string[], handOff: string | undefined, checked: number): string {
  const heading = HEADING[key];
  const more = handOff === undefined ? [] : [handOff];
  if (lines.length > 0) return [`${heading}:`, ...lines, ...after, ...more].join("\n");
  if (handOff !== undefined) return [`${heading}:`, emptyText({ kind: "scan", checked }), ...after, ...more].join("\n");
  return [`${heading}: none publicly visible`, ...after].join("\n");
}

/** A hand-off line: the complete call, its cursor minted for `tool` (¶3.6), under the section it continues. */
function handOffLine(
  s: SectionCtx, tool: "list_posts" | "list_comments" | "list_sequences" | "get_history", args: Record<string, unknown>,
  effective: Record<string, unknown>, state: StreamState,
): string {
  return `  More: ${handOffCall(tool, args, mint(s.svc, tool, args, effective, { streams: [state], current: 0 }))}`;
}

/** The arguments a hand-off repeats: the caller's `user`, the sort when the target has several, `af_only` when set and taken, `limit` when given. */
function handOffArgs(s: SectionCtx, extra: { sort?: "top" | "new"; afOnly: boolean }): Record<string, unknown> {
  const { x } = s;
  return {
    user: x.callerUser, ...(extra.sort !== undefined && { sort: extra.sort }), ...(extra.afOnly && { af_only: true }),
    ...(x.limitGiven && { limit: x.ask.limit }),
  };
}

/** The keyset state of a `new` list right after `shown` (the boundary at the last one shown, with the ids shown at that instant). */
function keysetAfter(shown: readonly { _id: string; postedAt: string }[], windowOffset: number): StreamState {
  const last = shown.at(-1);
  if (last === undefined) return { kind: "keyset", shown: 0, dir: "new", boundaryMs: null, idsAtBoundary: [], windowOffset };
  const boundaryMs = Date.parse(last.postedAt);
  const idsAtBoundary = shown.filter((r) => Date.parse(r.postedAt) === boundaryMs).map((r) => r._id);
  return { kind: "keyset", shown: shown.length, dir: "new", boundaryMs, idsAtBoundary, windowOffset: 0 };
}

/**
 * ¶4.7 step 3, D7, D11: the pinned posts in pinned order, each through every post-section rule applied here (P2, P3, P7),
 * sub-questions and group posts kept with their flags; with `af_only`, AF posts only.
 */
function pinnedSection(part: Part<RawPostCard> | undefined, pinnedIds: readonly string[], s: SectionCtx): Built | undefined {
  if (part === undefined) return undefined;
  if (!part.ok) return partialSection(part.partial);
  const byId = new Map(part.rows.map((row) => [row._id, row]));
  const kept = [...new Set(pinnedIds)].flatMap((id) => {
    const row = byId.get(id);
    const shown = postPublic(row) && !row.unlisted && !row.isEvent && !row.shortform && !row.hideAuthor && (!s.x.ask.afOnly || row.af);
    return shown ? [row] : [];
  });
  const lines = kept.map((row) => postLine(toPostRecord(row)));
  return { text: sectionText("pinned", lines, [], undefined, part.rows.length), notes: lines.length > 0 ? [CAVEAT["C-COUNTER"]] : [], dropped: part.rows.length - kept.length };
}

/**
 * ¶4.7 steps 2 and 8: the top or the latest posts, every row re-checked (`postPublic` and the author list rules, `af` with
 * `af_only`; own and coauthored posts kept), the first `limit` shown, and the `list_posts` hand-off when more exist (more passing
 * rows than shown, or a full raw page): `top` by `offset` after the raw row of the last post shown, `new` by `keyset` at it.
 */
function postsSection(key: "top" | "latest", part: Part<RawPostCard>, s: SectionCtx): Built {
  if (!part.ok) return partialSection(part.partial);
  const { ask } = s.x;
  const rawCount = ask.limit + POSTS_SPARE;
  const passing = part.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => postPublic(row) && recheck(row, { authorId: s.userId, af: ask.afOnly || undefined }));
  const shown = passing.slice(0, ask.limit);
  let handOff: string | undefined;
  if (passing.length > ask.limit || part.rows.length >= rawCount) {
    const sort = key === "top" ? "top" : "new";
    const args = handOffArgs(s, { sort, afOnly: ask.afOnly });
    const last = shown.at(-1);
    const state: StreamState = sort === "new"
      ? keysetAfter(shown.map((p) => p.row), rawCount)
      : last === undefined ? { kind: "offset", shown: 0, offset: rawCount } : { kind: "offset", shown: shown.length, offset: last.index + 1, lastId: last.row._id };
    const effective = listPostsEffective(listPostsTool.schema.parse(args) as ListPostsParams, { userId: s.userId });
    handOff = handOffLine(s, "list_posts", args, effective, state);
  }
  const lines = shown.map(({ row }) => postLine(toPostRecord(row)));
  return {
    text: sectionText(key, lines, [], handOff, part.rows.length), notes: lines.length > 0 ? [CAVEAT["C-COUNTER"]] : [],
    dropped: part.rows.length - passing.length,
  };
}

/** P1, P5, P6, P7: a comment shown in a person's list: public, not a placeholder, not a debate turn, attributable to them; `af` with `af_only`. */
function commentShown(row: RawCommentList, s: SectionCtx): boolean {
  return commentPublic(row) && !row.deleted && row.debateResponse !== true && !row.hideAuthor
    && recheckComment(row, { authorId: s.userId, af: s.x.ask.afOnly || undefined });
}

/** ¶3.8.1, ¶3.7: a comment in list form, with its place and who it replies to, its body cut at about 1,500 tokens. */
function commentText(row: RawCommentList): string {
  return commentBlock({ ...toCommentRecord(row), place: placeOf(row), parent: parentOf(row) }, { form: "list", bodyCapTokens: CONFIG.render.listCommentCapTokens });
}

/** The `list_comments` hand-off: a keyset state at the last comment shown (¶3.6), from the window's start when none was. */
function commentsHandOff(s: SectionCtx, shown: readonly RawCommentList[], emptyOffset: number): string {
  const args = handOffArgs(s, { afOnly: s.x.ask.afOnly });
  const effective = listCommentsEffective(listCommentsTool.schema.parse(args) as ListCommentsParams, { userId: s.userId });
  return handOffLine(s, "list_comments", args, effective, keysetAfter(shown, emptyOffset));
}

/** ¶4.7 step 2: the latest comments, `limit + 5` read, the first `limit` that pass shown. */
function commentsSection(part: Part<RawCommentList>, s: SectionCtx): Built {
  if (!part.ok) return partialSection(part.partial);
  const { ask } = s.x;
  const rawCount = ask.limit + POSTS_SPARE;
  const passing = part.rows.filter((row) => commentShown(row, s));
  const shown = passing.slice(0, ask.limit);
  const handOff = passing.length > ask.limit || part.rows.length >= rawCount ? commentsHandOff(s, shown, rawCount) : undefined;
  return {
    text: sectionText("comments", shown.map(commentText), [], handOff, part.rows.length), notes: [],
    dropped: part.rows.length - passing.length,
  };
}

/** The AF comments `af_only` hydrates: the first `limit` light rows of the scan that are on AF and by the person. */
function afCommentIds(part: Part<RawCommentLight>, s: SectionCtx): string[] {
  if (!part.ok) return [];
  return part.rows.filter((row) => recheckComment(row, { af: true, authorId: s.userId })).slice(0, s.x.ask.limit).map((row) => row._id);
}

/**
 * ¶4.7 step 7: with `af_only`, the latest 500 comments as light rows, the AF ones hydrated by the follow-up in the scan's order.
 * Fewer than `limit` shown says how many the scan kept and points to `list_comments {user, af_only: true}`.
 */
function afCommentsSection(scan: Part<RawCommentLight>, hydrated: Part<RawCommentList> | undefined, ids: readonly string[], s: SectionCtx, slug: string): Built | undefined {
  if (!scan.ok) return partialSection(scan.partial);
  if (hydrated === undefined) return undefined;
  if (!hydrated.ok) return partialSection(hydrated.partial);
  const { ask } = s.x;
  const kept = scan.rows.filter((row) => recheckComment(row, { af: true, authorId: s.userId }));
  const byId = new Map(hydrated.rows.map((row) => [row._id, row]));
  const shown = ids.flatMap((id) => {
    const row = byId.get(id);
    return row !== undefined && commentShown(row, s) ? [row] : [];
  });
  const note = shown.length < ask.limit
    ? [`af_only kept ${fmtInt(shown.length)} of the latest ${fmtInt(AF_COMMENT_SCAN)} comments; more: list_comments {user: ${JSON.stringify(slug)}, af_only: true}`]
    : [];
  const handOff = kept.length > ask.limit || scan.rows.length >= AF_COMMENT_SCAN ? commentsHandOff(s, shown, 0) : undefined;
  return {
    text: sectionText("comments", shown.map(commentText), note, handOff, scan.rows.length), notes: [],
    dropped: scan.rows.length - kept.length + ids.length - shown.length,
  };
}

/** P4: the sequences listed on the profile (the `userProfile` view's rows, hidden ones dropped), in the view's profile order. */
function listableSequences(part: Part<RawSeqCard>): RawSeqCard[] {
  return part.ok ? part.rows.filter(sequenceListable) : [];
}

/**
 * ¶4.7 steps 5 and 7, P10: the sequences, AF ones only with `af_only` (filtered here, ¶3.5), the first `limit` shown, and the
 * `list_sequences` hand-off: a `list` state after the last one shown, with the fingerprint `list_sequences` computes over the same
 * rows.
 */
function sequencesSection(part: Part<RawSeqCard>, s: SectionCtx): Built {
  if (!part.ok) return partialSection(part.partial);
  const { ask } = s.x;
  const listable = listableSequences(part);
  const listed = ask.afOnly ? listable.filter((row) => row.af) : listable;
  const shown = listed.slice(0, ask.limit);
  let handOff: string | undefined;
  if (listed.length > ask.limit || part.rows.length >= PROFILE_SEQUENCES_LIMIT) {
    const args = handOffArgs(s, { afOnly: ask.afOnly });
    const effective = listSequencesEffective(listSequencesTool.schema.parse(args) as ListSequencesParams, { userId: s.userId });
    const last = shown.at(-1);
    const state: StreamState = {
      kind: "list", shown: shown.length, index: shown.length, ...(last !== undefined && { lastId: last._id }), fingerprint: fingerprint(listed, createdMs),
    };
    handOff = handOffLine(s, "list_sequences", args, effective, state);
  }
  const lines = shown.map((row) => sequenceLine(toSequenceRecord(row)));
  return {
    text: sectionText("sequences", lines, [], handOff, part.rows.length), notes: lines.length > 0 ? [CAVEAT["C-COUNTER"]] : [],
    dropped: part.rows.length - listable.length,
  };
}

/**
 * ¶4.7 steps 2, 3, 6 and 8, L1: the newest `limit` wiki edits of the person's set (`loadUserWikiEdits`, the set `get_history {user}`
 * pages), each with its page, and the `get_history` hand-off, a `list` state into that set after the last one shown. When the
 * second raw page was needed, the section waits for the follow-up: left out when it was stopped, partial when it failed.
 */
async function wikiSection(main: AliasResults, sent: Sent, secondPage: boolean, s: SectionCtx): Promise<Built | undefined> {
  if (secondPage && sent.kind === "stopped") return undefined;
  if (secondPage && sent.kind === "failed") return partialSection(partialLine(PARTIAL_NAME.wiki, sent.error));
  let edits: { rows: RevisionRecord[]; over2000: boolean };
  try {
    edits = await loadUserWikiEdits(s.userId, s.ctx, s.svc, new Map([...main, ...(sent.kind === "ok" ? sent.results : [])]));
  } catch (e) {
    if (e instanceof CallStopped) return undefined;
    if (isToolError(e)) return partialSection(partialLine(PARTIAL_NAME.wiki, e));
    throw e;
  }
  const { ask } = s.x;
  const { rows } = edits;
  const shown = rows.slice(0, ask.limit);
  let handOff: string | undefined;
  if (rows.length > ask.limit) {
    const args = { user: s.x.callerUser, ...(s.x.limitGiven && { limit: ask.limit }) };
    const effective = historyUserEffective(getHistoryTool.schema.parse(args) as GetHistoryParams, s.userId);
    const state: StreamState = {
      kind: "list", shown: shown.length, index: shown.length, lastId: shown.at(-1)!.id, fingerprint: fingerprint(rows, (r) => r.editedMs),
    };
    handOff = handOffLine(s, "get_history", args, effective, state);
  }
  return {
    text: sectionText("wiki", shown.map(revisionLine), edits.over2000 ? [OVER_2000] : [], handOff, rows.length),
    notes: shown.length > 0 ? [CAVEAT["C-CHANGEMETRICS"]] : [], dropped: 0,
  };
}

// the profile (the head of page 1)

/** `User "<name>" · user_slug … · user_id … · <profile URL>`: the first line of every page. */
function userLine(profile: UserProfile): string {
  return [`User "${oneLine(profile.name, NAME_CAP)}"`, `user_slug ${profile.slug}`, `user_id ${profile.id}`, userUrl(profile.slug)].join(SEP);
}

/** ¶4.7 step 5, D9, P10: member since, karma, AF karma, AF membership, the site counters with `~`, the sequences listed on the profile. */
function memberLine(profile: UserProfile, sequences: number | undefined): string {
  const facts = [`Member since ${day(profile.createdAt)}`, `karma ${fmtInt(profile.karma)}`, FLAG.afKarma(profile.afKarma)];
  if (profile.afMember) facts.push(AF_MEMBER);
  facts.push(`~${counted(profile.postCount, "post")} (excludes coauthored)`, `~${counted(profile.commentCount, "comment")} (site counters)`);
  if (sequences !== undefined) facts.push(`${counted(sequences, "sequence")} on their profile`);
  return facts.join(SEP);
}

/** Job, organization and links, each only when present; all are single-line forum fields (¶3.7, Q79). */
function jobLine(profile: UserProfile): string | undefined {
  const parts: string[] = [];
  if (profile.job !== undefined) parts.push(`Job: ${oneLine(profile.job, TITLE_CAP)}`);
  if (profile.org !== undefined) parts.push(`Organization: ${oneLine(profile.org, TITLE_CAP)}`);
  if (profile.links.length > 0) {
    parts.push(`Links: ${profile.links.map((l) => `${oneLine(l.label, NAME_CAP)} ${oneLine(l.url, TITLE_CAP)}`).join(SEP)}`);
  }
  return parts.length === 0 ? undefined : parts.join(SEP);
}

/** A text as page 1 prints it: the bio fenced as forum text, a help text under its heading as a `> ` quote (¶3.7, Q79). */
function textHead(key: TextKey, text: string, nonce: string): string {
  return key === "bio" ? fence(BIO_LABEL, text, nonce) : `${HELP_HEADING[key]}:\n${quote(text)}`;
}

/** The rest of a text cut on page 1, as the block a continuation shows after the sections. */
function textRest(key: TextKey, rest: string): PageItem {
  return key === "bio" ? { text: rest, fence: BIO_REST_LABEL } : { text: `${HELP_HEADING[key]}, continued:\n${quote(rest)}` };
}

/**
 * A text as page 1 prints it, cut at about 3,000 tokens (and at its share of the page) at a paragraph or sentence end and followed
 * by the cut marker, outside the fence or quote; `restFrom` is where the rest starts, which the cursor shows after the sections.
 */
function textLines(key: TextKey, text: string | undefined, nonce: string, maxTokens: number): { lines: string[]; restFrom?: number } {
  if (text === undefined) return { lines: [] };
  // The fence or heading lines are charged first, and a quote's `> ` prefixes as the whole text's (more than the cut part's).
  const frame = estimateTokens(textHead(key, "", nonce)) + (key === "bio" ? 0 : estimateTokens(quote(text)) - estimateTokens(text));
  const cap = Math.min(CONFIG.render.bioCapTokens, new Budget(maxTokens).share(TEXT_SHARE[key])) - frame;
  if (sliceText(text, Math.max(0, cap)).next === undefined) return { lines: [textHead(key, text, nonce)] };
  // The marker is charged before the cut is found (its widest form, and its joining newline).
  const cut = sliceText(text, Math.max(0, cap - estimateTokens(WIDEST_CUT_MARKER) - 1));
  if (cut.next === undefined || cut.moreWords === 0) return { lines: [textHead(key, cut.text, nonce)] };
  return { lines: [textHead(key, cut.text, nonce), `${cutMarker(cut.moreWords)}${cut.inCode ? ` ${CUT_IN_CODE}` : ""}`], restFrom: cut.next };
}

/** The `next:` text of a footer: the section the cursor continues, or the rest of a cut text (`tails`: the cut texts, in block order). */
function nextText(next: SliceState, tails: readonly TextKey[]): string {
  if (next.block >= SECTIONS.length) return TEXT_NEXT[tails[next.block - SECTIONS.length] ?? "bio"];
  const label = HEADING[SECTIONS[next.block]!];
  return next.offset > 0 ? `${label}, continued` : label;
}

// one page

async function userPage(x: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { ask, start } = x;
  const first = start === undefined;
  const userId = x.resolved.id;
  const s: SectionCtx = { x, userId, ctx, svc };

  // Request 2. A stop before it answered is the server's `timeout` error (¶2.2 step 5); its failure is the call's error.
  const mainWe = x.mainWe ?? svc.caches.get("revuser", userId) === undefined;
  const mainOps = getUserMainOps(userId, ask.limit, ask.afOnly).filter((o) => mainWe || o.alias !== "we");
  const main = await svc.gql(mainOps, ctx, MAIN_TASK);
  const profile = toUserProfile(profileOf(main, x, ctx, svc));

  // Request 3, only with a part that applies.
  const scan = ask.afOnly ? partOf<RawCommentLight>(main.get("cl"), "comments") : undefined;
  const afIds = scan === undefined ? [] : afCommentIds(scan, s);
  const secondPage = mainWe && secondWikiPageNeeded(main.get("we"));
  const pinnedIds = profile.pinnedPostIds.filter(isEntityId);
  const followOps = getUserFollowupOps({ userId, pinnedIds, secondWikiPage: secondPage, afCommentIds: afIds });
  const sent = await sendFollowup(followOps, ctx, svc);

  // The sections from the block this page starts at; each is built (and its hand-off minted) only when it can be shown.
  const seq = partOf<RawSeqCard>(main.get("seq"), "sequences");
  const builders: readonly (() => Promise<Built | undefined>)[] = [
    async () => pinnedSection(followupPart<RawPostCard>(sent, followOps, "pin", "pinned"), pinnedIds, s),
    async () => postsSection("top", partOf<RawPostCard>(main.get("top"), "top"), s),
    async () => postsSection("latest", partOf<RawPostCard>(main.get("recent"), "latest"), s),
    async () => scan === undefined
      ? commentsSection(partOf<RawCommentList>(main.get("cm"), "comments"), s)
      : afCommentsSection(scan, followupPart<RawCommentList>(sent, followOps, "ch", "comments"), afIds, s, profile.slug),
    async () => sequencesSection(seq, s),
    () => wikiSection(main, sent, secondPage, s),
  ];
  const startBlock = start?.block ?? 0;
  const built: (Built | undefined)[] = [];
  for (let i = startBlock; i < builders.length; i++) built[i] = await builders[i]!();
  const dropped = Object.fromEntries(SECTIONS.map((key, i) => [key, built[i]?.dropped ?? 0]));
  if (Object.values(dropped).some((n) => n > 0)) svc.log.debug("get_user rows dropped by the visibility rules and re-checks", dropped);
  // A section of this page left out means a stop: request 3 was not sent, or (rarely) a wiki-edit page of its own was not.
  const leftOut = built.some((b, i) => i >= startBlock && b === undefined);
  const stopped = !leftOut ? undefined : sent.kind === "stopped" ? sent.why : (ctx.stopped ?? "time limit");

  // The head: on page 1 the whole profile, on a continuation the person's line.
  const nonce = svc.nonce();
  const textOf: Readonly<Record<TextKey, string | undefined>> = { bio: profile.bio, helpMe: profile.helpMe, helpOthers: profile.helpOthers };
  const texts = TEXTS.map((key) => ({ key, ...(first ? textLines(key, textOf[key], nonce, maxTokens) : { lines: [], restFrom: x.restFrom?.[key] }) }));
  const job = jobLine(profile);
  const head = first
    ? [userLine(profile), memberLine(profile, seq.ok ? listableSequences(seq).length : undefined), ...(job === undefined ? [] : [job]), ...texts.flatMap((t) => t.lines)]
    : [userLine(profile)];
  const notes = new Set([...(first ? [CAVEAT["C-COUNTER"]] : []), ...built.flatMap((b) => b?.notes ?? [])]);

  // The stream's blocks: the six sections, then the rest of each text cut on page 1, which only a continuation shows.
  const tails = texts.filter((t): t is typeof t & { restFrom: number } => t.restFrom !== undefined);
  const total = SECTIONS.length + tails.length;
  const blocks: (PageItem | undefined)[] = built.map((b) => (b === undefined ? undefined : { text: b.text }));
  if (!first) {
    for (const [i, t] of tails.entries()) {
      const block = SECTIONS.length + i;
      if (startBlock <= block) blocks[block] = textRest(t.key, (textOf[t.key] ?? "").slice(t.restFrom));
    }
  }
  const items = blocks.slice(startBlock).flatMap((item, j) => {
    if (item === undefined) return [];
    return j === 0 && start !== undefined && start.offset > 0 ? [{ ...item, from: start.offset }] : [item];
  });

  const data = { mainWe, ...Object.fromEntries(tails.map((t) => [TEXT_FROM_KEY[t.key], t.restFrom])) };
  const footerFor = (c: Consumed): Footer => {
    if (stopped !== undefined) {
      // ¶2.2 step 5: the cursor shows this page again, with the parts that were not read: page 1, or the same continuation.
      const state: CursorState = first
        ? { streams: [{ kind: "slice", shown: 0, block: 0, offset: 0 }], current: 0, data: { page1: true, mainWe } }
        : { streams: [start], current: 0, data };
      return { kind: "stopped", why: stopped, tool: "get_user", cursor: mint(svc, "get_user", x.args, x.effective, state) };
    }
    const next = sliceAfter(c, start, total);
    if (next === undefined) return { kind: "end" };
    return {
      kind: "more", tool: "get_user", cursor: mint(svc, "get_user", x.args, x.effective, { streams: [next], current: 0, data }), next: nextText(next, tails.map((t) => t.key)),
    };
  };
  const spec = {
    tool: "get_user" as const, subject: `"${oneLine(profile.name, NAME_CAP)}"`, request: requestEcho(x.resolved, ask, x.echo),
    notes: NOTE_ORDER.filter((n) => notes.has(n)), head, items,
  };
  return { text: renderPage(spec, maxTokens, nonce, footerFor).text, isError: false };
}

// first page and continuation

async function firstPage(p: GetUserParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const user = p.user!;
  const ref = parseRef("user", user, ["user"]);
  const resolved = await resolve(ref, "user", ctx, svc);
  const ask: Ask = { afOnly: p.af_only, limit: p.limit };
  const args = givenArgs(p, ctx);
  return userPage(
    { resolved, ref, ask, callerUser: user, limitGiven: ctx.given.has("limit"), echo: ctx, args, effective: effectiveOf(resolved.id, ask) },
    p.max_tokens, ctx, svc,
  );
}

async function continuation(entry: CursorEntry, p: GetUserParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { user: string; af_only: boolean; limit: number };
  // ¶3.6: the parameters given again are compared before any request, `user` once it is resolved (a slug equals its id).
  checkContinuation(entry, { af_only: p.af_only, limit: p.limit }, ctx);
  const firstUser = typeof entry.args.user === "string" ? entry.args.user : stored.user;
  const gave = ctx.given.has("user") && p.user !== undefined;
  // D1 on every continuation: the person is resolved again (from the cache, or with one request), and request 2 reads the profile.
  const ref = parseRef("user", gave ? p.user! : firstUser, ["user"]);
  const resolved = await resolve(ref, "user", ctx, svc);
  if (gave) checkContinuation(entry, { user: resolved.id }, ctx);
  // The caller's string now names another person: the one this cursor read is no longer found by it.
  if (resolved.id !== stored.user) throw notFound("user", "id", stored.user);
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "slice") throw internalError("get_user", "a cursor without a slice state");
  const data = isRecord(entry.state.data) ? entry.state.data : {};
  const page1 = data.page1 === true;
  // Where the rest of each text cut on page 1 starts (whole numbers only; anything else is no rest).
  const restFrom: Partial<Record<TextKey, number>> = {};
  for (const key of TEXTS) {
    const at = data[TEXT_FROM_KEY[key]];
    if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) restFrom[key] = at;
  }
  return userPage(
    {
      resolved, ref, ask: { afOnly: stored.af_only, limit: stored.limit }, callerUser: firstUser, limitGiven: Object.hasOwn(entry.args, "limit"),
      ...(!page1 && { start: state }), ...(typeof data.mainWe === "boolean" && { mainWe: data.mainWe }),
      ...(!page1 && { restFrom }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  user: P.user().optional(),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetUserParams> = {
  name: "get_user",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["user"],
  run(p, ctx, svc) {
    const entry = openContinuation("get_user", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
