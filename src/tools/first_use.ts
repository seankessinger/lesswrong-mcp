// Layer 2. The `first_use` tool (¶4.12): the measured recipe of §7.7 as one call. Step 1 refuses a loose form (accented letters
// or punctuation inside a word) with the ASCII spelling to try, offered only when it can be traced itself. Step 2 is one search
// POST of `posts_oldest_first` and, with `include_comments`, `comments_oldest_first` per form, each query quoted, with the
// per-index page sizes and the `af` facet; the next page of the queries that had more is read only while the candidates run
// out, at most `SEARCH_PAGES` pages per form (step 2's second POST). Step 3 checks each hit on its own text (rule 6, with the
// apostrophe needle): a use of any form makes it a candidate, only the other apostrophe form sets it aside, anything else is a
// rejected hit with its reason. Search fields are read only for that check and never printed (P16, P7). Candidates are each
// search page's hits in date order, pages one after the other, so that a page read later never reorders the candidates already
// shown; `limit` of them make a page (a `list` stream) and the first `min(limit, 10)` are checked.
// Request 1 hydrates the page's candidates and the earlier-dated rejected hits (the visibility check, P1, P2, P5, P6, P17);
// request 2 reads the history lists of the checked candidates that passed it; request 3 the as-published texts, ids taken from
// those lists only; up to 2 rounds of `findIntroduction` re-date the 2 earliest candidates whose phrase came with a later edit.
// The page re-ranks its candidates by effective date and names the earliest verified one. A part that fails after the hydrate is a
// `Partial:` line and leaves its candidates without a verdict; a deadline stop after the hydrate lists them unchecked and
// continues with a cursor that checks the same page again (¶2.2 step 5). No editor is ever printed (P7).
import { z } from "zod";
import { CONFIG } from "../config";
import { toCommentRecord } from "../domain/comments";
import { toPostRecord } from "../domain/posts";
import { allListed, findIntroduction, toRevisionRecord, type IntroSeries } from "../domain/revisions";
import { commentPublic, isPlaceholder, postListable } from "../domain/visibility";
import { badInput, CallStopped, internalError, isToolError, ToolError } from "../errors";
import { buildSearch } from "../forum/search";
import { AS_PUBLISHED_LIMIT, firstUseHistoryOps, firstUseHydrateOps } from "../forum/templates/first_use";
import { revisionTextOp } from "../forum/templates/shared";
import { isEntityId } from "../ids/parse";
import { fingerprint, listPage } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { fitsWhole } from "../render/layout";
import { CAVEAT, driftNote, emptyText, FLAG, fmtInt, partialLine } from "../render/messages";
import { personText, placeText } from "../render/records";
import { day } from "../text/dates";
import { asciiSuggestion, classify, contains } from "../text/phrases";
import { oneLine } from "../text/sanitize";
import type {
  AliasResult, AliasResults, CallContext, ClassifiedPhrase, CursorEntry, Facet, Footer, PageItem, PageSpec, PublicDocId, RawCommentList,
  RawPostCard, RawRevRow, RevisionDoc, RevisionRecord, SearchHit, SearchResult, SearchSpec, Services, StopReason, StreamState, ToolDef,
  ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, nextText, openContinuation, positionText, reply, rowsOf, setting } from "./common";
import { aliasData } from "./loaders";

type FirstUseParams = {
  forms?: string[]; include_comments: boolean; af_only: boolean; limit: number; cursor?: string; max_tokens: number;
};

type ListState = Extract<StreamState, { kind: "list" }>;
type Kind = "post" | "comment";

const TITLE = "Who first used this phrase, and was it original?";
/** ¶4.12, verbatim. */
const DESCRIPTION_QUOTE = "Who first used a phrase on LessWrong or the Alignment Forum, and was it in the original text? forms: the phrase and up to 4 other forms of it (word endings are not matched, so give \"mesa optimizers\" and \"mesa optimization\" yourself; hyphens count as spaces); a use of any form counts. Searches posts (and comments, unless include_comments=false) oldest first for each form, keeps only hits whose text really contains it, then checks the edit history of the earliest candidates: was the phrase in the text as published, or added by a later edit, and when? limit counts candidates per page; the history of at most 10 candidates is checked per call, and any others on the page are listed as \"not checked yet\" (continue with the cursor to check them). Returns the earliest verified use, the other candidates with dates and authors, and why earlier-looking hits were ruled out. The answer means \"the earliest public use that could be verified\", not a guaranteed first use. Search matches each item's current text only, dated by its original posting date, and leaves out posts with negative karma and retracted comments; so a phrase first used in a comment later retracted is missed. Texts from before 13 February 2019 exist only as a 2019 snapshot, so presence at publication can't be confirmed for them. The pre-2009 archive holds only Eliezer Yudkowsky's Overcoming Bias posts, 5 old essays carry placeholder 1 January dates, and a post's date can be later than its first public appearance. A form with an apostrophe is searched without the part after the apostrophe and checked in its original form (uses of the other form are reported separately). Forms with accented letters or punctuation inside a word (\"Gödel\", \"GPT-4.5\") can't be traced in date order and are refused; writers often use ASCII spellings (\"Godel\", \"Lob's theorem\"), which can be given as forms. af_only searches AF items only.";

const SEARCH_TASK = "searching for the earliest uses";
const HYDRATE_TASK = "reading the candidates";
const HISTORY_TASK = "reading the edit histories";
const TEXT_TASK = "reading the published texts";
const PROBE_TASK = "finding the edits that added the phrase";

/**
 * ¶4.12 step 2: the search reads at most this many pages of each query (the second POST only when the candidates run out), over
 * a whole cursor chain, so a call sends at most 2 search POSTs. Past them the list ends `End of reachable results` (an accepted
 * narrowing of ¶4.12 Paging's "search pages continue when they run out": deeper pages would need the cursor to carry the
 * candidates and search positions).
 */
const SEARCH_PAGES = 2;
/** ¶4.12 step 4: the history of at most this many candidates is checked per call. */
const CHECKED_MAX = 10;
/** ¶4.12 step 5: at most this many earlier-dated rejected hits are hydrated, so that they can be named. */
const REJECTED_HYDRATED = 10;
/** ¶4.12 step 8: `findIntroduction` re-dates this many candidates, in at most this many rounds of this many probes. */
const REDATED_MAX = 2;
const PROBE_ROUNDS = 2;
const PROBES = 10;

const SEP = " · ";
const TITLE_CAP = CONFIG.render.caps.title;
/** A version string is the forum's; it is printed on one line, at most this long. */
const VERSION_CAP = 40;
const POST_HITS = CONFIG.search.hitsPerPage.posts;
const COMMENT_HITS = CONFIG.search.hitsPerPage.comments;

/** ¶4.12 step 1. */
const LOOSE = "contains accented letters or punctuation inside a word, which the forum's exact-phrase search deletes, so it can't be traced in date order";
const TRY_ASCII = "Try ASCII spellings writers also use, as further forms";
/** ¶4.12 step 3: why a hit that matched the search is not a use. */
type Reason = "only in the title" | "words present but not as the phrase";
/** ¶4.12 step 8: the verdicts that need no argument. */
const IN_SNAPSHOT = "in the oldest kept text (a February-2019 snapshot); original wording not recorded";
const AT_PUBLICATION = "present at publication";
const NOT_AVAILABLE = "published text not available";
const NO_HISTORY = "not checked (its edit history is unavailable)";
const NO_TEXT = "not checked (its published text is unavailable)";
const NOT_YET = "not checked yet";
/** The `Partial:` sections. */
const PARTIAL = { search: "further search pages", history: "edit history", texts: "published texts", probes: "edit probes" } as const;
const NONE_VERIFIED = "No candidate checked on this page could be verified.";
/** The verdicts of a candidate whose check did not happen or did not finish. */
const NOT_CHECKED: ReadonlySet<Verdict["kind"]> = new Set(["unchecked", "no history", "no text"]);

const quoted = (s: string): string => `"${oneLine(s, TITLE_CAP)}"`;
const afWord = (af: boolean): string => (af ? FLAG.AF : FLAG.LW_ONLY);
const plural = (n: number, one: string): string => `${fmtInt(n)} ${one}${n === 1 ? "" : "s"}`;

// step 1: the forms

/** Whether `form` could be traced itself: it classifies, and not as a loose phrase. */
function traceable(form: string): boolean {
  try {
    return classify(form, "forms").mode !== "loose";
  } catch (e) {
    if (isToolError(e)) return false;
    throw e;
  }
}

/** ¶4.12 step 1, Q29: a loose form, with the ASCII spelling to try when that spelling can be traced. */
function looseRefusal(form: ClassifiedPhrase): ToolError {
  const ascii = asciiSuggestion(form.given);
  return badInput("forms", `${JSON.stringify(form.given)} ${LOOSE}`, traceable(ascii) ? `${TRY_ASCII}: ${JSON.stringify(ascii)}.` : `${TRY_ASCII}.`);
}

/** The forms classified (¶3.2.1), in order, a repeated one (the same needle) once; the first loose one is refused. */
function formsOf(forms: readonly string[]): ClassifiedPhrase[] {
  const out: ClassifiedPhrase[] = [];
  for (const form of forms) {
    const c = classify(form, "forms");
    if (c.mode === "loose") throw looseRefusal(c);
    if (!out.some((o) => o.needle === c.needle)) out.push(c);
  }
  return out;
}

/** ¶3.2.1 rule 6, Q135: the apostrophe form a hit may hold instead: the form as sent for one with a possessive, else `'s` on its first word. */
function otherForm(form: ClassifiedPhrase): string {
  return form.mode === "rewritten" ? form.sent : form.given.replace(/^(\S+)/u, "$1's");
}

// steps 2–3: the search and the local check

/** What one search asks for: the call's parameters on a first page, the cursor's on a continuation. */
interface Ask { forms: ClassifiedPhrase[]; includeComments: boolean; afOnly: boolean; limit: number }

/** A hit as step 3 left it: no search field but its id, kind and date survives the check (P16). */
interface Hit { id: string; kind: Kind; postedMs: number }
/** A candidate, with the forms its text holds exactly (the phrases `findIntroduction` looks for). */
interface Candidate extends Hit { forms: ClassifiedPhrase[] }
interface Rejected extends Hit { reason: Reason }

interface Searched {
  /** Each search page's candidates in date order, the pages one after the other. */
  candidates: Candidate[];
  rejected: Rejected[];
  /** Per form, the hits that hold only its other apostrophe form. */
  aside: number[];
  /** The search pages read. */
  pages: number;
  /** After each search page read, how many candidates the pages so far hold (a cursor's fingerprint covers the pages it read). */
  ends: number[];
  /** A query read up to its last page still had more hits. */
  more: boolean;
  /** The optional page that failed (¶3.9): the page's `Partial:` line; `more` stays, so the cursor reads it next. */
  failure?: ToolError;
}

interface Query { kind: Kind; spec: SearchSpec }

/** ¶4.12 step 2: per form, the oldest-first posts and, with `include_comments`, comments, the query quoted, the per-index page size. */
function queriesOf(ask: Ask): Query[] {
  const facets: Facet[] = ask.afOnly ? [{ field: "af", value: true }] : [];
  const query = (kind: Kind, form: ClassifiedPhrase): Query => ({
    kind,
    spec: { index: kind === "post" ? "posts" : "comments", sort: "old", phrases: [form], facets, page: 0, hitsPerPage: kind === "post" ? POST_HITS : COMMENT_HITS },
  });
  return ask.forms.flatMap((form) => [query("post", form), ...(ask.includeComments ? [query("comment", form)] : [])]);
}

const textField = (hit: SearchHit, name: string): string => (typeof hit[name] === "string" ? (hit[name] as string) : "");

/**
 * ¶4.12 step 3: a hit's own text (`body`) checked for every form (rule 6, exact): a candidate when it holds one; set aside when it
 * holds only a form's other apostrophe form; else rejected, `only in the title` when a post's title holds a form.
 */
function sortHit(raw: SearchHit, kind: Kind, forms: readonly ClassifiedPhrase[], s: Searched, page: { candidates: Candidate[]; rejected: Rejected[] }): Hit | undefined {
  const id = typeof raw._id === "string" ? raw._id : raw.objectID;
  const postedMs = Date.parse(textField(raw, "postedAt"));
  if (typeof id !== "string" || !isEntityId(id) || !Number.isFinite(postedMs)) return undefined;
  const hit: Hit = { id, kind, postedMs };
  const body = textField(raw, "body");
  const exact = forms.filter((f) => contains(body, f) === "exact");
  if (exact.length > 0) {
    page.candidates.push({ ...hit, forms: exact });
    return hit;
  }
  const other = forms.findIndex((f) => {
    const found = contains(body, f);
    return found === "with-possessive" || found === "without-possessive";
  });
  if (other >= 0) {
    s.aside[other] += 1;
    return hit;
  }
  const titled = kind === "post" && forms.some((f) => contains(textField(raw, "title"), f) === "exact");
  page.rejected.push({ ...hit, reason: titled ? "only in the title" : "words present but not as the phrase" });
  return hit;
}

const byDate = (a: Hit, b: Hit): number => (a.postedMs !== b.postedMs ? a.postedMs - b.postedMs : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Steps 2–3 over the search pages: the pages a cursor says were read (`pages`; the raw-response cache usually answers them), then
 * the next one while fewer than `want` candidates were found, a query had more and a request may start, up to `SEARCH_PAGES`. A
 * hit already seen (another form's) counts once, as the earliest form's. The first page is mandatory; so is a page read before,
 * since the cursor's place in the candidates depends on it. A later page that fails is `failure` (¶3.9: a `Partial:` line) and
 * the search is left open, so the cursor reads that page next.
 */
async function searchForms(ask: Ask, pages: number, want: number, ctx: CallContext, svc: Services): Promise<Searched> {
  const s: Searched = { candidates: [], rejected: [], aside: ask.forms.map(() => 0), pages: 0, ends: [], more: false };
  const seen = new Set<string>();
  let open = queriesOf(ask);
  for (let page = 0; page < SEARCH_PAGES && open.length > 0; page++) {
    const known = page < pages;
    if (page > 0 && !known && (s.candidates.length >= want || !ctx.mayStartRequest())) break;
    let results: SearchResult[];
    try {
      results = await svc.search(buildSearch(open.map((q) => ({ ...q.spec, page }))), ctx, SEARCH_TASK, "empty");
    } catch (e) {
      // ¶3.9: the optional page's failure is a `Partial:` line; the candidates in hand make the page, and the cursor reads it next.
      if (page > 0 && !known) {
        if (e instanceof CallStopped) break;
        if (isToolError(e)) {
          s.failure = e;
          break;
        }
      }
      throw e;
    }
    const found = { candidates: [] as Candidate[], rejected: [] as Rejected[] };
    const next: Query[] = [];
    results.forEach((r, j) => {
      const q = open[j]!;
      if (r.ended) return;
      for (const raw of r.hits) {
        const id = typeof raw._id === "string" ? raw._id : raw.objectID;
        if (typeof id === "string" && seen.has(id)) continue;
        const hit = sortHit(raw, q.kind, ask.forms, s, found);
        if (hit !== undefined) seen.add(hit.id);
      }
      if ((page + 1) * (q.spec.hitsPerPage ?? 0) < r.nbHits) next.push(q);
    });
    s.candidates.push(...found.candidates.sort(byDate));
    s.rejected.push(...found.rejected.sort(byDate));
    s.pages = page + 1;
    s.ends.push(s.candidates.length);
    open = next;
  }
  s.more = open.length > 0;
  return s;
}

// step 5: the hydrate and the visibility check

/** What the hydrate showed of one post or comment that passed the visibility rules. */
interface Doc {
  kind: Kind;
  id: string;
  af: boolean;
  postedAt: string;
  postedMs: number;
  hideAuthor: boolean;
  /** The candidate line without its verdict: `post "<title>" — <authors> · post_id … · AF · <day>`, or the comment's. */
  line: string;
  /** How the rejected section names it: `"<title>" (post_id …, AF, dated <day>)`, or `comment_id … (AF) by … on …, dated <day>`. */
  ref: string;
}

/** A hydrated alias; a refused or missing hit reads as no document. */
function hydrated(results: AliasResults, alias: string, ctx: CallContext): unknown {
  const r = results.get(alias);
  if (r !== undefined && "error" in r && r.error === "login_only") return undefined;
  return aliasData(results, alias, HYDRATE_TASK, ctx);
}

/** P2, P3: a post shown here is public, listed and not a quick-takes container; with `af_only`, on AF. */
function postDoc(d: RawPostCard, afOnly: boolean): Doc | undefined {
  if (!postListable(d) || (afOnly && !d.af)) return undefined;
  const r = toPostRecord(d);
  const dated = day(r.postedAt) + (r.status.placeholderDate ? `${SEP}${FLAG.PLACEHOLDER_DATE}` : "");
  return {
    kind: "post", id: r.id, af: r.af, postedAt: r.postedAt, postedMs: r.postedMs, hideAuthor: d.hideAuthor,
    line: [`post ${quoted(r.title)} — ${r.authors.map(personText).join(", ")}`, `post_id ${r.id}`, afWord(r.af), dated].join(SEP),
    ref: `${quoted(r.title)} (post_id ${r.id}, ${afWord(r.af)}, dated ${day(r.postedAt)})`,
  };
}

/** P2, P5, P6: a comment shown here is public and not a deleted placeholder; one on a hidden post stays, its post unnamed (P1). */
function commentDoc(d: RawCommentList, afOnly: boolean): Doc | undefined {
  if (!commentPublic(d) || isPlaceholder(d) || (afOnly && !d.af)) return undefined;
  const r = toCommentRecord(d);
  const place = r.place ?? { kind: "hidden post" };
  const where = place.kind === "quick take" ? `${SEP}${FLAG.QUICK_TAKE}` : ` ${placeText(place)}`;
  const named = `comment_id ${r.id} (${afWord(r.af)}) by ${personText(r.author)}${where}`;
  return {
    kind: "comment", id: r.id, af: r.af, postedAt: r.postedAt, postedMs: r.postedMs, hideAuthor: d.hideAuthor,
    line: `${named}${SEP}${day(r.postedAt)}`, ref: `${named}, dated ${day(r.postedAt)}`,
  };
}

/**
 * ¶4.12 step 5 (request 1): the documents of `hits` by id, whatever order the forum answered in (R10), each kept only when it passes
 * the visibility rules (P1, P2, P5, P6).
 */
async function hydrate(hits: readonly Hit[], afOnly: boolean, ctx: CallContext, svc: Services): Promise<Map<string, Doc>> {
  const postIds = hits.filter((h) => h.kind === "post").map((h) => h.id);
  const commentIds = [...new Set(hits.filter((h) => h.kind === "comment").map((h) => h.id))];
  const docs = new Map<string, Doc>();
  const ops = firstUseHydrateOps(postIds, commentIds);
  if (ops.length === 0) return docs;
  const results = await svc.gql(ops, ctx, HYDRATE_TASK);
  const wanted = new Set(postIds);
  for (const row of rowsOf<Record<string, unknown>>(hydrated(results, "p", ctx))) {
    if (typeof row._id !== "string" || !wanted.has(row._id)) continue;
    const doc = postDoc(row as unknown as RawPostCard, afOnly);
    if (doc !== undefined) docs.set(doc.id, doc);
  }
  commentIds.forEach((id, i) => {
    const data = hydrated(results, `c${i + 1}`, ctx);
    const row = isRecord(data) ? data.result : undefined;
    if (!isRecord(row) || row._id !== id) return;
    const doc = commentDoc(row as unknown as RawCommentList, afOnly);
    if (doc !== undefined) docs.set(doc.id, doc);
  });
  return docs;
}

// steps 6–8: history lists, as-published texts and verdicts

/** One checked candidate's history: the as-published row (when the list showed one) and the visible rows after it, oldest first. */
interface History {
  published?: RevisionRecord;
  /** The as-published list came back full. */
  publishedFull: boolean;
  after: RevisionRecord[];
  /** The list after publication came back full, so it may not reach back to publication. */
  afterFull: boolean;
}

type Verdict =
  | { kind: "snapshot" } | { kind: "published" } | { kind: "edit"; row: RevisionRecord } | { kind: "undetermined" }
  | { kind: "not located" } | { kind: "not available" } | { kind: "no history" } | { kind: "no text" } | { kind: "unchecked" };

/** A candidate of the page that the hydrate kept. */
interface Shown {
  c: Candidate;
  doc: Doc;
  /** Its index among the page's candidates (`listPage` items). */
  at: number;
  /** One of the first `min(limit, 10)` of the page: its history is checked in this call. */
  checked: boolean;
  publicId?: PublicDocId;
  verdict: Verdict;
}

const verified = (v: Verdict): boolean => v.kind === "snapshot" || v.kind === "published" || v.kind === "edit";
/** ¶4.12 step 9: a re-dated candidate's date is the edit that added the phrase; any other's is its posting date. */
const effectiveMs = (s: Shown): number => (s.verdict.kind === "edit" ? s.verdict.row.editedMs : s.doc.postedMs);

function revisionDoc(doc: Doc): RevisionDoc {
  return { kind: doc.kind, id: doc.id, hideAuthor: doc.hideAuthor, postedAt: doc.postedAt, af: doc.af };
}

/** A list alias's rows and total, or the error the alias carried (the forum's "nothing here" is no rows). */
function listOf(r: AliasResult | undefined): { rows: Record<string, unknown>[]; totalCount: number | null } | ToolError {
  if (r === undefined) return { rows: [], totalCount: null };
  if ("error" in r) return r.error === "not_found" || r.error === "not_public" ? { rows: [], totalCount: null } : new ToolError(r.error, r.message);
  return { rows: rowsOf<Record<string, unknown>>(r.data), totalCount: isRecord(r.data) && typeof r.data.totalCount === "number" ? r.data.totalCount : null };
}

/** The as-published row (`_id version editedAt updateType`) as a revision record of `doc`; `undefined` for an unreadable row. */
function publishedRow(row: Record<string, unknown> | undefined, doc: Doc): RevisionRecord | undefined {
  if (row === undefined || typeof row._id !== "string" || typeof row.editedAt !== "string" || !Number.isFinite(Date.parse(row.editedAt))) return undefined;
  const raw: RawRevRow = {
    _id: row._id, documentId: doc.id, collectionName: null,
    // §7.4: the forum's resolver answers `1.0.0` for a revision stored without a version.
    version: typeof row.version === "string" ? row.version : "1.0.0", editedAt: row.editedAt,
    updateType: typeof row.updateType === "string" ? (row.updateType as RawRevRow["updateType"]) : null,
    commitMessage: null, changeMetrics: null, wordCount: 0, userId: null, user: null,
  };
  return toRevisionRecord(raw, revisionDoc(doc));
}

/** The visible rows after publication, oldest first (ties by id), without the as-published row should the two lists share it. */
function afterRows(rows: readonly Record<string, unknown>[], doc: Doc, published: RevisionRecord | undefined): RevisionRecord[] {
  return rows
    .filter((r) => typeof r._id === "string" && r._id !== published?.id && typeof r.editedAt === "string" && Number.isFinite(Date.parse(r.editedAt)))
    .map((r) => toRevisionRecord(r as unknown as RawRevRow, revisionDoc(doc)))
    .sort((a, b) => (a.editedMs !== b.editedMs ? a.editedMs - b.editedMs : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Request 2's answer for the candidate under `key`, or the first error of its two aliases. */
function historyOf(results: AliasResults, key: string, doc: Doc): History | ToolError {
  const pub = listOf(results.get(`pub${key}`));
  if (pub instanceof ToolError) return pub;
  const aft = listOf(results.get(`aft${key}`));
  if (aft instanceof ToolError) return aft;
  const published = publishedRow(pub.rows[0], doc);
  return {
    ...(published !== undefined && { published }),
    publishedFull: !allListed({ rows: pub.rows.length, limit: AS_PUBLISHED_LIMIT, totalCount: pub.totalCount }),
    after: afterRows(aft.rows, doc, published),
    afterFull: !allListed({ rows: aft.rows.length, limit: CONFIG.paging.revisionPage, totalCount: aft.totalCount }),
  };
}

/**
 * The Markdown of revisions `ids`, each from a visible list of a confirmed document (P17; `owners` maps it to that document):
 * cached texts (`revtext`, shared with `get_history`) cost nothing, the rest are fetched in one request, `r1`…`rN`. A text the
 * forum no longer returns, or one of another document, is left out; `error` is the first alias error beyond "nothing here".
 */
async function revisionTexts(
  ids: readonly string[], owners: ReadonlyMap<string, string>, task: string, ctx: CallContext, svc: Services,
): Promise<{ texts: Map<string, string>; error?: ToolError }> {
  const texts = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const cached = svc.caches.get<string>("revtext", id);
    if (cached === undefined) missing.push(id);
    else texts.set(id, cached);
  }
  if (missing.length === 0) return { texts };
  const results = await svc.gql(missing.map((id, i) => revisionTextOp(`r${i + 1}`, ctx.confirmPublic("revision", id))), ctx, task);
  let error: ToolError | undefined;
  missing.forEach((id, i) => {
    const r = results.get(`r${i + 1}`);
    if (r === undefined) return;
    if ("error" in r) {
      if (r.error !== "not_found" && r.error !== "not_public") error ??= new ToolError(r.error, r.message);
      return;
    }
    const result = isRecord(r.data) ? r.data.result : undefined;
    if (!isRecord(result) || result._id !== id || result.documentId !== owners.get(id)) return;
    const markdown = typeof result.markdown === "string" ? result.markdown : "";
    svc.caches.set("revtext", id, markdown);
    texts.set(id, markdown);
  });
  return { texts, ...(error !== undefined && { error }) };
}

/** What steps 6–8 found for the page: verdicts are set on the `Shown` records themselves. */
interface Checked { partials: string[]; stopped?: StopReason }

/**
 * ¶4.12 step 8 for one re-dated candidate: the earliest row where one of its forms was found, unless another form's open interval
 * starts before it (that form may have come earlier); else not determined.
 */
function introVerdict(s: Shown, rows: readonly RevisionRecord[], search: Awaited<ReturnType<typeof findIntroduction>>): Verdict {
  const indexOf = (r: RevisionRecord): number => rows.findIndex((x) => x.id === r.id);
  const keys = s.c.forms.map((f) => `${s.c.id}|${f.given}`);
  const found = keys.flatMap((k) => (search.found[k] === undefined ? [] : [indexOf(search.found[k]!)])).filter((i) => i > 0);
  if (found.length === 0) return { kind: "undetermined" };
  const first = Math.min(...found);
  const open = keys.flatMap((k) => (search.between[k] === undefined ? [] : [indexOf(search.between[k]!.from)]));
  return open.some((i) => i < first) ? { kind: "undetermined" } : { kind: "edit", row: rows[first]! };
}

/**
 * Steps 6–8 for the checked candidates of the page: request 2 (history lists), request 3 (the as-published texts, from those lists
 * only) and up to 2 rounds of `findIntroduction` for the 2 earliest candidates whose phrase a later edit added. A failure of a part
 * leaves its candidates without a verdict and gives one `Partial:` line; a stop before request 2 or 3 leaves every candidate
 * unchecked, one during the rounds leaves the open ones not determined.
 */
async function checkHistories(shown: readonly Shown[], ask: Ask, ctx: CallContext, svc: Services): Promise<Checked> {
  const partials: string[] = [];
  const checked = shown.filter((s) => s.checked && s.publicId !== undefined);
  if (checked.length === 0) return { partials };
  // ¶2.2 step 5: a stop before request 2 or 3 leaves the whole page unchecked; the cursor checks it again.
  const unchecked = (stopped: StopReason): Checked => {
    for (const s of shown) s.verdict = { kind: "unchecked" };
    return { partials, stopped };
  };

  // Request 2: the history lists, only for the candidates the hydrate confirmed (P17).
  const histories = new Map<Shown, History>();
  try {
    const results = await svc.gql(firstUseHistoryOps(checked.map((s, k) => ({ key: String(k), docId: s.publicId!, postedMs: s.doc.postedMs }))), ctx, HISTORY_TASK);
    let failed: ToolError | undefined;
    checked.forEach((s, k) => {
      const h = historyOf(results, String(k), s.doc);
      if (h instanceof ToolError) {
        failed ??= h;
        s.verdict = { kind: "no history" };
      } else {
        histories.set(s, h);
      }
    });
    if (failed !== undefined) partials.push(partialLine(PARTIAL.history, failed));
  } catch (e) {
    if (e instanceof CallStopped) return unchecked(e.reason);
    if (!isToolError(e)) throw e;
    for (const s of checked) s.verdict = { kind: "no history" };
    return { partials: [partialLine(PARTIAL.history, e)] };
  }

  // Request 3: the as-published texts, ids from those lists only (P17).
  const owners = new Map<string, string>();
  for (const [s, h] of histories) for (const r of [...(h.published === undefined ? [] : [h.published]), ...h.after]) owners.set(r.id, s.doc.id);
  const wanted = [...histories.values()].flatMap((h) => (h.published === undefined ? [] : [h.published.id]));
  let texts = new Map<string, string>();
  try {
    const got = await revisionTexts(wanted, owners, TEXT_TASK, ctx, svc);
    texts = got.texts;
    if (got.error !== undefined) partials.push(partialLine(PARTIAL.texts, got.error));
  } catch (e) {
    if (e instanceof CallStopped) return unchecked(e.reason);
    if (!isToolError(e)) throw e;
    partials.push(partialLine(PARTIAL.texts, e));
  }

  // Step 8: the verdicts; a phrase a later edit added is located for the 2 earliest candidates whose list can show it.
  const added: { s: Shown; rows: RevisionRecord[] }[] = [];
  for (const [s, h] of histories) {
    if (h.published === undefined) {
      s.verdict = { kind: h.publishedFull ? "not located" : "not available" };
      continue;
    }
    const text = texts.get(h.published.id);
    if (text === undefined) {
      s.verdict = { kind: "no text" };
      continue;
    }
    if (ask.forms.some((f) => contains(text, f) === "exact")) {
      s.verdict = { kind: h.published.kind === "2019 import snapshot" ? "snapshot" : "published" };
      continue;
    }
    s.verdict = { kind: "undetermined" };
    // With no row after publication, or a list that may not reach back to it, there is nothing to search.
    if (h.after.length > 0 && !h.afterFull && added.length < REDATED_MAX) added.push({ s, rows: [h.published, ...h.after] });
  }
  if (added.length === 0) return { partials };

  const series: IntroSeries[] = added.map(({ s, rows }) => ({ key: s.c.id, rows, phrases: s.c.forms }));
  const fetchTexts = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
    const got = await revisionTexts(ids, owners, PROBE_TASK, ctx, svc);
    if (got.error !== undefined) throw got.error;
    return got.texts;
  };
  const rounds = Math.max(0, Math.min(PROBE_ROUNDS, ctx.maxRequests - ctx.requestsUsed));
  let stopped: StopReason | undefined;
  // The rounds run one at a time from the intervals the round before left, so a round that is refused or fails keeps what the
  // earlier ones found; the first pass sends nothing (adjacent rows need no text).
  let search = await findIntroduction(series, fetchTexts, { rounds: 0, probes: PROBES });
  for (let round = 0; round < rounds && Object.keys(search.between).length > 0; round++) {
    try {
      search = await findIntroduction(series, fetchTexts, { rounds: 1, probes: PROBES, state: search.state });
    } catch (e) {
      if (e instanceof CallStopped) stopped = e.reason;
      else if (isToolError(e)) partials.push(partialLine(PARTIAL.probes, e));
      else throw e;
      break;
    }
  }
  if (stopped === undefined && rounds < PROBE_ROUNDS && Object.keys(search.between).length > 0) stopped = "request cap";
  for (const { s, rows } of added) s.verdict = introVerdict(s, rows, search);
  return { partials, ...(stopped !== undefined && { stopped }) };
}

// the page

/** One page's inputs: what is asked, where the page starts, the search pages a cursor read, and what its cursors store. */
interface PageInput {
  ask: Ask;
  state?: ListState;
  pages: number;
  echo: CallContext;
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

function verdictText(s: Shown): string {
  const v = s.verdict;
  const param = s.doc.kind;
  switch (v.kind) {
    case "snapshot": return IN_SNAPSHOT;
    case "published": return AT_PUBLICATION;
    case "edit": return `added by an edit on ${day(v.row.editedMs)} (v${oneLine(v.row.version, VERSION_CAP)}, revision_id ${v.row.id})`;
    case "undetermined": {
      const phrases = s.c.forms.map((f) => JSON.stringify(f.given)).join(", ");
      return `added after publication (version not determined; get_history {${param}: "${s.doc.id}", phrases: [${phrases}]} finds it)`;
    }
    case "not located": return `published version not located in this call; get_history {${param}: "${s.doc.id}", revision: "original"} reads further`;
    case "not available": return NOT_AVAILABLE;
    case "no history": return NO_HISTORY;
    case "no text": return NO_TEXT;
    case "unchecked": return NOT_YET;
  }
}

const lineOf = (s: Shown): string => `${s.doc.line}${SEP}${verdictText(s)}`;

/** ¶4.12 Ordering: effective date, then posting date, then id. */
function byEffective(a: Shown, b: Shown): number {
  const ea = effectiveMs(a), eb = effectiveMs(b);
  if (ea !== eb) return ea - eb;
  if (a.doc.postedMs !== b.doc.postedMs) return a.doc.postedMs - b.doc.postedMs;
  return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0;
}

/** `"<form 1>" (also: "<form 2>", …)`. */
function subjectOf(forms: readonly ClassifiedPhrase[]): string {
  const [first, ...rest] = forms.map((f) => `"${f.given}"`);
  return rest.length === 0 ? first! : `${first} (also: ${rest.join(", ")})`;
}

/** ¶3.7 request echo: the forms (with how a changed one was searched), `include_comments`, `af_only` when on or given, `limit`. */
function requestEcho(x: PageInput): string[] {
  const { ask, echo } = x;
  const forms = ask.forms.map((f) => (f.sent === f.given ? `"${f.given}"` : `"${f.given}" (searched as "${f.sent}")`));
  return [
    `forms [${forms.join(", ")}]`,
    setting(echo, "include_comments", ask.includeComments),
    ...(ask.afOnly || echo.given.has("af_only") ? [setting(echo, "af_only", ask.afOnly)] : []),
    setting(echo, "limit", ask.limit),
  ];
}

/** ¶4.12 Errors and empty results. */
function emptyLine(forms: readonly ClassifiedPhrase[]): string {
  const others = forms.length > 1 ? " (or the other forms)" : "";
  return `No publicly visible post or comment contains "${forms[0]!.given}"${others}. Phrase search is exact: try other word forms, or hyphenated and spaced spellings.`;
}

/** No candidate, while the forum has more hits than the search pages this server reads: the empty text would say too much. */
function noneRead(forms: readonly ClassifiedPhrase[]): string {
  const others = forms.length > 1 ? " or another of the forms" : "";
  return `None of the oldest hits read holds "${forms[0]!.given}"${others} as an exact phrase.`;
}

/** Q135: the hits set aside for each form, as one line each. */
function asideLines(ask: Ask, s: Searched): string[] {
  return ask.forms.flatMap((f, i) => (s.aside[i]! > 0 ? [`Not counted (only the other apostrophe form, "${otherForm(f)}"): ${plural(s.aside[i]!, "hit")}.`] : []));
}

/** The end of the candidates when only the search pages read hold them: the forum has later hits that this server does not read. */
function pagesRead(ask: Ask): string {
  const comments = ask.includeComments ? ` and ${fmtInt(SEARCH_PAGES * COMMENT_HITS)} comment hits` : "";
  return `first_use reads the oldest ${fmtInt(SEARCH_PAGES * POST_HITS)} post hits${comments} of each form; later uses are not checked`;
}

/**
 * The items after the candidates: the rejected earlier-looking hits (candidates re-dated past the earliest verified one, and the
 * hydrated rejected hits dated before it, oldest first, then the count of the rest), the set-aside counts and the `get_history`
 * pointer. With no verified candidate every hydrated rejected hit is named.
 */
function afterLines(ask: Ask, s: Searched, shown: readonly Shown[], named: ReadonlyMap<string, { r: Rejected; doc: Doc }>, ev: Shown | undefined): string[] {
  const evMs = ev === undefined ? Number.POSITIVE_INFINITY : effectiveMs(ev);
  const lines: { ms: number; id: string; text: string }[] = [];
  for (const x of shown) {
    if (x !== ev && x.doc.postedMs < evMs && effectiveMs(x) > evMs) lines.push({ ms: x.doc.postedMs, id: x.doc.id, text: `${x.doc.ref}: phrase ${verdictText(x)}` });
  }
  const namedIds = new Set<string>();
  for (const { r, doc } of named.values()) {
    if (doc.postedMs >= evMs) continue;
    namedIds.add(r.id);
    lines.push({ ms: doc.postedMs, id: doc.id, text: `${doc.ref}: ${r.reason}` });
  }
  lines.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const others = s.rejected.filter((r) => !namedIds.has(r.id)).length;
  const rejected = [...lines.map((l) => `  - ${l.text}`), ...(others > 0 ? [`  - ${plural(others, "other hit")} contained the words but not the phrase`] : [])];
  return [
    ...(rejected.length > 0 ? ["Earlier-looking hits ruled out:", ...rejected] : []),
    ...asideLines(ask, s),
    ...(ev === undefined ? [] : [`Read the published text: get_history {${ev.doc.kind}: "${ev.doc.id}", revision: "original"}`]),
  ];
}

const candidateId = (c: Candidate): string => c.id;
const candidateMs = (c: Candidate): number => c.postedMs;

/**
 * ¶3.6: the page of candidates from `state` on (`listPage`). A cursor's fingerprint covers the search pages it had read (`pages`);
 * a search page read since only adds candidates after theirs, so the fingerprint is compared over those pages alone: the list
 * reads as changed only when they changed or the last candidate shown is gone. The states after the page's candidates carry the
 * fingerprint of every candidate found, which covers the pages this call read (the pages those cursors store).
 */
function candidatePage(s: Searched, state: ListState | undefined, pages: number, limit: number): ReturnType<typeof listPage<Candidate>> {
  const read = pages >= 1 && pages < s.pages ? s.ends[pages - 1]! : s.candidates.length;
  if (state?.fingerprint === undefined || read === s.candidates.length) return listPage(s.candidates, state, limit, candidateId, candidateMs);
  const { fingerprint: was, ...rest } = state;
  // Without the stored fingerprint, `listPage` gives a note only for a lost last candidate; its count is set here.
  const page = listPage(s.candidates, rest, limit, candidateId, candidateMs);
  const cur = fingerprint(s.candidates.slice(0, read), candidateMs);
  if (page.driftNote === undefined && was.count === cur.count && was.newestMs === cur.newestMs) return page;
  return { ...page, driftNote: driftNote(Math.max(0, cur.count - was.count)) };
}

/**
 * One page: steps 2–10 from `x.state` on. The page's candidates are hydrated with the earlier-dated rejected hits, the checked ones
 * get their verdicts, and the page shows as many of them (from the first, in candidate order) as fit whole with the lines after
 * them, re-ranked by effective date. The cursor resumes after the last candidate checked and shown, so candidates listed `not
 * checked yet` are checked on the next page; after a stop it repeats this page.
 */
async function pageOf(x: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { ask, state } = x;
  const start = state?.index ?? 0;
  const s = await searchForms(ask, x.pages, start + ask.limit, ctx, svc);
  const page = candidatePage(s, state, x.pages, ask.limit);
  const shown0 = state?.shown ?? 0;
  const first: ListState = state ?? { kind: "list", shown: 0, index: 0 };
  const checkN = Math.min(ask.limit, CHECKED_MAX);

  // Step 5 (request 1): the page's candidates, then the rejected hits dated before the newest checked one, oldest first.
  const toCheck = page.items.slice(0, checkN);
  const newestChecked = toCheck.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...toCheck.map((c) => c.postedMs));
  const earlier = s.rejected.filter((r) => r.postedMs < newestChecked).slice(0, REJECTED_HYDRATED);
  const docs = page.items.length === 0 ? new Map<string, Doc>() : await hydrate([...page.items, ...earlier], ask.afOnly, ctx, svc);
  const kept: Shown[] = page.items.flatMap((c, at) => {
    const doc = docs.get(c.id);
    if (doc === undefined) return [];
    const checked = at < checkN;
    // P17: a candidate the hydrate kept is confirmed public; only its history is read.
    return [{ c, doc, at, checked, ...(checked && { publicId: ctx.confirmPublic("doc", doc.id) }), verdict: { kind: "unchecked" } as Verdict }];
  });
  if (kept.length < page.items.length) svc.log.debug("first_use candidates dropped by the hydrate", { dropped: page.items.length - kept.length });
  const named = new Map<string, { r: Rejected; doc: Doc }>();
  for (const r of earlier) {
    const doc = docs.get(r.id);
    if (doc !== undefined) named.set(r.id, { r, doc });
  }

  const checkedParts = await checkHistories(kept, ask, ctx, svc);
  const { stopped } = checkedParts;
  const partials = [...(s.failure === undefined ? [] : [partialLine(PARTIAL.search, s.failure)]), ...checkedParts.partials];
  const notesFor = (shown: readonly Shown[]): string[] => [
    CAVEAT["C-SEARCH"],
    ...(shown.some((y) => y.verdict.kind === "snapshot") ? [CAVEAT["C-PRE2019"]] : []),
    ...(page.driftNote === undefined ? [] : [page.driftNote]),
  ];
  // A cursor stores the search pages that its state's place and fingerprint cover: the pages this call read for a state after
  // one of its candidates, the incoming cursor's for this page's own start (a stop repeats the page as it began).
  const cursorAt = (at: ListState, pages: number): string => mint(svc, "first_use", x.args, x.effective, { streams: [at], current: 0, data: { pages } });
  // A later search page may still add candidates: the list goes on past its end, so its length is no bound yet.
  const searchGoesOn = s.more && s.pages < SEARCH_PAGES;
  /** The footer after `resume` of the page's candidates: the next ones, the end of the list, or the end of what the search reads. */
  const footerAfter = (resume: number): Footer => {
    if (resume >= page.items.length && page.ended && !searchGoesOn) return s.more ? { kind: "reachable", reason: pagesRead(ask) } : { kind: "end" };
    const from = shown0 + resume + 1;
    const to = searchGoesOn ? from + ask.limit - 1 : Math.min(from + ask.limit - 1, s.candidates.length);
    const cursor = resume === 0 ? cursorAt(first, x.pages) : cursorAt(page.after[resume - 1] as ListState, s.pages);
    return { kind: "more", tool: "first_use", cursor, next: nextText("candidates", from, Math.max(from, to)) };
  };

  // Nothing kept on this page: the empty result on a first page that ends the list, else the scan line of a list that goes on.
  if (kept.length === 0) {
    const goesOn = !page.ended || searchGoesOn;
    const head = [
      ...partials,
      ...(goesOn && page.items.length > 0 ? [emptyText({ kind: "scan", checked: page.items.length })] : []),
      ...(!goesOn && shown0 === 0 ? [s.more ? noneRead(ask.forms) : emptyLine(ask.forms)] : []),
      ...asideLines(ask, s),
    ];
    return reply(
      { tool: "first_use", subject: subjectOf(ask.forms), request: requestEcho(x), notes: notesFor([]), head, items: [] },
      maxTokens, svc, () => footerAfter(page.items.length),
    );
  }

  /** The page with the first `k` kept candidates (in candidate order), re-ranked by effective date, and the lines after them. */
  const specFor = (k: number): { spec: PageSpec; footer: () => Footer } => {
    const shown = kept.slice(0, k).sort(byEffective);
    const ev = shown.find((y) => verified(y.verdict));
    const checkedCount = shown.filter((y) => !NOT_CHECKED.has(y.verdict.kind)).length;
    // A continuation's candidates are later search hits (page by page, ¶4.12 Paging): its earliest verified use is that page's only.
    const earliest = shown0 > 0 ? "Earliest verified on this page" : "Earliest verified";
    const head = [
      ...partials,
      // ¶2.2 step 5: a page stopped before its checks names no earliest use.
      ...(ev !== undefined ? [`${earliest}: ${lineOf(ev)}`] : shown.every((y) => y.verdict.kind === "unchecked") ? [] : [NONE_VERIFIED]),
      `Candidates (by effective date; ${fmtInt(checkedCount)} checked):`,
    ];
    const items: PageItem[] = [
      ...shown.map((y, i) => ({ text: `  ${i + 1}. ${lineOf(y)}` })),
      ...afterLines(ask, s, shown, named, ev).map((text) => ({ text })),
    ];
    // The list items this page accounts for: through its last candidate shown, the dropped ones after it included at the end.
    const through = k < kept.length ? kept[k - 1]!.at + 1 : page.items.length;
    // The cursor resumes at the first candidate not shown or not checked, so `not checked yet` ones are checked next.
    const firstUnchecked = kept.find((y) => !y.checked)?.at ?? page.items.length;
    const resume = Math.min(k < kept.length ? kept[k]!.at : page.items.length, firstUnchecked);
    const footer = (): Footer => (stopped !== undefined ? { kind: "stopped", why: stopped, tool: "first_use", cursor: cursorAt(first, x.pages) } : footerAfter(resume));
    const spec: PageSpec = {
      tool: "first_use", subject: subjectOf(ask.forms), request: requestEcho(x), position: positionText("candidates", shown0 + 1, shown0 + through),
      oneItem: shown0 === 0 && s.candidates.length === 1 && k === 1, notes: notesFor(shown), head, items,
    };
    return { spec, footer };
  };

  // As many candidates as fit whole with the lines after them; the first always goes on the page.
  let k = kept.length;
  while (k > 1 && !fitsWhole(specFor(k).spec, maxTokens)) k -= 1;
  const { spec, footer } = specFor(k);
  return reply(spec, maxTokens, svc, footer);
}

// first page and continuation

/** ¶3.6: the effective values a cursor compares: the forms as classified (each once), the flags and the limit. */
function firstUseEffective(forms: readonly ClassifiedPhrase[] | undefined, p: FirstUseParams): Record<string, unknown> {
  return { forms: forms?.map((f) => f.given), include_comments: p.include_comments, af_only: p.af_only, limit: p.limit };
}

async function firstPage(p: FirstUseParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  if (p.forms === undefined) throw internalError("first_use", "no forms");
  const forms = formsOf(p.forms);
  const args = givenArgs(p, ctx);
  const ask: Ask = { forms, includeComments: p.include_comments, afOnly: p.af_only, limit: p.limit };
  return pageOf({ ask, pages: 1, echo: ctx, args, effective: firstUseEffective(forms, p) }, p.max_tokens, ctx, svc);
}

async function continuation(entry: CursorEntry, p: FirstUseParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  // ¶3.6: forms given again are classified first (a loose one is refused as on a first page), then compared as the cursor stored them.
  checkContinuation(entry, firstUseEffective(ctx.given.has("forms") && p.forms !== undefined ? formsOf(p.forms) : undefined, p), ctx);
  const stored = entry.effective as { forms: string[]; include_comments: boolean; af_only: boolean; limit: number };
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "list") throw internalError("first_use", "a cursor without a list state");
  const pages = isRecord(entry.state.data) && typeof entry.state.data.pages === "number" ? entry.state.data.pages : 1;
  const ask: Ask = { forms: formsOf(stored.forms), includeComments: stored.include_comments, afOnly: stored.af_only, limit: stored.limit };
  return pageOf(
    {
      ask, state, pages,
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  forms: P.forms().optional(),
  include_comments: P.flag("include_comments"),
  af_only: P.flag("af_only"),
  limit: P.limit(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<FirstUseParams> = {
  name: "first_use",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["forms"],
  run(p, ctx, svc) {
    const entry = openContinuation("first_use", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
