import { parse } from "graphql";
import { describe, expect, it } from "vitest";
import { assertAllowed } from "../../src/forum/forbidden";
import { idLit } from "../../src/forum/literal";
import { op } from "../../src/forum/templates/op";
import * as T from "../../src/forum/templates/shared";
import type { GqlOp } from "../../src/types";
import { checkOps, typeViolations } from "../support/schemaCheck";
import { CATALOG, confirmed } from "../support/templateCatalog";

const AGI = "uMQ3cqWDPHhjtiesc";
const LEAN = "zHhGa3iQBQcdSifFL";
const DEBATE = "qbcuk8WwFnTZcXTd6";
const head = (o: GqlOp | undefined) => o && { template: o.template, alias: o.alias, text: o.text };

describe("shared templates: exact text of the schema-checked transcription", () => {
  it("¶3.1.2 Q88 Q90 resolution templates", () => {
    expect(head(T.postByIdOp("p", AGI, "...POST_FULL"))).toEqual({ template: "post_by_id", alias: "p", text: 'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_FULL } }' });
    expect(head(T.postsBySlugOp("s", "agi-ruin-a-list-of-lethalities", "...POST_FULL"))).toEqual({ template: "posts_by_slug", alias: "s", text: 's: posts(selector: {slugPost: {slug: "agi-ruin-a-list-of-lethalities"}}, limit: 2) { results { ...POST_FULL } }' });
    expect(head(T.postByLegacyIdOp("l", "2bz", "...POST_FULL"))).toEqual({ template: "post_by_legacy_id", alias: "l", text: 'l: posts(selector: {legacyIdPost: {legacyId: "2bz"}}, limit: 1) { results { ...POST_FULL } }' });
    expect(head(T.commentByIdOp("c", "HRDoDnHv8bvoW7oPZ", "...COMMENT_REF"))).toEqual({ template: "comment_by_id", alias: "c", text: 'c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_REF } }' });
    expect(head(T.commentByLegacyIdOp("c", "1k3", "...COMMENT_REF"))).toEqual({ template: "comment_by_legacy_id", alias: "c", text: 'c: comments(selector: {legacyIdComment: {legacyId: "1k3"}}, limit: 1) { results { ...COMMENT_REF } }' });
  });

  it("¶3.1.2 resolution templates", () => {
    expect(head(T.userBySlugOp("u", "eliezer_yudkowsky", "_id slug"))).toEqual({ template: "user_by_slug", alias: "u", text: 'u: GetUserBySlug(slug: "eliezer_yudkowsky") { _id slug }' });
    expect(head(T.userByIdOp("i", "nmk3nLpQE89dMRzzN", "...USER_CARD"))).toEqual({ template: "user_by_id", alias: "i", text: 'i: user(selector: {_id: "nmk3nLpQE89dMRzzN"}) { result { ...USER_CARD } }' });
    expect(head(T.tagBySlugOp("a", "bayes-rule", "...TAG_CARD"))).toEqual({ template: "tag_by_slug", alias: "a", text: 'a: tags(selector: {tagBySlug: {slug: "bayes-rule"}}, limit: 1) { results { ...TAG_CARD } }' });
    expect(head(T.tagPreviewOp("b", "bayes-rule", "tag { ...TAG_CARD } lens { ...MDOC_REF } summaries { _id deleted tabTitle }"))).toEqual({ template: "tag_preview", alias: "b", text: 'b: TagPreview(slug: "bayes-rule") { tag { ...TAG_CARD } lens { ...MDOC_REF } summaries { _id deleted tabTitle } }' });
    expect(head(T.tagByIdOp("t", "RkznxXmmh9b5ovdSq", "...TAG_CARD"))).toEqual({ template: "tag_by_id", alias: "t", text: 't: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...TAG_CARD } }' });
    expect(head(T.multiDocumentByIdOp("m", "RkznxXmmh9b5ovdSq", "...MDOC_REF"))).toEqual({ template: "multi_document_by_id", alias: "m", text: 'm: multiDocument(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...MDOC_REF } }' });
    expect(head(T.sequenceByIdOp("s", "5g5TkQTe9rmPS5vvM", "...SEQ_CARD"))).toEqual({ template: "sequence_by_id", alias: "s", text: 's: sequence(selector: {_id: "5g5TkQTe9rmPS5vvM"}, allowNull: true) { result { ...SEQ_CARD } }' });
    expect(head(T.collectionByIdOp("c", "62bf5f5dc581cd211cc67d49", "_id slug title"))).toEqual({ template: "collection_by_id", alias: "c", text: 'c: collection(selector: {_id: "62bf5f5dc581cd211cc67d49"}) { result { _id slug title } }' });
  });

  it("¶4.0 COLLECTIONS_LISTING", () => {
    const text = 'col: collections(selector: {default: {}}, limit: 10) { results { _id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } } } }';
    expect(head(T.collectionsListingOp())).toEqual({ template: "collections_listing", alias: "col", text });
    expect(T.collectionsListingOp("x").text).toBe(text.replace(/^col:/, "x:"));
  });

  it("Q57 R10 R3 by-id hydrates: an explicit limit equal to the de-duplicated id count, never enableTotal, never an empty list", () => {
    expect(head(T.postsByIdsOp("p", [AGI, LEAN, AGI], "...POST_CARD"))).toEqual({ template: "posts_by_ids", alias: "p", text: 'p: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc", "zHhGa3iQBQcdSifFL"]}}, limit: 2) { results { ...POST_CARD } }' });
    expect(head(T.usersByIdsOp("u", ["nmk3nLpQE89dMRzzN"], "...USER_CARD"))).toEqual({ template: "users_by_ids", alias: "u", text: 'u: users(selector: {usersByUserIds: {userIds: ["nmk3nLpQE89dMRzzN"]}}, limit: 1) { results { ...USER_CARD } }' });
    expect(head(T.sequencesByIdsOp("s", ["5g5TkQTe9rmPS5vvM"], "...SEQ_CARD"))).toEqual({ template: "sequences_by_ids", alias: "s", text: 's: sequences(selector: {default: {sequenceIds: ["5g5TkQTe9rmPS5vvM"]}}, limit: 1) { results { ...SEQ_CARD } }' });
    expect(T.commentsByIdsOps("b", ["HRDoDnHv8bvoW7oPZ", "aaaaaaaaaaaaaaaaa"], "...COMMENT_BODY").map(head)).toEqual([
      { template: "comments_by_ids", alias: "b1", text: 'b1: comments(selector: {default: {commentIds: ["HRDoDnHv8bvoW7oPZ", "aaaaaaaaaaaaaaaaa"]}}, limit: 2) { results { ...COMMENT_BODY } }' },
    ]);
    expect(T.tagRefsByIdOps("ar", ["aaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaa"]).map(head)).toEqual([
      { template: "tag_refs_by_id", alias: "ar1", text: 'ar1: tag(selector: {_id: "aaaaaaaaaaaaaaaaa"}) { result { ...TAG_REF } }' },
      { template: "tag_refs_by_id", alias: "ar2", text: 'ar2: tag(selector: {_id: "bbbbbbbbbbbbbbbbb"}) { result { ...TAG_REF } }' },
    ]);
    expect([T.postsByIdsOp("p", [], "_id"), T.usersByIdsOp("u", [], "_id"), T.sequencesByIdsOp("s", [], "_id")]).toEqual([undefined, undefined, undefined]);
    expect([T.commentsByIdsOps("b", [], "_id"), T.tagRefsByIdOps("ar", [])]).toEqual([[], []]);
  });

  it("R11 commentsByIdsOps puts at most 300 ids in one alias", () => {
    const ids = Array.from({ length: 301 }, (_, i) => `c${String(i).padStart(16, "0")}`);
    const ops = T.commentsByIdsOps("b", ids, "...COMMENT_BODY");
    expect(ops.map((o) => o.alias)).toEqual(["b1", "b2"]);
    expect(ops.map((o) => o.text.match(/limit: (\d+)/)![1])).toEqual(["300", "1"]);
  });

  it("Q3 Q14 Q53 Q54 P17 forests, debate turns, reviews and chapters, each with its own limit and public subject", () => {
    expect(T.commentForestOps(confirmed("post", DEBATE), true).map((o) => [o.template, o.publicSubject, o.text])).toEqual([
      ["comment_forest", "post", 'c: comments(selector: {postCommentsOld: {postId: "qbcuk8WwFnTZcXTd6"}}, limit: 5000) { results { ...COMMENT_TREE } }'],
      ["comment_forest", "post", 'a: comments(selector: {answersAndReplies: {postId: "qbcuk8WwFnTZcXTd6"}}, limit: 5000) { results { ...COMMENT_TREE } }'],
      ["comment_forest", "post", 'd: comments(selector: {debateResponses: {postId: "qbcuk8WwFnTZcXTd6"}}, limit: 500) { results { ...COMMENT_REF } }'],
    ]);
    expect(T.commentForestOps(confirmed("post", AGI), false).map((o) => o.alias)).toEqual(["c", "a"]);
    const tf = T.tagForestOp(confirmed("tag", "56yXXrcxRjrQs6z9R"));
    expect([tf.template, tf.publicSubject, tf.text]).toEqual(["tag_forest", "tag", 'c: comments(selector: {tagDiscussionComments: {tagId: "56yXXrcxRjrQs6z9R"}}, limit: 5000) { results { ...COMMENT_TREE } }']);
    expect(head(T.debateTurnsOp("dt", confirmed("post", DEBATE), "...COMMENT_REF contents { markdown }"))).toEqual({ template: "debate_turns", alias: "dt", text: 'dt: comments(selector: {debateResponses: {postId: "qbcuk8WwFnTZcXTd6"}}, limit: 500) { results { ...COMMENT_REF contents { markdown } } }' });
    expect(head(T.reviewsOp("rv", confirmed("post", AGI)))).toEqual({ template: "reviews", alias: "rv", text: 'rv: comments(selector: {reviews: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 50) { results { ...COMMENT_REF baseScore reviewingForReview } }' });
    const ch = T.sequenceChaptersOp("ch", confirmed("sequence", "5g5TkQTe9rmPS5vvM"), "_id number posts { ...POST_REF postedAt }");
    expect([ch.template, ch.publicSubject, ch.text]).toEqual(["sequence_chapters", "sequence", 'ch: chapters(selector: {SequenceChapters: {sequenceId: "5g5TkQTe9rmPS5vvM"}}, limit: 500) { results { _id number posts { ...POST_REF postedAt } } }']);
  });

  it("R7 Q71 revision lists name their field; a person's wiki edits take only userId", () => {
    const lean = confirmed("doc", LEAN);
    const agi = confirmed("doc", AGI);
    expect(head(T.revisionListOp("l", lean, "contents", { offset: 0, enableTotal: true }))).toEqual({ template: "revision_list", alias: "l", text: 'l: revisions(selector: {revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL", fieldName: "contents"}}, limit: 1000, offset: 0, enableTotal: true) { results { ...REV_ROW } totalCount }' });
    expect(T.revisionListOp("k", lean, "description", { before: "2020-01-01T00:00:00.001Z", enableTotal: true }).text).toBe('k: revisions(selector: {revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL", fieldName: "description", before: "2020-01-01T00:00:00.001Z"}}, limit: 1000, enableTotal: true) { results { ...REV_ROW } totalCount }');
    expect(T.revisionListOp("pub0", agi, "contents", { before: "2019-05-31T00:00:05.001Z", limit: 50, enableTotal: true, fields: "_id version editedAt updateType" }).text).toBe('pub0: revisions(selector: {revisionsOnDocument: {documentId: "uMQ3cqWDPHhjtiesc", fieldName: "contents", before: "2019-05-31T00:00:05.001Z"}}, limit: 50, enableTotal: true) { results { _id version editedAt updateType } totalCount }');
    expect(T.revisionListOp("aft0", agi, "contents", { after: "2019-05-31T00:00:05.000Z", enableTotal: true }).text).toBe('aft0: revisions(selector: {revisionsOnDocument: {documentId: "uMQ3cqWDPHhjtiesc", fieldName: "contents", after: "2019-05-31T00:00:05.000Z"}}, limit: 1000, enableTotal: true) { results { ...REV_ROW } totalCount }');
    expect(T.revisionListOp("l", lean, "contents", {}).text).toBe('l: revisions(selector: {revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL", fieldName: "contents"}}, limit: 1000) { results { ...REV_ROW } }');
    expect(head(T.revisionsByUserOp("w0", "nmk3nLpQE89dMRzzN", 0))).toEqual({ template: "revisions_by_user", alias: "w0", text: 'w0: revisions(selector: {revisionsByUser: {userId: "nmk3nLpQE89dMRzzN"}}, limit: 1000, enableTotal: true) { results { ...REV_ROW tag { ...TAG_REF } lens { ...MDOC_REF } summary { ...MDOC_REF } } totalCount }' });
    expect(T.revisionsByUserOp("w1", "nmk3nLpQE89dMRzzN", 1000).text).toBe('w1: revisions(selector: {revisionsByUser: {userId: "nmk3nLpQE89dMRzzN"}}, limit: 1000, offset: 1000) { results { ...REV_ROW tag { ...TAG_REF } lens { ...MDOC_REF } summary { ...MDOC_REF } } }');
    const r = T.revisionTextOp("r1", confirmed("revision", "aaaaaaaaaaaaaaaaa"));
    expect([r.template, r.publicSubject, r.text]).toEqual(["revision_text", "revision", 'r1: revision(selector: {_id: "aaaaaaaaaaaaaaaaa"}) { result { _id documentId fieldName version editedAt wordCount markdown } }']);
  });

  it("Q68 R6 the core-tag grouping is isolated", () => {
    const g = T.coreGroupingOp("g", "sYm3HiWcfZvrGu3ui");
    expect([g.template, g.isolate, g.text]).toEqual(["core_grouping", true, 'g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui", limit: 500) { tags { ...TAG_LIST } totalCount }']);
  });

  it("Q9 R3 refuses empty slugs, malformed legacy ids, malformed date bounds and invalid ids at runtime", () => {
    const failure = (template: string, detail: string) => `Unexpected failure in ${template} (${detail}). Please report this.`;
    expect(() => T.postsBySlugOp("s", "", "_id")).toThrow(failure("posts_by_slug", "empty slug"));
    expect(() => T.userBySlugOp("u", "", "_id")).toThrow(failure("user_by_slug", "empty slug"));
    expect(() => T.postByLegacyIdOp("l", "2BZ", "_id")).toThrow(failure("post_by_legacy_id", "not a base-36 legacy id"));
    expect(() => T.commentByLegacyIdOp("c", "1k3!", "_id")).toThrow(failure("comment_by_legacy_id", "not a base-36 legacy id"));
    expect(() => T.revisionListOp("l", confirmed("doc", LEAN), "contents", { before: "2020-01-01" })).toThrow(
      failure("revision_list", "not a YYYY-MM-DDTHH:MM:SS.SSSZ date"),
    );
    expect(() => T.postByIdOp("p", "agi-ruin", "_id")).toThrow(failure("idLit", "not a valid id"));
  });

  it("P17 excluded-path templates accept only Public*Id values (checked by tsc)", () => {
    const plain = AGI;
    const typeChecked = () => {
      // @ts-expect-error a plain string is not a PublicPostId
      T.commentForestOps(plain, false);
      // @ts-expect-error a plain string is not a PublicTagId
      T.tagForestOp(plain);
      // @ts-expect-error a plain string is not a PublicPostId
      T.reviewsOp("rv", plain);
      // @ts-expect-error a plain string is not a PublicSequenceId
      T.sequenceChaptersOp("ch", plain, "_id");
      // @ts-expect-error a plain string is not a PublicDocId
      T.revisionListOp("l", plain, "contents", {});
      // @ts-expect-error a plain string is not a PublicRevisionId
      T.revisionTextOp("r", plain);
      // @ts-expect-error a PublicPostId is not a PublicTagId
      T.tagForestOp(confirmed("post", plain));
    };
    expect(typeChecked).toBeTypeOf("function");
  });
});

describe("schemaCheck", () => {
  const post = (select: string) => op({ template: "t", alias: "x", root: "post", terms: { _id: idLit(AGI) }, allowNull: true, select });

  it("C2 reports validation errors against the forum schema", () => {
    expect(checkOps([post("{ result { _id noSuchField } }")])).toEqual(['C2 t: Cannot query field "noSuchField" on type "Post".']);
  });

  it("Q21 R8 reports denied Type.field pairs by type", () => {
    expect(checkOps([post("{ result { _id revisions { _id } } }")])).toEqual(["R8 Post.revisions is denied"]);
  });

  it("Q99 changeMetrics only on revision rows, never under a document's contents", () => {
    expect(checkOps([post("{ result { _id contents { changeMetrics } } }")])).toEqual(["Q99 Revision.changeMetrics under contents"]);
  });

  it("R12 Q122 a join without its reference fragment is reported", () => {
    const c = op({ template: "t", alias: "x", root: "comment", terms: { _id: idLit("HRDoDnHv8bvoW7oPZ") }, allowNull: true, select: "{ result { _id post { _id title } } }" });
    expect(checkOps([c])).toEqual(["R12 Comment.post (Post) lacks POST_REF"]);
  });
});

describe("shared templates: edges the exact-text tests leave open", () => {
  const failure = (template: string, detail: string) => `Unexpected failure in ${template} (${detail}). Please report this.`;

  it("R3 R7 a person's wiki edits read only the first two pages: any other offset is an internal error", () => {
    for (const offset of [-1, 1, 999, 1001, 2000]) {
      expect(() => T.revisionsByUserOp("w", "nmk3nLpQE89dMRzzN", offset)).toThrow(failure("revisions_by_user", "offset must be 0 or 1000"));
    }
  });

  it("R10 R11 by-id hydrates drop duplicates before chunking and counting", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(16, "0")}`);
    const ops = T.commentsByIdsOps("b", [...ids, ids[0]!, ids[1]!], "...COMMENT_BODY");
    expect(ops.map((o) => o.alias)).toEqual(["b1"]);
    expect(ops[0]!.text).toContain("limit: 300)");
    expect(T.commentsByIdsOps("b", [...ids, ...ids, "z0000000000000000"], "_id").map((o) => o.text.match(/limit: (\d+)/)![1])).toEqual(["300", "1"]);
  });

  it("R3 Q9 every slug template refuses an empty slug, and a legacy id must be base 36 and non-empty", () => {
    expect(() => T.tagBySlugOp("a", "", "_id")).toThrow(failure("tag_by_slug", "empty slug"));
    expect(() => T.tagPreviewOp("b", "", "tag { _id }")).toThrow(failure("tag_preview", "empty slug"));
    expect(() => T.postByLegacyIdOp("l", "", "_id")).toThrow(failure("post_by_legacy_id", "not a base-36 legacy id"));
    expect(() => T.commentByLegacyIdOp("c", "1 k", "_id")).toThrow(failure("comment_by_legacy_id", "not a base-36 legacy id"));
  });

  it("R3 Q11 both date bounds are checked, a field name outside the closed set is refused, and bounds keep their order", () => {
    const lean = confirmed("doc", LEAN);
    const date = failure("revision_list", "not a YYYY-MM-DDTHH:MM:SS.SSSZ date");
    expect(() => T.revisionListOp("l", lean, "contents", { after: "2020-01-01T00:00:00Z" })).toThrow(date);
    expect(() => T.revisionListOp("l", lean, "contents", { before: "2020-01-01T00:00:00.001Z", after: "tomorrow" })).toThrow(date);
    expect(() => T.revisionListOp("l", lean, "markdown" as "contents", {})).toThrow(failure("enumTerm", "value outside its closed set"));
    expect(T.revisionListOp("l", lean, "contents", { after: "2019-01-01T00:00:00.000Z", before: "2020-01-01T00:00:00.001Z" }).text).toContain(
      'fieldName: "contents", before: "2020-01-01T00:00:00.001Z", after: "2019-01-01T00:00:00.000Z"}}',
    );
  });

  it("R2 R7 revision lists without enableTotal ask for no totalCount, and an offset is passed through", () => {
    expect(T.revisionListOp("l", confirmed("doc", LEAN), "contents", { offset: 1000, limit: 25 }).text).toBe(
      'l: revisions(selector: {revisionsOnDocument: {documentId: "zHhGa3iQBQcdSifFL", fieldName: "contents"}}, limit: 25, offset: 1000) { results { ...REV_ROW } }',
    );
  });

  it("P17 R6 each excluded-path template carries its public subject; single-root resolutions carry none", () => {
    const subjects = (ops: GqlOp[]) => ops.map((o) => o.publicSubject);
    expect(subjects(T.commentForestOps(confirmed("post", DEBATE), true))).toEqual(["post", "post", "post"]);
    expect(subjects([T.debateTurnsOp("d", confirmed("post", DEBATE), "_id"), T.reviewsOp("r", confirmed("post", AGI))])).toEqual(["post", "post"]);
    expect(subjects([T.revisionListOp("l", confirmed("doc", LEAN), "contents", {})])).toEqual(["doc"]);
    expect(subjects([T.postByIdOp("p", AGI, "_id"), T.postsBySlugOp("s", "x", "_id"), T.tagByIdOp("t", "RkznxXmmh9b5ovdSq", "_id"), T.revisionsByUserOp("w", "nmk3nLpQE89dMRzzN", 0)])).toEqual([
      undefined, undefined, undefined, undefined,
    ]);
    expect(T.coreGroupingOp("g", "sYm3HiWcfZvrGu3ui").isolate).toBe(true);
    expect(T.tagBySlugOp("a", "bayes-rule", "_id").isolate).toBeUndefined();
  });
});

describe("schemaCheck: R12 and the report", () => {
  const comment = (select: string, alias = "x") =>
    op({ template: "t", alias, root: "comment", terms: { _id: idLit("HRDoDnHv8bvoW7oPZ") }, allowNull: true, select });

  it("R12 a join is satisfied by a fragment that spreads its reference fragment, directly or inside an inline fragment", () => {
    expect(checkOps([comment("{ result { _id post { ...POST_CARD } } }")])).toEqual([]);
    expect(checkOps([comment("{ result { _id post { ... on Post { ...POST_REF } } } }")])).toEqual([]);
  });

  it("R12 a reference fragment spread by a nested field does not satisfy the outer join", () => {
    expect(checkOps([comment("{ result { _id post { _id sourcePostRelations { sourcePost { ...POST_REF } } } } }")])).toEqual([
      "R12 Comment.post (Post) lacks POST_REF",
    ]);
  });

  it("R12 each joined type names its own reference fragment, inside fragment definitions as well", () => {
    const post = op({ template: "t", alias: "x", root: "post", terms: { _id: idLit(AGI) }, allowNull: true, select: "{ result { _id tags { _id name } user { _id } } }" });
    expect(checkOps([post])).toEqual(["R12 Post.tags (Tag) lacks TAG_REF"]);
    const viaFragment = op({ template: "t", alias: "x", root: "post", terms: { _id: idLit(AGI) }, allowNull: true, select: "{ result { ...POST_CARD } }" });
    expect(checkOps([viaFragment])).toEqual([]);
  });

  it("R12 the lenses and summaries a tag page lists need no reference fragment", () => {
    const tag = op({ template: "t", alias: "x", root: "tag", terms: { _id: idLit("56yXXrcxRjrQs6z9R") }, select: "{ result { ...TAG_REF lenses { _id slug } summaries { _id } } }" });
    expect(checkOps([tag])).toEqual([]);
  });

  it("a violation met twice is reported once, R12 before R8 before Q99", () => {
    const bad = (alias: string) => comment("{ result { _id post { _id } } }", alias);
    expect(checkOps([bad("x"), bad("y")])).toEqual(["R12 Comment.post (Post) lacks POST_REF"]);
    const several = op({ template: "t", alias: "x", root: "post", terms: { _id: idLit(AGI) }, allowNull: true, select: "{ result { ...POST_REF revisions { _id } contents { changeMetrics } tags { _id } } }" });
    expect(checkOps([several])).toEqual(["R12 Post.tags (Tag) lacks TAG_REF", "R8 Post.revisions is denied", "Q99 Revision.changeMetrics under contents"]);
  });

  it("C2 errors are returned alone, one per message, each naming the first op's template", () => {
    const o = op({ template: "first", alias: "x", root: "post", terms: { _id: idLit(AGI) }, allowNull: true, select: "{ result { _id post { _id } nope } }" });
    const messages = checkOps([o, comment("{ result { _id } }", "y")]);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.startsWith("C2 first: "))).toBe(true);
  });

  it("Q99 changeMetrics is allowed on revision rows", () => {
    const rows = op({ template: "t", alias: "x", root: "revisions", view: "revisionsOnDocument", terms: { documentId: idLit(LEAN), fieldName: '"contents"' }, limit: 5, publicSubject: "doc", select: "{ results { _id changeMetrics } }" });
    expect(checkOps([rows])).toEqual([]);
  });

  it("C2 typeViolations works on a document that fails validation: an undefined spread or a fragment cycle skips the inlined walk", () => {
    // (a) A spread with no definition used to throw a TypeError when the walk inlined it.
    const undefinedSpread = parse('query t { c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}) { result { ...NOPE } } }');
    expect(typeViolations(undefinedSpread)).toEqual([]);
    // (b) Two fragments that spread each other never finished inlining.
    const cycle = parse(
      'query t { p: post(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...A } } } fragment A on Post { _id ...B } fragment B on Post { _id ...A }',
    );
    expect(typeViolations(cycle)).toEqual([]);
    // R12 still reads the document as written: it is reported even though the walk after it is skipped.
    const joined = parse('query t { c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}) { result { _id post { _id } ...NOPE } } }');
    expect(typeViolations(joined)).toEqual(["R12 Comment.post (Post) lacks POST_REF"]);
  });
});

describe("template catalog: coverage", () => {
  it("builds an op of every template shared.ts offers", () => {
    const built = new Set(CATALOG.flatMap((e) => e.build().map((o) => o.template)));
    for (const template of [
      "post_by_id", "posts_by_slug", "post_by_legacy_id", "comment_by_id", "comment_by_legacy_id", "user_by_slug", "user_by_id", "tag_by_slug",
      "tag_preview", "tag_by_id", "multi_document_by_id", "sequence_by_id", "collection_by_id", "collections_listing", "posts_by_ids",
      "comments_by_ids", "users_by_ids", "sequences_by_ids", "tag_refs_by_id", "comment_forest", "tag_forest", "debate_turns", "reviews",
      "sequence_chapters", "revision_list", "revisions_by_user", "revision_text", "core_grouping",
    ]) {
      expect(built, template).toContain(template);
    }
  });

  it("gives the ops of one entry unique aliases, since they share one operation", () => {
    for (const entry of CATALOG) {
      const aliases = entry.build().map((o) => o.alias);
      expect(new Set(aliases).size, entry.name).toBe(aliases.length);
    }
  });
});

describe("template catalog: every template, every rule", () => {
  it.each(CATALOG.map((e) => [e.name, e] as const))("C2 R1–R12 %s validates against the forum schema and passes every rule", (_name, entry) => {
    const ops = entry.build();
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(() => assertAllowed(o)).not.toThrow();
      expect(o.text).not.toMatch(/\bmutation\b/);
    }
    expect(checkOps(ops)).toEqual([]);
  });
});
