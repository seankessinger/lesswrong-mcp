// Layer 4. The ops of `find`'s one GraphQL request (¶4.1 step 3), composed from the shared builders: the post hits by id and
// the slug fallback per post item, the user hits and up to three slug guesses per user item, each tag hit by `tag(_id)` (which
// keeps the wiki-only pages that `tagsByTagIds` drops, Q59) with the tag and lens lookups of each tag item's slug, the sequence
// hits, the collections listing when it is not cached, and the `commented_on` post by id or by slug. A continuation re-reads
// its candidates with the same ops (ids only). Pure: no services, caches or domain code.
import type { GqlOp } from "../../types";
import {
  collectionsListingOp, postByIdOp, postsByIdsOp, postsBySlugOp, sequencesByIdsOp, tagByIdOp, tagBySlugOp, tagPreviewOp, usersByIdsOp,
  userBySlugOp,
} from "./shared";

export interface FindHydratePlan {
  postIds: string[];
  postSlugs: string[];
  userIds: string[];
  userSlugs: string[];
  tagIds: string[];
  tagSlugs: string[];
  sequenceIds: string[];
  collections: boolean;
  commentedOn?: { id?: string; slug?: string };
}

/** The k-th (0-based) alias of a family: `ps`, `ps2`, `ps3`, … */
const nth = (base: string, k: number): string => (k === 0 ? base : `${base}${k + 1}`);

/** The aliases of the k-th (0-based) entry of `postSlugs`, `userSlugs`, distinct `tagIds` and `tagSlugs`. */
export const findAlias = {
  postSlug: (k: number): string => nth("ps", k),
  userSlug: (k: number): string => `ug${k + 1}`,
  tagId: (k: number): string => `t${k + 1}`,
  tagSlug: (k: number): string => nth("ts", k),
  tagPreview: (k: number): string => nth("tp", k),
} as const;

/**
 * The hydrate ops in this order, each part only when it has something to read: `p`, `ps…`, `u`, `ug1…`, `t1…` (one per distinct
 * tag id), `ts…`/`tp…` (a pair per tag slug), `s`, `col`, then `co` (the `commented_on` id) and `cs` (its slug).
 */
export function findHydrateOps(plan: FindHydratePlan): GqlOp[] {
  const ops: GqlOp[] = [];
  const push = (o: GqlOp | undefined): void => {
    if (o !== undefined) ops.push(o);
  };
  push(postsByIdsOp("p", plan.postIds, "...POST_CARD"));
  plan.postSlugs.forEach((slug, k) => push(postsBySlugOp(findAlias.postSlug(k), slug, "...POST_CARD")));
  push(usersByIdsOp("u", plan.userIds, "...USER_CARD"));
  plan.userSlugs.forEach((slug, k) => push(userBySlugOp(findAlias.userSlug(k), slug, "...USER_CARD")));
  [...new Set(plan.tagIds)].forEach((id, k) => push(tagByIdOp(findAlias.tagId(k), id, "...TAG_CARD")));
  plan.tagSlugs.forEach((slug, k) => {
    push(tagBySlugOp(findAlias.tagSlug(k), slug, "...TAG_CARD"));
    push(tagPreviewOp(findAlias.tagPreview(k), slug, "tag { ...TAG_CARD } lens { ...MDOC_REF }"));
  });
  push(sequencesByIdsOp("s", plan.sequenceIds, "...SEQ_CARD"));
  if (plan.collections) push(collectionsListingOp("col"));
  if (plan.commentedOn?.id !== undefined) push(postByIdOp("co", plan.commentedOn.id, "...POST_CARD"));
  if (plan.commentedOn?.slug !== undefined) push(postsBySlugOp("cs", plan.commentedOn.slug, "...POST_CARD"));
  return ops;
}
