// Layer 4. Inline GraphQL literals (R4, D6): the forum is sent no variables, so every value in a template is written
// into its text by one of these builders. Strings are JSON-escaped, ids must match `ID_RE`, `Date` arguments are
// exactly `YYYY-MM-DDTHH:MM:SS.SSSZ` (Q11), and sort terms come only from closed sets. A string that is not
// well-formed UTF-16 is the caller's bad input (¶8); every other refusal is an internal error, because the callers
// validate first. No refusal echoes the value it refused.
import { badInput, internalError } from "../errors";
import { ID_RE } from "../ids/parse";
import { isoMs } from "../text/dates";

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const DATE_LITERAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A GraphQL string literal. A lone surrogate is refused as `bad_input` named after `param`, before anything is
 * escaped: `JSON.stringify` would write it as `\ud800`, which the forum's parser rejects, failing the whole operation.
 */
export function str(s: string, param = "query"): string {
  if (!s.isWellFormed()) {
    throw badInput(param, "contains a character that is not valid text (an unpaired surrogate)", "Remove it and try again.");
  }
  return JSON.stringify(s);
}

/** A quoted entity id, which must pass `ID_RE` (17 alphanumeric characters, or 24 hex). */
export function idLit(id: string): string {
  if (!ID_RE.test(id)) throw internalError("idLit", "not a valid id");
  return JSON.stringify(id);
}

/** A quoted `Date`, exactly `YYYY-MM-DDTHH:MM:SS.SSSZ`: four-digit years only, so no `+010000-…` or `-000001-…`. */
export function dateLit(ms: number): string {
  const iso = Number.isNaN(new Date(ms).getTime()) ? "" : isoMs(ms);
  if (!DATE_LITERAL_RE.test(iso)) throw internalError("dateLit", "not a date in the literal range");
  return JSON.stringify(iso);
}

export function int(n: number): string {
  if (!Number.isSafeInteger(n)) throw internalError("int", "not a safe integer");
  return String(n);
}

export function bool(b: boolean): string {
  return b ? "true" : "false";
}

/** `[a, b]` from items that are already literals. */
export function list(items: readonly string[]): string {
  return `[${items.join(", ")}]`;
}

/** `{k: v, …}` from values that are already literals; an `undefined` value leaves its field out, and order is kept. */
export function obj(fields: Readonly<Record<string, string | undefined>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!GRAPHQL_NAME_RE.test(key)) throw internalError("obj", "not a GraphQL name");
    parts.push(`${key}: ${value}`);
  }
  return `{${parts.join(", ")}}`;
}

/** A String-typed sort term (R4): quoted, and only a member of its closed set. */
export function enumTerm<T extends string>(value: T, allowed: readonly T[]): string {
  if (!allowed.includes(value)) throw internalError("enumTerm", "value outside its closed set");
  return JSON.stringify(value);
}
