// Layer 2. The `find` tool (¶4.1): names, titles and topics → ranked candidates with exact ids, in at most 3 requests. Request 1
// is one search POST with a query per item and index (step 2: the wiki-only `tags` query, the abbreviation's long form, further
// pages while `limit` needs them and the 4 MB estimate allows); request 2 re-reads every hit live and adds what search cannot
// give (step 3: slug fallbacks for posts, slug guesses for people, `tag(_id)` per tag hit plus the tag and lens slug lookups, the
// collections listing, the `commented_on` post, and each identifier item's resolution); request 3 is the `commented_on` post's
// comment forest, read only once that post is confirmed public (step 5). A forum URL or a 24-hex id is resolved and never
// searched; a bare 17-character query is resolved and searched in the same two requests, and falls back to the search outcome
// when it is neither an id nor a slug (step 1: "Superintelligence" is a word). Candidates are ranked and labelled as step 6 says, a
// best match is marked only when one candidate is clearly right (S15 for people), hidden ones are dropped (step 7: P3 unlisted
// posts and P4 hidden sequences only as identifiers), `af_only` removals are counted, and every kept candidate goes into the
// resolution cache (D4). The reply lists each item's candidates under its header; a continuation re-reads the next candidates
// by id and applies the visibility rules again (`list` paging over the rendered candidates).
import { z } from "zod";
import { CONFIG } from "../config";
import { toPostRecord } from "../domain/posts";
import { toSequenceRecord } from "../domain/sequences";
import { toTagRecord } from "../domain/tags";
import { toUserRecord } from "../domain/users";
import {
  attributable, maskSeqRef, mdocPublic, postListable, postPublic, sequenceListable, sequencePublic, tagPublic, userPublic,
} from "../domain/visibility";
import { badInput, internalError, isToolError } from "../errors";
import { buildSearch, estimateBytes } from "../forum/search";
import { findAlias, findHydrateOps, type FindHydratePlan } from "../forum/templates/find";
import { isEntityId, parseLink, parseRef, slugify } from "../ids/parse";
import { readResolution, rememberResolution, resolutionOps, resolvedFrom } from "../ids/resolve";
import { fingerprint, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, emptyText, errorText, fmtInt } from "../render/messages";
import { postLine, seqRefText, sequenceLine, tagCard, userCard } from "../render/records";
import { foldForMatch, sanitizeQuery } from "../text/phrases";
import { oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, Category, CollectionSlug, Consumed, CursorEntry, Facet, Footer, Forest, GqlOp, PageItem, ParsedRef, Person,
  RawBook, RawCollection,
  RawMdocRef, RawPostCard, RawPostFull, RawSeqCard, RawTagCard, RawUserCard, Resolved, SearchIndex, SearchSpec, Services, StreamState,
  ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, reply, setting } from "./common";
import { aliasData, collectionsCached, loadCollectionsListing, loadForest } from "./loaders";

interface FindItem { kind: "post" | "user" | "tag" | "sequence"; query: string; commented_on?: string }
type FindParams = { items?: FindItem[]; af_only: boolean; limit: number; cursor?: string; max_tokens: number };

type ItemKind = FindItem["kind"];
type CandKind = "post" | "user" | "tag" | "sequence" | "collection" | "book";
type ListState = Extract<StreamState, { kind: "list" }>;
type UserPerson = Extract<Person, { kind: "user" }>;
type Role = "main" | "wiki" | "alias";

/**
 * One row of the reply as the cursor keeps it (ids, numbers and server labels only, never forum text): a candidate; an item's
 * line when it has none (`none`, with the number of non-AF candidates af_only removed and the number of commenters it left out
 * unchecked); or the closing "Also searched" lines (`also`). A `none` line is written when it is printed: an identifier that did
 * not resolve (`again`) is resolved again, since its error can quote forum titles (D1).
 */
interface Row { item: number; kind: CandKind | "none" | "also"; id: string; label: string; best: boolean; removed?: number; unchecked?: number; again?: true }
/** What an item prints under its header before its first row: the post whose commenters came first, and its note lines. */
interface ItemHead { post?: string; notes: string[] }
interface FindData { cands: Row[]; heads: ItemHead[]; from?: number }

/** The document a candidate row is printed from. */
type Shown =
  | { kind: "post"; doc: RawPostCard }
  | { kind: "user"; doc: RawUserCard }
  | { kind: "person"; person: UserPerson }              // a commenter whose card was not read
  | { kind: "tag"; doc: RawTagCard }
  | { kind: "echo"; text: string }                      // an identifier lens or summary, or a collection outside the listing
  | { kind: "sequence"; doc: RawSeqCard }
  | { kind: "collection"; doc: RawCollection }
  | { kind: "book"; doc: RawBook; slug: string };

/** A candidate while one item is ranked: `group` orders it (step 6), `exact` marks an exact title or name. */
interface Cand { kind: CandKind; id: string; label: string; group: number; shown: Shown; exact: boolean; guessOnly?: boolean }
/**
 * One item's result: its kept candidates in order, its best match, its header notes, and what af_only left out: `removed`
 * candidates checked and found not on AF, `unchecked` commenters whose AF membership could not be checked.
 */
interface Outcome { cands: Cand[]; best?: Cand; head: ItemHead; removed: number; unchecked: number; failure?: string; failedAs?: Category }
interface Expansion { item: number; short: string; long: string }

const TITLE = "Which post, person, topic or sequence is this name?";
/** ¶4.1, verbatim. */
const DESCRIPTION_QUOTE =
  "Resolve names to exact identifiers for the other tools. items: 1–5 names, each {kind, query}, resolved independently: kind \"post\" (a post title), \"user\" (a person's display name), \"tag\" (a topic, tag or wiki page name) or \"sequence\" (a sequence, book or collection title). limit counts candidates per item. Each candidate has its ids and enough detail to choose (karma, dates, author, counts, a snippet), labelled by how it matched (identifier, exact title, exact name, commenter on the post, slug, earlier slug, alias, search). \"best match\" is marked only when one candidate is clearly right: the only exact title; the only matching commenter of commented_on; or, for people otherwise, the only account whose display name equals the query and whose karma is at least 10 and ten times that of every other candidate. Otherwise choose from the list or ask the user. Posts: give the full title; fragments often rank posts that quote the title first, and titles are not unique. The title's slug is also tried, which finds posts search leaves out (negative karma). People: display names only. Accents matter (\"Højmark\" ≠ \"Hojmark\"); several accounts can share a name; slug guesses are labelled \"may be a namesake\". To find someone who commented on a known post, add commented_on to the user item (a post identifier, or \"item:N\" for the best match of item N in this call, counting from 1): that post's commenters are matched first, which is how \"Paul Christiano\" finds paulfchristiano. Topics: the forum expands no abbreviations, so the long forms of LLM, RLHF, AGI, ML, EA, FDT, UDT, CEV, ELK, SAE, IDA, HPMOR and \"mech interp\" are searched as well, and this is reported. Wiki-only pages (articles that can't be applied to posts) are labelled. Sequences: the five collections and their books are matched by title too. A forum URL or an id given as query is resolved directly; a slug-like query is also tried as a slug. af_only keeps AF posts and sequences and, for user items, AF members; it does not apply to tag items (refused if every item is one). Karma and counts are re-read live.";

const SEARCH_TASK = "searching for the names";
const HYDRATE_TASK = "reading the candidates";

/** The labels of step 6, exactly. */
const LABEL = {
  identifier: "identifier",
  exactTitle: "exact title",
  exactName: "exact name",
  titleContains: "search; title contains the query",
  search: "search",
  foundBySlug: "found by slug; not in search, e.g. negative karma",
  notCommenter: "search; not a commenter on this post",
  namesake: "slug match (may be a namesake)",
  slug: "slug",
  oldSlug: "earlier slug",
  lensSlug: "lens slug",
  collection: "collection",
  alias: (long: string): string => `alias: ${long}`,
  book: (collection: string): string => `book in ${collection}`,
  commented: (n: number): string => `commented on this post ${fmtInt(n)} time${n === 1 ? "" : "s"}`,
} as const;

/** ¶4.1 "Errors and empty results": each kind's hint, verbatim. */
const HINT: Readonly<Record<ItemKind, string>> = {
  post: "give the full title, or search {phrases: [...]}",
  user: "check the spelling including accents; if they commented on a known post, add commented_on",
  tag: "spell out abbreviations; there may be no tag for this topic: search {query: …} finds posts by words",
  sequence: "collections and books are matched by title only",
};

/** S15: why an exact-name account is not the best match (¶4.1 step 6's sentence wherever it is true, else the rule it fails). */
const OUTRANKED = "an exact-name account exists, but a higher-karma account ranks above it";
const BELOW_TEN = "an exact-name account exists, but its karma is below 10";
const NOT_TEN_TIMES = "an exact-name account exists, but its karma is not ten times that of every other candidate";
const IGNORED_HIDDEN = "commented_on ignored: that post is not publicly visible";
/** At most one discussion is read per call (¶4.1: 1 search + 1 GraphQL + 0–1 forest). */
const IGNORED_ONE_FOREST = "commented_on ignored: only one post's commenters are read per call; ask for this item in another call";
const ignoredNoBest = (n: number): string => `commented_on ignored: item ${n} has no best match`;
const nonAf = (n: number): string => `${fmtInt(n)} non-AF candidate${n === 1 ? " was" : "s were"} left out`;
/** ¶3.5: a commenter whose card request 2 did not read cannot be checked for AF membership, so af_only leaves him out unchecked. */
const unchecked = (n: number): string => `${fmtInt(n)} commenter${n === 1 ? " was" : "s were"} left out because AF membership could not be checked (repeat without af_only to see them)`;
/**
 * Step 1: the header note of a bare 17-character query that resolved as neither id nor slug and was searched instead.
 * The same words for a hidden and a missing document (D1), and no forum text, so the note can live in the cursor.
 */
function notAnId(it: FindItem): string {
  const entity = { post: "post", user: "user", tag: "wiki page", sequence: "sequence" }[it.kind];
  const key = it.kind === "sequence" ? "id" : "id or slug";
  const as = it.kind === "post" || it.kind === "sequence" ? "title" : "name";
  return `not an ${key}: no publicly visible ${entity} has the ${key} ${queryText(it.query)}; searched as a ${as} instead`;
}

const INDEX: Readonly<Record<ItemKind, SearchIndex>> = { post: "posts", user: "users", tag: "tags", sequence: "sequences" };
const AF_FACET: Facet = { field: "af", value: true };
const WIKI_ONLY: Facet = { field: "wikiOnly", value: true };
/** The selections of an identifier item's resolution. */
const IDENTIFIER_SELECT = { post: "...POST_CARD", user: "...USER_CARD", tag: "...TAG_CARD", sequence: "...SEQ_CARD" } as const;
/** The `commented_on` post read like a resolution, its aliases `co`/`cs` (and `cl` for an LW1 link) seen as `cp`/`cs`/`cl`. */
const COMMENTED_ON_PREFIX = "c";
const HIDDEN_CATEGORIES: ReadonlySet<Category> = new Set(["not_found", "not_public", "login_only"]);

const ITEM_RE = /^item:(\d+)$/;
const GUESS_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME = CONFIG.render.caps.name;
const QUERY_CAP = 300;
const SEP = " · ";
const RECORD_INDENT = "     ";

const quoted = (s: string): string => `"${s}"`;
const queryText = (q: string): string => quoted(oneLine(q, QUERY_CAP));

// the search plan (step 2)

/** Step 1: a forum URL or a 24-hex id is resolved directly, never searched (neither can be a word). */
function isDirectQuery(query: string): boolean {
  const q = query.trim();
  return /^[0-9a-f]{24}$/.test(q) || parseLink(/^https?:\/\//i.test(q) ? q : `https://${q}`).onsite;
}

/** Step 1: a bare 17-character query is resolved as an identifier and searched as a name in the same requests. */
function isWordLikeId(query: string): boolean {
  return /^[A-Za-z0-9]{17}$/.test(query.trim());
}

/** The reference an identifier query parses to; undefined for a query that only goes to search. */
function refOf(it: FindItem): ParsedRef | undefined {
  return isDirectQuery(it.query) || isWordLikeId(it.query) ? parseRef("query", it.query, [it.kind]) : undefined;
}

/** The long form of an abbreviation the whole query spells (case-insensitively, also with a trailing "s"). */
function expansionOf(text: string): string | undefined {
  const t = text.toLowerCase();
  return CONFIG.abbreviations.find(({ abbr }) => t === abbr.toLowerCase() || t === `${abbr.toLowerCase()}s`)?.long;
}

interface Planned { spec: SearchSpec; item: number; role: Role }

function searchPlan(items: readonly FindItem[], limit: number, afOnly: boolean): { planned: Planned[]; expansions: Expansion[] } {
  const planned: Planned[] = [];
  const mains: Planned[] = [];
  const expansions: Expansion[] = [];
  items.forEach((it, i) => {
    const item = i + 1;
    if (isDirectQuery(it.query)) return;
    const text = sanitizeQuery(it.query).text;
    if (text === "") return;
    const index = INDEX[it.kind];
    const hitsPerPage = Math.min(limit, CONFIG.search.hitsPerPage[index]);
    const facets = afOnly && it.kind !== "tag" ? [AF_FACET] : [];
    const spec = (query: string, hits: number, f: readonly Facet[]): SearchSpec =>
      ({ index, sort: "relevance", query, page: 0, hitsPerPage: hits, ...(f.length > 0 && { facets: f }) });
    const main: Planned = { spec: spec(text, hitsPerPage, facets), item, role: "main" };
    planned.push(main);
    mains.push(main);
    if (it.kind === "tag") planned.push({ spec: spec(text, CONFIG.search.findWikiOnlyHits, [WIKI_ONLY]), item, role: "wiki" });
    const long = it.kind === "tag" || it.kind === "sequence" ? expansionOf(text) : undefined;
    if (long !== undefined) {
      planned.push({ spec: spec(long, hitsPerPage, facets), item, role: "alias" });
      expansions.push({ item, short: text, long });
    }
  });
  // Further pages of each item's main query, all second pages before any third, while the response estimate allows (¶7).
  for (let page = 1; ; page++) {
    const due = mains.filter((m) => page * m.spec.hitsPerPage! < limit);
    if (due.length === 0) break;
    for (const m of due) {
      const next: Planned = { ...m, spec: { ...m.spec, page } };
      if (estimateBytes(buildSearch([...planned, next].map((x) => x.spec))) > CONFIG.search.maxRequestBytes) return { planned, expansions };
      planned.push(next);
    }
  }
  return { planned, expansions };
}

/** ¶4.1 step 2: the search queries in request order, the item number of each, and the abbreviations expanded. */
export function findSearchSpecs(
  items: readonly FindItem[], limit: number, afOnly: boolean,
): { specs: SearchSpec[]; owners: number[]; expansions: { item: number; short: string; long: string }[] } {
  const { planned, expansions } = searchPlan(items, limit, afOnly);
  return { specs: planned.map((x) => x.spec), owners: planned.map((x) => x.item), expansions };
}

// checks before any request

type Target = { item: number } | { ref: ParsedRef };

/** ¶4.1 errors, in item order: `commented_on` on a non-user item, `item:N` out of range or not a post item, a bad identifier; then `af_only` on tag items only. */
function checkItems(items: readonly FindItem[], afOnly: boolean): (Target | undefined)[] {
  const count = items.length;
  const targets = items.map((it, i): Target | undefined => {
    const n = i + 1;
    if (it.commented_on === undefined) return undefined;
    if (it.kind !== "user") throw badInput("commented_on", `item ${n} is a ${it.kind} item; only user items take commented_on`, "Move it to a user item.");
    const m = ITEM_RE.exec(it.commented_on.trim());
    if (m === null) return { ref: parseRef("commented_on", it.commented_on, ["post"]) };
    const target = Number(m[1]);
    if (target < 1 || target > count) {
      throw badInput(
        "commented_on", `"item:${target}" names no item of this call (it has ${count} item${count === 1 ? "" : "s"})`,
        `Use item:1 to item:${count}, counting from 1.`,
      );
    }
    if (target === n || items[target - 1]!.kind !== "post") throw badInput("commented_on", `"item:${target}" is not a post item`, "Point it at a post item.");
    return { item: target };
  });
  if (afOnly && items.every((it) => it.kind === "tag")) {
    throw badInput("af_only", "wiki pages have no AF status", "Remove af_only; it does not apply to tag items.");
  }
  return targets;
}

// matching and ranking (steps 4–6)

/** Step 6: NFC, lower case, straight quotes, collapsed spaces, trailing `.?!:;,` dropped (so composed and decomposed accents agree). */
function normalized(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u{2018}\u{2019}]/gu, "'")
    .replace(/[\u{201C}\u{201D}]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.?!:;,]+$/u, "")
    .trimEnd();
}

/** Step 3: up to three slug guesses for a person's name, each a plausible slug. */
function userGuesses(query: string): string[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  return [...new Set([slugify(q), lower.replace(/\s+/gu, ""), lower.replace(/\s+/gu, "_")])].filter((g) => GUESS_RE.test(g));
}

/** Candidates in group order (stable), the first of each kind and id kept. */
function ranked(cands: readonly Cand[]): Cand[] {
  const seen = new Set<string>();
  return [...cands].sort((a, b) => a.group - b.group).filter((c) => {
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const afMember = (u: RawUserCard): boolean => (u.groups ?? []).includes(CONFIG.afGroup);

/** ¶3.5: whether a candidate stays under `af_only` (tag items never reach this). */
function keptByAf(s: Shown): boolean {
  switch (s.kind) {
    case "post":
    case "sequence":
      return s.doc.af;
    case "user":
      return afMember(s.doc);
    case "tag":
    case "echo":
    case "collection":
    case "book":
      return true;       // ¶3.5: items with no AF status are never removed
    case "person":
      return false;      // a commenter whose card was not read: his membership cannot be checked (counted as unchecked)
  }
}

/**
 * The ranked candidates without the ones `af_only` removes: `removed` counts those checked and found not on AF, `unchecked`
 * the commenters whose card was not read (removed too, but never called non-AF).
 */
function settled(cands: readonly Cand[], afOnly: boolean): { kept: Cand[]; removed: number; unchecked: number } {
  const all = ranked(cands);
  if (!afOnly) return { kept: all, removed: 0, unchecked: 0 };
  const kept = all.filter((c) => keptByAf(c.shown));
  const notChecked = all.filter((c) => c.shown.kind === "person").length;
  return { kept, removed: all.length - kept.length - notChecked, unchecked: notChecked };
}

/** The only candidate of group 0 (an exact match), when there is exactly one. */
function onlyExact(kept: readonly Cand[]): Cand | undefined {
  const exact = kept.filter((c) => c.group === 0);
  return exact.length === 1 ? exact[0] : undefined;
}

function postOutcome(it: FindItem, hits: readonly string[], slugRows: readonly RawPostCard[], docs: ReadonlyMap<string, RawPostCard>, afOnly: boolean): Outcome {
  const q = normalized(it.query);
  const cands: Cand[] = [];
  for (const id of hits) {
    const doc = docs.get(id);
    if (doc === undefined) continue;
    const title = normalized(doc.title);
    const exact = title === q;
    const label = exact ? LABEL.exactTitle : title.includes(q) ? LABEL.titleContains : LABEL.search;
    cands.push({ kind: "post", id, label, group: exact ? 0 : 1, shown: { kind: "post", doc }, exact });
  }
  for (const doc of slugRows) {
    if (cands.some((c) => c.id === doc._id)) continue;
    const exact = normalized(doc.title) === q;
    const label = exact ? `${LABEL.exactTitle}; ${LABEL.foundBySlug}` : LABEL.foundBySlug;
    cands.push({ kind: "post", id: doc._id, label, group: exact ? 0 : 2, shown: { kind: "post", doc }, exact });
  }
  const { kept, removed, unchecked: notChecked } = settled(cands, afOnly);
  return { cands: kept, best: onlyExact(kept), head: { notes: [] }, removed, unchecked: notChecked };
}

/** Step 5, P19: the commenters whose name or slug holds every word of the query, by attributable comments only. */
function matchingCommenters(forest: Forest, query: string): { person: UserPerson; count: number }[] {
  const words = foldForMatch(query).split(" ").filter((w) => w !== "");
  const found = new Map<string, { person: UserPerson; count: number }>();
  for (const node of forest.byId.values()) {
    const author = node.c.author;
    if (!attributable(node.c) || author.kind !== "user") continue;
    const name = foldForMatch(author.name);
    const slug = foldForMatch(author.slug ?? "");
    if (!words.every((w) => name.includes(w)) && !words.every((w) => slug.includes(w))) continue;
    const seen = found.get(author.id);
    if (seen !== undefined) seen.count += 1;
    else found.set(author.id, { person: author, count: 1 });
  }
  return [...found.values()];
}

const karmaOf = (c: Cand): number => (c.shown.kind === "user" ? c.shown.doc.karma : 0);

/** Step 6, S15: the best user, or the header note that says why there is none. */
function userBest(kept: readonly Cand[], commentersFirst: boolean): { best?: Cand; note?: string } {
  if (commentersFirst) {
    const commenters = kept.filter((c) => c.group === 0);
    if (commenters.length > 0) return commenters.length === 1 ? { best: commenters[0] } : {};
  }
  const exact = kept.filter((c) => c.exact);
  if (exact.length > 1) return { note: `${fmtInt(exact.length)} accounts have exactly this display name` };
  const e = exact[0];
  if (e === undefined || e.guessOnly) return {};   // a slug guess alone may be a namesake (§3.4)
  const others = kept.filter((c) => c !== e);
  if (karmaOf(e) >= 10 && others.every((c) => karmaOf(e) >= 10 * karmaOf(c))) return { best: e };
  // ¶4.1 step 6's sentence wherever it is true; otherwise the half of the S15 rule the account fails.
  if (others.some((c) => karmaOf(c) > karmaOf(e))) return { note: OUTRANKED };
  return { note: karmaOf(e) < 10 ? BELOW_TEN : NOT_TEN_TIMES };
}

function userOutcome(
  it: FindItem, hits: readonly string[], guesses: readonly RawUserCard[], docs: ReadonlyMap<string, RawUserCard>,
  forest: Forest | undefined, head: ItemHead, afOnly: boolean,
): Outcome {
  const q = normalized(it.query);
  const exactName = (u: RawUserCard): boolean => normalized(u.displayName) === q;
  // A commenter's card (and his karma for the tie-break) from any public card request 2 read: a search hit or a slug guess.
  const cards = new Map(docs);
  for (const doc of guesses) if (!cards.has(doc._id)) cards.set(doc._id, doc);
  const card = (id: string, person: UserPerson): Shown => {
    const doc = cards.get(id);
    return doc === undefined ? { kind: "person", person } : { kind: "user", doc };
  };
  const commenters = forest === undefined ? [] : matchingCommenters(forest, it.query).sort((a, b) =>
    b.count - a.count || (cards.get(b.person.id)?.karma ?? 0) - (cards.get(a.person.id)?.karma ?? 0) || (a.person.id < b.person.id ? -1 : 1));
  const cands: Cand[] = commenters.map(({ person, count }) => (
    { kind: "user", id: person.id, label: LABEL.commented(count), group: 0, shown: card(person.id, person), exact: false }));
  for (const id of hits) {
    const doc = docs.get(id);
    if (doc === undefined) continue;
    const exact = exactName(doc);
    const label = exact ? LABEL.exactName : forest !== undefined ? LABEL.notCommenter : LABEL.search;
    cands.push({ kind: "user", id, label, group: 1, shown: { kind: "user", doc }, exact });
  }
  for (const doc of guesses) {
    cands.push({ kind: "user", id: doc._id, label: LABEL.namesake, group: 2, shown: { kind: "user", doc }, exact: exactName(doc), guessOnly: true });
  }
  const { kept, removed, unchecked: notChecked } = settled(cands, afOnly);
  const { best, note } = userBest(kept, forest !== undefined);
  return { cands: kept, best, head: { ...head, notes: [...head.notes, ...(note === undefined ? [] : [note])] }, removed, unchecked: notChecked };
}

/** A tag item's slug lookups: the `tagBySlug` rows and the `TagPreview` answer. */
interface TagSlugAnswer { rows: readonly RawTagCard[]; preview: unknown }

function tagOutcome(
  it: FindItem, hits: Readonly<Record<Role, readonly string[]>>, long: string | undefined, slugAnswer: TagSlugAnswer | undefined,
  docs: ReadonlyMap<string, RawTagCard>,
): Outcome {
  const q = normalized(it.query);
  const slug = slugify(it.query);
  const raw = it.query.trim().toLowerCase();
  const entries: { doc: RawTagCard; group: number; label: string }[] = [];
  const bySlug = (doc: RawTagCard): void => void entries.push({ doc, group: 1, label: doc.slug === slug ? LABEL.slug : LABEL.oldSlug });
  for (const doc of slugAnswer?.rows ?? []) if (tagPublic(doc)) bySlug(doc);
  const preview = slugAnswer?.preview;
  if (isRecord(preview) && isRecord(preview.tag)) {
    const page = preview.tag as unknown as RawTagCard;
    if (preview.lens != null) {
      // P12: a lens slug stands for its page, only while the lens and its page are public.
      if (mdocPublic(preview.lens as RawMdocRef) && tagPublic(page)) entries.push({ doc: page, group: 1, label: LABEL.lensSlug });
    } else if (tagPublic(page)) {
      bySlug(page);
    }
  }
  const fromHits = (ids: readonly string[], group: number, label: string): void => {
    for (const id of ids) {
      const doc = docs.get(id);
      if (doc !== undefined) entries.push({ doc, group, label });
    }
  };
  if (long !== undefined) fromHits(hits.alias, 2, LABEL.alias(long));
  fromHits(hits.main, 3, LABEL.search);
  fromHits(hits.wiki, 3, LABEL.search);
  const cands = entries.map(({ doc, group, label }): Cand => {
    const name = normalized(doc.name) === q;
    const exact = name || doc.slug === raw;
    return { kind: "tag", id: doc._id, label: exact ? (name ? LABEL.exactName : LABEL.slug) : label, group: exact ? 0 : group, shown: { kind: "tag", doc }, exact };
  });
  const { kept } = settled(cands, false);   // ¶3.5: af_only does not apply to tag items
  return { cands: kept, best: onlyExact(kept), head: { notes: [] }, removed: 0, unchecked: 0 };
}

function sequenceOutcome(
  it: FindItem, hits: Readonly<Record<Role, readonly string[]>>, long: string | undefined, docs: ReadonlyMap<string, RawSeqCard>,
  listing: readonly RawCollection[], afOnly: boolean,
): Outcome {
  const q = normalized(it.query);
  const cands: Cand[] = [];
  const fromHits = (ids: readonly string[], label: string): void => {
    for (const id of ids) {
      const doc = docs.get(id);
      if (doc === undefined) continue;
      const exact = normalized(doc.title) === q;
      cands.push({ kind: "sequence", id, label: exact ? LABEL.exactTitle : label, group: exact ? 0 : 1, shown: { kind: "sequence", doc }, exact });
    }
  };
  fromHits(hits.main, LABEL.search);
  if (long !== undefined) fromHits(hits.alias, LABEL.alias(long));
  // Step 4: collections and books are not indexed; they match by normalized title (collections also by the alias table and by
  // their own slug: "codex" names The Codex as surely as "The Codex" does).
  const lower = it.query.trim().toLowerCase();
  for (const c of listing) {
    const slug = collectionSlugOf(c);
    const aliases: readonly string[] = (CONFIG.collectionAliases as Readonly<Record<string, readonly string[]>>)[slug] ?? [];
    if (normalized(c.title) === q || aliases.some((a) => normalized(a) === q) || slug === lower) {
      cands.push({ kind: "collection", id: c._id, label: LABEL.collection, group: 0, shown: { kind: "collection", doc: c }, exact: true });
    }
  }
  for (const c of listing) {
    const slug = collectionSlugOf(c);
    for (const book of c.books) {
      if (normalized(book.title) !== q) continue;
      cands.push({ kind: "book", id: book._id, label: LABEL.book(slug), group: 0, shown: { kind: "book", doc: book, slug }, exact: true });
    }
  }
  const { kept, removed, unchecked: notChecked } = settled(cands, afOnly);
  return { cands: kept, best: onlyExact(kept), head: { notes: [] }, removed, unchecked: notChecked };
}

/** A collection's slug from the hard-coded id table (§11.5), so that a label never carries a forum string. */
function collectionSlugOf(c: RawCollection): string {
  return (Object.keys(CONFIG.collections) as CollectionSlug[]).find((slug) => CONFIG.collections[slug] === c._id) ?? oneLine(c.slug, NAME);
}

/** What an identifier item's resolution prints from: a card when the resolution read one, else its echo. */
function identifierShown(r: Resolved, listing: readonly RawCollection[]): { kind: CandKind; id: string; shown: Shown } {
  const echo = (): Shown => ({ kind: "echo", text: [r.display, ...r.notes].join(SEP) });
  switch (r.kind) {
    case "post": return { kind: "post", id: r.id, shown: { kind: "post", doc: r.doc as RawPostCard } };
    case "user": return { kind: "user", id: r.id, shown: { kind: "user", doc: r.doc as RawUserCard } };
    case "tag": return { kind: "tag", id: r.id, shown: { kind: "tag", doc: r.doc as RawTagCard } };
    case "lens":
    case "summary": return { kind: "tag", id: r.pageId ?? r.id, shown: echo() };
    case "sequence": return { kind: "sequence", id: r.id, shown: { kind: "sequence", doc: r.doc as RawSeqCard } };
    case "collection": {
      const doc = listing.find((c) => c._id === r.id);
      return { kind: "collection", id: r.id, shown: doc === undefined ? echo() : { kind: "collection", doc } };
    }
    case "comment": throw internalError("find", "an identifier item resolved to a comment");
  }
}

/** Step 1: an identifier item's single candidate is its best match; a failure is its only line, and the call goes on. */
function identifierOutcome(
  ref: ParsedRef, n: number, results: AliasResults, listing: readonly RawCollection[], afOnly: boolean, ctx: CallContext, svc: Services,
): Outcome {
  let r: Resolved;
  try {
    r = readResolution(ref, "query", `r${n}`, results, ctx, svc);
  } catch (e) {
    if (isToolError(e)) return { cands: [], head: { notes: [] }, removed: 0, unchecked: 0, failure: `not resolved: ${errorText(e)}`, failedAs: e.category };
    throw e;
  }
  const { kind, id, shown } = identifierShown(r, listing);
  const { kept, removed, unchecked: notChecked } = settled([{ kind, id, label: LABEL.identifier, group: 0, shown, exact: true }], afOnly);
  return { cands: kept, best: kept[0], head: { notes: [] }, removed, unchecked: notChecked };
}

// reading the answers

/** The documents of a `{ results }` alias of request 2. */
function listed<T>(results: AliasResults, alias: string, ctx: CallContext): T[] {
  const data = aliasData(results, alias, HYDRATE_TASK, ctx);
  return isRecord(data) && Array.isArray(data.results) ? (data.results.filter(isRecord) as T[]) : [];
}

/** The document of a `{ result }` alias (`single`) or of a root answered directly. */
function one<T>(results: AliasResults, alias: string, ctx: CallContext, single: boolean): T | undefined {
  const data = aliasData(results, alias, HYDRATE_TASK, ctx);
  const doc = single && isRecord(data) ? data.result : data;
  return isRecord(doc) ? (doc as T) : undefined;
}

/** P17: the public posts of a post alias are confirmed public in this call; the listable ones are candidates (P2, P3). */
function listablePosts(results: AliasResults, alias: string, ctx: CallContext): RawPostCard[] {
  return listed<RawPostCard>(results, alias, ctx).filter((d) => {
    if (!postPublic(d)) return false;
    ctx.confirmPublic("post", d._id);
    return postListable(d);
  });
}

/** The tag docs of the `t<k>` aliases, public ones only (placeholder pages kept, P12). */
function tagsById(results: AliasResults, ids: readonly string[], ctx: CallContext): Map<string, RawTagCard> {
  const docs = new Map<string, RawTagCard>();
  [...new Set(ids)].forEach((_, k) => {
    const doc = one<RawTagCard>(results, findAlias.tagId(k), ctx, true);
    if (doc !== undefined && tagPublic(doc)) docs.set(doc._id, doc);
  });
  return docs;
}

/** The `commented_on` post read like a resolution (P17): its document, or `undefined` when it is not publicly visible. */
function commentedOnPost(ref: ParsedRef, results: AliasResults, ctx: CallContext, svc: Services): RawPostCard | undefined {
  const seen: [string, string][] = [["co", "cp"], ["cs", "cs"], ["cl", "cl"]];
  const view: AliasResults = new Map(seen.flatMap(([from, to]) => {
    const r = results.get(from);
    return r === undefined ? [] : [[to, r] as const];
  }));
  try {
    return readResolution(ref, "commented_on", COMMENTED_ON_PREFIX, view, ctx, svc).doc as RawPostCard;
  } catch (e) {
    if (isToolError(e) && HIDDEN_CATEGORIES.has(e.category)) return undefined;
    throw e;
  }
}

// the first page

async function firstPage(p: FindParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const items = p.items;
  if (items === undefined) throw internalError("find", "items missing without a cursor");
  const targets = checkItems(items, p.af_only);
  const refs = items.map(refOf);
  // Step 1: a word-like item is searched as well as resolved, and falls back to the search when nothing has its id or slug.
  const searched = items.map((it, i) => refs[i] === undefined || isWordLikeId(it.query));
  const { planned, expansions } = searchPlan(items, p.limit, p.af_only);

  // Request 1: one search POST.
  const hits = items.map((): Record<Role, string[]> => ({ main: [], wiki: [], alias: [] }));
  if (planned.length > 0) {
    const answers = await svc.search(buildSearch(planned.map((x) => x.spec)), ctx, SEARCH_TASK, "empty");
    planned.forEach((x, i) => {
      const into = hits[x.item - 1]![x.role];
      for (const hit of answers[i]?.hits ?? []) {
        const id = typeof hit._id === "string" ? hit._id : hit.objectID;
        if (isEntityId(id) && !into.includes(id)) into.push(id);
      }
    });
  }

  // Request 2: the hydrate, the slug lookups, the listing, the commented_on post and the identifiers.
  const postSlugs: string[] = [];
  const userSlugs: string[] = [];
  const tagSlugs: string[] = [];
  const at = (list: string[], s: string): number => {
    if (!list.includes(s)) list.push(s);
    return list.indexOf(s);
  };
  const slugOf = items.map((it, i) => {
    const s = searched[i] && (it.kind === "post" || it.kind === "tag") ? slugify(it.query) : "";
    return s === "" ? undefined : at(it.kind === "post" ? postSlugs : tagSlugs, s);
  });
  const guessesOf = items.map((it, i) => (searched[i] && it.kind === "user" ? userGuesses(it.query).map((g) => at(userSlugs, g)) : []));
  const explicit = targets.find((t): t is { ref: ParsedRef } => t !== undefined && "ref" in t)?.ref;
  const sameRef = (a: ParsedRef, b: ParsedRef): boolean => a.form === b.form && a.value === b.value;
  const ofKind = (kind: ItemKind, roles: readonly Role[]): string[] =>
    items.flatMap((it, i) => (it.kind === kind && searched[i] ? roles.flatMap((r) => hits[i]![r]) : []));
  const plan: FindHydratePlan = {
    postIds: ofKind("post", ["main"]), postSlugs,
    userIds: ofKind("user", ["main"]), userSlugs,
    tagIds: ofKind("tag", ["main", "wiki", "alias"]), tagSlugs,
    sequenceIds: ofKind("sequence", ["main", "alias"]),
    collections: items.some((it) => it.kind === "sequence") && !collectionsCached(svc),
  };
  const extra: GqlOp[] = [];
  if (explicit?.form === "id") plan.commentedOn = { id: explicit.value };
  else if (explicit?.form === "slug") plan.commentedOn = { slug: explicit.value };
  else if (explicit?.form === "idOrSlug") plan.commentedOn = { id: explicit.value, slug: explicit.value };
  else if (explicit !== undefined) extra.push(...resolutionOps(explicit, COMMENTED_ON_PREFIX, { post: "...POST_CARD" }));   // an LW1 link
  refs.forEach((ref, i) => {
    if (ref !== undefined) extra.push(...resolutionOps(ref, `r${i + 1}`, IDENTIFIER_SELECT));
  });
  const ops = [...findHydrateOps(plan), ...extra];
  const results: AliasResults = ops.length > 0 ? await svc.gql(ops, ctx, HYDRATE_TASK) : new Map();

  const postDocs = new Map(listablePosts(results, "p", ctx).map((d) => [d._id, d]));
  const userDocs = new Map(listed<RawUserCard>(results, "u", ctx).filter(userPublic).map((d) => [d._id, d]));
  const tagDocs = tagsById(results, plan.tagIds, ctx);
  const seqDocs = new Map(listed<RawSeqCard>(results, "s", ctx).filter(sequenceListable).map((d) => [d._id, d]));
  const listing = items.some((it) => it.kind === "sequence") ? await loadCollectionsListing(ctx, svc, results) : [];
  const longOf = (n: number): string | undefined => expansions.find((x) => x.item === n)?.long;

  // Every item but the people first: `item:N` names the best match of a post item. An identifier item that resolved, or whose
  // query cannot be a word, is done; a word-like one that nothing has as id or slug goes on to its kind's outcome under a note.
  const outcomes: Outcome[] = [];
  const idNotes: (string | undefined)[] = [];
  items.forEach((it, i) => {
    const ref = refs[i];
    const k = slugOf[i];
    if (ref !== undefined) {
      const o = identifierOutcome(ref, i + 1, results, listing, p.af_only, ctx, svc);
      if (!(o.failedAs === "not_found" && isWordLikeId(it.query))) {
        outcomes[i] = o;
        return;
      }
      idNotes[i] = notAnId(it);
    }
    if (it.kind === "post") {
      outcomes[i] = postOutcome(it, hits[i]!.main, k === undefined ? [] : listablePosts(results, findAlias.postSlug(k), ctx), postDocs, p.af_only);
    } else if (it.kind === "tag") {
      const answer = k === undefined ? undefined : {
        rows: listed<RawTagCard>(results, findAlias.tagSlug(k), ctx), preview: one(results, findAlias.tagPreview(k), ctx, false),
      };
      outcomes[i] = tagOutcome(it, hits[i]!, longOf(i + 1), answer, tagDocs);
    } else if (it.kind === "sequence") outcomes[i] = sequenceOutcome(it, hits[i]!, longOf(i + 1), seqDocs, listing, p.af_only);
    const note = idNotes[i];
    if (note !== undefined && outcomes[i] !== undefined) outcomes[i]!.head.notes.unshift(note);
  });

  // Step 5: the commented_on post, confirmed public, and its commenters (request 3; one discussion per call).
  const explicitPost = explicit === undefined ? undefined : commentedOnPost(explicit, results, ctx, svc);
  const forests = new Map<string, Forest>();
  for (const [i, it] of items.entries()) {
    if (outcomes[i] !== undefined) continue;
    const target = targets[i];
    const note = idNotes[i];
    const head: ItemHead = { notes: note === undefined ? [] : [note] };
    let post: RawPostCard | undefined;
    if (target !== undefined && "item" in target) {
      const best = outcomes[target.item - 1]?.best?.shown;
      if (best?.kind === "post") post = best.doc;
      else head.notes.push(ignoredNoBest(target.item));
    } else if (target !== undefined) {
      head.notes.push(...target.ref.notes);   // what `ids/parse` set aside (a commentId, stray punctuation) is said, not dropped
      if (!sameRef(target.ref, explicit!)) head.notes.push(IGNORED_ONE_FOREST);
      else if (explicitPost === undefined) head.notes.push(IGNORED_HIDDEN);
      else post = explicitPost;
    }
    let forest: Forest | undefined;
    if (post !== undefined) {
      forest = forests.get(post._id);
      if (forest === undefined && (forests.size === 0 || svc.caches.get("forest", `post:${post._id}`) !== undefined)) {
        forest = await loadForest({
          kind: "post", id: ctx.confirmPublic("post", post._id), af: post.af,
          hideCommentKarma: (post as Partial<RawPostFull>).hideCommentKarma === true, debate: (CONFIG.debatePostIds as readonly string[]).includes(post._id),
        }, ctx, svc);
        forests.set(post._id, forest);
      }
      if (forest === undefined) head.notes.push(IGNORED_ONE_FOREST);
      else head.post = post._id;
    }
    const guesses = guessesOf[i]!.flatMap((k) => {
      const doc = one<RawUserCard>(results, findAlias.userSlug(k), ctx, false);
      return doc !== undefined && userPublic(doc) ? [doc] : [];
    });
    outcomes[i] = userOutcome(it, hits[i]!.main, guesses, userDocs, forest, head, p.af_only);
  }

  remember(outcomes, svc);

  const rows: Row[] = [];
  const docs = new Map<string, Shown>();
  const failures = new Map<number, string>();
  outcomes.forEach((o, i) => {
    const n = i + 1;
    const shown = o.cands.slice(0, p.limit);
    for (const c of o.cands) keepDoc(docs, `${c.kind}:${c.id}`, c.shown);
    if (shown.length === 0) {
      if (o.failure !== undefined) failures.set(n, o.failure);
      rows.push({ ...noneRow(n, o), ...(o.failure !== undefined && { again: true as const }) });
    } else {
      if (o.removed > 0) o.head.notes.push(nonAf(o.removed));
      if (o.unchecked > 0) o.head.notes.push(unchecked(o.unchecked));
      for (const c of shown) rows.push({ item: n, kind: c.kind, id: c.id, label: c.label, best: c === o.best });
    }
  });
  if (expansions.length > 0) rows.push({ item: 0, kind: "also", id: "", label: "", best: false });

  const args = givenArgs(p, ctx);
  return render({
    items, afOnly: p.af_only, limit: p.limit, echo: ctx, rows, heads: outcomes.map((o) => o.head), docs, failures, expansions,
    args, effective: findEffective(p),
  }, p.max_tokens, svc);
}

/** The row of an item without candidates, with the counts af_only left out (numbers only, so it is safe in the cursor). */
function noneRow(item: number, o: Outcome): Row {
  return {
    item, kind: "none", id: "", label: "", best: false,
    ...(o.removed > 0 && { removed: o.removed }), ...(o.unchecked > 0 && { unchecked: o.unchecked }),
  };
}

/** Keeps `s` under `key` unless a card is there already: a stand-in (a commenter without a card, an echo) never replaces one. */
function keepDoc(docs: Map<string, Shown>, key: string, s: Shown): void {
  const standIn = (x: Shown): boolean => x.kind === "person" || x.kind === "echo";
  const had = docs.get(key);
  if (had === undefined || (standIn(had) && !standIn(s))) docs.set(key, s);
}

/** D4: every kept candidate under its slug (or id) → its resolution; two posts sharing a slug only under their ids (Q88). */
function remember(outcomes: readonly Outcome[], svc: Services): void {
  const cands = outcomes.flatMap((o) => o.cands);
  const idsBySlug = new Map<string, Set<string>>();
  for (const c of cands) {
    if (c.shown.kind !== "post") continue;
    const ids = idsBySlug.get(c.shown.doc.slug) ?? new Set<string>();
    idsBySlug.set(c.shown.doc.slug, ids.add(c.id));
  }
  for (const { shown: s } of cands) {
    switch (s.kind) {
      case "post": {
        const shared = (idsBySlug.get(s.doc.slug)?.size ?? 0) > 1;
        rememberResolution("post", shared ? s.doc._id : s.doc.slug, resolvedFrom("post", s.doc), svc);
        break;
      }
      case "user":
        rememberResolution("user", s.doc.slug, resolvedFrom("user", s.doc), svc);
        break;
      case "person": {
        const { id, slug, name } = s.person;
        rememberResolution("user", slug ?? id, resolvedFrom("user", { _id: id, slug, displayName: name }), svc);
        break;
      }
      case "tag":
        rememberResolution("tag", s.doc.slug, resolvedFrom("tag", s.doc), svc);
        break;
      case "sequence":
        rememberResolution("sequence", s.doc._id, resolvedFrom("sequence", s.doc), svc);
        break;
    }
  }
}

function findEffective(p: FindParams): Record<string, unknown> {
  return { items: p.items, af_only: p.af_only, limit: p.limit };
}

// a continuation

/** The rows still to show and what they print from, read again in one request. */
interface Reread { rows: Row[]; docs: Map<string, Shown>; failures: Map<number, string> }

/**
 * Step 7 again on the rows still to show: candidates are re-read by id and dropped when their document is gone or no longer
 * passes; an identifier item that did not resolve is resolved again (its line, or now its candidate).
 */
async function reread(rest: readonly Row[], items: readonly FindItem[], afOnly: boolean, ctx: CallContext, svc: Services): Promise<Reread> {
  const ids = (kind: CandKind): string[] => [...new Set(rest.filter((r) => r.kind === kind).map((r) => r.id))];
  const needsListing = rest.some((r) => r.kind === "collection" || r.kind === "book");
  const retried = new Map(rest.flatMap((r) => {
    const it = items[r.item - 1];
    const ref = r.kind === "none" && r.again && it !== undefined ? refOf(it) : undefined;
    return ref === undefined ? [] : [[r, ref] as const];
  }));
  const plan: FindHydratePlan = {
    postIds: ids("post"), postSlugs: [], userIds: ids("user"), userSlugs: [], tagIds: ids("tag"), tagSlugs: [],
    sequenceIds: ids("sequence"), collections: needsListing && !collectionsCached(svc),
  };
  const ops = [...findHydrateOps(plan), ...[...retried].flatMap(([r, ref]) => resolutionOps(ref, `r${r.item}`, IDENTIFIER_SELECT))];
  const results: AliasResults = ops.length > 0 ? await svc.gql(ops, ctx, HYDRATE_TASK) : new Map();
  const docs = new Map<string, Shown>();
  for (const doc of listed<RawPostCard>(results, "p", ctx)) if (postPublic(doc)) docs.set(`post:${doc._id}`, { kind: "post", doc });
  for (const doc of listed<RawUserCard>(results, "u", ctx)) if (userPublic(doc)) docs.set(`user:${doc._id}`, { kind: "user", doc });
  for (const doc of tagsById(results, plan.tagIds, ctx).values()) docs.set(`tag:${doc._id}`, { kind: "tag", doc });
  for (const doc of listed<RawSeqCard>(results, "s", ctx)) if (sequencePublic(doc)) docs.set(`sequence:${doc._id}`, { kind: "sequence", doc });
  const listing = needsListing ? await loadCollectionsListing(ctx, svc, results) : [];
  for (const c of listing) {
    docs.set(`collection:${c._id}`, { kind: "collection", doc: c });
    for (const doc of c.books) docs.set(`book:${doc._id}`, { kind: "book", doc, slug: collectionSlugOf(c) });
  }
  const rows: Row[] = [];
  const failures = new Map<number, string>();
  for (const row of rest) {
    const ref = retried.get(row);
    if (ref === undefined) {
      const s = docs.get(`${row.kind}:${row.id}`);
      if (row.kind === "none" || row.kind === "also" || (s !== undefined && stillShown(row, s, afOnly))) rows.push(row);
      continue;
    }
    const o = identifierOutcome(ref, row.item, results, listing, afOnly, ctx, svc);
    const c = o.cands[0];
    if (c !== undefined) {
      keepDoc(docs, `${c.kind}:${c.id}`, c.shown);
      rows.push({ item: row.item, kind: c.kind, id: c.id, label: c.label, best: true });
      continue;
    }
    if (o.failure !== undefined) failures.set(row.item, o.failure);
    rows.push({ ...noneRow(row.item, o), again: true });
  }
  return { rows, docs, failures };
}

/** Step 7 again on a re-read document: identifiers need only be public; everything else listable; af_only as on page 1. */
function stillShown(row: Row, s: Shown, afOnly: boolean): boolean {
  const identifier = row.label === LABEL.identifier;
  if (s.kind === "post" && !identifier && !postListable(s.doc)) return false;
  if (s.kind === "sequence" && !identifier && !sequenceListable(s.doc)) return false;
  return !afOnly || s.kind === "tag" || keptByAf(s);
}

async function continuation(entry: CursorEntry, p: FindParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  checkContinuation(entry, findEffective(p), ctx);
  const effective = entry.effective as { items: FindItem[]; af_only: boolean; limit: number };
  const state = entry.state.streams[entry.state.current] as ListState;
  const data = entry.state.data as unknown as FindData;
  const rest = listPage(data.cands, state, data.cands.length, rowKey).items;
  const start = data.cands.length - rest.length;
  const { rows, docs, failures } = await reread(rest, effective.items, effective.af_only, ctx, svc);
  const visible = [...data.cands.slice(0, start), ...rows];
  const first = rest[0];
  const from = first !== undefined && visible[start] === first ? data.from : undefined;
  return render({
    // The echo marks `(default)` only what neither the first call nor this one gave.
    items: effective.items, afOnly: effective.af_only, limit: effective.limit, echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
    rows: visible, heads: data.heads, docs, failures, expansions: findSearchSpecs(effective.items, effective.limit, effective.af_only).expansions,
    args: { ...entry.args }, effective: { ...entry.effective }, state, from,
  }, p.max_tokens, svc);
}

// the reply

interface PageInput {
  items: readonly FindItem[];
  afOnly: boolean;
  limit: number;
  echo: CallContext;                        // its `given` decides the request echo's `(default)` marks
  rows: Row[];
  heads: readonly ItemHead[];
  docs: ReadonlyMap<string, Shown>;
  failures: ReadonlyMap<number, string>;    // an unresolved identifier item's line, written for this page
  expansions: readonly Expansion[];
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
  state?: ListState;
  from?: number;
}

const rowKey = (r: Row): string => `${r.item}:${r.kind}:${r.id}`;

/**
 * ¶3.9 the filtered-list template with the item kind's hint (¶4.1), and what af_only left out when it left out some: the
 * non-AF candidates and the unchecked commenters as one suggestion, since the template keeps only two.
 */
function emptyLine(it: FindItem, row: Row): string {
  const { removed = 0, unchecked: notChecked = 0 } = row;
  const left = [...(removed > 0 ? [nonAf(removed)] : []), ...(notChecked > 0 ? [unchecked(notChecked)] : [])];
  return emptyText({
    kind: "filtered", items: "candidates", filters: `${it.kind} ${queryText(it.query)}`,
    suggestions: [HINT[it.kind], ...(left.length > 0 ? [left.join(", and ")] : [])],
  });
}

/** A record's lines without the bullet of a list record. */
const unbullet = (text: string): string[] => text.replace(/^• /u, "").split("\n");

/** ¶3.8.1 record lines of one candidate (post list form without excerpt, user card, tag card with excerpt, sequence line). */
function recordLines(s: Shown): string[] {
  switch (s.kind) {
    case "post": return postLine(toPostRecord(s.doc), { prefix: "" }).split("\n");
    case "user": return unbullet(userCard(toUserRecord(s.doc)));
    case "person": {
      const { id, slug, name } = s.person;
      return [[quoted(oneLine(name, NAME)), ...(slug ? [`user_slug ${slug}`] : []), `user_id ${id}`].join(SEP)];
    }
    case "tag": return unbullet(tagCard(toTagRecord(s.doc), { excerpt: true }));
    case "echo": return [s.text];
    case "sequence": return unbullet(sequenceLine(toSequenceRecord(s.doc)));
    case "collection": return [`${quoted(oneLine(s.doc.title, NAME))}${SEP}collection_slug ${collectionSlugOf(s.doc)}`];
    case "book": {
      // P4, P14: only the book's visible sequences, by reference.
      const sequences = s.doc.sequences.map((q) => seqRefText(maskSeqRef(q)));
      const head = `book ${quoted(oneLine(s.doc.title, NAME))} in collection_slug ${s.slug}`;
      return [sequences.length > 0 ? `${head}: ${sequences.join(", ")}` : head];
    }
  }
}

function render(input: PageInput, maxTokens: number, svc: Services): ToolOutput {
  const { items, rows, heads, docs } = input;
  const page = listPage(rows, input.state, rows.length, rowKey, () => 0);
  const start = rows.length - page.items.length;
  const startState: ListState = input.state ?? { kind: "list", shown: 0, index: 0, fingerprint: fingerprint(rows, () => 0) };

  // Candidate numbers within each item, and each item's last number.
  const numbers: number[] = [];
  const last = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === "none" || r.kind === "also") return;
    numbers[i] = (last.get(r.item) ?? 0) + 1;
    last.set(r.item, numbers[i]!);
  });

  const header = (n: number): string => {
    const it = items[n - 1]!;
    const post = heads[n - 1]?.post;
    return `Item ${n} · ${it.kind} ${queryText(it.query)}${post === undefined ? "" : ` (commenters of post_id ${post} first)`}`;
  };
  const continued = (n: number): string => `Item ${n} · ${items[n - 1]!.kind} ${queryText(items[n - 1]!.query)} (continued)`;
  const body = (r: Row, i: number): string => {
    if (r.kind === "none") return `  ${input.failures.get(r.item) ?? emptyLine(items[r.item - 1]!, r)}`;
    if (r.kind === "also") return input.expansions.map((x) => `Also searched: ${quoted(x.long)} for ${queryText(x.short)} (item ${x.item})`).join("\n");
    const [first = "", ...more] = recordLines(docs.get(`${r.kind}:${r.id}`)!);
    const lead = `  ${numbers[i]}. ${r.best ? `★ best match (${r.label}) — ` : ""}`;
    return [`${lead}${first}${r.best ? "" : ` (${r.label})`}`, ...more.map((line) => RECORD_INDENT + line.trimStart())].join("\n");
  };
  const pageItems = page.items.map((r, j): PageItem => {
    const i = start + j;
    const lines: string[] = [];
    if (r.kind !== "also") {
      const firstOfItem = !rows.slice(0, i).some((o) => o.item === r.item);
      if (i === start && start > 0 && !firstOfItem) lines.push(continued(r.item));
      if (firstOfItem) lines.push(header(r.item), ...(heads[r.item - 1]?.notes ?? []).map((note) => `  ${note}`));
    }
    lines.push(body(r, i));
    return { text: lines.join("\n"), ...(r.kind !== "also" && { header: continued(r.item) }), ...(j === 0 && input.from !== undefined && { from: input.from }) };
  });

  const k = items.length;
  const request = [`items 1–${k}`, setting(input.echo, "limit", input.limit)];
  if (input.afOnly) {
    request.push(setting(input.echo, "af_only", true));
    if (items.some((it) => it.kind === "tag")) request.push("af_only does not apply to tag items");
    // ¶3.5: collections and books have no AF status and are never removed.
    if (items.some((it) => it.kind === "sequence")) request.push("af_only does not apply to collections and books");
  }
  const anyCandidate = page.items.some((r) => r.kind !== "none" && r.kind !== "also");
  const notes = [...(anyCandidate ? [CAVEAT["C-COUNTER"], CAVEAT["C-KARMA"]] : []), ...(page.driftNote === undefined ? [] : [page.driftNote])];

  const nextFor = (j: number): string => {
    const r = page.items[j]!;
    const i = start + j;
    if (r.kind === "also") return `the "Also searched" lines`;
    if (r.kind === "none") return `item ${r.item}`;
    return `item ${r.item}, ${nextText("candidates", numbers[i]!, last.get(r.item)!)}`;
  };
  const footerFor = (c: Consumed): Footer => {
    if (c.sliceTo === undefined && c.items >= page.items.length) return { kind: "end" };
    const state = c.items > 0 ? (page.after[c.items - 1] as ListState) : startState;
    const data: FindData = { cands: rows, heads: [...heads], ...(c.sliceTo !== undefined && { from: c.sliceTo }) };
    const cursor = mint(svc, "find", input.args, input.effective, { streams: [state], current: 0, data: data as unknown as Record<string, unknown> });
    return { kind: "more", tool: "find", cursor, next: nextFor(c.items) };
  };
  return reply(
    { tool: "find", subject: `${k} item${k === 1 ? "" : "s"}`, request, notes, head: [], items: pageItems },
    maxTokens, svc, footerFor,
  );
}

// the tool

const schema = z.strictObject({
  items: P.items().optional(),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<FindParams> = {
  name: "find",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["items"],
  run(p, ctx, svc) {
    const entry = openContinuation("find", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
