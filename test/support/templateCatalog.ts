import { createCallContext } from "../../src/call/context";
import { idLit } from "../../src/forum/literal";
import { findHydrateOps } from "../../src/forum/templates/find";
import { firstUseHistoryOps, firstUseHydrateOps } from "../../src/forum/templates/first_use";
import { subjectOps } from "../../src/forum/templates/get_comments";
import { feedOp } from "../../src/forum/templates/get_feed";
import { historyDocOps } from "../../src/forum/templates/get_history";
import { incomingPostsOp, incomingTagOps, linkBodyOp, linkResolutionOps } from "../../src/forum/templates/get_links";
import { getPostRequest2Ops } from "../../src/forum/templates/get_post";
import { reactionItemOp, reactorIdsOp } from "../../src/forum/templates/get_reactions";
import { collectionOp, getSequenceRequest1Ops, getSequenceRequest2Ops } from "../../src/forum/templates/get_sequence";
import { getTagRequest1Ops, getTagRequest2Ops } from "../../src/forum/templates/get_tag";
import { getUserFollowupOps, getUserMainOps } from "../../src/forum/templates/get_user";
import { allRecentCommentsOp, topShortformOp } from "../../src/forum/templates/list_comments";
import { listPostsOp } from "../../src/forum/templates/list_posts";
import { sequenceSetOp } from "../../src/forum/templates/list_sequences";
import { allTagsOp } from "../../src/forum/templates/list_tags";
import { searchHydrateOps } from "../../src/forum/templates/search";
import { op, type OpSpec } from "../../src/forum/templates/op";
import * as T from "../../src/forum/templates/shared";
import type { GqlOp, PublicId, PublicKind } from "../../src/types";

interface CatalogEntry { name: string; build: () => GqlOp[] }

/** Every optional filter term of a post list, as the list_posts views test writes them. */
const LIST_FILTERS = {
  after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z", af: true as const, question: true as const, karmaThreshold: 10,
};

/** The period the list_comments template tests write their `after`/`before` terms from. */
const LIST_COMMENTS_MARCH = { after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z" };

const confirmer = createCallContext("get_history", { now: () => 0 });
export function confirmed<K extends PublicKind>(kind: K, id: string): PublicId<K> {
  return confirmer.confirmPublic(kind, id);
}

function allFragmentOps(): GqlOp[] {
  const one = (alias: string, root: string, id: string, select: string, extra: Partial<OpSpec> = {}) =>
    op({ template: "fragments", alias, root, terms: { _id: idLit(id) }, select, ...extra });
  return [
    one("fp", "post", "uMQ3cqWDPHhjtiesc", "{ result { ...POST_REF ...POST_CARD ...POST_LIGHT ...POST_FULL ...POST_CARD_EXCERPT } }", { allowNull: true }),
    one("fc", "comment", "HRDoDnHv8bvoW7oPZ", "{ result { ...COMMENT_REF ...COMMENT_TREE ...COMMENT_BODY ...COMMENT_LIST ...COMMENT_LIGHT } }", { allowNull: true }),
    one("fu", "user", "nmk3nLpQE89dMRzzN", "{ result { ...USER_CARD ...USER_PROFILE } }"),
    one("ft", "tag", "56yXXrcxRjrQs6z9R", "{ result { ...TAG_REF ...TAG_CARD ...TAG_LIST ...TAG_FULL } }"),
    one("fs", "sequence", "5g5TkQTe9rmPS5vvM", "{ result { ...SEQ_REF ...SEQ_CARD ...SEQ_LIGHT } }", { allowNull: true }),
    one("fm", "multiDocument", "aaaaaaaaaaaaaaaaa", "{ result { ...MDOC_REF } }"),
    one("fr", "revision", "aaaaaaaaaaaaaaaaa", "{ result { ...REV_ROW } }", { publicSubject: "revision" }),
  ];
}

/** The `cutoff` of the cursor feeds' samples. */
const FEED_CUTOFF = "2026-10-22T00:00:00.000Z";

export const CATALOG: CatalogEntry[] = [
  { name: "all 21 fragments", build: allFragmentOps },
  { name: "post_by_id", build: () => [T.postByIdOp("p", "uMQ3cqWDPHhjtiesc", "...POST_FULL")] },
  { name: "posts_by_slug", build: () => [T.postsBySlugOp("s", "agi-ruin-a-list-of-lethalities", "...POST_FULL")] },
  { name: "post_by_legacy_id", build: () => [T.postByLegacyIdOp("l", "2bz", "...POST_FULL")] },
  { name: "comment_by_id", build: () => [T.commentByIdOp("c", "HRDoDnHv8bvoW7oPZ", "...COMMENT_REF")] },
  { name: "comment_by_legacy_id", build: () => [T.commentByLegacyIdOp("c", "1k3", "...COMMENT_REF")] },
  { name: "user_by_slug + user_by_id", build: () => [T.userBySlugOp("u", "eliezer_yudkowsky", "_id slug"), T.userByIdOp("i", "nmk3nLpQE89dMRzzN", "...USER_CARD")] },
  { name: "tag_by_slug + tag_preview", build: () => [T.tagBySlugOp("a", "bayes-rule", "...TAG_CARD"), T.tagPreviewOp("b", "bayes-rule", "tag { ...TAG_CARD } lens { ...MDOC_REF } summaries { _id deleted tabTitle }")] },
  { name: "tag_by_id + multi_document_by_id", build: () => [T.tagByIdOp("t", "RkznxXmmh9b5ovdSq", "...TAG_CARD"), T.multiDocumentByIdOp("m", "RkznxXmmh9b5ovdSq", "...MDOC_REF")] },
  { name: "sequence_by_id + collection_by_id", build: () => [T.sequenceByIdOp("s", "5g5TkQTe9rmPS5vvM", "...SEQ_CARD"), T.collectionByIdOp("c", "oneQyj4pw77ynzwAF", "_id slug title")] },
  { name: "collections_listing", build: () => [T.collectionsListingOp()] },
  {
    name: "by-id hydrates",
    build: () => [
      T.postsByIdsOp("p", ["uMQ3cqWDPHhjtiesc", "zHhGa3iQBQcdSifFL"], "...POST_CARD")!,
      ...T.commentsByIdsOps("b", ["HRDoDnHv8bvoW7oPZ", "aaaaaaaaaaaaaaaaa"], "...COMMENT_BODY"),
      T.usersByIdsOp("u", ["nmk3nLpQE89dMRzzN"], "...USER_CARD")!,
      T.sequencesByIdsOp("s", ["5g5TkQTe9rmPS5vvM"], "...SEQ_CARD")!,
      ...T.tagRefsByIdOps("ar", ["aaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbb"]),
    ],
  },
  { name: "comment_forest with debate turns", build: () => T.commentForestOps(confirmed("post", "qbcuk8WwFnTZcXTd6"), true) },
  { name: "tag_forest", build: () => [T.tagForestOp(confirmed("tag", "56yXXrcxRjrQs6z9R"))] },
  {
    name: "debate_turns + reviews + sequence_chapters",
    build: () => [
      T.debateTurnsOp("dt", confirmed("post", "qbcuk8WwFnTZcXTd6"), "...COMMENT_REF contents { markdown }"),
      T.reviewsOp("rv", confirmed("post", "uMQ3cqWDPHhjtiesc")),
      T.sequenceChaptersOp("ch", confirmed("sequence", "5g5TkQTe9rmPS5vvM"), "_id number posts { ...POST_REF postedAt }"),
    ],
  },
  {
    name: "revision_list + revisions_by_user + revision_text",
    build: () => [
      T.revisionListOp("l", confirmed("doc", "zHhGa3iQBQcdSifFL"), "contents", { offset: 0, enableTotal: true }),
      T.revisionListOp("k", confirmed("doc", "zHhGa3iQBQcdSifFL"), "description", { before: "2020-01-01T00:00:00.001Z", enableTotal: true }),
      T.revisionsByUserOp("w0", "nmk3nLpQE89dMRzzN", 0),
      T.revisionsByUserOp("w1", "nmk3nLpQE89dMRzzN", 1000),
      T.revisionTextOp("r1", confirmed("revision", "aaaaaaaaaaaaaaaaa")),
      T.revisionTextOp("r2", confirmed("revision", "5a1b2c3d4e5f60718293a4b5")),
    ],
  },
  { name: "core_grouping", build: () => [T.coreGroupingOp("g", "sYm3HiWcfZvrGu3ui")] },
  {
    name: "find_graphql",
    build: () => findHydrateOps({
      postIds: ["uMQ3cqWDPHhjtiesc", "zHhGa3iQBQcdSifFL"], postSlugs: ["agi-ruin-a-list-of-lethalities"], userIds: ["nmk3nLpQE89dMRzzN"],
      userSlugs: ["paul-christiano", "paulchristiano", "paul_christiano"], tagIds: ["56yXXrcxRjrQs6z9R"], tagSlugs: ["interpretability"],
      sequenceIds: ["5g5TkQTe9rmPS5vvM"], collections: true, commentedOn: { id: "uMQ3cqWDPHhjtiesc" },
    }),
  },
  {
    name: "search_hydrate",
    build: () => [
      ...searchHydrateOps("post", ["uMQ3cqWDPHhjtiesc"]), ...searchHydrateOps("comment", ["HRDoDnHv8bvoW7oPZ"]), ...searchHydrateOps("user", ["nmk3nLpQE89dMRzzN"]),
      ...searchHydrateOps("tag", ["56yXXrcxRjrQs6z9R"]), ...searchHydrateOps("sequence", ["5g5TkQTe9rmPS5vvM"]),
    ],
  },
  {
    name: "get_post_request2",
    build: () => getPostRequest2Ops({
      postId: confirmed("post", "uMQ3cqWDPHhjtiesc"), reviews: true, debate: true, html: true, sequenceId: confirmed("sequence", "5g5TkQTe9rmPS5vvM"),
      listing: true,
    }),
  },
  {
    name: "get_comments_subject",
    build: () => [
      ...subjectOps({ post: { kind: "post", form: "id", value: "uMQ3cqWDPHhjtiesc", given: "id", notes: [] } }),
      ...subjectOps({ tag: { kind: "tag", form: "id", value: "56yXXrcxRjrQs6z9R", given: "id", notes: [] } }),
      ...subjectOps({ comment: { kind: "comment", form: "id", value: "HRDoDnHv8bvoW7oPZ", given: "id", notes: [] } }),
      ...subjectOps({ user: { kind: "user", form: "slug", value: "paulfchristiano", given: "slug", notes: [] } }),
    ],
  },
  {
    name: "list_posts_userPosts",
    build: () => [listPostsOp("userPosts", { userId: "nmk3nLpQE89dMRzzN", tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top", ...LIST_FILTERS, filter: "curated" }, { limit: 40, offset: 0, enableTotal: true }, "excerpt")],
  },
  {
    name: "list_posts_tagRelevance",
    build: () => [listPostsOp("tagRelevance", { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "relevance", ...LIST_FILTERS, filter: "frontpage" }, { limit: 40, offset: 0, enableTotal: true }, "excerpt")],
  },
  {
    name: "list_posts_sitewide",
    build: () => [
      listPostsOp("new", { sortedBy: "new", ...LIST_FILTERS, filter: "curated" }, { limit: 40, offset: 0 }, "excerpt", "n"),
      listPostsOp("old", { sortedBy: "old", after: LIST_FILTERS.after }, { limit: 40 }, "excerpt", "o"),
      listPostsOp("top", { sortedBy: "top" }, { limit: 40, offset: 40 }, "excerpt", "t"),
      listPostsOp("recentComments", { sortedBy: "recentComments" }, { limit: 40 }, "excerpt", "r"),
    ],
  },
  {
    name: "list_posts_light_scans",
    build: () => [
      listPostsOp("userPosts", { userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", af: true }, { limit: 2000, enableTotal: true }, "light", "a"),
      listPostsOp("userPosts", { userId: "nmk3nLpQE89dMRzzN", tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top" }, { limit: 2000, enableTotal: true }, "light", "r"),
      listPostsOp("tagRelevance", { tagId: "56yXXrcxRjrQs6z9R", sortedBy: "top" }, { limit: 2000, enableTotal: true }, "light", "g"),
      listPostsOp("curated", {}, { limit: 2000, enableTotal: true }, "light", "c"),
      T.postsByIdsOp("h", ["uMQ3cqWDPHhjtiesc"], "...POST_CARD_EXCERPT")!,
    ],
  },
  {
    name: "list_comments_allRecent",
    build: () => [
      allRecentCommentsOp("n", { userId: "nmk3nLpQE89dMRzzN", sortBy: "new", ...LIST_COMMENTS_MARCH, minimumKarma: 5 }, { limit: 40 }, "list"),
      allRecentCommentsOp("t", { sortBy: "top", ...LIST_COMMENTS_MARCH }, { limit: 40, offset: 40 }, "list"),
      allRecentCommentsOp("pl", { userId: "nmk3nLpQE89dMRzzN", sortBy: "new" }, { limit: 2000, enableTotal: true }, "light"),
      allRecentCommentsOp("af", { sortBy: "new" }, { limit: 500 }, "light"),
    ],
  },
  {
    name: "list_comments_quick_takes",
    build: () => [topShortformOp("q", { userId: "nmk3nLpQE89dMRzzN", ...LIST_COMMENTS_MARCH }, { limit: 2000, enableTotal: true })],
  },
  { name: "list_tags_all", build: () => [allTagsOp()] },
  // get_tag, with the arguments of its template tests
  { name: "get_tag_req1_slug", build: () => getTagRequest1Ops({ kind: "tag", form: "slug", value: "bayes-rule", given: "slug", notes: [] }) },
  { name: "get_tag_req1_id", build: () => getTagRequest1Ops({ kind: "tag", form: "id", value: "RkznxXmmh9b5ovdSq", given: "id", notes: [] }) },
  {
    name: "get_tag_req2_op1",
    build: () => getTagRequest2Ops({
      tagId: confirmed("tag", "56yXXrcxRjrQs6z9R"), sortedBy: "top", af: true, limit: 10, core: false, arbitalIds: ["aaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbb"],
    }),
  },
  {
    name: "get_tag_req2_op2_core",
    build: () => getTagRequest2Ops({ tagId: confirmed("tag", "sYm3HiWcfZvrGu3ui"), sortedBy: "new", af: false, limit: 5, core: true, arbitalIds: [] }),
  },
  // get_sequence, with the arguments of its template tests
  { name: "get_sequence_collection", build: () => [collectionOp("oneQyj4pw77ynzwAF")] },
  {
    name: "get_sequence_req1",
    build: () => getSequenceRequest1Ops("5g5TkQTe9rmPS5vvM", { kind: "post", form: "idOrSlug", value: "pwLastPost0000001", given: "id", notes: [] }),
  },
  {
    name: "get_sequence_req1_legacy",
    build: () => getSequenceRequest1Ops("5g5TkQTe9rmPS5vvM", { kind: "post", form: "legacy", value: "2bz", given: "url", notes: [] }),
  },
  { name: "get_sequence_req2", build: () => getSequenceRequest2Ops({ sequenceId: confirmed("sequence", "5g5TkQTe9rmPS5vvM"), listing: true }) },
  // list_sequences, the light set and the hydrate of the page shown
  { name: "list_sequences", build: () => [sequenceSetOp(0), T.sequencesByIdsOp("h", ["5g5TkQTe9rmPS5vvM"], "...SEQ_CARD")!] },
  // get_history, request 1 for a post, a comment and a tag (the six ops p, ps, c, t, m, lp)
  {
    name: "get_history_req1",
    build: () => [
      ...historyDocOps({ kind: "post", form: "idOrSlug", value: "zHhGa3iQBQcdSifFL", given: "id", notes: [] }, "post"),
      ...historyDocOps({ kind: "comment", form: "id", value: "HRDoDnHv8bvoW7oPZ", given: "id", notes: [] }, "comment"),
      ...historyDocOps({ kind: "tag", form: "idOrSlug", value: "RkznxXmmh9b5ovdSq", given: "id", notes: [] }, "tag"),
    ],
  },
  // get_user, with the arguments of its template tests
  { name: "get_user_main", build: () => getUserMainOps("nmk3nLpQE89dMRzzN", 10, false) },
  { name: "get_user_main_af", build: () => getUserMainOps("nmk3nLpQE89dMRzzN", 10, true) },
  {
    name: "get_user_followup",
    build: () => getUserFollowupOps({ userId: "nmk3nLpQE89dMRzzN", pinnedIds: ["uMQ3cqWDPHhjtiesc"], secondWikiPage: true, afCommentIds: ["HRDoDnHv8bvoW7oPZ"] }),
  },
  // first_use, with the arguments of its template tests
  { name: "first_use_hydrate", build: () => firstUseHydrateOps(["uMQ3cqWDPHhjtiesc"], ["HRDoDnHv8bvoW7oPZ"]) },
  {
    name: "first_use_history",
    build: () => firstUseHistoryOps([{ key: "0", docId: confirmed("doc", "uMQ3cqWDPHhjtiesc"), postedMs: Date.parse("2019-05-31T00:00:00.000Z") }]),
  },
  // get_links, with the arguments of its template tests
  {
    name: "get_links_incoming_post",
    build: () => [
      incomingPostsOp("uMQ3cqWDPHhjtiesc", true, { limit: 20, offset: 0, enableTotal: true }, "card"),
      incomingPostsOp("uMQ3cqWDPHhjtiesc", false, { limit: 2000, enableTotal: true }, "light"),
    ],
  },
  { name: "get_links_incoming_tag", build: () => incomingTagOps("56yXXrcxRjrQs6z9R") },
  {
    name: "get_links_body",
    build: () => [linkBodyOp({ post: "uMQ3cqWDPHhjtiesc" }), linkBodyOp({ tag: "56yXXrcxRjrQs6z9R" }), linkBodyOp({ lens: "BayesGuideLens001" })],
  },
  {
    name: "get_links_resolution",
    build: () => linkResolutionOps({
      postIds: ["uMQ3cqWDPHhjtiesc"], postSlugs: ["agi-ruin-a-list-of-lethalities"], commentIds: ["HRDoDnHv8bvoW7oPZ"],
      tagSlugs: ["ai", "interpretability-ml-and-ai"], tagOldSlugs: ["1lz"], lensSlugs: ["bayes-rule-guide"], userSlugs: ["eliezer_yudkowsky"],
      sequenceIds: ["5g5TkQTe9rmPS5vvM", "aaaaaaaaaaaaaaaaa"], hydratePostIds: ["zHhGa3iQBQcdSifFL"],
    }),
  },
  // get_reactions, the five ops of its template test
  {
    name: "get_reactions",
    build: () => [
      reactionItemOp("post", "uMQ3cqWDPHhjtiesc"), reactionItemOp("comment", "HRDoDnHv8bvoW7oPZ"), reactionItemOp("tag", "56yXXrcxRjrQs6z9R"),
      reactionItemOp("lens", "aaaaaaaaaaaaaaaaa"), reactorIdsOp(["nmk3nLpQE89dMRzzN"])!,
    ],
  },
  // get_feed, one entry per template with the sample its template test asserts
  { name: "feed_frontpage", build: () => [feedOp("frontpage", { limit: 100, offset: 0 })] },
  { name: "feed_recent_discussion", build: () => [feedOp("recent_discussion", { limit: 20, cutoff: FEED_CUTOFF, offset: 0 })] },
  { name: "feed_popular_comments", build: () => [feedOp("popular_comments", {})] },
  { name: "feed_quick_takes", build: () => [feedOp("quick_takes", { limit: 20, offset: 40 })] },
  { name: "feed_this_week", build: () => [feedOp("this_week", {})] },
  { name: "feed_wiki_activity", build: () => [feedOp("wiki_activity", { limit: 10, cutoff: FEED_CUTOFF, offset: 0 })] },
  { name: "feed_dialogues", build: () => [feedOp("dialogues", {})] },
  { name: "feed_best_of", build: () => [feedOp("best_of", {})] },
  { name: "feed_spotlight", build: () => [feedOp("spotlight", {})] },
];
