// Layer 3. The D1 policy (¶3.8.4): decides whether a row or a joined document is public, masks references to the ones
// that are not, and gives unattributable comments an opaque author before any per-person computation (P19). Joins
// arrive `null` when the forum's access check refuses them (§4.9), so `null` and `undefined` are never public. Every
// function is pure: it never throws and never logs (callers count what they drop and log only the numbers, P14).
import { CONFIG } from "../config";
import type {
  Person, PostRef, RawCommentRef, RawGlossaryTerm, RawLensRef, RawMdocRef, RawPostRef, RawRevRow, RawSeqRef, RawTagRef,
  RawUserRef, SeqRef, TagRef, VisibleTagRef, WikiEditPage,
} from "../types";

const UNREVIEWED_CUTOFF_MS = Date.parse(CONFIG.unreviewedCutoff);

/** P1, P2: whether a post row or join is public. Unlisted posts are public (P3). */
export function postPublic(p: RawPostRef | null | undefined): p is RawPostRef {
  return p != null && !p.rejected;
}

/** P2, P3: a post may be an item of a post list only when it is public, not unlisted and not a quick-takes container. */
export function postListable(p: Pick<RawPostRef, "rejected" | "unlisted" | "shortform"> | null | undefined): boolean {
  return p != null && !p.rejected && !p.unlisted && !p.shortform;
}

/**
 * P2, P5, P6: whether a comment row or join is public (an unparseable date fails closed). Placeholders, debate turns,
 * anonymous comments and `user: null` comments stay public; `authorOf` decides whom each one names.
 */
export function commentPublic(c: RawCommentRef | null | undefined): c is RawCommentRef {
  if (c == null || c.rejected) return false;
  if (c.deleted && !c.deletedPublic) return false;
  if (c.authorIsUnreviewed && !(Date.parse(c.postedAt) < UNREVIEWED_CUTOFF_MS)) return false;
  return true;
}

/** P5, D8: a publicly deleted comment is a placeholder: date and reason only, no author and no text. */
export function isPlaceholder(c: Pick<RawCommentRef, "deleted" | "deletedPublic">): boolean {
  return c.deleted && c.deletedPublic;
}

/** P8: a deleted account's profile is not public; a missing user is not either. */
export function userPublic(u: { deleted: boolean } | null | undefined): boolean {
  return u != null && !u.deleted;
}

/** P4: the forum refuses deleted and draft sequences, so they arrive `null`; hidden sequences open by id and are public. */
export function sequencePublic(s: RawSeqRef | null | undefined): s is RawSeqRef {
  return s != null;
}

/** P4: hidden sequences are never listed (collection listings included). */
export function sequenceListable(s: RawSeqRef | null | undefined): boolean {
  return sequencePublic(s) && !s.hidden;
}

/** P15: whether a glossary term is shown. */
export function glossaryTermPublic(t: RawGlossaryTerm): boolean {
  return t.approved && !t.deleted;
}

/**
 * P5, P7, P8: who a post, comment or revision is by; the first rule that applies wins. A placeholder and a `hideAuthor`
 * document name nobody, a `null` user is a deleted account, otherwise the user as the forum names them (render
 * sanitizes the name when printing).
 */
export function authorOf(user: RawUserRef | null, opts: { hideAuthor: boolean; placeholder?: boolean }): Person {
  if (opts.placeholder) return { kind: "none", why: "comment placeholder" };
  if (opts.hideAuthor) return { kind: "none", why: "author not publicly visible" };
  if (user === null) return { kind: "none", why: "account not publicly visible" };
  return { kind: "user", id: user._id, slug: user.slug, name: user.displayName ?? user.slug ?? user._id };
}

/** P1, P3, P14, D7, D11: a public post named with its flags, or `{hidden: true}` and nothing else. */
export function maskPostRef(p: RawPostRef | null | undefined): PostRef {
  if (!postPublic(p)) return { hidden: true };
  return {
    hidden: false, id: p._id, title: p.title, slug: p.slug, af: p.af, event: p.isEvent, unlisted: p.unlisted,
    question: p.question, shortform: p.shortform,
  };
}

/** P4, P14, D7: a public sequence named with its hidden-from-lists flag, or `{hidden: true}` and nothing else. */
export function maskSeqRef(s: RawSeqRef | null | undefined): SeqRef {
  if (!sequencePublic(s)) return { hidden: true };
  return { hidden: false, id: s._id, title: s.title, af: s.af, hiddenFromLists: s.hidden };
}

/** P19: only a comment with a named author counts toward a person. */
export function attributable(c: { author: Person }): boolean {
  return c.author.kind === "user";
}

// ---------- wiki pages, lenses, summaries and wiki edits (P12)

/** P12 (a), P1: whether a tag row or join is public. Wiki-only and placeholder pages are public. */
export function tagPublic(t: RawTagRef | null | undefined): t is RawTagRef {
  return t != null && !t.deleted && !t.adminOnly;
}

/** P12, §10.1: placeholder pages are never listed. */
export function tagListable(t: RawTagRef | null | undefined): boolean {
  return tagPublic(t) && !t.isPlaceholderPage;
}

function visibleTag(t: RawTagRef): VisibleTagRef {
  return { hidden: false, id: t._id, name: t.name, slug: t.slug, wikiOnly: t.wikiOnly };
}

/** P1, P12, P14: a public tag named with its flags, or `{hidden: true}` and nothing else. */
export function maskTagRef(t: RawTagRef | null | undefined): TagRef {
  return tagPublic(t) ? visibleTag(t) : { hidden: true };
}

/** P12 (b): the page of a lens or summary: its `parentTag`, else (a lens's own summary) its parent lens's page. */
export function pageOf(m: RawMdocRef): RawTagRef | null {
  return m.parentTag ?? m.parentLens?.parentTag ?? null;
}

/** P12 (b), Q137: the public page of a lens or summary, or `undefined` when the lens or summary is not public. */
function publicPageOf(m: RawMdocRef | null | undefined): RawTagRef | undefined {
  if (m == null || m.deleted) return undefined;
  if (m.collectionName === "MultiDocuments" && (m.parentLens == null || m.parentLens.deleted)) return undefined;
  const page = pageOf(m);
  return tagPublic(page) ? page : undefined;
}

/** P12 (b), Q137: a lens or summary is public only if it is not deleted and its page (and parent lens) are public. */
export function mdocPublic(m: RawMdocRef | null | undefined): m is RawMdocRef {
  return publicPageOf(m) !== undefined;
}

/** P12, Q60: a page's child rows without the deleted ones, as a new array. */
export function visibleChildren<T extends { deleted: boolean }>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => !r.deleted);
}

type RevisionJoins = Pick<RawRevRow, "collectionName" | "tag" | "lens" | "summary">;

/**
 * P12 (c): the public page a revision row (or a wiki-edit feed item) edited, through the join that matches its
 * `collectionName`, with the lens or summary for a `MultiDocuments` row, or `undefined`.
 */
function editedPage(r: RevisionJoins): { page: RawTagRef; doc: RawMdocRef | null } | undefined {
  if (r.collectionName === "Tags") return tagPublic(r.tag) ? { page: r.tag, doc: null } : undefined;
  if (r.collectionName !== "MultiDocuments") return undefined;
  const doc = r.lens ?? r.summary;
  const page = publicPageOf(doc);
  return doc != null && page !== undefined ? { page, doc } : undefined;
}

/** P12 (c), P14: whether a revision row is shown. */
export function revisionRowPublic(r: RevisionJoins): boolean {
  return editedPage(r) !== undefined;
}

/** A wiki edit's lens, titled by its `title`, else its `tabTitle`. */
function wikiLens(l: Pick<RawLensRef, "slug" | "title" | "tabTitle">): NonNullable<WikiEditPage["lens"]> {
  return { slug: l.slug, title: l.title ?? l.tabTitle };
}

/** P12 (c), ¶4.7 step 6: the page and the part a public wiki edit touched; `undefined` exactly when the row is hidden. */
export function wikiEditPage(r: RevisionJoins): WikiEditPage | undefined {
  const edited = editedPage(r);
  if (edited === undefined) return undefined;
  const { doc } = edited;
  const page = visibleTag(edited.page);
  if (doc === null) return { part: "page", page };
  if (doc.fieldName !== "summary") return { part: "lens", page, lens: wikiLens(doc) };
  // A lens's own summary: its parent lens is non-null here, because publicPageOf requires it.
  if (doc.collectionName === "MultiDocuments" && doc.parentLens != null) {
    return { part: "lens summary", page, lens: wikiLens(doc.parentLens), summaryId: doc._id };
  }
  return { part: "summary", page, summaryId: doc._id };
}
