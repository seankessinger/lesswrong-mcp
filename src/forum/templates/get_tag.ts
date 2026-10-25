// Layer 4. The two requests of `get_tag` (¶4.8). Request 1 resolves and checks the page in one operation through the aliases of
// ¶3.1.2 with the selections the page needs: a slug reads `tagBySlug` (old slugs and Arbital ids) and `TagPreview` (lens slugs,
// with the lens text and the lens's own summaries, Q132); an id reads `tag` and `multiDocument` (lenses and summaries, with the
// page or the parent lens joined, so a lens or summary id needs no further request, C3, P17); a bare 17-character string sends
// all four. Request 2, for the confirmed page: its tagged posts (`tagRelevance` with the Required filter, R7, Q55; `limit + 5`
// rows and the forum's count), the ids of its discussion comments (at most 200), one `tag(_id)` lookup per Arbital page (P12,
// C3) and, for a core tag, the grouping as its own isolated operation (R6). Pure: built from the shared builders.
import { internalError } from "../../errors";
import type { GqlOp, ParsedRef, PublicTagId } from "../../types";
import { bool, enumTerm, idLit, list, obj, str } from "../literal";
import { op } from "./op";
import { coreGroupingOp, multiDocumentByIdOp, tagByIdOp, tagBySlugOp, tagPreviewOp, tagRefsByIdOps } from "./shared";

/** The ¶4.8 `sortedBy` values of the tag's post list. */
export type TagPostsOrder = "top" | "relevance" | "new" | "old";

const ORDERS: readonly TagPostsOrder[] = ["top", "relevance", "new", "old"];
/** ¶4.8 step 2: the discussion count is exact below this many comments, else "200+". */
export const DISCUSSION_LIMIT = 200;
/** The posts request reads this many rows more than the caller's `limit`, so that re-checked rows can be replaced (Q55). */
export const POSTS_SPARE = 5;

const TEXT = "contents { markdown version editedAt }";
const SUMMARIES = "summaries { _id deleted tabTitle contents { markdown } }";
const MDOC_FIELDS = `...MDOC_REF ${TEXT} ${SUMMARIES} parentTag { ...TAG_FULL } parentLens { ${TEXT} ${SUMMARIES} parentTag { ...TAG_FULL } }`;
const PREVIEW_FIELDS = `tag { ...TAG_FULL } lens { ...MDOC_REF ${TEXT} } ${SUMMARIES}`;

/** Request 1: id → `t`, `m` (`get_tag_req1_id`); slug → `a`, `b` (`get_tag_req1_slug`); a bare 17-character string → all four. */
export function getTagRequest1Ops(ref: ParsedRef): GqlOp[] {
  const byId = (): GqlOp[] => [
    { ...tagByIdOp("t", ref.value, "...TAG_FULL"), template: "get_tag_req1_id" },
    { ...multiDocumentByIdOp("m", ref.value, MDOC_FIELDS), template: "get_tag_req1_id" },
  ];
  const bySlug = (): GqlOp[] => [
    { ...tagBySlugOp("a", ref.value, "...TAG_FULL"), template: "get_tag_req1_slug" },
    { ...tagPreviewOp("b", ref.value, PREVIEW_FIELDS), template: "get_tag_req1_slug" },
  ];
  switch (ref.form) {
    case "id": return byId();
    case "slug": return bySlug();
    case "idOrSlug": return [...byId(), ...bySlug()];
    default: throw internalError("get_tag_req1", `a tag given as ${ref.form}`);
  }
}

/**
 * Request 2 for the confirmed page `tagId`: `p` (its tagged posts in `sortedBy` order, `af` when asked, `limit + 5` rows with
 * the forum's count) and `dc` (the discussion comment ids), both `get_tag_req2_op1`; `ar1`…`arN`, one `tag(_id)` per Arbital
 * page id; and `g`, the isolated core grouping, only when `core`.
 */
export function getTagRequest2Ops(p: {
  tagId: PublicTagId; sortedBy: TagPostsOrder; af: boolean; limit: number; core: boolean; arbitalIds: readonly string[];
}): GqlOp[] {
  const template = "get_tag_req2_op1";
  const posts = op({
    template, alias: "p", root: "posts", view: "tagRelevance",
    terms: {
      tagId: idLit(p.tagId), sortedBy: enumTerm(p.sortedBy, ORDERS), excludeEvents: bool(true), af: p.af ? bool(true) : undefined,
      filterSettings: obj({ tags: list([obj({ tagId: idLit(p.tagId), filterMode: str("Required") })]) }),
    },
    limit: p.limit + POSTS_SPARE, enableTotal: true, select: "{ results { ...POST_CARD contents { plaintextDescription } } totalCount }",
  });
  const discussion = op({
    template, alias: "dc", root: "comments", view: "tagDiscussionComments", terms: { tagId: idLit(p.tagId) }, limit: DISCUSSION_LIMIT,
    select: "{ results { _id } }", publicSubject: "tag",
  });
  return [posts, discussion, ...tagRefsByIdOps("ar", p.arbitalIds), ...(p.core ? [coreGroupingOp("g", p.tagId)] : [])];
}
