// Layer 2. The `get_tag` tool (¶4.8): a wiki page and its top posts in one call. Request 1 reads the page with TAG_FULL through
// the resolution aliases of ¶3.1.2 (a slug: `tagBySlug` and `TagPreview`; an id: `tag` and `multiDocument`), which is also its
// visibility check (P12, P17): `ids/resolve` reads it, so its outcomes, error wording, eviction and negative cache are
// resolve's, and the alias that answers `app.missing_document` is the expected miss (R9). A lens slug or id opens that lens; a
// summary id opens what it summarizes (the page, or a lens's own summary its lens), with the page joined in the same request
// (C3). Request 2, for the confirmed page: its tagged posts (re-checked, Q55), its discussion count, its Arbital relations (one
// `tag(_id)` each, P12) and, for a core tag whose grouping is not cached, the grouping (Q68). Once the page is confirmed, a part
// that fails is a `Partial:` line; a deadline stop shows request 1's page and continues as page 1 again.
// Page 1 reserves the header, the posts and the grouping preview first (the posts always appear on page 1) and gives the
// summaries and the text the rest; the text continues with a `slice` cursor that re-reads the page by request 1 alone. The
// posts continue through a minted `list_posts` cursor (an `offset` state for `top`/`tag_relevance`, a `keyset` state for
// `new`/`old`), the grouping through a minted `list_tags` cursor (a `list` state at index 10).
import { z } from "zod";
import { CONFIG } from "../config";
import { recheck } from "../domain/filters";
import { matchInText, processBody, sliceSection, type ProcessedBody } from "../domain/markdown";
import { toPostRecord } from "../domain/posts";
import { likersOf } from "../domain/reactions";
import { pageType } from "../domain/tags";
import { tagUrl } from "../domain/urls";
import { maskTagRef, pageOf, postPublic, tagPublic, visibleChildren } from "../domain/visibility";
import { badInput, CallStopped, internalError, isToolError, notFound, ToolError } from "../errors";
import { DISCUSSION_LIMIT, getTagRequest1Ops, getTagRequest2Ops, POSTS_SPARE, type TagPostsOrder } from "../forum/templates/get_tag";
import { isEntityId, parseRef } from "../ids/parse";
import { echoOf, negativeKey, readResolution, rememberResolution, resolvedFrom } from "../ids/resolve";
import { fingerprint, sliceAfter, slicePosition } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { estimateTokens } from "../render/budget";
import { fitsWhole } from "../render/layout";
import { CAVEAT, emptyText, FLAG, fmtInt, matchLine, partialLine } from "../render/messages";
import { matchHitItem, postLine, quote, tagRefText, textOutlineLine } from "../render/records";
import { day } from "../text/dates";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResults, ArbitalRelation, CallContext, Consumed, CursorEntry, CursorState, Footer, GqlOp, PageItem, PageSpec, ParsedRef, PublicTagId,
  RawLensRef, RawMdocRef, RawPostCard, RawTagFull, RawTagRef, Resolved, Services, StopReason, StreamState, ToolDef, ToolOutput,
  VisibleTagRef,
} from "../types";
import { checkContinuation, givenArgs, handOffCall, isRecord, mint, openContinuation, reply, rowsOf, setting } from "./common";
import { listPostsEffective, tool as listPostsTool, type ListPostsParams } from "./list_posts";
import { listTagsEffective, tool as listTagsTool, type ListTagsParams } from "./list_tags";
import { loadCoreGrouping, type TagSet } from "./loaders";

type GetTagParams = {
  tag?: string; section?: number; match?: string; sort: "top" | "tag_relevance" | "new" | "old"; limit: number; af_only: boolean;
  cursor?: string; max_tokens: number;
};

type Sort = GetTagParams["sort"];
type SliceState = Extract<StreamState, { kind: "slice" }>;
type ListState = Extract<StreamState, { kind: "list" }>;
/** A text as request 1 selects it (`contents { markdown version editedAt }`, or a page's `description`). */
type TextField = { markdown: string | null; version: string; editedAt: string };
type Summary = RawTagFull["summaries"][number];
/** The parent lens of a lens's own summary, as request 1 selects it. */
type ParentLens = RawLensRef & { contents?: TextField | null; summaries?: Summary[] | null; parentTag: RawTagFull | null };
/** A lens or summary as request 1 selects it (`m`, or `TagPreview`'s `lens`): MDOC_REF with its text, summaries and page. */
type MdocDoc = Omit<RawMdocRef, "parentTag" | "parentLens"> & {
  contents?: TextField | null; summaries?: Summary[] | null; parentTag: RawTagFull | null; parentLens: ParentLens | null;
};

const TITLE = "What does the wiki say, and what are the top posts?";
/** ¶4.8, verbatim. */
const DESCRIPTION_QUOTE =
  "A tag or wiki page: its text and its top posts in one call. tag = id, URL (/w/…, /tag/…, /p/…, arbital.com/p/…) or exact slug; earlier slugs, Arbital ids and lens slugs work; a lens slug opens that lens (an extra tab of the page), and a summary_id opens the page or lens it summarizes. limit counts posts. Returns name, ids, page type (tag, core tag, wiki-only page that can't be applied to posts, or placeholder page with no content), parent tag and subtags, likes on the page itself, the wiki text as Markdown (an outline and section=<number> for long pages; match=<text> keeps only the paragraphs containing it), the page's lenses (listed with lens_slug; open one by passing it as tag), short summaries (with summary_id), related Arbital pages for imported pages, the number of discussion comments (read them with get_comments tag=…), for one of the 7 core tags a preview of the tags grouped under it (list_tags gives them all), and limit tagged posts in sort order: top (karma, default), tag_relevance (strength of tagging), new, old. Which order the site's own tag page uses is not known. Only posts readers actually tagged are listed (relevance 1 or more); the header gives the forum's count of them. Event and meetup posts are not listed here; they open by id and can appear in search. The first page always shows the posts; a long wiki text fills the rest of the page and continues with the cursor. af_only applies to the posts (wiki pages themselves have no AF status). More posts: the list_posts call given at the end, whose cursor starts right after the last post shown.";

const PAGE_TASK = "reading the wiki page";
const PARTS_TASK = "reading the wiki page's posts, discussion and related pages";
/** The `Partial:` section of each part of request 2. */
const SECTION = {
  posts: "tagged posts",
  discussion: "discussion count",
  grouping: "tags grouped under this core tag",
  arbital: "related Arbital pages",
} as const;

const NAME_CAP = CONFIG.render.caps.name;
const VERSION_CAP = 40;
const SEP = " · ";
/** ¶4.8 step 7: the grouping preview shows this many tags; `list_tags` continues at this index. */
const PREVIEW_TAGS = 10;
/** ¶4.8: the `sortedBy` each sort sends. */
const SORTED_BY: Readonly<Record<Sort, TagPostsOrder>> = { top: "top", tag_relevance: "relevance", new: "new", old: "old" };
/** The heading of the posts block for each sort. */
const POSTS_HEADING: Readonly<Record<Sort, string>> = {
  top: "Top tagged posts (by karma):",
  tag_relevance: "Top tagged posts (by tag relevance):",
  new: "Tagged posts (newest first):",
  old: "Tagged posts (oldest first):",
};
/** ¶4.8 step 3: the Arbital relations in the order of `arbitalLinkedPages`, each with its label. */
const RELATIONS: readonly (readonly [ArbitalRelation, string])[] = [
  ["parents", "parent"], ["children", "child"], ["requirements", "requires"], ["teaches", "teaches"], ["faster", "faster"],
  ["slower", "slower"], ["moreTechnical", "more technical"], ["lessTechnical", "less technical"],
];

const quoted = (s: string | null | undefined): string => `"${oneLine(s, NAME_CAP)}"`;
/** A whole count with its noun: `1 word`, `2,410 words`. */
const counted = (n: number, one: string): string => `${fmtInt(n)} ${n === 1 ? one : `${one}s`}`;
/** A public tag reference, or undefined for a hidden one (P12). */
function visibleRef(t: RawTagRef | null | undefined): VisibleTagRef | undefined {
  const ref = maskTagRef(t);
  return ref.hidden ? undefined : ref;
}

// what was asked

/** The parameters that shape a page, stored in its cursor. */
interface Ask { section?: number; match?: string; sort: Sort; limit: number; afOnly: boolean }

const askOf = (p: GetTagParams): Ask => ({ section: p.section, match: p.match, sort: p.sort, limit: p.limit, afOnly: p.af_only });

/** ¶3.6: the effective values a cursor compares, `tag` as the id of the document opened; every parameter but `cursor` and `max_tokens`. */
function effectiveOf(openedId: string, ask: Ask): Record<string, unknown> {
  return { tag: openedId, section: ask.section, match: ask.match, sort: ask.sort, limit: ask.limit, af_only: ask.afOnly };
}

/**
 * ¶3.7 request echo: the tag as resolved (¶3.1.2's exception: a lens, or a lens's summary, opens the lens and the echo says so),
 * `section`/`match`/`af_only` when given, `sort` and `limit` always.
 */
function requestEcho(r: Resolved, ask: Ask, echo: CallContext): string[] {
  const out = [echoOf("tag", r, { opens: "lens" })];
  if (ask.section !== undefined) out.push(`section ${ask.section}`);
  if (ask.match !== undefined) out.push(`match "${oneLine(ask.match, 200)}"`);
  if (ask.afOnly) out.push("af_only true");
  out.push(setting(echo, "sort", ask.sort), setting(echo, "limit", ask.limit));
  return out;
}

// request 1: the page, or the lens opened instead of its text

/** A lens opened in place of the page's own text. */
interface OpenedLens { id: string; slug: string; title: string }

/** What request 1 opened: the page, and the text and summaries shown (the page's, or an opened lens's own, Q132). */
interface Opened {
  /** How the caller's string resolved (the echo). */
  resolved: Resolved;
  page: RawTagFull;
  pageId: PublicTagId;
  lens?: OpenedLens;
  text: TextField | null;
  summaries: readonly Summary[];
}

/** The id of the document whose text is shown: the cursor's `tag`. */
const openedId = (o: Opened): string => o.lens?.id ?? o.page._id;

function lensOf(l: { _id: string; slug: string; title: string | null; tabTitle: string }): OpenedLens {
  return { id: l._id, slug: l.slug, title: l.title ?? l.tabTitle };
}

/**
 * ¶4.8 step 1: what the resolved document opens. A page opens itself; a lens (by its slug through `TagPreview`, or by its id)
 * opens its own text and summaries; a lens's own summary opens that lens; a page's summary opens the page. The page always
 * comes from request 1 with TAG_FULL: `TagPreview`'s `tag`, or the `multiDocument`'s joined page (P12 `pageOf`).
 */
function openedFrom(resolved: Resolved, results: AliasResults): Omit<Opened, "pageId"> {
  if (resolved.kind === "tag") {
    const page = resolved.doc as RawTagFull;
    return { resolved, page, text: page.description, summaries: page.summaries ?? [] };
  }
  const m = resolved.doc as MdocDoc;
  const preview = results.get("b");
  const viaPreview = preview !== undefined && !("error" in preview) && isRecord(preview.data) && preview.data.lens === resolved.doc;
  const page = (viaPreview ? (preview.data as { tag?: unknown }).tag : pageOf(m as unknown as RawMdocRef)) as RawTagFull | null | undefined;
  // `ids/resolve` checked the lens or summary and its page (mdocPublic); TagPreview's page is the lens's own.
  if (!tagPublic(page)) throw internalError("get_tag", "a public lens or summary without its page");
  if (viaPreview) {
    const summaries = (preview.data as { summaries?: Summary[] | null }).summaries ?? [];
    return { resolved, page, lens: lensOf(m), text: m.contents ?? null, summaries };
  }
  if (m.fieldName === "summary") {
    const parent = m.parentLens;
    if (parent != null) return { resolved, page, lens: lensOf(parent), text: parent.contents ?? null, summaries: parent.summaries ?? [] };
    return { resolved, page, text: page.description, summaries: page.summaries ?? [] };
  }
  return { resolved, page, lens: lensOf(m), text: m.contents ?? null, summaries: m.summaries ?? [] };
}

/**
 * Request 1 (step 1): the page through the resolution aliases with the selections `get_tag` needs; a remembered `not_found` or
 * `not_public` costs no request. The resolution is cached under the caller's string by `ids/resolve`; a lens or summary also
 * remembers its page under the page's id, as a tag (the hand-off continuations re-check the page by that id).
 */
async function readTag(ref: ParsedRef, ctx: CallContext, svc: Services): Promise<Opened> {
  const negative = svc.caches.get<{ category: ToolError["category"]; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const results = await svc.gql(getTagRequest1Ops(ref), ctx, PAGE_TASK);
  const resolved = readResolution(ref, "tag", "", results, ctx, svc);
  const opened = openedFrom(resolved, results);
  if (resolved.kind !== "tag") rememberResolution("tag", opened.page._id, resolvedFrom("tag", opened.page), svc);
  return { ...opened, pageId: ctx.confirmPublic("tag", opened.page._id) };
}

// request 2

/** What request 2 gave: a stop (deadline or cap), a failure of the whole request, or its answer. */
type Sent = { kind: "stopped"; why: StopReason } | { kind: "failed"; error: ToolError } | { kind: "ok"; results: AliasResults };

async function send(ops: readonly GqlOp[], ctx: CallContext, svc: Services): Promise<Sent> {
  try {
    return { kind: "ok", results: await svc.gql(ops, ctx, PARTS_TASK) };
  } catch (e) {
    if (e instanceof CallStopped) return { kind: "stopped", why: e.reason };
    if (isToolError(e)) return { kind: "failed", error: e };
    throw e;
  }
}

/** One part of request 2: its data (undefined when the forum had nothing), or `ok: false` when it failed. */
type Part = { ok: true; data: unknown } | { ok: false };

/** The part `alias` of an answered or failed request 2; a failure adds its `Partial:` line (¶3.9). */
function partOf(sent: Exclude<Sent, { kind: "stopped" }>, alias: string, section: string, partials: string[]): Part {
  if (sent.kind === "failed") {
    partials.push(partialLine(section, sent.error));
    return { ok: false };
  }
  const r = sent.results.get(alias);
  if (r === undefined) return { ok: false };
  if (!("error" in r)) return { ok: true, data: r.data };
  if (r.error === "not_found" || r.error === "not_public") return { ok: true, data: undefined };
  partials.push(partialLine(section, new ToolError(r.error, r.message)));
  return { ok: false };
}

/** ¶4.8 step 2: the distinct Arbital page ids of `arbitalLinkedPages`, in relation order (only ids a template can carry). */
function arbitalIdsOf(page: RawTagFull): string[] {
  const links = page.arbitalLinkedPages;
  if (links == null) return [];
  const ids = RELATIONS.flatMap(([key]) => (links[key] ?? []).map((p) => (isRecord(p) ? p._id : undefined)));
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && isEntityId(id)))];
}

/** ¶4.8 step 3, P12, C3: `<relation> "<name>" (tag_slug …)` for each relation whose `tag(_id)` lookup came back public. */
function arbitalLine(page: RawTagFull, ids: readonly string[], results: AliasResults): { line?: string; dropped: number } {
  const found = new Map<string, VisibleTagRef>();
  ids.forEach((id, i) => {
    const r = results.get(`ar${i + 1}`);
    const doc = r !== undefined && !("error" in r) && isRecord(r.data) ? r.data.result : undefined;
    const ref = visibleRef(isRecord(doc) ? (doc as unknown as RawTagRef) : undefined);
    if (ref !== undefined) found.set(id, ref);
  });
  const links = page.arbitalLinkedPages;
  const parts: string[] = [];
  let dropped = 0;
  for (const [key, label] of RELATIONS) {
    for (const linked of links?.[key] ?? []) {
      const ref = isRecord(linked) ? found.get(linked._id) : undefined;
      if (ref === undefined) dropped++;
      else parts.push(`${label} ${tagRefText(ref)}`);
    }
  }
  return { ...(parts.length > 0 && { line: `Related Arbital pages: ${parts.join(SEP)}` }), dropped };
}

// the posts and their hand-off (step 6)

interface PostsBlock {
  /** The lines with each post's excerpt, and without (the 40 % rule of step 5). */
  lines: (excerpts: boolean) => string[];
  shown: number;
  dropped: number;
  /** The forum's count of the listed set, from a full raw page (P10). */
  forumCount?: number;
}

interface HandOffInput { page: RawTagFull; ask: Ask; callerTag: string; limitGiven: boolean }

/**
 * ¶4.8 step 6, ¶3.6: the `list_posts` hand-off, whose cursor starts right after the last post shown: an `offset` state at the
 * raw offset of the next row for `top`/`tag_relevance`, a `keyset` state at the last post's `postedAt` (with the ids shown at
 * that instant) for `new`/`old`. With no post shown, it starts after the raw page that was read. A row's index among the rows
 * returned is never past its raw offset (a raw page can return fewer rows than it covers), so the offset can only fall
 * short, and `list_posts` then skips the rows up to `lastId`.
 */
function postsHandOff(x: HandOffInput, shown: readonly { row: RawPostCard; index: number }[], rawCount: number, svc: Services): string {
  const { ask } = x;
  const args: Record<string, unknown> = {
    tag: x.callerTag, sort: ask.sort, ...(ask.afOnly && { af_only: true }), ...(x.limitGiven && { limit: ask.limit }),
  };
  const last = shown.at(-1);
  let state: StreamState;
  if (ask.sort === "new" || ask.sort === "old") {
    const boundaryMs = last === undefined ? null : Date.parse(last.row.postedAt);
    const idsAtBoundary = shown.filter((s) => Date.parse(s.row.postedAt) === boundaryMs).map((s) => s.row._id);
    state = { kind: "keyset", shown: shown.length, dir: ask.sort, boundaryMs, idsAtBoundary, windowOffset: last === undefined ? rawCount : 0 };
  } else {
    state = last === undefined
      ? { kind: "offset", shown: 0, offset: rawCount }
      : { kind: "offset", shown: shown.length, offset: last.index + 1, lastId: last.row._id };
  }
  const effective = listPostsEffective(listPostsTool.schema.parse(args) as ListPostsParams, { tagId: x.page._id });
  return `More posts: ${handOffCall("list_posts", args, mint(svc, "list_posts", args, effective, { streams: [state], current: 0 }))}`;
}

/** ¶4.8 step 6: the posts that pass the visibility rules and the re-checks (Q55, D11), the first `limit` of them, and the hand-off. */
function postsBlock(x: HandOffInput, data: unknown, svc: Services): PostsBlock {
  const { ask, page } = x;
  const raw = rowsOf<RawPostCard>(data);
  const totalCount = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
  const rawCount = ask.limit + POSTS_SPARE;
  const passing = raw
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => postPublic(row) && recheck(row, { tagId: page._id, af: ask.afOnly || undefined }));
  const shown = passing.slice(0, ask.limit);
  // ¶3.6 fullness: a full raw page may be followed by more rows; its totalCount is then the forum's count of the set (P10).
  const full = raw.length >= rawCount || (totalCount ?? 0) >= rawCount;
  const handOff = passing.length > ask.limit || full ? postsHandOff(x, shown, rawCount, svc) : undefined;
  const lines = (excerpts: boolean): string[] => {
    if (shown.length === 0) {
      const filters = `tagged ${quoted(page.name)}${ask.afOnly ? ", AF only" : ""}`;
      const empty = handOff === undefined ? emptyText({ kind: "filtered", items: "posts", filters }) : emptyText({ kind: "scan", checked: raw.length });
      return [empty, ...(handOff === undefined ? [] : [handOff])];
    }
    const posts = shown.map(({ row }) => postLine(toPostRecord(row, { excerpt: excerpts }), { excerpt: excerpts }));
    return [POSTS_HEADING[ask.sort], ...posts, ...(handOff === undefined ? [] : [handOff])];
  };
  return {
    lines, shown: shown.length, dropped: raw.length - passing.length,
    ...(totalCount !== undefined && totalCount >= rawCount && { forumCount: totalCount }),
  };
}

// the core grouping preview (step 7)

/** A grouped tag as the preview names it; a wiki-only page is labelled (¶4.8 step 3). */
function groupedText(t: VisibleTagRef): string {
  return t.wikiOnly ? `${tagRefText(t)} (wiki-only page)` : tagRefText(t);
}

/**
 * ¶4.8 step 7, Q68: the first 10 grouped tags in the forum's order and, when there are more, the `list_tags` hand-off: a `list`
 * state at index 10 over the same listable rows, with the fingerprint `list_tags` computes for them.
 */
function groupingLines(set: TagSet, x: { page: RawTagFull; callerTag: string }, svc: Services): string[] {
  const refs = set.rows.flatMap((row) => visibleRef(row) ?? []);
  if (refs.length === 0) return ["Tags grouped under this core tag: none."];
  const preview = refs.slice(0, PREVIEW_TAGS).map(groupedText).join(SEP);
  if (set.rows.length <= PREVIEW_TAGS) return [`Tags grouped under this core tag: ${preview}`];
  const args = { tag: x.callerTag };
  const effective = listTagsEffective(listTagsTool.schema.parse(args) as ListTagsParams, { tagId: x.page._id });
  const state: ListState = {
    kind: "list", shown: PREVIEW_TAGS, index: PREVIEW_TAGS, lastId: set.rows[PREVIEW_TAGS - 1]!._id, fingerprint: fingerprint(set.rows, () => 0),
  };
  const cursor = mint(svc, "list_tags", args, effective, { streams: [state], current: 0 });
  return [
    `Tags grouped under this core tag (first ${PREVIEW_TAGS} of the forum's list): ${preview}`,
    `More tags under ${quoted(x.page.name)}: ${handOffCall("list_tags", args, cursor)}`,
  ];
}

// the text and the header lines (steps 3–4, the output layout)

/** The edit day of a text, when its `editedAt` parses. */
function editedDay(t: TextField): string | undefined {
  return Number.isFinite(Date.parse(t.editedAt)) ? day(t.editedAt) : undefined;
}

/** The fence label of the text shown: `wiki, v1.6.0, edited 2025-03-01`, or `lens "Guide", v1.2.0, edited …` for a lens. */
function textLabel(o: Opened): string {
  const t = o.text;
  const parts = [o.lens === undefined ? "wiki" : `lens ${quoted(o.lens.title)}`];
  if (t !== null) {
    parts.push(`v${oneLine(t.version, VERSION_CAP)}`);
    const edited = editedDay(t);
    if (edited !== undefined) parts.push(`edited ${edited}`);
  }
  return parts.join(", ");
}

/** The summaries shown, each `- summary_id <id> ("<tabTitle>"):` and its text quoted (P12, Q60). */
function summaryItems(o: Opened): PageItem[] {
  return visibleChildren(o.summaries).map((s) => {
    const head = `- summary_id ${s._id} (${quoted(s.tabTitle)}):`;
    const md = s.contents?.markdown;
    return { text: md == null || md.trim() === "" ? head : `${head}\n${quote(md)}` };
  });
}

/** The slice stream's items (the summaries, then the text as `section` or `match` select it) and the head lines the text needs. */
interface TextPart { items: PageItem[]; head: string[]; body?: ProcessedBody }

/**
 * ¶4.8 step 4: the text with the clean-up of ¶3.7, whole, as one section, or as the paragraphs that match (as in `get_post`). A
 * page that never had a text (`description` null) reads as one whose text is empty, so `section` and `match` answer alike.
 */
function textPart(o: Opened, ask: Ask): TextPart {
  const items = summaryItems(o);
  const t = o.text;
  const body = t === null ? undefined : processBody({ markdown: blockText(t.markdown), dialogue: false, version: t.version });
  const md = body?.md ?? "";
  const label = textLabel(o);
  const part = (head: string[]): TextPart => ({ items, head, ...(body !== undefined && { body }) });
  if (ask.section !== undefined) {
    items.push({ text: sliceSection(md, ask.section, "page"), fence: `${label}, section ${ask.section}` });
    return part([]);
  }
  if (ask.match !== undefined) {
    const { total, hits } = matchInText(md, ask.match);
    items.push(...hits.map(matchHitItem));
    return part([matchLine(hits.length, total, "paragraphs", ask.match)]);
  }
  if (md.trim() !== "") items.push({ text: md, fence: label });
  return part([]);
}

/** The first header line: the page, or the lens opened and its page, with ids and URL (¶3.1.3). */
function titleLine(o: Opened): string {
  const { page, lens } = o;
  if (lens === undefined) return [`Wiki page ${quoted(page.name)}`, `tag_slug ${page.slug}`, `tag_id ${page._id}`, tagUrl(page.slug)].join(SEP);
  const of = `of ${quoted(page.name)} (tag_slug ${page.slug}, tag_id ${page._id})`;
  return [`Lens ${quoted(lens.title)}`, `lens_slug ${oneLine(lens.slug, NAME_CAP)} ${of}`, tagUrl(lens.slug)].join(SEP);
}

/** Request 2's parts of the second header line; absent on a page whose request 2 did not run. */
interface Counts { forumCount?: number; discussion?: number }

/**
 * The second header line: page type, parent and subtags (P12), likes on the page itself (Q108, §10.3), the forum's count of the
 * listed set (P10), the discussion count, and when the text shown was last edited (Q50.32); the site's postCount never (Q50.30).
 */
function factsLine(o: Opened, counts: Counts): { line: string; droppedSubtags: number } {
  const { page } = o;
  const facts = [`Page type: ${pageType(page)}`];
  const parent = visibleRef(page.parentTag);
  if (parent !== undefined) facts.push(`parent: ${tagRefText(parent)}`);
  const subTags = page.subTags ?? [];
  const subtags = subTags.flatMap((t) => visibleRef(t) ?? []);
  if (subtags.length > 0) facts.push(`subtags: ${subtags.map(tagRefText).join(", ")}`);
  facts.push(`likes ${fmtInt(likersOf(page.extendedScore).length)}`);
  if (counts.forumCount !== undefined) facts.push(FLAG.forumCount(counts.forumCount));
  if (counts.discussion !== undefined) {
    const n = counts.discussion;
    const count = n >= DISCUSSION_LIMIT ? `${fmtInt(DISCUSSION_LIMIT)}+ discussion comments` : counted(n, "discussion comment");
    facts.push(n > 0 ? `${count} (get_comments {tag: ${JSON.stringify(page.slug)}})` : count);
  }
  const edited = o.text === null ? undefined : editedDay(o.text);
  if (o.text !== null && edited !== undefined) {
    facts.push(`${o.lens === undefined ? "wiki" : "lens"} text last edited ${edited} (v${oneLine(o.text.version, VERSION_CAP)})`);
  }
  return { line: facts.join(SEP), droppedSubtags: subTags.length - subtags.length };
}

/** ¶4.8 step 3: the page's visible lenses (P12), each with `lens_slug`, title and word count. */
function lensesLine(page: RawTagFull): { line: string; dropped: number } {
  const all = page.lenses ?? [];
  const lenses = visibleChildren(all);
  if (lenses.length === 0) return { line: "Lenses: none", dropped: all.length };
  const named = lenses.map((l) => {
    const words = l.contents?.wordCount;
    return `lens_slug ${oneLine(l.slug, NAME_CAP)} ${quoted(l.title ?? l.tabTitle)}${typeof words === "number" ? ` (${counted(words, "word")})` : ""}`;
  });
  return { line: `Lenses (${fmtInt(lenses.length)}): ${named.join(SEP)}`, dropped: all.length - lenses.length };
}

/** ¶4.8 Paging: the text changed between pages; the cursor's character position is kept. */
function editedNote(o: Opened): string {
  const what = o.lens === undefined ? "wiki text" : "lens text";
  return `The ${what} was edited since the previous page (now v${oneLine(o.text?.version, VERSION_CAP)}); continuing at the same position.`;
}

// one page

interface PageInput {
  opened: Opened;
  ask: Ask;
  /** The caller's `tag` string, which the hand-offs repeat. */
  callerTag: string;
  /** Whether the caller gave `limit` (the `list_posts` hand-off repeats only what was given). */
  limitGiven: boolean;
  /** A continuation's slice state; undefined on page 1. */
  start?: SliceState;
  /** Its `given` decides the request echo's `(default)` marks. */
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** What request 2 added to page 1: the counts of the second header line, its head lines (the posts with or without excerpts), its notes. */
interface Request2Parts {
  counts: Counts; arbital: string[]; partials: string[]; posts: (excerpts: boolean) => string[]; grouping: string[]; notes: string[];
}

/** Request 2 for page 1 (step 2), read part by part, or the reason it was stopped (¶2.2 step 5). */
async function request2(input: PageInput, ctx: CallContext, svc: Services): Promise<Request2Parts | { stopped: StopReason }> {
  const { opened, ask } = input;
  const { page } = opened;
  const arbitalIds = arbitalIdsOf(page);
  // A grouping already cached is used as read here; `g` is sent only without it, and only then read from the answer.
  const cachedGrouping = page.core ? svc.caches.get<TagSet>("coregroup", page._id) : undefined;
  const sendGrouping = page.core && cachedGrouping === undefined;
  const ops = getTagRequest2Ops({
    tagId: opened.pageId, sortedBy: SORTED_BY[ask.sort], af: ask.afOnly, limit: ask.limit, core: sendGrouping, arbitalIds,
  });
  const sent = await send(ops, ctx, svc);
  if (sent.kind === "stopped") return { stopped: sent.why };

  const partials: string[] = [];
  const notes: string[] = [];
  const counts: Counts = {};
  let posts: PostsBlock | undefined;
  if (!page.wikiOnly) {
    const p = partOf(sent, "p", SECTION.posts, partials);
    if (p.ok) {
      posts = postsBlock({ page, ask, callerTag: input.callerTag, limitGiven: input.limitGiven }, p.data, svc);
      if (posts.forumCount !== undefined) counts.forumCount = posts.forumCount;
      notes.push(...(posts.shown > 0 ? [CAVEAT["C-TAGGED"]] : []), CAVEAT["C-EVENTS"]);
    }
  }
  const postsLines = (excerpts: boolean): string[] => (page.wikiOnly ? ["Wiki-only page: it has no tagged posts."] : posts?.lines(excerpts) ?? []);
  const dc = partOf(sent, "dc", SECTION.discussion, partials);
  if (dc.ok) counts.discussion = rowsOf<{ _id: unknown }>(dc.data).length;

  let grouping: string[] = [];
  if (cachedGrouping !== undefined) {
    grouping = groupingLines(cachedGrouping, { page, callerTag: input.callerTag }, svc);
  } else if (sendGrouping) {
    if (sent.kind === "failed") {
      partials.push(partialLine(SECTION.grouping, sent.error));
    } else {
      try {
        grouping = groupingLines(await loadCoreGrouping(page._id, ctx, svc, sent.results), { page, callerTag: input.callerTag }, svc);
      } catch (e) {
        if (!isToolError(e)) throw e;
        partials.push(partialLine(SECTION.grouping, e));
      }
    }
  }

  let arbital: string[] = [];
  let arbitalDropped = 0;
  if (arbitalIds.length > 0) {
    if (sent.kind === "failed") {
      partials.push(partialLine(SECTION.arbital, sent.error));
    } else {
      const a = arbitalLine(page, arbitalIds, sent.results);
      arbital = a.line === undefined ? [] : [a.line];
      arbitalDropped = a.dropped;
    }
  }
  const dropped = (posts?.dropped ?? 0) + arbitalDropped;
  if (dropped > 0) svc.log.debug("get_tag rows dropped by the visibility rules and re-checks", { posts: posts?.dropped ?? 0, arbital: arbitalDropped });
  return { counts, arbital, partials, posts: postsLines, grouping, notes };
}

async function tagPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { opened, ask, start } = input;
  const { page, lens } = opened;
  const first = start === undefined;
  const subject = lens === undefined ? quoted(page.name) : `lens ${quoted(lens.title)} of ${quoted(page.name)}`;
  const request = requestEcho(opened.resolved, ask, input.echo);
  const version = opened.text?.version;
  // The items first: a `section` out of range is bad_input before request 2 is sent.
  const text = textPart(opened, ask);
  const parts = first ? await request2(input, ctx, svc) : undefined;
  const stopped = parts !== undefined && "stopped" in parts ? parts.stopped : undefined;
  const r2 = parts !== undefined && !("stopped" in parts) ? parts : undefined;

  const notes = [...(r2?.notes ?? [])];
  if (text.body?.footnotes) notes.push(CAVEAT["C-FOOTNOTES"]);
  const facts = factsLine(opened, r2?.counts ?? {});
  const lenses = lensesLine(page);
  // P14: what P12 dropped is counted in a debug line only.
  const dropped = { subtags: facts.droppedSubtags, lenses: lenses.dropped, summaries: opened.summaries.length - visibleChildren(opened.summaries).length };
  if (first && dropped.subtags + dropped.lenses + dropped.summaries > 0) svc.log.debug("get_tag children dropped as hidden", dropped);

  // The head of page 1 is reserved first (step 5): the header, the posts and the grouping preview; a continuation repeats only
  // the title line of the document, says when its text changed, and keeps the match line on every page of the matches.
  const edited = start?.version !== undefined && version !== undefined && start.version !== version;
  const head = (excerpts: boolean): string[] => first
    ? [
      titleLine(opened), facts.line, ...(page.isPlaceholderPage ? ["This wiki page is an empty placeholder."] : []), lenses.line,
      ...(r2?.arbital ?? []), ...(r2?.partials ?? []), ...(r2?.posts(excerpts) ?? []), ...(r2?.grouping ?? []),
      ...text.head,
    ]
    : [titleLine(opened), ...(edited ? [editedNote(opened)] : []), ...(ask.match !== undefined ? text.head : [])];
  // ¶4.8 step 5: the summaries and the text get at least 40 % of the budget; a head that leaves less drops the posts' excerpts.
  const limitTokens = Math.floor(CONFIG.render.fill * maxTokens);
  const withExcerpts = head(true);
  const used = estimateTokens([...request, ...notes, ...withExcerpts].join("\n"));
  const headLines = limitTokens - used >= CONFIG.render.getTagTextMinShare * limitTokens ? withExcerpts : head(false);

  // The slice stream: the items from where this page starts, the first resumed inside its text, and its position in the text.
  const slice = slicePosition(text.items, start);
  const spec = (outline: readonly string[]): PageSpec => ({
    tool: "get_tag", subject, request, ...(slice.position !== undefined && { position: slice.position }), oneItem: first, notes,
    head: [...headLines, ...outline], items: slice.items,
  });

  if (stopped !== undefined) {
    // ¶2.2 step 5: request 1's page and text without request 2's parts; the cursor answers page 1 again.
    const state: CursorState = { streams: [{ kind: "slice", shown: 0, block: 0, offset: 0 }], current: 0, data: { page1: true } };
    return reply(spec([]), maxTokens, svc, () => ({
      kind: "stopped", why: stopped, tool: "get_tag", cursor: mint(svc, "get_tag", input.args, input.effective, state),
    }));
  }

  // ¶3.7: the outline is shown on page 1 when the text does not fit, has more than 3 headings, or with `section`.
  const headings = text.body?.headings ?? [];
  const outline = first && headings.length > 0 && (headings.length > 3 || ask.section !== undefined || !fitsWhole(spec([]), maxTokens));
  const footerFor = (c: Consumed): Footer => {
    const next = sliceAfter(c, start, text.items.length, version);
    if (next === undefined) return { kind: "end" };
    const cursor = mint(svc, "get_tag", input.args, input.effective, { streams: [next], current: 0 });
    return { kind: "more", tool: "get_tag", cursor, next: slice.next(c) };
  };
  return reply(spec(outline ? [textOutlineLine(headings, maxTokens)] : []), maxTokens, svc, footerFor);
}

// first page and continuation

async function firstPage(p: GetTagParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const tag = p.tag!;
  const opened = await readTag(parseRef("tag", tag, ["tag"]), ctx, svc);
  const ask = askOf(p);
  const args = givenArgs(p, ctx);
  return tagPage(
    { opened, ask, callerTag: tag, limitGiven: ctx.given.has("limit"), echo: ctx, args, effective: effectiveOf(openedId(opened), ask) },
    p.max_tokens, ctx, svc,
  );
}

async function continuation(entry: CursorEntry, p: GetTagParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { tag: string; section?: number; match?: string; sort: Sort; limit: number; af_only: boolean };
  const firstTag = typeof entry.args.tag === "string" ? entry.args.tag : stored.tag;
  // ¶3.6, D1: request 1 again, re-checking the page: with a `tag` given again (resolved, then compared by the id it opens), else
  // with the caller's first string, so that the request repeats page 1's (usually a raw-cache hit).
  const given = ctx.given.has("tag") && p.tag !== undefined;
  const opened = await readTag(parseRef("tag", given ? p.tag! : firstTag, ["tag"]), ctx, svc);
  checkContinuation(entry, effectiveOf(openedId(opened), askOf(p)), ctx);
  // The caller's string now opens another document: the one this cursor read is no longer found by it.
  if (openedId(opened) !== stored.tag) throw notFound("wiki page", "id", stored.tag);
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "slice") throw internalError("get_tag", "a cursor without a slice state");
  const page1 = isRecord(entry.state.data) && entry.state.data.page1 === true;
  return tagPage(
    {
      opened, ask: { section: stored.section, match: stored.match, sort: stored.sort, limit: stored.limit, afOnly: stored.af_only },
      callerTag: firstTag, limitGiven: Object.hasOwn(entry.args, "limit"), ...(!page1 && { start: state }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  tag: P.tag().optional(),
  section: P.section().optional(),
  match: P.match().optional(),
  sort: P.sort("get_tag"),
  limit: P.limit(),
  af_only: P.flag("af_only"),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetTagParams> = {
  name: "get_tag",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["tag"],
  run(p, ctx, svc) {
    if (p.section !== undefined && p.match !== undefined) throw badInput("match", "can't be combined with section", "Give section or match, not both.");
    const entry = openContinuation("get_tag", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
