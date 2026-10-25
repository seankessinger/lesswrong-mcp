// ===================== src/types.ts =====================
import type { ZodObject, ZodRawShape } from "zod";

// ---------- names and enums
export type ToolName =
  | "find" | "search" | "get_post" | "get_comments" | "list_posts" | "list_comments"
  | "get_user" | "get_tag" | "get_sequence" | "list_sequences" | "get_history"
  | "first_use" | "get_links" | "get_reactions" | "get_feed" | "list_tags";
export type Category =
  | "bad_input" | "bad_cursor" | "not_found" | "not_public" | "login_only" | "too_broad"
  | "rate_limited" | "politeness_cap" | "timeout" | "forum_error" | "internal";
export type StopReason = "time limit" | "request cap";
export type EntityKind = "post" | "comment" | "user" | "tag" | "sequence" | "revision";
export type KindValue = "post" | "comment" | "user" | "tag" | "sequence";
export type CollectionSlug = "rationality" | "codex" | "hpmor" | "highlights" | "bestoflesswrong";
export type SortValue =
  | "top" | "af_top" | "new" | "old" | "active" | "tag_relevance" | "curated_date"
  | "relevance" | "largest" | "contested" | "site_order";
export type FeedName =
  | "frontpage" | "recent_discussion" | "popular_comments" | "quick_takes" | "this_week"
  | "wiki_activity" | "dialogues" | "best_of" | "spotlight";

// ---------- identifiers (¶3.1)
export interface ParsedRef {
  kind: EntityKind;
  form: "id" | "slug" | "idOrSlug" | "legacy" | "collection" | "word" | "item";
  value: string;            // id | slug | base-36 legacy id | collection slug | "original"/"current"/"previous" | N of "item:N"
  given: "id" | "url" | "slug" | "word";
  notes: string[];          // echo notes, e.g. "commentId ignored; pass it as comment to target the comment"
  postPart?: string;        // sequence refs from /s/<seq>/p/<post>: that post id
}
export type ResolvedKind = "post" | "comment" | "user" | "tag" | "lens" | "summary" | "sequence" | "collection";
export interface Resolved {
  kind: ResolvedKind;
  id: string;               // the entity _id (a collection: its hard-coded id)
  slug?: string;
  name: string;             // sanitized title or display name
  display: string;          // echo text after "<param> → ", e.g. `"AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc) by "Eliezer Yudkowsky"`
  notes: string[];          // e.g. `lens bayes-rule-guide → page "Bayes' rule"`
  af?: boolean;
  pageId?: string;          // lens or summary: its page's tag id (P12 pageOf)
  /**
   * A lens or summary: the echo notes of ¶3.1.2's exception, for a tool that opens the part itself (`own`: `lens_slug X of
   * page "…"`, `summary_id X of [lens "…" (lens_slug …) of ]page "…"`) or the lens a summary belongs to (`lens`: `summary_id X
   * → lens "…" (lens_slug …) of page "…"`; absent for a page's own summary and for a lens, which opens as itself).
   */
  part?: { own: string; lens?: string };
  doc?: unknown;            // the raw document of the selection that first resolved it; from the cache, rely only on the kind's reference fields
}

// Ids confirmed public in this call; only CallContext.confirmPublic creates them (P17).
declare const publicBrand: unique symbol;
export type PublicKind = "post" | "comment" | "tag" | "sequence" | "doc" | "revision";
export type PublicId<K extends PublicKind> = string & { readonly [publicBrand]: K };
export type PublicPostId = PublicId<"post">;
export type PublicTagId = PublicId<"tag">;
export type PublicSequenceId = PublicId<"sequence">;
export type PublicDocId = PublicId<"doc">;            // post, comment, tag, lens or summary whose revision list may be read
export type PublicRevisionId = PublicId<"revision">;  // an id from a confirmed document's visible revision list

// ---------- raw forum documents: exactly the fields of the ¶4.0 fragments (fragments.ts)
export interface RawUserRef { _id: string; slug: string | null; displayName: string | null }
export interface RawPostRef {                                   // POST_REF
  _id: string; title: string; slug: string; af: boolean; question: boolean; rejected: boolean;
  unlisted: boolean; shortform: boolean; hideAuthor: boolean; isEvent: boolean;
  hiddenRelatedQuestion: boolean; groupId: string | null;
}
export interface RawCommentRef {                                // COMMENT_REF
  _id: string; postId: string | null; tagId: string | null; userId: string | null; postedAt: string;
  af: boolean; deleted: boolean; deletedPublic: boolean; deletedReason: string | null; rejected: boolean;
  authorIsUnreviewed: boolean; hideAuthor: boolean; hideKarma: boolean; debateResponse: boolean | null;
  user: RawUserRef | null;
}
export interface RawTagRef {                                    // TAG_REF
  _id: string; name: string; slug: string; core: boolean; wikiOnly: boolean; adminOnly: boolean;
  deleted: boolean; isPlaceholderPage: boolean;
}
export interface RawSeqRef { _id: string; title: string; af: boolean; hidden: boolean }   // SEQ_REF
export interface RawLensRef {                                   // MDOC_REF's written-out parentLens
  _id: string; slug: string; title: string | null; tabTitle: string; fieldName: string; deleted: boolean;
  parentTag: RawTagRef | null;
}
export interface RawMdocRef {                                   // MDOC_REF
  _id: string; slug: string; title: string | null; tabTitle: string; fieldName: "description" | "summary" | string;
  collectionName: "Tags" | "MultiDocuments" | string; deleted: boolean;
  parentTag: RawTagRef | null; parentLens: RawLensRef | null;
}
export interface RawPostCard extends RawPostRef {               // POST_CARD (+ contents for POST_CARD_EXCERPT)
  postedAt: string; baseScore: number; voteCount: number; afBaseScore: number | null; commentCount: number;
  afCommentCount: number; url: string | null; debate: boolean; collabEditorDialogue: boolean;
  curatedDate: string | null; frontpageDate: string | null; sticky: boolean; legacy: boolean;
  lastCommentedAt: string | null; userId: string | null; user: RawUserRef | null; coauthors: RawUserRef[] | null;
  tags: RawTagRef[]; tagRelevance: Record<string, number> | null;
  reviewWinner: { reviewYear: number; category: string; reviewRanking: number } | null;
  contents?: { plaintextDescription: string | null } | null;
}
export interface RawPostLight {                                  // POST_LIGHT
  _id: string; postedAt: string; baseScore: number; afBaseScore: number | null; af: boolean;
  curatedDate: string | null; frontpageDate: string | null; question: boolean; isEvent: boolean; shortform: boolean;
  unlisted: boolean; rejected: boolean; hideAuthor: boolean; hiddenRelatedQuestion: boolean; groupId: string | null;
  userId: string | null; coauthorUserIds: string[]; tagRelevance: Record<string, number> | null;
}
export interface RawGlossaryTerm { _id: string; term: string; approved: boolean; deleted: boolean; contents: { markdown: string | null } | null }
export interface RawPostFull extends Omit<RawPostCard, "contents"> {   // POST_FULL
  hideCommentKarma: boolean; onlyVisibleToLoggedIn: boolean; linkUrl: string | null;
  extendedScore: unknown; reviewCount: number; finalReviewVoteScoreHighKarma: number;
  finalReviewVoteScoreAF: number; canonicalSequenceId: string | null; canonicalCollectionSlug: string | null;
  canonicalSequence: (RawSeqRef & { canonicalCollectionSlug: string | null }) | null;
  contents: { version: string; editedAt: string; markdown: string | null; originalContents: { type: string } | null } | null;
  bestAnswer: (RawCommentRef & { baseScore: number | null }) | null;
  sourcePostRelations: { sourcePost: RawPostRef | null }[];
  targetPostRelations: { targetPost: RawPostRef | null }[];
  glossary: RawGlossaryTerm[];
}
export interface RawCommentTree extends RawCommentRef {          // COMMENT_TREE (+ body fields when merged with COMMENT_BODY / COMMENT_LIST)
  parentCommentId: string | null; topLevelCommentId: string | null; answer: boolean;
  lastEditedAt: string | null; baseScore: number | null; voteCount: number; afBaseScore: number | null;
  extendedScore: unknown; retracted: boolean; moderatorHat: boolean; reviewingForReview: string | null;
  shortform: boolean | null; isPinnedOnProfile: boolean;
  contents: { wordCount?: number | null; markdown?: string | null } | null;
}
export interface RawCommentList extends RawCommentTree {         // COMMENT_LIST
  post: RawPostRef | null; tag: RawTagRef | null; parentComment: RawCommentRef | null;
}
export interface RawCommentLight { _id: string; af: boolean; postedAt: string; baseScore: number | null; hideKarma: boolean; userId: string | null }
export interface RawUserCard {                                   // USER_CARD (+ help texts in search hydration)
  _id: string; slug: string; displayName: string; createdAt: string; karma: number; afKarma: number;
  postCount: number; commentCount: number; groups: string[] | null; jobTitle: string | null;
  organization: string | null; deleted: boolean;
  biography: { plaintextDescription?: string | null; markdown?: string | null; wordCount?: number; editedAt?: string } | null;
  howOthersCanHelpMe?: { markdown: string | null } | null; howICanHelpOthers?: { markdown: string | null } | null;
}
export interface RawUserProfile extends RawUserCard {            // USER_PROFILE
  website: string | null; twitterProfileURL: string | null;
  githubProfileURL: string | null; linkedinProfileURL: string | null; blueskyProfileURL: string | null;
  facebookProfileURL: string | null; pinnedPostIds: string[];
}
export interface RawTagCard extends RawTagRef { postCount: number; parentTag: RawTagRef | null; description?: { plaintextDescription?: string | null } | null }
export interface RawTagList extends RawTagRef { postCount: number; coreTagId: string | null; parentTag: RawTagRef | null }
interface RawArbitalPage { _id: string; name: string; slug: string }
export type ArbitalRelation = "parents" | "children" | "requirements" | "teaches" | "faster" | "slower" | "moreTechnical" | "lessTechnical";
export interface RawTagFull extends Omit<RawTagCard, "description"> {   // TAG_FULL
  coreTagId: string | null; baseScore: number; voteCount: number;
  extendedScore: unknown;
  description: { plaintextDescription?: string | null; markdown: string | null; version: string; editedAt: string; wordCount: number } | null;
  subTags: RawTagRef[];
  lenses: { _id: string; slug: string; title: string | null; tabTitle: string; deleted: boolean; contents: { wordCount: number } | null }[];
  summaries: { _id: string; deleted: boolean; tabTitle: string; contents: { markdown: string | null } | null }[];
  arbitalLinkedPages: Record<ArbitalRelation, RawArbitalPage[] | null> | null;
}
export interface RawSeqCard extends RawSeqRef {                  // SEQ_CARD
  createdAt: string; canonicalCollectionSlug: string | null; curatedOrder: number | null;
  postsCount: number; user: RawUserRef | null; contents: { plaintextDescription?: string | null; markdown?: string | null } | null;
}
export interface RawSeqLight {                                   // SEQ_LIGHT
  _id: string; createdAt: string; af: boolean; hidden: boolean; userId: string; curatedOrder: number | null;
  userProfileOrder: number | null; hideFromAuthorPage: boolean;
}
export interface RawRevRow {                                     // REV_ROW (+ page joins in revisionsByUser and the feeds)
  _id: string; documentId: string; collectionName: string | null; version: string;
  editedAt: string; updateType: "initial" | "major" | "minor" | "patch" | null; commitMessage: string | null;
  changeMetrics: { added?: number; removed?: number } | null; wordCount: number; userId: string | null;
  user: RawUserRef | null; tag?: RawTagRef | null; lens?: RawMdocRef | null; summary?: RawMdocRef | null;
}
export interface RawChapter { _id: string; title?: string | null; number: number | null; posts: (RawPostRef & Partial<RawPostCard>)[] }
export interface RawBook { _id: string; title: string | null; number: number | null; postedAt: string; sequenceIds: string[]; sequences: (RawSeqRef & Partial<RawSeqCard>)[] }
export interface RawCollection { _id: string; slug: string; title: string; contents?: { markdown: string | null } | null; books: RawBook[] }

// ---------- people and references (domain/visibility masks; render prints)
export type Person =
  | { kind: "user"; id: string; slug: string | null; name: string }
  | { kind: "none"; why: "comment placeholder" | "author not publicly visible" | "account not publicly visible" };
export interface VisiblePostRef { hidden: false; id: string; title: string; slug: string; af: boolean; event: boolean; unlisted: boolean; question: boolean; shortform: boolean }
export type PostRef = VisiblePostRef | { hidden: true };
export interface VisibleTagRef { hidden: false; id: string; name: string; slug: string; wikiOnly: boolean }
export type TagRef = VisibleTagRef | { hidden: true };
interface VisibleSeqRef { hidden: false; id: string; title: string; af: boolean; hiddenFromLists: boolean }
export type SeqRef = VisibleSeqRef | { hidden: true };
export interface WikiEditPage {                                  // the page and part a wiki edit touched (¶4.7 step 6)
  part: "page" | "lens" | "summary" | "lens summary";
  page: VisibleTagRef;
  lens?: { slug: string; title: string };
  summaryId?: string;
}

// ---------- records (domain normalizes, render prints)
export interface StatusFlags {
  curatedDate?: string; frontpage: boolean; pinned: boolean;
  bestOf?: { year: number; category: string; rank: number };    // rank = reviewRanking + 1
  question: boolean; linkUrl?: string; dialogue: boolean; debate: boolean; event: boolean; shortform: boolean;
  subQuestion: boolean; groupPost: boolean; unlisted: boolean; placeholderDate: boolean;
}
export interface PostRecord {
  id: string; title: string; url: string;
  authors: Person[];                 // owner first, then coauthors; [{kind:"none", why:"author not publicly visible"}] under hideAuthor (P7)
  postedAt: string; postedMs: number; karma: number; votes: number;
  af: boolean; afKarma: number | null; commentCount: number; afCommentCount: number;
  status: StatusFlags; lastCommentedAt?: string;
  tags: { tag: VisibleTagRef; relevance: number }[];   // visible tags, relevance high → low
  excerpt?: string;                  // ≤ 280 characters, ending "…" when cut
}
export type Place =
  | { kind: "post"; post: VisiblePostRef }
  | { kind: "tag"; tag: VisibleTagRef }
  | { kind: "quick take"; post: VisiblePostRef }
  | { kind: "hidden post" }
  | { kind: "hidden tag" };
export type ParentRef =
  | { kind: "none" }
  | { kind: "comment"; id: string; af: boolean; author: Person }   // author kind "none" → "reply to a comment whose author is not publicly visible"
  | { kind: "deleted"; id: string }                                // "reply to a comment placeholder"
  | { kind: "hidden" };                                            // "parent comment not publicly visible"
export interface ReactEntry { name: string; net: number; created: Reactor[]; seconded: Reactor[]; disagreed: Reactor[]; quotes: string[] }
export interface Reactor { userId?: string; name?: string }
export interface Reactions { reacts: ReactEntry[]; agreement?: { score: number; votes: number }; likers: Reactor[]; hasVoteData: boolean }
export interface CommentRecord {
  id: string; author: Person; postedAt: string; postedMs: number; edited: boolean;
  karma: number | null; votes: number | null; afKarma: number | null;   // all null under hidden karma (P18)
  karmaHidden: boolean; af: boolean; reactions: Reactions;
  parentId: string | null; rootId: string;
  answer: boolean; retracted: boolean; moderatorHat: boolean; reviewYear?: string; quickTake: boolean;
  pinnedOnProfile: boolean; debateTurn: boolean;
  placeholder?: { reason: string | null };   // publicly deleted (P5): no author, no body
  wordCount: number; body?: string;          // Markdown once fetched; never for placeholders
  place?: Place; parent?: ParentRef;         // list form only
}
export interface TreeNode { c: CommentRecord; children: TreeNode[]; orphan: boolean; debateReplyTo?: Person }
export interface Thread {
  rootId: string; root: TreeNode; answer: boolean; nodes: TreeNode[];   // nodes in reading order (depth-first, siblings by postedAt)
  size: number; participants: number; rootKarma: number | null; rootAfKarma: number | null;
  af: boolean; postedMs: number; newestMs: number; contested: number;
}
export interface Forest {
  threads: Thread[]; byId: ReadonlyMap<string, TreeNode>; count: number; afCount: number;
  postAf: boolean; hideCommentKarma: boolean; hasVoteData: boolean; truncated: boolean;   // truncated: a list returned exactly 5000 rows
}
export interface RankedThread { thread: Thread; label: string; rank: number }   // label "T3" or "A1"; rank 1-based
export interface UserRecord {
  id: string; slug: string; name: string; createdAt: string; karma: number; afKarma: number; afMember: boolean;
  postCount: number; commentCount: number; job?: string; org?: string; bioExcerpt?: string;
}
export interface UserProfile extends UserRecord {
  bio?: string; helpOthers?: string; helpMe?: string; links: { label: string; url: string }[]; pinnedPostIds: string[];
}
export interface TagRecord {
  id: string; slug: string; name: string; pageType: "tag" | "core tag" | "wiki-only page" | "placeholder page";
  postCount: number; parent?: VisibleTagRef; coreTagId?: string; excerpt?: string;
}
export interface SequenceRecord {
  id: string; title: string; author: Person; af: boolean; hiddenFromLists: boolean; createdAt: string;
  postsCount: number; curatedOrder: number | null; collectionSlug?: string; excerpt?: string;
}
export type RevisionLabel =
  | "2019 import snapshot" | "image copy to CDN" | "forum change count +0/−0 chars (the text may still have changed)"
  | "before publication" | "version number repeats";
export interface RevisionDoc { kind: "post" | "comment" | "tag" | "lens" | "summary"; id: string; hideAuthor: boolean; postedAt?: string; af?: boolean }
export interface RevisionRecord {
  id: string; version: string; editedAt: string; editedMs: number;
  kind: "first version" | "published" | "edit" | "small automatic save" | "2019 import snapshot" | null;
  editor?: Person;                   // omitted on hideAuthor documents (P7)
  change?: { added: number; removed: number }; wordCount: number; labels: RevisionLabel[];
  cdnCopiesFolded: number; page?: WikiEditPage;
}

// ---------- dates and phrases
export interface DateRange { start?: number; endExclusive?: number; clampedTo?: number }   // epoch ms; clampedTo = now when date_to was clamped
export interface ClassifiedPhrase { given: string; sent: string; mode: "exact" | "rewritten" | "loose"; needle: string }

// ---------- forum transport
export interface GqlOp {
  template: string;                  // snake_case template name; operationName when first in a request
  alias: string;                     // unique within one gql() call
  text: string;                      // `<alias>: <root>(<args>) <selection>` with inline literals and fragment spreads
  isolate?: true;                    // non-null root: its own operation of an array batch (R6)
  publicSubject?: PublicKind;        // excluded path (P17): built only from a Public*Id
  ttlMs?: number;                    // raw-response cache TTL override (feeds)
}
export type AliasResult = { data: unknown } | { error: Category; message: string };
export type AliasResults = ReadonlyMap<string, AliasResult>;
export interface HttpConfig {
  graphqlUrl: string; searchUrl: string; userAgent: string;
  spacingMs: number; maxSpacingMs: number; halveAfterSuccesses: number;
  retryDelayMs: number; retryJitter: number;
  retryAfterCapMs: number; pausesMs: readonly number[]; episodeResetMs: number;
  inCallRetryMaxWaitMs: number; inCallRetriesMax: number;
  requestTimeoutMaxMs: number; maxResponseBytes: number;
  sessionWindows: readonly { ms: number; requests: number; bytes: number; label: string }[];
  responseTtlMs: number;
}
export interface HttpRequest { endpoint: "graphql" | "search"; body: string; label: string; task: string; ttlMs?: number }
export interface HttpResponse { status: number; text: string; ms: number; bytes: number; cached: boolean; cacheKey: string }
export interface LruLike { get(key: string): unknown; set(key: string, value: unknown, ttlMs: number): void; delete(key: string): void }
export interface HttpDeps {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; random: () => number;
  config: HttpConfig; cache: LruLike; log: Log;
}
export interface Http { fetch(req: HttpRequest, ctx: CallContext): Promise<HttpResponse>; evict(keys: readonly string[]): void }

// ---------- search (¶4.2, §5)
export type SearchIndex = "posts" | "comments" | "users" | "tags" | "sequences";
export type SearchSort = "relevance" | "new" | "old" | "top";
export type Facet =
  | { field: "af"; value: true }
  | { field: "userId"; value: string }
  | { field: "tags._id"; value: string; negate?: true }
  | { field: "postId.keyword"; value: string }
  | { field: "tags"; value: string }
  | { field: "wikiOnly"; value: true };
export interface SearchSpec {
  index: SearchIndex; sort: SearchSort;
  query?: string;                            // already sanitized (text/phrases.sanitizeQuery)
  phrases?: readonly ClassifiedPhrase[];     // exact/rewritten → quoted; loose → plain words
  exclude?: readonly string[];               // "-word" unless every phrase is loose
  facets?: readonly Facet[]; range?: DateRange;   // range only on posts and comments
  page: number; hitsPerPage?: number;        // default and maximum: CONFIG.search.hitsPerPage[index]
}
export interface EsQuery {
  indexName: string;
  params: { query: string; hitsPerPage: number; page: number; facetFilters?: string[][]; numericFilters?: string[]; highlightPreTag: "**"; highlightPostTag: "**" };
}
export interface SearchHit {
  objectID: string; _id?: string;
  _snippetResult?: Record<string, { value: string }>;
  [field: string]: unknown;
}
export interface SearchResult {
  hits: SearchHit[]; nbHits: number; page: number; nbPages: number | null; hitsPerPage: number; index: string;
  ended?: true;                              // the forum answered "Result window is too large…" (¶8): the stream ends, not an error
}

// ---------- paging and cursors (¶3.6)
export interface Fingerprint { count: number; newestMs: number }
export type StreamState =                    // every variant carries `shown`: items of this stream already shown on earlier pages
  | { kind: "offset"; shown: number; offset: number; lastId?: string }
  | { kind: "keyset"; shown: number; dir: "new" | "old"; boundaryMs: number | null; idsAtBoundary: string[]; windowOffset: number }
  | { kind: "feed"; shown: number; cutoff: string | null; endOffset: number; index: number }
  | { kind: "search"; shown: number; page: number; index: number }
  | { kind: "list"; shown: number; index: number; lastId?: string; fingerprint?: Fingerprint }
  | { kind: "slice"; shown: number; block: number; offset: number; version?: string };
export interface CursorState { streams: StreamState[]; current: number; data?: Record<string, unknown> }   // data: ids, numbers, intervals only; never forum text
export interface CursorEntry {
  tool: ToolName; args: Readonly<Record<string, unknown>>; effective: Readonly<Record<string, unknown>>;
  state: CursorState; issuedAt: number;
}
export interface CursorStore {
  issue(tool: ToolName, args: Record<string, unknown>, effective: Record<string, unknown>, state: CursorState): string;
  take(tool: ToolName, token: string): CursorEntry;            // ToolError bad_cursor when malformed, unknown, expired or foreign
}

// ---------- rendering (¶3.7)
export type Footer =
  | { kind: "end" }
  | { kind: "more"; tool: ToolName; cursor: string; next: string; drift?: true }  // next e.g. "items 11–20", "threads 5–8", "text from 31 %"; drift appends C-DRIFT
  | { kind: "reachable"; reason: string }
  | { kind: "stopped"; why: StopReason; tool: ToolName; cursor: string; drift?: true };
export interface PageItem {           // fitting rule 3 applies to every first item that does not fit (no per-item flag)
  text: string;                      // a rendered record, or forum text when `fence` is set
  fence?: string;                    // label: printed inside "--- begin text <nonce> (<fence>; written by forum users) ---" … "--- end text <nonce> ---"
  from?: number;                     // first item only: character offset to resume a sliced item at
  header?: string;                   // first item only: repeated before a continuation slice (thread header, chapter header)
}
export interface CappedBlock { key: string; title: string; lines: readonly string[]; share: number; from?: number }   // outline 0.25, signals 0.15, reply map 0.25
export interface TrailingBlock {     // printed after the items, room reserved before them, ending "and N more" (get_comments outline, ¶4.4 step 14)
  title: string; share: number;
  lines: (c: Consumed) => readonly string[];       // pure: called more than once
}
export interface Consumed { items: number; sliceTo?: number; blocks: Readonly<Record<string, number>> }   // items shown whole; offset reached in a sliced item; per capped block, the line index it resumes at (from + lines shown)
export interface PageSpec {
  tool: ToolName;
  subject: string;                                // first line: "<tool> — <subject>"
  request: readonly string[];                     // "Request: " + parts joined " · "
  position?: string | ((c: Consumed) => string);  // omitted when the reply is one item shown whole (see `oneItem`)
  /**
   * Whether the reply is one item of its list (¶3.7: Position is left out only when the reply is one item shown whole, that
   * is, every item of the page shown whole from its start). Default: the page has one item. A tool whose items are not its
   * list's units says so: `get_comments` counts threads but pages comments, so one comment can be one of many threads.
   */
  oneItem?: boolean;
  notes: readonly string[];                       // caveat texts, printed once each after "Notes: "
  head: readonly string[];                        // always shown, reserved first
  blocks?: readonly CappedBlock[];
  items: readonly PageItem[];
  trailing?: TrailingBlock;                       // after the items, before the tail
  tail?: readonly string[];                       // shown after the items only if room remains
}
export interface Rendered { text: string; consumed: Consumed }

// ---------- one tool call
export interface CallContext {
  readonly tool: ToolName;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly maxRequests: number;
  readonly given: ReadonlySet<string>;            // parameter names present in the call's arguments
  requestsUsed: number;
  bytesUsed: number;
  cacheKeys: string[];                            // raw-response keys this call stored or read from the cache
  stopped?: StopReason;                           // set when mayStartRequest() first returns false
  now(): number;
  mayStartRequest(): boolean;                     // false once 40 s have passed, requestsUsed ≥ maxRequests, or bytesUsed ≥ 20 MB
  beginRequest(): void;                           // throws CallStopped(reason) when !mayStartRequest(); else requestsUsed += 1
  beginRetry(): void;                             // ¶7: a transport retry of the same request is not charged: throws CallStopped only past 40 s or 20 MB
  requestTimeoutMs(): number;                     // min(45_000, 50_000 − elapsed)
  charge(bytes: number): void;
  confirmPublic<K extends PublicKind>(kind: K, id: string): PublicId<K>;
  isConfirmed(kind: PublicKind, id: string): boolean;
}
export type CacheNs =
  | "resolve" | "negative" | "forest" | "body" | "rev" | "revuser" | "revtext" | "scan" | "seqset"
  | "tagcat" | "coregroup" | "collections" | "winners" | "feed" | "spotlight";
export interface Caches {
  get<T>(ns: CacheNs, key: string): T | undefined;
  set<T>(ns: CacheNs, key: string, value: T, ttlMs?: number): void;   // default TTL: CONFIG.cache.ttlMs[ns]
  delete(ns: CacheNs, key: string): void;
}
export interface Log {
  request(e: { label: string; status: number; ms: number; bytes: number; cached: boolean }): void;
  debug(message: string, counts?: Readonly<Record<string, number>>): void;
  info(message: string): void;
  error(message: string): void;
}
export interface Services {
  gql(ops: readonly GqlOp[], ctx: CallContext, task: string): Promise<AliasResults>;
  search(queries: readonly EsQuery[], ctx: CallContext, task: string, emptyString?: "empty" | "default"): Promise<SearchResult[]>;
  caches: Caches;
  cursors: CursorStore;
  evictResponses(keys: readonly string[]): void;
  now(): number;
  nonce(): string;                                // 6 lowercase hex characters, fresh per reply
  log: Log;
}
export interface ToolOutput { text: string; isError: boolean }
export interface ToolDef<P = any> {
  name: ToolName;
  title: string;
  description: string;                            // spec quote + "\n\n" + CONVENTIONS_LINE
  schema: ZodObject<ZodRawShape>;                 // strict; required parameters are optional here (a cursor may replace them)
  required?: readonly string[];                   // required unless `cursor` is given
  oneOf?: readonly (readonly string[])[];         // "exactly one of" groups, checked first, unless `cursor` is given
  run(params: P, ctx: CallContext, svc: Services): Promise<ToolOutput>;
}
export interface ToolListing {
  name: ToolName; title: string; description: string; inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: true };
}
