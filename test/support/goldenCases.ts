// The golden-output registry (¶9.2 "Golden outputs"): it holds each tool's representative cases (first page, continuation,
// empty, each error category), and test/golden.test.ts snapshots every reply, so a wording change is always deliberate.
import type { ToolName } from "../../src/types";
import {
  aiGrouping, aiGroupingRows, axelAfOnlyEntries, axelLongBioProfile, axelPinnedFailure, deletedUserRefusal, forestEntries, fullLightScan, gqlEntry,
  lensBacklinksFailure, longPostEntries, longWikiPageEntries, manyReactionsEntries, manyTagHitsFor, paulCommentsOnAgiRuin, rawSeqLight, searchEntry, sequenceSetEntry,
  smallAgiRuinForest, tagCatalogue,
} from "./builders";
import type { FixtureEntry, FixtureFamily } from "./fixtures";

interface GoldenCase {
  /** Unique; the snapshot key. */
  name: string;
  tool: ToolName;
  args: Record<string, unknown>;
  families: readonly FixtureFamily[];
  /** Entries matched before the families' (overrides first). */
  extra?: () => FixtureEntry[];
  /** Also call again with the cursor the first page printed, and snapshot that page too. */
  follow?: boolean;
  /** The follow-up call's `max_tokens`, when set (the first page's budget is in `args`). */
  followMax?: number;
}

/** The families the `find` cases read. */
const FIND_FAMILIES: readonly FixtureFamily[] = ["posts", "users", "tags", "sequences", "search", "comments"];
/** The families the `search` cases read. */
const SEARCH_FAMILIES: readonly FixtureFamily[] = ["posts", "comments", "joins", "users", "tags", "sequences", "search"];
/** The families the `get_post` cases read. */
const GET_POST_FAMILIES: readonly FixtureFamily[] = ["posts", "comments", "sequences", "users", "tags"];
/** The families the `get_comments` cases read. */
const GET_COMMENTS_FAMILIES: readonly FixtureFamily[] = ["posts", "comments", "joins", "users", "tags"];
/** The families the `list_posts` cases read. */
const LIST_POSTS_FAMILIES: readonly FixtureFamily[] = ["posts", "lists", "users", "tags"];
/** The families the `list_comments` cases read. */
const LIST_COMMENTS_FAMILIES: readonly FixtureFamily[] = ["users", "posts", "comments", "lists", "joins"];
/** The families the `get_tag` cases read. */
const GET_TAG_FAMILIES: readonly FixtureFamily[] = ["tags", "lists", "joins", "posts", "users"];
/** The families the `get_sequence` cases read. */
const GET_SEQUENCE_FAMILIES: readonly FixtureFamily[] = ["sequences", "posts", "users", "tags"];
/** The families the `list_sequences` cases read. */
const LIST_SEQUENCES_FAMILIES: readonly FixtureFamily[] = ["sequences", "users"];
/** The families the `get_history` cases read. */
const GET_HISTORY_FAMILIES: readonly FixtureFamily[] = ["posts", "comments", "tags", "revisions", "users"];
/** The families the `get_user` cases read. */
const GET_USER_FAMILIES: readonly FixtureFamily[] = ["users", "posts", "comments", "lists", "revisions", "tags", "sequences"];
/** The families the `first_use` cases read. */
const FIRST_USE_FAMILIES: readonly FixtureFamily[] = ["search", "posts", "comments", "revisions", "users"];
/** The families the `get_links` cases read. */
const GET_LINKS_FAMILIES: readonly FixtureFamily[] = ["posts", "lists", "tags", "sequences", "comments", "users", "revisions"];
/** The families the `get_reactions` cases read. */
const GET_REACTIONS_FAMILIES: readonly FixtureFamily[] = ["posts", "comments", "tags", "users"];
/** The families the `get_feed` cases read. */
const GET_FEED_FAMILIES: readonly FixtureFamily[] = ["feeds"];
/** A post whose text holds one link of every kind. */
const LINK_HUB = "LinkHubPost000001";
/** The three forms of example 4 (¶5b). */
const MESA_FORMS = ["mesa optimizer", "mesa optimizers", "mesa optimization"];
const AGI_RUIN = "uMQ3cqWDPHhjtiesc";
/** "A critical look at Lean4", whose history has every label (§7.2–§7.4). */
const LEAN4 = "zHhGa3iQBQcdSifFL";

/** The sequences light set when Eliezer Yudkowsky's one curated sequence is not on the Alignment Forum: curated and AF only is then empty. */
const eyCuratedWithoutAf = (): FixtureEntry[] => [
  sequenceSetEntry([rawSeqLight({ _id: "SeqLightA00000001", createdAt: "2024-01-01T00:00:00.000Z", af: false, curatedOrder: 5, userId: "nmk3nLpQE89dMRzzN" })], 0, 1),
];

/** Eliezer Yudkowsky's wiki edits: none. */
const noEyWikiEdits = (): FixtureEntry[] => [gqlEntry(
  { root: "revisions", view: "revisionsByUser", terms: { userId: "nmk3nLpQE89dMRzzN" } }, { results: [], totalCount: 0 }, "§7.1",
)];

/** Eliezer Yudkowsky's comments in March 2024: none. */
const noEyComments2024March = (): FixtureEntry[] => [gqlEntry(
  { root: "comments", view: "allRecentComments", terms: { userId: "nmk3nLpQE89dMRzzN", sortBy: "new", after: "2024-03-01T00:00:00.000Z" } },
  { results: [], totalCount: 0 }, "§9.4",
)];

/** Eliezer Yudkowsky's 2019 posts by karma under the AI tag's Required filter: none. */
const noEy2019AiPosts = (): FixtureEntry[] => [gqlEntry(
  {
    root: "posts", view: "userPosts", limit: 20, offset: 0, enableTotal: true,
    terms: {
      userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", after: "2019-01-01T00:00:00.000Z", before: "2020-01-01T00:00:00.000Z",
      filterSettings: { tags: [{ tagId: "sYm3HiWcfZvrGu3ui", filterMode: "Required" }] },
    },
  },
  { results: [], totalCount: 0 }, "§6.2",
)];

/** No hit for any form, in either oldest-first index. */
const noFirstUseHits = (): FixtureEntry[] => [
  searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
  searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
];

export const GOLDEN: GoldenCase[] = [
  // find
  {
    name: "find example 2", tool: "find", families: FIND_FAMILIES, extra: paulCommentsOnAgiRuin,
    args: { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Paul Christiano", commented_on: "item:1" }] },
  },
  { name: "find collection", tool: "find", families: FIND_FAMILIES, args: { items: [{ kind: "sequence", query: "The Sequences" }] } },
  { name: "find empty user", tool: "find", families: FIND_FAMILIES, args: { items: [{ kind: "user", query: "zzqq" }] } },
  {
    name: "find continuation", tool: "find", families: FIND_FAMILIES, extra: () => manyTagHitsFor("alignment", 10), follow: true,
    args: { items: [{ kind: "tag", query: "alignment" }], max_tokens: 2000 },
  },
  { name: "find bad_input af_only", tool: "find", families: FIND_FAMILIES, args: { items: [{ kind: "tag", query: "mech interp" }], af_only: true } },
  // search
  { name: "search phrases", tool: "search", families: SEARCH_FAMILIES, args: { phrases: ["inner alignment"], limit: 1 }, follow: true },
  { name: "search loose", tool: "search", families: SEARCH_FAMILIES, args: { phrases: ["GPT-4.5"] } },
  { name: "search comment on hidden post", tool: "search", families: SEARCH_FAMILIES, args: { kind: "comment", query: "orthogonality" } },
  { name: "search empty", tool: "search", families: SEARCH_FAMILIES, args: { phrases: ["zzqq qqzz"] } },
  { name: "search bad_input facet", tool: "search", families: SEARCH_FAMILIES, args: { kind: "sequence", query: "x", user: "eliezer_yudkowsky" } },
  { name: "search not_public post filter", tool: "search", families: SEARCH_FAMILIES, args: { kind: "comment", query: "x", post: "draftPost00000001" } },
  // get_post
  { name: "get_post header", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "uMQ3cqWDPHhjtiesc", include_body: false } },
  { name: "get_post container", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "quickTakesBox0001" } },
  { name: "get_post debate", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "qbcuk8WwFnTZcXTd6" } },
  { name: "get_post section", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "outlinePost000001", section: 2 } },
  {
    name: "get_post long", tool: "get_post", families: GET_POST_FAMILIES, extra: longPostEntries, follow: true,
    args: { post: "longPost000000001", max_tokens: 2000 },
  },
  { name: "get_post not_found", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "AAAAAAAAAAAAAAAAA" } },
  { name: "get_post not_public", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "draftPost00000001" } },
  { name: "get_post login_only", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "loginOnlyPost0001" } },
  { name: "get_post bad_input section", tool: "get_post", families: GET_POST_FAMILIES, args: { post: "outlinePost000001", section: 9 } },
  // get_comments
  { name: "get_comments top", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { post: AGI_RUIN } },
  { name: "get_comments contested", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { post: AGI_RUIN, sort: "contested" } },
  {
    name: "get_comments page 2", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, follow: true,
    args: { post: AGI_RUIN, limit: 1 },
  },
  { name: "get_comments af_only", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { post: AGI_RUIN, af_only: true } },
  {
    name: "get_comments empty", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: () => forestEntries({ post: "negKarmaPost00001" }, []),
    args: { post: "negKarmaPost00001" },
  },
  { name: "get_comments not_public", tool: "get_comments", families: GET_COMMENTS_FAMILIES, args: { post: "draftPost00000001" } },
  { name: "get_comments bad_input oneOf", tool: "get_comments", families: GET_COMMENTS_FAMILIES, args: { post: AGI_RUIN, tag: "ai" } },
  // get_comments comment target, reply map and match
  {
    name: "get_comments user map", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest,
    args: { post: AGI_RUIN, user: "paulfchristiano" },
  },
  { name: "get_comments comment", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { comment: "replyPaul00000001" } },
  { name: "get_comments comment alone", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { comment: "onHiddenPostCmnt1" } },
  { name: "get_comments match", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest, args: { post: AGI_RUIN, match: "reply" } },
  {
    name: "get_comments user empty", tool: "get_comments", families: GET_COMMENTS_FAMILIES, extra: smallAgiRuinForest,
    args: { post: AGI_RUIN, user: "eliezer_yudkowsky" },
  },
  { name: "get_comments debate turn", tool: "get_comments", families: GET_COMMENTS_FAMILIES, args: { comment: "debateTurnCmnt001" } },
  { name: "get_comments not_found comment", tool: "get_comments", families: GET_COMMENTS_FAMILIES, args: { comment: "privDeletedCmnt01" } },
  {
    name: "get_comments bad_input af_only", tool: "get_comments", families: GET_COMMENTS_FAMILIES,
    args: { comment: "replyPaul00000001", af_only: true },
  },
  // list_posts
  { name: "list_posts tag top", tool: "list_posts", families: LIST_POSTS_FAMILIES, args: { tag: "interpretability-ml-and-ai" }, follow: true },
  {
    name: "list_posts example 3 tagged part", tool: "list_posts", families: LIST_POSTS_FAMILIES,
    args: { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top" },
  },
  { name: "list_posts new", tool: "list_posts", families: LIST_POSTS_FAMILIES, args: {} },
  {
    name: "list_posts empty", tool: "list_posts", families: LIST_POSTS_FAMILIES, extra: noEy2019AiPosts,
    args: { user: "eliezer_yudkowsky", tag: "ai", date_from: "2019", date_to: "2019", sort: "top" },
  },
  { name: "list_posts bad_input af_top", tool: "list_posts", families: LIST_POSTS_FAMILIES, args: { sort: "af_top" } },
  // list_posts light scans and the untagged section
  { name: "list_posts af_top", tool: "list_posts", families: LIST_POSTS_FAMILIES, args: { user: "eliezer_yudkowsky", sort: "af_top", limit: 2 }, follow: true },
  {
    name: "list_posts example 3", tool: "list_posts", families: [...LIST_POSTS_FAMILIES, "search"],
    args: { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: "interpretability" },
  },
  {
    name: "list_posts too_broad", tool: "list_posts", families: LIST_POSTS_FAMILIES, args: { tag: "ai", sort: "af_top" },
    extra: () => [fullLightScan("tagRelevance", { tagId: "sYm3HiWcfZvrGu3ui", sortedBy: "top" }, 2500)],
  },
  // list_comments
  { name: "list_comments person", tool: "list_comments", families: LIST_COMMENTS_FAMILIES, args: { user: "sample-commenter" }, follow: true },
  {
    name: "list_comments empty person window", tool: "list_comments", families: LIST_COMMENTS_FAMILIES, extra: noEyComments2024March,
    args: { user: "eliezer_yudkowsky", date_from: "2024-03", date_to: "2024-03" },
  },
  { name: "list_comments bad_input window", tool: "list_comments", families: LIST_COMMENTS_FAMILIES, args: { sort: "top" } },
  { name: "list_comments bad_input unknown parameter", tool: "list_comments", families: LIST_COMMENTS_FAMILIES, args: { tag: "ai" } },
  { name: "list_comments not_found user", tool: "list_comments", families: LIST_COMMENTS_FAMILIES, args: { user: "Eliezer_Yudkowsky" } },
  // list_tags
  { name: "list_tags catalogue", tool: "list_tags", families: ["tags"], extra: () => [tagCatalogue(12)], args: { limit: 5 }, follow: true },
  { name: "list_tags core ai", tool: "list_tags", families: ["tags"], extra: () => [aiGrouping(aiGroupingRows(), 4321)], args: { tag: "ai" } },
  { name: "list_tags bad_input non-core", tool: "list_tags", families: ["tags"], args: { tag: "interpretability-ml-and-ai" } },
  { name: "list_tags not_found", tool: "list_tags", families: ["tags"], args: { tag: "no-such-tag" } },
  { name: "list_tags bad_input af_only", tool: "list_tags", families: ["tags"], args: { af_only: true } },
  // get_tag
  { name: "get_tag example 6", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "interpretability-ml-and-ai" } },
  { name: "get_tag wiki-only Arbital", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "bayes-rule" } },
  { name: "get_tag lens slug", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "bayes-rule-guide" } },
  { name: "get_tag core grouping", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "ai" } },
  {
    name: "get_tag long text", tool: "get_tag", families: GET_TAG_FAMILIES, extra: longWikiPageEntries, follow: true, followMax: 2000,
    args: { tag: "long-wiki-page", max_tokens: 4000 },
  },
  { name: "get_tag not_found admin-only", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "admin-only-page" } },
  { name: "get_tag not_public deleted", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "DeletedTagPage001" } },
  { name: "get_tag bad_input section", tool: "get_tag", families: GET_TAG_FAMILIES, args: { tag: "interpretability-ml-and-ai", section: 4 } },
  // get_sequence
  { name: "get_sequence a sequence", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "BiasesSequence001", limit: 3 }, follow: true },
  { name: "get_sequence marked last post", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "5g5TkQTe9rmPS5vvM", post: "pwLastPost0000001" } },
  { name: "get_sequence collection rationality", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "rationality" } },
  { name: "get_sequence collection bestoflesswrong", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "bestoflesswrong" } },
  { name: "get_sequence empty", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "EmptySequence0001" } },
  { name: "get_sequence not_public", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "deletedSeq0000001" } },
  { name: "get_sequence not_found", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "UnknownSequence01" } },
  { name: "get_sequence bad_input slug", tool: "get_sequence", families: GET_SEQUENCE_FAMILIES, args: { sequence: "rationalty" } },
  // list_sequences
  { name: "list_sequences all", tool: "list_sequences", families: LIST_SEQUENCES_FAMILIES, args: { limit: 2 }, follow: true },
  { name: "list_sequences by person", tool: "list_sequences", families: LIST_SEQUENCES_FAMILIES, args: { user: "eliezer_yudkowsky" } },
  { name: "list_sequences curated", tool: "list_sequences", families: LIST_SEQUENCES_FAMILIES, args: { curated_only: true } },
  {
    name: "list_sequences empty", tool: "list_sequences", families: LIST_SEQUENCES_FAMILIES, extra: eyCuratedWithoutAf,
    args: { user: "eliezer_yudkowsky", curated_only: true, af_only: true },
  },
  { name: "list_sequences bad_input sort", tool: "list_sequences", families: LIST_SEQUENCES_FAMILIES, args: { sort: "top" } },
  // get_history, versions, texts and diffs
  { name: "get_history Lean4 versions", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: LEAN4 } },
  { name: "get_history Lean4 original", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: LEAN4, revision: "original" } },
  { name: "get_history Lean4 diff", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: LEAN4, revision: "original", compare_to: "current" } },
  { name: "get_history pre-2019", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: "PreNineteenPost01" } },
  { name: "get_history anonymous post", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: "AnonPostHistory01" } },
  { name: "get_history wiki page", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { tag: "RkznxXmmh9b5ovdSq" } },
  { name: "get_history empty", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: "NoVisibleVersion1" } },
  {
    name: "get_history bad_input not public version", tool: "get_history", families: GET_HISTORY_FAMILIES,
    args: { post: LEAN4, revision: "NotInTheList00001" },
  },
  { name: "get_history bad_input deleted comment", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { comment: "DeletedPubComment" } },
  { name: "get_history not_found", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { post: "HiddenDraftPost01" } },
  // get_history, phrase introduction and a person's wiki edits
  {
    name: "get_history phrases Lean4", tool: "get_history", families: GET_HISTORY_FAMILIES,
    args: { post: LEAN4, phrases: ["proof assistant", "trusted kernel", "theorem prover"] },
  },
  { name: "get_history user", tool: "get_history", families: GET_HISTORY_FAMILIES, args: { user: "eliezer_yudkowsky" } },
  { name: "get_history user empty", tool: "get_history", families: GET_HISTORY_FAMILIES, extra: noEyWikiEdits, args: { user: "eliezer_yudkowsky" } },
  {
    name: "get_history bad_input user with revision", tool: "get_history", families: GET_HISTORY_FAMILIES,
    args: { user: "eliezer_yudkowsky", revision: "current" },
  },
  // get_user
  { name: "get_user example 5", tool: "get_user", families: GET_USER_FAMILIES, args: { user: "axel-hojmark", limit: 3 } },
  { name: "get_user af_only", tool: "get_user", families: GET_USER_FAMILIES, extra: axelAfOnlyEntries, args: { user: "axel-hojmark", limit: 3, af_only: true } },
  { name: "get_user not_found case", tool: "get_user", families: GET_USER_FAMILIES, args: { user: "Axel-Hojmark" } },
  { name: "get_user not_public deleted", tool: "get_user", families: GET_USER_FAMILIES, extra: () => [deletedUserRefusal()], args: { user: "DeletedUserId0001" } },
  { name: "get_user partial pinned", tool: "get_user", families: GET_USER_FAMILIES, extra: () => [axelPinnedFailure()], args: { user: "axel-hojmark", limit: 3 } },
  {
    name: "get_user over budget", tool: "get_user", families: GET_USER_FAMILIES, extra: () => [axelLongBioProfile()], follow: true, followMax: 2000,
    args: { user: "axel-hojmark", limit: 3, max_tokens: 8000 },
  },
  // first_use
  { name: "first_use example 4", tool: "first_use", families: FIRST_USE_FAMILIES, args: { forms: MESA_FORMS, limit: 5 } },
  { name: "first_use page 1 of 2", tool: "first_use", families: FIRST_USE_FAMILIES, args: { forms: MESA_FORMS, limit: 2 } },
  { name: "first_use empty", tool: "first_use", families: FIRST_USE_FAMILIES, extra: noFirstUseHits, args: { forms: ["zzqx frobnicator"] } },
  { name: "first_use bad_input loose form", tool: "first_use", families: FIRST_USE_FAMILIES, args: { forms: ["Gödel"] } },
  // get_links
  { name: "get_links post both", tool: "get_links", families: GET_LINKS_FAMILIES, args: { post: LINK_HUB }, follow: true },
  { name: "get_links post outgoing", tool: "get_links", families: GET_LINKS_FAMILIES, args: { post: LINK_HUB, direction: "outgoing" } },
  { name: "get_links tag incoming", tool: "get_links", families: GET_LINKS_FAMILIES, args: { tag: "interpretability-ml-and-ai", direction: "incoming" } },
  {
    name: "get_links partial lens backlinks", tool: "get_links", families: GET_LINKS_FAMILIES, extra: () => [lensBacklinksFailure()],
    args: { tag: "interpretability-ml-and-ai", direction: "incoming" },
  },
  { name: "get_links bad_input sort with tag", tool: "get_links", families: GET_LINKS_FAMILIES, args: { tag: "ai", sort: "new" } },
  {
    name: "get_links too_broad", tool: "get_links", families: GET_LINKS_FAMILIES, extra: () => [fullLightScan("pingbackPosts", { postId: LINK_HUB }, 2300)],
    args: { post: LINK_HUB, direction: "incoming", sort: "old" },
  },
  // get_reactions
  { name: "get_reactions comment", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { comment: "reactsCmnt0000001" } },
  { name: "get_reactions post slug", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { post: "a-post-readers-reacted-to" } },
  { name: "get_reactions wiki page", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { tag: "innerAlignTag0001" } },
  { name: "get_reactions lens slug", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { tag: "inner-alignment-intro" } },
  { name: "get_reactions no votes", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { comment: "noVotesCmnt000001" } },
  { name: "get_reactions placeholder", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { comment: "placeholderCmnt01" } },
  { name: "get_reactions not_found", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { post: "AAAAAAAAAAAAAAAAA" } },
  { name: "get_reactions not_public", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, args: { post: "draftPost00000001" } },
  {
    name: "get_reactions continuation", tool: "get_reactions", families: GET_REACTIONS_FAMILIES, extra: manyReactionsEntries,
    args: { comment: "manyReactsCmnt001", max_tokens: 2000 }, follow: true,
  },
  // get_feed
  { name: "get_feed frontpage", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "frontpage", limit: 3 } },
  { name: "get_feed frontpage af_only", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "frontpage", af_only: true, limit: 3 } },
  { name: "get_feed quick_takes", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "quick_takes" } },
  { name: "get_feed bad_input af_only wiki_activity", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "wiki_activity", af_only: true } },
  { name: "get_feed bad_input limit spotlight", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "spotlight", limit: 3 } },
  // get_feed recent_discussion and wiki_activity
  { name: "get_feed recent_discussion", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "recent_discussion", limit: 3 }, follow: true },
  { name: "get_feed wiki_activity", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "wiki_activity" } },
  // get_feed popular_comments, this_week, dialogues, best_of and spotlight
  { name: "get_feed popular_comments", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "popular_comments" } },
  { name: "get_feed this_week", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "this_week" } },
  { name: "get_feed dialogues", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "dialogues" } },
  { name: "get_feed best_of", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "best_of" } },
  { name: "get_feed best_of old 2022", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "best_of", sort: "old", date_from: "2022", date_to: "2022" } },
  { name: "get_feed spotlight", tool: "get_feed", families: GET_FEED_FAMILIES, args: { feed: "spotlight" } },
  // prompt-injection goldens (¶3.7, S2, Q79)
  { name: "injection post", tool: "get_post", families: ["posts"], args: { post: "injectionPost0001" } },
  { name: "injection comment", tool: "get_comments", families: ["comments", "posts"], args: { comment: "injectionCmnt0001" } },
];
