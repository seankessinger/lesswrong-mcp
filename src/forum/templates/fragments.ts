// Layer 4. The 21 shared GraphQL fragments of ¶4.0, as exact text: the schema-checked transcription of the table, one
// definition per line (C3: every field validates offline against the real schema, C2). Templates spread these by
// name; `fragmentClosure` finds the definitions an operation's text needs and `fragmentDefinitions` prints them.
// The `Raw*` types of src/types.ts are exactly these selections. Pure; imports nothing but the error wording.
import { internalError } from "../../errors";

export type FragmentName =
  | "POST_REF" | "COMMENT_REF" | "TAG_REF" | "SEQ_REF" | "MDOC_REF"
  | "POST_CARD" | "POST_LIGHT" | "POST_FULL" | "POST_CARD_EXCERPT"
  | "COMMENT_TREE" | "COMMENT_BODY" | "COMMENT_LIST" | "COMMENT_LIGHT"
  | "USER_CARD" | "USER_PROFILE" | "TAG_CARD" | "TAG_LIST" | "TAG_FULL"
  | "SEQ_CARD" | "SEQ_LIGHT" | "REV_ROW";

export const FRAGMENTS: Readonly<Record<FragmentName, string>> = Object.freeze({
  POST_REF: "fragment POST_REF on Post { _id title slug af question rejected unlisted shortform hideAuthor isEvent hiddenRelatedQuestion groupId }",
  COMMENT_REF: "fragment COMMENT_REF on Comment { _id postId tagId userId postedAt af deleted deletedPublic deletedReason rejected authorIsUnreviewed hideAuthor hideKarma debateResponse user { _id slug displayName } }",
  TAG_REF: "fragment TAG_REF on Tag { _id name slug core wikiOnly adminOnly deleted isPlaceholderPage }",
  SEQ_REF: "fragment SEQ_REF on Sequence { _id title af hidden }",
  MDOC_REF: "fragment MDOC_REF on MultiDocument { _id slug title tabTitle fieldName collectionName deleted parentTag { ...TAG_REF } parentLens { _id slug title tabTitle fieldName deleted parentTag { ...TAG_REF } } }",
  POST_CARD: "fragment POST_CARD on Post { ...POST_REF postedAt baseScore voteCount afBaseScore commentCount afCommentCount url debate collabEditorDialogue curatedDate frontpageDate sticky legacy lastCommentedAt userId user { _id slug displayName } coauthors { _id slug displayName } tags { ...TAG_REF } tagRelevance reviewWinner { reviewYear category reviewRanking } }",
  POST_LIGHT: "fragment POST_LIGHT on Post { _id postedAt baseScore afBaseScore af curatedDate frontpageDate question isEvent shortform unlisted rejected hideAuthor hiddenRelatedQuestion groupId userId coauthorUserIds tagRelevance }",
  POST_FULL: "fragment POST_FULL on Post { ...POST_CARD hideCommentKarma onlyVisibleToLoggedIn linkUrl extendedScore reviewCount finalReviewVoteScoreHighKarma finalReviewVoteScoreAF canonicalSequenceId canonicalCollectionSlug canonicalSequence { ...SEQ_REF canonicalCollectionSlug } contents { version editedAt markdown originalContents { type } } bestAnswer { ...COMMENT_REF baseScore } sourcePostRelations { sourcePost { ...POST_REF } } targetPostRelations { targetPost { ...POST_REF } } glossary { _id term approved deleted contents { markdown } } }",
  POST_CARD_EXCERPT: "fragment POST_CARD_EXCERPT on Post { ...POST_CARD contents { plaintextDescription } }",
  COMMENT_TREE: "fragment COMMENT_TREE on Comment { ...COMMENT_REF parentCommentId topLevelCommentId answer lastEditedAt baseScore voteCount afBaseScore extendedScore retracted moderatorHat reviewingForReview shortform isPinnedOnProfile contents { wordCount } }",
  COMMENT_BODY: "fragment COMMENT_BODY on Comment { _id contents { markdown } }",
  COMMENT_LIST: "fragment COMMENT_LIST on Comment { ...COMMENT_TREE contents { markdown wordCount } post { ...POST_REF } tag { ...TAG_REF } parentComment { ...COMMENT_REF } }",
  COMMENT_LIGHT: "fragment COMMENT_LIGHT on Comment { _id af postedAt baseScore hideKarma userId }",
  USER_CARD: "fragment USER_CARD on User { _id slug displayName createdAt karma afKarma postCount commentCount groups jobTitle organization deleted biography { plaintextDescription } }",
  USER_PROFILE: "fragment USER_PROFILE on User { ...USER_CARD website twitterProfileURL githubProfileURL linkedinProfileURL blueskyProfileURL facebookProfileURL pinnedPostIds biography { markdown wordCount editedAt } howOthersCanHelpMe { markdown } howICanHelpOthers { markdown } }",
  TAG_CARD: "fragment TAG_CARD on Tag { ...TAG_REF postCount parentTag { ...TAG_REF } description { plaintextDescription } }",
  TAG_LIST: "fragment TAG_LIST on Tag { ...TAG_REF postCount coreTagId parentTag { ...TAG_REF } }",
  TAG_FULL: "fragment TAG_FULL on Tag { ...TAG_CARD coreTagId baseScore voteCount extendedScore description { markdown version editedAt wordCount } subTags { ...TAG_REF } lenses { _id slug title tabTitle deleted contents { wordCount } } summaries { _id deleted tabTitle contents { markdown } } arbitalLinkedPages { parents { _id name slug } children { _id name slug } requirements { _id name slug } teaches { _id name slug } faster { _id name slug } slower { _id name slug } moreTechnical { _id name slug } lessTechnical { _id name slug } } }",
  SEQ_CARD: "fragment SEQ_CARD on Sequence { ...SEQ_REF createdAt canonicalCollectionSlug curatedOrder postsCount user { _id slug displayName } contents { plaintextDescription } }",
  SEQ_LIGHT: "fragment SEQ_LIGHT on Sequence { _id createdAt af hidden userId curatedOrder userProfileOrder hideFromAuthorPage }",
  REV_ROW: "fragment REV_ROW on Revision { _id documentId collectionName version editedAt updateType commitMessage changeMetrics wordCount userId user { _id slug displayName } }",
});

/** A JSON string literal, so that a spread written inside forum text or a search phrase is not taken for a spread. */
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"/g;
/** A named spread; an inline fragment (`... on Tag`) has a space after the dots and never matches. */
const SPREAD_RE = /\.\.\.([A-Z][A-Z0-9_]*)\b/g;

function spreadNames(text: string): string[] {
  return Array.from(text.replace(STRING_LITERAL_RE, '""').matchAll(SPREAD_RE), (m) => m[1]!);
}

function isFragmentName(name: string): name is FragmentName {
  return Object.hasOwn(FRAGMENTS, name);
}

/** The fragments `text` spreads, and those they spread in turn, each once, dependencies before the fragments that use them. */
export function fragmentClosure(text: string): FragmentName[] {
  const closure: FragmentName[] = [];
  const visited = new Set<string>();
  const visit = (names: readonly string[]): void => {
    for (const name of names) {
      if (visited.has(name)) continue;
      if (!isFragmentName(name)) throw internalError("fragments", `unknown fragment ${name}`);
      visited.add(name);
      visit(spreadNames(FRAGMENTS[name]));
      closure.push(name);
    }
  };
  visit(spreadNames(text));
  return closure;
}

/** The definitions of `names`, in the order given, one per line. */
export function fragmentDefinitions(names: readonly FragmentName[]): string {
  return names.map((n) => FRAGMENTS[n]).join("\n");
}
