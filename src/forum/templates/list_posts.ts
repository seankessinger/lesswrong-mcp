// Layer 4. The post lists of `list_posts` (¶4.5): one view key per request (R1), chosen by the tool: `userPosts` for a
// person's own and coauthored posts, `tagRelevance` for a tag's posts, and the site-wide `new`, `old`, `top`,
// `recentComments` and `curated` views. The selector terms are written in a fixed order, each only when set; every view
// gets `excludeEvents: true` (D11), and a tag filter is the `Required` filter-settings object (R7: `tagRelevance` itself
// does not filter, §10.4; inside `userPosts` it selects the person's tagged posts, §6.2). `sortedBy` and `filter` come only
// from their closed sets (R4): `relevance` is a `tagRelevance` order only. The answer is `POST_CARD_EXCERPT` rows, or
// `POST_LIGHT` rows for a light scan, with `totalCount` when the page asks for it (bounded selectors only, P10).
// Pure: no services, caches or domain code.
import { internalError } from "../../errors";
import type { GqlOp } from "../../types";
import { bool, enumTerm, idLit, int, list, obj, str } from "../literal";
import { op } from "./op";

export type PostsView = "userPosts" | "tagRelevance" | "new" | "old" | "top" | "recentComments" | "curated";

export interface ListPostsTerms {
  userId?: string;
  tagId?: string;
  sortedBy?: "new" | "old" | "top" | "recentComments" | "relevance";
  after?: string;     // inclusive lower bound, `YYYY-MM-DDTHH:MM:SS.SSSZ`
  before?: string;    // exclusive upper bound, same form
  af?: true;
  question?: true;
  karmaThreshold?: number;
  filter?: "curated" | "frontpage";
}

type SortedBy = NonNullable<ListPostsTerms["sortedBy"]>;
type Filter = NonNullable<ListPostsTerms["filter"]>;

const TEMPLATE = "list_posts";
/** R4, §6.2: the orders every `posts` view takes; `tagRelevance` also takes `relevance` (§10.4). */
const SORTED_BY: readonly SortedBy[] = ["new", "old", "top", "recentComments"];
const SORTED_BY_TAG_RELEVANCE: readonly SortedBy[] = [...SORTED_BY, "relevance"];
/** R4, §6.2: the named fragments `filter` selects. */
const FILTERS: readonly Filter[] = ["curated", "frontpage"];
const DATE_BOUND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = { excerpt: "...POST_CARD_EXCERPT", light: "...POST_LIGHT" } as const;

function dateTerm(bound: string | undefined): string | undefined {
  if (bound === undefined) return undefined;
  if (!DATE_BOUND_RE.test(bound)) throw internalError(TEMPLATE, "not a YYYY-MM-DDTHH:MM:SS.SSSZ date");
  return str(bound, "date");
}

/** R7: `{tags: [{tagId, filterMode: "Required"}]}`, the filter that keeps only the posts tagged with `tagId`. */
function requiredTag(tagId: string): string {
  return obj({ tags: list([obj({ tagId: idLit(tagId), filterMode: str("Required") })]) });
}

/** The filters every view shares, in the order of the view's terms after its own leading ones. */
function filterTerms(terms: ListPostsTerms): Record<string, string | undefined> {
  return {
    af: terms.af ? bool(true) : undefined,
    question: terms.question ? bool(true) : undefined,
    karmaThreshold: terms.karmaThreshold === undefined ? undefined : int(terms.karmaThreshold),
    filter: terms.filter === undefined ? undefined : enumTerm(terms.filter, FILTERS),
  };
}

/** The selector terms of `view`, in the fixed order of ¶4.5. */
function selectorTerms(view: PostsView, terms: ListPostsTerms): Record<string, string | undefined> {
  const sortedBy = terms.sortedBy === undefined
    ? undefined
    : enumTerm(terms.sortedBy, view === "tagRelevance" ? SORTED_BY_TAG_RELEVANCE : SORTED_BY);
  const after = dateTerm(terms.after);
  const before = dateTerm(terms.before);
  const excludeEvents = bool(true);
  switch (view) {
    case "userPosts": {
      if (terms.userId === undefined) throw internalError(TEMPLATE, "userPosts without a userId");
      return {
        userId: idLit(terms.userId), sortedBy, after, before, excludeEvents, ...filterTerms(terms),
        filterSettings: terms.tagId === undefined ? undefined : requiredTag(terms.tagId),
      };
    }
    case "tagRelevance": {
      if (terms.tagId === undefined) throw internalError(TEMPLATE, "tagRelevance without a tagId");
      if (terms.userId !== undefined) throw internalError(TEMPLATE, "a userId on tagRelevance");
      return { tagId: idLit(terms.tagId), sortedBy, after, before, excludeEvents, ...filterTerms(terms), filterSettings: requiredTag(terms.tagId) };
    }
    default:
      if (terms.userId !== undefined || terms.tagId !== undefined) throw internalError(TEMPLATE, `a person or tag on the site-wide ${view} view`);
      return { sortedBy, excludeEvents, after, before, ...filterTerms(terms) };
  }
}

/**
 * One page of a post list: `limit` rows from `offset` (when given), with `totalCount` when `enableTotal` is set, as
 * `POST_CARD_EXCERPT` (`"excerpt"`) or `POST_LIGHT` (`"light"`) rows, under `alias` (default `l`).
 */
export function listPostsOp(
  view: PostsView,
  terms: ListPostsTerms,
  page: { limit: number; offset?: number; enableTotal?: true },
  fields: "excerpt" | "light",
  alias = "l",
): GqlOp {
  return op({
    template: TEMPLATE, alias, root: "posts", view, terms: selectorTerms(view, terms),
    limit: page.limit, offset: page.offset, enableTotal: page.enableTotal,
    select: `{ results { ${FIELDS[fields]} }${page.enableTotal ? " totalCount" : ""} }`,
  });
}
