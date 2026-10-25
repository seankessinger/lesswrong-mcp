// Layer 4. The subject request of `get_comments` (¶4.4 step 1), composed from the shared resolution builders with the bare
// aliases `ids/resolve.readResolution` reads: the post with `...POST_CARD hideCommentKarma` (its header fields and its
// hidden-karma switch), the wiki page (a tag, or a lens or summary that stands for its page), the comment with `...COMMENT_LIST`
// (its post and tag joins are the check of its discussion's subject, P1, P17), and the person, by id or slug. A slug resolves
// and checks in the same request (¶3.1.2). Pure: refs in, ops out; no services, caches or domain code.
import { internalError } from "../../errors";
import type { GqlOp, ParsedRef } from "../../types";
import {
  commentByIdOp, commentByLegacyIdOp, multiDocumentByIdOp, postByIdOp, postByLegacyIdOp, postsBySlugOp, tagByIdOp, tagBySlugOp,
  tagPreviewOp, userByIdOp, userBySlugOp,
} from "./shared";

const TEMPLATE = "get_comments_subject";
const POST_FIELDS = "...POST_CARD hideCommentKarma";
const COMMENT_FIELDS = "...COMMENT_LIST";
const TAG_FIELDS = "...TAG_CARD";
const MDOC_FIELDS = "...MDOC_REF";
const PREVIEW_FIELDS = `tag { ${TAG_FIELDS} } lens { ${MDOC_FIELDS} } summaries { _id deleted tabTitle }`;
/**
 * The display name too, so that a message can name the person; the karma too, so that the ¶3.7 echo of this call and of every
 * later tool that finds the person in the resolution cache shows it (a namesake is visible at once).
 */
const USER_FIELDS = "_id slug displayName karma";

/** A form no parameter of `get_comments` parses to (a collection, a word, an item): a bug of the caller. */
function unsupported(ref: ParsedRef): never {
  throw internalError(TEMPLATE, `a ${ref.kind} given as ${ref.form}`);
}

function postOps(ref: ParsedRef): GqlOp[] {
  switch (ref.form) {
    case "id": return [postByIdOp("p", ref.value, POST_FIELDS)];
    case "slug": return [postsBySlugOp("s", ref.value, POST_FIELDS)];
    case "idOrSlug": return [postByIdOp("p", ref.value, POST_FIELDS), postsBySlugOp("s", ref.value, POST_FIELDS)];
    case "legacy": return [postByLegacyIdOp("l", ref.value, POST_FIELDS)];
    default: return unsupported(ref);
  }
}

function tagOps(ref: ParsedRef): GqlOp[] {
  const byId = (): GqlOp[] => [tagByIdOp("t", ref.value, TAG_FIELDS), multiDocumentByIdOp("m", ref.value, MDOC_FIELDS)];
  const bySlug = (): GqlOp[] => [tagBySlugOp("a", ref.value, TAG_FIELDS), tagPreviewOp("b", ref.value, PREVIEW_FIELDS)];
  switch (ref.form) {
    case "id": return byId();
    case "slug": return bySlug();
    case "idOrSlug": return [...byId(), ...bySlug()];
    default: return unsupported(ref);
  }
}

function commentOps(ref: ParsedRef): GqlOp[] {
  switch (ref.form) {
    case "id": return [commentByIdOp("c", ref.value, COMMENT_FIELDS)];
    case "legacy": return [commentByLegacyIdOp("c", ref.value, COMMENT_FIELDS)];
    default: return unsupported(ref);
  }
}

function userOps(ref: ParsedRef): GqlOp[] {
  switch (ref.form) {
    case "id": return [userByIdOp("i", ref.value, USER_FIELDS)];
    case "slug": return [userBySlugOp("u", ref.value, USER_FIELDS)];
    case "idOrSlug": return [userByIdOp("i", ref.value, USER_FIELDS), userBySlugOp("u", ref.value, USER_FIELDS)];
    default: return unsupported(ref);
  }
}

/**
 * The ops of `get_comments`' subject request, in the order post, tag, comment, user, each only when its ref is given: post `id`
 * → `p`, `slug` → `s`, `idOrSlug` → `p` and `s`, `legacy` → `l`; tag `id` → `t` and `m`, `slug` → `a` and `b`, `idOrSlug` → all
 * four; comment `id` or `legacy` → `c`; user `id` → `i`, `slug` → `u`, `idOrSlug` → `i` and `u`.
 */
export function subjectOps(target: { post?: ParsedRef; tag?: ParsedRef; comment?: ParsedRef; user?: ParsedRef }): GqlOp[] {
  return [
    ...(target.post === undefined ? [] : postOps(target.post)),
    ...(target.tag === undefined ? [] : tagOps(target.tag)),
    ...(target.comment === undefined ? [] : commentOps(target.comment)),
    ...(target.user === undefined ? [] : userOps(target.user)),
  ];
}
