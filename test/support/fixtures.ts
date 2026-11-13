// The hand-built fixture families (¶9.1, ¶C, D14): their entry types, the family loader and the fixture-field schema check.
// Every family is one JSON list in test/fixtures/hand/<family>.json; each entry answers one GraphQL alias (`match.root`) or one
// search query (`match.index`) and names its `source`. `checkFixtureFields` keeps the GraphQL
// documents from drifting from the forum's schema (C2): every root, view and field they name must exist there.
import { readFileSync } from "node:fs";
import { getNamedType, isInputObjectType, isObjectType, type GraphQLNamedType } from "graphql";
import { forumSchema } from "../schema";

export type FixtureFamily =
  | "posts" | "comments" | "joins" | "lists" | "revisions" | "users" | "tags" | "sequences" | "search" | "feeds" | "transport";

/**
 * Every family, in the order of the `FixtureFamily` union with `transport` last: the transport family's two post entries share
 * their keys with posts.json and are meant to be shadowed by it wherever every family is loaded (the first match wins).
 */
export const ALL_FAMILIES: readonly FixtureFamily[] = [
  "posts", "comments", "joins", "lists", "revisions", "users", "tags", "sequences", "search", "feeds", "transport",
];

/** One GraphQL alias: `root` and every other key the entry gives must agree with the request (`terms` and `args` as subsets). */
export interface GraphqlMatch {
  root: string;
  view?: string;
  terms?: Record<string, unknown>;
  id?: string;
  args?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  enableTotal?: boolean;
}

/** One search query: `index` (with its sort suffix) and every other key the entry gives must equal the request's. */
export interface SearchMatch {
  index: string;
  query?: string;
  page?: number;
  hitsPerPage?: number;
  facetFilters?: string[][];
  numericFilters?: string[];
}

export interface FixtureEntry {
  source: string;
  match: GraphqlMatch | SearchMatch;
  result?: unknown;
  error?: { message: string; dataNull?: boolean; path?: (string | number)[]; status?: number };
}

/** The entries of one family file's text; a malformed file (a stray comma in a hand-built entry) names itself in the error. */
export function parseFamily(name: string, text: string): FixtureEntry[] {
  try {
    return JSON.parse(text) as FixtureEntry[];
  } catch (e) {
    throw new Error(`test/fixtures/hand/${name}.json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The entries of each named family in the order given, freshly parsed. */
export function loadFamilies(...names: FixtureFamily[]): FixtureEntry[] {
  return names.flatMap((name) => {
    const file = new URL("../fixtures/hand/" + name + ".json", import.meta.url);
    return parseFamily(name, readFileSync(file, "utf8"));
  });
}

/**
 * The schema problems of the GraphQL entries that carry a result, in entry order and each once: an unknown root, a view that is
 * not a key of the root's `selector` input, and every key of the result document that is not a field of its type. Search entries
 * and entries without a result are skipped. The walk unwraps lists and non-null types and stops at scalars (`JSON` included),
 * enums and abstract types.
 */
export function checkFixtureFields(entries: readonly FixtureEntry[]): string[] {
  const queryFields = forumSchema.getQueryType()!.getFields();
  const found: string[] = [];
  for (const entry of entries) {
    if (!("root" in entry.match) || entry.result === undefined || entry.result === null) continue;
    const { root, view } = entry.match;
    const at = `${entry.source} ${root}:`;
    const field = queryFields[root];
    if (field === undefined) {
      found.push(`${at} root does not exist`);
      continue;
    }
    if (view !== undefined) {
      const selector = field.args.find((a) => a.name === "selector");
      const selectorType = selector && getNamedType(selector.type);
      const views = isInputObjectType(selectorType) ? selectorType.getFields() : {};
      if (!Object.hasOwn(views, view)) found.push(`${at} view ${view} does not exist`);
    }
    walk(entry.result, getNamedType(field.type), (message) => found.push(`${at} ${message}`));
  }
  return [...new Set(found)];
}

function walk(value: unknown, type: GraphQLNamedType, report: (message: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, type, report);
    return;
  }
  if (value === null || typeof value !== "object" || !isObjectType(type)) return;
  const fields = type.getFields();
  for (const [key, child] of Object.entries(value)) {
    if (key === "__typename") continue;
    const field = fields[key];
    if (field === undefined) report(`${type.name}.${key} does not exist`);
    else walk(child, getNamedType(field.type), report);
  }
}
