// Layer 4. The GraphQL runner (¶8 forum/gql.ts row): runs template ops as one forum request and maps the answer alias by alias.
// The ops that share an operation go in chunks of at most 100 aliases (R11), then each non-null root alone (R6); a request with
// more than one operation, or with an isolated one, is an array batch (one HTTP request). Before anything is sent, an op on an
// excluded path whose subject this call has not confirmed public is refused (P17, the runtime guard of ¶8's call/context row).
// Every answer is parsed whatever its HTTP status (R9, S7): a parse or validation failure loses every alias of its operation
// (`internal`, naming the template: Q83), a whole-operation `data: null` is mapped by its first error (Q84), and otherwise each
// alias is matched to the errors whose `path` starts with it (Q85, S8), an error below a non-null alias leaving its data in place.
// Of an error object only its `message` is read out, cut to 200 characters (¶8 message hygiene, Q75): stack traces, `locations`,
// `extensions` and paths never leave this module. An answer holding any error but `not_found` or `not_public` is evicted from
// the raw-response cache (¶2.3).
import { CONFIG } from "../config";
import { forumError, internalError, type ToolError } from "../errors";
import { cutMessage } from "../text/sanitize";
import type { AliasResult, AliasResults, CallContext, Category, GqlOp, Http } from "../types";
import { documentFor } from "./templates/op";

export type GqlRunner = (ops: readonly GqlOp[], ctx: CallContext, task: string) => Promise<AliasResults>;

/** ¶8 GraphQL message table: each entry a prefix of the forum's message, the first match wins; anything else is `forum_error`. */
const MESSAGE_CATEGORIES: readonly (readonly [prefix: string, category: Category])[] = [
  ["app.missing_document", "not_found"],
  ["app.operation_not_allowed", "not_public"],
  ["This post is only visible to logged-in users.", "login_only"],
  ["Tag not found", "not_found"],
  // The pager, the inline literals, the date formatting, the field selection (R8, Q99) and the root allow-list prevent these.
  ...[
    "Exceeded maximum value for skip",
    "OFFSET must not be negative",
    "app.conflicting_term_and_resolver_arg_keys",
    "Invalid view argument",
    "Invalid postCommentsNew view",
    "Missing view argument",
    "Invalid time field",
    "Invalid value for timeField",
    "Cannot read properties of undefined",
    "invalid input syntax for type timestamp",
    "Cannot return null for non-nullable field",
    "Cannot resolve field name: af",
    "Must be logged in",
    "You must be logged in",
    "You must be an admin",
    "Only admins",
    "This feature is only available to admins",
  ].map((prefix) => [prefix, "internal"] as const),
];

/** The codes of a request-level failure: the operation never ran, so every alias of it is lost (§4.8). */
const REQUEST_FAILURES: ReadonlySet<unknown> = new Set(["GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"]);

/** P17: the term (or, for a single root, the selector's `_id`) that names an excluded path's subject; the first one in the text. */
const SUBJECT_ID_RE = /\b(?:postId|tagId|documentId|sequenceId|_id): "([A-Za-z0-9]+)"/;

const NON_JSON = "unexpected non-JSON response (possibly bot protection)";
const MALFORMED = "malformed response";
const LACKED = "the forum's answer lacked this part";
/** Stands in for the message of an error that carries none, or of a failed operation that sent no error. */
const NO_MESSAGE = "the forum gave no error message";

/** The categories whose answers may stay in the raw-response cache (¶2.3); any other alias error evicts the answer. */
const CACHEABLE_ERRORS: ReadonlySet<Category> = new Set(["not_found", "not_public"]);

/** One operation of a request: its ops share one `query`, named after its first op's template. */
interface Operation {
  name: string;
  ops: readonly GqlOp[];
}

/** What is read of one error object: its message and the start of its path; `code` only to tell a request-level failure apart. */
interface ForumErrorRead {
  message: string;
  path: readonly unknown[];
  code: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ¶8 Q82: the category of a forum error message. */
export function categoryOf(message: string): Category {
  return MESSAGE_CATEGORIES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? "forum_error";
}

export function createGql(http: Http, opts?: { maxAliases?: number }): GqlRunner {
  const maxAliases = opts?.maxAliases ?? CONFIG.paging.maxAliases;

  return async (ops, ctx, task) => {
    if (ops.length === 0) return new Map();
    const seen = new Set<string>();
    for (const op of ops) {
      if (seen.has(op.alias)) throw internalError(ctx.tool, `${op.template}: duplicate alias ${op.alias}`);
      seen.add(op.alias);
    }
    for (const op of ops) assertSubjectConfirmed(op, ctx);

    const operations = operationsOf(ops, maxAliases);
    const payload = operations.map(({ name, ops: its }) => ({ query: documentFor(name, its), operationName: name }));
    // R6: an isolated operation goes in an array batch even when it is the only one.
    const batch = operations.length > 1 || ops.some((op) => op.isolate);
    const ttls = ops.flatMap((op) => (op.ttlMs === undefined ? [] : [op.ttlMs]));
    const res = await http.fetch(
      {
        endpoint: "graphql",
        body: JSON.stringify(batch ? payload : payload[0]),
        label: operations.map((o) => o.name).join("+"),
        task,
        ...(ttls.length > 0 && { ttlMs: Math.min(...ttls) }),
      },
      ctx,
    );

    // A cached 200 that cannot be read is an error too, so it must not be served again (¶2.3).
    const unreadable = (short: string): ToolError => {
      http.evict([res.cacheKey]);
      return forumError(task, short);
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw unreadable(NON_JSON);
    }
    const results = batch ? parsed : [parsed];
    if (!Array.isArray(results) || results.length !== operations.length || !results.every(isOperationResult)) {
      throw unreadable(MALFORMED);
    }

    const byAlias = new Map<string, AliasResult>();
    operations.forEach((operation, i) => {
      for (const [alias, result] of operationResults(results[i], operation.ops)) byAlias.set(alias, result);
    });
    if ([...byAlias.values()].some((r) => "error" in r && !CACHEABLE_ERRORS.has(r.error))) http.evict([res.cacheKey]);
    return new Map(ops.map((op) => [op.alias, byAlias.get(op.alias)!]));
  };
}

/** P17 at run time: an op on an excluded path is sent only for a subject this call confirmed public (`internal` otherwise). */
function assertSubjectConfirmed(op: GqlOp, ctx: CallContext): void {
  if (op.publicSubject === undefined) return;
  const id = SUBJECT_ID_RE.exec(op.text)?.[1];
  if (id === undefined || !ctx.isConfirmed(op.publicSubject, id)) {
    throw internalError(ctx.tool, `${op.template}: excluded path for a subject not confirmed public in this call`);
  }
}

/** The ops that may share an operation, in order and in chunks of at most `maxAliases` (R11), then each isolated op alone (R6). */
function operationsOf(ops: readonly GqlOp[], maxAliases: number): Operation[] {
  const shared = ops.filter((op) => !op.isolate);
  const groups: GqlOp[][] = [];
  for (let from = 0; from < shared.length; from += maxAliases) groups.push(shared.slice(from, from + maxAliases));
  for (const op of ops) if (op.isolate) groups.push([op]);
  return groups.map((group) => ({ name: group[0]!.template, ops: group }));
}

/** One operation's answer is an object whose `data`, when present, is null or an object and whose `errors`, when present, a list. */
function isOperationResult(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (!Object.hasOwn(value, "data") || value.data === null || isRecord(value.data)) &&
    (value.errors === undefined || Array.isArray(value.errors))
  );
}

function readErrors(errors: unknown): ForumErrorRead[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => {
    const error = isRecord(e) ? e : {};
    return {
      message: typeof error.message === "string" && error.message !== "" ? error.message : NO_MESSAGE,
      path: Array.isArray(error.path) ? error.path : [],
      code: isRecord(error.extensions) ? error.extensions.code : undefined,
    };
  });
}

/** An alias error: the forum's message cut (¶8), and an `internal` one prefixed with the template that caused it. */
function aliasError(category: Category, message: string, op: GqlOp): AliasResult {
  const cut = cutMessage(message);
  return { error: category, message: category === "internal" ? `${op.template}: ${cut}` : cut };
}

/** The result of each alias of one operation, from that operation's answer `r`. */
function operationResults(r: Record<string, unknown>, ops: readonly GqlOp[]): [string, AliasResult][] {
  const errors = readErrors(r.errors);
  const first = errors[0]?.message ?? NO_MESSAGE;
  if (!Object.hasOwn(r, "data") || errors.some((e) => REQUEST_FAILURES.has(e.code))) {
    return ops.map((op) => [op.alias, aliasError("internal", first, op)]);
  }
  if (r.data === null) {
    const category = categoryOf(first);
    return ops.map((op) => [op.alias, aliasError(category, first, op)]);
  }
  const data = r.data as Record<string, unknown>;
  return ops.map((op): [string, AliasResult] => {
    if (!Object.hasOwn(data, op.alias)) return [op.alias, { error: "forum_error", message: LACKED }];
    const own = errors.filter((e) => e.path[0] === op.alias);
    const value = data[op.alias];
    if (value !== null) return [op.alias, { data: value }];
    // S8: a null alias is an error only when an error names it; without one it is the forum's own "nothing here".
    if (own.length > 0) return [op.alias, aliasError(categoryOf(own[0]!.message), own[0]!.message, op)];
    return [op.alias, { data: null }];
  });
}
