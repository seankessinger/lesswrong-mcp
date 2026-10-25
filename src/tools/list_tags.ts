// Layer 2. The `list_tags` tool (¶4.16): the site's tag catalogue, or the tags grouped under one of the 7 core tags. Without `tag`
// the whole catalogue (`allTagsAlphabetical`, at most 2,000 rows) is read in one request, cached for 60 minutes and paged here.
// With `tag` the tag is resolved (with `TAG_LIST`, which carries `coreTagId`) and checked by its `core` flag; a tag that is not
// core is `bad_input` naming the page it is grouped under, and a core tag's grouping (`TagsByCoreTagId`, at most 500 rows, shared
// with `get_tag`'s preview through `loadCoreGrouping`) is paged the same way. Rows that are not listable are dropped before
// anything is counted (P10, P12), wiki-only pages are labelled by their cards, and the grouping's `totalCount` is never read.
// Both sets are a `list` cursor over the cached rows; a set as long as its request allowed ends with "more may exist".
import { z } from "zod";
import { CONFIG } from "../config";
import { toTagRecord } from "../domain/tags";
import { pageOf as pageOfLens, tagListable, tagPublic } from "../domain/visibility";
import { badInput, internalError, type ToolError } from "../errors";
import { allTagsOp, ALL_TAGS_LIMIT } from "../forum/templates/list_tags";
import { CORE_GROUPING_LIMIT, tagByIdOp, tagRefsByIdOps } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { echoOf, resolve } from "../ids/resolve";
import { fingerprint, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, emptyText, endMostReturned } from "../render/messages";
import { tagCard } from "../render/records";
import { oneLine } from "../text/sanitize";
import type {
  CallContext, Consumed, CursorEntry, Footer, PageItem, RawMdocRef, RawTagList, RawTagRef, Resolved, Services, StreamState, ToolDef,
  ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, setting } from "./common";
import { aliasData, loadCoreGrouping, type TagSet } from "./loaders";

export type ListTagsParams = { tag?: string; limit: number; cursor?: string; max_tokens: number };

type ListState = Extract<StreamState, { kind: "list" }>;

const TITLE = "What tags exist, or which tags sit under this core tag?";
/** ¶4.16, verbatim. */
const DESCRIPTION_QUOTE =
  "List tags. Without tag: every tag that can be applied to posts (about 1,010), alphabetically, as on the site's all-tags page. With tag = one of the 7 core tags (rationality, ai, world-modeling, world-optimization, practical, community, site-meta): all the tags grouped under it, in the forum's order (by score, then name); these groupings also include wiki-only pages (articles that can't be applied to posts), labelled. limit counts tags. Each tag shows its ids, page type, the site's count of tagged posts (~, it overcounts) and its parent. Placeholder pages (empty wiki stubs) are not listed; wiki-only pages outside the core groupings are found with find or search kind=tag. Open one with get_tag.";

const CATALOGUE_TASK = "listing the tags";
const LOOKUP_TASK = "looking up the core tag";
const CATALOGUE_KEY = "all";
const UNIT = "items";
const NAME = CONFIG.render.caps.name;

/**
 * ¶3.6: the effective values a cursor compares: the default `limit` applied and `tag` as the id of the core tag it resolved to
 * (absent without one). `get_tag`'s hand-off stores the same keys.
 */
export function listTagsEffective(p: ListTagsParams, ids: { tagId?: string }): Record<string, unknown> {
  return { tag: ids.tagId, limit: p.limit };
}

// the core tag

/** A core tag the call was given: the page's id and the resolution that confirmed it public. */
interface Core { id: string; resolved: Resolved }

/** The page a resolution stands for (P12): a tag is itself, a lens or summary is its page, whose join carries `TAG_REF` only. */
function pageOf(r: Resolved): RawTagRef & { coreTagId?: string | null } {
  const doc = r.doc;
  if (!isRecord(doc)) throw internalError("list_tags", "a resolved tag without its document");
  if (r.kind === "lens" || r.kind === "summary") {
    const page = pageOfLens(doc as unknown as RawMdocRef);
    if (page === null) throw internalError("list_tags", "a resolved lens or summary without its page");
    return page;
  }
  return doc as unknown as RawTagRef & { coreTagId?: string | null };
}

/**
 * The `bad_input` of a tag that is not core, naming the page it is grouped under when it has one that is public. A cached
 * resolution guarantees `TAG_REF` only, which lacks `coreTagId`: it is then read with one `tag(_id)` lookup. Both lookups only
 * improve the wording (the error is known already), so each is sent only while the call may still start a request (¶7: past the
 * 40 s mark, or at the cap of 2: a lens, whose page join also lacks `coreTagId`, resolves, looks up and then goes without the name);
 * without them the text says no more than is certainly true, that the tag is not core.
 */
async function notCore(page: RawTagRef & { coreTagId?: string | null }, name: string, ctx: CallContext, svc: Services): Promise<ToolError> {
  const fail = (where: string): ToolError =>
    badInput("tag", `list_tags takes one of the 7 core tags: ${CONFIG.coreTags.map((t) => t.slug).join(", ")}; "${name}" ${where}`);
  let coreTagId = page.coreTagId;
  if (coreTagId === undefined) {
    if (!ctx.mayStartRequest()) return fail("is not a core tag");
    const data = aliasData(await svc.gql([tagByIdOp("x", page._id, "...TAG_LIST")], ctx, LOOKUP_TASK), "x", LOOKUP_TASK, ctx);
    const row = isRecord(data) ? data.result : undefined;
    coreTagId = isRecord(row) && typeof row.coreTagId === "string" ? row.coreTagId : null;
  }
  if (coreTagId === null) return fail("is not grouped under a core tag");
  if (!ctx.mayStartRequest()) return fail("is not a core tag");
  const data = aliasData(await svc.gql(tagRefsByIdOps("ct", [coreTagId]), ctx, LOOKUP_TASK), "ct1", LOOKUP_TASK, ctx);
  const row = isRecord(data) ? data.result : undefined;
  return fail(isRecord(row) && tagPublic(row as unknown as RawTagRef) ? `is grouped under "${oneLine(String(row.name), NAME)}"` : "is not grouped under a core tag");
}

/** `input` resolved with `TAG_LIST` and checked by its `core` flag, which every cached resolution has (¶4.16). */
async function coreOf(input: string, ctx: CallContext, svc: Services): Promise<Core> {
  const resolved = await resolve(parseRef("tag", input, ["tag"]), "tag", ctx, svc, { select: { tag: "...TAG_LIST" } });
  const page = pageOf(resolved);
  if (!page.core) throw await notCore(page, resolved.name, ctx, svc);
  return { id: page._id, resolved };
}

// the sets

/** The catalogue: from the `tagcat` cache, else one request of at most 2,000 rows, the listable ones kept for 60 minutes. */
async function loadCatalogue(ctx: CallContext, svc: Services): Promise<TagSet> {
  const cached = svc.caches.get<TagSet>("tagcat", CATALOGUE_KEY);
  if (cached !== undefined) return cached;
  const data = aliasData(await svc.gql([allTagsOp()], ctx, CATALOGUE_TASK), "t", CATALOGUE_TASK, ctx);
  if (!isRecord(data) || !Array.isArray(data.results)) throw internalError(ctx.tool, "list_tags_all: no results in the answer");
  const raw = data.results.filter(isRecord) as unknown as RawTagList[];
  const set: TagSet = { rows: raw.filter(tagListable), full: raw.length === ALL_TAGS_LIMIT };
  if (set.rows.length < raw.length) svc.log.debug("list_tags rows dropped as not listable", { dropped: raw.length - set.rows.length });
  svc.caches.set("tagcat", CATALOGUE_KEY, set);
  return set;
}

// the page

interface PageInput {
  /** The core tag of a grouping; absent for the catalogue. */
  core?: Core;
  set: TagSet;
  /** The cursor's `list` state; undefined on page 1. */
  state?: ListState;
  limit: number;
  /** Its `given` decides the request echo's `(default)` marks. */
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** One page: the cards of `set` from `state` on, and the footer that continues the list or says that more may exist. */
function tagsPage(input: PageInput, maxTokens: number, svc: Services): ToolOutput {
  const { core, set, state, limit } = input;
  const page = listPage(set.rows, state, limit, (r) => r._id, () => 0);
  const shown0 = state?.shown ?? 0;
  const first: ListState = state ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(set.rows, () => 0) };
  const count = page.items.length;
  const scope = core === undefined ? undefined : `grouped under "${core.resolved.name}"`;

  const items: PageItem[] = page.items.map((row) => ({ text: tagCard(toTagRecord(row), { excerpt: false }) }));
  const request = [core === undefined ? "all taggable tags (alphabetical)" : echoOf("tag", core.resolved), setting(input.echo, "limit", limit)];
  const notes = [...(count > 0 ? [CAVEAT["C-COUNTER"]] : []), ...(page.driftNote === undefined ? [] : [page.driftNote])];
  // ¶3.9: nothing at all on a first page is the filtered-list template; a continuation past the end has nothing to restate.
  const head = count === 0 && shown0 === 0 ? [emptyText({ kind: "filtered", items: "tags", filters: scope ?? "all taggable tags" })] : [];
  const position = count === 0 ? undefined : (c: Consumed): string => positionText(UNIT, shown0 + 1, shown0 + Math.max(1, Math.min(c.items, count)));

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, count);
    if (n === count && page.ended) {
      return set.full ? { kind: "reachable", reason: endMostReturned(core === undefined ? ALL_TAGS_LIMIT : CORE_GROUPING_LIMIT) } : { kind: "end" };
    }
    const at = n === 0 ? first : page.after[n - 1]!;
    const cursor = mint(svc, "list_tags", input.args, input.effective, { streams: [at], current: 0 });
    return { kind: "more", tool: "list_tags", cursor, next: nextText(UNIT, shown0 + n + 1, Math.min(shown0 + n + limit, set.rows.length)) };
  };

  return reply(
    {
      tool: "list_tags", subject: core === undefined ? "all taggable tags" : `tags ${scope}`, request, ...(position !== undefined && { position }),
      oneItem: shown0 === 0 && count === 1 && page.ended, notes, head, items,
    },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

async function firstPage(p: ListTagsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const core = p.tag === undefined ? undefined : await coreOf(p.tag, ctx, svc);
  const set = core === undefined ? await loadCatalogue(ctx, svc) : await loadCoreGrouping(core.id, ctx, svc);
  const args = givenArgs(p, ctx);
  return tagsPage({ core, set, limit: p.limit, echo: ctx, args, effective: listTagsEffective(p, { tagId: core?.id }) }, p.max_tokens, svc);
}

async function continuation(entry: CursorEntry, p: ListTagsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: a `tag` given again is resolved first, so that a slug equals the id it resolves to.
  const given = ctx.given.has("tag") && p.tag !== undefined ? await coreOf(p.tag, ctx, svc) : undefined;
  checkContinuation(entry, listTagsEffective(p, { tagId: given?.id }), ctx);
  const stored = entry.effective as { tag?: string; limit: number };
  const start = entry.state.streams[0];
  if (start === undefined || start.kind !== "list") throw internalError("list_tags", "a cursor without a list state");
  // D1 on every continuation: the core tag is checked again. A `tag` given again was resolved above and checkContinuation has proved
  // its id is the stored one, so that resolution is the check: resolving the stored id as well would be a request more (a lens or
  // summary warms the keys of the lens, not of its page), which could make the mandatory sequence 3 against the cap of 2 (¶4.16).
  // Without a `tag` the stored id is resolved (from the cache, or with one request).
  const core = stored.tag === undefined ? undefined : (given ?? (await coreOf(stored.tag, ctx, svc)));
  const set = core === undefined ? await loadCatalogue(ctx, svc) : await loadCoreGrouping(core.id, ctx, svc);
  return tagsPage(
    {
      core, set, state: start, limit: stored.limit,
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, svc,
  );
}

// the tool

const schema = z.strictObject({
  tag: P.tag().optional(),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<ListTagsParams> = {
  name: "list_tags",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  run(p, ctx, svc) {
    const entry = openContinuation("list_tags", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
