// Layer 4. The requests of `get_feed` (¶4.15): one template per feed, `feed_<feed>`, built by `feedOp`. The home page's post list
// is the `magic` view with the logged-out settings and never an `af` term (that would switch the pinned set
// to `afSticky`, D2); the Quick Takes are the `shortformFrontpage` comments; `RecentDiscussionFeed` and `AllTagsActivityFeed` are
// non-null roots, so each is its own operation of an array batch (R6, `isolate`), and `RecentDiscussionFeed` takes at most 20
// items and never `af` (it crashes and nulls the response) and never `cutoff: null` (that restarts the feed, Q19, §14.3). The
// fixed-size feeds ignore the page they are given and ask for the most this server requests (`FEED_LIMITS`). Responses are kept
// for `CONFIG.cache.ttlMs` (2 minutes for the feeds, an hour for the Best of list, 30 minutes for the spotlight). Pure: built from
// the literal and op builders.
import { CONFIG } from "../../config";
import { internalError } from "../../errors";
import type { FeedName, GqlOp } from "../../types";
import { bool, dateLit, int, list, obj, str } from "../literal";
import { op, type OpSpec } from "./op";

/** The most items each fixed-size feed asks for in its one request (`recent_discussion`: the forum's own page cap, ¶4.15). */
export const FEED_LIMITS = { popular_comments: 100, this_week: 300, dialogues: 100, best_of: 1000, recent_discussion: 20 } as const;

const POST_CARDS = "{ results { ...POST_CARD } }";
const COMMENT_LISTS = "{ results { ...COMMENT_LIST } }";
const RECENT_COMMENTS = "recentComments(commentsLimit: 3, maxAgeHours: 18) { ...COMMENT_LIST }";
/** ¶4.15: the four item types of the recent-discussion feed that are rendered (§14.3 minimal query, the tag joined so P12 can apply). */
const RECENT_DISCUSSION_SELECTION =
  `{ cutoff endOffset results { type postCommented { ...POST_CARD ${RECENT_COMMENTS} } shortformCommented { ...POST_REF lastCommentedAt user { _id slug displayName } ${RECENT_COMMENTS} } tagDiscussed { ...TAG_REF } tagRevised { _id documentId editedAt changeMetrics tag { ...TAG_REF } } } }`;
const WIKI_ACTIVITY_SELECTION =
  "{ cutoff endOffset results { type tagCreated { ...TAG_REF } tagRevision { _id documentId editedAt changeMetrics user { _id slug displayName } tag { ...TAG_REF } } tagDiscussionComment { ...COMMENT_LIST } } }";
const WINNERS_SELECTION = "{ results { postId reviewYear category reviewRanking post { ...POST_CARD } } }";
const SPOTLIGHT_SELECTION =
  "{ documentType customTitle customSubtitle lastPromotedAt post { ...POST_CARD } sequence { ...SEQ_CARD } tag { ...TAG_CARD } }";

/** What a page of a feed asks for. `limit` is required by the feeds that take one; `cutoff` and `offset` only by the cursor feeds. */
interface FeedPage { limit?: number; offset?: number; cutoff?: string | null }

/** The `magic` terms of the simulated logged-out home page (§14.2): `forum`, personal blogs hidden, the two default tags. */
function frontpageTerms(): Record<string, string> {
  const tags = CONFIG.frontpageTags.map((t) => obj({ tagId: str(t.tagId), tagName: str(t.tagName), filterMode: str("TagDefault") }));
  return { forum: bool(true), filterSettings: obj({ personalBlog: str("Hidden"), tags: list(tags) }) };
}

/**
 * The request of `feed` for `page`. `frontpage`, `recent_discussion`, `quick_takes` and `wiki_activity` need `page.limit`; the
 * other feeds ignore it. `cutoff` is sent only when it is a string, followed by `offset` (default 0); `cutoff: null` means the
 * feed ended and is an internal error, since sending it would restart the feed.
 */
export function feedOp(feed: FeedName, page: FeedPage): GqlOp {
  const template = `feed_${feed}`;
  const ttlMs = CONFIG.cache.ttlMs.feed;
  const need = (): number => {
    if (page.limit === undefined) throw internalError(template, "page.limit is required");
    return page.limit;
  };
  const base = { template, alias: "f", ttlMs } satisfies Pick<OpSpec, "template" | "alias" | "ttlMs">;
  // Cursor feeds: the limit, then `cutoff` and `offset` once a page has a cutoff.
  const cursorArgs = (): Record<string, string> => {
    const limit = int(need());
    if (page.cutoff === null) throw internalError(template, "cutoff null is never sent");
    if (page.cutoff === undefined) return { limit };
    return { limit, cutoff: dateLit(Date.parse(page.cutoff)), offset: int(page.offset ?? 0) };
  };
  switch (feed) {
    case "frontpage":
      return op({ ...base, root: "posts", view: "magic", terms: frontpageTerms(), limit: need(), offset: page.offset ?? 0, select: POST_CARDS });
    case "recent_discussion":
      return op({ ...base, root: "RecentDiscussionFeed", args: cursorArgs(), select: RECENT_DISCUSSION_SELECTION, isolate: true });
    case "popular_comments":
      return op({ ...base, root: "PopularComments", args: { limit: int(FEED_LIMITS.popular_comments) }, select: COMMENT_LISTS });
    case "quick_takes":
      return op({
        ...base, alias: "q", root: "comments", view: "shortformFrontpage", terms: {}, limit: need(), offset: page.offset ?? 0, select: COMMENT_LISTS,
      });
    case "this_week":
      return op({
        ...base, root: "CuratedAndPopularThisWeek", args: { af: bool(false), limit: int(FEED_LIMITS.this_week) }, select: POST_CARDS,
      });
    case "wiki_activity":
      return op({ ...base, root: "AllTagsActivityFeed", args: cursorArgs(), select: WIKI_ACTIVITY_SELECTION, isolate: true });
    case "dialogues":
      return op({ ...base, root: "RecentlyActiveDialogues", args: { limit: int(FEED_LIMITS.dialogues) }, select: POST_CARDS });
    case "best_of":
      return op({
        ...base, root: "reviewWinners", view: "default", terms: {}, limit: FEED_LIMITS.best_of, select: WINNERS_SELECTION,
        ttlMs: CONFIG.cache.ttlMs.winners,
      });
    case "spotlight":
      return op({ ...base, root: "currentSpotlight", select: SPOTLIGHT_SELECTION, ttlMs: CONFIG.cache.ttlMs.spotlight });
  }
}
