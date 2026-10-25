// Layer 4. The requests of `get_user` (¶4.7). The main request reads, for one person, the profile (`u`, USER_PROFILE), the top and
// the latest posts (`top`, `recent`: `userPosts` with `excludeEvents`, and the `af` term with `af_only`; `limit + 5` rows each,
// because some rows are removed here, P2), the latest comments (`cm`: `limit + 5` rows of COMMENT_LIST; with `af_only` instead
// `cl`, a light scan of the latest 500, since no comment view filters `af`, §16), the sequences listed on the profile (`seq`, the
// `userProfile` view) and the first raw page of the wiki edits (`we`, the set `get_history {user}` pages, L1). The follow-up
// request carries only the parts that apply: the pinned posts by id (`pin`), the second raw page of the wiki edits when the first
// was full (`we2`), and the hydrate of the AF comments the scan kept (`ch`). Pure: built from the Task 13–15 builders and
// `list_comments`' comment op.
import type { GqlOp } from "../../types";
import { bool, enumTerm, idLit, list } from "../literal";
import { allRecentCommentsOp } from "./list_comments";
import { op } from "./op";
import { postsByIdsOp, revisionsByUserOp, userByIdOp } from "./shared";

/** The post and comment lists read this many rows more than the caller's `limit`, so that removed rows can be replaced (¶4.7 step 2). */
export const POSTS_SPARE = 5;
/** ¶4.7 step 7, ¶3.6 (a declared exception): with `af_only` the comment section scans the person's latest this many comments. */
export const AF_COMMENT_SCAN = 500;
/** ¶4.7 step 2: the sequences on a profile, at most this many (one request). */
export const PROFILE_SEQUENCES_LIMIT = 500;

const POST_ORDERS: readonly ("top" | "new")[] = ["top", "new"];

/**
 * The main request for the person `userId`: `u`, `top`, `recent`, `cm` (or `cl` with `af`), `seq` and `we`, all template
 * `get_user_main` (`get_user_main_af` with `af`).
 */
export function getUserMainOps(userId: string, limit: number, af: boolean): GqlOp[] {
  const template = af ? "get_user_main_af" : "get_user_main";
  const posts = (alias: "top" | "recent", sortedBy: "top" | "new"): GqlOp => op({
    template, alias, root: "posts", view: "userPosts",
    terms: { userId: idLit(userId), sortedBy: enumTerm(sortedBy, POST_ORDERS), excludeEvents: bool(true), af: af ? bool(true) : undefined },
    limit: limit + POSTS_SPARE, select: "{ results { ...POST_CARD } }",
  });
  const comments = af
    ? allRecentCommentsOp("cl", { userId, sortBy: "new" }, { limit: AF_COMMENT_SCAN }, "light")
    : allRecentCommentsOp("cm", { userId, sortBy: "new" }, { limit: limit + POSTS_SPARE }, "list");
  return [
    { ...userByIdOp("u", userId, "...USER_PROFILE"), template },
    posts("top", "top"),
    posts("recent", "new"),
    { ...comments, template },
    op({
      template, alias: "seq", root: "sequences", view: "userProfile", terms: { userId: idLit(userId) }, limit: PROFILE_SEQUENCES_LIMIT,
      select: "{ results { ...SEQ_CARD } }",
    }),
    { ...revisionsByUserOp("we", userId, 0), template },
  ];
}

/**
 * The follow-up request (template `get_user_followup`): `pin` for the pinned posts, `we2` when the first wiki-edit page was full,
 * `ch` for the AF comments to show; only those that apply, so `[]` when none does.
 */
export function getUserFollowupOps(p: {
  userId: string; pinnedIds: readonly string[]; secondWikiPage: boolean; afCommentIds: readonly string[];
}): GqlOp[] {
  const template = "get_user_followup";
  const ops: GqlOp[] = [];
  const pin = postsByIdsOp("pin", p.pinnedIds, "...POST_CARD");
  if (pin !== undefined) ops.push({ ...pin, template });
  if (p.secondWikiPage) ops.push({ ...revisionsByUserOp("we2", p.userId, 1000), template });
  const ids = [...new Set(p.afCommentIds)];
  if (ids.length > 0) {
    ops.push(op({
      template, alias: "ch", root: "comments", view: "default", terms: { commentIds: list(ids.map(idLit)) }, limit: ids.length,
      select: "{ results { ...COMMENT_LIST } }",
    }));
  }
  return ops;
}
