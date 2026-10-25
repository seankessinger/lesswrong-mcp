// Layer 4. The comment lists of `list_comments` (¶4.6): `allRecentComments` for ordinary comments, site-wide or by one person
// (`sortBy` is a term of this view alone, R4, §9.4), and `topShortform` for top-level quick takes, which takes no `sortBy` at
// all (R4, Q74). Every term is an inline literal in a fixed order, each only when set; `after` is inclusive and `before`
// exclusive, both `YYYY-MM-DDTHH:MM:SS.SSSZ` (Q11, Q12). The answer is `COMMENT_LIST` rows, or `COMMENT_LIGHT` rows for a light
// set or an `af_only` scan, with `totalCount` when the page asks for it (bounded selectors only, which here means a `userId`,
// P10). Pure: no services, caches or domain code.
import { internalError } from "../../errors";
import type { GqlOp } from "../../types";
import { enumTerm, idLit, int, str } from "../literal";
import { op } from "./op";

/** The terms of `allRecentComments`, in the order they are written. */
export interface AllRecentTerms {
  userId?: string;
  sortBy: "new" | "old" | "top";
  after?: string;     // inclusive lower bound, `YYYY-MM-DDTHH:MM:SS.SSSZ`
  before?: string;    // exclusive upper bound, same form
  minimumKarma?: number;
}

/** One page of a comment list: `limit` rows from `offset` (when given), with `totalCount` when `enableTotal` is set. */
interface Page { limit: number; offset?: number; enableTotal?: true }

const SORT_BY: readonly AllRecentTerms["sortBy"][] = ["new", "old", "top"];
const DATE_BOUND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = { list: "...COMMENT_LIST", light: "...COMMENT_LIGHT" } as const;

function dateTerm(template: string, bound: string | undefined): string | undefined {
  if (bound === undefined) return undefined;
  if (!DATE_BOUND_RE.test(bound)) throw internalError(template, "not a YYYY-MM-DDTHH:MM:SS.SSSZ date");
  return str(bound, "date");
}

function selection(fields: "list" | "light", page: Page): string {
  return `{ results { ${FIELDS[fields]} }${page.enableTotal ? " totalCount" : ""} }`;
}

/**
 * Ordinary comments (template `list_comments_allRecent`): `terms` as sent, `page` as the raw page, `fields` the selection
 * (`"list"`: `COMMENT_LIST`; `"light"`: `COMMENT_LIGHT`), under `alias`.
 */
export function allRecentCommentsOp(alias: string, terms: AllRecentTerms, page: Page, fields: "list" | "light"): GqlOp {
  const template = "list_comments_allRecent";
  return op({
    template, alias, root: "comments", view: "allRecentComments",
    terms: {
      userId: terms.userId === undefined ? undefined : idLit(terms.userId),
      sortBy: enumTerm(terms.sortBy, SORT_BY),
      after: dateTerm(template, terms.after),
      before: dateTerm(template, terms.before),
      minimumKarma: terms.minimumKarma === undefined ? undefined : int(terms.minimumKarma),
    },
    limit: page.limit, offset: page.offset, enableTotal: page.enableTotal,
    select: selection(fields, page),
  });
}

/**
 * Top-level quick takes as a light set (template `list_comments_quick_takes`): no `sortBy` and no `minimumKarma`, because the
 * set is ordered and filtered here (Q74, R4).
 */
export function topShortformOp(
  alias: string,
  terms: { userId?: string; after?: string; before?: string },
  page: Page,
): GqlOp {
  const template = "list_comments_quick_takes";
  return op({
    template, alias, root: "comments", view: "topShortform",
    terms: {
      userId: terms.userId === undefined ? undefined : idLit(terms.userId),
      after: dateTerm(template, terms.after),
      before: dateTerm(template, terms.before),
    },
    limit: page.limit, offset: page.offset, enableTotal: page.enableTotal,
    select: selection("light", page),
  });
}
