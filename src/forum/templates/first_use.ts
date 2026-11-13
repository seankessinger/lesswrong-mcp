// Layer 4. The GraphQL requests of `first_use` (¶4.12). Request 1, the hydrate (step 5), reads the checked candidates and the
// earlier-dated rejected hits by id: the posts in one `exactPostIds` alias `p` with POST_CARD, each comment in its own `c<i>`
// alias with COMMENT_TREE and its `post` and `tag` joins, which name where it is (P1), and no body (step 5: the phrase was
// checked on the hit's text). The `parentComment` join, which step 5's selection lacks, stays: `toCommentRecord` tells a list
// row by that key, and only a list row gets its place from the joins (without it a visible comment would read as one on a
// hidden post). So the row is the `RawCommentList` that `placeOf` reads, without the body that COMMENT_LIST would also fetch.
// It is also the visibility check (P17, R10): request 2, the history lists (step 6), is built only from the `PublicDocId`s it
// confirms: per candidate `pub<key>`, the light rows at or before publication + 5 s (its first row is the as-published version,
// §7.3) and `aft<key>`, the REV_ROW list after it. Pure: built from the shared builders.
import { isoMs } from "../../text/dates";
import type { GqlOp, PublicDocId } from "../../types";
import { commentByIdOp, postsByIdsOp, revisionListOp } from "./shared";

const HYDRATE = "first_use_hydrate";
const HISTORY = "first_use_history";
/** §7.3: a publish revision lands within 5 s of `postedAt`; the as-published list ends 1 ms after that (`before` is exclusive). */
const PUBLISHED_WITHIN_MS = 5_000;
/** ¶4.12 step 6: the as-published list's page size. */
export const AS_PUBLISHED_LIMIT = 50;
const AS_PUBLISHED_FIELDS = "_id version editedAt updateType";
/** Step 5: a comment with its joins and no body; `parentComment` makes it a list row (see above). */
const COMMENT_FIELDS = "...COMMENT_TREE post { ...POST_REF } tag { ...TAG_REF } parentComment { ...COMMENT_REF }";

/** Request 1 (template `first_use_hydrate`): `p` for the posts (none for no ids), then `c1`…`cN` for the comments, in the order given. */
export function firstUseHydrateOps(postIds: readonly string[], commentIds: readonly string[]): GqlOp[] {
  const ops: GqlOp[] = [];
  const posts = postsByIdsOp("p", postIds, "...POST_CARD");
  if (posts !== undefined) ops.push({ ...posts, template: HYDRATE });
  [...new Set(commentIds)].forEach((id, i) => ops.push({ ...commentByIdOp(`c${i + 1}`, id, COMMENT_FIELDS), template: HYDRATE }));
  return ops;
}

/** Request 2 (template `first_use_history`): `pub<key>` and `aft<key>` for each candidate, in the order given. */
export function firstUseHistoryOps(candidates: readonly { key: string; docId: PublicDocId; postedMs: number }[]): GqlOp[] {
  return candidates.flatMap(({ key, docId, postedMs }) => [
    {
      ...revisionListOp(`pub${key}`, docId, "contents", {
        before: isoMs(postedMs + PUBLISHED_WITHIN_MS + 1), limit: AS_PUBLISHED_LIMIT, enableTotal: true, fields: AS_PUBLISHED_FIELDS,
      }),
      template: HISTORY,
    },
    { ...revisionListOp(`aft${key}`, docId, "contents", { after: isoMs(postedMs + PUBLISHED_WITHIN_MS), enableTotal: true }), template: HISTORY },
  ]);
}
