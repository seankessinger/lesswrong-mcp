// Layer 2. The `get_post` tool (¶4.3): one post in full. Request 1 reads the post with POST_FULL through its resolution
// aliases, which is also its visibility check (P17); its outcomes and wording are `ids/resolve`'s. A quick-takes container
// gets the short answer of step 2. Request 2, one batch with each part only when it is needed, reads the review comments, the
// debate turns, the HTML (when a dialogue or P15 needs it), the canonical sequence's chapters and the collections listing;
// request 3 reads the adjacent sequence's chapters to name a neighbour at a sequence boundary, only while a request may start
// (step 4). Once the post is confirmed, a part that fails is a `Partial:`
// line and the rest is returned (¶3.9, ¶8); a deadline or cap stop ends the page with `Stopped early`. The body goes through
// the pipeline of step 6 once per version (the `body` cache, `<postId>@<version>`, which `get_links` reads too) and is shown
// whole, as one section, or as the paragraphs that match; the debate turns follow it. Paging (¶4.3, ¶3.6) is a `slice`
// stream over the body and the turns, next to the two context parts that have no bound of their own, the review lines and
// the glossary: each is a capped block, and the cursor's data keeps the line each unfinished one resumes at. The other
// context lines are one bounded line each and are shown on the first page only. A continuation re-reads the post (the
// visibility re-check), shows the unfinished blocks from where they stopped before the text, and says so when the post's
// version changed (Q50.15).
import { z } from "zod";
import { CONFIG } from "../config";
import { matchInText, needsHtml, processBody, sliceSection, type ProcessedBody } from "../domain/markdown";
import { toPostRecord } from "../domain/posts";
import { parseReactions, reactSummary, visibleReacts } from "../domain/reactions";
import { adjacentSequence, neighbours, readingOrder } from "../domain/sequences";
import { authorOf, commentPublic, glossaryTermPublic, isPlaceholder, maskPostRef, sequencePublic } from "../domain/visibility";
import { badInput, CallStopped, isToolError, loginOnly, notFound, ToolError } from "../errors";
import { getPostRequest2Ops, neighbourChaptersOp } from "../forum/templates/get_post";
import { parseRef } from "../ids/parse";
import { echoOf, negativeKey, readResolution, resolutionOps } from "../ids/resolve";
import { sliceAfter, slicePosition } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { fitsWhole } from "../render/layout";
import { CAVEAT, FLAG, fmtInt, matchLine, partialLine } from "../render/messages";
import { afBlock, commentRefText, matchHitItem, personText, postRefText, quote, statusTexts, textOutlineLine } from "../render/records";
import { day, minute } from "../text/dates";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, CappedBlock, Consumed, CursorEntry, CursorState, Footer, GqlOp, PageItem, PageSpec, ParsedRef, PostRecord,
  PublicPostId, RawChapter, RawCommentRef, RawPostFull, RawPostRef, Resolved, Services, StreamState, ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, openContinuation, reply, rowsOf, setting } from "./common";
import { bookSequenceTitle, collectionsCached, crossText, DIR_WORD, loadCollectionsListing, UNORDERED, type Dir } from "./loaders";

type GetPostParams = { post?: string; section?: number; match?: string; include_body: boolean; cursor?: string; max_tokens: number };

type SliceState = Extract<StreamState, { kind: "slice" }>;
type ReviewRow = RawCommentRef & { baseScore: number | null; reviewingForReview: string | null };
type TurnRow = RawCommentRef & { contents: { markdown: string | null } | null };
type CanonicalSequence = NonNullable<RawPostFull["canonicalSequence"]>;

const TITLE = "What does this post say, and what is its status?";
/** ¶4.3, verbatim. */
const DESCRIPTION_QUOTE =
  "Read one post: metadata, status and text. post = id, URL or exact current slug (renamed posts lose their earlier slugs, but the id in any URL works; a comment link opens its post). Returns title, authors including coauthors, publication date, last-edit date and version, karma and vote count (both include the author's automatic self-vote), AF status with AF karma and AF comment count, the comment count (~), status (curated, frontpage or not, pinned, Best of LessWrong, question, linkpost, dialogue, debate, event), tags ordered by how strongly readers tied them to the post (relevance votes shown), Annual Review results and the post's review comments (with ids), the post's glossary, a summary of reader reactions, related questions, the best answer of a question post, the site's canonical sequence for the post with the previous and next post in the order of that sequence's chapter list (at the ends, the neighbouring sequence of its collection, if its books are all numbered; the sequence page's own order can differ when chapters are unnumbered; a post can be in several sequences, see get_sequence), and the body as Markdown. Long bodies: the first page shows a numbered outline of headings; read one with section=<number>, or continue with the cursor. match=<text> returns only the paragraphs containing that text (case, accents and punctuation ignored). include_body=false returns everything but the text. Interactive widget code is omitted (its size is noted); dialogues show speaker names; for the 6 old-style debate posts the debate turns follow the body. Answers and comments are in get_comments. A post the forum refuses to logged-out readers gives not_public; a post for logged-in readers only gives login_only; a post that is reachable by link only opens by id or any URL containing its id (not by slug) and is flagged.";

const POST_TASK = "reading the post";
const PARTS_TASK = "reading the post's reviews, turns and sequence";
const NEIGHBOUR_TASK = "reading the neighbouring sequence";

/** The `Partial:` section of each part. */
const SECTION = {
  reviews: "reviews",
  turns: "debate turns",
  speakers: "speaker names",
  html: "post HTML",
  sequence: "canonical sequence",
  neighbour: "neighbouring sequence",
} as const;

const TITLE_CAP = CONFIG.render.caps.title;
const NAME_CAP = CONFIG.render.caps.name;
const VERSION_CAP = 40;
const SEP = " · ";
/** ¶3.8.1: at most this many tags, then `+N more`. */
const TAGS_SHOWN = 6;
/** The reviews request's limit (templates/shared.ts): a full answer may have left reviews out. */
const REVIEWS_LIMIT = 50;
/** ¶4.3 step 7: the last line of the reviews block after a full answer of `REVIEWS_LIMIT` rows. */
const MORE_REVIEWS = "  more may exist; every review also appears in get_comments, flagged review";
/** §7.7: a `legacy` post from before this instant came from Overcoming Bias. */
const OVERCOMING_BIAS_BEFORE_MS = Date.parse("2009-01-01T00:00:00.000Z");

/** Request 3's alias for the sequence before (`pb`) or after (`nb`) the canonical one. */
const NEIGHBOUR_ALIAS: Readonly<Record<Dir, string>> = { prev: "pb", next: "nb" };

/** The context parts with no bound of their own (¶4.3 Paging, the ¶3.6 `slice` row: "get_post context blocks"), in page order. */
type BlockKey = "reviews" | "glossary";
const BLOCK_KEYS = ["reviews", "glossary"] as const satisfies readonly BlockKey[];
/** Each context block is held to this share of the page; one line of either is far below it at 2,000. */
const CONTEXT_BLOCK_SHARE = 0.25;
/** A context block, resumed at `from` (the index of its next line). */
type ContextBlock = CappedBlock & { key: BlockKey; from: number };
/** Where each unfinished block resumes; a cursor's data holds these numbers only. */
type BlockResume = Partial<Record<BlockKey, number>>;
/** The `next:` text of a page that left a block unfinished; `at` is the line it resumes at, printed 1-based. */
const BLOCK_NEXT: Readonly<Record<BlockKey, (at: number) => string>> = {
  reviews: (at) => `reviews from ${fmtInt(at + 1)}`,
  glossary: (at) => `glossary from term ${fmtInt(at + 1)}`,
};

const quoted = (s: string | null | undefined, cap: number): string => `"${oneLine(s, cap)}"`;
/** A whole count with its noun: `1 vote`, `612 votes`. */
const counted = (n: number, one: string): string => `${fmtInt(n)} ${n === 1 ? one : `${one}s`}`;
/** §14.6: review vote scores carry float noise; one decimal, grouped. */
const score = (n: number): string => fmtInt(Math.round(n * 10) / 10);

// what was asked

/** The text-selecting parameters of a call, stored in its cursor. */
interface Ask { section?: number; match?: string; includeBody: boolean }

function effectiveOf(postId: string, ask: Ask): Record<string, unknown> {
  return { post: postId, section: ask.section, match: ask.match, include_body: ask.includeBody };
}

/** ¶3.7 request echo: the post as resolved, `section`/`match` when given, `include_body` always. */
function requestEcho(r: Resolved, ask: Ask, echo: CallContext): string[] {
  const out = [echoOf("post", r)];
  const unused = ask.includeBody ? "" : " (not applied: include_body false)";
  if (ask.section !== undefined) out.push(`section ${ask.section}${unused}`);
  if (ask.match !== undefined) out.push(`match "${oneLine(ask.match, 200)}"${unused}`);
  out.push(setting(echo, "include_body", ask.includeBody));
  return out;
}

// requests

/**
 * Request 1 (step 1): the post with POST_FULL through its resolution aliases; a remembered `not_found`/`not_public` costs no
 * request. A post flagged for logged-in readers only is refused as `login_only`.
 */
async function readPost(ref: ParsedRef, ctx: CallContext, svc: Services): Promise<{ resolved: Resolved; doc: RawPostFull }> {
  const negative = svc.caches.get<{ category: ToolError["category"]; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const results = await svc.gql(resolutionOps(ref, "", { post: "...POST_FULL" }), ctx, POST_TASK);
  const resolved = readResolution(ref, "post", "", results, ctx, svc);
  const doc = resolved.doc as RawPostFull;
  if (doc.onlyVisibleToLoggedIn) throw loginOnly();
  return { resolved, doc };
}

/** What a later request gave: nothing sent, a stop (deadline or cap), a failure of the whole request, or its answer. */
type Sent = { kind: "none" } | { kind: "stopped" } | { kind: "failed"; error: ToolError } | { kind: "ok"; results: AliasResults };

/** One request, sent only while a request may start; a `ToolError` is that request's failure (¶7: a later part, `Partial:`). */
async function send(ops: readonly GqlOp[], task: string, ctx: CallContext, svc: Services): Promise<Sent> {
  if (ops.length === 0) return { kind: "none" };
  if (!ctx.mayStartRequest()) return { kind: "stopped" };
  try {
    return { kind: "ok", results: await svc.gql(ops, ctx, task) };
  } catch (e) {
    if (e instanceof CallStopped) return { kind: "stopped" };
    if (isToolError(e)) return { kind: "failed", error: e };
    throw e;
  }
}

/** One part of a request: its data (undefined when the forum had nothing), or `ok: false` when it was not read or failed. */
type Part = { ok: true; data: unknown } | { ok: false };

/**
 * The part `alias` of `sent`, read only when `ops` asked for it. A failure of the whole request or of the alias adds its
 * `Partial:` line to `partials`; the forum's "nothing here" (`not_found`, `not_public`) is no data. A stopped or unsent request
 * is not read, and says nothing.
 */
function partOf(sent: Sent, ops: readonly GqlOp[], alias: string, section: string, partials: string[]): Part {
  if (!ops.some((o) => o.alias === alias) || sent.kind === "none" || sent.kind === "stopped") return { ok: false };
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

// the canonical sequence (steps 4–5)

/** `"<title>" (sequence_id …[, not in the site's sequence lists])` (P4, D7). */
function sequenceText(s: CanonicalSequence): string {
  return `${quoted(s.title, TITLE_CAP)} (sequence_id ${s._id}${s.hidden ? `, ${FLAG.HIDDEN_SEQUENCE}` : ""})`;
}

interface SequenceOutcome { line?: string; stopped: boolean }

/**
 * Where the collections listing comes from: request 2's `col` alias (read or failed; `part` is read, and a failure's `Partial:`
 * line added, only when a neighbour outside the sequence is wanted), or the `collections` cache.
 */
type ListingSource = { asked: true; part: () => Part; results?: AliasResults } | { asked: false };

/**
 * Steps 4–5: the canonical sequence line. Membership is checked in the chapter list (the stored pointer is historical, Q50.14);
 * previous and next are the post's neighbours in the view order (Q101). At an end, in a collection whose books are all
 * numbered, the neighbour is the last or first post of the adjacent sequence, read by request 3; with unnumbered books
 * (bestoflesswrong) none can be named and the line says so.
 */
async function sequenceOutcome(
  doc: RawPostFull, seq: CanonicalSequence, chapters: Part, listing: ListingSource, partials: string[], ctx: CallContext, svc: Services,
): Promise<SequenceOutcome> {
  const named = sequenceText(seq);
  if (!chapters.ok) return { line: `Canonical sequence: ${named}`, stopped: false };
  const at = neighbours(readingOrder(rowsOf<RawChapter>(chapters.data)), doc._id);
  if (at === undefined) {
    return { line: `The site's stored canonical-sequence pointer names ${named}, but this post is not currently in that sequence.`, stopped: false };
  }
  const shown: Partial<Record<Dir, string>> = {};
  if (at.prev !== undefined) shown.prev = `previous: ${postRefText(maskPostRef(at.prev.post))}`;
  if (at.next !== undefined) shown.next = `next: ${postRefText(maskPostRef(at.next.post))}`;
  const ends = (["prev", "next"] as const).filter((dir) => shown[dir] === undefined);
  const slug = doc.canonicalCollectionSlug?.trim() ?? "";
  let stopped = false;

  if (ends.length > 0 && slug !== "") {
    // A `col` alias that failed adds its Partial line here, where the listing is needed; an unasked listing is read from the
    // cache only, never sent.
    const readable = listing.asked ? listing.part().ok : collectionsCached(svc);
    const collection = readable
      ? (await loadCollectionsListing(ctx, svc, listing.asked ? listing.results : undefined)).find((c) => c.slug === slug)
      : undefined;
    if (collection !== undefined) {
      const wanted: { dir: Dir; id: string }[] = [];
      for (const dir of ends) {
        const adjacent = adjacentSequence(collection, seq._id, dir);
        if (!adjacent.reliable) {
          shown[dir] = `the ${DIR_WORD[dir]} sequence of ${oneLine(collection.slug, NAME_CAP)} ${UNORDERED}`;
        } else if (adjacent.id !== undefined) {
          wanted.push({ dir, id: adjacent.id });
        }
      }
      // P17: an adjacent sequence is a `Book.sequences` row of the listing, so it is confirmed public here.
      const ops = wanted.map((w) => neighbourChaptersOp(NEIGHBOUR_ALIAS[w.dir], ctx.confirmPublic("sequence", w.id)));
      const sent = await send(ops, NEIGHBOUR_TASK, ctx, svc);
      if (sent.kind === "stopped") stopped = true;
      const failures: string[] = [];
      for (const w of wanted) {
        const part = partOf(sent, ops, NEIGHBOUR_ALIAS[w.dir], SECTION.neighbour, failures);
        if (!part.ok) continue;
        const order = readingOrder(rowsOf<RawChapter>(part.data));
        const post = w.dir === "next" ? order[0] : order.at(-1);
        if (post === undefined) continue;
        shown[w.dir] = `${DIR_WORD[w.dir]}: ${crossText(post.post, w.dir, collection.slug, bookSequenceTitle(collection, w.id))}`;
      }
      // One section: request 3 reads both ends, and its failure is one Partial line.
      if (failures.length > 0) partials.push(failures[0]!);
    }
  }
  const parts = [`Canonical sequence: ${named}`, ...(["prev", "next"] as const).flatMap((dir) => (shown[dir] === undefined ? [] : [shown[dir]!]))];
  return { line: parts.join(SEP), stopped };
}

// the context lines (step 7, the output layout)

/** `Published … · last edited … (v…) · ~N words · karma … (… votes) · <AF block> · <status flags>[ · originally on Overcoming Bias]`. */
function publishedLine(doc: RawPostFull, rec: PostRecord, body: ProcessedBody | undefined): string {
  const facts = [`Published ${day(doc.postedAt)}`];
  const contents = doc.contents;
  if (contents != null && Number.isFinite(Date.parse(contents.editedAt))) {
    facts.push(`last edited ${day(contents.editedAt)} (v${oneLine(contents.version, VERSION_CAP)})`);
  }
  if (body !== undefined) facts.push(`~${counted(body.words, "word")}`);
  facts.push(`karma ${fmtInt(rec.karma)} (${counted(rec.votes, "vote")})`, afBlock(rec), ...statusTexts(rec.status));
  if (doc.legacy && rec.postedMs < OVERCOMING_BIAS_BEFORE_MS) facts.push("originally on Overcoming Bias");
  return facts.join(SEP);
}

/** ¶3.8.1: the visible tags by relevance with their number, at most 6, then `+N more` (P12: hidden tags are already gone). */
function tagsLine(rec: PostRecord): string | undefined {
  if (rec.tags.length === 0) return undefined;
  const shown = rec.tags.slice(0, TAGS_SHOWN).map(({ tag, relevance }) => `${quoted(tag.name, NAME_CAP)} ${fmtInt(relevance)} (tag_slug ${tag.slug})`);
  const rest = rec.tags.length - TAGS_SHOWN;
  if (rest > 0) shown.push(`+${fmtInt(rest)} more`);
  return `Tags (relevance): ${shown.join(SEP)}`;
}

/**
 * Q111, P1, P14: `sourcePostRelations` are the parent questions (the name reads backwards) and `targetPostRelations` the
 * sub-questions; a null or hidden post is left out.
 */
function relatedLine(doc: RawPostFull): string | undefined {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (label: string, p: RawPostRef | null): void => {
    const ref = maskPostRef(p);
    if (ref.hidden || seen.has(ref.id)) return;
    seen.add(ref.id);
    parts.push(`${label} ${postRefText(ref)}`);
  };
  for (const r of doc.sourcePostRelations ?? []) add("parent", r.sourcePost);
  for (const r of doc.targetPostRelations ?? []) add("sub-question", r.targetPost);
  return parts.length === 0 ? undefined : `Related questions: ${parts.join(SEP)}`;
}

/** P18: `karma N`, or `karma not publicly visible` (never 0) when the comment's or the post's karma is hidden. */
function commentKarma(c: { baseScore: number | null; hideKarma: boolean }, doc: RawPostFull): string {
  return c.hideKarma || doc.hideCommentKarma || c.baseScore === null ? FLAG.KARMA_HIDDEN : `karma ${fmtInt(c.baseScore)}`;
}

/** P2, P5, P7, P18: the best answer with its id, AF status and author; a placeholder names only its reason; a hidden one nothing. */
function bestAnswerLine(doc: RawPostFull): string | undefined {
  const a = doc.bestAnswer;
  if (!commentPublic(a)) return undefined;
  const ref = commentRefText({ id: a._id, af: a.af });
  if (isPlaceholder(a)) return `Best answer: ${ref}${SEP}${FLAG.deletedPlaceholder(a.deletedReason)}`;
  const who = personText(authorOf(a.user, { hideAuthor: a.hideAuthor }));
  return `Best answer: ${ref} by ${who} (${commentKarma({ baseScore: a.baseScore ?? null, hideKarma: a.hideKarma }, doc)})`;
}

/** `  review (<year>) by <person> · karma … · comment_id … (AF | LW only)`; a placeholder names only its reason (P5). */
function reviewLine(c: ReviewRow, doc: RawPostFull): string {
  const year = oneLine(c.reviewingForReview, NAME_CAP);
  const head = `  ${year === "" ? "review" : FLAG.review(year)}`;
  const ref = commentRefText({ id: c._id, af: c.af });
  if (isPlaceholder(c)) return [head, FLAG.deletedPlaceholder(c.deletedReason), ref].join(SEP);
  return [`${head} by ${personText(authorOf(c.user, { hideAuthor: c.hideAuthor }))}`, commentKarma(c, doc), ref].join(SEP);
}

/** `Annual Review: N reviews · final vote score … · AF final vote score …` when any is non-zero (§14.6); a head line. */
function annualReviewLine(doc: RawPostFull): string | undefined {
  const facts: string[] = [];
  if (doc.reviewCount > 0) facts.push(counted(doc.reviewCount, "review"));
  if (doc.finalReviewVoteScoreHighKarma) facts.push(`final vote score ${score(doc.finalReviewVoteScoreHighKarma)}`);
  if (doc.finalReviewVoteScoreAF) facts.push(`AF final vote score ${score(doc.finalReviewVoteScoreAF)}`);
  return facts.length === 0 ? undefined : `Annual Review: ${facts.join(SEP)}`;
}

/**
 * The review lines as a capped block resumed at `from` (¶4.3 step 7, Paging): one line per visible review, and after a
 * full answer of 50 rows the line saying more may exist. Undefined when there is nothing to list.
 */
function reviewsBlock(doc: RawPostFull, rows: readonly ReviewRow[], from: number): ContextBlock | undefined {
  const visible = rows.filter(commentPublic);
  const lines = visible.map((r) => reviewLine(r, doc));
  if (rows.length >= REVIEWS_LIMIT) lines.push(MORE_REVIEWS);
  if (lines.length === 0) return undefined;
  return { key: "reviews", title: `Reviews (${fmtInt(visible.length)}):`, lines, share: CONTEXT_BLOCK_SHARE, from };
}

/** P15: only the terms the author approved and kept, one per line with its definition, as a capped block resumed at `from`. */
function glossaryBlock(doc: RawPostFull, from: number): ContextBlock | undefined {
  const lines = (doc.glossary ?? []).filter(glossaryTermPublic).map((t) => {
    const term = quoted(t.term, NAME_CAP);
    const definition = oneLine(t.contents?.markdown, TITLE_CAP);
    return `  ${definition === "" ? term : `${term} — ${definition}`}`;
  });
  if (lines.length === 0) return undefined;
  return { key: "glossary", title: "Glossary:", lines, share: CONTEXT_BLOCK_SHARE, from };
}

interface ContextInput {
  doc: RawPostFull;
  rec: PostRecord;
  id: PublicPostId;
  body?: ProcessedBody;
  sequenceLine?: string;
}

/**
 * The context lines of the first page, in the order of ¶4.3's output layout, each one bounded line. The review lines and
 * the glossary are not among them: they are capped blocks, which the layout prints after the head (`reviewsBlock`,
 * `glossaryBlock`).
 */
function contextLines(x: ContextInput): string[] {
  const { doc, rec, id } = x;
  // P7: people come from `authors` only (an anonymous post names nobody).
  const authors = rec.authors.map(personText).join(", ");
  const lines = [
    `Post ${quoted(rec.title, TITLE_CAP)}${authors === "" ? "" : ` — ${authors}`}`, `post_id ${id}${SEP}${rec.url}`, publishedLine(doc, rec, x.body),
  ];
  const optional = [tagsLine(rec), x.sequenceLine, relatedLine(doc), bestAnswerLine(doc), annualReviewLine(doc)];
  lines.push(...optional.filter((l): l is string => l !== undefined));
  // P11, Q50.11: reactions with a net above 0; posts have no agreement axis.
  const reacts = reactSummary(visibleReacts(parseReactions(doc.extendedScore)));
  if (reacts !== "") lines.push(`Reactions: ${reacts} (details: get_reactions {post: "${id}"})`);
  lines.push(`Comments: ~${fmtInt(doc.commentCount)} (site counter) — get_comments {post: "${id}"}`);
  return lines;
}

// the text (step 6)

/** `This post has no body text.`, and for a linkpost `It links to <url>.` (the URL on one line, as FLAG.linkpost prints it). */
function emptyBodyLine(doc: RawPostFull): string {
  const url = oneLine(doc.url, TITLE_CAP);
  return url === "" ? "This post has no body text." : `This post has no body text. It links to ${url}.`;
}

/**
 * Q53, Q109, P5, P7: a debate turn, by its author or as a placeholder, without turn karma; its text quoted. A turn the page
 * cuts resumes on the next page under its own first line (¶3.7 rule 3).
 */
function turnItem(c: TurnRow, n: number): PageItem {
  const placeholder = isPlaceholder(c);
  const who = placeholder ? FLAG.deletedPlaceholder(c.deletedReason) : personText(authorOf(c.user, { hideAuthor: c.hideAuthor }));
  const head = [`▶ turn ${n}`, who, minute(c.postedAt), commentRefText({ id: c._id, af: c.af })].join(SEP);
  const markdown = c.contents?.markdown;
  return { text: placeholder || markdown == null || markdown.trim() === "" ? head : `${head}\n${quote(markdown)}`, header: head };
}

/** The items of the text, and the head lines that belong to it (the empty-body line, the match line). */
function textOf(
  doc: RawPostFull, id: PublicPostId, ask: Ask, body: ProcessedBody | undefined, turns: readonly TurnRow[],
): { items: PageItem[]; head: string[] } {
  if (!ask.includeBody) return { items: [], head: [] };
  const md = blockText(body?.md);
  const label = `post_id ${id}, v${oneLine(body?.version, VERSION_CAP)}`;
  if (ask.section !== undefined) {
    return { items: [{ text: sliceSection(md, ask.section, "post"), fence: `${label}, section ${ask.section}` }], head: [] };
  }
  if (ask.match !== undefined) {
    const { total, hits } = matchInText(md, ask.match);
    return { items: hits.map(matchHitItem), head: [matchLine(hits.length, total, "paragraphs", ask.match)] };
  }
  const empty = md.trim() === "";
  const items: PageItem[] = empty ? [] : [{ text: md, fence: label }];
  items.push(...turns.map((t, i) => turnItem(t, i + 1)));
  return { items, head: empty ? [emptyBodyLine(doc)] : [] };
}

/** The `contents.html` of the `h` alias (`{ result: { _id, contents: { html } } }`), when it is a string. */
function htmlOf(data: unknown): string | undefined {
  const result = isRecord(data) ? data.result : undefined;
  const contents = isRecord(result) ? result.contents : undefined;
  return isRecord(contents) && typeof contents.html === "string" ? contents.html : undefined;
}

/** Q50.15 (¶4.3 Paging): the post changed between pages; the cursor's character position is kept. */
function editedNote(version: string | undefined): string {
  return `This post was edited since the previous page (now v${oneLine(version, VERSION_CAP)}); continuing at the same character position.`;
}

// one page

interface PageInput {
  resolved: Resolved;
  doc: RawPostFull;
  ask: Ask;
  start?: SliceState;               // where a continuation starts; undefined on a page that shows the context lines
  resume?: BlockResume;             // a continuation's unfinished context blocks and the lines they resume at
  echo: CallContext;                // its `given` decides the request echo's `(default)` marks
  args: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** Step 2, Q96: a quick-takes container has no body; its quick takes are comments. */
function containerReply(input: PageInput, subject: string, request: string[], maxTokens: number, svc: Services): ToolOutput {
  const { doc } = input;
  const owner = authorOf(doc.user, { hideAuthor: doc.hideAuthor });
  const text = owner.kind === "user" && owner.slug
    ? `This is ${quoted(owner.name, NAME_CAP)}'s quick-takes container; it has no body. Its quick takes are comments: list_comments {user: ${JSON.stringify(owner.slug)}, quick_takes_only: true}.`
    : "This is a quick-takes container; it has no body. Its quick takes are comments.";
  return reply({ tool: "get_post", subject, request, notes: [], head: [text], items: [] }, maxTokens, svc, () => ({ kind: "end" }));
}

async function postPage(input: PageInput, maxTokens: number, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const { doc, ask, start } = input;
  const subject = quoted(doc.title, TITLE_CAP);
  const request = requestEcho(input.resolved, ask, input.echo);
  if (doc.shortform) return containerReply(input, subject, request, maxTokens, svc);

  const id = ctx.confirmPublic("post", doc._id);
  const first = start === undefined;
  const resume = input.resume ?? {};
  const contents = doc.contents;
  const version = contents?.version;
  const bodyKey = `${id}@${version ?? ""}`;
  const cached = contents == null ? undefined : svc.caches.get<ProcessedBody>("body", bodyKey);
  // Q53, Q109: the turns of the 6 debate posts follow the whole body (not a section or the matches).
  const debate = ask.includeBody && ask.section === undefined && ask.match === undefined && (CONFIG.debatePostIds as readonly string[]).includes(id);
  // P17: the joined canonical sequence came back, so it is public (a hidden one too, P4).
  const seq = first && doc.canonicalSequenceId != null && sequencePublic(doc.canonicalSequence) ? doc.canonicalSequence : undefined;
  const sequenceId = seq === undefined ? undefined : ctx.confirmPublic("sequence", seq._id);
  // P7: an anonymous dialogue is read as plain Markdown (its turns in order, no labels).
  const dialogue = doc.collabEditorDialogue && !doc.hideAuthor;
  const ops = getPostRequest2Ops({
    postId: id,
    // A continuation reads the reviews again only while their block is unfinished (≤ 3 requests a call).
    reviews: first ? doc.reviewCount > 0 : resume.reviews !== undefined,
    debate,
    html: contents != null && cached === undefined && needsHtml(contents.markdown, contents.originalContents?.type, dialogue),
    ...(sequenceId !== undefined && { sequenceId }),
    listing: sequenceId !== undefined && (doc.canonicalCollectionSlug?.trim() ?? "") !== "" && !collectionsCached(svc),
  });
  const sent = await send(ops, PARTS_TASK, ctx, svc);
  let stopped = sent.kind === "stopped";

  // Request 2's parts, in request order, so that the Partial lines are too.
  const partials: string[] = [];
  const part = (alias: string, section: string): Part => partOf(sent, ops, alias, section, partials);
  const rv = part("rv", SECTION.reviews);
  const dt = part("dt", SECTION.turns);
  const h = part("h", dialogue ? SECTION.speakers : SECTION.html);
  const ch = part("ch", SECTION.sequence);
  const listing: ListingSource = ops.some((o) => o.alias === "col")
    ? { asked: true, part: () => part("col", SECTION.neighbour), ...(sent.kind === "ok" && { results: sent.results }) }
    : { asked: false };

  const htmlNeeded = ops.some((o) => o.alias === "h");
  const html = h.ok ? htmlOf(h.data) : undefined;
  let body = cached;
  if (body === undefined && contents != null) {
    body = processBody({
      markdown: contents.markdown, ...(html !== undefined && { html }), type: contents.originalContents?.type, dialogue, version: contents.version,
    });
    // A body processed without the HTML it needed (Partial, or stopped) is shown but never cached.
    if (!htmlNeeded || html !== undefined) svc.caches.set("body", bodyKey, body);
  }
  const turns = dt.ok ? rowsOf<TurnRow>(dt.data).filter(commentPublic).sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt)) : [];

  let sequenceLine: string | undefined;
  if (seq !== undefined) {
    if (sent.kind === "stopped") {
      sequenceLine = `Canonical sequence: ${sequenceText(seq)}`;
    } else {
      const outcome = await sequenceOutcome(doc, seq, ch, listing, partials, ctx, svc);
      sequenceLine = outcome.line;
      stopped ||= outcome.stopped;
    }
  }

  const notes: string[] = [];
  if (first) {
    notes.push(CAVEAT["C-COUNTER"]);
    if (doc.af) notes.push(CAVEAT["C-KARMA"]);
    if (doc.frontpageDate == null) notes.push(CAVEAT["C-FRONTPAGE"]);
    if (doc.legacy) notes.push(CAVEAT["C-PRE2019"]);
  }
  // The first page leads with the context lines; a continuation only says when the text changed since the previous page.
  const edited = start?.version !== undefined && version !== undefined && start.version !== version;
  const lead = first
    ? contextLines({ doc, rec: toPostRecord(doc), id, ...(body !== undefined && { body }), ...(sequenceLine !== undefined && { sequenceLine }) })
    : edited ? [editedNote(version)] : [];

  // ¶4.3 Paging: the review lines and the glossary are capped blocks, the first page's from their start and a
  // continuation's from where each stopped. A continuation shows only the blocks left unfinished: the reviews when `rv`
  // was asked again (a failure is its Partial line, and the block is dropped), the glossary from request 1.
  const blocks = [
    rv.ok ? reviewsBlock(doc, rowsOf<ReviewRow>(rv.data), resume.reviews ?? 0) : undefined,
    first || resume.glossary !== undefined ? glossaryBlock(doc, resume.glossary ?? 0) : undefined,
  ].filter((b): b is ContextBlock => b !== undefined);

  if (stopped) {
    // ¶3.6: a stop is not an error; the page holds what arrived, and the cursor continues where this page started: on the
    // first page, the first page again with its context lines and blocks from their start (`restart`); on a continuation,
    // the same stream and block indices it was given.
    const state: CursorState = first
      ? { streams: [{ kind: "slice", shown: 0, block: 0, offset: 0, ...(version !== undefined && { version }) }], current: 0, data: { restart: 1 } }
      : { streams: [start], current: 0, ...(Object.keys(resume).length > 0 && { data: { ...resume } }) };
    const shown = first ? { blocks } : {};
    return reply({ tool: "get_post", subject, request, notes, head: [...lead, ...partials], ...shown, items: [] }, maxTokens, svc, () => ({
      kind: "stopped", why: ctx.stopped ?? "time limit", tool: "get_post", cursor: mint(svc, "get_post", input.args, input.effective, state),
    }));
  }

  const text = textOf(doc, id, ask, body, turns);
  // The slice stream: the items from where this page starts, the first resumed inside its text. A continuation whose
  // stream points past the last item shows only the blocks left, so nothing of the text (position, its notes) is printed.
  const slice = slicePosition(text.items, start);
  const showsText = first || (start?.block ?? 0) < text.items.length;
  if (ask.includeBody && body !== undefined && showsText) {
    if (body.footnotes) notes.push(CAVEAT["C-FOOTNOTES"]);
  }
  const position = showsText ? slice.position : undefined;

  // The match line heads every page of the matches; the empty-body line belongs to the first page.
  const textHead = first || (ask.match !== undefined && showsText) ? text.head : [];
  // ¶3.7: the post is one item, however many slice items (body, turns, hits) carry its text, so a first page that shows them
  // all whole prints no `Position: text 1–100 %` (as get_tag); a cut page and every continuation keep the line.
  const spec = (head: readonly string[]): PageSpec => ({
    tool: "get_post", subject, request, ...(position !== undefined && { position }), oneItem: first, notes,
    head: [...lead, ...partials, ...head, ...textHead], blocks, items: slice.items,
  });
  // ¶3.7: the outline is shown on the first page when the text does not fit it, has more than 3 headings, or is not shown.
  const headings = body?.headings ?? [];
  const outline = first && headings.length > 0 && (headings.length > 3 || !ask.includeBody || !fitsWhole(spec([]), maxTokens));

  // The page ends only when the text and every block are finished. Otherwise the cursor keeps the slice stream (past the
  // last item once the text is finished) and, in its data, the line each unfinished block resumes at; `next:` names the
  // first unfinished block, else the text.
  const footerFor = (c: Consumed): Footer => {
    const open = blocks.flatMap((b) => {
      const at = c.blocks[b.key] ?? b.from;
      return at < b.lines.length ? [{ key: b.key, at }] : [];
    });
    const next = sliceAfter(c, start, text.items.length, version);
    if (next === undefined && open.length === 0) return { kind: "end" };
    const stream: SliceState = next ?? {
      kind: "slice", shown: (start?.shown ?? 0) + c.items, block: text.items.length, offset: 0, ...(version !== undefined && { version }),
    };
    const data = Object.fromEntries(open.map((b) => [b.key, b.at]));
    const cursor = mint(svc, "get_post", input.args, input.effective, { streams: [stream], current: 0, ...(open.length > 0 && { data }) });
    const pending = open[0];
    const nextText = pending !== undefined ? BLOCK_NEXT[pending.key](pending.at) : slice.next(c);
    return { kind: "more", tool: "get_post", cursor, next: nextText };
  };
  return reply(spec(outline ? [textOutlineLine(headings, maxTokens)] : []), maxTokens, svc, footerFor);
}

/** The block indices a cursor's data holds (whole numbers only; anything else is no index). */
function resumeOf(data: Readonly<Record<string, unknown>>): BlockResume {
  const resume: BlockResume = {};
  for (const key of BLOCK_KEYS) {
    const at = data[key];
    if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) resume[key] = at;
  }
  return resume;
}

// first page and continuation

async function firstPage(p: GetPostParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const ref = parseRef("post", p.post!, ["post"]);
  const { resolved, doc } = await readPost(ref, ctx, svc);
  const ask: Ask = { section: p.section, match: p.match, includeBody: p.include_body };
  const args = givenArgs(p, ctx);
  return postPage({ resolved, doc, ask, echo: ctx, args, effective: effectiveOf(resolved.id, ask) }, p.max_tokens, ctx, svc);
}

async function continuation(entry: CursorEntry, p: GetPostParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const stored = entry.effective as { post: string; section?: number; match?: string; include_body: boolean };
  // ¶3.6: a `post` given again is resolved by the same request that re-checks visibility (D1), then compared by id. Without
  // one, the caller's first string is read again (as get_tag and get_user do), so the request repeats page 1's, which the
  // raw-response cache usually answers; the stored id stands in only for a cursor whose first call gave no string.
  const firstPost = typeof entry.args.post === "string" ? entry.args.post : stored.post;
  const ref = parseRef("post", ctx.given.has("post") && p.post !== undefined ? p.post : firstPost, ["post"]);
  const { resolved, doc } = await readPost(ref, ctx, svc);
  checkContinuation(entry, effectiveOf(resolved.id, { section: p.section, match: p.match, includeBody: p.include_body }), ctx);
  // The string now resolves elsewhere (a slug moved, or a bare id also tried as a slug): the cursor's post is gone.
  if (resolved.id !== stored.post) throw notFound("post", "id", stored.post);
  const state = entry.state.streams[entry.state.current] as SliceState;
  const data = isRecord(entry.state.data) ? entry.state.data : {};
  // A restart shows the first page again, its context lines and blocks from their start, so no block index is read.
  const restart = data.restart === 1;
  return postPage(
    {
      resolved, doc, ask: { section: stored.section, match: stored.match, includeBody: stored.include_body },
      ...(!restart && { start: state, resume: resumeOf(data) }),
      echo: { ...ctx, given: new Set([...ctx.given, ...Object.keys(entry.args)]) },
      args: { ...entry.args }, effective: { ...entry.effective },
    },
    p.max_tokens, ctx, svc,
  );
}

// the tool

const schema = z.strictObject({
  post: P.post().optional(),
  section: P.section().optional(),
  match: P.match().optional(),
  include_body: P.flag("include_body"),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetPostParams> = {
  name: "get_post",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  required: ["post"],
  run(p, ctx, svc) {
    if (p.section !== undefined && p.match !== undefined) throw badInput("match", "can't be combined with section", "Give section or match, not both.");
    const entry = openContinuation("get_post", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
