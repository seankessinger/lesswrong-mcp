// The request lint of ¶9.3: what the fake forum checks on every request a test sends through it, after the build-time guard
// (src/forum/forbidden.ts) and whatever a tool did with the ops it built. `lintGraphql` checks one parsed GraphQL document: schema
// validity (C2), the template rules R1-R12, P9, P10 and P17's order (an excluded path only after an earlier response confirmed its
// subject public). `recordConfirmations` reads one operation's response into the `LintHistory` that the P17 check consults, from
// the confirmation sources of P17, `exactPostIds` hydrates, `Book.sequences` rows and a confirmed document's revision rows only.
// `lintSearch` checks one search body (Q24, Q35, Q36, Q127, Q128). Every finding is a message string and an empty array means the
// request is clean; nothing here throws on a malformed request.
import {
  BREAK,
  getNamedType,
  Kind,
  print,
  validate,
  valueFromASTUntyped,
  visit,
  type ArgumentNode,
  type ASTNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLError,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { CONFIG } from "../../src/config";
import {
  ALLOW_NULL_ROOTS, ALLOWED, DENIED_ARGS, DENIED_ROOTS, DENIED_TERMS, DENIED_VIEWS, enableTotalAllowed, EXCLUDED_PATHS, LIMIT_ROOTS,
} from "../../src/forum/forbidden";
import { ID_RE } from "../../src/ids/parse";
import type { PublicKind, SearchIndex } from "../../src/types";
import { forumSchema } from "../schema";
import { typeViolations } from "./schemaCheck";

/** The subjects confirmed public by earlier responses of one fake forum, as `"<PublicKind>:<id>"`. */
export interface LintHistory { confirmed: Set<string> }

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_FORMAT = "YYYY-MM-DDTHH:MM:SS.SSSZ";
/** R2: every limit is 1–5000; `RecentDiscussionFeed` takes at most 20. */
const MAX_LIMIT = 5000;
const FEED_MAX_LIMIT = 20;
/** View terms holding a date bound (String-typed in the schema, so validation does not check their form). */
const DATE_TERMS: readonly string[] = ["after", "before"];
/** R3: id lists that are never sent empty. */
const ID_LISTS: readonly string[] = ["exactPostIds", "commentIds", "userIds", "slugs", "sequenceIds"];
/** P17: the term (or, for `revision`, the selector field) that names an excluded path's subject, by the kind it must be confirmed as. */
const SUBJECT_TERM: Readonly<Partial<Record<PublicKind, string>>> = {
  post: "postId", tag: "tagId", doc: "documentId", sequence: "sequenceId", revision: "_id",
};

const queryFields = forumSchema.getQueryType()!.getFields();

// ---------------------------------------------------------------------------------------------------------------------
// Reading a document

/** One selector view of an alias (`key` `<root>.<view>`), or a single or custom root's selector (`key` `<root>`). */
interface ViewRead {
  view: string | undefined;
  key: string;
  terms: Readonly<Record<string, unknown>>;
}

interface AliasRead {
  alias: string;
  root: string;
  args: ReadonlyMap<string, ArgumentNode>;
  /** The literal value of each argument (`undefined` for a variable). */
  values: Readonly<Record<string, unknown>>;
  /** A root whose `selector` is not a `SelectorInput`: its selector is `{<view>: {<terms>}}`. */
  listRoot: boolean;
  /** A list root's selector keys, in the order written. */
  views: readonly string[];
  /** One per view key; for a list root without one, or a single or custom root, exactly one keyed by the root. */
  reads: readonly ViewRead[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationsOf(doc: DocumentNode): OperationDefinitionNode[] {
  return doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
}

function fragmentsOf(doc: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  return fragments;
}

const nameOf = (operation: OperationDefinitionNode | undefined): string => operation?.name?.value ?? "anonymous";

/** The aliases of an operation: its top-level fields, with fragment spreads and inline fragments flattened, in document order. */
function topLevelFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  seen: ReadonlySet<string> = new Set(),
): FieldNode[] {
  return selectionSet.selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) return [selection];
    if (selection.kind === Kind.INLINE_FRAGMENT) return topLevelFields(selection.selectionSet, fragments, seen);
    const name = selection.name.value;
    const definition = fragments.get(name);
    if (definition === undefined || seen.has(name)) return [];
    return topLevelFields(definition.selectionSet, fragments, new Set([...seen, name]));
  });
}

function readAlias(field: FieldNode): AliasRead {
  const root = field.name.value;
  const args = new Map((field.arguments ?? []).map((a) => [a.name.value, a] as const));
  const values: Record<string, unknown> = {};
  for (const [name, arg] of args) values[name] = valueFromASTUntyped(arg.value);
  const selectorArg = queryFields[root]?.args.find((a) => a.name === "selector");
  const listRoot = selectorArg !== undefined && getNamedType(selectorArg.type).name !== "SelectorInput";
  const selector = isRecord(values.selector) ? values.selector : {};
  const views = listRoot ? Object.keys(selector) : [];
  const reads: ViewRead[] =
    views.length > 0
      ? views.map((view) => {
          const terms = selector[view];
          return { view, key: `${root}.${view}`, terms: isRecord(terms) ? terms : {} };
        })
      : [{ view: undefined, key: root, terms: listRoot ? {} : selector }];
  return { alias: field.alias?.value ?? root, root, args, values, listRoot, views, reads };
}

/** Whether the operation declares or uses a variable, itself or in a fragment it spreads (directly or through others). */
function usesVariables(operation: OperationDefinitionNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>): boolean {
  const pending: ASTNode[] = [operation];
  const seen = new Set<string>();
  let found = false;
  while (pending.length > 0 && !found) {
    visit(pending.pop()!, {
      VariableDefinition() {
        found = true;
        return BREAK;
      },
      Variable() {
        found = true;
        return BREAK;
      },
      FragmentSpread(node) {
        const definition = fragments.get(node.name.value);
        if (definition !== undefined && !seen.has(node.name.value)) {
          seen.add(node.name.value);
          pending.push(definition);
        }
      },
    });
  }
  return found;
}

/** The name of the operation a validation error points into; the document's first operation for an error outside every operation. */
function operationNameAt(error: GraphQLError, operations: readonly OperationDefinitionNode[]): string {
  const at = error.nodes?.[0]?.loc?.start;
  const owner = at === undefined ? undefined : operations.find((o) => o.loc !== undefined && o.loc.start <= at && at < o.loc.end);
  return nameOf(owner ?? operations[0]);
}

// ---------------------------------------------------------------------------------------------------------------------
// lintGraphql

/**
 * The ¶9.3 findings for one parsed GraphQL document: its validation errors (C2) first, then per operation the variables (R4) and
 * alias count (R11) and the per-alias rules for every top-level field in field order, then the type-aware R12, R8 and Q99
 * findings of `typeViolations`. `history` holds the subjects earlier responses confirmed public (P17).
 */
export function lintGraphql(doc: DocumentNode, history: LintHistory): string[] {
  const operations = operationsOf(doc);
  const fragments = fragmentsOf(doc);
  const found = validate(forumSchema, doc).map((e) => `C2 ${operationNameAt(e, operations)}: ${e.message}`);
  for (const operation of operations) {
    const name = nameOf(operation);
    if (usesVariables(operation, fragments)) found.push(`R4 ${name}: variables are not allowed`);
    const fields = topLevelFields(operation.selectionSet, fragments);
    const maxAliases = CONFIG.paging.maxAliases;
    if (fields.length > maxAliases) found.push(`R11 ${name}: ${fields.length} aliases (at most ${maxAliases})`);
    for (const field of fields) found.push(...aliasViolations(readAlias(field), history));
  }
  found.push(...typeViolations(doc));
  return found;
}

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function isDateArgument(root: string, name: string): boolean {
  const arg = queryFields[root]?.args.find((a) => a.name === name);
  return arg !== undefined && getNamedType(arg.type).name === "Date";
}

/** R1 for `view`, R2 for `limit`, P9 for the moderation terms (`DENIED_TERMS`). */
function deniedTermMessage(alias: string, term: string, key: string): string {
  if (term === "view") return `R1 ${alias}: view term in ${key}`;
  if (term === "limit") return `R2 ${alias}: limit term in ${key}`;
  return `P9 ${alias}: term ${term} in ${key}`;
}

/** R7: `filterSettings.tags` holds `{tagId: <the view's tagId>, filterMode: "Required"}`. */
function hasRequiredTagFilter(terms: Readonly<Record<string, unknown>>): boolean {
  const tagId = terms.tagId;
  const tags = isRecord(terms.filterSettings) ? terms.filterSettings.tags : undefined;
  return typeof tagId === "string" && Array.isArray(tags) && tags.some((t) => isRecord(t) && t.tagId === tagId && t.filterMode === "Required");
}

/**
 * The per-alias rules, in the order their findings are reported: views and terms, limit and offset, dates, the root-specific
 * rules, P17, R7. A root that is not allowed is reported alone: nothing else about it matters.
 */
function aliasViolations(read: AliasRead, history: LintHistory): string[] {
  const { alias: a, root, args, values, reads } = read;
  if (DENIED_ROOTS.includes(root) || !Object.hasOwn(ALLOWED, root)) return [`R8 ${a}: root ${root} is not allowed`];
  const found: string[] = [];

  // R1, R8: one allowed view key; R1, R2, P9: no view, limit or moderation term.
  if (read.listRoot && read.views.length !== 1) found.push(`R1 ${a}: ${read.views.length} view keys`);
  for (const view of read.views) {
    if (!ALLOWED[root]!.includes(view) || DENIED_VIEWS.includes(view) || view.startsWith("sunshine")) {
      found.push(`R8 ${a}: view ${root}.${view} is not allowed`);
    }
  }
  for (const { key, terms } of reads) {
    for (const term of Object.keys(terms)) if (DENIED_TERMS.includes(term)) found.push(deniedTermMessage(a, term, key));
  }
  for (const name of args.keys()) if (DENIED_ARGS.includes(name)) found.push(`R8 ${a}: argument ${name}`);

  // R2, Q4: an explicit limit within policy; offsets 0–2000.
  const limit = args.get("limit");
  if (limit === undefined) {
    if (LIMIT_ROOTS.includes(root)) found.push(`R2 ${a}: no limit on ${root}`);
  } else if (!isInteger(values.limit) || values.limit < 1 || values.limit > MAX_LIMIT) {
    found.push(`R2 ${a}: limit ${print(limit.value)} on ${root} outside 1–${MAX_LIMIT}`);
  } else if (root === "RecentDiscussionFeed" && values.limit > FEED_MAX_LIMIT) {
    found.push(`R2 ${a}: limit ${values.limit} on RecentDiscussionFeed over ${FEED_MAX_LIMIT}`);
  }
  const offset = args.get("offset");
  const maxOffset = CONFIG.paging.maxOffset;
  if (offset !== undefined && (!isInteger(values.offset) || values.offset < 0 || values.offset > maxOffset)) {
    found.push(`Q4 ${a}: offset ${print(offset.value)} on ${root} outside 0–${maxOffset}`);
  }

  // R4: dates in the exact format.
  for (const name of args.keys()) {
    const value = values[name];
    if (typeof value === "string" && isDateArgument(root, name) && !DATE_RE.test(value)) {
      found.push(`R4 ${a}: ${root}.${name} "${value}" is not ${DATE_FORMAT}`);
    }
  }
  for (const { key, terms } of reads) {
    for (const term of DATE_TERMS) {
      const value = terms[term];
      if (typeof value === "string" && !DATE_RE.test(value)) found.push(`R4 ${a}: ${key}.${term} "${value}" is not ${DATE_FORMAT}`);
    }
  }

  // R8, R4, R5, R3, P10.
  if (root === "RecentDiscussionFeed" && args.has("af")) found.push(`R8 ${a}: af on RecentDiscussionFeed`);
  for (const { key, terms } of reads) {
    if (key === "comments.topShortform" && Object.hasOwn(terms, "sortBy")) found.push(`R4 ${a}: sortBy on topShortform`);
  }
  if (args.has("allowNull") && !ALLOW_NULL_ROOTS.includes(root)) found.push(`R5 ${a}: allowNull on ${root}`);
  for (const { key, terms } of reads) {
    for (const term of ID_LISTS) {
      const value = terms[term];
      if (Array.isArray(value) && value.length === 0) found.push(`R3 ${a}: empty ${term} in ${key}`);
    }
  }
  if (values.enableTotal === true) {
    for (const { view, key, terms } of reads) {
      const present = Object.fromEntries(Object.keys(terms).map((term) => [term, true]));
      if (!enableTotalAllowed(root, view, present)) found.push(`P10 ${a}: enableTotal on ${key}`);
    }
  }

  // P17: an excluded path only for a subject an earlier response confirmed public. A path without its subject is never confirmed.
  for (const { key, terms } of reads) {
    if (!Object.hasOwn(EXCLUDED_PATHS, key)) continue;
    const kind = EXCLUDED_PATHS[key]!;
    const id = terms[SUBJECT_TERM[kind]!];
    if (typeof id !== "string" || !history.confirmed.has(`${kind}:${id}`)) {
      found.push(`P17 ${a}: ${key} for ${kind} ${typeof id === "string" ? id : "(none)"} before a response confirmed it public`);
    }
  }

  // R7.
  for (const { key, terms } of reads) {
    if (key === "revisions.revisionsOnDocument" && terms.fieldName == null) found.push(`R7 ${a}: revisionsOnDocument without fieldName`);
    if (key === "revisions.revisionsByUser") {
      for (const term of Object.keys(terms)) if (term !== "userId") found.push(`R7 ${a}: revisionsByUser term ${term}`);
    }
    if (key === "posts.tagRelevance" && !hasRequiredTagFilter(terms)) found.push(`R7 ${a}: tagRelevance without the Required filter for its tagId`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// recordConfirmations

/**
 * Adds to `history` the subjects that one operation's response (`{ data, errors? }`) confirms public, from these sources only:
 * the single roots `post`, `comment`, `tag`, `sequence`, `multiDocument`; the rows of the slug and legacy-id lookups; `TagPreview`'s
 * tag and lens; the rows of a `posts.default` hydrate by `exactPostIds`; inside each of those documents, whether or not it passes,
 * its joins (a comment's `post` and `tag`, a post's `canonicalSequence`, a lens's or summary's page), each judged by its own flags;
 * the `Book.sequences` rows of a collections listing or `collection`; and the row ids of a `revisionsOnDocument` answer for a
 * document already confirmed. A document passes only when the flags of its reference fragment are present and public.
 */
export function recordConfirmations(doc: DocumentNode, response: unknown, history: LintHistory): void {
  const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
  if (data === undefined) return;
  const fragments = fragmentsOf(doc);
  for (const operation of operationsOf(doc)) {
    for (const field of topLevelFields(operation.selectionSet, fragments)) {
      const read = readAlias(field);
      const answer = data[read.alias];
      if (isRecord(answer) && read.reads.length === 1) confirmFrom(read.reads[0]!, answer, history);
    }
  }
}

const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function confirmFrom({ key, terms }: ViewRead, answer: Record<string, unknown>, history: LintHistory): void {
  const confirm = (kind: PublicKind, id: unknown): void => {
    if (typeof id === "string") history.confirmed.add(`${kind}:${id}`);
  };

  /** Post, comment and tag rules: a passing document is confirmed under its kind and as `doc`. */
  const post = (d: unknown): void => {
    if (isRecord(d) && postPasses(d)) for (const kind of ["post", "doc"] as const) confirm(kind, d._id);
  };
  const comment = (d: unknown): void => {
    if (isRecord(d) && commentPasses(d)) for (const kind of ["comment", "doc"] as const) confirm(kind, d._id);
  };
  const tag = (d: unknown): void => {
    if (isRecord(d) && tagPasses(d)) for (const kind of ["tag", "doc"] as const) confirm(kind, d._id);
  };
  /** A sequence object is public when it is there (P4: `hidden` only keeps it out of lists). */
  const sequence = (d: unknown): void => {
    if (isRecord(d)) confirm("sequence", d._id);
  };

  // Source documents with their joins.
  const postSource = (d: unknown): void => {
    post(d);
    if (isRecord(d)) sequence(d.canonicalSequence);
  };
  const commentSource = (d: unknown): void => {
    comment(d);
    if (isRecord(d)) {
      post(d.post);
      tag(d.tag);
    }
  };
  /** A lens or summary is confirmed only as `doc`; its page, a join, as a tag. */
  const lensSource = (d: unknown): void => {
    if (!isRecord(d)) return;
    if (lensPasses(d)) confirm("doc", d._id);
    tag(pageOf(d));
  };
  const bookSequences = (collection: unknown): void => {
    if (!isRecord(collection)) return;
    for (const book of rows(collection.books)) if (isRecord(book)) rows(book.sequences).forEach(sequence);
  };

  switch (key) {
    case "post":
      return postSource(answer.result);
    case "comment":
      return commentSource(answer.result);
    case "tag":
      return tag(answer.result);
    case "sequence":
      return sequence(answer.result);
    case "multiDocument":
      return lensSource(answer.result);
    case "posts.slugPost":
    case "posts.legacyIdPost":
      return rows(answer.results).forEach(postSource);
    case "comments.legacyIdComment":
      return rows(answer.results).forEach(commentSource);
    case "tags.tagBySlug":
      return rows(answer.results).forEach(tag);
    case "TagPreview":
      tag(answer.tag);
      return lensSource(answer.lens);
    case "posts.default":
      if (Object.hasOwn(terms, "exactPostIds")) rows(answer.results).forEach(postSource);
      return;
    case "collections.default":
      return rows(answer.results).forEach(bookSequences);
    case "collection":
      return bookSequences(answer.result);
    case "revisions.revisionsOnDocument": {
      const documentId = terms.documentId;
      if (typeof documentId !== "string" || !history.confirmed.has(`doc:${documentId}`)) return;
      for (const row of rows(answer.results)) if (isRecord(row)) confirm("revision", row._id);
      return;
    }
  }
}

function postPasses(d: Record<string, unknown>): boolean {
  return d.rejected === false;
}

/** P2, P5, P6: not rejected, not deleted (a public placeholder included), and not by an unreviewed author at or after the cutoff. */
function commentPasses(d: Record<string, unknown>): boolean {
  if (d.rejected !== false || d.deleted !== false) return false;
  if (d.authorIsUnreviewed === false) return true;
  return d.authorIsUnreviewed === true && typeof d.postedAt === "string" && Date.parse(d.postedAt) < Date.parse(CONFIG.unreviewedCutoff);
}

function tagPasses(d: Record<string, unknown>): boolean {
  return d.deleted === false && d.adminOnly === false;
}

/** P12 `pageOf`: a lens's or summary's page, or for a lens's own summary its lens's page. */
function pageOf(d: Record<string, unknown>): unknown {
  return d.parentTag ?? (isRecord(d.parentLens) ? d.parentLens.parentTag : undefined);
}

/** P12: not deleted, its page passes the tag rule, and a lens's own summary (`MultiDocuments`) has a live lens. */
function lensPasses(d: Record<string, unknown>): boolean {
  const page = pageOf(d);
  if (d.deleted !== false || typeof d.collectionName !== "string" || !isRecord(page) || !tagPasses(page)) return false;
  return d.collectionName !== "MultiDocuments" || (isRecord(d.parentLens) && d.parentLens.deleted === false);
}

// ---------------------------------------------------------------------------------------------------------------------
// lintSearch

const SEARCH_INDEX_RE = /^(posts|comments|users|tags|sequences)(_newest_first|_oldest_first|_karma)?$/;
const SEARCH_PARAMS: readonly string[] = ["query", "hitsPerPage", "page", "facetFilters", "numericFilters", "highlightPreTag", "highlightPostTag"];
/** The forum's page size when a query gives none; used for the size estimate. */
const DEFAULT_HITS_PER_PAGE = 10;
const NUMERIC_FILTER_RE = /^(publicDateMs|postedAt)(>=|<)\d+$/;
const NUMERIC_FILTER_INDEXES: readonly SearchIndex[] = ["posts", "comments"];

/** The per-index facet table of ¶4.2 (Q128): values allowed as written, and prefixes allowed before an id (`ID_RE`). */
const FACETS: Readonly<Record<SearchIndex, { values: readonly string[]; idPrefixes: readonly string[] }>> = {
  posts: { values: ["af:true"], idPrefixes: ["userId:", "tags._id:", "tags._id:-"] },
  comments: { values: ["af:true"], idPrefixes: ["userId:", "postId.keyword:", "tags:"] },
  users: { values: ["af:true"], idPrefixes: [] },
  tags: { values: ["wikiOnly:true"], idPrefixes: [] },
  sequences: { values: ["af:true"], idPrefixes: [] },
};

function facetAllowed(index: SearchIndex, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const { values, idPrefixes } = FACETS[index];
  return values.includes(value) || idPrefixes.some((prefix) => value.startsWith(prefix) && ID_RE.test(value.slice(prefix.length)));
}

/** A value that may be a list or one item: the list, `[]` when absent. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/**
 * The ¶9.3 findings for one search body (`{ options, queries }` or a bare array of queries), query by query, then the estimated
 * response size of the whole body against `CONFIG.search.maxRequestBytes`. A query whose index name is not one known index with
 * a known sort suffix is reported alone and left out of the estimate.
 */
export function lintSearch(body: unknown): string[] {
  const queries = Array.isArray(body) ? body : isRecord(body) ? rows(body.queries) : [];
  const found: string[] = [];
  let estimate = 0;
  for (const query of queries) {
    const q = isRecord(query) ? query : {};
    const i = String(q.indexName);
    const match = typeof q.indexName === "string" ? SEARCH_INDEX_RE.exec(q.indexName) : null;
    if (match === null) {
      found.push(`search ${i}: not one index with a known sort`);
      continue;
    }
    const index = match[1] as SearchIndex;
    if (index === "sequences" && match[2] === "_karma") found.push(`search ${i}: sort karma not allowed on sequences`);
    const params = isRecord(q.params) ? q.params : {};
    for (const key of Object.keys(params)) {
      if (!SEARCH_PARAMS.includes(key)) found.push(key === "aroundLatLng" ? `search ${i}: aroundLatLng` : `search ${i}: unknown parameter ${key}`);
    }

    // Q127: the per-index page size cap, and the estimate.
    const hitsPerPage = typeof params.hitsPerPage === "number" ? params.hitsPerPage : DEFAULT_HITS_PER_PAGE;
    const cap = CONFIG.search.hitsPerPage[index];
    if (hitsPerPage > cap) found.push(`search ${i}: hitsPerPage ${hitsPerPage} over ${cap}`);
    estimate += hitsPerPage * CONFIG.search.estBytesPerHit[index];

    // Q24, Q128: one value per inner array, each from the facet table.
    for (const group of listOf(params.facetFilters)) {
      const values = listOf(group);
      if (values.length > 1) found.push(`search ${i}: inner facet array with ${values.length} values`);
      for (const value of values) if (!facetAllowed(index, value)) found.push(`search ${i}: facet "${String(value)}" not in the facet table`);
    }

    // Q35, Q36: integer bounds on posts and comments only, and a closed range across two fields.
    const filters = listOf(params.numericFilters);
    if (filters.length === 0) continue;
    if (!NUMERIC_FILTER_INDEXES.includes(index)) {
      found.push(`search ${i}: numeric filters on ${index}`);
      continue;
    }
    const bounds = new Map<string, Set<string>>();
    for (const filter of filters) {
      const bound = typeof filter === "string" ? NUMERIC_FILTER_RE.exec(filter) : null;
      if (bound === null) {
        found.push(`search ${i}: numeric filter "${String(filter)}" is not an integer >= or < bound on publicDateMs or postedAt`);
        continue;
      }
      bounds.set(bound[1]!, (bounds.get(bound[1]!) ?? new Set()).add(bound[2]!));
    }
    for (const [field, operators] of bounds) {
      if (operators.has(">=") && operators.has("<")) found.push(`search ${i}: closed date range on one field ${field}`);
    }
  }
  const maxBytes = CONFIG.search.maxRequestBytes;
  if (estimate > maxBytes) found.push(`search: estimated ${estimate} bytes over ${maxBytes}`);
  return found;
}
