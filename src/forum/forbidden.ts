// Layer 4. The allow-list and deny-list of R1-R8, P9, P10 and P17, and `assertAllowed`: the check every template op passes
// before it is sent. It reads the op's text only (no GraphQL parser at runtime): strings are masked first, so a `$`, a
// word or a bracket inside a JSON string literal is data, and the root, its arguments and its selector terms are split
// at top-level commas. Every refusal is `internalError(op.template, <detail>)`: a template that trips one is a bug of this
// server, never the caller's input. The type-aware checks (the denied `Type.field` pairs of test/support/deniedFields.ts,
// R12, `changeMetrics`) need the schema and run in tests through test/support/schemaCheck.ts. Imports nothing but the error
// wording and the shared types.
import { internalError } from "../errors";
import type { GqlOp, PublicKind } from "../types";

function frozenLists(lists: Record<string, string[]>): Readonly<Record<string, readonly string[]>> {
  for (const list of Object.values(lists)) Object.freeze(list);
  return Object.freeze(lists);
}

/** Every root the templates use, with the selector views each may name; a root with no views is a single or custom root. */
export const ALLOWED: Readonly<Record<string, readonly string[]>> = frozenLists({
  posts: ["default", "slugPost", "legacyIdPost", "userPosts", "tagRelevance", "new", "old", "top", "recentComments", "curated", "magic", "pingbackPosts"],
  post: [],
  comments: ["legacyIdComment", "postCommentsOld", "answersAndReplies", "debateResponses", "reviews", "tagDiscussionComments", "default", "allRecentComments", "topShortform", "shortformFrontpage"],
  comment: [],
  GetUserBySlug: [],
  user: [],
  users: ["usersByUserIds"],
  tags: ["tagBySlug", "tagsBySlugs", "allTagsAlphabetical", "pingbackWikiPages"],
  tag: [],
  TagPreview: [],
  multiDocument: [],
  multiDocuments: ["pingbackLensPages"],
  sequence: [],
  sequences: ["default", "userProfile"],
  collection: [],
  collections: ["default"],
  chapters: ["SequenceChapters"],
  getSequenceStats: [],
  revisions: ["revisionsOnDocument", "revisionsByUser"],
  revision: [],
  TagsByCoreTagId: [],
  RecentDiscussionFeed: [],
  AllTagsActivityFeed: [],
  PopularComments: [],
  CuratedAndPopularThisWeek: [],
  RecentlyActiveDialogues: [],
  reviewWinners: ["default"],
  currentSpotlight: [],
});

/** Roots the templates never use; refused by name (R8) even if the allow-list changes. */
export const DENIED_ROOTS: readonly string[] = Object.freeze([
  "GetAllReviewWinners", "TagHistoryFeed", "TagUpdatesInTimeBlock", "CommentsWithReacts", "UserContentFeed", "ProfileDiamondPosts",
  "ProfileDiamondComments", "NetKarmaChangesForAuthorsOverPeriod", "Recommendations", "LastCuratedDate", "ActiveTagCount", "RandomTag",
  "RevisionsDiff", "votes", "vote", "getBookWordCount",
]);

/** Views the templates never use; refused by name (P9, R8), and every view whose name starts with `sunshine` by prefix. */
export const DENIED_VIEWS: readonly string[] = Object.freeze([
  "rejected", "postCommentsDeleted", "allCommentsDeleted", "profileComments", "unlisted", "drafts", "all_drafts", "scheduled",
  "LWSunshinesList", "allUsers", "usersMapLocations", "LWUsersAdmin", "usersWithBannedUsers", "draftComments", "moderatorComments",
  "afSubmissions", "postsWithBannedUsers", "myBookmarkedPosts",
]);

/** Arguments the templates never send (R8). */
export const DENIED_ARGS: readonly string[] = Object.freeze(["input", "orderBy"]);

/** Terms that are never sent inside a view (R1, R2, P9). */
export const DENIED_TERMS: readonly string[] = Object.freeze(["view", "limit", "authorIsUnreviewed", "includeRejected"]);

/** Roots whose answer is non-null in the schema: one failing alias would null the whole response, so each is isolated (R6). */
const NON_NULL_ROOTS: readonly string[] = Object.freeze(["RecentDiscussionFeed", "AllTagsActivityFeed", "TagsByCoreTagId"]);

/** The only roots that may carry `allowNull: true` (R5). */
export const ALLOW_NULL_ROOTS: readonly string[] = Object.freeze(["post", "comment", "sequence"]);

/** Roots that take an explicit top-level `limit` (R2). */
export const LIMIT_ROOTS: readonly string[] = Object.freeze([
  "posts", "comments", "users", "tags", "multiDocuments", "sequences", "collections", "chapters", "revisions", "reviewWinners",
  "RecentDiscussionFeed", "AllTagsActivityFeed", "PopularComments", "CuratedAndPopularThisWeek", "RecentlyActiveDialogues", "TagsByCoreTagId",
]);

/** Paths requested only for a subject confirmed public (P17), each with the kind of subject its op must carry. */
export const EXCLUDED_PATHS: Readonly<Record<string, PublicKind>> = Object.freeze({
  "comments.postCommentsOld": "post",
  "comments.answersAndReplies": "post",
  "comments.debateResponses": "post",
  "comments.reviews": "post",
  "comments.tagDiscussionComments": "tag",
  "revisions.revisionsOnDocument": "doc",
  revision: "revision",
  "chapters.SequenceChapters": "sequence",
});

// Module-private tables

/** Terms (views) or arguments (single and custom roots) a root or view must receive, in the order they are checked (R3, R7). */
const REQUIRED: Readonly<Record<string, readonly string[]>> = frozenLists({
  "posts.default": ["exactPostIds"],
  "posts.slugPost": ["slug"],
  "posts.legacyIdPost": ["legacyId"],
  "posts.userPosts": ["userId"],
  "posts.tagRelevance": ["tagId", "filterSettings"],
  "posts.pingbackPosts": ["postId"],
  "comments.default": ["commentIds"],
  "comments.legacyIdComment": ["legacyId"],
  "comments.postCommentsOld": ["postId"],
  "comments.answersAndReplies": ["postId"],
  "comments.debateResponses": ["postId"],
  "comments.reviews": ["postId"],
  "comments.tagDiscussionComments": ["tagId"],
  "users.usersByUserIds": ["userIds"],
  "tags.tagBySlug": ["slug"],
  "tags.tagsBySlugs": ["slugs"],
  "tags.pingbackWikiPages": ["tagId"],
  "multiDocuments.pingbackLensPages": ["documentId"],
  "sequences.userProfile": ["userId"],
  "chapters.SequenceChapters": ["sequenceId"],
  "revisions.revisionsOnDocument": ["documentId", "fieldName"],
  "revisions.revisionsByUser": ["userId"],
  post: ["_id"],
  comment: ["_id"],
  user: ["_id"],
  tag: ["_id"],
  multiDocument: ["_id"],
  sequence: ["_id"],
  collection: ["_id"],
  revision: ["_id"],
  GetUserBySlug: ["slug"],
  TagPreview: ["slug"],
  getSequenceStats: ["sequenceId"],
  TagsByCoreTagId: ["coreTagId"],
});

/** Terms whose value is a list of ids; an empty list is never sent, because the forum's treatment of `[]` is not established (R3). */
const ID_LISTS: readonly string[] = ["exactPostIds", "commentIds", "userIds", "slugs", "sequenceIds"];

/** `sortedBy` values of every `posts` view (R4, evidenced in §6.2), and the one more that `tagRelevance` takes (§10.4). */
const SORTED_BY: readonly string[] = ["new", "old", "top", "recentComments"];
const SORTED_BY_TAG_RELEVANCE: readonly string[] = [...SORTED_BY, "relevance"];
/** `sortBy` values of `comments.allRecentComments`, the only view that takes one (R4, §9.4). */
const SORT_BY: readonly string[] = ["new", "old", "top"];

/** Fields refused by name alone in any selection; their owner type is checked in tests, where the schema is at hand. */
const NAME_ONLY_DENIED: readonly string[] = [
  "tableOfContents", "tableOfContentsRevision", "htmlWithContributorAnnotations", "htmlBody", "htmlHighlightStartingAtHash", "username",
  "sequenceCount", "mapLocation", "mapLocationLatLng", "allVotes", "isBookmarked", "pageUrl", "pageUrlRelative", "usersWhoLiked", "tagRel",
  "prevPost", "nextPost", "canonicalNextPostSlug", "canonicalPrevPostSlug",
];
const NAME_ONLY_DENIED_RE = new RegExp(`\\b(${NAME_ONLY_DENIED.join("|")})\\b`);

// enableTotal

/**
 * Whether `enableTotal: true` may be sent with this selector (P10, ¶3.6): only on the selectors listed below. Only which
 * terms are present matters, not their values.
 *
 * A term whose value is `undefined` counts as absent, not present: `obj()` leaves such a term out of the sent text, so this
 * function and the guard (which reads that text) agree on what is in the selector. `view` is `undefined` for a root with none.
 */
export function enableTotalAllowed(root: string, view: string | undefined, terms: Readonly<Record<string, unknown>>): boolean {
  const has = (term: string): boolean => Object.hasOwn(terms, term) && terms[term] !== undefined;
  switch (`${root}.${view}`) {
    case "posts.userPosts":
    case "posts.tagRelevance":
    case "posts.curated":
    case "posts.pingbackPosts":
    case "revisions.revisionsOnDocument":
    case "revisions.revisionsByUser":
      return true;
    case "comments.allRecentComments":
    case "comments.topShortform":
      return has("userId");
    case "sequences.default":
      return !has("sequenceIds");
    default:
      return false;
  }
}

// Reading an op's text

/** `text` with every character strictly inside a JSON string literal replaced by `_`; indexes still line up with `text`. */
function maskStrings(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => `"${"_".repeat(literal.length - 2)}"`);
}

const HEADER_RE = /^([A-Za-z_]\w*): ([A-Za-z_]\w*)/;
const NAME_RE = /^[A-Za-z_]\w*$/;

/** Index of the bracket that closes the one opening at `open`, counting `(`, `{` and `[` alike, on masked text; -1 when unclosed. */
function closingIndex(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

interface Pair {
  name: string;
  value: string;
}

/** `name: value` pairs split at top-level commas; values are taken from the original text, so strings keep their content. */
function pairsOf(text: string, template: string): Pair[] {
  const masked = maskStrings(text);
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      segments.push(text.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(text.slice(start));
  const pairs: Pair[] = [];
  for (const segment of segments) {
    if (segment.trim() === "") continue;
    const colon = maskStrings(segment).indexOf(":");
    const name = colon < 0 ? "" : segment.slice(0, colon).trim();
    if (!NAME_RE.test(name)) throw internalError(template, "unreadable arguments");
    pairs.push({ name, value: segment.slice(colon + 1).trim() });
  }
  return pairs;
}

/** The pairs inside `{ … }`, where the braces are the whole of `value`. */
function objectPairs(value: string, template: string): Pair[] {
  const masked = maskStrings(value);
  if (!value.startsWith("{") || closingIndex(masked, 0) !== value.length - 1) throw internalError(template, "unreadable selector");
  return pairsOf(value.slice(1, -1), template);
}

interface ReadOp {
  root: string;
  args: Pair[];
  /** The masked text after the arguments: the selection. */
  selection: string;
}

/**
 * Splits an op's text into root, arguments and selection. Text this reader cannot parse (no `<alias>: <root>` header, an
 * unclosed argument list, a segment that is not `name: value`) is refused as "unreadable operation" or "unreadable arguments";
 * `objectPairs` refuses "unreadable selector" likewise. `op()` never produces such text, so these only fire for hand-built
 * text, and they fail closed.
 */
function readOp(text: string, masked: string, template: string): ReadOp {
  const header = HEADER_RE.exec(text);
  if (!header) throw internalError(template, "unreadable operation");
  let end = header[0].length;
  let args: Pair[] = [];
  if (text[end] === "(") {
    const close = closingIndex(masked, end);
    if (close < 0) throw internalError(template, "unreadable arguments");
    args = pairsOf(text.slice(end + 1, close), template);
    end = close + 1;
  }
  return { root: header[2]!, args, selection: masked.slice(end) };
}

/** The value of a GraphQL integer literal, or `undefined` when `value` is anything else. */
function intValue(value: string): number | undefined {
  return /^-?\d+$/.test(value) ? Number(value) : undefined;
}

/** The content of a JSON string literal, or `undefined` when `value` is not one. */
function stringValue(value: string): string | undefined {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) return undefined;
  try {
    return JSON.parse(value) as string;
  } catch {
    return undefined;
  }
}

/** R7: `filterSettings` holds a tag filter object naming `tagLiteral` with `filterMode: "Required"`. */
function hasRequiredTagFilter(settings: string, tagLiteral: string, template: string): boolean {
  for (const entry of maskStrings(settings).matchAll(/\{[^{}]*\}/g)) {
    const fields = pairsOf(settings.slice(entry.index + 1, entry.index + entry[0].length - 1), template);
    const valueOf = (name: string): string | undefined => fields.find((f) => f.name === name)?.value;
    if (valueOf("tagId") === tagLiteral && valueOf("filterMode") === '"Required"') return true;
  }
  return false;
}

// assertAllowed

/**
 * Throws `internalError(op.template, <detail>)` unless `op.text` passes every allow-list, deny-list and limit rule, checked
 * in this order: variables, `mutation`, the root, its views, denied arguments and terms, the limit and offset bounds (R2),
 * `allowNull` and `enableTotal`, isolation of a non-null root (R6), the excluded paths' public subject (P17), `af` on
 * RecentDiscussionFeed, the sorts (R4), the required ids and empty id lists (R3), the tagRelevance filter and the
 * revisionsByUser terms (R7), and the denied fields of the selection. Reads the text only; `op.isolate` and
 * `op.publicSubject` are the caller's claims that R6 and P17 ask for.
 */
export function assertAllowed(op: GqlOp): void {
  const template = op.template;
  function refuse(detail: string): never {
    throw internalError(template, detail);
  }

  const masked = maskStrings(op.text);
  if (masked.includes("$")) refuse("variables are not allowed");
  if (/\bmutation\b/.test(masked)) refuse("only queries are allowed");

  const { root, args, selection } = readOp(op.text, masked, template);
  const arg = (name: string): Pair | undefined => args.find((a) => a.name === name);

  // The root, then its view: a list root's selector is `{<view>: {<terms>}}`, a single root's is `{<terms>}`.
  if (DENIED_ROOTS.includes(root) || !Object.hasOwn(ALLOWED, root)) refuse(`root ${root} is not allowed`);
  const allowedViews = ALLOWED[root]!;
  const isListRoot = allowedViews.length > 0;
  const selector = arg("selector");
  const viewPairs = isListRoot && selector ? objectPairs(selector.value, template) : [];
  const views = viewPairs.map((p) => p.name);
  for (const v of views) if (DENIED_VIEWS.includes(v) || v.startsWith("sunshine")) refuse(`denied view ${v}`);
  if (isListRoot && views.length === 0) refuse(`missing view on ${root}`);
  for (const v of views) if (!allowedViews.includes(v)) refuse(`view ${v} is not allowed on ${root}`);
  if (views.length > 1) refuse("more than one view key");
  const view = views[0];
  const key = view === undefined ? root : `${root}.${view}`;
  const terms: Pair[] = isListRoot
    ? viewPairs.length > 0 ? objectPairs(viewPairs[0]!.value, template) : []
    : selector ? objectPairs(selector.value, template) : [];
  const term = (name: string): Pair | undefined => terms.find((t) => t.name === name);

  for (const a of args) if (DENIED_ARGS.includes(a.name)) refuse(`denied argument ${a.name}`);
  for (const t of terms) if (DENIED_TERMS.includes(t.name)) refuse(`denied term ${t.name}`);

  // R2: an explicit limit on every list root and limited custom root (RecentDiscussionFeed at most 20), offsets 0-2000.
  if (LIMIT_ROOTS.includes(root)) {
    const limit = arg("limit");
    if (!limit) refuse(`missing limit on ${root}`);
    const n = intValue(limit.value);
    if (n === undefined || n < 1 || n > 5000) refuse(`limit ${limit.value} outside 1–5000`);
    if (root === "RecentDiscussionFeed" && n > 20) refuse(`limit ${n} over 20 on RecentDiscussionFeed`);
  }
  const offset = arg("offset");
  if (offset) {
    const n = intValue(offset.value);
    if (n === undefined || n < 0 || n > 2000) refuse(`offset ${offset.value} outside 0–2000`);
  }

  // `allowNull: false` and `enableTotal: false` request nothing, so they are not refused (op() never emits them; hand-built
  // text may); any other value asks for the feature and is checked.
  const allowNull = arg("allowNull");
  if (allowNull && allowNull.value !== "false" && !ALLOW_NULL_ROOTS.includes(root)) refuse(`allowNull on ${root}`);
  const enableTotal = arg("enableTotal");
  if (enableTotal && enableTotal.value !== "false") {
    const present = Object.fromEntries(terms.map((t) => [t.name, t.value]));
    if (!enableTotalAllowed(root, view, present)) refuse("enableTotal on an unbounded selector");
  }
  if (NON_NULL_ROOTS.includes(root) && !op.isolate) refuse(`non-null root ${root} must be isolated`);
  if (Object.hasOwn(EXCLUDED_PATHS, key) && op.publicSubject !== EXCLUDED_PATHS[key]) {
    refuse(`excluded path ${key} needs a confirmed-public subject`);
  }
  if (root === "RecentDiscussionFeed" && arg("af")) refuse("af on RecentDiscussionFeed");

  // R4: no sortBy on topShortform; sortedBy and sortBy only from their closed sets.
  if (key === "comments.topShortform" && term("sortBy")) refuse("sortBy on topShortform");
  const sortedBy = term("sortedBy");
  if (sortedBy) {
    const allowed = root !== "posts" ? [] : view === "tagRelevance" ? SORTED_BY_TAG_RELEVANCE : SORTED_BY;
    const value = stringValue(sortedBy.value);
    if (value === undefined || !allowed.includes(value)) refuse(`sortedBy "${value ?? sortedBy.value}" not allowed on ${key}`);
  }
  const sortBy = term("sortBy");
  if (sortBy) {
    const allowed = key === "comments.allRecentComments" ? SORT_BY : [];
    const value = stringValue(sortBy.value);
    if (value === undefined || !allowed.includes(value)) refuse(`sortBy "${value ?? sortBy.value}" not allowed on ${key}`);
  }

  // R3: a view that takes an id receives it (single and custom roots take theirs as arguments), and no id list is empty.
  const supplied = new Set((isListRoot || selector ? terms : args).map((p) => p.name));
  if (Object.hasOwn(REQUIRED, key)) {
    for (const needed of REQUIRED[key]!) if (!supplied.has(needed)) refuse(`missing ${needed} on ${key}`);
  }
  for (const t of terms) if (ID_LISTS.includes(t.name) && /^\[\s*\]$/.test(t.value)) refuse(`empty id list ${t.name}`);

  // R7.
  if (key === "posts.tagRelevance" && !hasRequiredTagFilter(term("filterSettings")!.value, term("tagId")!.value, template)) {
    refuse("tagRelevance needs the Required tag filter");
  }
  if (key === "revisions.revisionsByUser" && terms.some((t) => t.name !== "userId")) refuse("revisionsByUser takes only userId");

  const denied = NAME_ONLY_DENIED_RE.exec(selection);
  if (denied) refuse(`denied field ${denied[1]}`);
}
