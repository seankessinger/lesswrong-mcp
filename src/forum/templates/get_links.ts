// Layer 4. The requests of `get_links` (¶4.13). Incoming links to a post are `pingbackPosts` (alias `i`, the cards of a page by
// offset, or `il`, the light rows of the whole list, which `new` and `old` sort locally); incoming links to a wiki page are its
// `pingbackWikiPages` (`w`) and `pingbackLensPages` (`lp`). The outgoing links are read from the current text, never from the
// stored `pingbacks` field (Q103, Q50.13): `linkBodyOp` asks for the text (`pb`, `tb` or `lb`), and `linkResolutionOps` resolves
// every forum link it holds in one request (Q131): post ids (`p`), post slugs (`ps<i>`), comments (`c<i>`), tags by current slug
// (`ts`), then by older slug (`tb<i>`) and as lenses (`tp<i>`), people (`u<i>`), sequences (`s<i>`) and the incoming page's
// posts (`h`, the hydrate of a `new` or `old` page). Aliases are numbered from 1 within each kind; a kind with nothing to ask
// has no alias. Pure: built from the literal, op and shared builders.
import { internalError } from "../../errors";
import type { GqlOp } from "../../types";
import { bool, idLit, list, str } from "../literal";
import { op } from "./op";
import {
  commentByIdOp, multiDocumentByIdOp, postByIdOp, postsByIdsOp, postsBySlugOp, sequenceByIdOp, tagByIdOp, tagBySlugOp, tagPreviewOp,
  userBySlugOp,
} from "./shared";

/** ¶4.13: the wiki-page backlinks (`pingbackWikiPages`, `pingbackLensPages`) are read up to this many rows each. */
const BACKLINKS_LIMIT = 500;

const INCOMING_POST = "get_links_incoming_post";
const INCOMING_TAG = "get_links_incoming_tag";
const BODY = "get_links_body";
const RESOLUTION = "get_links_resolution";

/**
 * The posts whose text links to `postId`, in the forum's order (karma, high first): `i` with `POST_CARD` rows for a page read by
 * offset, `il` with `POST_LIGHT` rows for the whole list. `af` adds the `af: true` term; `totalCount` comes only with `enableTotal`.
 */
export function incomingPostsOp(
  postId: string,
  af: boolean,
  page: { limit: number; offset?: number; enableTotal?: true },
  fields: "card" | "light",
): GqlOp {
  const card = fields === "card";
  return op({
    template: INCOMING_POST, alias: card ? "i" : "il", root: "posts", view: "pingbackPosts",
    terms: { postId: idLit(postId), af: af ? bool(true) : undefined },
    limit: page.limit, offset: page.offset, enableTotal: page.enableTotal,
    select: `{ results { ...${card ? "POST_CARD" : "POST_LIGHT"} }${page.enableTotal ? " totalCount" : ""} }`,
  });
}

/** `[w, lp]`: the wiki pages whose text links to the page `tagId`, and the lens pages that do (their page joined). */
export function incomingTagOps(tagId: string): GqlOp[] {
  return [
    op({
      template: INCOMING_TAG, alias: "w", root: "tags", view: "pingbackWikiPages", terms: { tagId: idLit(tagId) },
      limit: BACKLINKS_LIMIT, select: "{ results { ...TAG_CARD } }",
    }),
    op({
      template: INCOMING_TAG, alias: "lp", root: "multiDocuments", view: "pingbackLensPages", terms: { documentId: idLit(tagId) },
      limit: BACKLINKS_LIMIT, select: "{ results { ...MDOC_REF } }",
    }),
  ];
}

/** The current text of a post (`pb`), a wiki page (`tb`) or a lens (`lb`) with its version. */
export function linkBodyOp(target: { post?: string; tag?: string; lens?: string }): GqlOp {
  const body = (o: GqlOp): GqlOp => ({ ...o, template: BODY });
  if (target.post !== undefined) return body(postByIdOp("pb", target.post, "_id contents { version markdown }"));
  if (target.tag !== undefined) return body(tagByIdOp("tb", target.tag, "_id description { version markdown }"));
  if (target.lens !== undefined) return body(multiDocumentByIdOp("lb", target.lens, "_id contents { version markdown }"));
  throw internalError(BODY, "no post, tag or lens to read");
}

/** The forum links of a text, by kind, in order of first appearance (each list already capped by the caller). */
export interface LinkTargets {
  postIds: readonly string[];
  postSlugs: readonly string[];
  commentIds: readonly string[];
  /** Looked up by current slug in one alias. */
  tagSlugs: readonly string[];
  /** Looked up again by older slug (`tagBySlug`), one alias each. */
  tagOldSlugs: readonly string[];
  /** Looked up again as lens slugs (`TagPreview`), one alias each. */
  lensSlugs: readonly string[];
  userSlugs: readonly string[];
  sequenceIds: readonly string[];
  /** The incoming posts of a page to print, hydrated beside the links. */
  hydratePostIds: readonly string[];
}

/**
 * The one request that resolves every forum link of a text (and hydrates the incoming page), in the order `p`, `ps<i>`, `c<i>`,
 * `ts`, `tb<i>`, `tp<i>`, `u<i>`, `s<i>`, `h`, each only when its list is not empty.
 */
export function linkResolutionOps(links: LinkTargets): GqlOp[] {
  const resolution = (o: GqlOp): GqlOp => ({ ...o, template: RESOLUTION });
  const ops: GqlOp[] = [];
  const posts = postsByIdsOp("p", links.postIds, "...POST_CARD");
  if (posts !== undefined) ops.push(resolution(posts));
  links.postSlugs.forEach((slug, i) => ops.push(resolution(postsBySlugOp(`ps${i + 1}`, slug, "...POST_CARD"))));
  links.commentIds.forEach((id, i) => ops.push(resolution(commentByIdOp(`c${i + 1}`, id, "...COMMENT_REF post { ...POST_REF } tag { ...TAG_REF }"))));
  const tagSlugs = [...new Set(links.tagSlugs)];
  if (tagSlugs.length > 0) {
    ops.push(op({
      template: RESOLUTION, alias: "ts", root: "tags", view: "tagsBySlugs", terms: { slugs: list(tagSlugs.map((slug) => str(slug, "slug"))) },
      limit: tagSlugs.length, select: "{ results { ...TAG_REF } }",
    }));
  }
  links.tagOldSlugs.forEach((slug, i) => ops.push(resolution(tagBySlugOp(`tb${i + 1}`, slug, "...TAG_REF"))));
  links.lensSlugs.forEach((slug, i) => ops.push(resolution(tagPreviewOp(`tp${i + 1}`, slug, "tag { ...TAG_REF } lens { ...MDOC_REF }"))));
  links.userSlugs.forEach((slug, i) => ops.push(resolution(userBySlugOp(`u${i + 1}`, slug, "_id slug displayName deleted"))));
  links.sequenceIds.forEach((id, i) => ops.push(resolution(sequenceByIdOp(`s${i + 1}`, id, "...SEQ_REF"))));
  const hydrate = postsByIdsOp("h", links.hydratePostIds, "...POST_CARD");
  if (hydrate !== undefined) ops.push(resolution(hydrate));
  return ops;
}
