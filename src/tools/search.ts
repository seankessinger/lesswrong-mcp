// Layer 2. The `search` tool (¶4.2): full-text search of one index, with structured filters instead of query syntax and every
// hit re-read live. Before any request the call is checked in a fixed order (a query with nothing left to search, the sort per
// kind, the facet table, the query-or-filter rule, the phrase rules of ¶3.2.1, dates). Step 1 resolves `user`, `tag` and `post`
// in at most one request (a hidden post fails here, so no hit on it is ever shown, P1). A round is then one search POST of
// consecutive pages at the index's page size (within the 4 MB estimate and the 10,000-result depth) and one hydrate: every hit
// is checked here against every phrase on its own text (step 6; people after the hydrate, on the fields their record carries),
// its forum fields are reduced to a snippet at once (Q41), and the hydrated record decides what is shown (steps 8–9: P7, P13,
// P16, P18 and the D1 visibility rules).
// A second round runs only while hits are missing, more exist and a request may start. Paging is a `search` stream: the page
// number and the index inside it; a continuation runs again from there, its raw search answers usually cached.
import { z } from "zod";
import { CONFIG } from "../config";
import { toCommentRecord } from "../domain/comments";
import { toPostRecord } from "../domain/posts";
import { toSequenceRecord } from "../domain/sequences";
import { toTagRecord } from "../domain/tags";
import { toUserRecord } from "../domain/users";
import { commentPublic, postPublic, sequenceListable, tagPublic, userPublic } from "../domain/visibility";
import { badInput, CallStopped, internalError } from "../errors";
import { buildSearch, buildText, estimateBytes } from "../forum/search";
import { searchAlias, searchHydrateOps } from "../forum/templates/search";
import { isEntityId } from "../ids/parse";
import { echoOf } from "../ids/resolve";
import { searchPageAllowed } from "../paging/pager";
import { CONVENTIONS_LINE, P, searchSorts } from "../params/vocabulary";
import { CAVEAT, emptyText, END_SEARCH_DEPTH, FLAG, fmtInt, SHORT_PAGE_NOTE } from "../render/messages";
import { commentBlock, personText, postLine, sequenceLine, snippetText, tagCard, userCard } from "../render/records";
import { effectiveDate, parseRange } from "../text/dates";
import { classify, contains, normalizeText, queryTermsIn, sanitizeQuery } from "../text/phrases";
import { oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, ClassifiedPhrase, Consumed, CursorEntry, DateRange, Facet, Footer, KindValue, PageItem, RawCommentList,
  RawPostCard, RawSeqCard, RawTagCard, RawUserCard, SearchHit, SearchIndex, SearchResult, SearchSort, SearchSpec, Services,
  SortValue, StreamState, ToolDef, ToolOutput,
} from "../types";
import {
  checkContinuation, dateEchoes, FILTER_PARAMS, type FilterParam, type Filters, givenArgs, isRecord, mint, nextText, openContinuation, periodText, positionText, reply,
  resolveFilters, setting, tagFilterText, tagIdOf,
} from "./common";
import { aliasData } from "./loaders";

type SearchParams = {
  kind: KindValue; query?: string; phrases?: string[]; exclude?: string[]; user?: string; tag?: string; post?: string; af_only: boolean;
  date_from?: string; date_to?: string; sort: SortValue; limit: number; cursor?: string; max_tokens: number;
};

type SearchState = Extract<StreamState, { kind: "search" }>;
/** A hit's place in the result: its 0-based page and its index inside that page. */
interface Pos { page: number; index: number }

const TITLE = "Where is X discussed?";
/** ¶4.2, verbatim. */
const DESCRIPTION_QUOTE =
  "Full-text search of LessWrong and the Alignment Forum (one index for both; AF items are flagged). kind: post (default; titles and text), comment, user (display name, bio, job, organization and the \"how I can help\" texts), tag (wiki pages: name and text, including extra tabs) or sequence. limit counts hits. query words match loosely: with several words most but not all must match (two need only one), word endings match, typos barely, OR and AND are ignored; ranking is relevance weighted by karma, with no recency factor. A person's name in query also matches what they wrote; use user to filter by author. For exact wording use phrases: every phrase must occur in the same item, as exact words with no word endings; for any of several forms (\"mesa optimizer\", \"mesa optimizers\"), search each separately or use query. Hyphens count as spaces. Every hit is checked here for the phrases, and hits that matched only on title, author name or formatting are dropped and counted. The forum loses punctuation inside phrases, so a word with an apostrophe is searched without the part after it and then checked here in its original form (hits with only the other form are labelled), and a phrase with other punctuation inside a word or with accented letters (\"GPT-4.5\", \"R&D\", \"Gödel\") is searched loosely and then checked here exactly; that works with sort relevance only and may miss some uses. With exclude and no phrases, any one of the query words is enough; with phrases, query words only affect ranking; in both cases accented letters in query words are dropped. exclude: single words to leave out (the forum can't exclude a phrase). Filters: user (the primary author only, so coauthored posts are missed; kinds post and comment; for sequences by a person use list_sequences), tag (kind post: tagged posts; kind comment: comments on publicly visible posts with that tag), post (kind comment: comments on one post), af_only (posts, comments and sequences on AF; for kind user, AF members; not for kind tag), date_from/date_to (kinds post and comment). sort: relevance (default); for post and comment also new, old and top (karma as of the search index's last update); for user new and old (account creation) and top (karma); for sequence new and old; tag hits by relevance only (imported pages carry Arbital-era dates). Abbreviations and synonyms are not expanded: search \"LLM\" and \"language model\" separately. Search matches each item's current text only, dated by its original posting date, and leaves out posts with negative karma and retracted comments (first_use checks edit history). Comment results can include the turns of old-style debates, flagged \"debate turn\"; post results include event posts, flagged. Each hit shows its ids, context, author, date, live karma, AF status and snippet; the match count is the forum's loose count, not how many items discuss the topic. Results stop 10,000 deep. query or phrases is required, except that a filter (user, tag, post) with sort new, old or top lists everything matching the filters.";

const SEARCH_TASK = "searching the forum";
const HYDRATE_TASK = "reading the search hits";

/** ¶4.2 "Requests per call": 0–1 resolve, then at most two rounds of one search and one hydrate. */
const MAX_ROUNDS = 2;
/** Q46: under `top` the index's snapshot karma orders the hits, while the karma shown is re-read live. */
const TOP_NOTE = "sort top ranks by karma as of the search index's last update; the karma shown is live, so the order can look slightly off.";
/** ¶4.2 "Errors and empty results": the empty template's hints, in this order. */
const HINT = {
  phrases: "phrase searches are exact (no word endings; try other forms or query)",
  narrow: "af_only and date filters narrow a lot",
  user: "the user filter misses coauthored posts",
} as const;

const INDEX: Readonly<Record<KindValue, SearchIndex>> = { post: "posts", comment: "comments", user: "users", tag: "tags", sequence: "sequences" };
/** The kinds whose index has an author facet and a tag facet (¶4.2 facet table), and the kinds with a posting date (¶3.4). */
const AUTHORED: ReadonlySet<KindValue> = new Set(["post", "comment"]);
const DATED: ReadonlySet<KindValue> = new Set(["post", "comment"]);
/** A filter (`user`, `tag`, `post`) with one of these sorts lists everything matching it, with no query (§5.1). */
const LISTING_SORTS: ReadonlySet<SortValue> = new Set(["new", "old", "top"]);

/**
 * The hit fields a forum snippet may come from, first match first: the item's own text fields only (P7, P13). People never
 * get a forum snippet: theirs is built from the fields their record carries (P13).
 */
const SNIPPET_FIELDS: Readonly<Record<KindValue, readonly string[]>> = {
  post: ["body", "title"], comment: ["body"], user: [], tag: ["description", "name"], sequence: ["plaintextDescription", "title"],
};
/** A local snippet starts this many characters before the first query word or phrase in the text (¶4.2 step 8). */
const SNIPPET_LEAD = 40;
const SNIPPET_CAP = CONFIG.render.caps.snippet;
/** How much of a caller's text an error quotes. */
const QUOTED_CAP = 60;
/** ¶3.2.1 rule 1: a phrase is at most 100 characters; the possessive label quotes the form sent, on one line (the caller's words). */
const PHRASE_CAP = 100;
const ECHO_CAP = 1000;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LOW_SURROGATE = /[\u{DC00}-\u{DFFF}]/u;

// the checks before any request

/** What one search asks for: the call's parameters on a first page, the cursor's on a continuation. */
interface Ask {
  kind: KindValue; query?: string; phrases?: string[]; exclude?: string[]; user?: string; tag?: string; post?: string;
  afOnly: boolean; dateFrom?: string; dateTo?: string; sort: SortValue; limit: number;
}

/** A checked search: what is sent and how the hits are checked. */
interface Plan {
  ask: Ask;
  index: SearchIndex;
  sort: SearchSort;
  cap: number;                     // hitsPerPage: the index's cap (¶7)
  text?: string;                   // the sanitized query, when it kept a letter or digit
  sanitized?: { text: string; removed: string[] };
  phrases: ClassifiedPhrase[];
  exclude: string[];
  anyLoose: boolean;               // a phrase is searched loosely: report `k of the first m hits`
  listing: boolean;                // filter-only listing: an empty query that lists everything matching the filters
  range: DateRange;
}

const askOf = (p: SearchParams): Ask => ({
  kind: p.kind, query: p.query, phrases: p.phrases, exclude: p.exclude, user: p.user, tag: p.tag, post: p.post,
  afOnly: p.af_only, dateFrom: p.date_from, dateTo: p.date_to, sort: p.sort, limit: p.limit,
});

/** ¶3.3, Q25: the sorts each kind refuses, with the reason. */
function checkSort(kind: KindValue, sort: SortValue): void {
  if (searchSorts(kind).includes(sort)) return;
  if (kind === "sequence") throw badInput("sort", `kind sequence can't be sorted by ${sort} (the forum's sequences index has no karma order)`, "Use relevance, new or old.");
  if (kind === "tag") {
    throw badInput("sort", "kind tag is sorted by relevance only (imported pages carry Arbital-era dates, and a page's karma is the likes on the page itself)", "Use relevance.");
  }
  throw internalError("search", `sort ${sort} is not one of kind ${kind}'s`);   // the schema allows only sorts every other kind takes
}

/** ¶4.2 facet table: each refused combination with its reason, in the order user, tag, post, af_only, date_from, date_to. */
function checkFacets(ask: Ask): void {
  const { kind } = ask;
  if (ask.user !== undefined && !AUTHORED.has(kind)) {
    throw badInput("user", `kind ${kind} can't be filtered by author`, kind === "sequence" ? "For a person's sequences use list_sequences {user}." : "Use kind post or comment.");
  }
  if (ask.tag !== undefined && !AUTHORED.has(kind)) throw badInput("tag", `kind ${kind} can't be filtered by tag`, "Use kind post or comment.");
  if (ask.post !== undefined && kind !== "comment") throw badInput("post", "only kind comment can be filtered by post", 'Set kind "comment".');
  if (ask.afOnly && kind === "tag") throw badInput("af_only", "wiki pages have no AF status", "Remove af_only for kind tag.");
  for (const [param, value] of [["date_from", ask.dateFrom], ["date_to", ask.dateTo]] as const) {
    if (value !== undefined && !DATED.has(kind)) throw badInput(param, `kind ${kind} has no posting date to filter`, "Dates filter kinds post and comment only.");
  }
}

/**
 * Every check of ¶4.2 that needs no request, in this order: a query sanitized to nothing, the sort, the facets, no query or
 * phrases, each phrase, a loose phrase's sort, the dates. The first failure is `bad_input`.
 */
function checked(ask: Ask, now: number): Plan {
  const { kind, sort } = ask;
  const sanitized = ask.query === undefined ? undefined : sanitizeQuery(ask.query);
  // A query with no letter or digit left after sanitizing counts as absent (its removals are still echoed).
  const text = sanitized !== undefined && WORD_CHAR.test(sanitized.text) ? sanitized.text : undefined;
  const hasPhrases = (ask.phrases?.length ?? 0) > 0;
  const listing = text === undefined && !hasPhrases && FILTER_PARAMS.some((f) => ask[f] !== undefined) && LISTING_SORTS.has(sort);
  if (ask.query !== undefined && text === undefined && !hasPhrases && !listing) {
    throw badInput("query", `${JSON.stringify(oneLine(ask.query, QUOTED_CAP))} leaves nothing to search for (no letters or digits)`, "Give words to search for, or use phrases.");
  }
  checkSort(kind, sort);
  checkFacets(ask);
  if (text === undefined && !hasPhrases && !listing) {
    throw badInput("query", "give query or phrases", "Or combine a filter (user, tag, post) with sort new, old or top to list everything matching the filters.");
  }
  const phrases = (ask.phrases ?? []).map((x) => classify(x, "phrases"));
  const loose = phrases.find((x) => x.mode === "loose");
  if (loose !== undefined && sort !== "relevance") {
    throw badInput(
      "phrases", `"${loose.given}" has punctuation inside a word or accented letters, which the forum's search deletes, so it is searched loosely`,
      "Loose phrases work only with sort relevance.",
    );
  }
  const range = parseRange(ask.dateFrom, ask.dateTo, now);
  const index = INDEX[kind];
  return {
    ask, index, sort: sort as SearchSort, cap: CONFIG.search.hitsPerPage[index], ...(text !== undefined && { text }),
    ...(sanitized !== undefined && { sanitized }), phrases, exclude: ask.exclude ?? [], anyLoose: loose !== undefined, listing, range,
  };
}

// steps 2–5: the query of one page

function specFor(plan: Plan, f: Filters, page: number): SearchSpec {
  const facets: Facet[] = [];
  if (plan.ask.afOnly) facets.push({ field: "af", value: true });
  if (f.user !== undefined) facets.push({ field: "userId", value: f.user.id });
  if (f.tag !== undefined) facets.push(plan.ask.kind === "post" ? { field: "tags._id", value: tagIdOf(f.tag) } : { field: "tags", value: tagIdOf(f.tag) });
  if (f.post !== undefined) facets.push({ field: "postId.keyword", value: f.post.id });
  const dated = plan.range.start !== undefined || plan.range.endExclusive !== undefined;
  return {
    index: plan.index, sort: plan.sort, ...(plan.text !== undefined && { query: plan.text }), ...(plan.phrases.length > 0 && { phrases: plan.phrases }),
    ...(plan.exclude.length > 0 && { exclude: plan.exclude }), ...(facets.length > 0 && { facets }), ...(dated && { range: plan.range }),
    page, hitsPerPage: plan.cap,
  };
}

/**
 * One round's pages from `at`: `ceil(need / cap)` of them (at least 1), within the search depth and the 4 MB estimate (¶7). A
 * continuation that starts inside a page asks for the same pages as the call before it, so its first POST is usually cached.
 */
function roundSpecs(plan: Plan, f: Filters, at: Pos, need: number): SearchSpec[] {
  const pages = Math.max(1, Math.ceil(need / plan.cap));
  const specs: SearchSpec[] = [];
  for (let page = at.page; page < at.page + pages && searchPageAllowed(page, plan.cap); page++) {
    const spec = specFor(plan, f, page);
    if (specs.length > 0 && estimateBytes(buildSearch([...specs, spec])) > CONFIG.search.maxRequestBytes) break;
    specs.push(spec);
  }
  return specs;
}

// step 6: each hit checked on its own text, then reduced to what is shown

/** One hit after step 6: its forum fields are gone (Q41); only the snippets and the verdicts are kept. */
interface Checked {
  id: string;
  pos: Pos;
  verdict: "ok" | "phrase" | "exclude";   // people are checked after the hydrate, so theirs is always "ok" here
  labels: string[];                       // the phrase-form labels (¶3.2.1 rule 6)
  forumSnippet?: string;
  localSnippet: string;
  ownTerms: boolean;                      // P7: a query word (or every phrase) occurs in the hit's own text
}

const field = (hit: SearchHit, name: string): string => (typeof hit[name] === "string" ? (hit[name] as string) : "");

/** The text step 6 checks: title + body for posts, body for comments, name + description for tags, title + description for sequences. */
function ownText(kind: KindValue, hit: SearchHit): string {
  switch (kind) {
    case "post": return `${field(hit, "title")}\n${field(hit, "body")}`;
    case "comment": return field(hit, "body");
    case "tag": return `${field(hit, "name")}\n${field(hit, "description")}`;
    case "sequence": return `${field(hit, "title")}\n${field(hit, "plaintextDescription")}`;
    case "user": return "";
  }
}

/** ¶3.2.1 rule 6: every phrase must occur; a form found only on the other side of the apostrophe rule is kept and labelled. */
function phraseCheck(text: string, phrases: readonly ClassifiedPhrase[]): { ok: boolean; labels: string[] } {
  const labels: string[] = [];
  for (const phrase of phrases) {
    const found = contains(text, phrase);
    if (found === false) return { ok: false, labels: [] };
    if (found === "without-possessive") labels.push(FLAG.withoutPossessive(oneLine(phrase.sent, PHRASE_CAP)));
    if (found === "with-possessive") labels.push(FLAG.ONLY_WITH_POSSESSIVE);
  }
  return { ok: true, labels: [...new Set(labels)] };
}

/** ¶4.2 step 2: in loose mode `exclude` is applied here, as whole words of the normalized text. */
function excludedIn(text: string, exclude: readonly string[]): boolean {
  const words = new Set(normalizeText(text).split(/[^\p{L}\p{N}]+/u));
  return exclude.some((w) => words.has(w.toLowerCase()));
}

/** The forum's snippet of one of the hit's own text fields, when it sent one. */
function forumSnippetOf(kind: KindValue, hit: SearchHit): string | undefined {
  for (const name of SNIPPET_FIELDS[kind]) {
    const value = hit._snippetResult?.[name]?.value;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** ¶4.2 step 8: up to 300 characters of `text`, starting 40 characters before the first query word or phrase in it. */
function localSnippet(text: string, plan: Plan): string {
  const lower = text.toLowerCase();
  const terms = [...(plan.text?.split(" ") ?? []).filter((w) => WORD_CHAR.test(w)), ...plan.phrases.map((x) => x.given)];
  const found = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  let start = found.length === 0 ? 0 : Math.max(0, Math.min(...found) - SNIPPET_LEAD);
  if (start > 0 && LOW_SURROGATE.test(text[start] ?? "")) start -= 1;   // never cut a surrogate pair
  return oneLine(text.slice(start), SNIPPET_CAP);
}

const hitId = (hit: SearchHit): string | undefined => {
  const id = typeof hit._id === "string" ? hit._id : hit.objectID;
  return isEntityId(id) ? id : undefined;
};

function checkHit(plan: Plan, hit: SearchHit, id: string, pos: Pos, excludeLocally: boolean): Checked {
  const kind = plan.ask.kind;
  if (kind === "user") return { id, pos, verdict: "ok", labels: [], localSnippet: "", ownTerms: true };
  const own = ownText(kind, hit);
  const { ok, labels } = phraseCheck(own, plan.phrases);
  const verdict = !ok ? "phrase" : excludeLocally && excludedIn(own, plan.exclude) ? "exclude" : "ok";
  const ownTerms = plan.phrases.length > 0 || plan.text === undefined || queryTermsIn(own, plan.text);
  const forumSnippet = forumSnippetOf(kind, hit);
  return { id, pos, verdict, labels, ...(forumSnippet !== undefined && { forumSnippet }), localSnippet: localSnippet(own, plan), ownTerms };
}

// steps 7–9: the hydrate and the privacy checks

/** A hydrated alias; a refused or missing hit reads as no document. */
function hydrated(results: AliasResults, alias: string, ctx: CallContext): unknown {
  const r = results.get(alias);
  if (r !== undefined && "error" in r && r.error === "login_only") return undefined;
  return aliasData(results, alias, HYDRATE_TASK, ctx);
}

/** Step 7's documents by id, whatever order the forum answered in (R10). */
function docsOf(kind: KindValue, ids: readonly string[], results: AliasResults, ctx: CallContext): Map<string, Record<string, unknown>> {
  const docs = new Map<string, Record<string, unknown>>();
  const keep = (doc: unknown): void => {
    if (isRecord(doc) && typeof doc._id === "string") docs.set(doc._id, doc);
  };
  const rows = (alias: string): void => {
    const data = hydrated(results, alias, ctx);
    if (isRecord(data) && Array.isArray(data.results)) data.results.forEach(keep);
  };
  const single = (alias: string): void => {
    const data = hydrated(results, alias, ctx);
    if (isRecord(data)) keep(data.result);
  };
  const unique = [...new Set(ids)];
  switch (kind) {
    case "post": rows(searchAlias.post); break;
    case "user": rows(searchAlias.user); break;
    case "sequence": rows(searchAlias.sequence); break;
    case "comment": unique.forEach((_, k) => single(searchAlias.comment(k))); break;
    case "tag": unique.forEach((_, k) => single(searchAlias.tag(k))); break;
  }
  return docs;
}

/** A record, its snippet line and its phrase-form label line. */
function withSnippet(record: string, snippet: string, labels: readonly string[]): string {
  const lines = [record];
  const text = oneLine(snippet, SNIPPET_CAP);
  if (text !== "") lines.push(`  ${snippetText(text)}`);
  if (labels.length > 0) lines.push(`  ${labels.join(" · ")}`);
  return lines.join("\n");
}

/** P13: the fields a person's hit is checked on and snippeted from. */
function userFields(u: RawUserCard): string {
  return [u.displayName, u.biography?.plaintextDescription, u.jobTitle, u.organization, u.howOthersCanHelpMe?.markdown, u.howICanHelpOthers?.markdown]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .join("\n");
}

/**
 * What one walked hit adds to the page: its text when shown, whether it holds every phrase and whether step 6 dropped it
 * (the dropped line counts it).
 */
interface Judged { text?: string; contained: boolean; phraseDrop?: true }

/** Steps 8–9 on a post, comment, tag or sequence hit that passed step 6: undefined when it is not shown. */
function shownText(plan: Plan, f: Filters, h: Checked, doc: Record<string, unknown> | undefined): string | undefined {
  const afOnly = plan.ask.afOnly;
  const anonymous = (d: { hideAuthor: boolean }): boolean => d.hideAuthor;
  switch (plan.ask.kind) {
    case "post": {
      const d = doc as RawPostCard | undefined;
      if (!postPublic(d) || (afOnly && !d.af)) return undefined;
      // P7: an anonymous post is kept only on its own terms, with a local snippet.
      if (anonymous(d) && (f.user !== undefined || !h.ownTerms)) return undefined;
      return withSnippet(postLine(toPostRecord(d)), anonymous(d) ? h.localSnippet : h.forumSnippet ?? h.localSnippet, h.labels);
    }
    case "comment": {
      const d = doc as RawCommentList | undefined;
      if (!commentPublic(d) || (afOnly && !d.af)) return undefined;
      const rec = toCommentRecord(d);
      const place = rec.place?.kind;
      // ¶4.2 step 8, P16: under a tag filter only comments on publicly visible posts are kept. A hit whose hydrated post is
      // null or hidden is dropped, wiki-discussion comments included.
      if (f.tag !== undefined && place !== "post" && place !== "quick take") return undefined;
      // P18: under top, comments with hidden karma are left out.
      if (plan.sort === "top" && (rec.karmaHidden || rec.karma === null)) return undefined;
      if (anonymous(d) && (f.user !== undefined || !h.ownTerms)) return undefined;
      const snippet = rec.placeholder !== undefined ? "" : anonymous(d) ? h.localSnippet : h.forumSnippet ?? h.localSnippet;
      return withSnippet(commentBlock({ ...rec, body: undefined }, { form: "list" }), snippet, h.labels);
    }
    case "tag": {
      const d = doc as RawTagCard | undefined;
      if (!tagPublic(d)) return undefined;
      return withSnippet(tagCard(toTagRecord(d)), h.forumSnippet ?? h.localSnippet, h.labels);
    }
    case "sequence": {
      const d = doc as RawSeqCard | undefined;
      if (d === undefined || !sequenceListable(d) || (afOnly && !d.af)) return undefined;
      return withSnippet(sequenceLine(toSequenceRecord(d)), h.forumSnippet ?? h.localSnippet, h.labels);
    }
    case "user":
      throw internalError("search", "a user hit reached the post rules");
  }
}

/**
 * Step 6 for people (on their hydrated fields): a person who fails a phrase is a step-6 failure like any other kind's, and in
 * loose mode `exclude` is applied here (¶4.2 step 2). Then P13: with query words only, a hit whose words occur in none of the
 * fields this server reads is dropped.
 */
function judgeUser(plan: Plan, doc: Record<string, unknown> | undefined, excludeLocally: boolean): Judged {
  const d = doc as RawUserCard | undefined;
  if (!userPublic(d) || d === undefined) return { contained: false };
  if (plan.ask.afOnly && !(d.groups ?? []).includes(CONFIG.afGroup)) return { contained: false };
  const fields = userFields(d);
  const { ok, labels } = phraseCheck(fields, plan.phrases);
  if (plan.phrases.length > 0) {
    if (!ok) return { contained: false, phraseDrop: true };
  } else if (!(plan.text !== undefined && queryTermsIn(fields, plan.text))) {
    return { contained: true };
  }
  if (excludeLocally && excludedIn(fields, plan.exclude)) return { contained: true };
  return { contained: true, text: withSnippet(userCard(toUserRecord(d)), localSnippet(fields, plan), labels) };
}

function judge(plan: Plan, f: Filters, h: Checked, doc: Record<string, unknown> | undefined, excludeLocally: boolean): Judged {
  if (plan.ask.kind === "user") return judgeUser(plan, doc, excludeLocally);
  if (h.verdict === "phrase") return { contained: false, phraseDrop: true };
  if (h.verdict === "exclude") return { contained: true };
  const text = shownText(plan, f, h, doc);
  return { contained: true, ...(text !== undefined && { text }) };
}

// the rounds

interface Item { text: string; pos: Pos }

/** What the rounds of one call collected and where the next page starts. */
interface Outcome {
  items: Item[];
  nbHits: number;                   // the first page's loose count
  checked: number;                  // hits walked
  contained: number;                // of them, those holding every phrase (loose mode's `k`)
  phraseDrops: number;              // dropped by the phrase check (exact mode's dropped line)
  resume?: Pos;                     // where the next page starts; undefined when nothing is left
  stopped: boolean;                 // a request could not start (time limit or request cap)
  depth: boolean;                   // the end is the forum's search depth, not the end of the results
}

async function collect(plan: Plan, f: Filters, start: Pos, ctx: CallContext, svc: Services): Promise<Outcome> {
  const o: Outcome = { items: [], nbHits: 0, checked: 0, contained: 0, phraseDrops: 0, stopped: false, depth: false };
  const { kind, limit } = plan.ask;
  const excludeLocally = buildText(specFor(plan, f, 0)).excludeLocally;
  const seen = new Set<string>();
  let at: Pos | undefined = start;
  for (let round = 0; round < MAX_ROUNDS && at !== undefined && o.items.length < limit; round++) {
    const from: Pos = at;
    const specs = roundSpecs(plan, f, from, limit - o.items.length);
    if (specs.length === 0) {
      o.depth = true;
      at = undefined;
      break;
    }
    if (round > 0 && !ctx.mayStartRequest()) {
      o.stopped = true;
      break;
    }
    let results: SearchResult[];
    try {
      results = await svc.search(buildSearch(specs), ctx, SEARCH_TASK, plan.listing ? "default" : "empty");
    } catch (e) {
      if (round > 0 && e instanceof CallStopped) {
        o.stopped = true;
        break;
      }
      throw e;
    }
    if (round === 0) o.nbHits = results[0]?.nbHits ?? 0;

    // The round's hits from `from` on, and where the results continue after its last page.
    const hits: Checked[] = [];
    let next: Pos | undefined;
    let depth = false;
    for (const [j, r] of results.entries()) {
      const page = specs[j]!.page;
      if (r.ended) {
        depth = true;   // the forum's depth error ends every query of the body (Q23)
        next = undefined;
        break;
      }
      r.hits.forEach((hit, index) => {
        const id = hitId(hit);
        if (id === undefined || (page === from.page && index < from.index)) return;
        hits.push(checkHit(plan, hit, id, { page, index }, excludeLocally));
      });
      next = (page + 1) * plan.cap < r.nbHits ? { page: page + 1, index: 0 } : undefined;
    }
    if (next !== undefined && !searchPageAllowed(next.page, plan.cap)) {
      depth = true;
      next = undefined;
    }

    // Step 7, then the walk in hit order, stopping at the limit.
    const ids = [...new Set(hits.filter((h) => h.verdict === "ok" && !seen.has(h.id)).map((h) => h.id))];
    let docs = new Map<string, Record<string, unknown>>();
    if (ids.length > 0) {
      try {
        docs = docsOf(kind, ids, await svc.gql(searchHydrateOps(kind, ids), ctx, HYDRATE_TASK), ctx);
      } catch (e) {
        // ¶2.2 step 5: the first round's hydrate is mandatory (nothing is printed from a hit alone), so its refusal at the 40 s
        // mark is the call's timeout; a later round's ends the page early with what the earlier rounds gave.
        if (!(e instanceof CallStopped) || round === 0) throw e;
        o.stopped = true;
        o.resume = from;
        return o;
      }
    }
    for (const h of hits) {
      if (o.items.length >= limit) {
        o.resume = h.pos;
        return o;
      }
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      o.checked += 1;
      const j = judge(plan, f, h, docs.get(h.id), excludeLocally);
      if (j.contained) o.contained += 1;
      if (j.phraseDrop) o.phraseDrops += 1;
      if (j.text !== undefined) o.items.push({ text: j.text, pos: h.pos });
    }
    o.depth = depth;
    at = next;
  }
  if (at !== undefined) o.resume = at;
  return o;
}

// the page

interface PageInput {
  plan: Plan;
  filters: Filters;
  state: SearchState;               // where this page started
  from?: number;
  echo: CallContext;                // its `given` decides the request echo's `(default)` marks
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

const next1 = (pos: Pos, cap: number): Pos => (pos.index + 1 < cap ? { page: pos.page, index: pos.index + 1 } : { page: pos.page + 1, index: 0 });

/** ¶4.2 output layout: the request echo, in order. */
function requestEcho(input: PageInput): string[] {
  const { plan, filters, echo } = input;
  const { ask } = plan;
  const request = [setting(echo, "kind", ask.kind)];
  const sanitizedChanged = plan.sanitized !== undefined && (plan.sanitized.removed.length > 0 || plan.sanitized.text !== ask.query);
  const sent = buildText(specFor(plan, filters, 0)).text;
  // A filter listing whose query sanitized to nothing sends an empty text; its removals are still said on the next line.
  if ((plan.phrases.length > 0 || plan.exclude.length > 0 || sanitizedChanged) && sent !== "") request.push(`searched as: ${oneLine(sent, ECHO_CAP)}`);
  if (plan.sanitized !== undefined && plan.sanitized.removed.length > 0) request.push(`query: removed ${oneLine(plan.sanitized.removed.join(", "), ECHO_CAP)}`);
  request.push(...filterEchoes(input), setting(echo, "sort", ask.sort), setting(echo, "limit", ask.limit));
  return request;
}

/** The resolved filters, `af_only` and the dates (the period in UTC, as every tool echoes it) as the echo and the empty template name them. */
function filterEchoes(input: PageInput): string[] {
  const { plan, filters } = input;
  const out = FILTER_PARAMS.flatMap((param) => {
    const r = filters[param];
    return r === undefined ? [] : [echoOf(param, r)];
  });
  if (plan.ask.afOnly) out.push(setting(input.echo, "af_only", true));
  out.push(...dateEchoes(plan.range));
  return out;
}

/** ¶3.9 the filtered-list template: the text as sent, the filters restated by name (not in the echo's arrow form), and at most two hints. */
function emptyLine(input: PageInput): string {
  const { plan, filters } = input;
  const sent = buildText(specFor(plan, filters, 0)).text;
  const hints = [
    ...(plan.phrases.length > 0 ? [HINT.phrases] : []),
    ...(plan.ask.afOnly || plan.ask.dateFrom !== undefined || plan.ask.dateTo !== undefined ? [HINT.narrow] : []),
    ...(filters.user !== undefined ? [HINT.user] : []),
  ];
  const u = filters.user;
  const period = periodText(plan.range);
  const named = [
    ...(sent === "" ? [] : [oneLine(sent, ECHO_CAP)]),
    ...(u === undefined ? [] : [`by ${personText({ kind: "user", id: u.id, slug: u.slug ?? null, name: u.name })}`]),
    ...(filters.tag === undefined ? [] : [`tagged ${tagFilterText(filters.tag)}`]),
    ...(filters.post === undefined ? [] : [`on "${filters.post.name}" (post_id ${filters.post.id})`]),
    ...(plan.ask.afOnly ? ["AF only"] : []),
    ...(period === undefined ? [] : [period]),
  ];
  return emptyText({ kind: "filtered", items: `${plan.ask.kind} hits`, filters: named.join(", "), suggestions: hints });
}

function subjectOf(plan: Plan): string {
  if (plan.listing) return `${plan.ask.kind} hits (filters only)`;
  const asked = [...(plan.text !== undefined && plan.ask.query !== undefined ? [plan.ask.query] : []), ...plan.phrases.map((x) => x.given)];
  return `${plan.ask.kind} hits for "${oneLine(asked.join(", "), CONFIG.render.caps.title)}"`;
}

async function searchPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { plan, filters, state } = input;
  const { kind, limit } = plan.ask;
  const o = await collect(plan, filters, { page: state.page, index: state.index }, ctx, svc);
  const shown0 = state.shown;
  // A cursor that would start past the search depth is the depth's end instead.
  const resume = o.resume !== undefined && searchPageAllowed(o.resume.page, plan.cap) ? o.resume : undefined;
  const depth = o.depth || (o.resume !== undefined && resume === undefined);
  const items = o.items;

  const notes = [CAVEAT["C-SEARCH"]];
  if (filters.user !== undefined) notes.push(CAVEAT["C-COAUTHOR-SEARCH"]);
  if (plan.sort === "top") notes.push(TOP_NOTE);
  if (kind === "comment" && plan.sort === "top") notes.push(CAVEAT["C-HIDDEN-KARMA-ORDER"]);

  const head: string[] = [];
  // Step 10: no count under these filters (P7, P16).
  const countHidden = filters.user !== undefined || (kind === "comment" && filters.tag !== undefined);
  if (o.nbHits > 0 && !countHidden) head.push(FLAG.looseCount(o.nbHits));
  if (plan.anyLoose && o.checked > 0) head.push(`${fmtInt(o.contained)} of the first ${fmtInt(o.checked)} hits contain the exact phrase`);
  if (!plan.anyLoose && o.phraseDrops > 0) {
    const n = o.phraseDrops;
    head.push(`${fmtInt(n)} hit${n === 1 ? "" : "s"} matched only on the title, author name or formatting and ${n === 1 ? "was" : "were"} dropped`);
  }
  if (items.length === 0) {
    if (resume !== undefined) {
      if (o.checked > 0) head.push(emptyText({ kind: "scan", checked: o.checked }));
    } else if (shown0 === 0) {
      head.push(emptyLine(input));
    }
  } else if (items.length < limit && resume !== undefined && !o.stopped) {
    head.push(SHORT_PAGE_NOTE);
  }

  const pageItems: PageItem[] = items.map((it, j) => ({ text: it.text, ...(j === 0 && input.from !== undefined && { from: input.from }) }));
  const position = items.length === 0 ? undefined : (c: Consumed): string =>
    positionText("hits", shown0 + 1, shown0 + Math.max(1, Math.min(c.items, items.length) + (c.sliceTo === undefined ? 0 : 1)));

  const footerFor = (c: Consumed): Footer => {
    const n = Math.min(c.items, items.length);
    const cursorAt = (pos: Pos, from?: number): string => {
      const next: SearchState = { kind: "search", shown: shown0 + n, page: pos.page, index: pos.index };
      return mint(svc, "search", input.args, input.effective, { streams: [next], current: 0, ...(from !== undefined && { data: { from } }) });
    };
    const more = (cursor: string): Footer => ({ kind: "more", tool: "search", cursor, next: nextText("hits", shown0 + n + 1, shown0 + n + limit) });
    if (c.sliceTo !== undefined && n < items.length) return more(cursorAt(items[n]!.pos, c.sliceTo));
    if (n < items.length) return more(cursorAt(n === 0 ? items[0]!.pos : next1(items[n - 1]!.pos, plan.cap)));
    if (resume === undefined) return depth ? { kind: "reachable", reason: END_SEARCH_DEPTH } : { kind: "end" };
    if (o.stopped) return { kind: "stopped", why: ctx.stopped ?? "time limit", tool: "search", cursor: cursorAt(resume) };
    return more(cursorAt(resume));
  };

  // ¶3.7: the position line is left out only when the page is the whole result (one hit of a longer list keeps it).
  const oneItem = shown0 === 0 && items.length === 1 && resume === undefined && !depth && !o.stopped;
  return reply(
    { tool: "search", subject: subjectOf(plan), request: requestEcho(input), ...(position !== undefined && { position }), oneItem, notes, head, items: pageItems },
    maxTokens, svc, footerFor,
  );
}

// first page and continuation

/** ¶3.6: the effective values a cursor compares: defaults applied, filters as resolved ids, dates as instants. */
function searchEffective(ask: Ask, f: Filters): Record<string, unknown> {
  return {
    kind: ask.kind, query: ask.query, phrases: ask.phrases, exclude: ask.exclude, user: f.user?.id,
    tag: f.tag === undefined ? undefined : tagIdOf(f.tag), post: f.post?.id, af_only: ask.afOnly,
    date_from: effectiveDate(ask.dateFrom, "from"), date_to: effectiveDate(ask.dateTo, "to"), sort: ask.sort, limit: ask.limit,
  };
}

const filterInputs = (ask: Ask): Partial<Record<FilterParam, string>> => ({ user: ask.user, tag: ask.tag, post: ask.post });

async function firstPage(p: SearchParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const ask = askOf(p);
  const plan = checked(ask, ctx.now());
  const filters = await resolveFilters(filterInputs(ask), ctx, svc);
  const args = givenArgs(p, ctx);
  return searchPage(
    { plan, filters, state: { kind: "search", shown: 0, page: 0, index: 0 }, echo: ctx, args, effective: searchEffective(ask, filters) },
    p.max_tokens, ctx, svc,
  );
}

/** The search a cursor continues: its stored values, with the filters and dates as the first call gave them (to resolve again). */
function storedAsk(entry: CursorEntry): Ask {
  const e = entry.effective as { kind: KindValue; query?: string; phrases?: string[]; exclude?: string[]; af_only: boolean; sort: SortValue; limit: number };
  const a = entry.args as Partial<SearchParams>;
  return {
    kind: e.kind, query: e.query, phrases: e.phrases, exclude: e.exclude, user: a.user, tag: a.tag, post: a.post,
    afOnly: e.af_only, dateFrom: a.date_from, dateTo: a.date_to, sort: e.sort, limit: e.limit,
  };
}

async function continuation(entry: CursorEntry, p: SearchParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: parameters given again are checked and resolved first, so a slug equals the id it resolves to.
  if (ctx.given.has("date_from") || ctx.given.has("date_to")) parseRange(p.date_from, p.date_to, ctx.now());
  const given = askOf(p);
  const givenFilters = await resolveFilters(
    Object.fromEntries(FILTER_PARAMS.filter((f) => ctx.given.has(f)).map((f) => [f, given[f]])) as Partial<Record<FilterParam, string>>, ctx, svc,
  );
  checkContinuation(entry, searchEffective(given, givenFilters), ctx);
  const ask = storedAsk(entry);
  const plan = checked(ask, ctx.now());
  // D1 on every continuation: the filters are resolved again (from the cache, or with one request).
  const filters = await resolveFilters(filterInputs(ask), ctx, svc);
  const state = entry.state.streams[entry.state.current] as SearchState;
  const from = isRecord(entry.state.data) && typeof entry.state.data.from === "number" ? entry.state.data.from : undefined;
  return searchPage(
    {
      plan, filters, state, ...(from !== undefined && { from }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  kind: P.kind(["post", "comment", "user", "tag", "sequence"], "post"),
  query: P.query().optional(),
  phrases: P.phrases().optional(),
  exclude: P.exclude().optional(),
  user: P.user().optional(),
  tag: P.tag().optional(),
  post: P.post().optional(),
  af_only: P.flag("af_only"),
  date_from: P.dateFrom().optional(),
  date_to: P.dateTo().optional(),
  sort: P.sort("search"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<SearchParams> = {
  name: "search",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  run(p, ctx, svc) {
    const entry = openContinuation("search", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
