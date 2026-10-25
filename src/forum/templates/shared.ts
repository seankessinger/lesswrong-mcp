// Layer 4. The query templates that more than one tool sends (¶3.1.2 resolution, ¶4.0 COLLECTIONS_LISTING, the by-id hydrates,
// comment and tag forests, debate turns, reviews, chapters, revision lists and texts, a person's wiki edits and the core-tag
// grouping). Every function renders its operation through `op()`, so the guard (forum/forbidden.ts) vets it as it is built;
// `fields` is the selection written inside `result { … }` or `results { … }`, and the texts are exactly those the tests assert,
// which are validated against the forum's real schema (C2). Ids go through `idLit`, slugs and dates through `str`; a value that
// no caller should be able to produce (an empty slug, a malformed legacy id or date bound) is an internal error naming the
// template. Templates that need a confirmed-public subject (P17) take a `Public*Id`, which only `CallContext.confirmPublic`
// makes, and carry it as `publicSubject`. Pure: no services, caches or domain code (the templates rule of the import test).
import { CONFIG } from "../../config";
import { internalError } from "../../errors";
import type { GqlOp, PublicDocId, PublicPostId, PublicRevisionId, PublicSequenceId, PublicTagId } from "../../types";
import { enumTerm, idLit, int, list, str } from "../literal";
import { op, type OpSpec } from "./op";

// Explicit limits (R2) of the ¶4 templates that have no entry in CONFIG.
/** A slug can name two posts; two rows are enough to tell the caller to choose (¶4.1 step 1). */
const SLUG_POST_LIMIT = 2;
/** The forum has five collections (§11.5); ten rows leave room. */
const COLLECTIONS_LIMIT = 10;
const DEBATE_TURNS_LIMIT = 500;
const CHAPTERS_LIMIT = 500;
const REVIEWS_LIMIT = 50;
/** The largest group under one core tag has 461 tags (Q68); a grouping that comes back this long may be longer still. */
export const CORE_GROUPING_LIMIT = 500;

const LEGACY_ID_RE = /^[0-9a-z]+$/;
const DATE_BOUND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REVISION_FIELDS = ["contents", "description"] as const;

const resultOf = (fields: string): string => `{ result { ${fields} } }`;
const resultsOf = (fields: string): string => `{ results { ${fields} } }`;

function slugLit(template: string, slug: string): string {
  if (slug === "") throw internalError(template, "empty slug");
  return str(slug, "slug");
}

function legacyIdLit(template: string, legacyId: string): string {
  if (!LEGACY_ID_RE.test(legacyId)) throw internalError(template, "not a base-36 legacy id");
  return str(legacyId, "legacy id");
}

function dateBoundLit(template: string, bound: string): string {
  if (!DATE_BOUND_RE.test(bound)) throw internalError(template, "not a YYYY-MM-DDTHH:MM:SS.SSSZ date");
  return str(bound, "date");
}

/** A single root answered as `{ result { … } }`, selected by `_id`. */
function byId(template: string, alias: string, root: string, id: string, fields: string, extra: Partial<OpSpec> = {}): GqlOp {
  return op({ template, alias, root, terms: { _id: idLit(id) }, select: resultOf(fields), ...extra });
}

/** A list root read through one view with one term, answered as `{ results { … } }`. */
function byView(template: string, alias: string, root: string, view: string, terms: OpSpec["terms"], limit: number, fields: string): GqlOp {
  return op({ template, alias, root, view, terms, limit, select: resultsOf(fields) });
}

/** The distinct ids in first-seen order. */
function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

// ¶3.1.2 resolution

export function postByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("post_by_id", alias, "post", id, fields, { allowNull: true });
}

export function postsBySlugOp(alias: string, slug: string, fields: string): GqlOp {
  return byView("posts_by_slug", alias, "posts", "slugPost", { slug: slugLit("posts_by_slug", slug) }, SLUG_POST_LIMIT, fields);
}

export function postByLegacyIdOp(alias: string, legacyId: string, fields: string): GqlOp {
  return byView("post_by_legacy_id", alias, "posts", "legacyIdPost", { legacyId: legacyIdLit("post_by_legacy_id", legacyId) }, 1, fields);
}

export function commentByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("comment_by_id", alias, "comment", id, fields, { allowNull: true });
}

export function commentByLegacyIdOp(alias: string, legacyId: string, fields: string): GqlOp {
  return byView("comment_by_legacy_id", alias, "comments", "legacyIdComment", { legacyId: legacyIdLit("comment_by_legacy_id", legacyId) }, 1, fields);
}

export function userBySlugOp(alias: string, slug: string, fields: string): GqlOp {
  return op({ template: "user_by_slug", alias, root: "GetUserBySlug", args: { slug: slugLit("user_by_slug", slug) }, select: `{ ${fields} }` });
}

export function userByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("user_by_id", alias, "user", id, fields);
}

export function tagBySlugOp(alias: string, slug: string, fields: string): GqlOp {
  return byView("tag_by_slug", alias, "tags", "tagBySlug", { slug: slugLit("tag_by_slug", slug) }, 1, fields);
}

/** `TagPreview` answers a tag, a lens and the summaries of both; `inner` is the whole selection inside its braces. */
export function tagPreviewOp(alias: string, slug: string, inner: string): GqlOp {
  return op({ template: "tag_preview", alias, root: "TagPreview", args: { slug: slugLit("tag_preview", slug) }, select: `{ ${inner} }` });
}

export function tagByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("tag_by_id", alias, "tag", id, fields);
}

export function multiDocumentByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("multi_document_by_id", alias, "multiDocument", id, fields);
}

export function sequenceByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("sequence_by_id", alias, "sequence", id, fields, { allowNull: true });
}

export function collectionByIdOp(alias: string, id: string, fields: string): GqlOp {
  return byId("collection_by_id", alias, "collection", id, fields);
}

// ¶4.0 COLLECTIONS_LISTING

const COLLECTIONS_FIELDS = "_id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } }";

export function collectionsListingOp(alias = "col"): GqlOp {
  return byView("collections_listing", alias, "collections", "default", {}, COLLECTIONS_LIMIT, COLLECTIONS_FIELDS);
}

// By-id hydrates (R3, R10, R11): never an empty list, never enableTotal, and an explicit limit equal to the de-duplicated count

/** `undefined` for no ids: an empty list is never sent (R3). */
export function postsByIdsOp(alias: string, ids: readonly string[], fields: string): GqlOp | undefined {
  const unique = distinct(ids);
  if (unique.length === 0) return undefined;
  return byView("posts_by_ids", alias, "posts", "default", { exactPostIds: list(unique.map(idLit)) }, unique.length, fields);
}

/** One alias per `CONFIG.paging.bodiesPerAlias` ids, named `<aliasPrefix>1`, `<aliasPrefix>2`, …; none for no ids. */
export function commentsByIdsOps(aliasPrefix: string, ids: readonly string[], fields: string): GqlOp[] {
  const unique = distinct(ids);
  const ops: GqlOp[] = [];
  for (let from = 0; from < unique.length; from += CONFIG.paging.bodiesPerAlias) {
    const chunk = unique.slice(from, from + CONFIG.paging.bodiesPerAlias);
    ops.push(byView("comments_by_ids", `${aliasPrefix}${ops.length + 1}`, "comments", "default", { commentIds: list(chunk.map(idLit)) }, chunk.length, fields));
  }
  return ops;
}

export function usersByIdsOp(alias: string, ids: readonly string[], fields: string): GqlOp | undefined {
  const unique = distinct(ids);
  if (unique.length === 0) return undefined;
  return byView("users_by_ids", alias, "users", "usersByUserIds", { userIds: list(unique.map(idLit)) }, unique.length, fields);
}

export function sequencesByIdsOp(alias: string, ids: readonly string[], fields: string): GqlOp | undefined {
  const unique = distinct(ids);
  if (unique.length === 0) return undefined;
  return byView("sequences_by_ids", alias, "sequences", "default", { sequenceIds: list(unique.map(idLit)) }, unique.length, fields);
}

/** One `tag(selector: {_id})` alias per distinct id, named `<aliasPrefix>1`, `<aliasPrefix>2`, …: the P12 lookup of Arbital pages. */
export function tagRefsByIdOps(aliasPrefix: string, ids: readonly string[]): GqlOp[] {
  return distinct(ids).map((id, i) => byId("tag_refs_by_id", `${aliasPrefix}${i + 1}`, "tag", id, "...TAG_REF"));
}

// Forests, debate turns, reviews and chapters, built only from a Public*Id (P17)

function postComments(template: string, alias: string, view: string, postId: PublicPostId, limit: number, fields: string): GqlOp {
  return op({
    template, alias, root: "comments", view, terms: { postId: idLit(postId) }, limit, publicSubject: "post", select: resultsOf(fields),
  });
}

/** The whole discussion of a post: its comments (`c`), its answers and their replies (`a`) and, for a dialogue, its turns (`d`). */
export function commentForestOps(postId: PublicPostId, debate: boolean): GqlOp[] {
  const forest = (alias: string, view: string): GqlOp =>
    postComments("comment_forest", alias, view, postId, CONFIG.paging.forestLimit, "...COMMENT_TREE");
  const ops = [forest("c", "postCommentsOld"), forest("a", "answersAndReplies")];
  if (debate) ops.push(postComments("comment_forest", "d", "debateResponses", postId, DEBATE_TURNS_LIMIT, "...COMMENT_REF"));
  return ops;
}

/** A wiki page's discussion comments, alias `c`. */
export function tagForestOp(tagId: PublicTagId): GqlOp {
  return op({
    template: "tag_forest", alias: "c", root: "comments", view: "tagDiscussionComments", terms: { tagId: idLit(tagId) },
    limit: CONFIG.paging.forestLimit, publicSubject: "tag", select: resultsOf("...COMMENT_TREE"),
  });
}

export function debateTurnsOp(alias: string, postId: PublicPostId, fields: string): GqlOp {
  return postComments("debate_turns", alias, "debateResponses", postId, DEBATE_TURNS_LIMIT, fields);
}

export function reviewsOp(alias: string, postId: PublicPostId): GqlOp {
  return postComments("reviews", alias, "reviews", postId, REVIEWS_LIMIT, "...COMMENT_REF baseScore reviewingForReview");
}

export function sequenceChaptersOp(alias: string, sequenceId: PublicSequenceId, chapterFields: string): GqlOp {
  return op({
    template: "sequence_chapters", alias, root: "chapters", view: "SequenceChapters", terms: { sequenceId: idLit(sequenceId) },
    limit: CHAPTERS_LIMIT, publicSubject: "sequence", select: resultsOf(chapterFields),
  });
}

// Revisions

export interface RevisionPage {
  offset?: number;
  before?: string;      // exclusive upper bound, `YYYY-MM-DDTHH:MM:SS.SSSZ`
  after?: string;       // exclusive lower bound (the forum's `after` is strict), same form
  limit?: number;       // default `CONFIG.paging.revisionPage`
  enableTotal?: true;   // adds `totalCount`
  fields?: string;      // default `...REV_ROW`
}

/** The revisions of one confirmed document's `fieldName` (R7 names the field; without it the forum answers the wrong text). */
export function revisionListOp(alias: string, documentId: PublicDocId, fieldName: "contents" | "description", page: RevisionPage): GqlOp {
  const template = "revision_list";
  return op({
    template, alias, root: "revisions", view: "revisionsOnDocument",
    terms: {
      documentId: idLit(documentId),
      fieldName: enumTerm(fieldName, REVISION_FIELDS),
      before: page.before === undefined ? undefined : dateBoundLit(template, page.before),
      after: page.after === undefined ? undefined : dateBoundLit(template, page.after),
    },
    limit: page.limit ?? CONFIG.paging.revisionPage,
    offset: page.offset,
    enableTotal: page.enableTotal,
    publicSubject: "doc",
    select: `{ results { ${page.fields ?? "...REV_ROW"} }${page.enableTotal ? " totalCount" : ""} }`,
  });
}

const WIKI_EDIT_FIELDS = "...REV_ROW tag { ...TAG_REF } lens { ...MDOC_REF } summary { ...MDOC_REF }";

/**
 * A person's wiki edits, newest first (R7: `userId` is the only term). The first page (`offset` 0) asks for the total; the
 * second (`offset` 1000) does not. Any other offset is a bug of the caller: the scan reads these two pages and no more.
 */
export function revisionsByUserOp(alias: string, userId: string, offset: number): GqlOp {
  const template = "revisions_by_user";
  const secondPage = CONFIG.paging.revisionPage;
  if (offset !== 0 && offset !== secondPage) throw internalError(template, `offset must be 0 or ${secondPage}`);
  const first = offset === 0;
  return op({
    template, alias, root: "revisions", view: "revisionsByUser", terms: { userId: idLit(userId) },
    limit: CONFIG.paging.revisionPage,
    offset: first ? undefined : offset,
    enableTotal: first ? true : undefined,
    select: `{ results { ${WIKI_EDIT_FIELDS} }${first ? " totalCount" : ""} }`,
  });
}

/** The text of one revision of a confirmed document (P17). */
export function revisionTextOp(alias: string, id: PublicRevisionId): GqlOp {
  return byId("revision_text", alias, "revision", id, "_id documentId fieldName version editedAt wordCount markdown", { publicSubject: "revision" });
}

// Core-tag grouping

/** The tags filed under one core tag. Its answer is non-null, so a failing alias would null the response: it is isolated (R6). */
export function coreGroupingOp(alias: string, coreTagId: string): GqlOp {
  return op({
    template: "core_grouping", alias, root: "TagsByCoreTagId", args: { coreTagId: idLit(coreTagId), limit: int(CORE_GROUPING_LIMIT) },
    isolate: true, select: "{ tags { ...TAG_LIST } totalCount }",
  });
}
