// Layer 4. The ops of `get_post`'s requests after the first (¶4.3 steps 3–4), composed from the shared builders. Request 2
// is one array batch of the parts the post needs, each only when asked for, in this order: its review comments (`rv`), the
// debate turns of the 6 old-style debate posts (`dt`), its HTML (`h`, when a dialogue or P15 needs it), the chapters of its
// canonical sequence in the view's order (`ch`, §11.2), and the collections listing when it is not cached (`col`). Request 3
// reads the chapters of the sequence next to it in its collection, to name the neighbour at a boundary. Pure: no services,
// caches or domain code.
import type { GqlOp, PublicPostId, PublicSequenceId } from "../../types";
import { collectionsListingOp, debateTurnsOp, postByIdOp, reviewsOp, sequenceChaptersOp } from "./shared";

/** The chapter fields both requests read: enough to order the posts and name a neighbour. */
const CHAPTER_FIELDS = "_id number posts { ...POST_REF postedAt }";

/** Request 2 of `get_post`: `rv`, `dt`, `h`, `ch`, `col`, each only when asked for; `[]` when nothing is. */
export function getPostRequest2Ops(p: {
  postId: PublicPostId; reviews: boolean; debate: boolean; html: boolean; sequenceId?: PublicSequenceId; listing: boolean;
}): GqlOp[] {
  const ops: GqlOp[] = [];
  if (p.reviews) ops.push(reviewsOp("rv", p.postId));
  if (p.debate) ops.push(debateTurnsOp("dt", p.postId, "...COMMENT_REF contents { markdown }"));
  if (p.html) ops.push(postByIdOp("h", p.postId, "_id contents { html }"));
  if (p.sequenceId !== undefined) ops.push(sequenceChaptersOp("ch", p.sequenceId, CHAPTER_FIELDS));
  if (p.listing) ops.push(collectionsListingOp("col"));
  return ops;
}

/** Request 3 of `get_post`: the chapters of an adjacent sequence (a `Book.sequences` row of the listing, P17), under `alias`. */
export function neighbourChaptersOp(alias: string, sequenceId: PublicSequenceId): GqlOp {
  return sequenceChaptersOp(alias, sequenceId, CHAPTER_FIELDS);
}
