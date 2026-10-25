// Layer 3. Normalizes a post row into a `PostRecord` (¶3.8.1). It takes a row that has already passed `postPublic` and
// filters nothing itself except the post's tags (P12). Only the fields of the POST_CARD fragment are read, so stale
// counters the forum may send are never carried (Q50.1, Q50.4, Q50.6, Q50.16). Names and titles stay
// as the forum gives them; the renderer cuts them. Pure: it never throws and never logs.
import { CONFIG } from "../config";
import { oneLine } from "../text/sanitize";
import type { Person, PostRecord, RawPostCard, RawPostFull } from "../types";
import { postStatus } from "./status";
import { postUrl } from "./urls";
import { authorOf, maskTagRef, tagPublic } from "./visibility";

/** Q50.25: a one-line excerpt of at most `max` characters ending `…` when cut; `undefined` for missing or blank text. */
export function excerptOf(plain: string | null | undefined, max: number = CONFIG.render.excerptChars): string | undefined {
  if (plain === null || plain === undefined) return undefined;
  const line = oneLine(plain, max);
  return line === "" ? undefined : line;
}

/** Under sort `active` and in `recent_discussion` (¶3.8.1, row 5): the last comment's date, or `null` for a post nobody has commented on (its posting date counts). */
export function lastCommentOf(row: RawPostCard): string | null {
  return row.commentCount === 0 || row.lastCommentedAt == null || row.lastCommentedAt === row.postedAt ? null : row.lastCommentedAt;
}

/** P7: a `hideAuthor` post names nobody; otherwise the owner, then each coauthor, as `authorOf` names them. */
function authorsOf(raw: RawPostCard | RawPostFull): Person[] {
  if (raw.hideAuthor) return [{ kind: "none", why: "author not publicly visible" }];
  return [authorOf(raw.user, { hideAuthor: false }), ...(raw.coauthors ?? []).map((u) => authorOf(u, { hideAuthor: false }))];
}

/** P12, Q50.10: the public tags with their `tagRelevance` number (0 when the forum gave none), high first; ties keep the forum's order. */
function tagsOf(raw: RawPostCard | RawPostFull): PostRecord["tags"] {
  const tags: PostRecord["tags"] = [];
  for (const t of raw.tags) {
    if (!tagPublic(t)) continue;
    const ref = maskTagRef(t);
    if (!ref.hidden) tags.push({ tag: ref, relevance: raw.tagRelevance?.[t._id] ?? 0 });
  }
  return tags.sort((a, b) => b.relevance - a.relevance);
}

/**
 * ¶3.8.1: the record of a post. `afKarma` is `null` on a non-AF post, whose `afBaseScore` means nothing (¶3.5). The
 * excerpt is read, only when asked for, from the `contents { plaintextDescription }` of a `POST_CARD_EXCERPT` row (a
 * `RawPostFull`'s contents never carries that key).
 */
export function toPostRecord(raw: RawPostCard | RawPostFull, opts?: { excerpt?: boolean }): PostRecord {
  const record: PostRecord = {
    id: raw._id,
    title: raw.title,
    url: postUrl(raw),
    authors: authorsOf(raw),
    postedAt: raw.postedAt,
    postedMs: Date.parse(raw.postedAt),
    karma: raw.baseScore,
    votes: raw.voteCount,
    af: raw.af,
    afKarma: raw.af ? raw.afBaseScore : null,
    commentCount: raw.commentCount,
    afCommentCount: raw.afCommentCount,
    status: postStatus(raw),
    tags: tagsOf(raw),
  };
  if (raw.lastCommentedAt != null) record.lastCommentedAt = raw.lastCommentedAt;
  if (opts?.excerpt && raw.contents != null && "plaintextDescription" in raw.contents) {
    const excerpt = excerptOf(raw.contents.plaintextDescription);
    if (excerpt !== undefined) record.excerpt = excerpt;
  }
  return record;
}
