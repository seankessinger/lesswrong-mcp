// The fake forum (¶9.2): a `fetchImpl` for both endpoints, so the real forum/http.ts runs in every test that reaches the forum.
// GraphQL bodies (one operation or an array batch) are parsed and validated against the forum's schema operation by operation; each
// alias is answered from the first matching fixture entry, projected onto its selection set, in the forum's response shapes (§4.8).
// Search bodies are answered query by query from the search entries as `text/plain` JSON (§5). Requests are recorded; injections
// delay answers or replace them with statuses, headers or other bodies (¶C transport).
// An unmatched alias or query never throws (http.ts would retry a throw and the test would see only `forum_error`): it is recorded
// in `unmatched` and answered with an error, or with no hits. Unless `lint: false`, the request lint (support/lint.ts, ¶9.3) checks
// every parsed GraphQL operation, before any operation of its body is answered, and every parsed search body, appending to
// `lintErrors`; each GraphQL reply then feeds the forum's history of subjects confirmed public (P17). Injected answers and
// unparsable bodies are not linted.
import { isDeepStrictEqual } from "node:util";
import {
  getNamedType,
  isInterfaceType,
  isObjectType,
  Kind,
  parse,
  validate,
  valueFromASTUntyped,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type NamedTypeNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { forumSchema } from "./schema";
import type { FixtureEntry, GraphqlMatch, SearchMatch } from "./support/fixtures";
import { lintGraphql, lintSearch, recordConfirmations, type LintHistory } from "./support/lint";

interface Injection {
  endpoint?: "graphql" | "search";
  when?: (body: string) => boolean;
  times?: number;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}

interface RecordedRequest {
  endpoint: "graphql" | "search";
  body: string;
  /** `opts.now()` when the request arrived, before any injected delay; 0 without `now`. */
  at: number;
}

export interface FakeForum {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  inject(i: Injection): void;
  lintErrors: string[];
  warnings: string[];
  unmatched: string[];
}

type Endpoint = RecordedRequest["endpoint"];
type FixtureError = NonNullable<FixtureEntry["error"]>;

/** A reply before it becomes a `Response`. */
interface Answer { status: number; headers: Record<string, string>; body: string }

/** One GraphQL alias as the matcher sees it. */
interface AliasRequest {
  root: string;
  view?: string;
  terms?: Record<string, unknown>;
  id?: string;
  args: Record<string, unknown>;
  limit?: number;
  offset: number;
  enableTotal: boolean;
}

/** One search query as the matcher sees it, request defaults applied. */
interface QueryRequest {
  index: string;
  query?: unknown;
  page: number;
  hitsPerPage: number;
  facetFilters: unknown[];
  numericFilters: unknown[];
}

/** What answering one parsed GraphQL request body produced: its reply and whether it failed to parse or validate. */
interface OperationAnswer { reply: Record<string, unknown>; failed: boolean }

const GRAPHQL_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const SEARCH_HEADERS = { "content-type": "text/plain;charset=UTF-8" } as const;
const STACK_FRAME = "    at resolve (/var/task/packages/lesswrong/server/resolvers/defaultResolvers.js:1:1)";
/** Root arguments matched on their own (selector → `view`/`terms` or `id`); every other argument is matched through `args`. */
const OWN_ARGS: ReadonlySet<string> = new Set(["selector", "limit", "offset", "enableTotal", "allowNull"]);
const DEFAULT_HITS_PER_PAGE = 10;

const queryFields = forumSchema.getQueryType()!.getFields();

export function createFakeForum(opts: {
  fixtures: readonly FixtureEntry[];
  lint?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): FakeForum {
  const injections: { injection: Injection; left: number }[] = [];
  const lint = opts.lint !== false;
  const history: LintHistory = { confirmed: new Set() };
  const forum: FakeForum = {
    fetchImpl: (url, init) => respond(url, init),
    requests: [],
    inject(injection) {
      injections.push({ injection, left: injection.times ?? 1 });
    },
    lintErrors: [],
    warnings: [],
    unmatched: [],
  };

  async function respond(url: string, init: RequestInit): Promise<Response> {
    if (init.signal?.aborted) throw init.signal.reason;
    const endpoint = endpointOf(url);
    const body = String(init.body);
    forum.requests.push({ endpoint, body, at: opts.now?.() ?? 0 });
    const answer = (await injected(endpoint, body)) ?? (endpoint === "graphql" ? answerGraphql(body) : answerSearch(body));
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  }

  /** The first injection that applies, one of its `times` spent: its answer, or `undefined` when it only delays (or none applies). */
  async function injected(endpoint: Endpoint, body: string): Promise<Answer | undefined> {
    const index = injections.findIndex(
      ({ injection: i }) => (i.endpoint === undefined || i.endpoint === endpoint) && (i.when === undefined || i.when(body)),
    );
    if (index < 0) return undefined;
    const slot = injections[index]!;
    slot.left -= 1;
    if (slot.left <= 0) injections.splice(index, 1);
    const i = slot.injection;
    if (i.delayMs !== undefined) await delay(i.delayMs);
    if (i.status !== undefined || i.body !== undefined) return { status: i.status ?? 200, headers: { ...i.headers }, body: i.body ?? "" };
    return undefined;
  }

  /** `opts.sleep(ms)`, or a real timer without it. */
  function delay(ms: number): Promise<void> {
    return opts.sleep ? opts.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------------------------------------------- GraphQL

  /**
   * One operation or an array batch; the reply has the request's shape, and HTTP 400 when any operation failed to parse or validate.
   * Every parsed operation is linted before any is answered (a confirmation in one operation's reply cannot excuse another of the
   * same request), and every reply is then read for confirmations.
   */
  function answerGraphql(body: string): Answer {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const reply = { errors: [{ message: "fake forum: the GraphQL body is not JSON", extensions: { code: "BAD_REQUEST" } }] };
      return { status: 400, headers: { ...GRAPHQL_HEADERS }, body: JSON.stringify(reply) };
    }
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const docs = requests.map(parsedQuery);
    if (lint) for (const doc of docs) if (!(doc instanceof Error)) forum.lintErrors.push(...lintGraphql(doc, history));
    const answers = requests.map((request, i) => answerOperation(request, docs[i]!));
    if (lint) {
      docs.forEach((doc, i) => {
        if (!(doc instanceof Error)) recordConfirmations(doc, answers[i]!.reply, history);
      });
    }
    const replies = answers.map((a) => a.reply);
    return {
      status: answers.some((a) => a.failed) ? 400 : 200,
      headers: { ...GRAPHQL_HEADERS },
      body: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]),
    };
  }

  /**
   * One `{ query, operationName }` with its parsed query (or the error parsing it): a parse or validation failure loses every alias
   * (§4.8); otherwise each alias is answered.
   */
  function answerOperation(request: unknown, doc: DocumentNode | Error): OperationAnswer {
    const { operationName } = isRecord(request) ? request : {};
    if (doc instanceof Error) {
      return { failed: true, reply: { errors: [{ message: doc.message, extensions: { code: "GRAPHQL_PARSE_FAILED" } }] } };
    }
    const invalid = validate(forumSchema, doc);
    if (invalid.length > 0) {
      const code = "GRAPHQL_VALIDATION_FAILED";
      return { failed: true, reply: { errors: invalid.map((e) => ({ message: e.message, locations: e.locations, extensions: { code } })) } };
    }
    const operation = chosenOperation(doc, operationName);
    if (typeof operation === "string") {
      return { failed: true, reply: { errors: [{ message: operation, extensions: { code: "OPERATION_RESOLUTION_FAILURE" } }] } };
    }
    return { failed: false, reply: execute(operation, fragmentsOf(doc)) };
  }

  /** `{ data }` or `{ data, errors }`, each top-level field answered as an alias; `data` is null when a matched error says so. */
  function execute(operation: OperationDefinitionNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const errors: Record<string, unknown>[] = [];
    let dataNull = false;
    for (const field of fieldsOf(operation.selectionSet, fragments)) {
      const alias = field.alias?.value ?? field.name.value;
      const request = aliasRequest(field);
      const entry = opts.fixtures.find((e) => isGraphqlMatch(e.match) && aliasMatches(e.match, request));
      if (entry === undefined) {
        const line = describeAlias(alias, request);
        forum.unmatched.push(line);
        put(data, alias, null);
        errors.push({ message: `fake forum: no fixture for ${line}`, path: [alias] });
        continue;
      }
      const rootType = getNamedType(queryFields[request.root]!.type);
      const project = (): unknown => projected(entry.result, field.selectionSet, rootType, fragments, entry.source);
      if (entry.error === undefined) {
        put(data, alias, project());
        continue;
      }
      errors.push(resolverError(entry.error, alias));
      if (entry.error.dataNull) dataNull = true;
      const nested = entry.result !== undefined && (entry.error.path?.length ?? 0) > 1;
      put(data, alias, nested ? project() : null);
    }
    const reply: Record<string, unknown> = { data: dataNull ? null : data };
    if (errors.length > 0) reply.errors = errors;
    return reply;
  }

  /**
   * `value` reduced to what `selectionSet` asks for, field by field, as the forum would return it (null for an absent source field).
   * Fragment spreads are followed; inline fragments are not, as no template sends one.
   */
  function projected(
    value: unknown,
    selectionSet: SelectionSetNode | undefined,
    type: GraphQLNamedType,
    fragments: ReadonlyMap<string, FragmentDefinitionNode>,
    source: string,
  ): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((item) => projected(item, selectionSet, type, fragments, source));
    if (selectionSet === undefined || !isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    const fill = (selections: SelectionSetNode, on: GraphQLNamedType): void => {
      for (const selection of selections.selections) {
        if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const fragment = fragments.get(selection.name.value)!;
          fill(fragment.selectionSet, conditionType(fragment.typeCondition) ?? on);
        } else if (selection.kind === Kind.FIELD) {
          const name = selection.name.value;
          const key = selection.alias?.value ?? name;
          if (value[name] === undefined) {
            warn(`${on.name}.${name} missing in fixture (${source})`);
            put(out, key, null);
          } else {
            const raw = value[name];
            put(out, key, selection.selectionSet ? projected(raw, selection.selectionSet, fieldType(on, name), fragments, source) : raw);
          }
        }
      }
    };
    fill(selectionSet, type);
    return out;
  }

  function warn(text: string): void {
    if (!forum.warnings.includes(text)) forum.warnings.push(text);
  }

  // ---------------------------------------------------------------------------------------------------------------- search

  /** `{ options, queries }` or a bare array of queries; one query whose entry is an error fails the whole body (Q23). */
  function answerSearch(body: string): Answer {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, headers: { ...SEARCH_HEADERS }, body: "fake forum: the search body is not JSON" };
    }
    if (lint) forum.lintErrors.push(...lintSearch(parsed));
    const queries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.queries : undefined;
    if (!Array.isArray(queries)) return { status: 400, headers: { ...SEARCH_HEADERS }, body: "fake forum: the search body has no queries" };
    const answers = queries.map(answerQuery);
    const failure = answers.find((a): a is { error: FixtureError } => "error" in a);
    if (failure !== undefined) return { status: failure.error.status ?? 400, headers: { ...SEARCH_HEADERS }, body: failure.error.message };
    return { status: 200, headers: { ...SEARCH_HEADERS }, body: JSON.stringify(answers.map((a) => ("result" in a ? a.result : null))) };
  }

  function answerQuery(query: unknown): { result: Record<string, unknown> } | { error: FixtureError } {
    const request = queryRequest(query);
    const entry = opts.fixtures.find((e) => !isGraphqlMatch(e.match) && queryMatches(e.match, request));
    if (entry === undefined) forum.unmatched.push(describeQuery(request));
    if (entry?.error !== undefined) return { error: entry.error };
    const given = isRecord(entry?.result) ? entry.result : {};
    const result: Record<string, unknown> = {
      hits: [],
      nbHits: Array.isArray(given.hits) ? given.hits.length : 0,
      page: request.page,
      hitsPerPage: request.hitsPerPage,
      index: request.index,
      processingTimeMS: 1,
      ...given,
    };
    if (!Object.hasOwn(given, "nbPages")) {
      const nbHits = Number(result.nbHits);
      const perPage = Number(result.hitsPerPage);
      result.nbPages = perPage > 0 ? Math.ceil(nbHits / perPage) : 0;
    }
    return { result };
  }

  return forum;
}

// -------------------------------------------------------------------------------------------------------------------- helpers

function endpointOf(url: string): Endpoint {
  if (url.endsWith("/graphql")) return "graphql";
  if (url.endsWith("/api/search")) return "search";
  throw new Error(`fake forum: unexpected URL ${url}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGraphqlMatch(match: GraphqlMatch | SearchMatch): match is GraphqlMatch {
  return "root" in match;
}

/** The parsed `query` of one `{ query, operationName }`, or the error parsing it raised. */
function parsedQuery(request: unknown): DocumentNode | Error {
  const { query } = isRecord(request) ? request : {};
  try {
    return parse(query as string);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** The operation `operationName` names, else the document's only one; failing that, the message the forum's Apollo server answers. */
function chosenOperation(doc: DocumentNode, operationName: unknown): OperationDefinitionNode | string {
  const operations = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  if (typeof operationName === "string") {
    return operations.find((o) => o.name?.value === operationName) ?? `Unknown operation named "${operationName}".`;
  }
  return operations.length === 1 ? operations[0]! : "Must provide operation name if query contains multiple operations.";
}

function fragmentsOf(doc: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  return fragments;
}

/** The fields of a selection set with its fragment spreads and inline fragments flattened, in document order. */
function fieldsOf(selectionSet: SelectionSetNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>): FieldNode[] {
  return selectionSet.selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) return [selection];
    const inner = selection.kind === Kind.FRAGMENT_SPREAD ? fragments.get(selection.name.value)!.selectionSet : selection.selectionSet;
    return fieldsOf(inner, fragments);
  });
}

function conditionType(condition: NamedTypeNode | undefined): GraphQLNamedType | undefined {
  return condition === undefined ? undefined : forumSchema.getType(condition.name.value) ?? undefined;
}

/** The named type of `parent.name`; `parent` itself when it has no such field (never for a validated document). */
function fieldType(parent: GraphQLNamedType, name: string): GraphQLNamedType {
  const field = isObjectType(parent) || isInterfaceType(parent) ? parent.getFields()[name] : undefined;
  return field === undefined ? parent : getNamedType(field.type);
}

/**
 * A top-level field as the matcher sees it. Every argument becomes a plain JS value; the JSON round trip turns the null-prototype
 * objects of `valueFromASTUntyped` into ordinary ones, which `isDeepStrictEqual` requires to equal a fixture's. A root whose
 * `selector` is a `SelectorInput` is selected by `id` (its `_id`); any other selector's single key is the `view`, its value the terms.
 */
function aliasRequest(field: FieldNode): AliasRequest {
  const root = field.name.value;
  const values: Record<string, unknown> = JSON.parse(
    JSON.stringify(Object.fromEntries((field.arguments ?? []).map((a) => [a.name.value, valueFromASTUntyped(a.value)]))),
  );
  const request: AliasRequest = {
    root,
    args: Object.fromEntries(Object.entries(values).filter(([name]) => !OWN_ARGS.has(name))),
    offset: typeof values.offset === "number" ? values.offset : 0,
    enableTotal: values.enableTotal === true,
  };
  if (typeof values.limit === "number") request.limit = values.limit;
  const selector = values.selector;
  if (isRecord(selector)) {
    const selectorArg = queryFields[root]?.args.find((a) => a.name === "selector");
    if (selectorArg !== undefined && getNamedType(selectorArg.type).name === "SelectorInput") {
      if (typeof selector._id === "string") request.id = selector._id;
    } else {
      const view = Object.keys(selector)[0];
      if (view !== undefined) {
        request.view = view;
        const terms = selector[view];
        request.terms = isRecord(terms) ? terms : {};
      }
    }
  }
  return request;
}

/** `root` equal; `view`, `id`, `limit`, `offset`, `enableTotal` equal when the entry gives them; its `terms` and `args` subsets. */
function aliasMatches(match: GraphqlMatch, request: AliasRequest): boolean {
  return (
    match.root === request.root &&
    (match.view === undefined || match.view === request.view) &&
    (match.id === undefined || match.id === request.id) &&
    (match.limit === undefined || match.limit === request.limit) &&
    (match.offset === undefined || match.offset === request.offset) &&
    (match.enableTotal === undefined || match.enableTotal === request.enableTotal) &&
    isSubset(match.terms, request.terms ?? {}) &&
    isSubset(match.args, request.args)
  );
}

function isSubset(part: Record<string, unknown> | undefined, whole: Record<string, unknown>): boolean {
  return part === undefined || Object.entries(part).every(([key, value]) => Object.hasOwn(whole, key) && isDeepStrictEqual(whole[key], value));
}

/** `<alias>: <root>[.<view>] <JSON>`, the JSON holding only what the request gives: id, terms, args, limit, offset ≠ 0, enableTotal. */
function describeAlias(alias: string, request: AliasRequest): string {
  const described = {
    ...(request.id !== undefined && { id: request.id }),
    ...(request.view !== undefined && { terms: request.terms }),
    ...(Object.keys(request.args).length > 0 && { args: request.args }),
    ...(request.limit !== undefined && { limit: request.limit }),
    ...(request.offset !== 0 && { offset: request.offset }),
    ...(request.enableTotal && { enableTotal: true }),
  };
  return `${alias}: ${request.root}${request.view ? "." + request.view : ""} ${JSON.stringify(described)}`;
}

/** A resolver error in the forum's shape (§4.8): `code` INTERNAL_SERVER_ERROR and a server stack trace that callers must strip. */
function resolverError(error: FixtureError, alias: string): Record<string, unknown> {
  return {
    message: error.message,
    locations: [{ line: 1, column: 1 }],
    path: error.path ?? [alias],
    extensions: { code: "INTERNAL_SERVER_ERROR", stacktrace: ["Error: " + error.message, STACK_FRAME] },
  };
}

/** Sets `out[key]`; a key produced twice (the same field from several fragments) is deep-merged, objects by key. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  out[key] = Object.hasOwn(out, key) ? merged(out[key], value) : value;
}

function merged(earlier: unknown, later: unknown): unknown {
  if (isRecord(earlier) && isRecord(later)) {
    const out = { ...earlier };
    for (const [key, value] of Object.entries(later)) put(out, key, value);
    return out;
  }
  return later;
}

function queryRequest(query: unknown): QueryRequest {
  const { indexName, params } = isRecord(query) ? query : {};
  const p = isRecord(params) ? params : {};
  return {
    index: String(indexName),
    query: p.query,
    page: typeof p.page === "number" ? p.page : 0,
    hitsPerPage: typeof p.hitsPerPage === "number" ? p.hitsPerPage : DEFAULT_HITS_PER_PAGE,
    facetFilters: Array.isArray(p.facetFilters) ? p.facetFilters : [],
    numericFilters: Array.isArray(p.numericFilters) ? p.numericFilters : [],
  };
}

/** `index` equal; `query`, `page`, `hitsPerPage`, `facetFilters`, `numericFilters` equal when the entry gives them. */
function queryMatches(match: SearchMatch, request: QueryRequest): boolean {
  return (
    match.index === request.index &&
    (match.query === undefined || match.query === request.query) &&
    (match.page === undefined || match.page === request.page) &&
    (match.hitsPerPage === undefined || match.hitsPerPage === request.hitsPerPage) &&
    (match.facetFilters === undefined || isDeepStrictEqual(match.facetFilters, request.facetFilters)) &&
    (match.numericFilters === undefined || isDeepStrictEqual(match.numericFilters, request.numericFilters))
  );
}

/** `search <index> <JSON>` with query, page and hitsPerPage, and the filters only when the request gives some. */
function describeQuery(request: QueryRequest): string {
  const { query, page, hitsPerPage, facetFilters, numericFilters } = request;
  const described = {
    query, page, hitsPerPage,
    ...(facetFilters.length > 0 && { facetFilters }),
    ...(numericFilters.length > 0 && { numericFilters }),
  };
  return `search ${request.index} ${JSON.stringify(described)}`;
}
