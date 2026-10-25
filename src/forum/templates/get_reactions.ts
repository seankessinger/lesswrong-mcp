// Layer 4. The requests of `get_reactions` (¶4.14). The item request asks for the votes of one post (`p`), comment (`c`), wiki page
// (`t`) or lens (`m`) with the references that name it (`REACTION_FIELDS`), so it is also the item's visibility check (P12, P17);
// a tag id is asked as a page and as a lens in the same request. A page's own likers are read from its `extendedScore`, never
// from `Tag.usersWhoLiked`, which adds the likes on its lenses (§10.3, L10), and `allVotes` and `currentUserVote` are never
// selected (§4.9). The reactor request (`ids`) names the people of the reactions and likes shown, by id, in one list (§9.8).
// Pure: built from the shared builders.
import type { GqlOp } from "../../types";
import { commentByIdOp, multiDocumentByIdOp, postByIdOp, tagByIdOp, usersByIdsOp } from "./shared";

/** The selection written inside `result { … }` for each kind of item (¶4.14 Behaviour). */
export const REACTION_FIELDS: Readonly<{ post: string; comment: string; tag: string; mdoc: string }> = Object.freeze({
  post: "...POST_REF baseScore voteCount afBaseScore afVoteCount extendedScore user { _id slug displayName }",
  comment: "...COMMENT_REF baseScore voteCount afBaseScore afVoteCount extendedScore post { ...POST_REF } tag { ...TAG_REF }",
  tag: "...TAG_REF baseScore voteCount extendedScore",
  mdoc: "...MDOC_REF baseScore voteCount extendedScore",
});

/** The request for one item by id: alias `p` (post), `c` (comment), `t` (wiki page) or `m` (lens or summary). */
export function reactionItemOp(kind: "post" | "comment" | "tag" | "lens", id: string): GqlOp {
  switch (kind) {
    case "post": return postByIdOp("p", id, REACTION_FIELDS.post);
    case "comment": return commentByIdOp("c", id, REACTION_FIELDS.comment);
    case "tag": return tagByIdOp("t", id, REACTION_FIELDS.tag);
    case "lens": return multiDocumentByIdOp("m", id, REACTION_FIELDS.mdoc);
  }
}

/** The people behind `ids` (alias `ids`, each once, in first-seen order); `undefined` for none, since an empty list is never sent (R3). */
export function reactorIdsOp(ids: readonly string[]): GqlOp | undefined {
  return usersByIdsOp("ids", ids, "_id slug displayName");
}
