// Raw forum documents and fixture entries for tests (D14). Each `raw*` builder returns a fresh, complete public document with exactly
// the fields of its ¶4.0 fragment (so projection reports nothing missing and `checkFixtureFields` passes), built from the seed data
// (AGI Ruin, the interpretability, AI and Bayes' rule tags, Predictably Wrong); `o` is shallow-merged over the
// defaults, and nested defaults are built anew on every call. A test that depends on a field sets it explicitly. The default
// person is the made-up SAMPLE_AUTHOR; a test that needs a real person for public content passes them explicitly (`eyRef`,
// `axelRef`). Generators of large synthetic sets belong here too.
import type {
  RawCommentLight, RawCommentList, RawCommentRef, RawCommentTree, RawLensRef, RawMdocRef, RawPostCard, RawPostFull, RawPostLight, RawPostRef,
  RawRevRow, RawSeqCard, RawSeqLight, RawSeqRef, RawTagCard, RawTagFull, RawTagList, RawTagRef, RawUserCard, RawUserProfile,
  RawUserRef, SearchResult,
} from "../../src/types";
import { slugify } from "../../src/ids/parse";
import type { FixtureEntry, GraphqlMatch, SearchMatch } from "./fixtures";

/** A deterministic 17-character synthetic id: `seed` and `n` padded to 13 digits. */
export function seedId(n: number): string {
  return "seed" + String(n).padStart(13, "0");
}

export function gqlEntry(match: GraphqlMatch, result: unknown, source: string): FixtureEntry {
  return { source, match, result };
}

export function searchEntry(match: SearchMatch, result: Partial<SearchResult>, source: string): FixtureEntry {
  return { source, match, result };
}

const AGI_RUIN = "uMQ3cqWDPHhjtiesc";
const AGI_RUIN_POSTED = "2022-06-05T22:05:52.224Z";
const EY = "nmk3nLpQE89dMRzzN";
/** The made-up default person of every `raw*` builder. */
export const SAMPLE_AUTHOR: NamedUserRef = { _id: "sampleAuthor00001", slug: "sample-author", displayName: "Sample Author" };
const AGI_RUIN_COMMENT = "HRDoDnHv8bvoW7oPZ";
const COMMENT_POSTED = "2022-06-19T16:02:00.000Z";
const AI_TAG = "sYm3HiWcfZvrGu3ui";
const INTERPRETABILITY_DESCRIPTION = "Interpretability is the study of …";
const PREDICTABLY_WRONG = "5g5TkQTe9rmPS5vvM";
const SEQUENCE_CREATED = "2017-01-01T00:00:00.000Z";

/** The AI core tag, the default parent of the interpretability tag. */
const aiTag = (): RawTagRef => rawTagRef({ _id: AI_TAG, name: "AI", slug: "ai", core: true });

export function rawUserRef(o?: Partial<RawUserRef>): RawUserRef {
  return { ...SAMPLE_AUTHOR, ...o };
}

/** Eliezer Yudkowsky, for tests of his public content. */
export const eyRef = (): RawUserRef => rawUserRef({ _id: EY, slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" });

export function rawPostRef(o?: Partial<RawPostRef>): RawPostRef {
  return {
    _id: AGI_RUIN, title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities", af: true,
    question: false, rejected: false, unlisted: false, shortform: false, hideAuthor: false, isEvent: false,
    hiddenRelatedQuestion: false, groupId: null,
    ...o,
  };
}

export function rawPostCard(o?: Partial<RawPostCard>): RawPostCard {
  return {
    ...rawPostRef(),
    postedAt: AGI_RUIN_POSTED, baseScore: 1055, voteCount: 612, afBaseScore: 156, commentCount: 717, afCommentCount: 145,
    url: null, debate: false, collabEditorDialogue: false, curatedDate: null, frontpageDate: "2022-06-06T00:00:00.000Z",
    sticky: false, legacy: false, lastCommentedAt: "2024-01-01T00:00:00.000Z", userId: SAMPLE_AUTHOR._id, user: rawUserRef(), coauthors: [],
    tags: [], tagRelevance: {}, reviewWinner: null,
    ...o,
  };
}

export function rawPostLight(o?: Partial<RawPostLight>): RawPostLight {
  return {
    _id: AGI_RUIN, postedAt: AGI_RUIN_POSTED, baseScore: 1055, afBaseScore: 156, af: true, curatedDate: null,
    frontpageDate: "2022-06-06T00:00:00.000Z", question: false, isEvent: false, shortform: false, unlisted: false,
    rejected: false, hideAuthor: false, hiddenRelatedQuestion: false, groupId: null, userId: SAMPLE_AUTHOR._id, coauthorUserIds: [],
    tagRelevance: {},
    ...o,
  };
}

export function rawPostFull(o?: Partial<RawPostFull>): RawPostFull {
  return {
    ...rawPostCard(),
    hideCommentKarma: false, onlyVisibleToLoggedIn: false, linkUrl: null, extendedScore: null,
    reviewCount: 0, finalReviewVoteScoreHighKarma: 0, finalReviewVoteScoreAF: 0, canonicalSequenceId: null,
    canonicalCollectionSlug: null, canonicalSequence: null,
    contents: { version: "1.0.0", editedAt: AGI_RUIN_POSTED, markdown: "Body.", originalContents: { type: "ckEditorMarkup" } },
    bestAnswer: null, sourcePostRelations: [], targetPostRelations: [], glossary: [],
    ...o,
  };
}

export function rawCommentRef(o?: Partial<RawCommentRef>): RawCommentRef {
  return {
    _id: AGI_RUIN_COMMENT, postId: AGI_RUIN, tagId: null, userId: SAMPLE_AUTHOR._id, postedAt: COMMENT_POSTED, af: true, deleted: false,
    deletedPublic: false, deletedReason: null, rejected: false, authorIsUnreviewed: false, hideAuthor: false, hideKarma: false,
    debateResponse: null, user: rawUserRef(),
    ...o,
  };
}

export function rawCommentTree(o?: Partial<RawCommentTree>): RawCommentTree {
  return {
    ...rawCommentRef(),
    parentCommentId: null, topLevelCommentId: null, answer: false, lastEditedAt: null, baseScore: 10,
    voteCount: 5, afBaseScore: 5, extendedScore: null, retracted: false, moderatorHat: false, reviewingForReview: null,
    shortform: false, isPinnedOnProfile: false, contents: { wordCount: 2 },
    ...o,
  };
}

export function rawCommentList(o?: Partial<RawCommentList>): RawCommentList {
  return {
    ...rawCommentTree(),
    contents: { markdown: "A comment.", wordCount: 2 }, post: rawPostRef(), tag: null, parentComment: null,
    ...o,
  };
}

export function rawCommentLight(o?: Partial<RawCommentLight>): RawCommentLight {
  return { _id: AGI_RUIN_COMMENT, af: true, postedAt: COMMENT_POSTED, baseScore: 10, hideKarma: false, userId: SAMPLE_AUTHOR._id, ...o };
}

export function rawUserCard(o?: Partial<RawUserCard>): RawUserCard {
  return {
    ...SAMPLE_AUTHOR, createdAt: "2009-02-23T00:00:00.000Z",
    karma: 170469, afKarma: 4321, postCount: 967, commentCount: 7845, groups: ["alignmentForum"], jobTitle: null,
    organization: null, deleted: false, biography: { plaintextDescription: "A bio." },
    ...o,
  };
}

export function rawUserProfile(o?: Partial<RawUserProfile>): RawUserProfile {
  return {
    ...rawUserCard(),
    website: null, twitterProfileURL: null, githubProfileURL: null, linkedinProfileURL: null, blueskyProfileURL: null,
    facebookProfileURL: null, pinnedPostIds: [],
    biography: { plaintextDescription: "A bio.", markdown: "A bio.", wordCount: 2, editedAt: "2020-01-01T00:00:00.000Z" },
    howOthersCanHelpMe: null, howICanHelpOthers: null,
    ...o,
  };
}

export function rawTagRef(o?: Partial<RawTagRef>): RawTagRef {
  return {
    _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai", core: false,
    wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false,
    ...o,
  };
}

export function rawTagCard(o?: Partial<RawTagCard>): RawTagCard {
  return {
    ...rawTagRef(),
    postCount: 1608, parentTag: aiTag(), description: { plaintextDescription: INTERPRETABILITY_DESCRIPTION },
    ...o,
  };
}

export function rawTagList(o?: Partial<RawTagList>): RawTagList {
  return { ...rawTagRef(), postCount: 1608, coreTagId: AI_TAG, parentTag: aiTag(), ...o };
}

export function rawTagFull(o?: Partial<RawTagFull>): RawTagFull {
  return {
    ...rawTagRef(),
    postCount: 1608, parentTag: aiTag(), coreTagId: AI_TAG, baseScore: 31, voteCount: 23,
    extendedScore: null,
    description: {
      plaintextDescription: INTERPRETABILITY_DESCRIPTION, markdown: "Wiki text.", version: "1.0.0",
      editedAt: "2025-01-01T00:00:00.000Z", wordCount: 2,
    },
    subTags: [], lenses: [], summaries: [], arbitalLinkedPages: null,
    ...o,
  };
}

export function rawSeqRef(o?: Partial<RawSeqRef>): RawSeqRef {
  return { _id: PREDICTABLY_WRONG, title: "Predictably Wrong", af: false, hidden: false, ...o };
}

export function rawSeqCard(o?: Partial<RawSeqCard>): RawSeqCard {
  return {
    ...rawSeqRef(),
    createdAt: SEQUENCE_CREATED, canonicalCollectionSlug: "rationality", curatedOrder: null,
    postsCount: 21, user: rawUserRef(), contents: { plaintextDescription: "A sequence." },
    ...o,
  };
}

export function rawSeqLight(o?: Partial<RawSeqLight>): RawSeqLight {
  return {
    _id: PREDICTABLY_WRONG, createdAt: SEQUENCE_CREATED, af: false, hidden: false, userId: SAMPLE_AUTHOR._id, curatedOrder: null,
    userProfileOrder: null, hideFromAuthorPage: false,
    ...o,
  };
}

/** A lens of the wiki-only Bayes' rule page. */
export function rawMdocRef(o?: Partial<RawMdocRef>): RawMdocRef {
  return {
    _id: seedId(101), slug: "bayes-rule-guide", title: "Guide", tabTitle: "Guide", fieldName: "description",
    collectionName: "Tags", deleted: false,
    parentTag: rawTagRef({ _id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true }), parentLens: null,
    ...o,
  };
}

export function rawRevRow(o?: Partial<RawRevRow>): RawRevRow {
  return {
    _id: seedId(201), documentId: "zHhGa3iQBQcdSifFL", collectionName: "Posts", version: "1.0.0",
    editedAt: "2024-02-27T10:15:03.000Z", updateType: "initial", commitMessage: null, changeMetrics: { added: 412, removed: 37 },
    wordCount: 4410, userId: SAMPLE_AUTHOR._id, user: rawUserRef(),
    ...o,
  };
}

/**
 * Plants fields the fragments never select (stale counters, private fields) on a raw document, so a test can prove a
 * normalizer never carries them. The result keeps the type of `base`: the planted keys are invisible to the compiler.
 */
export function withExtra<T extends object>(base: T, extra: Readonly<Record<string, unknown>>): T {
  return { ...base, ...extra } as T;
}

// ---------------- made-up people (P7, P19) ----------------
/** A user reference whose slug and name are set. */
export type NamedUserRef = RawUserRef & { slug: string; displayName: string };

/**
 * A made-up account for the tests whose rule needs a person's own anonymous or placeholder rows; such rows are never given to a
 * real account. `samplePersonEntry` resolves its slug.
 */
export const SAMPLE_PERSON: NamedUserRef = { _id: "samplePerson00001", slug: "sample-person", displayName: "Sample Person" };

/** §9.1: the `GetUserBySlug` answer for SAMPLE_PERSON's slug. */
export function samplePersonEntry(): FixtureEntry {
  return gqlEntry({ root: "GetUserBySlug", args: { slug: SAMPLE_PERSON.slug } }, rawUserCard({
    ...SAMPLE_PERSON, createdAt: "2020-01-01T00:00:00.000Z", karma: 100, afKarma: 0, postCount: 2, commentCount: 5, groups: [],
  }), "§9.1");
}

/** A public post of SAMPLE_PERSON's own: LW only, karma 10 (5 votes), posted 2025-01-01; `o` is merged over it. */
export function samplePersonPost(_id: string, title: string, o: Partial<RawPostCard> = {}): RawPostCard {
  return rawPostCard({
    _id, title, slug: slugify(title), af: false, postedAt: "2025-01-01T00:00:00.000Z", baseScore: 10, voteCount: 5, afBaseScore: null,
    commentCount: 2, afCommentCount: 0, frontpageDate: "2025-01-02T00:00:00.000Z", lastCommentedAt: null, userId: SAMPLE_PERSON._id,
    user: SAMPLE_PERSON, ...o,
  });
}

/** What SAMPLE_PERSON's profile holds for `samplePersonPage`: its groups and the raw rows of each section, all empty unless given. */
export interface SamplePersonProfile {
  groups?: string[]; pinned?: RawPostCard[]; top?: RawPostCard[]; latest?: RawPostCard[]; comments?: RawCommentList[];
  sequences?: RawSeqCard[]; wikiEdits?: RawRevRow[];
}

/**
 * §9.1-§9.4, §11.1, §7.1: SAMPLE_PERSON's get_user requests: the slug resolve, the profile, the top and latest posts, the
 * comments, the profile's sequences, the wiki edits and, when it pins posts, their hydrate (§9.3).
 */
export function samplePersonPage(p: SamplePersonProfile = {}): FixtureEntry[] {
  const id = SAMPLE_PERSON._id;
  const pinned = p.pinned ?? [];
  return [
    samplePersonEntry(),
    gqlEntry({ root: "user", id }, { result: rawUserProfile({
      ...SAMPLE_PERSON, createdAt: "2020-01-01T00:00:00.000Z", karma: 100, afKarma: 0, postCount: 2, commentCount: 5, groups: p.groups ?? [],
      pinnedPostIds: pinned.map((x) => x._id),
    }) }, "§9.2"),
    gqlEntry({ root: "posts", view: "userPosts", terms: { userId: id, sortedBy: "top" } }, { results: p.top ?? [] }, "§9.3"),
    gqlEntry({ root: "posts", view: "userPosts", terms: { userId: id, sortedBy: "new" } }, { results: p.latest ?? [] }, "§9.3"),
    gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: id, sortBy: "new" } }, { results: p.comments ?? [] }, "§9.4"),
    gqlEntry({ root: "sequences", view: "userProfile", terms: { userId: id } }, { results: p.sequences ?? [] }, "§11.1"),
    samplePersonWikiEditsEntry(p.wikiEdits ?? []),
    ...(pinned.length > 0
      ? [gqlEntry({ root: "posts", view: "default", terms: { exactPostIds: pinned.map((x) => x._id) } }, { results: [...pinned].reverse() }, "§9.3")]
      : []),
  ];
}

/**
 * SAMPLE_PERSON's get_user requests with three pinned posts of its own, in this order: a public one (samplePinPost0001), a
 * rejected one (samplePinRej00001) and an anonymous one (samplePinAnon0001, titled PLANTED-P7-4). The other sections are empty.
 */
export function samplePersonPinnedPage(): FixtureEntry[] {
  return samplePersonPage({ pinned: [
    samplePersonPost("samplePinPost0001", "A pinned post"), samplePersonPost("samplePinRej00001", "A pinned rejected post", { rejected: true }),
    samplePersonPost("samplePinAnon0001", "PLANTED-P7-4", { hideAuthor: true }),
  ] });
}

/** §7.1: SAMPLE_PERSON's wiki edits (`revisionsByUser`), all of `rows` on one raw page. */
export function samplePersonWikiEditsEntry(rows: readonly RawRevRow[]): FixtureEntry {
  return gqlEntry({ root: "revisions", view: "revisionsByUser", terms: { userId: SAMPLE_PERSON._id } }, { results: rows, totalCount: rows.length }, "§7.1");
}

/**
 * §7.1: SAMPLE_PERSON's wiki edits, newest first: three of pages that are not public, then one of the AI page
 * (sampleWikiEdit001): a lens of an admin-only page (sampleWikiEdit004), the summary of a deleted lens (sampleWikiEdit003) and
 * an edit of a page the forum refused, with no page join (sampleWikiEdit002; document PLANTED-P12-8, message PLANTED-P12-9).
 */
export function samplePersonWikiEdits(): RawRevRow[] {
  const edit = (n: number, o: Partial<RawRevRow>): RawRevRow => rawRevRow({
    _id: `sampleWikiEdit00${n}`, collectionName: "MultiDocuments", version: `1.${n}.0`, editedAt: `2025-0${n}-01T00:00:00.000Z`,
    updateType: "minor", commitMessage: "", changeMetrics: { added: 10 * n, removed: n }, wordCount: 100, userId: SAMPLE_PERSON._id,
    user: SAMPLE_PERSON, tag: null, lens: null, summary: null, ...o,
  });
  const bayes = rawTagRef({ _id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true });
  const deadLens: RawLensRef = {
    _id: "sampleDeadLens001", slug: "planted-p12-lens", title: "PLANTED-P12-lens", tabTitle: "Lens", fieldName: "description", deleted: true, parentTag: bayes,
  };
  const adminPage = rawTagRef({ _id: "sampleAdminPage01", name: "PLANTED-P12-admin-page", slug: "planted-admin-page", adminOnly: true });
  return [
    edit(4, { documentId: "sampleAdminLens01", lens: rawMdocRef({ _id: "sampleAdminLens01", slug: "planted-admin-lens", title: "PLANTED-P12-admin-lens", tabTitle: "Lens", parentTag: adminPage }) }),
    edit(3, { documentId: "sampleDeadSumm001", summary: rawMdocRef({
      _id: "sampleDeadSumm001", slug: "planted-dead-lens-summary", title: null, tabTitle: "Summary", fieldName: "summary", collectionName: "MultiDocuments",
      parentTag: null, parentLens: deadLens,
    }) }),
    edit(2, { documentId: "PLANTED-P12-8", collectionName: "Tags", commitMessage: "PLANTED-P12-9" }),
    edit(1, { documentId: AI_TAG, collectionName: "Tags", tag: aiTag() }),
  ];
}

/** The made-up owner of the fixtures' anonymous items (as in posts.json); its name is a planted marker. */
export const ANON_AUTHOR: NamedUserRef = { _id: "anonAuthorUser001", slug: "anon-author", displayName: "PLANTED-P7-1" };

/** A made-up commenter of the fixture families, the owner of rows that are not public. */
export const A_COMMENTER: NamedUserRef = { _id: "commenterUser0001", slug: "a-commenter", displayName: "A Commenter" };

/** A made-up owner of sequences in the fixture families, hidden ones included. */
export const OTHER_USER: NamedUserRef = { _id: "OtherUserId000001", slug: "other_user", displayName: "Other User" };

// ---------------- comment forests (¶C "Comments", §8.2–§8.12, §13.3) ----------------
const forestId = (prefix: string, n: number): string => prefix + String(n).padStart(17 - prefix.length, "0");
const forestIso = (ms: number): string => new Date(ms).toISOString();
const FOREST_HOUR = 3_600_000;
const forestUser = (i: number): RawUserRef =>
  rawUserRef({ _id: forestId("agiU", i), slug: `commenter-${i}`, displayName: `Commenter ${i}` });
const FOREST_PAUL = rawUserRef({ _id: "paulfchristianoId", slug: "paulfchristiano", displayName: "paulfchristiano" }); // §8.2
const FOREST_EY = rawUserRef({ _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }); // §1
const FOREST_THREAD1 = ["e1", "p2", "e3", "p4", "e5", "b1", "b2", "x1", "y1", "c1", "c2", "d1", "d2", "f1", "g1", "g2", "g3"] as const;
const FOREST_QUOTE =
  "The hard part is getting alignment right on the first critical try, at a dangerous level of intelligence, where failure kills everyone and leaves no retry.";
/** Every field a forest computation reads, set explicitly, so rawCommentTree's defaults never decide a value. */
const FOREST_PLAIN = {
  tagId: null, deleted: false, deletedPublic: false, deletedReason: null, rejected: false, authorIsUnreviewed: false,
  hideAuthor: false, hideKarma: false, debateResponse: false, answer: false, retracted: false,
  moderatorHat: false, reviewingForReview: null, shortform: false, isPinnedOnProfile: false, extendedScore: null,
} as const;

export const AGI_FOREST = {
  postId: "uMQ3cqWDPHhjtiesc",
  paul: FOREST_PAUL,
  ey: FOREST_EY,
  quote: FOREST_QUOTE,
  ids: {
    p0: "HRDoDnHv8bvoW7oPZ",
    ...(Object.fromEntries(FOREST_THREAD1.map((k, i) => [k, forestId("agiA", i + 1)])) as Record<(typeof FOREST_THREAD1)[number], string>),
    promoted: forestId("agiS", 1), hiddenRoot: forestId("agiS", 2), hiddenReply: forestId("agiS", 3),
    orphanRoot: forestId("agiS", 4), orphan: forestId("agiS", 5), deletedAccountRoot: forestId("agiS", 6),
    missingParent: forestId("agiX", 1), fillerRoot0: forestId("agiF", 0), fillerPlaceholder: forestId("agiF", 4),
    paulFillerRoot: forestId("agiF", 100),
  },
} as const;

/** §8.12 AGI-Ruin shape: 731 comments in 158 threads (thread 1 = 18 comments rooted at HRDoDnHv8bvoW7oPZ, 4 special threads, 153 filler threads). */
export function agiRuinForest(): { comments: RawCommentTree[]; answers: RawCommentTree[] } {
  const ids = AGI_FOREST.ids;
  const out: RawCommentTree[] = [];
  const by = (u: RawUserRef | null, deletedUserId?: string) => ({ userId: u ? u._id : deletedUserId!, user: u });
  const row = (_id: string, postedAt: string, author: ReturnType<typeof by>, o: Partial<RawCommentTree>) =>
    rawCommentTree({ ...FOREST_PLAIN, _id, postId: AGI_FOREST.postId, postedAt, lastEditedAt: postedAt, parentCommentId: null, topLevelCommentId: null, ...author, ...o });
  const t0 = Date.parse("2022-06-19T16:02:00.000Z");
  const reply = (key: (typeof FOREST_THREAD1)[number], parent: string, hours: number, author: ReturnType<typeof by>, o: Partial<RawCommentTree>) =>
    row(ids[key], forestIso(t0 + hours * FOREST_HOUR), author, { parentCommentId: parent, topLevelCommentId: ids.p0, contents: { wordCount: 150 }, ...o });
  const react = (i: number, reactType: string, quotes?: string[]) =>
    ({ userId: forestUser(i)._id, displayName: `Commenter ${i}`, karma: 10 * i, reactType, ...(quotes ? { quotes } : {}) });
  // Thread 1 (§13.2, §13.3): reacts + agreement on the root, an anti-react, a quote-anchored disagree.
  out.push(row(ids.p0, forestIso(t0), by(FOREST_PAUL), {
    lastEditedAt: forestIso(t0 + 200), af: true, baseScore: 299, voteCount: 120, afBaseScore: 87, contents: { wordCount: 150 },
    extendedScore: {
      reacts: { disagree: [react(1, "created", [FOREST_QUOTE]), react(2, "seconded"), react(4, "seconded"), react(3, "disagreed")], crux: [react(5, "created")] },
      agreement: 45, agreementVoteCount: 30, approvalVoteCount: 120,
    },
  }));
  out.push(reply("e1", ids.p0, 1, by(FOREST_EY), { af: true, baseScore: 40, voteCount: 20, afBaseScore: 30, extendedScore: { reacts: {}, agreement: 3, agreementVoteCount: 3, approvalVoteCount: 20 } }));
  out.push(reply("p2", ids.e1, 2, by(FOREST_PAUL), { af: true, baseScore: 25, voteCount: 10, afBaseScore: 20 }));
  out.push(reply("e3", ids.p2, 3, by(FOREST_EY), { af: true, baseScore: 30, voteCount: 12, afBaseScore: 22, moderatorHat: true }));
  out.push(reply("p4", ids.e3, 4, by(FOREST_PAUL), { af: true, baseScore: 20, voteCount: 8, afBaseScore: 15 }));
  out.push(reply("e5", ids.p4, 5, by(FOREST_EY), { af: true, baseScore: 18, voteCount: 9, afBaseScore: 10 }));
  out.push(reply("b1", ids.p0, 6, by(forestUser(1)), { af: false, baseScore: 12, voteCount: 15, afBaseScore: 3, extendedScore: { agreement: -8, agreementVoteCount: 11 } }));
  out.push(reply("b2", ids.b1, 7, by(forestUser(2)), { af: false, baseScore: 2, voteCount: 6, afBaseScore: 0 }));
  out.push(reply("x1", ids.p0, 8, by(forestUser(6)), { af: false, deleted: true, deletedPublic: true, deletedReason: "Requested account deletion", moderatorHat: true, baseScore: 1, voteCount: 1, afBaseScore: 0, extendedScore: { agreement: 0, agreementVoteCount: 0 }, contents: null }));
  out.push(reply("y1", ids.b1, 9, by(ANON_AUTHOR), { af: false, hideAuthor: true, moderatorHat: true, baseScore: 5, voteCount: 3, afBaseScore: 0 }));
  out.push(reply("c1", ids.p0, 10, by(forestUser(3)), { af: false, baseScore: 9, voteCount: 5, afBaseScore: 0, extendedScore: { reacts: { changemind: [react(4, "created")] }, agreement: 0, agreementVoteCount: 0, approvalVoteCount: 5 } }));
  out.push(reply("c2", ids.c1, 11, by(FOREST_PAUL), { af: false, baseScore: 7, voteCount: 4, afBaseScore: 0 }));
  out.push(reply("d1", ids.e1, 12, by(forestUser(4)), { af: false, baseScore: 6, voteCount: 3, afBaseScore: 0 }));
  out.push(reply("d2", ids.p2, 13, by(forestUser(5)), { af: false, baseScore: 5, voteCount: 3, afBaseScore: 0 }));
  out.push(reply("f1", ids.c1, 14, by(forestUser(1)), { af: false, baseScore: 4, voteCount: 2, afBaseScore: 0 }));
  out.push(reply("g1", ids.e5, 16, by(forestUser(3)), { af: false, baseScore: 4, voteCount: 2, afBaseScore: 0 }));
  out.push(reply("g2", ids.p0, 17, by(null, forestId("agiU", 998)), { af: false, baseScore: 3, voteCount: 2, afBaseScore: 0 }));
  out.push(reply("g3", ids.g1, 18, by(forestUser(5)), { af: false, baseScore: 2, voteCount: 1, afBaseScore: 0 }));
  // Special threads.
  const one = { contents: { wordCount: 80 }, af: false } as const;
  out.push(Object.assign(row(ids.promoted, "2022-06-05T23:00:00.000Z", by(forestUser(7)), { ...one, baseScore: 8, voteCount: 4, afBaseScore: 2 }), { promoted: false })); // §8.4, Q14
  out.push(row(ids.hiddenRoot, "2022-06-10T12:00:00.000Z", by(forestUser(8)), { ...one, hideKarma: true, baseScore: null, voteCount: 7, afBaseScore: null })); // §13.5
  out.push(row(ids.hiddenReply, "2022-06-10T13:00:00.000Z", by(forestUser(9)), { ...one, parentCommentId: ids.hiddenRoot, topLevelCommentId: ids.hiddenRoot, baseScore: 3, voteCount: 2, afBaseScore: 1 }));
  out.push(row(ids.orphanRoot, "2022-06-11T12:00:00.000Z", by(forestUser(9)), { ...one, baseScore: 20, voteCount: 10, afBaseScore: 6 }));
  out.push(row(ids.orphan, "2022-06-11T14:00:00.000Z", by(forestUser(10)), { ...one, parentCommentId: ids.missingParent, topLevelCommentId: ids.orphanRoot, baseScore: 4, voteCount: 2, afBaseScore: 1 })); // §8.7
  out.push(row(ids.deletedAccountRoot, "2022-06-12T12:00:00.000Z", by(null, forestId("agiU", 999)), { ...one, baseScore: 15, voteCount: 8, afBaseScore: 5 })); // §8.5
  // Filler: 153 threads (95 of 5 comments, 58 of 4), 707 comments, one every 10 minutes from 2022-06-06.
  const fillerStart = Date.parse("2022-06-06T00:00:00.000Z");
  let k = 0;
  for (let j = 0; j < 153; j++) {
    const size = j < 95 ? 5 : 4;
    const thread: string[] = [];
    for (let m = 0; m < size; m++, k++) {
      const _id = forestId("agiF", k);
      thread.push(_id);
      const isRoot = m === 0;
      const karma = isRoot ? 1 + ((j * 37) % 250) : 1 + ((k * 13) % 40);
      const placeholder = m === size - 1 && j < 16; // 16 here + x1 = 17 placeholders (§8.4)
      const author = isRoot && j === 20 ? FOREST_PAUL : forestUser((k % 212) + 1);
      out.push(row(_id, forestIso(fillerStart + k * 600_000), by(author), {
        parentCommentId: isRoot ? null : thread[Math.floor((m - 1) / 2)], topLevelCommentId: isRoot ? null : thread[0],
        af: k % 5 === 0, baseScore: karma, voteCount: Math.ceil(karma / 2), afBaseScore: Math.floor(karma / 3),
        contents: placeholder ? null : { wordCount: 100 + ((k * 7) % 121) },
        ...(placeholder ? { deleted: true, deletedPublic: true, deletedReason: "Comment deleted by its author", extendedScore: { agreement: 0, agreementVoteCount: 0 } } : {}),
      }));
    }
  }
  return { comments: out, answers: [] };
}

const oldUser = (i: number): RawUserRef =>
  rawUserRef({ _id: forestId("oldU", i), slug: `old-commenter-${i}`, displayName: `Old Commenter ${i}` });
export const OLD_DISCUSSION = {
  postId: forestId("oldP", 1),
  ids: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i + 1}`, forestId("oldC", i + 1)])) as Record<`c${number}`, string>,
} as const;

/** §13.3 an old discussion without reactions or agreement votes: 4 reply chains of 4, 3, 3 and 2 comments, no signals. */
export function oldDiscussionForest(): { comments: RawCommentTree[]; answers: RawCommentTree[] } {
  const threads = [
    { karma: 30, start: "2010-03-13T10:00:00.000Z", authors: [1, 2, 3, 1] },
    { karma: 25, start: "2010-03-13T11:00:00.000Z", authors: [2, 4, 5] },
    { karma: 12, start: "2010-03-13T12:00:00.000Z", authors: [3, 1, 4] },
    { karma: 7, start: "2010-03-13T13:00:00.000Z", authors: [5, 2] },
  ];
  const out: RawCommentTree[] = [];
  let n = 1;
  threads.forEach((t, ti) => {
    const chain: string[] = [];
    t.authors.forEach((a, m) => {
      const _id = forestId("oldC", n++);
      const postedAt = forestIso(Date.parse(t.start) + m * 300_000);
      const karma = m === 0 ? t.karma : 6 - m;
      out.push(rawCommentTree({
        ...FOREST_PLAIN, _id, postId: OLD_DISCUSSION.postId, userId: oldUser(a)._id, user: oldUser(a), postedAt, lastEditedAt: postedAt,
        parentCommentId: m === 0 ? null : chain[m - 1], topLevelCommentId: m === 0 ? null : chain[0],
        af: false, baseScore: karma, voteCount: Math.ceil(karma / 2), afBaseScore: 0, contents: { wordCount: 50 },
        extendedScore: ti === 1 && m === 0 ? { agreement: 0, agreementVoteCount: 0 } : null,
      }));
      chain.push(_id);
    });
  });
  return { comments: out, answers: [] };
}

/** A 17-character id from a short lowercase stem: rowId("a1") === "a1ZZZZZZZZZZZZZZZ" (stems never contain "Z"). */
export const rowId = (stem: string): string => stem.padEnd(17, "Z");
export const rowUser = (n: number): RawUserRef =>
  rawUserRef({ _id: `user${String(n).padStart(13, "0")}`, slug: `user-${n}`, displayName: `User ${n}` });
/** A public comment on AGI Ruin with every forest field explicit; `user: null` is a deleted account (userId rowId("gone")). */
export function commentRow(stem: string, user: number | null, postedAt: string, o: Partial<RawCommentTree> = {}): RawCommentTree {
  return rawCommentTree({
    ...FOREST_PLAIN, _id: rowId(stem), postId: "uMQ3cqWDPHhjtiesc", userId: user === null ? rowId("gone") : rowUser(user)._id,
    user: user === null ? null : rowUser(user), postedAt, lastEditedAt: postedAt, parentCommentId: null, topLevelCommentId: null,
    af: false, baseScore: 5, voteCount: 3, afBaseScore: 1, contents: { wordCount: 10 }, ...o,
  });
}
export function replyRow(stem: string, user: number | null, postedAt: string, parent: string, root: string, o: Partial<RawCommentTree> = {}): RawCommentTree {
  return commentRow(stem, user, postedAt, { parentCommentId: rowId(parent), topLevelCommentId: rowId(root), ...o });
}
/** n public root comments by user 1 on AGI Ruin (ids rowId(`t${i}`)), all posted at postedAt: the forest-limit truncation set. */
export function flatForestRows(n: number, postedAt = "2022-06-19T10:00:00.000Z"): RawCommentTree[] {
  return Array.from({ length: n }, (_, i) => commentRow(`t${i}`, 1, postedAt));
}

// ---------------- get_comments (¶4.4, §8.2–§8.12, §13.3) ----------------
const GLM_POST = "R5g8YT25G9DXJJ48n";

/** A row as the forest views answer it (COMMENT_TREE): its Markdown, if it has any, is left out; the word count stays. */
function treeRow(c: RawCommentTree): RawCommentTree {
  return c.contents == null ? c : { ...c, contents: { wordCount: c.contents.wordCount } };
}

/**
 * ¶4.4 phase A and B as the forum answers them (source §8.2): for a post its `postCommentsOld` and `answersAndReplies` lists, for a
 * wiki page its `tagDiscussionComments` list (limit 5000, Markdown left out of every row), then one default-view body entry that
 * answers any `commentIds` request with the body of every comment given (its own Markdown, else `Comment <id>.`). The body entry
 * has no terms, so an entry for the same view placed before these wins.
 */
export function forestEntries(subject: { post?: string; tag?: string }, comments: RawCommentTree[], answers?: RawCommentTree[]): FixtureEntry[] {
  const source = "§8.2";
  const list = (view: string, terms: Record<string, unknown>, rows: readonly RawCommentTree[]): FixtureEntry =>
    gqlEntry({ root: "comments", view, terms, limit: 5000 }, { results: rows.map(treeRow) }, source);
  const forest = subject.tag !== undefined
    ? [list("tagDiscussionComments", { tagId: subject.tag }, comments)]
    : [list("postCommentsOld", { postId: subject.post }, comments), list("answersAndReplies", { postId: subject.post }, answers ?? [])];
  const bodies = [...comments, ...(answers ?? [])].map((c) => ({
    ...c, contents: { wordCount: c.contents?.wordCount ?? 0, markdown: c.contents?.markdown ?? `Comment ${c._id}.` },
  }));
  return [...forest, gqlEntry({ root: "comments", view: "default" }, { results: bodies }, source)];
}

/**
 * The bodies request (COMMENT_BODY) for a forest whose entries carry none (e.g. `paulCommentsOnAgiRuin`): one default-view entry
 * that answers any `commentIds` request with `Comment <id>.` for every row that has contents (placeholders are left out). It has
 * no terms, so callers place it after more specific `comments.default` entries. The example flows reuse it.
 */
export function bodiesEntry(rows: readonly { _id: string; contents?: unknown }[], source: string): FixtureEntry {
  const results = rows.filter((r) => r.contents !== null).map((r) => ({ _id: r._id, contents: { markdown: `Comment ${r._id}.` } }));
  return gqlEntry({ root: "comments", view: "default" }, { results }, source);
}

/**
 * `n` public root comments on the GLM post (ids `glmCmnt0000000000`…), not on AF, without reactions or agreement votes, one
 * vote each; `o` is merged over every row.
 */
export function glmComments(n: number, o: Partial<RawCommentTree> = {}): RawCommentTree[] {
  return Array.from({ length: n }, (_, i) =>
    rawCommentTree({ _id: `glmCmnt${String(i).padStart(10, "0")}`, postId: GLM_POST, extendedScore: null, voteCount: 1, af: false, ...o }));
}

/** The COMMENT_REF fields of a comment row (a COMMENT_LIST `parentComment` join). */
function commentRefOf(c: RawCommentTree): RawCommentRef {
  const { _id, postId, tagId, userId, postedAt, af, deleted, deletedPublic, deletedReason, rejected, authorIsUnreviewed, hideAuthor, hideKarma, debateResponse, user } = c;
  return { _id, postId, tagId, userId, postedAt, af, deleted, deletedPublic, deletedReason, rejected, authorIsUnreviewed, hideAuthor, hideKarma, debateResponse, user };
}

const SMALL_PAUL = rawUserRef({ _id: "paulfchristianoId", slug: "paulfchristiano", displayName: "paulfchristiano" });
const SMALL_ANN = rawUserRef({ _id: "annUserId00000001", slug: "ann", displayName: "Ann" });
const SMALL_BOB = rawUserRef({ _id: "bobUserId00000001", slug: "bob", displayName: "Bob" });
const SMALL_CAROL = rawUserRef({ _id: "carolUserId000001", slug: "carol", displayName: "Carol" });
const smallReact = (n: number) => ({ userId: `reactorUser00000${n}`, displayName: `Reactor ${n}`, karma: 100 * n, reactType: "created" });

/**
 * §8.2, §8.7, §13.3: AGI Ruin's discussion in three threads. T1 `rootPaul000000001` (AF, karma 299, agreement +45 of 30 votes,
 * one crux reaction) ← `replyC00000000001` (Carol, not on AF) ← `replyPaul00000001` (AF); T2 `rootAnn0000000001` (AF, karma
 * 50); T3 `rootBob0000000001` (not on AF, karma 8, three disagree reactions) with `orphanReply000001`, whose parent
 * `privDeletedCmnt01` is absent (privately deleted). Every comment has a short body (`> …`). The entries: the forest views and
 * the default-view body entry (`forestEntries`), then one `comment(_id)` entry per comment (COMMENT_LIST, its post AGI Ruin,
 * its parent's COMMENT_REF or null), which `get_comments {comment}` reads.
 */
export function smallAgiRuinForest(): FixtureEntry[] {
  const row = (o: Partial<RawCommentTree> & { _id: string; user: RawUserRef; markdown: string; wordCount: number }): RawCommentTree => {
    const { markdown, wordCount, ...rest } = o;
    return rawCommentTree({
      ...FOREST_PLAIN, postId: AGI_RUIN, userId: rest.user._id, lastEditedAt: null, parentCommentId: null, topLevelCommentId: null,
      afBaseScore: 0, ...rest, contents: { wordCount, markdown },
    });
  };
  const rows = [
    row({
      _id: "rootPaul000000001", user: SMALL_PAUL, af: true, baseScore: 299, voteCount: 120, afBaseScore: 87, postedAt: "2022-06-19T16:02:00.000Z",
      extendedScore: { agreement: 45, agreementVoteCount: 30, reacts: { crux: [smallReact(1)] } }, wordCount: 40, markdown: "Paul's root comment about takeoff.",
    }),
    row({ _id: "rootAnn0000000001", user: SMALL_ANN, af: true, baseScore: 50, voteCount: 20, afBaseScore: 20, postedAt: "2022-06-06T08:00:00.000Z", wordCount: 3, markdown: "Ann's root comment." }),
    row({
      _id: "rootBob0000000001", user: SMALL_BOB, af: false, baseScore: 8, voteCount: 3, postedAt: "2022-06-07T08:00:00.000Z",
      extendedScore: { reacts: { disagree: [smallReact(1), smallReact(2), smallReact(3)] }, agreement: 0, agreementVoteCount: 0 }, wordCount: 3, markdown: "Bob's contrarian take.",
    }),
    row({
      _id: "replyC00000000001", user: SMALL_CAROL, af: false, baseScore: 10, voteCount: 4, postedAt: "2022-06-20T10:00:00.000Z",
      parentCommentId: "rootPaul000000001", topLevelCommentId: "rootPaul000000001", wordCount: 2, markdown: "Carol's reply.",
    }),
    row({
      _id: "replyPaul00000001", user: SMALL_PAUL, af: true, baseScore: 20, voteCount: 8, afBaseScore: 12, postedAt: "2022-06-21T09:00:00.000Z",
      parentCommentId: "replyC00000000001", topLevelCommentId: "rootPaul000000001", wordCount: 3, markdown: "Paul replies back.",
    }),
    row({
      _id: "orphanReply000001", user: SMALL_ANN, af: false, baseScore: 2, voteCount: 1, postedAt: "2022-06-08T08:00:00.000Z",
      parentCommentId: "privDeletedCmnt01", topLevelCommentId: "rootBob0000000001", wordCount: 3, markdown: "An orphaned reply.",
    }),
  ];
  const byId = new Map(rows.map((r) => [r._id, r]));
  const source = "§8.2, §8.7, §13.3";
  const single = rows.map((r) => {
    const parent = r.parentCommentId === null ? undefined : byId.get(r.parentCommentId);
    return gqlEntry({ root: "comment", id: r._id }, {
      result: rawCommentList({ ...r, post: rawPostRef(), tag: null, parentComment: parent === undefined ? null : commentRefOf(parent) }),
    }, source);
  });
  return [...forestEntries({ post: AGI_RUIN }, rows), ...single];
}

/**
 * §8.12: one thread on the GLM post larger than a 2,000-token page: root `glmChain000000000` (2025-01-01T00:00Z) and replies
 * `glmChain000000001`…`glmChain000000029`, one hour apart; replies 1–4 a chain, replies 5–29 answer reply 4. Authors cycle
 * through five people (`glmUser<k>`, k = index mod 5); every comment is off AF, karma 10 (2 votes), without vote data, and 250
 * words long.
 */
export function deepThread30(): RawCommentTree[] {
  const markdown = Array.from({ length: 250 }, (_, j) => `w${j % 10}`).join(" ");
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  const id = (i: number): string => "glmChain" + String(i).padStart(9, "0");
  return Array.from({ length: 30 }, (_, i) => {
    const k = i % 5;
    const user = rawUserRef({ _id: "glmUser" + String(k).padStart(10, "0"), slug: `glm-user-${k}`, displayName: `GLM User ${k}` });
    const parent = i === 0 ? null : id(i <= 4 ? i - 1 : 4);
    return rawCommentTree({
      ...FOREST_PLAIN, _id: id(i), postId: GLM_POST, userId: user._id, user, postedAt: new Date(start + i * FOREST_HOUR).toISOString(),
      lastEditedAt: null, parentCommentId: parent, topLevelCommentId: i === 0 ? null : id(0), af: false, baseScore: 10, voteCount: 2,
      afBaseScore: 0, extendedScore: null, contents: { wordCount: 250, markdown },
    });
  });
}

// ---------------- find (¶4.1, §3.4, §8.2, §10.2) ----------------
const PAUL_CHRISTIANO = rawUserRef({ _id: "paulfchristianoId", slug: "paulfchristiano", displayName: "paulfchristiano" }); // §3.4
const CHRISTIAN_KL = rawUserRef({ _id: "christianKlId0001", slug: "christiankl", displayName: "ChristianKl" }); // §3.4

/**
 * P19, §8.2, §8.7: AGI Ruin's `postCommentsOld` forest for `find`'s `commented_on`: three comments by `person` (`<own>Cmnt…`), a
 * public placeholder by `placeholderBy` (`<other>Placeholder…`), an anonymous comment by `anonymousBy` (`<other>Anon…`) and one
 * by ChristianKl; `answersAndReplies` is empty.
 */
function commentersOnAgiRuin(
  own: string, other: string, person: RawUserRef, placeholderBy: RawUserRef, anonymousBy: RawUserRef,
): FixtureEntry[] {
  const at = (hour: number): string => new Date(Date.parse("2022-06-06T00:00:00.000Z") + hour * 3_600_000).toISOString();
  const row = (_id: string, user: RawUserRef, hour: number, o: Partial<RawCommentTree> = {}): RawCommentTree =>
    rawCommentTree({
      ...FOREST_PLAIN, _id, postId: AGI_RUIN, userId: user._id, user, postedAt: at(hour), lastEditedAt: at(hour),
      parentCommentId: null, topLevelCommentId: null, af: false, baseScore: 10, voteCount: 5, afBaseScore: 0, contents: { wordCount: 40 }, ...o,
    });
  const id = (prefix: string, kind: string, n: number): string => prefix + kind + String(n).padStart(17 - prefix.length - kind.length, "0");
  const comments = [
    row(id(own, "Cmnt", 1), person, 1),
    row(id(own, "Cmnt", 2), person, 2),
    row(id(own, "Cmnt", 3), person, 3),
    row(id(other, "Placeholder", 1), placeholderBy, 4, { deleted: true, deletedPublic: true, deletedReason: "Comment deleted by its author", contents: null }),
    row(id(other, "Anon", 1), anonymousBy, 5, { hideAuthor: true }),
    row("ckCmnt00000000001", CHRISTIAN_KL, 6),
  ];
  const forest = (view: string, results: RawCommentTree[]): FixtureEntry =>
    gqlEntry({ root: "comments", view, terms: { postId: AGI_RUIN }, limit: 5000 }, { results }, "§8.2, §8.7, P19");
  return [forest("postCommentsOld", comments), forest("answersAndReplies", [])];
}

/** P19: paulfchristiano's three comments on AGI Ruin among a placeholder and an anonymous comment by made-up accounts. */
export function paulCommentsOnAgiRuin(): FixtureEntry[] {
  return commentersOnAgiRuin("paul", "agi", PAUL_CHRISTIANO, A_COMMENTER, ANON_AUTHOR);
}

/** P19: SAMPLE_PERSON's comments on AGI Ruin, the placeholder and the anonymous comment included (`smpl…` ids). */
export function samplePersonOnAgiRuin(): FixtureEntry[] {
  return commentersOnAgiRuin("smpl", "smpl", SAMPLE_PERSON, SAMPLE_PERSON, SAMPLE_PERSON);
}

/**
 * §3.4, §10.2: a `tags` search for `query` (page 0, 10 per page) with `n` hits `manyTag0000000001`…, each a public tag whose
 * description is 600 characters of dense text (a run of slugs, so that ten cards overflow a 2,000-token page), the empty
 * wiki-only query, and the empty tag and lens lookups of the query's slug.
 */
export function manyTagHitsFor(query: string, n: number): FixtureEntry[] {
  const source = "§3.4, §10.2";
  const slug = slugify(query);
  const tags = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const tagSlug = `${slug}-topic-${i}`;
    const related = Array.from({ length: 12 }, (_, j) => `${tagSlug}/related-page-${j + 1}`).join("/");
    return { _id: "manyTag" + String(i).padStart(10, "0"), name: `${query} topic ${i}`, slug: tagSlug, description: related.padEnd(600, "-").slice(0, 600) };
  });
  const hits = tags.map((t) => ({ objectID: t._id, _id: t._id, name: t.name }));
  return [
    searchEntry({ index: "tags", query, page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, source),
    searchEntry({ index: "tags", query, page: 0, hitsPerPage: 10, facetFilters: [] }, { hits, nbHits: n }, source),
    ...tags.map((t) => gqlEntry({ root: "tag", id: t._id }, {
      result: rawTagFull({
        _id: t._id, name: t.name, slug: t.slug, postCount: 10, parentTag: null,
        description: { plaintextDescription: t.description, markdown: t.description, version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 1 },
      }),
    }, source)),
    gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug }, limit: 1 }, { results: [] }, source),
    gqlEntry({ root: "TagPreview", args: { slug } }, null, source),
  ];
}

/**
 * §6.5, ¶3.6: `post longPost000000001` ("Long") by Eliezer Yudkowsky, a public Markdown-type post of 600 short paragraphs, far
 * larger than one page at `max_tokens` 2,000 (the `get_post long` golden's slice paging).
 */
export function longPostEntries(): FixtureEntry[] {
  const markdown = Array.from({ length: 600 }, (_, i) => `Paragraph ${i} of a long post with some words in it.`).join("\n\n");
  const doc = rawPostFull({
    _id: "longPost000000001", title: "Long", slug: "long", userId: EY, user: eyRef(),
    contents: { version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", markdown, originalContents: { type: "markdown" } },
  });
  return [gqlEntry({ root: "post", id: "longPost000000001" }, { result: doc }, "§6.5")];
}

/**
 * ¶3.6, §4.5: a light scan of `view` with `terms` whose one raw page is full: 2,000 public `POST_LIGHT` rows
 * (`lightRow000000000`…) and a `totalCount` over 2,000, so the scan is `too_broad`.
 */
export function fullLightScan(view: string, terms: Record<string, unknown>, totalCount: number): FixtureEntry {
  const rows = Array.from({ length: 2000 }, (_, i) => rawPostLight({ _id: "lightRow" + String(i).padStart(9, "0"), baseScore: 2000 - i }));
  return gqlEntry({ root: "posts", view, terms, limit: 2000, enableTotal: true }, { results: rows, totalCount }, "§4.5, ¶3.6");
}

/**
 * §10.2, §10.6: the `i`th synthetic `TAG_LIST` row of a catalogue or a core grouping: `TagRow00000000001`…, named `Tag 0001`,
 * slugged `tag-1`, an ordinary public tag with no parent and no core tag unless `o` says otherwise.
 */
export function tagRow(i: number, o: Partial<RawTagList> = {}): RawTagList {
  return rawTagList({
    _id: `TagRow${String(i).padStart(11, "0")}`, name: `Tag ${String(i).padStart(4, "0")}`, slug: `tag-${i}`,
    core: false, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false, postCount: 3, coreTagId: null, parentTag: null, ...o,
  });
}

/** `n` synthetic rows, `tagRow(0)`…`tagRow(n - 1)`, each with `o` (the 500-row groupings and 1,010-row catalogues). */
export function tagRows(n: number, o: Partial<RawTagList> = {}): RawTagList[] {
  return Array.from({ length: n }, (_, i) => tagRow(i, o));
}

/** §10.2, Q130: the all-tags view (`allTagsAlphabetical`, limit 2,000) answering `n` synthetic rows. */
export function tagCatalogue(n: number): FixtureEntry {
  return gqlEntry({ root: "tags", view: "allTagsAlphabetical", limit: 2000 }, { results: tagRows(n) }, "§10.2");
}

/** §10.6, Q68: the AI core tag's grouping fixture: `rows` and a `totalCount` that is never shown. */
export function aiGrouping(rows: readonly RawTagList[], totalCount: number): FixtureEntry {
  return gqlEntry({ root: "TagsByCoreTagId", args: { coreTagId: AI_TAG } }, { tags: rows, totalCount }, "§10.6");
}

/**
 * §10.6, P12: five rows of the AI grouping: Interpretability, three rows P12 hides (their names start `PLANTED-P12-`) and the
 * wiki-only page "AI alignment".
 */
export function aiGroupingRows(): RawTagList[] {
  return [
    tagRow(1, { name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai", _id: "56yXXrcxRjrQs6z9R", coreTagId: AI_TAG, postCount: 1608 }),
    tagRow(2, { name: "PLANTED-P12-admin", adminOnly: true, coreTagId: AI_TAG }),
    tagRow(3, { name: "PLANTED-P12-placeholder", wikiOnly: true, isPlaceholderPage: true, coreTagId: AI_TAG }),
    tagRow(4, { name: "PLANTED-P12-deleted", deleted: true, coreTagId: AI_TAG }),
    tagRow(5, { name: "AI alignment", slug: "ai-alignment", wikiOnly: true, postCount: 0, coreTagId: AI_TAG }),
  ];
}

// ---------------- get_tag (¶4.8, §10) ----------------

/** A tagged post card of the get_tag sets: a public LW-only post by Eliezer Yudkowsky with an excerpt, tagged `tagId` with relevance 3. */
function taggedCard(id: string, tagId: string, o: Partial<RawPostCard> = {}): RawPostCard {
  return rawPostCard({ _id: id, af: false, userId: EY, user: eyRef(), tagRelevance: { [tagId]: 3 }, contents: { plaintextDescription: `Excerpt of ${id}.` }, ...o });
}

/**
 * ¶4.8 step 5, ¶3.6: `long-wiki-page` ("Long page", `LongWikiPage00001`), a wiki text of 3,000 short paragraphs (far larger
 * than a page at `max_tokens` 4,000) with three tagged posts and no discussion: get_tag's page-1 budget and its `slice` cursor.
 */
export function longWikiPageEntries(): FixtureEntry[] {
  const id = "LongWikiPage00001";
  const text = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i + 1} of the long page has a few more words in it.`).join("\n\n");
  const page = rawTagFull({
    _id: id, name: "Long page", slug: "long-wiki-page", core: false, wikiOnly: false, parentTag: null, subTags: [], lenses: [], summaries: [],
    arbitalLinkedPages: null,
    description: { markdown: text, version: "1.0.0", editedAt: "2025-01-01T00:00:00.000Z", wordCount: 36000, plaintextDescription: null },
  });
  const posts = [1, 2, 3].map((i) => taggedCard(`LongPagePost0000${i}`, id));
  return [
    gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "long-wiki-page" } }, { results: [page] }, "§10.2"),
    gqlEntry({ root: "TagPreview", args: { slug: "long-wiki-page" } }, { tag: page, lens: null, summaries: [] }, "§10.2"),
    gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: id } }, { results: posts, totalCount: 3 }, "§10.4"),
    gqlEntry({ root: "comments", view: "tagDiscussionComments", terms: { tagId: id } }, { results: [] }, "§10.7"),
  ];
}

/**
 * ¶4.8 step 6, ¶3.6: `deep-new-tag` (`DeepNewTag0000001`) with 2,050 tagged posts a minute apart, the newest posted
 * `2026-10-20T00:00:00.000Z` (`deepNew0000000000`…`deepNew0000002049`): get_tag's first raw page (`limit` 50, so 55 rows) and the
 * 40 keyset windows list_posts opens after it. Window k (1–40) starts after row 50k − 1: rows 50k … 50k + 99, with the rest of the
 * list as its totalCount, so the last window is short and ends the list.
 */
export function deepNewTagEntries(): FixtureEntry[] {
  const tag = "DeepNewTag0000001";
  const t0 = Date.parse("2026-10-20T00:00:00.000Z");
  const at = (i: number): string => new Date(t0 - i * 60_000).toISOString();
  const rows = Array.from({ length: 2050 }, (_, i) => taggedCard(`deepNew${String(i).padStart(10, "0")}`, tag, { postedAt: at(i) }));
  const page = rawTagFull({
    _id: tag, name: "Deep new tag", slug: "deep-new-tag", core: false, wikiOnly: false, parentTag: null, subTags: [], lenses: [], summaries: [],
    arbitalLinkedPages: null,
  });
  const windows = Array.from({ length: 40 }, (_, j) => 40 - j).map((k) => gqlEntry(
    { root: "posts", view: "tagRelevance", terms: { tagId: tag, sortedBy: "new", before: new Date(Date.parse(at(50 * k - 1)) + 1).toISOString() } },
    { results: rows.slice(50 * k, 50 * k + 100), totalCount: 2050 - 50 * k }, "§4.4",
  ));
  return [
    gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "deep-new-tag" } }, { results: [page] }, "§10.2"),
    gqlEntry({ root: "TagPreview", args: { slug: "deep-new-tag" } }, { tag: page, lens: null, summaries: [] }, "§10.2"),
    gqlEntry({ root: "comments", view: "tagDiscussionComments", terms: { tagId: tag } }, { results: [] }, "§10.7"),
    ...windows,
    gqlEntry({ root: "posts", view: "tagRelevance", terms: { tagId: tag, sortedBy: "new" }, limit: 55 }, { results: rows.slice(0, 55), totalCount: 2050 }, "§4.4"),
  ];
}

// ---------------- list_sequences (¶4.10, §11.1) ----------------

/** §11.1: a raw page of the sequences light set (`default` view, limit 1,000, with the total) at `offset`, answering `rows`. */
export function sequenceSetEntry(rows: readonly RawSeqLight[], offset: 0 | 1000 | 2000, totalCount: number): FixtureEntry {
  return gqlEntry({ root: "sequences", view: "default", limit: 1000, offset }, { results: rows, totalCount }, "§11.1");
}

/** `n` public light rows by the default person: ids are `stem` and the row number, zero-padded to 17 characters; `o` is merged into each. */
export function seqLightRows(stem: string, n: number, o: Partial<RawSeqLight> = {}): RawSeqLight[] {
  return Array.from({ length: n }, (_, i) => rawSeqLight({ _id: stem + String(i).padStart(17 - stem.length, "0"), ...o }));
}

/**
 * ¶4.10, ¶3.6: the sequences light set at the most this server reads, 3,000 rows (`SeqBulk0000000000`…), newest first, as
 * three full raw pages (each answering a total of 1,000 or more), and for each of the 60 pages of 50 the hydrate of its ids.
 */
export function fullSequenceSet(): FixtureEntry[] {
  const t0 = Date.parse("2020-01-01T00:00:00.000Z");
  const rows = seqLightRows("SeqBulk", 3000).map((row, i) => ({ ...row, createdAt: new Date(t0 + (3000 - i) * 60_000).toISOString() }));
  const hydrates = Array.from({ length: 60 }, (_, page) => {
    const ids = rows.slice(page * 50, page * 50 + 50).map((r) => r._id);
    return gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: ids } }, { results: ids.map((id) => rawSeqCard({ _id: id, title: id })) }, "§11.1");
  });
  return [
    sequenceSetEntry(rows.slice(0, 1000), 0, 3000), sequenceSetEntry(rows.slice(1000, 2000), 1000, 2000), sequenceSetEntry(rows.slice(2000), 2000, 1000),
    ...hydrates,
  ];
}

// ---------------- get_history (¶4.11, §7.2) ----------------

/** One raw page of a synthetic version list: its `offset` or keyset `before` bound, its row count, its total and its newest row's time. */
interface RevisionPageSpec { offset?: number; before?: string; rows: number; totalCount: number; startMs: number }

/**
 * ¶4.11 steps 2–3, Q26: the raw pages of a post's `contents` history (`revisionsOnDocument`), one entry per page in the order
 * `pages` gives them (an entry with `before` must come before the offset entries, whose terms are a subset of its own). The rows of
 * a page are a minute apart, newest first from `startMs`; row k is `Rev<the first 4 characters of docId><startMs / 60,000 − k in 10
 * digits>`, version `1.<that number>.0`, a public `minor` edit with a change count of +1/−0.
 */
export function revisionHistory(docId: string, pages: readonly RevisionPageSpec[]): FixtureEntry[] {
  return pages.map((p) => {
    const terms = p.before ? { documentId: docId, fieldName: "contents", before: p.before } : { documentId: docId, fieldName: "contents" };
    const results = Array.from({ length: p.rows }, (_, i) => {
      const n = p.startMs / 60_000 - i;
      return rawRevRow({
        _id: `Rev${docId.slice(0, 4)}${String(n).padStart(10, "0")}`, documentId: docId, collectionName: "Posts",
        version: `1.${n}.0`, editedAt: new Date(p.startMs - i * 60_000).toISOString(), updateType: "minor", commitMessage: "",
        changeMetrics: { added: 1, removed: 0 },
      });
    });
    return gqlEntry(
      { root: "revisions", view: "revisionsOnDocument", terms, ...(p.offset !== undefined ? { offset: p.offset } : {}) },
      { results, totalCount: p.totalCount }, "§7.2",
    );
  });
}

// ---------------- get_history phrases and wiki edits (¶4.11 steps 2 and 8, §7.1, §7.2) ----------------

/**
 * ¶4.11 step 8: "A long history" (`LongIntroPost0001`), published 2020-01-01, with 500 public versions an hour apart from
 * 1 s after publication (row k: `IntroRev` and k in 9 digits, version `1.<k>.0`), and the text of each, `markdown(k)`: by
 * default "rare phrase" first appears in v1.333.0. Request 1, the version list (newest first, all listed) and the 500 texts.
 */
export function longIntroHistory(
  markdown: (k: number) => string = (k) => (k >= 333 ? "This text has the rare phrase now." : "This text lacks it."),
): FixtureEntry[] {
  const doc = "LongIntroPost0001";
  const posted = Date.parse("2020-01-01T00:00:00.000Z");
  const rows = Array.from({ length: 500 }, (_, k) => rawRevRow({
    _id: `IntroRev${String(k).padStart(9, "0")}`, documentId: doc, collectionName: "Posts", version: `1.${k}.0`,
    editedAt: new Date(posted + 1000 + k * 3_600_000).toISOString(), updateType: k === 0 ? "initial" : "minor", commitMessage: "",
    changeMetrics: { added: 1, removed: 0 },
  })).reverse();
  const post = { ...rawPostRef({ _id: doc, title: "A long history" }), postedAt: new Date(posted).toISOString(), contents: { version: "1.499.0", editedAt: rows[0].editedAt } };
  return [
    gqlEntry({ root: "post", id: doc }, { result: post }, "§7.2"),
    gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: doc, fieldName: "contents" } }, { results: rows, totalCount: 500 }, "§7.2"),
    ...rows.map((row) => gqlEntry({ root: "revision", id: row._id }, {
      result: {
        _id: row._id, documentId: doc, fieldName: "contents", version: row.version, editedAt: row.editedAt, wordCount: 5,
        markdown: markdown(Number(row.version.split(".")[1])),
      },
    }, "§7.4")),
  ];
}

/**
 * ¶4.11 step 2, §7.1: one raw page of a person's wiki edits, 1,000 public edits of the AI page by `user`, a minute apart and
 * newest first from 2024-01-01 less `from` minutes; row k is `stem` and `from + k` zero-padded to 17 characters, version
 * `2.<from + k>.0`, with the page joins `revisionsByUser` selects.
 */
export function wikiEditRows(stem: string, from: number, user: RawUserRef = rawUserRef()): RawRevRow[] {
  const start = Date.parse("2024-01-01T00:00:00.000Z");
  return Array.from({ length: 1000 }, (_, i) => rawRevRow({
    _id: stem + String(from + i).padStart(17 - stem.length, "0"), documentId: AI_TAG, collectionName: "Tags",
    version: `2.${from + i}.0`, editedAt: new Date(start - (from + i) * 60_000).toISOString(), updateType: "minor", commitMessage: "",
    changeMetrics: { added: 1, removed: 0 }, userId: user._id, user, tag: aiTag(), lens: null, summary: null,
  }));
}

// ---------------- get_user (¶4.7, §9.2, §16) ----------------

const AXEL = "EE3myGHTpvb8h9hb5";
/** Axel Højmark, the person of ¶5b example 5. */
export const axelRef = (): RawUserRef => rawUserRef({ _id: AXEL, slug: "axel-hojmark", displayName: "Axel Højmark" });

/**
 * ¶4.7 step 7, §16: Axel's AF view. One AF top post, no AF latest post, his latest comments as a light scan of three rows of which
 * only the second is on AF, and the hydrate of that one.
 */
export function axelAfOnlyEntries(): FixtureEntry[] {
  const lights = [1, 2, 3].map((n) => rawCommentLight({ _id: `AxelLight0000000${n}`, af: n === 2, userId: AXEL, postedAt: `2026-10-0${6 - n}T00:00:00.000Z` }));
  return [
    gqlEntry(
      { root: "posts", view: "userPosts", terms: { userId: AXEL, sortedBy: "top", af: true } },
      { results: [rawPostCard({ _id: "AxelAfTop00000001", title: "An AF post by Axel", slug: "an-af-post-by-axel", af: true, userId: AXEL, user: axelRef() })] }, "§16",
    ),
    gqlEntry({ root: "posts", view: "userPosts", terms: { userId: AXEL, sortedBy: "new", af: true } }, { results: [] }, "§16"),
    gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: AXEL, sortBy: "new" }, limit: 500 }, { results: lights }, "§16"),
    gqlEntry(
      { root: "comments", view: "default", terms: { commentIds: ["AxelLight00000002"] } },
      { results: [rawCommentList({ _id: "AxelLight00000002", af: true, afBaseScore: 4, userId: AXEL, user: axelRef(), postedAt: "2026-10-04T00:00:00.000Z" })] },
      "§8.1",
    ),
  ];
}

/** §4.8: the hydrate of Axel's four pinned posts fails with a resolver error. */
export function axelPinnedFailure(): FixtureEntry {
  return {
    source: "§4.8",
    match: {
      root: "posts", view: "default",
      terms: { exactPostIds: ["AxelPinnedPost001", "AxelUnlistedPin01", "AxelEventPin00001", "AxelSubQPin00001x"] },
    },
    error: { message: "Something went wrong" },
  };
}

/** §9.8, P8: a deleted account; the forum refuses its profile. */
export function deletedUserRefusal(): FixtureEntry {
  return { source: "§9.8", match: { root: "user", id: "DeletedUserId0001" }, error: { message: "app.operation_not_allowed" } };
}

/** ¶4.7 Paging: Axel's profile with a bio of 3,000 sentences (far over the 3,000-token bio cap) and no pinned posts. */
export function axelLongBioProfile(): FixtureEntry {
  const bio = Array.from({ length: 3000 }, (_, i) => `Bio sentence ${i + 1} about research interests.`).join(" ");
  return gqlEntry({ root: "user", id: AXEL }, {
    result: rawUserProfile({
      _id: AXEL, slug: "axel-hojmark", displayName: "Axel Højmark", createdAt: "2023-02-01T00:00:00.000Z", karma: 120, afKarma: 56,
      postCount: 4, commentCount: 7, groups: ["alignmentForum"], pinnedPostIds: [],
      biography: { plaintextDescription: "Bio sentence 1", markdown: bio, wordCount: 18000, editedAt: "2025-01-01T00:00:00.000Z" },
    }),
  }, "§9.2");
}

/** L9, §12: the lens backlinks of the interpretability page fail (the `pingbackLensPages` view was not probed), the wiki-page backlinks do not. */
export function lensBacklinksFailure(): FixtureEntry {
  return {
    source: "§12",
    match: { root: "multiDocuments", view: "pingbackLensPages", terms: { documentId: "56yXXrcxRjrQs6z9R" } },
    error: { message: "Something went wrong" },
  };
}

// ---------------- get_reactions (¶4.14, §13.3) ----------------

/**
 * §13.3, ¶3.6: `manyReactsCmnt001`, Alice's comment on AGI Ruin (LW only, 50 karma from 30 votes), whose `extendedScore` holds 40
 * reactions `react01`…`react40`, each added by Alice and anchored to a long passage (cut to 200 characters by `parseReactions`):
 * far more than one page of `get_reactions` at `max_tokens` 2,000, so its `slice` cursor continues the text.
 */
export function manyReactionsEntries(): FixtureEntry[] {
  const alice = rawUserRef({ _id: "aliceUserId000001", slug: "alice", displayName: "Alice" });
  const reacts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const quote = `Passage ${n} that readers anchored this reaction to, ` + "with enough words to fill a line. ".repeat(4);
    return [`react${String(n).padStart(2, "0")}`, [{ userId: alice._id, displayName: "Alice", karma: 512, reactType: "created", quotes: [quote] }]];
  }));
  const comment = rawCommentList({
    _id: "manyReactsCmnt001", userId: alice._id, user: alice, af: false, baseScore: 50, voteCount: 30, afBaseScore: 0, extendedScore: { reacts },
  });
  return [gqlEntry({ root: "comment", id: "manyReactsCmnt001" }, { result: withExtra(comment, { afVoteCount: 0 }) }, "§13.3")];
}
