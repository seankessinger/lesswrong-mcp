// Layer 3. "Trust but verify" (¶4.5): re-checks, on every returned row, each filter the tools asked the forum to apply,
// because the forum ignores some of them silently (Q8), pads `tagRelevance` with untagged posts (Q55) and adds sub-questions
// and group posts to author lists (Q58). A row that fails is dropped by the caller. Every predicate here is pure: it never
// throws and never logs, so callers count what they drop and debug-log only the numbers (P14, ¶7).
import type { DateRange, RawCommentLight, RawCommentList, RawPostCard, RawPostLight } from "../types";
import { postListable } from "./visibility";

/** The filters of a post list. A boolean filter is checked only when it is `true`; the others only when given. */
export interface PostFilters {
  af?: boolean; question?: boolean; tagId?: string; curated?: boolean; frontpage?: boolean;
  range?: DateRange; minKarma?: number; authorId?: string;
}

/** The filters of a comment list. A boolean filter is checked only when it is `true`; the others only when given. */
export interface CommentFilters { af?: boolean; range?: DateRange; minKarma?: number; authorId?: string; topLevel?: boolean }

/** The window is `[start, endExclusive)` with either side optional; a date that does not parse fails a closed side. */
function inWindow(postedAt: string, range: DateRange | undefined): boolean {
  if (range === undefined || (range.start === undefined && range.endExclusive === undefined)) return true;
  const ms = Date.parse(postedAt);
  if (Number.isNaN(ms)) return false;
  if (range.start !== undefined && ms < range.start) return false;
  if (range.endExclusive !== undefined && ms >= range.endExclusive) return false;
  return true;
}

/** Light rows carry their coauthors as ids, cards as users; `coauthors` is `null` when the forum sent no join. */
function coauthorIdsOf(row: RawPostLight | RawPostCard): readonly string[] {
  return "coauthorUserIds" in row ? row.coauthorUserIds : (row.coauthors ?? []).map((u) => u._id);
}

/**
 * Whether a post row survives the list rules and every filter that was asked for.
 *
 * Always: `postListable` (not rejected, not unlisted, not a quick-takes container; P2, P3), not an event (D11), a
 * sub-question or group post only with an author filter, where the forum lists it under its author (Q58), and the
 * anonymity rule (P7). When asked: `af`, `question`, a `tagRelevance` of at least 1 for `tagId` (Q55), `curatedDate` and
 * `frontpageDate` set (Q8, L2), `postedAt` in the window, `baseScore` at least `minKarma`, and `authorId` as owner or
 * coauthor.
 *
 * `opts.except: "tag"` leaves out the tag test and nothing else (the untagged section of `list_posts`, ¶4.5).
 */
export function recheck(row: RawPostLight | RawPostCard, f: PostFilters, opts?: { except?: "tag" }): boolean {
  if (!postListable(row) || row.isEvent) return false;
  const byAuthor = f.authorId !== undefined;
  if ((row.hiddenRelatedQuestion || row.groupId) && !byAuthor) return false;
  if (row.hideAuthor && byAuthor) return false;

  if (f.af === true && !row.af) return false;
  if (f.question === true && !row.question) return false;
  if (f.tagId !== undefined && opts?.except !== "tag" && (row.tagRelevance?.[f.tagId] ?? 0) < 1) return false;
  if (f.curated === true && row.curatedDate == null) return false;
  if (f.frontpage === true && row.frontpageDate == null) return false;
  if (!inWindow(row.postedAt, f.range)) return false;
  if (f.minKarma !== undefined && row.baseScore < f.minKarma) return false;
  if (f.authorId !== undefined && row.userId !== f.authorId && !coauthorIdsOf(row).includes(f.authorId)) return false;
  return true;
}

/**
 * Whether a comment row survives every filter that was asked for. `af`; the window on `postedAt`; `minKarma`, which
 * leaves out a comment whose karma is hidden or missing (P18) and otherwise needs `baseScore` at least `minKarma`;
 * `authorId` as the comment's named author (P7); `topLevel`, checked only on rows that carry `parentCommentId` (list rows):
 * a root comment on a quick-takes container.
 */
export function recheckComment(row: RawCommentLight | RawCommentList, f: CommentFilters): boolean {
  if (f.af === true && !row.af) return false;
  if (!inWindow(row.postedAt, f.range)) return false;
  if (f.minKarma !== undefined && (row.hideKarma || row.baseScore == null || row.baseScore < f.minKarma)) return false;
  if (f.authorId !== undefined && (row.userId !== f.authorId || ("hideAuthor" in row && row.hideAuthor))) return false;
  if (f.topLevel === true && "parentCommentId" in row && (row.parentCommentId != null || row.shortform !== true)) return false;
  return true;
}
