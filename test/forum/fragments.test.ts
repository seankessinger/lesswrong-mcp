// test/forum/fragments.test.ts
import { NoUnusedFragmentsRule, parse, specifiedRules, validate } from "graphql";
import { describe, expect, it } from "vitest";
import {
  FRAGMENTS,
  fragmentClosure,
  fragmentDefinitions,
  type FragmentName,
} from "../../src/forum/templates/fragments";
import { forumSchema } from "../schema";

// The schema-checked transcription of the ¶4.0 table (one definition per line, exactly).
const EXPECTED: Record<FragmentName, string> = {
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
};

describe("fragments", () => {
  it("C3 ¶4.0 the 21 fragments are exactly the schema-checked transcription", () => {
    expect(FRAGMENTS).toEqual(EXPECTED);
    expect(Object.keys(FRAGMENTS)).toHaveLength(21);
  });

  it("¶4.0 the table cannot be changed at run time", () => {
    expect(Object.isFrozen(FRAGMENTS)).toBe(true);
  });

  it("C2 C3 every fragment validates against the forum schema", () => {
    const rules = specifiedRules.filter((r) => r !== NoUnusedFragmentsRule);
    const doc = parse(Object.values(FRAGMENTS).join("\n"));
    expect(validate(forumSchema, doc, rules).map((e) => e.message)).toEqual([]);
  });

  it("fragmentClosure lists the spread names transitively, dependencies first", () => {
    expect(fragmentClosure('p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_FULL } }')).toEqual(
      ["POST_REF", "TAG_REF", "POST_CARD", "SEQ_REF", "COMMENT_REF", "POST_FULL"],
    );
    expect(fragmentClosure('c: comment(selector: {_id: "HRDoDnHv8bvoW7oPZ"}, allowNull: true) { result { ...COMMENT_LIST } }')).toEqual(
      ["COMMENT_REF", "COMMENT_TREE", "POST_REF", "TAG_REF", "COMMENT_LIST"],
    );
    expect(
      fragmentClosure(
        't: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...TAG_CARD } } m: multiDocument(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ...MDOC_REF } }',
      ),
    ).toEqual(["TAG_REF", "TAG_CARD", "MDOC_REF"]);
  });

  it("fragmentClosure ignores spreads inside string literals and inline fragments", () => {
    expect(fragmentClosure('u: GetUserBySlug(slug: "...POST_REF") { _id slug }')).toEqual([]);
    expect(fragmentClosure('x: tag(selector: {_id: "RkznxXmmh9b5ovdSq"}) { result { ... on Tag { _id } } }')).toEqual([]);
  });

  it("an unknown fragment name is an internal error", () => {
    expect(() => fragmentClosure("x { ...NOPE }")).toThrow(
      "Unexpected failure in fragments (unknown fragment NOPE). Please report this.",
    );
  });

  it("fragmentDefinitions joins the definitions with newlines, in the order given", () => {
    expect(fragmentDefinitions(["TAG_REF", "MDOC_REF"])).toBe(`${EXPECTED.TAG_REF}\n${EXPECTED.MDOC_REF}`);
  });
});
