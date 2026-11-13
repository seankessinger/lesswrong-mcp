// Layer 4. The op of `search`'s hydrate (¶4.2 step 7), composed from the shared builders: every hit is re-read live by id,
// because the search index's numbers are stale snapshots and each hit is checked on its live row (§5.7, §5.8). Posts in one
// `exactPostIds` list (POST_CARD), comments one `comment(_id)` alias each (COMMENT_FIELDS; debate turns resolve too, §8.9),
// people in one `usersByUserIds` list (USER_CARD plus the two help texts the local check of step 6 reads), wiki pages one
// `tag(_id)` alias each (TAG_FIELDS), sequences in one `sequenceIds` list (SEQ_CARD). Pure: no services, caches or domain code.
import type { GqlOp, KindValue } from "../../types";
import { commentByIdOp, postsByIdsOp, sequencesByIdsOp, tagByIdOp, usersByIdsOp } from "./shared";

/**
 * A comment hit with its joins and no body, as first_use's: search prints a comment hit by its header and the forum's snippet
 * (`body: undefined`), so its text is never asked for; `parentComment` makes it a list row.
 */
const COMMENT_FIELDS = "...COMMENT_TREE post { ...POST_REF } tag { ...TAG_REF } parentComment { ...COMMENT_REF }";
/** A wiki-page hit as its card prints it (`tagCard` without the excerpt): no description. */
const TAG_FIELDS = "...TAG_REF postCount parentTag { ...TAG_REF }";

const USER_FIELDS = "...USER_CARD howOthersCanHelpMe { markdown } howICanHelpOthers { markdown }";

/** The aliases a hydrate answers under: `p`, `u`, `s` for the lists, `c<k>` and `t<k>` (1-based, distinct ids in hit order) for the single roots. */
export const searchAlias = {
  post: "p",
  comment: (k: number): string => `c${k + 1}`,
  user: "u",
  tag: (k: number): string => `t${k + 1}`,
  sequence: "s",
} as const;

/** The hydrate of `kind`'s hits `ids` (each once, in hit order); `[]` for no ids. */
export function searchHydrateOps(kind: KindValue, ids: readonly string[]): GqlOp[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  switch (kind) {
    case "post": return [postsByIdsOp(searchAlias.post, unique, "...POST_CARD")!];
    case "comment": return unique.map((id, k) => commentByIdOp(searchAlias.comment(k), id, COMMENT_FIELDS));
    case "user": return [usersByIdsOp(searchAlias.user, unique, USER_FIELDS)!];
    case "tag": return unique.map((id, k) => tagByIdOp(searchAlias.tag(k), id, TAG_FIELDS));
    case "sequence": return [sequencesByIdsOp(searchAlias.sequence, unique, "...SEQ_CARD")!];
  }
}
