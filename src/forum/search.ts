// Layer 4. The search builder and runner (¶4.2, ¶7, ¶8 forum/search.ts row). `buildSearch` turns each
// SearchSpec into one query on one index (Q24) whose name carries the sort suffix, whose text quotes exact and rewritten phrases
// and sends loose ones as plain words (simple mode when every phrase is loose, ¶4.2 step 2), whose facets come only from the
// per-index table of live-confirmed facets with validated ids and booleans as values (Q128, Q37, Q38), and whose dates are
// integer filters on two fields (Q35, Q36). Page sizes are the per-index caps (Q127) and the depth limit is checked here as a
// backstop (Q22). Every builder refusal is `internal`: the tools refuse the caller's bad combinations first, so one reaching
// this module is a bug of this server. The runner of `createSearch` sends its queries as one POST, refused before sending when the
// estimated response passes 4 MB (¶7), parses the `text/plain` answer as JSON (Q27) and maps the forum's errors (¶8, Q86): the
// depth 400 ends every query of the body (Q23), any other 400 is `internal`, a 200 it cannot read is `forum_error` and leaves the
// raw-response cache (¶2.3), and the 500 never arrives here (forum/http.ts retries it once, then raises `forum_error`).
import { CONFIG } from "../config";
import { forumError, internalError, type ToolError } from "../errors";
import { ID_RE } from "../ids/parse";
import { toSearchFilters } from "../text/dates";
import { cutMessage } from "../text/sanitize";
import type { CallContext, EsQuery, Facet, Http, SearchIndex, SearchResult, SearchSort, SearchSpec } from "../types";

export type SearchRunner = (
  queries: readonly EsQuery[],
  ctx: CallContext,
  task: string,
  emptyString?: "empty" | "default",
) => Promise<SearchResult[]>;

/** ¶4.2 per-index facet table (Q128): the live-confirmed facets, and no other. */
export const FACETS: Readonly<Record<SearchIndex, readonly Facet["field"][]>> = Object.freeze({
  posts: Object.freeze(["af", "userId", "tags._id"] as const),
  comments: Object.freeze(["af", "userId", "postId.keyword", "tags"] as const),
  users: Object.freeze(["af"] as const),
  tags: Object.freeze(["wikiOnly"] as const),
  sequences: Object.freeze(["af"] as const),
});

/** The facets whose value is an entity id; every other facet's value is the boolean `true`. */
const ID_FACETS: ReadonlySet<Facet["field"]> = new Set(["userId", "tags._id", "postId.keyword", "tags"]);
/** ¶3.4: date filters exist on posts and comments only. */
const DATED_INDEXES: ReadonlySet<SearchIndex> = new Set(["posts", "comments"]);
const SORT_SUFFIX: Readonly<Record<SearchSort, string>> = { relevance: "", new: "_newest_first", old: "_oldest_first", top: "_karma" };

/** The depth error's text, found anywhere in the 400 message (`search_phase_execution_exception … Result window is too large, …`). */
const DEPTH_ERROR = "Result window is too large";
const NON_JSON = "unexpected non-JSON response (possibly bot protection)";
const MALFORMED = "malformed search response";
/** The estimate for an index name this module does not know: the largest per-hit size, so the budget is never skipped. */
const LARGEST_HIT_BYTES = Math.max(...Object.values(CONFIG.search.estBytesPerHit));

function refuse(detail: string): ToolError {
  return internalError("search", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Q24: one index per query, its sort in the name; `sequences_karma` is a forum 400 (§5.5), so it is refused here. */
export function indexName(index: SearchIndex, sort: SearchSort): string {
  if (index === "sequences" && sort === "top") throw refuse("sequences can't be sorted by karma");
  return index + SORT_SUFFIX[sort];
}

/**
 * ¶4.2 step 2 (§5.2): `query` unquoted, exact and rewritten phrases in `"…"`, loose phrases as plain words, `-word` excludes.
 * When every phrase is loose, nothing is quoted or excluded (a `-x` would switch the forum to advanced mode, which deletes the
 * loose phrases' letters), so `exclude` is applied locally instead. Empty parts are dropped.
 */
export function buildText(spec: SearchSpec): { text: string; simple: boolean; excludeLocally: boolean } {
  const phrases = spec.phrases ?? [];
  const exclude = spec.exclude ?? [];
  if (phrases.length > 0 && phrases.every((p) => p.mode === "loose")) {
    return { text: words([spec.query, ...phrases.map((p) => p.sent)]), simple: true, excludeLocally: exclude.length > 0 };
  }
  const text = words([
    spec.query,
    ...phrases.map((p) => (p.mode === "loose" ? p.sent : `"${p.sent}"`)),
    ...exclude.map((w) => `-${w}`),
  ]);
  return { text, simple: phrases.length === 0 && exclude.length === 0, excludeLocally: false };
}

function words(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}

/** One query per spec, refused (`internal`) when it breaks a page cap, the depth limit, the facet table or the date rule. */
export function buildSearch(specs: readonly SearchSpec[]): EsQuery[] {
  return specs.map(buildQuery);
}

function buildQuery(spec: SearchSpec): EsQuery {
  const { index, page } = spec;
  const cap = CONFIG.search.hitsPerPage[index];
  const hitsPerPage = spec.hitsPerPage ?? cap;
  if (hitsPerPage > cap) throw refuse(`hitsPerPage ${hitsPerPage} over ${cap} for ${index}`);
  if (page * hitsPerPage + hitsPerPage > CONFIG.search.maxDepth) {
    throw refuse(`page ${page} past the depth of ${CONFIG.search.maxDepth.toLocaleString("en-US")}`);
  }
  const facetFilters = (spec.facets ?? []).map((facet) => facetFilter(index, facet));
  let numericFilters: string[] = [];
  if (spec.range !== undefined) {
    if (!DATED_INDEXES.has(index)) throw refuse(`date filters on ${index}`);
    numericFilters = toSearchFilters(spec.range);
  }
  // Key order matters: the POST body is this object's JSON.
  return {
    indexName: indexName(index, spec.sort),
    params: {
      query: buildText(spec).text,
      hitsPerPage,
      page,
      ...(facetFilters.length > 0 && { facetFilters }),
      ...(numericFilters.length > 0 && { numericFilters }),
      highlightPreTag: "**",
      highlightPostTag: "**",
    },
  };
}

/** One inner array per facet, so facets on different fields are ANDed (§5.4); the table first, then negation, then the value. */
function facetFilter(index: SearchIndex, facet: Facet): string[] {
  const { field } = facet;
  if (!FACETS[index].includes(field)) throw refuse(`facet ${field} is not in the table for ${index}`);
  const negate = "negate" in facet && facet.negate === true;
  if (negate && !(field === "tags._id" && index === "posts")) throw refuse(`negated facet ${field} on ${index}`);
  // §5.4: a value is cut at its first `:` and a leading `-` negates it, so only ids (and `true`) are ever sent.
  if (ID_FACETS.has(field) && !(typeof facet.value === "string" && ID_RE.test(facet.value))) {
    throw refuse(`facet value for ${field} is not an id`);
  }
  return [`${field}:${negate ? "-" : ""}${String(facet.value)}`];
}

/** ¶7, Q127: the estimated response size, Σ `hitsPerPage` × the per-hit estimate of the query's index (its name before the first `_`). */
export function estimateBytes(queries: readonly EsQuery[]): number {
  const perHit: Readonly<Record<string, number>> = CONFIG.search.estBytesPerHit;
  return queries.reduce((sum, q) => {
    const index = q.indexName.split("_", 1)[0]!;
    return sum + q.params.hitsPerPage * (Object.hasOwn(perHit, index) ? perHit[index]! : LARGEST_HIT_BYTES);
  }, 0);
}

/** ¶4.2 step 5: the POST body; `"default"` makes an empty query list everything matching the filters (§5.1). */
export function searchBody(queries: readonly EsQuery[], emptyString: "empty" | "default"): string {
  return JSON.stringify({ options: { emptyStringSearchResults: emptyString }, queries });
}

export function createSearch(http: Http): SearchRunner {
  return async (queries, ctx, task, emptyString = "empty") => {
    if (queries.length === 0) return [];
    const estimate = estimateBytes(queries);
    if (estimate > CONFIG.search.maxRequestBytes) {
      throw internalError(ctx.tool, `search: estimated ${estimate} bytes over the ${CONFIG.search.maxRequestBytes / 1_048_576} MB budget`);
    }
    const res = await http.fetch(
      {
        endpoint: "search",
        body: searchBody(queries, emptyString),
        label: `search ${[...new Set(queries.map((q) => q.indexName))].join(",")}`,
        task,
      },
      ctx,
    );

    if (res.status === 400) {
      // Q23: one failing query fails the whole body, so the depth error ends every query of it.
      if (res.text.includes(DEPTH_ERROR)) return queries.map(endedResult);
      throw internalError(ctx.tool, `search: ${cutMessage(res.text)}`);
    }

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
    if (!Array.isArray(parsed) || parsed.length !== queries.length || !parsed.every(isSearchResult)) throw unreadable(MALFORMED);
    // Only these fields are kept (the echoes, timings and dummy fields of §5.7 are dropped).
    return parsed.map(({ hits, nbHits, page, nbPages, hitsPerPage, index }) => ({ hits, nbHits, page, nbPages, hitsPerPage, index }));
  };
}

function endedResult(q: EsQuery): SearchResult {
  return { hits: [], nbHits: 0, page: q.params.page, nbPages: null, hitsPerPage: q.params.hitsPerPage, index: q.indexName, ended: true };
}

/** §5.6, §5.7: one result per query; `nbPages` is `null` only for `hitsPerPage: 0`. */
function isSearchResult(value: unknown): value is SearchResult {
  return (
    isRecord(value) &&
    Array.isArray(value.hits) &&
    value.hits.every(isRecord) &&
    typeof value.nbHits === "number" &&
    typeof value.page === "number" &&
    (value.nbPages === null || typeof value.nbPages === "number") &&
    typeof value.hitsPerPage === "number" &&
    typeof value.index === "string"
  );
}
