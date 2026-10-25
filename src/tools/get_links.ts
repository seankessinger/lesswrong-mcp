// Layer 2. The `get_links` tool (¶4.13): the posts and wiki pages that link to a post or wiki page, and the links in its text.
// Request 1 resolves and checks the subject (P17): a post through `resolutionOps` with `contents { version }` (built rather than
// `resolve`d, since a cached `Resolved.doc` guarantees only POST_REF, and the body cache key needs the version), a page or lens
// through `resolve`. The incoming list is request 2: a post's `pingbackPosts` by offset (`top`, with C-DEPTH and C-DRIFT) or as
// one light set of at most 2,000 rows sorted locally (`new`, `old`; their page is hydrated beside the outgoing links), a page's
// wiki pages and lens pages (P12). The outgoing links are read from the current text, never from the stored `pingbacks` (Q103):
// from the `body` cache `get_post` fills when it holds the text, else from a request of their own (which this tool never caches:
// get_post's entry also needs the HTML its dialogues and suggestions are cleaned with); `extractLinks` finds them and one
// request resolves every forum link (Q131). Each link reads as the forum answered, through the visibility rules: a hidden post,
// comment, person or sequence is "a … link that can't be shown" with no id, title or slug (P1, P4, P12). The page lists up to
// `limit` incoming items, then the outgoing links from where the cursor stands (two streams, ¶3.6). Past the 40 s mark the
// outgoing requests are not sent and the page ends `Stopped early`; a request of the outgoing part that fails is a `Partial:`
// line, while a failure of the subject or of the incoming list (the hydrate of a `new`/`old` page included) is the call's.
import { z } from "zod";
import { CONFIG } from "../config";
import { extractLinks, type LinkRef } from "../domain/links";
import { hasFootnotes, type ProcessedBody } from "../domain/markdown";
import { toPostRecord } from "../domain/posts";
import {
  authorOf, commentPublic, isPlaceholder, maskPostRef, maskSeqRef, maskTagRef, mdocPublic, pageOf, postListable, postPublic, sequencePublic,
  tagListable, userPublic,
} from "../domain/visibility";
import { badInput, CallStopped, internalError, isToolError, notFound, ToolError } from "../errors";
import { incomingPostsOp, incomingTagOps, linkBodyOp, linkResolutionOps, type LinkTargets } from "../forum/templates/get_links";
import { collectionsListingOp } from "../forum/templates/shared";
import { parseRef } from "../ids/parse";
import { commentPlace, echoOf, negativeKey, readResolution, resolutionOps, resolve } from "../ids/resolve";
import {
  collect, compareLocal, fingerprint, lightScan, listPage, sliceAfter, stateAfter, type OffsetSource,
} from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { renderPage } from "../render/layout";
import { CAVEAT, DEPTH_HINT, emptyText, fmtInt, partialLine } from "../render/messages";
import { commentRefText, personText, postLine, postRefText, seqRefText, tagRefText, wikiEditPageText } from "../render/records";
import { oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, Category, CollectionSlug, Consumed, CursorEntry, CursorState, Footer, PageItem, PageSpec, ParsedRef, RawCommentRef,
  RawLensRef, RawMdocRef, RawPostCard, RawPostLight, RawPostRef, RawSeqRef, RawTagCard, RawTagRef, RawUserRef, Resolved, Services, StopReason,
  StreamState, ToolDef, ToolOutput, VisibleTagRef, WikiEditPage,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, rowsOf, setting } from "./common";
import { aliasData, cachedCollectionsListing, loadCollectionsListing } from "./loaders";

type GetLinksParams = {
  post?: string; tag?: string; direction: "incoming" | "outgoing" | "both"; sort: "top" | "new" | "old"; af_only: boolean; limit: number;
  cursor?: string; max_tokens: number;
};

type Direction = GetLinksParams["direction"];
type Sort = GetLinksParams["sort"];
type SliceState = Extract<StreamState, { kind: "slice" }>;
type ListState = Extract<StreamState, { kind: "list" }>;

const TITLE = "What links to this post, and what does it link to?";
/** ¶4.13, verbatim. */
const DESCRIPTION_QUOTE =
  "Links between posts and wiki pages. post=…: incoming = posts whose current text links to this post (only links in post bodies count, not comments, wiki pages, sequences or profiles; the forum leaves out linking posts with zero or negative karma; the list reflects each linking post's text as of its last edit, so a linking post's date is not the date the link was added); outgoing = every link in this post's current text, with forum links resolved to titles or names (each post and comment with its id and AF status) and external links grouped by site. tag=…: incoming = wiki pages whose text links to this page (the forum keeps no list of posts linking to a tag; wiki-only pages are not included; for a lens, the links to its whole page); outgoing = the links in the wiki text (for a lens slug, in that lens's text). direction: both (default), incoming, outgoing. sort (incoming posts only): top (karma; default), new, old; new and old rank at most 2,000 linking posts; wiki-page backlinks come newest page first and take no sort. For sort top, the forum can't list beyond about the 2,000th result in this order, and rankings can shift between pages as votes arrive. af_only keeps AF posts and comments among the links; links to wiki pages, people and external sites have no AF status and are kept; with tag and direction incoming it is refused. limit counts incoming items; outgoing links are listed in order of first appearance and continue with the cursor.";

const SUBJECT_TASK = "reading the post";
const INCOMING_TASK = "listing the links to this page";
const BODY_TASK = "reading the text";
const RESOLVE_TASK = "resolving the links";
const HYDRATE_TASK = "reading the linking posts";
/** The `Partial:` sections. */
const SECTION = { outgoing: "outgoing links", lenses: "lens backlinks" } as const;

/** ¶4.13: how many links of each kind one call resolves; the rest read `forum link (not resolved)`. */
const CAPS = { postSlugs: 10, comments: 20, tagFallbacks: 20, users: 20, sequences: 20 } as const;
/** `contents { version }` is what the post's own `body` cache key needs; the rest is POST_REF and the author, as `resolve` reads them. */
const SUBJECT_SELECT = "...POST_REF postedAt user { _id slug displayName } contents { version }";

const SEP = " · ";
const NAME_CAP = CONFIG.render.caps.name;
const TITLE_CAP = CONFIG.render.caps.title;

const POST_HIDDEN = "a post link that can't be shown (missing or not publicly visible)";
const COMMENT_HIDDEN = "a comment link that can't be shown";
const USER_HIDDEN = "a user link that can't be shown";
const SEQUENCE_HIDDEN = "a sequence link that can't be shown";
const AF_ECHO = "af_only does not apply to links to wiki pages, people and other sites";
const POSTS_EMPTY_NOTE = "Only links in post bodies of posts with positive karma are counted.";
/** A nonce for the trial render that decides how many incoming items fit; nothing of it is printed. */
const TRIAL_NONCE = "000000";

const quoted = (s: string, cap: number): string => `"${oneLine(s, cap)}"`;
const counted = (n: number, one: string): string => `${fmtInt(n)} ${one}${n === 1 ? "" : "s"}`;
const idOf = (r: { _id: string }): string => r._id;
/** A posting date in epoch milliseconds; 0 for an unreadable one, so that orders and fingerprints stay comparable. */
function postedMs(r: { postedAt: string }): number {
  const t = Date.parse(r.postedAt);
  return Number.isFinite(t) ? t : 0;
}

// what was asked, and where the two streams stand

interface Ask { direction: Direction; sort: Sort; afOnly: boolean; limit: number }

const askOf = (p: GetLinksParams): Ask => ({ direction: p.direction, sort: p.sort, afOnly: p.af_only, limit: p.limit });

/** ¶3.6: the effective values a cursor compares: every parameter but `cursor` and `max_tokens`, the subject as the id it resolved to. */
function effectiveOf(subject: { post?: string; tag?: string }, ask: Ask): Record<string, unknown> {
  return { post: subject.post, tag: subject.tag, direction: ask.direction, sort: ask.sort, af_only: ask.afOnly, limit: ask.limit };
}

/** Where each stream stands at the start of a page; a stream that is not `more` has nothing left to show. */
interface Start {
  incoming: { more: boolean; state?: StreamState };
  outgoing: { more: boolean; state?: SliceState };
}

const freshStart = (direction: Direction): Start => ({
  incoming: { more: direction !== "outgoing" },
  outgoing: { more: direction !== "incoming" },
});

/** The cursor holds both streams in a fixed place (incoming, outgoing); `data` says which of them has more, and a finished one is a placeholder. */
const NO_INCOMING: StreamState = { kind: "list", shown: 0, index: 0 };
const NO_OUTGOING: SliceState = { kind: "slice", shown: 0, block: 0, offset: 0 };

function cursorState(incoming: StreamState | undefined, outgoing: SliceState | undefined): CursorState {
  return {
    streams: [incoming ?? NO_INCOMING, outgoing ?? NO_OUTGOING],
    current: incoming === undefined ? 1 : 0,
    data: { incoming: incoming !== undefined, outgoing: outgoing !== undefined },
  };
}

function startOf(entry: CursorEntry): Start {
  const [incoming, outgoing] = entry.state.streams;
  const data = isRecord(entry.state.data) ? entry.state.data : {};
  if (incoming === undefined || outgoing === undefined || outgoing.kind !== "slice") throw internalError("get_links", "a cursor without both streams");
  return {
    incoming: data.incoming === true ? { more: true, state: incoming } : { more: false },
    outgoing: data.outgoing === true ? { more: true, state: outgoing } : { more: false },
  };
}

// the subject (request 1)

/** What the call is about: the post or page, what incoming links point at, and the text the outgoing links are read from. */
interface Subject {
  param: "post" | "tag";
  /** How the caller's string resolved (the request echo). */
  resolved: Resolved;
  /** The first line's subject: `"<title>"`, or `lens "<title>" of "<page>"`. */
  label: string;
  /** What incoming links point at: a post, or a wiki page (a lens stands for its page), and how an empty list names it. */
  target: { kind: "post" | "page"; id: string; named: string };
  /** The document whose text holds the outgoing links; a post's `version` is known from request 1. */
  text: { kind: "post" | "tag" | "lens"; id: string; version?: string };
  /** The id a cursor stores for the subject: the post, or the document whose text is read. */
  identity: string;
}

async function postSubject(input: string, ctx: CallContext, svc: Services): Promise<Subject> {
  const ref = parseRef("post", input, ["post"]);
  // A remembered `not_found` or `not_public` (¶2.3, the negative cache `readResolution` writes) costs no request.
  const negative = svc.caches.get<{ category: Category; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const results = await svc.gql(resolutionOps(ref, "", { post: SUBJECT_SELECT }), ctx, SUBJECT_TASK);
  const resolved = readResolution(ref, "post", "", results, ctx, svc);
  const contents = isRecord(resolved.doc) ? resolved.doc.contents : undefined;
  const version = isRecord(contents) ? contents.version : undefined;
  return {
    param: "post", resolved, label: quoted(resolved.name, TITLE_CAP),
    target: { kind: "post", id: resolved.id, named: `${quoted(resolved.name, TITLE_CAP)} (post_id ${resolved.id})` },
    text: { kind: "post", id: resolved.id, ...(typeof version === "string" && { version }) },
    identity: resolved.id,
  };
}

/** A lens opens its own text and its page's links; a page's summary stands for the page (or the lens it summarizes); P12 failures read `not_found`. */
async function tagSubject(input: string, ctx: CallContext, svc: Services): Promise<Subject> {
  const resolved = await resolve(parseRef("tag", input, ["tag"]), "tag", ctx, svc);
  if (resolved.kind === "tag") {
    if (resolved.slug === undefined) throw internalError("get_links", "a public wiki page without its slug");
    return {
      param: "tag", resolved, label: quoted(resolved.name, NAME_CAP),
      target: { kind: "page", id: resolved.id, named: `${quoted(resolved.name, NAME_CAP)} (tag_slug ${resolved.slug})` },
      text: { kind: "tag", id: resolved.id },
      identity: resolved.id,
    };
  }
  const doc = resolved.doc as RawMdocRef;
  const page = pageOf(doc);
  // `ids/resolve` checked the lens or summary and its page (mdocPublic).
  if (page === null) throw internalError("get_links", "a public lens or summary without its page");
  const lens: Pick<RawLensRef, "_id" | "title" | "tabTitle"> | null = resolved.kind === "lens" ? doc : doc.parentLens;
  const pageName = quoted(resolved.name, NAME_CAP);
  return {
    param: "tag", resolved,
    label: lens === null ? pageName : `lens ${quoted(lens.title ?? lens.tabTitle, NAME_CAP)} of ${pageName}`,
    target: { kind: "page", id: page._id, named: `${pageName} (tag_slug ${page.slug})` },
    text: lens === null ? { kind: "tag", id: page._id } : { kind: "lens", id: lens._id },
    identity: lens === null ? page._id : lens._id,
  };
}

// the incoming list

/** One incoming list's page, whatever its kind: the printed items, the rows they came from and the state that continues after them. */
interface Incoming {
  /** The printed items; `at` is the item's place among the page's rows (a hydrate can drop rows). */
  items(hydrated: ReadonlyMap<string, RawPostCard>): { text: string; at: number }[];
  /** The posts of a `new` or `old` page, to hydrate with the outgoing links' request; none for the other lists. */
  hydrate: string[];
  /** The rows on the page, and how many rows the list holds when it is known. */
  rows: number;
  total?: number;
  /** How many rows were checked to find them (the scan text of a page with no item that goes on). */
  checked: number;
  /** The state that continues after the page's first `rows` rows; undefined once the list has ended. */
  after(rows: number): StreamState | undefined;
  heading(shown: number): string;
  /** The text of a list with nothing in it. */
  empty: string[];
  /** Offset lists can shift between pages as votes arrive (C-DRIFT). */
  drift: boolean;
  /** The list ended at a limit of the forum: the `End of reachable results` reason. */
  endLine?: string;
  notes: string[];
  partials: string[];
  stopped?: StopReason;
}

const POSTS_HEADING = (shown: number): string =>
  `Incoming (${fmtInt(shown)} shown; the forum lists only linking posts with positive karma, as of each one's last edit)`;

/**
 * ¶4.13 incoming, post, `top`: the forum's own order, by offset (bounded, so the first raw page asks for the count), up to offset
 * 2000. The C-DEPTH hint names `af_only`, which the forum applies to this list, unless it is already given (¶3.6: `get_links`
 * refuses dates, and `sort` new/old would be `too_broad` here).
 */
async function incomingTop(subject: Subject, ask: Ask, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Incoming> {
  const source: OffsetSource<RawPostCard> = {
    kind: "offset",
    bounded: true,
    ...(!ask.afOnly && { endHint: DEPTH_HINT.afOnly }),
    async fetch(offset, size, first, c) {
      const o = incomingPostsOp(subject.target.id, ask.afOnly, { limit: size, offset, ...(first && { enableTotal: true as const }) }, "card");
      const data = aliasData(await svc.gql([o], c, INCOMING_TASK), o.alias, INCOMING_TASK, c);
      const totalCount = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
      return { rows: rowsOf<RawPostCard>(data), rawCount: size, ...(totalCount !== undefined && { totalCount }) };
    },
    idOf,
  };
  // Events stay, flagged (D11); a post is listed when it is public, listed and not a quick-takes container (P2, P3).
  const c = await collect(source, start, ask.limit, (row) => postListable(row) && (!ask.afOnly || row.af), ctx, { unit: "posts" });
  const lines = c.items.map((card) => postLine(toPostRecord(card)));
  return {
    items: () => lines.map((text, at) => ({ text, at })),
    hydrate: [],
    rows: c.items.length,
    checked: c.checked,
    after: (rows) => stateAfter(c, rows),
    heading: POSTS_HEADING,
    empty: postsEmpty(subject, ask),
    drift: c.drift,
    ...(c.endLine !== undefined && { endLine: c.endLine }),
    notes: c.note === undefined ? [] : [c.note],
    partials: [],
    ...(c.stopped !== undefined && { stopped: c.stopped }),
  };
}

/** ¶4.13 Errors and empty results: the filtered-list template, and what is counted. */
function postsEmpty(subject: Subject, ask: Ask): string[] {
  const filters = `linking to ${subject.target.named}${ask.afOnly ? ", AF only" : ""}`;
  return [emptyText({ kind: "filtered", items: "posts", filters }), POSTS_EMPTY_NOTE];
}

/**
 * The whole list of linking posts as light rows (`new` and `old`), read once and cached for 10 minutes in the `scan` cache, keyed
 * by the first request's text. A full raw page of 2,000 is `too_broad` (¶3.6).
 */
async function loadLinkingSet(subject: Subject, ask: Ask, ctx: CallContext, svc: Services): Promise<RawPostLight[]> {
  const cap = CONFIG.paging.lightScanCap;
  const o = incomingPostsOp(subject.target.id, ask.afOnly, { limit: cap, enableTotal: true }, "light");
  const key = `${o.template}:${o.text}`;
  const cached = svc.caches.get<RawPostLight[]>("scan", key);
  if (cached !== undefined) return cached;
  const { rows } = await lightScan<RawPostLight>(
    async () => {
      const data = aliasData(await svc.gql([o], ctx, INCOMING_TASK), o.alias, INCOMING_TASK, ctx);
      const totalCount = isRecord(data) && typeof data.totalCount === "number" ? data.totalCount : undefined;
      return { rows: rowsOf<RawPostLight>(data), rawCount: cap, ...(totalCount !== undefined && { totalCount }) };
    },
    { overCap: { why: `More than ${fmtInt(cap)} posts link here`, how: "Use sort top, which pages through about the first 2,000, or af_only" } },
  );
  svc.caches.set("scan", key, rows);
  return rows;
}

/** ¶4.13 incoming, post, `new`/`old`: the light set sorted locally and paged as a `list`; only the page shown is hydrated. */
async function incomingScan(subject: Subject, ask: Ask, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Incoming> {
  const rows = await loadLinkingSet(subject, ask, ctx, svc);
  const visible = rows.filter((r) => postListable(r) && (!ask.afOnly || r.af));
  const sorted = visible.sort(compareLocal<RawPostLight>(postedMs, postedMs, idOf, ask.sort === "old" ? "asc" : "desc"));
  if (start !== undefined && start.kind !== "list") throw internalError("get_links", "a cursor without a list state for a sorted list");
  const page = listPage(sorted, start, ask.limit, idOf, postedMs);
  const first: ListState = start ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(sorted, postedMs) };
  return {
    items: (hydrated) => page.items.flatMap((row, at) => {
      const card = hydrated.get(row._id);
      // The hydrate is by id, so every row is checked again (R10).
      return card !== undefined && postListable(card) && (!ask.afOnly || card.af) ? [{ text: postLine(toPostRecord(card)), at }] : [];
    }),
    hydrate: page.items.map(idOf),
    rows: page.items.length,
    total: sorted.length,
    checked: page.items.length,
    after: (n) => (n >= page.items.length && page.ended ? undefined : n === 0 ? first : page.after[n - 1]),
    heading: POSTS_HEADING,
    empty: postsEmpty(subject, ask),
    drift: false,
    notes: page.driftNote === undefined ? [] : [page.driftNote],
    partials: [],
  };
}

/** A wiki-page backlink: its id for the `list` state, and its line. */
interface Backlink { id: string; text: string }

const visibleTag = (t: RawTagRef): VisibleTagRef | undefined => {
  const ref = maskTagRef(t);
  return ref.hidden ? undefined : ref;
};

/** P12, ¶4.13: the lens, or the summary, of a public page, in the words of a wiki edit; undefined when it or its page is hidden. */
function partText(m: RawMdocRef | null | undefined): string | undefined {
  if (!mdocPublic(m)) return undefined;
  const pageRef = pageOf(m);
  const page = pageRef === null ? undefined : visibleTag(pageRef);
  if (page === undefined) return undefined;
  const lens = (l: Pick<RawLensRef, "slug" | "title" | "tabTitle">): NonNullable<WikiEditPage["lens"]> => ({ slug: l.slug, title: l.title ?? l.tabTitle });
  if (m.fieldName !== "summary") return wikiEditPageText({ part: "lens", page, lens: lens(m) });
  return m.parentLens == null
    ? wikiEditPageText({ part: "summary", page, summaryId: m._id })
    : wikiEditPageText({ part: "lens summary", page, lens: lens(m.parentLens), summaryId: m._id });
}

/**
 * ¶4.13 incoming, wiki page: its wiki pages (the forum's order, newest page first; listable ones) and then the lens pages that link
 * to it (L9, P12), as one `list`. A failure of the lens backlinks is a `Partial:` line; one of the wiki pages is the call's.
 */
async function incomingTag(subject: Subject, ask: Ask, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Incoming> {
  const results = await svc.gql(incomingTagOps(subject.target.id), ctx, INCOMING_TASK);
  const wiki = rowsOf<RawTagCard>(aliasData(results, "w", INCOMING_TASK, ctx));
  const partials: string[] = [];
  const lp = results.get("lp");
  let lensRows: RawMdocRef[] = [];
  if (lp !== undefined && "error" in lp) {
    if (lp.error !== "not_found" && lp.error !== "not_public") partials.push(partialLine(SECTION.lenses, new ToolError(lp.error, lp.message)));
  } else {
    lensRows = rowsOf<RawMdocRef>(lp?.data);
  }
  const set: Backlink[] = [
    ...wiki.flatMap((row) => {
      const ref = tagListable(row) ? visibleTag(row) : undefined;
      return ref === undefined ? [] : [{ id: row._id, text: tagRefText(ref) }];
    }),
    ...lensRows.flatMap((row) => {
      const text = partText(row);
      return text === undefined ? [] : [{ id: row._id, text }];
    }),
  ];
  if (set.length < wiki.length + lensRows.length) svc.log.debug("get_links backlinks dropped as hidden", { dropped: wiki.length + lensRows.length - set.length });
  if (start !== undefined && start.kind !== "list") throw internalError("get_links", "a cursor without a list state for the backlinks");
  const page = listPage(set, start, ask.limit, (b) => b.id, () => 0);
  const first: ListState = start ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(set, () => 0) };
  return {
    items: () => page.items.map((b, at) => ({ text: `• ${b.text}`, at })),
    hydrate: [],
    rows: page.items.length,
    total: set.length,
    checked: page.items.length,
    after: (n) => (n >= page.items.length && page.ended ? undefined : n === 0 ? first : page.after[n - 1]),
    heading: (shown) => `Incoming (${fmtInt(shown)} shown; wiki pages whose text links to this page, newest page first)`,
    empty: [emptyText({ kind: "filtered", items: "wiki pages", filters: `linking to ${subject.target.named}` })],
    drift: false,
    notes: page.driftNote === undefined ? [] : [page.driftNote],
    partials,
  };
}

function readIncoming(subject: Subject, ask: Ask, start: StreamState | undefined, ctx: CallContext, svc: Services): Promise<Incoming> {
  if (subject.target.kind === "page") return incomingTag(subject, ask, start, ctx, svc);
  return ask.sort === "top" ? incomingTop(subject, ask, start, ctx, svc) : incomingScan(subject, ask, start, ctx, svc);
}

// the outgoing links: the text, the plan, the resolution

/** The text the outgoing links are read from, and its version (the slice state's). */
interface LinkText { md: string; version?: string; footnotes: boolean }

/**
 * ¶4.13 Outgoing: a post's text from the `body` cache when `get_post` stored it (key `<postId>@<version>`), else one request;
 * a page's description or a lens's contents by one request. Nothing is cached here.
 */
async function readText(subject: Subject, ctx: CallContext, svc: Services): Promise<LinkText> {
  const t = subject.text;
  if (t.kind === "post") {
    // A post without a body (no `contents`) has no links.
    if (t.version === undefined) return { md: "", footnotes: false };
    const cached = svc.caches.get<ProcessedBody>("body", `${t.id}@${t.version}`);
    if (cached !== undefined) return { md: cached.md, version: t.version, footnotes: cached.footnotes };
  }
  const o = linkBodyOp(t.kind === "post" ? { post: t.id } : t.kind === "tag" ? { tag: t.id } : { lens: t.id });
  const data = aliasData(await svc.gql([o], ctx, BODY_TASK), o.alias, BODY_TASK, ctx);
  const result = isRecord(data) ? data.result : undefined;
  const field = isRecord(result) ? (t.kind === "tag" ? result.description : result.contents) : undefined;
  const md = isRecord(field) && typeof field.markdown === "string" ? field.markdown : "";
  const version = isRecord(field) && typeof field.version === "string" ? field.version : undefined;
  return { md, ...(version !== undefined && { version }), footnotes: hasFootnotes(md) };
}

/** One forum link of the text, in order of first appearance, and how it is looked up. */
type Slot =
  | { kind: "collection"; slug: string }
  | { kind: "post"; id: string }
  | { kind: "post-slug"; n: number }
  | { kind: "comment"; n: number }
  | { kind: "tag"; slug: string; url: string; n?: number }
  | { kind: "user"; n: number }
  | { kind: "sequence"; n: number }
  | { kind: "unresolved"; url: string };

type Targets = { -readonly [K in keyof Omit<LinkTargets, "hydratePostIds">]: string[] };

/** A text with no links asks for none. */
const EMPTY_TARGETS: Targets = {
  postIds: [], postSlugs: [], commentIds: [], tagSlugs: [], tagOldSlugs: [], lensSlugs: [], userSlugs: [], sequenceIds: [],
};

interface Plan {
  slots: Slot[];
  external: { domain: string; urls: string[] }[];
  targets: Targets;
}

/** ¶4.13: a link beyond a kind's cap, an onsite link that names nothing this server reads, or one of a form it cannot look up is unresolved. */
function slotOf(ref: ParsedRef | undefined, url: string, t: Targets): Slot {
  const unresolved: Slot = { kind: "unresolved", url };
  if (ref === undefined) return unresolved;
  switch (ref.kind) {
    case "post":
      if (ref.form === "id") {
        t.postIds.push(ref.value);
        return { kind: "post", id: ref.value };
      }
      if (ref.form !== "slug" || t.postSlugs.length >= CAPS.postSlugs) return unresolved;
      t.postSlugs.push(ref.value);
      return { kind: "post-slug", n: t.postSlugs.length };
    case "comment":
      if (ref.form !== "id" || t.commentIds.length >= CAPS.comments) return unresolved;
      t.commentIds.push(ref.value);
      return { kind: "comment", n: t.commentIds.length };
    case "tag": {
      if (ref.form !== "slug") return unresolved;
      t.tagSlugs.push(ref.value);
      // Every slug is asked by current slug; the first 20 also by older slug and as lens slugs (Q131).
      if (t.tagSlugs.length > CAPS.tagFallbacks) return { kind: "tag", slug: ref.value, url };
      t.tagOldSlugs.push(ref.value);
      t.lensSlugs.push(ref.value);
      return { kind: "tag", slug: ref.value, url, n: t.tagSlugs.length };
    }
    case "user":
      if (ref.form !== "slug" || t.userSlugs.length >= CAPS.users) return unresolved;
      t.userSlugs.push(ref.value);
      return { kind: "user", n: t.userSlugs.length };
    case "sequence":
      if (ref.form === "collection") return { kind: "collection", slug: ref.value };
      if (ref.form !== "id" || t.sequenceIds.length >= CAPS.sequences) return unresolved;
      t.sequenceIds.push(ref.value);
      return { kind: "sequence", n: t.sequenceIds.length };
    default:
      return unresolved;
  }
}

/** The links of a text, forum links in order of first appearance as slots and external links grouped by site (also in that order). */
function planLinks(links: readonly LinkRef[]): Plan {
  const targets: Targets = structuredClone(EMPTY_TARGETS);
  const slots: Slot[] = [];
  const sites = new Map<string, string[]>();
  for (const link of links) {
    const t = link.target;
    if (t.onsite) {
      slots.push(slotOf(t.ref, link.url, targets));
    } else {
      const urls = sites.get(t.domain) ?? [];
      urls.push(link.url);
      sites.set(t.domain, urls);
    }
  }
  return { slots, external: [...sites].map(([domain, urls]) => ({ domain, urls })), targets };
}

/** What the resolution request answered, read alias by alias; the forum's "nothing here" and its refusals read as no data. */
function readers(results: AliasResults) {
  const data = (alias: string): unknown => {
    const r = results.get(alias);
    return r === undefined || "error" in r ? undefined : r.data;
  };
  return {
    rows: <T>(alias: string): T[] => rowsOf<T>(data(alias)),
    single: <T>(alias: string): T | undefined => {
      const d = data(alias);
      return isRecord(d) && isRecord(d.result) ? (d.result as unknown as T) : undefined;
    },
    whole: (alias: string): Record<string, unknown> | undefined => {
      const d = data(alias);
      return isRecord(d) ? d : undefined;
    },
  };
}

const unresolvedText = (url: string): string => `forum link (not resolved): ${oneLine(url, TITLE_CAP)}`;
/** A collection link: `"<title>" (collection_slug <slug>)`, or by its slug alone when the listing was not at hand. */
const collectionText = (slug: string, title: string | undefined): string =>
  title === undefined ? `collection_slug ${slug}` : `${quoted(title, TITLE_CAP)} (collection_slug ${slug})`;
type LinkedComment = RawCommentRef & { post: RawPostRef | null; tag: RawTagRef | null };

const linksCollection = (plan: Plan): boolean => plan.slots.some((slot) => slot.kind === "collection");

/**
 * The titles of the collections a text links to, by slug, from the collections listing (¶4.0 COLLECTIONS_LISTING): the `col`
 * alias of the resolution request when it rode along, else the cache. No request is made for it here: a listing not at hand (a
 * text whose only forum links are collection links sends no resolution request), or one that could not be read, leaves each
 * collection link by its slug alone.
 */
async function collectionTitles(plan: Plan, results: AliasResults | undefined, ctx: CallContext, svc: Services): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  if (!linksCollection(plan)) return titles;
  let listing = cachedCollectionsListing(svc);
  if (results?.has("col") === true) {
    try {
      listing = await loadCollectionsListing(ctx, svc, results);
    } catch (e) {
      if (!isToolError(e)) throw e;
    }
  }
  for (const c of listing ?? []) {
    const slug = (Object.keys(CONFIG.collections) as CollectionSlug[]).find((s) => CONFIG.collections[s] === c._id);
    if (slug !== undefined && typeof c.title === "string") titles.set(slug, c.title);
  }
  return titles;
}

/**
 * The line of each forum link, in order, through the visibility rules (P1, P4, P12): a post by id or slug (the first row of its
 * slug that is public), a comment placed by `tagId` first, a tag by current slug, else older slug, else as a lens, a person, a
 * sequence (a hidden one named with its flag). `afOnly` leaves out the posts and comments that are not on the AF (masked ones
 * stay); `leftOut` counts them.
 */
function outgoingLines(plan: Plan, results: AliasResults, afOnly: boolean, collections: ReadonlyMap<string, string>): { lines: string[]; leftOut: number } {
  const read = readers(results);
  const posts = new Map(read.rows<RawPostCard>("p").map((row) => [row._id, row]));
  const tagsBySlug = new Map(read.rows<RawTagRef>("ts").map((row) => [row.slug, row]));
  let leftOut = 0;

  const postLink = (row: RawPostCard | undefined): string | undefined => {
    if (!postPublic(row)) return POST_HIDDEN;
    if (afOnly && !row.af) {
      leftOut++;
      return undefined;
    }
    return postRefText(maskPostRef(row));
  };
  const tagLink = (slot: Extract<Slot, { kind: "tag" }>): string => {
    const direct = tagsBySlug.get(slot.slug) ?? (slot.n === undefined ? undefined : read.rows<RawTagRef>(`tb${slot.n}`)[0]);
    const named = (t: RawTagRef): string => {
      const ref = visibleTag(t);
      return ref === undefined ? unresolvedText(slot.url) : tagRefText(ref);
    };
    if (direct !== undefined) return named(direct);
    const preview = slot.n === undefined ? undefined : read.whole(`tp${slot.n}`);
    if (preview?.lens != null) return partText(preview.lens as RawMdocRef) ?? unresolvedText(slot.url);
    return preview?.tag != null ? named(preview.tag as RawTagRef) : unresolvedText(slot.url);
  };

  const lines = plan.slots.flatMap((slot): string[] => {
    let line: string | undefined;
    switch (slot.kind) {
      case "collection":
        line = collectionText(slot.slug, collections.get(slot.slug));
        break;
      case "post":
        line = postLink(posts.get(slot.id));
        break;
      case "post-slug":
        line = postLink(read.rows<RawPostCard>(`ps${slot.n}`).find((row) => postPublic(row)));
        break;
      case "comment": {
        const row = read.single<LinkedComment>(`c${slot.n}`);
        if (!commentPublic(row) || isPlaceholder(row)) line = COMMENT_HIDDEN;
        else if (afOnly && !row.af) leftOut++;
        else line = `${commentRefText({ id: row._id, af: row.af })}${commentPlace(row)}`;
        break;
      }
      case "tag":
        line = tagLink(slot);
        break;
      case "user": {
        const row = read.whole(`u${slot.n}`) as (RawUserRef & { deleted: boolean }) | undefined;
        line = row !== undefined && userPublic(row) ? personText(authorOf(row, { hideAuthor: false })) : USER_HIDDEN;
        break;
      }
      case "sequence": {
        const row = read.single<RawSeqRef>(`s${slot.n}`);
        line = sequencePublic(row) ? seqRefText(maskSeqRef(row)) : SEQUENCE_HIDDEN;
        break;
      }
      case "unresolved":
        line = unresolvedText(slot.url);
        break;
    }
    return line === undefined ? [] : [line];
  });
  return { lines, leftOut };
}

/**
 * The outgoing stream's blocks, one per link line and per site, the head line sharing the first block (so that a page never ends
 * on the head line alone): `Outgoing: <forum links> forum links, <external links> external links (<sites> sites)`.
 */
function outgoingBlocks(plan: Plan, lines: readonly string[], leftOut: number): string[] {
  const urls = plan.external.reduce((n, site) => n + site.urls.length, 0);
  const left = leftOut === 0 ? "" : `; af_only left out ${counted(leftOut, "link")} to posts and comments not on the Alignment Forum`;
  const head = `Outgoing: ${counted(lines.length, "forum link")}, ${counted(urls, "external link")} (${counted(plan.external.length, "site")})${left}`;
  const body = [
    ...lines.map((line) => `• ${line}`),
    ...plan.external.map((site) => `• ${oneLine(site.domain, NAME_CAP)} (${fmtInt(site.urls.length)}): ${site.urls.map((url) => oneLine(url, TITLE_CAP)).join(SEP)}`),
  ];
  return body.length === 0 ? [head] : [`${head}\n${body[0]}`, ...body.slice(1)];
}

/** What the outgoing part of a page came to. */
interface Outgoing {
  /** `off`: not part of this page; `shown`: read; `stopped`: its requests were not sent (deadline or cap); `failed`: a `Partial:` line says so. */
  outcome: "off" | "shown" | "stopped" | "failed";
  blocks: string[];
  version?: string;
  footnotes: boolean;
  stopped?: StopReason;
  partials: string[];
  /** The cards of the incoming page's posts, from the same request. */
  hydrated: Map<string, RawPostCard>;
}

/** The first alias error that is more than "nothing here" (not_found, not_public), other than the hydrate's and the collections listing's. */
function firstFailure(results: AliasResults): ToolError | undefined {
  for (const [alias, r] of results) {
    if (alias !== "h" && alias !== "col" && "error" in r && r.error !== "not_found" && r.error !== "not_public") return new ToolError(r.error, r.message);
  }
  return undefined;
}

/**
 * The outgoing part: the text, then one request for every forum link of it and the hydrate of the incoming page (`hydrateIds`,
 * which that page cannot be printed without: a failure of the request that carries it is the call's). Otherwise a request that is
 * refused by the deadline or the cap is `stopped` and one that fails is a `Partial:` line (¶2.2 step 5).
 */
async function readOutgoing(x: PageInput, hydrateIds: readonly string[], ctx: CallContext, svc: Services): Promise<Outgoing> {
  const out: Outgoing = { outcome: x.start.outgoing.more ? "shown" : "off", blocks: [], footnotes: false, partials: [], hydrated: new Map() };
  const mustSend = hydrateIds.length > 0;
  /** An outgoing request that could not be made or failed. `mustSend`: the request after it is the incoming page's own, so a stop ends the call. */
  const giveUp = (e: unknown, stopIsFatal: boolean): void => {
    if (e instanceof CallStopped) {
      if (stopIsFatal) throw e;
      out.outcome = "stopped";
      out.stopped = e.reason;
    } else if (isToolError(e)) {
      out.outcome = "failed";
      out.partials.push(partialLine(SECTION.outgoing, e));
    } else {
      throw e;
    }
  };

  let plan: Plan | undefined;
  if (out.outcome === "shown") {
    try {
      const text = await readText(x.subject, ctx, svc);
      plan = planLinks(extractLinks(text.md));
      out.footnotes = text.footnotes;
      if (text.version !== undefined) out.version = text.version;
    } catch (e) {
      giveUp(e, mustSend);
    }
  }

  // A collection link's title comes from the collections listing, which rides along the resolution request when that is sent
  // anyway and the listing is not cached (as in get_post); it is never a request of its own.
  const resolution = linkResolutionOps({ ...(plan?.targets ?? EMPTY_TARGETS), hydratePostIds: hydrateIds });
  const withListing = resolution.length > 0 && plan !== undefined && linksCollection(plan) && cachedCollectionsListing(svc) === undefined;
  const ops = withListing ? [...resolution, collectionsListingOp("col")] : resolution;
  let results: AliasResults | undefined;
  if (ops.length > 0 && (out.outcome === "shown" || mustSend)) {
    try {
      results = await svc.gql(ops, ctx, mustSend ? HYDRATE_TASK : RESOLVE_TASK);
    } catch (e) {
      if (mustSend) throw e;
      giveUp(e, false);
    }
  }
  if (results !== undefined && mustSend) {
    const rows = rowsOf<RawPostCard>(aliasData(results, "h", HYDRATE_TASK, ctx));
    out.hydrated = new Map(rows.map((row) => [row._id, row]));
    if (out.hydrated.size < hydrateIds.length) svc.log.debug("get_links linking posts dropped by the hydrate", { dropped: hydrateIds.length - out.hydrated.size });
  }
  if (out.outcome === "shown" && plan !== undefined) {
    const failure = results === undefined ? undefined : firstFailure(results);
    if (failure !== undefined) {
      out.outcome = "failed";
      out.partials.push(partialLine(SECTION.outgoing, failure));
    } else {
      const { lines, leftOut } = outgoingLines(plan, results ?? new Map(), x.ask.afOnly, await collectionTitles(plan, results, ctx, svc));
      out.blocks = outgoingBlocks(plan, lines, leftOut);
    }
  }
  return out;
}

// one page

interface PageInput {
  subject: Subject;
  ask: Ask;
  start: Start;
  /** Its `given` decides the request echo's `(default)` marks. */
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** The incoming links a lens's call lists are its page's (¶3.1.2); the echo says so beside what was opened. */
const INCOMING_ARE_PAGES = "(incoming links are the page's)";

/**
 * ¶3.7 request echo: the subject as resolved (¶3.1.2's exception: a lens, or a lens's summary, opens the lens for its text, and
 * the incoming side stays the page's), `direction`, `sort` (posts), `af_only` and what it does not reach, `limit`.
 */
function requestEcho(x: PageInput): string[] {
  const { subject, ask, echo } = x;
  const pagesIncoming = subject.text.kind === "lens" && ask.direction !== "outgoing";
  return [
    `${echoOf(subject.param, subject.resolved, { opens: "lens" })}${pagesIncoming ? ` ${INCOMING_ARE_PAGES}` : ""}`,
    setting(echo, "direction", ask.direction),
    ...(subject.param === "post" && (ask.direction !== "outgoing" || echo.given.has("sort")) ? [setting(echo, "sort", ask.sort)] : []),
    ...(ask.afOnly || echo.given.has("af_only") ? [setting(echo, "af_only", ask.afOnly)] : []),
    ...(ask.afOnly && ask.direction !== "incoming" ? [AF_ECHO] : []),
    setting(echo, "limit", ask.limit),
  ];
}

/** The outgoing items from the stream's state: the blocks from its block on, the first resumed inside its text when the state says so. */
function outgoingItems(blocks: readonly string[], state: SliceState | undefined): PageItem[] {
  const offset = state?.offset ?? 0;
  return blocks.slice(state?.block ?? 0).map((text, j) => (j === 0 && offset > 0 ? { text, from: offset, header: "Outgoing (continued):" } : { text }));
}

async function linksPage(x: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { subject, ask, start } = x;
  const incoming = start.incoming.more ? await readIncoming(subject, ask, start.incoming.state, ctx, svc) : undefined;
  const outgoing = await readOutgoing(x, incoming?.hydrate ?? [], ctx, svc);
  const stopped = incoming?.stopped ?? outgoing.stopped;

  const inItems = incoming?.items(outgoing.hydrated) ?? [];
  const outItems = outgoing.outcome === "shown" ? outgoingItems(outgoing.blocks, start.outgoing.state) : [];
  const s0 = start.incoming.state?.shown ?? 0;
  const b0 = start.outgoing.state?.block ?? 0;
  /** The page's rows that its first `n` printed incoming items account for: the rows the hydrate dropped after the last go with it. */
  const through = (n: number): number => (incoming === undefined ? 0 : n >= inItems.length ? incoming.rows : n === 0 ? 0 : inItems[n - 1]!.at + 1);

  const edited = start.outgoing.state?.version !== undefined && outgoing.version !== undefined && start.outgoing.state.version !== outgoing.version;
  const notes = [
    ...(outgoing.outcome === "shown" && outgoing.footnotes ? [CAVEAT["C-FOOTNOTES"]] : []),
    ...(incoming?.notes ?? []),
    ...(edited ? [`The text changed since the previous page (now v${oneLine(outgoing.version, NAME_CAP)}); the outgoing list may have shifted.`] : []),
  ];

  /** The whole result is one item (the position line is left out): nothing before it, nothing after it. */
  const wholeResult = inItems.length + outItems.length === 1 && stopped === undefined
    && start.incoming.state === undefined && start.outgoing.state === undefined
    && (incoming === undefined || incoming.after(incoming.rows) === undefined) && outgoing.blocks.length <= 1;

  // The page with its first `k` incoming items, and the outgoing ones after them when `withOut`. An outgoing item resumed inside
  // its text is cut only as the first item of a page; after incoming items it starts again at its beginning.
  const specFor = (k: number, withOut: boolean): PageSpec => {
    const empty = incoming !== undefined && inItems.length === 0 && s0 === 0
      ? incoming.rows === 0 || incoming.after(incoming.rows) === undefined ? incoming.empty : [emptyText({ kind: "scan", checked: incoming.checked })]
      : [];
    const position = (c: Consumed): string => {
      const shownIn = k === 0 ? 0 : Math.max(Math.min(c.items, k), 1);
      const wholeOut = withOut ? Math.max(0, c.items - k) : 0;
      const reachedOut = wholeOut + (withOut && c.items >= k && c.sliceTo !== undefined ? 1 : 0);
      const parts = [
        ...(shownIn > 0 ? [positionText("incoming", s0 + 1, s0 + through(shownIn))] : []),
        ...(reachedOut > 0 ? [positionText("outgoing", b0 + 1, b0 + reachedOut, outgoing.blocks.length)] : []),
      ];
      return parts.length > 0 ? parts.join(SEP) : positionText("incoming", s0 + 1, s0 + 1);
    };
    const outShown = k > 0 ? outItems.map(({ text }) => ({ text })) : outItems;
    const items: PageItem[] = [...inItems.slice(0, k).map((item) => ({ text: item.text })), ...(withOut ? outShown : [])];
    return {
      tool: "get_links", subject: subject.label, request: requestEcho(x), ...(items.length > 0 && { position }), oneItem: wholeResult, notes,
      head: [...outgoing.partials, ...(incoming?.partials ?? []), ...(k > 0 && incoming !== undefined ? [incoming.heading(k)] : empty)],
      items,
    };
  };

  // The heading says how many incoming items are shown: when not all of them fit, the page is built again with those only.
  let k = inItems.length;
  let withOut = true;
  if (k > 0) {
    const trial = renderPage(specFor(k, withOut), maxTokens, TRIAL_NONCE, () => ({ kind: "end" })).consumed;
    if (trial.items < k) {
      k = Math.max(1, trial.items);
      withOut = false;
    }
  }
  const spec = specFor(k, withOut);

  const footerFor = (c: Consumed): Footer => {
    const shownIn = k === 0 ? 0 : Math.max(Math.min(c.items, k), 1);
    const rowsIn = through(shownIn);
    const inAfter = incoming === undefined ? undefined : incoming.after(rowsIn);
    const wholeOut = withOut ? Math.max(0, c.items - k) : 0;
    // A cut item resumes inside its own text; a cut incoming item is not resumed (it would be cut again).
    const sliceTo = withOut && c.items >= k ? c.sliceTo : undefined;
    let outAfter: SliceState | undefined;
    if (outgoing.outcome === "stopped" || (outgoing.outcome === "shown" && !withOut)) outAfter = start.outgoing.state ?? NO_OUTGOING;
    else if (outgoing.outcome === "shown") {
      outAfter = sliceAfter({ items: wholeOut, ...(sliceTo !== undefined && { sliceTo }), blocks: {} }, start.outgoing.state, outgoing.blocks.length, outgoing.version);
    }
    if (inAfter === undefined && outAfter === undefined) {
      return incoming?.endLine !== undefined ? { kind: "reachable", reason: incoming.endLine } : { kind: "end" };
    }
    const cursor = mint(svc, "get_links", x.args, x.effective, cursorState(inAfter, outAfter));
    // ¶3.6 Drift: a cursor that continues an offset (`top`) incoming list carries C-DRIFT on a stopped page as on a full one.
    const drift = inAfter !== undefined && incoming?.drift ? { drift: true as const } : {};
    if (stopped !== undefined) return { kind: "stopped", why: stopped, tool: "get_links", cursor, ...drift };
    const inFrom = s0 + rowsIn + 1;
    const next = [
      ...(inAfter === undefined ? [] : [nextText("incoming", inFrom, Math.min(inFrom + ask.limit - 1, incoming?.total ?? Number.POSITIVE_INFINITY))]),
      ...(outAfter === undefined ? [] : [nextText("outgoing", outAfter.block + 1, outgoing.blocks.length)]),
    ];
    return { kind: "more", tool: "get_links", cursor, next: next.join(", "), ...drift };
  };
  return reply(spec, maxTokens, svc, footerFor);
}

// first page and continuation

async function firstPage(p: GetLinksParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const subject = p.post !== undefined ? await postSubject(p.post, ctx, svc) : p.tag !== undefined ? await tagSubject(p.tag, ctx, svc) : undefined;
  if (subject === undefined) throw internalError("get_links", "no post or tag");
  const ask = askOf(p);
  const args = givenArgs(p, ctx);
  const effective = effectiveOf(subject.param === "post" ? { post: subject.identity } : { tag: subject.identity }, ask);
  return linksPage({ subject, ask, start: freshStart(ask.direction), echo: ctx, args, effective }, p.max_tokens, ctx, svc);
}

async function continuation(entry: CursorEntry, p: GetLinksParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { post?: string; tag?: string; direction: Direction; sort: Sort; af_only: boolean; limit: number };
  // ¶3.6: a subject given again is resolved first, so that a slug equals the id it resolves to, then compared with the stored one.
  const givenPost = ctx.given.has("post") && p.post !== undefined ? await postSubject(p.post, ctx, svc) : undefined;
  const givenTag = ctx.given.has("tag") && p.tag !== undefined ? await tagSubject(p.tag, ctx, svc) : undefined;
  checkContinuation(entry, effectiveOf({ post: givenPost?.identity, tag: givenTag?.identity }, askOf(p)), ctx);
  // D1 on every continuation: the subject is checked again, by the caller's first string when none is given.
  const first = typeof entry.args.post === "string" ? entry.args.post : entry.args.tag;
  const subject = givenPost ?? givenTag
    ?? (stored.post !== undefined ? await postSubject(String(first), ctx, svc) : await tagSubject(String(first), ctx, svc));
  // The caller's string now opens another document: the one this cursor read is no longer found by it.
  if (subject.identity !== (stored.post ?? stored.tag)) throw notFound(subject.param === "post" ? "post" : "wiki page", "id", String(stored.post ?? stored.tag));
  const ask: Ask = { direction: stored.direction, sort: stored.sort, afOnly: stored.af_only, limit: stored.limit };
  return linksPage(
    {
      subject, ask, start: startOf(entry),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  post: P.post().optional(),
  tag: P.tag().optional(),
  direction: P.direction(),
  sort: P.sort("get_links"),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetLinksParams> = {
  name: "get_links",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  oneOf: [["post", "tag"]],
  run(p, ctx, svc) {
    if (p.tag !== undefined && ctx.given.has("sort")) {
      throw badInput("sort", "applies to incoming posts only; wiki-page backlinks come in the forum's order (newest page first)", "Leave sort out with tag.");
    }
    if (p.tag !== undefined && p.af_only && p.direction === "incoming") {
      throw badInput("af_only", "wiki pages have no AF status", "Leave af_only out, or use direction outgoing or both.");
    }
    const entry = openContinuation("get_links", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
