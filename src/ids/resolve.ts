// Layer 3. Identifier resolution (¶3.1.2 "Resolved with", ¶2.2 step 3): a `ParsedRef` becomes a `Resolved` through one request
// that is also the subject's visibility check (D1), with the request-echo text of ¶3.7, the error wording of ¶3.9 and the
// resolution and negative caches of ¶2.3. Each kind and form is read through fixed bare aliases (post p, s, l; comment c; user
// i, u; tag t, m, a, b; sequence s), which a caller may prefix to compose resolutions into a request of its own
// (`resolutionOps` + `readResolution`). The aliases of one reference are read in a fixed order and the first publicly visible
// document wins; a document these rules hide reads exactly as if the forum had not returned it, so a hidden item and an unknown
// one get the same answer (P2, P5, P6, P12). Only the forum's own refusal is `not_public` (P1, P4, P8); before `not_found` or
// `not_public` is thrown, the call's raw responses are evicted and the error is remembered for 5 minutes. A success confirms
// the subject public in this call (P17) and is cached for 30 minutes under the input and the id, and a user or page also under
// its current slug (never a post: post slugs are neither unique nor total, Q88, P3). No slug other than the current one is
// ever printed (P13).
import { CONFIG } from "../config";
import {
  authorOf, commentPublic, isPlaceholder, maskPostRef, maskTagRef, mdocPublic, pageOf, postListable, postPublic, sequencePublic, tagPublic,
  userPublic,
} from "../domain/visibility";
import { badInput, forumError, internalError, loginOnly, notFound, notPublic, POST_SLUG_HINT, slugHint, ToolError, userSlugHint } from "../errors";
import {
  commentByIdOp, commentByLegacyIdOp, multiDocumentByIdOp, postByIdOp, postByLegacyIdOp, postsBySlugOp, sequenceByIdOp, tagByIdOp,
  tagBySlugOp, tagPreviewOp, userByIdOp, userBySlugOp,
} from "../forum/templates/shared";
import { FLAG, fmtInt } from "../render/messages";
import { personText, postRefText, tagRefText } from "../render/records";
import { oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, Category, CollectionSlug, EntityKind, GqlOp, ParsedRef, RawCommentList, RawCommentRef, RawMdocRef, RawPostCard,
  RawPostRef, RawSeqCard, RawSeqRef, RawTagRef, RawUserCard, Resolved, ResolvedKind, Services,
} from "../types";

/** The selection written for each kind of document a resolution can return; an entry replaces the default for its kind only. */
export interface ResolveSelect { post?: string; comment?: string; user?: string; tag?: string; mdoc?: string; sequence?: string }

type DocKind = keyof ResolveSelect;
type Key = "id" | "slug";
type FromKind = "post" | "comment" | "user" | "tag" | "sequence";

const DEFAULT_SELECT: Readonly<Required<ResolveSelect>> = {
  post: "...POST_REF postedAt user { _id slug displayName }",
  comment: "...COMMENT_REF post { ...POST_REF } tag { ...TAG_REF }",
  user: "...USER_CARD",
  tag: "...TAG_CARD",
  mdoc: "...MDOC_REF",
  sequence: "...SEQ_CARD",
};

const TITLE = CONFIG.render.caps.title;
const NAME = CONFIG.render.caps.name;

/** The noun of ¶3.9 for each kind of subject; tags, lenses and summaries are all a `wiki page`, so a hidden page reads alike everywhere. */
const ENTITY: Readonly<Record<EntityKind, string>> = {
  post: "post", comment: "comment", user: "user", tag: "wiki page", sequence: "sequence", revision: "revision",
};
/** The kinds the forum can refuse as a subject (¶3.9 `not_public`); a refused comment reads as unknown. */
const REFUSED_AS: Readonly<Partial<Record<EntityKind, "post" | "user" | "sequence" | "wiki page">>> = {
  post: "post", user: "user", tag: "wiki page", sequence: "sequence",
};

/** One document an alias returned (always an object), with the kind of record it is. */
interface Candidate { kind: DocKind; doc: unknown }

/** One alias of a reference: the op that asks it and how its answer is read. */
interface Source {
  bare: string;                                                   // the alias without the caller's prefix
  key: Key;                                                       // what the caller's value is when this alias answers
  op(alias: string, value: string, select: Readonly<Required<ResolveSelect>>): GqlOp;
  read(data: unknown): Candidate[];
}

/** An alias error that is more than "nothing here", with the key of the alias that raised it. */
interface Refusal { error: Category; message: string; key: Key }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A document answered directly (`GetUserBySlug`). */
const whole = (kind: DocKind) => (doc: unknown): Candidate[] => (isRecord(doc) ? [{ kind, doc }] : []);
/** `{ result }` of a single root. */
const single = (kind: DocKind) => (data: unknown): Candidate[] => whole(kind)(isRecord(data) ? data.result : undefined);
/** `{ results }` of a list view. */
const listed = (kind: DocKind) => (data: unknown): Candidate[] =>
  isRecord(data) && Array.isArray(data.results) ? data.results.flatMap((row) => whole(kind)(row)) : [];
/** `TagPreview` names the lens when the slug is a lens's, else the page; a lens these rules hide must not fall back to its page. */
const preview = (data: unknown): Candidate[] => {
  if (!isRecord(data)) return [];
  return data.lens != null ? whole("mdoc")(data.lens) : whole("tag")(data.tag);
};

/** The aliases of one reference, in the order they are read (¶3.1.2: the id wins over the slug). */
function sourcesOf(ref: ParsedRef): Source[] {
  const { kind, form } = ref;
  switch (kind) {
    case "post": {
      const p: Source = { bare: "p", key: "id", op: (a, v, s) => postByIdOp(a, v, s.post), read: single("post") };
      const sl: Source = { bare: "s", key: "slug", op: (a, v, s) => postsBySlugOp(a, v, s.post), read: listed("post") };
      if (form === "id") return [p];
      if (form === "slug") return [sl];
      if (form === "idOrSlug") return [p, sl];
      if (form === "legacy") return [{ bare: "l", key: "id", op: (a, v, s) => postByLegacyIdOp(a, v, s.post), read: listed("post") }];
      break;
    }
    case "comment":
      if (form === "id") return [{ bare: "c", key: "id", op: (a, v, s) => commentByIdOp(a, v, s.comment), read: single("comment") }];
      if (form === "legacy") return [{ bare: "c", key: "id", op: (a, v, s) => commentByLegacyIdOp(a, v, s.comment), read: listed("comment") }];
      break;
    case "user": {
      const i: Source = { bare: "i", key: "id", op: (a, v, s) => userByIdOp(a, v, s.user), read: single("user") };
      const u: Source = { bare: "u", key: "slug", op: (a, v, s) => userBySlugOp(a, v, s.user), read: whole("user") };
      if (form === "id") return [i];
      if (form === "slug") return [u];
      if (form === "idOrSlug") return [i, u];
      break;
    }
    case "tag": {
      const t: Source = { bare: "t", key: "id", op: (a, v, s) => tagByIdOp(a, v, s.tag), read: single("tag") };
      const m: Source = { bare: "m", key: "id", op: (a, v, s) => multiDocumentByIdOp(a, v, s.mdoc), read: single("mdoc") };
      const sa: Source = { bare: "a", key: "slug", op: (a, v, s) => tagBySlugOp(a, v, s.tag), read: listed("tag") };
      const sb: Source = {
        bare: "b", key: "slug", read: preview,
        op: (a, v, s) => tagPreviewOp(a, v, `tag { ${s.tag} } lens { ${s.mdoc} } summaries { _id deleted tabTitle }`),
      };
      if (form === "id") return [t, m];
      if (form === "slug") return [sa, sb];
      if (form === "idOrSlug") return [t, m, sa, sb];
      break;
    }
    case "sequence":
      if (form === "id") return [{ bare: "s", key: "id", op: (a, v, s) => sequenceByIdOp(a, v, s.sequence), read: single("sequence") }];
      break;
  }
  throw internalError("resolve", `a ${kind} given as ${form} is not resolved by a request`);
}

/** D1: whether a returned document is publicly visible under its kind's rule. */
function isPublic(c: Candidate): boolean {
  switch (c.kind) {
    case "post": return postPublic(c.doc as RawPostRef);
    case "comment": return commentPublic(c.doc as RawCommentRef);
    case "user": return userPublic(c.doc as { deleted: boolean });
    case "tag": return tagPublic(c.doc as RawTagRef);
    case "mdoc": return mdocPublic(c.doc as RawMdocRef);
    case "sequence": return sequencePublic(c.doc as RawSeqRef);
  }
}

// cache keys

/** The cache namespace of a resolved kind: lenses and summaries are found through `tag`, collections through `sequence`. */
function cacheKind(kind: ResolvedKind | ParsedRef["kind"]): string {
  if (kind === "lens" || kind === "summary") return "tag";
  return kind === "collection" ? "sequence" : kind;
}

/** `<kind>:<value>`; an LW1 id is kept apart from a slug that spells the same (`/lw/g/…` and a post slugged `g`). */
function inputKey(ref: ParsedRef): string {
  return `${cacheKind(ref.kind)}:${ref.form === "legacy" ? "legacy:" : ""}${ref.value}`;
}

/**
 * The key under which a reference's `not_found` or `not_public` is remembered (¶2.3): a tool that composes its own first
 * request reads `svc.caches.get("negative", negativeKey(ref))` before sending it, so a remembered refusal costs no request.
 */
export function negativeKey(ref: ParsedRef): string {
  return inputKey(ref);
}

// building a Resolved

const quoted = (s: string): string => `"${s}"`;
const afWord = (af: boolean): string => (af ? FLAG.AF : FLAG.LW_ONLY);

/** The fields shared by every kind, with `slug` and `af` only when the document has them. */
function base(kind: ResolvedKind, d: { _id?: unknown; slug?: unknown; af?: unknown }, name: string, display: string, notes: string[], doc: unknown): Resolved {
  return {
    kind, id: String(d._id), ...(typeof d.slug === "string" && { slug: d.slug }), name, display, notes,
    ...(typeof d.af === "boolean" && { af: d.af }), doc,
  };
}

/** `by "<displayName>"`, `by author not publicly visible` (P7) or `by account not publicly visible` (P8); nothing when the document did not select its user. */
function postAuthor(p: Partial<RawPostCard>): string {
  if (p.user === undefined && p.hideAuthor !== true) return "";
  const who = authorOf(p.user ?? null, { hideAuthor: p.hideAuthor === true });
  return ` by ${who.kind === "user" ? quoted(oneLine(who.name, NAME)) : who.why}`;
}

/**
 * P1: a comment's place as ` on …`, decided by `tagId` first; a hidden page or post is unnamed. Nothing when the join was not
 * selected. `get_links` words a comment link with it.
 */
export function commentPlace(c: Partial<RawCommentList>): string {
  if (c.tagId != null) {
    if (c.tag === undefined) return "";
    const tag = maskTagRef(c.tag);
    return tag.hidden ? ` ${FLAG.ON_HIDDEN_TAG}` : ` on wiki page ${tagRefText(tag)}`;
  }
  if (c.postId == null || c.post === undefined) return "";
  const post = maskPostRef(c.post);
  return post.hidden ? ` ${FLAG.ON_HIDDEN_POST}` : ` on ${postRefText(post)}`;
}

/**
 * A `Resolved` from a publicly visible document of `kind`, with the ¶3.7 echo text as its display; fields absent from `doc` are
 * left out with their separator. The notes are the document's own flags (unlisted and event posts, hidden sequences), never
 * the input's.
 */
export function resolvedFrom(kind: FromKind, doc: unknown): Resolved {
  const d = isRecord(doc) ? doc : {};
  const id = String(d._id);
  switch (kind) {
    case "post": {
      const p = d as Partial<RawPostCard>;
      const name = oneLine(p.title, TITLE);
      const notes = [...(p.unlisted ? [FLAG.UNLISTED] : []), ...(p.isEvent ? [FLAG.EVENT] : [])];
      return base("post", p, name, `${quoted(name)} (post_id ${id})${postAuthor(p)}`, notes, doc);
    }
    case "comment": {
      const c = d as Partial<RawCommentList>;
      const flag = typeof c.af === "boolean" ? ` (${afWord(c.af)})` : "";
      const placeholder = isPlaceholder({ deleted: c.deleted === true, deletedPublic: c.deletedPublic === true });
      const by = c.user === undefined ? "" : ` by ${personText(authorOf(c.user, { hideAuthor: c.hideAuthor === true, placeholder }))}`;
      return base("comment", c, `comment_id ${id}`, `comment_id ${id}${flag}${by}${commentPlace(c)}`, [], doc);
    }
    case "user": {
      const u = d as Partial<RawUserCard>;
      const name = oneLine(u.displayName ?? u.slug ?? id, NAME);
      const facts = [...(typeof u.slug === "string" ? [`user_slug ${u.slug}`] : []), `user_id ${id}`];
      if (typeof u.karma === "number") facts.push(`karma ${fmtInt(u.karma)}`);
      return base("user", u, name, `${quoted(name)} (${facts.join(", ")})`, [], doc);
    }
    case "tag": {
      const t = d as Partial<RawTagRef>;
      const name = oneLine(t.name, NAME); // ¶3.7: tag, lens and page names are names (60), not titles
      const facts = [...(typeof t.slug === "string" ? [`tag_slug ${t.slug}`] : []), `tag_id ${id}`];
      return base("tag", t, name, `${quoted(name)} (${facts.join(", ")})`, [], doc);
    }
    case "sequence": {
      const s = d as Partial<RawSeqCard>;
      const name = oneLine(s.title, TITLE);
      return base("sequence", s, name, `${quoted(name)} (sequence_id ${id})`, s.hidden ? [FLAG.HIDDEN_SEQUENCE] : [], doc);
    }
  }
}

/** The ¶3.1.2 note of a lens or summary that stands for its page, from the fields a `Resolved` keeps. */
function pageNoteOf(r: Resolved): string {
  return r.kind === "summary" ? `summary_id ${r.id} → page ${quoted(r.name)}` : `lens ${r.slug} → page ${quoted(r.name)}`;
}

/**
 * P12: a public lens or summary stands for its page: the page's name and display, its page id, and a note saying so. The
 * `part` notes are for the four tools of ¶3.1.2's exception, which open the lens or summary itself (`echoOf`).
 */
function mdocResolved(m: RawMdocRef): Resolved {
  const page = pageOf(m);
  if (page === null) throw internalError("resolve", "a public lens or summary without a page"); // mdocPublic requires the page
  const shown = resolvedFrom("tag", page);
  const summary = m.fieldName === "summary";
  const pageText = `page ${quoted(shown.name)}`;
  const lens = summary ? m.parentLens : null;
  const lensText = lens == null ? "" : `lens ${quoted(oneLine(lens.title ?? lens.tabTitle, NAME))} (lens_slug ${oneLine(lens.slug, NAME)}) of `;
  const part = summary
    ? { own: `summary_id ${m._id} of ${lensText}${pageText}`, ...(lens != null && { lens: `summary_id ${m._id} → ${lensText}${pageText}` }) }
    : { own: `lens_slug ${oneLine(m.slug, NAME)} of ${pageText}` };
  const r: Resolved = {
    kind: summary ? "summary" : "lens", id: m._id, ...(!summary && { slug: m.slug }), name: shown.name, display: shown.display,
    notes: [], pageId: page._id, part, doc: m,
  };
  return { ...r, notes: [pageNoteOf(r)] };
}

/** The notes that depend on what the caller gave: the parse notes. */
function forInput(r: Resolved, ref: ParsedRef): Resolved {
  return { ...r, notes: [...ref.notes, ...r.notes] };
}

/** P17: the subject (and a lens's or summary's page) is confirmed public in this call. */
function confirm(r: Resolved, ctx: CallContext): void {
  switch (r.kind) {
    case "post":
    case "comment":
    case "tag":
      ctx.confirmPublic(r.kind, r.id);
      ctx.confirmPublic("doc", r.id);
      return;
    case "lens":
    case "summary":
      ctx.confirmPublic("doc", r.id);
      if (r.pageId !== undefined) ctx.confirmPublic("tag", r.pageId);
      return;
    case "sequence":
      ctx.confirmPublic("sequence", r.id);
      return;
  }
}

function isCollectionSlug(s: string): s is CollectionSlug {
  return Object.hasOwn(CONFIG.collections, s);
}

/** A collection named by its slug (§11.5): its hard-coded id, no request. */
export function collectionResolved(slug: CollectionSlug): Resolved {
  return { kind: "collection", id: CONFIG.collections[slug], slug, name: slug, display: `collection_slug ${slug}`, notes: [] };
}

function collectionOf(ref: ParsedRef): Resolved {
  if (!isCollectionSlug(ref.value)) throw internalError("resolve", "not one of the five collection slugs");
  return { ...collectionResolved(ref.value), notes: [...ref.notes] };
}

// the request and its reading

/** The ops that resolve `ref`, aliased `<aliasPrefix><bare alias>`; none for a collection. */
export function resolutionOps(ref: ParsedRef, aliasPrefix: string, select?: ResolveSelect): GqlOp[] {
  if (ref.form === "collection") return [];
  const d = DEFAULT_SELECT;
  const chosen: Required<ResolveSelect> = {
    post: select?.post ?? d.post, comment: select?.comment ?? d.comment, user: select?.user ?? d.user,
    tag: select?.tag ?? d.tag, mdoc: select?.mdoc ?? d.mdoc, sequence: select?.sequence ?? d.sequence,
  };
  return sourcesOf(ref).map((s) => s.op(aliasPrefix + s.bare, ref.value, chosen));
}

/** ¶2.3: a subject that turned out hidden leaves no raw response behind, only the error, for 5 minutes. */
function rememberHidden(e: ToolError, ref: ParsedRef, ctx: CallContext, svc: Services): ToolError {
  svc.evictResponses(ctx.cacheKeys);
  svc.caches.set("negative", inputKey(ref), { category: e.category, message: e.message });
  return e;
}

/** ¶3.9: why nothing publicly visible answered. Only the forum's own refusal is `not_public`. */
function failure(ref: ParsedRef, param: string, refusal: Refusal | undefined, ctx: CallContext, svc: Services): ToolError {
  const { value } = ref;
  if (refusal?.error === "not_public") {
    const refused = REFUSED_AS[ref.kind];
    if (refused !== undefined) return rememberHidden(notPublic(`the ${refused} with the ${refusal.key} "${value}"`, refused), ref, ctx, svc);
    refusal = undefined;
  }
  if (refusal === undefined) {
    // ¶8: a bare 17-character string tried as id and as slug and found as neither reads in the slug form with the find hint (a
    // slug typed with a capital is the likelier mistake); a post's hint adds the slug caveat. The same words for a hidden document
    // and a missing one (D1).
    if (ref.form === "idOrSlug" && (ref.kind === "post" || ref.kind === "user" || ref.kind === "tag")) {
      const hint = `${slugHint(ref.kind, value)}${ref.kind === "post" ? ` ${POST_SLUG_HINT}` : ""}`;
      return rememberHidden(notFound(ENTITY[ref.kind], "slug", value, hint), ref, ctx, svc);
    }
    const key: Key = ref.form === "slug" ? "slug" : "id";
    const hint = key === "id" ? undefined : ref.kind === "post" ? POST_SLUG_HINT : ref.kind === "user" ? userSlugHint(value) : undefined;
    return rememberHidden(notFound(ENTITY[ref.kind], key, value, hint), ref, ctx, svc);
  }
  switch (refusal.error) {
    case "login_only":
      return loginOnly();
    case "internal":
      return internalError(ctx.tool, refusal.message);
    case "forum_error":
      return forumError(`resolving ${param}`, refusal.message);
    default:
      return new ToolError(refusal.error, refusal.message);
  }
}

/** Q88: two publicly visible posts hold the slug; the caller chooses by id. */
function twoPosts(param: string, slug: string, rows: readonly Candidate[]): ToolError {
  const [a, b] = rows.map((r) => r.doc as RawPostRef);
  const named = (p: RawPostRef): string => `${quoted(oneLine(p.title, TITLE))} (post_id ${p._id})`;
  return badInput(param, `the slug "${slug}" names 2 posts: ${named(a!)} and ${named(b!)}`, "Pass the post_id you mean.");
}

/**
 * Reads `ref`'s aliases (prefixed `aliasPrefix`) out of an answer `results` that may hold other aliases too. The first publicly
 * visible document wins; it is confirmed public in `ctx` (with a comment's public post and page joins) and cached. Otherwise
 * throws `bad_input` for a slug two posts hold, `not_found` or `not_public` (both remembered for 5 minutes), `login_only`, or
 * the alias's own error worded as ¶3.9 says (`internal` naming the template, `forum_error`).
 */
export function readResolution(ref: ParsedRef, param: string, aliasPrefix: string, results: AliasResults, ctx: CallContext, svc: Services): Resolved {
  if (ref.form === "collection") return collectionOf(ref);
  const sources = sourcesOf(ref);
  if (sources.every((s) => !results.has(aliasPrefix + s.bare))) {
    throw internalError(ctx.tool, `resolve: the answer has no alias ${aliasPrefix}${sources[0]!.bare}`);
  }
  let refusal: Refusal | undefined;
  for (const source of sources) {
    const answer = results.get(aliasPrefix + source.bare);
    if (answer === undefined) continue;
    if ("error" in answer) {
      // `app.missing_document` is the forum's "nothing here", like a null or an empty list.
      if (answer.error !== "not_found") refusal ??= { error: answer.error, message: answer.message, key: source.key };
      continue;
    }
    const found = source.read(answer.data).filter(isPublic);
    if (ref.kind === "post" && source.key === "slug" && found.length > 1) throw twoPosts(param, ref.value, found);
    const first = found[0];
    if (first !== undefined) return resolved(ref, first, ctx, svc);
  }
  throw failure(ref, param, refusal, ctx, svc);
}

function resolved(ref: ParsedRef, c: Candidate, ctx: CallContext, svc: Services): Resolved {
  const r = c.kind === "mdoc" ? mdocResolved(c.doc as RawMdocRef) : resolvedFrom(c.kind, c.doc);
  confirm(r, ctx);
  if (c.kind === "comment") {
    const { post, tag } = c.doc as Partial<RawCommentList>;
    if (postPublic(post)) ctx.confirmPublic("post", post._id);
    if (tagPublic(tag)) ctx.confirmPublic("tag", tag._id);
  }
  const k = cacheKind(r.kind);
  svc.caches.set("resolve", inputKey(ref), r);
  svc.caches.set("resolve", `${k}:${r.id}`, r);
  // ¶2.3 keys the cache by kind + input. A user's or page's slug lookup is exact and unique, so its current slug is a safe
  // extra key. A post's is not: two posts may share a slug (Q88), and the forum's slug lookup never finds an unlisted post or a
  // quick-takes container (P3), so a post is kept under its input and id only.
  if (r.slug !== undefined && (r.kind === "user" || r.kind === "tag" || r.kind === "lens")) svc.caches.set("resolve", `${k}:${r.slug}`, r);
  // A composed request reads past the negative cache; a subject public now must not keep failing in `resolve`.
  svc.caches.delete("negative", inputKey(ref));
  return forInput(r, ref);
}

/** A resolution cached under `ref`'s kind and value, confirmed public again in this call (P17), or `undefined`. */
export function cachedResolution(ref: ParsedRef, ctx: CallContext, svc: Services): Resolved | undefined {
  const hit = svc.caches.get<Resolved>("resolve", inputKey(ref));
  if (hit === undefined) return undefined;
  confirm(hit, ctx);
  return forInput(hit, ref);
}

/**
 * Caches `r` (found by another route, e.g. `find`) under its id and under `input`. A post that is not listable (unlisted, a
 * quick-takes container) is kept under its id only: the forum's slug lookup never finds it, so neither may a cached slug (P3).
 */
export function rememberResolution(kind: ResolvedKind, input: string, r: Resolved, svc: Services): void {
  const k = cacheKind(kind);
  svc.caches.set("resolve", `${k}:${r.id}`, r);
  if (kind === "post" && input !== r.id && !postListable(r.doc as RawPostRef | undefined)) return;
  svc.caches.set("resolve", `${k}:${input}`, r);
  svc.caches.delete("negative", `${k}:${input}`);
}

/** A subject's keys in the resolution cache, each with the value a `not_found` under it names: its id, and the reference given. */
function resolutionKeys(ref: ParsedRef, id: string): Map<string, string> {
  return new Map([[`${cacheKind(ref.kind)}:${id}`, id], [inputKey(ref), ref.value]]);
}

/**
 * Drops a subject's resolution under its id and the reference given (an LW1 address, say), so that the next look at it asks
 * the forum; a user's or page's slug key, when one was written, lapses with its TTL.
 */
export function dropResolution(ref: ParsedRef, id: string, svc: Services): void {
  for (const key of resolutionKeys(ref, id).keys()) svc.caches.delete("resolve", key);
}

/**
 * D1, ¶2.3: a subject the forum stopped returning since it was resolved (a comment privately deleted or rejected after the
 * discussion's forest was read): its resolution is dropped (`dropResolution`) and `error(value)` is remembered for 5
 * minutes under each of those keys, naming that key's value, so no later call shows it from the cache. Returns
 * `error(ref.value)`, which names the reference given, as `readResolution`'s failure does.
 */
export function forgetResolution(ref: ParsedRef, id: string, error: (value: string) => ToolError, svc: Services): ToolError {
  dropResolution(ref, id, svc);
  for (const [key, value] of resolutionKeys(ref, id)) {
    const e = error(value);
    svc.caches.set("negative", key, { category: e.category, message: e.message });
  }
  return error(ref.value);
}

/**
 * Resolves one identifier parameter: a collection costs nothing; a remembered `not_found`/`not_public` is thrown again and a
 * cached resolution returned, both without a request; otherwise one request. A cached `Resolved` keeps the document of the
 * selection that first resolved it, so a caller that needs more than the kind's reference fields builds its own request from
 * `resolutionOps` and `readResolution`.
 */
export async function resolve(ref: ParsedRef, param: string, ctx: CallContext, svc: Services, opts?: { select?: ResolveSelect }): Promise<Resolved> {
  if (ref.form === "collection") return collectionOf(ref);
  const negative = svc.caches.get<{ category: Category; message: string }>("negative", inputKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const cached = cachedResolution(ref, ctx, svc);
  if (cached !== undefined) return cached;
  const results = await svc.gql(resolutionOps(ref, "", opts?.select), ctx, `resolving ${param}`);
  return readResolution(ref, param, "", results, ctx, svc);
}

/** What a tool opens when given a lens or summary (¶3.1.2): its page (the rule), the part itself, or the lens the part belongs to. */
export interface EchoOptions {
  /**
   * `page` (the default): a lens or summary stands for its page and the note says so. `part`: the tool opens the lens or summary
   * itself (`get_history`'s own history, `get_reactions`' lens votes). `lens`: the tool opens the lens when there is one (a lens,
   * or the lens a summary belongs to; `get_tag`, `get_links`) and the page otherwise.
   */
  opens?: "page" | "part" | "lens";
}

/**
 * ¶3.7 request echo: `<param> → <display>`, then each note after ` · `. For a lens or summary, `opens` picks the ¶3.1.2 note:
 * the page note (the rule), or, in the four tools that address part of a page (the exception), what the tool opened.
 */
export function echoOf(param: string, r: Resolved, opts: EchoOptions = {}): string {
  const opens = opts.opens ?? "page";
  const part = r.part;
  const replacement = part === undefined || opens === "page" ? undefined : opens === "part" ? part.own : part.lens ?? (r.kind === "lens" ? part.own : undefined);
  const notes = replacement === undefined ? r.notes : r.notes.map((n) => (n === pageNoteOf(r) ? replacement : n));
  return `${param} → ${r.display}${notes.length > 0 ? " · " + notes.join(" · ") : ""}`;
}
