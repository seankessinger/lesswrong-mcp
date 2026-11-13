// Layer 2. The `get_post` tool (¶4.3): one post in full. Request 1 reads the post with POST_FULL through its resolution
// aliases, which is also its visibility check (P17); its outcomes and wording are `ids/resolve`'s. A quick-takes container
// gets the short answer of step 2. Request 2, one batch with each part only when it is needed, reads the review comments, the
// debate turns, the canonical sequence's chapters and the collections listing;
// request 3 reads the adjacent sequence's chapters to name a neighbour at a sequence boundary, only while a request may start
// (step 4). Once the post is confirmed, a part that fails is a `Partial:`
// line and the rest is returned (¶3.9, ¶8); a deadline or cap stop ends the page with `Stopped early`. The body is the post's page
// as Markdown (`pageText`): POST_FULL reads `contents.html`, never the forum's Markdown, and a post with no page shows no text. It
// goes through
// the pipeline of step 6 once per version (the `body` cache, `<postId>@<version>`) and is shown
// whole, as one section, or as the paragraphs that match; the debate turns follow it. Paging (¶4.3, ¶3.6) is a `slice`
// stream over the body and the turns, next to the two context parts that have no bound of their own, the review lines and
// the glossary: each is a capped block, and the cursor's data keeps the line each unfinished one resumes at. The other
// context lines are one bounded line each and are shown on the first page only. A continuation re-reads the post (the
// visibility re-check), shows the unfinished blocks from where they stopped before the text, and says so when the post's
// version changed (Q50.15).
import { z } from "zod";
import { CONFIG } from "../config";
import { matchInText, pageText, processBody, sliceSection, type ProcessedBody } from "../domain/markdown";
import { toPostRecord } from "../domain/posts";
import { parseReactions, reactSummary, visibleReacts } from "../domain/reactions";
import { adjacentSequence, neighbours, readingOrder } from "../domain/sequences";
import { authorOf, commentPublic, glossaryTermPublic, isPlaceholder, maskPostRef, sequencePublic } from "../domain/visibility";
import { badInput, loginOnly, notFound } from "../errors";
import { getPostRequest2Ops, neighbourChaptersOp } from "../forum/templates/get_post";
import { parseRef } from "../ids/parse";
import { echoOf, readResolution, resolutionOps, throwRemembered } from "../ids/resolve";
import { sliceAfter, slicePosition } from "../paging/pager";
import { FORUM_TEXT, P } from "../params/vocabulary";
import { fitsWhole } from "../render/layout";
import { CAVEAT, FLAG, fmtInt, matchLine } from "../render/messages";
import { IMPORTED_BEFORE_MS } from "../domain/revisions";
import { afBlock, commentRefText, counted, matchHitItem, personText, postRefText, quote, statusTexts, tagsText, textOutlineLine } from "../render/records";
import { day, minute } from "../text/dates";
import { blockText, oneLine } from "../text/sanitize";
import type {
  AliasResults, CallContext, CappedBlock, Consumed, CursorEntry, CursorState, Footer, PageItem, PageSpec, ParsedRef, PostRecord,
  PublicPostId, RawChapter, RawCommentRef, RawPostFull, RawPostRef, Resolved, Services, StreamState, ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, givenArgs, isRecord, mint, openContinuation, reply, resumedFrom, rowsOf, setting } from "./common";
import {
  bookSequenceRow, collectionsCached, crossText, DIR_WORD, loadCollectionsListing, partOf, send, UNORDERED, type Dir, type Part,
} from "./loaders";

type GetPostParams = { post?: string; section?: number; match?: string; include_body: boolean; cursor?: string; max_tokens: number };

type SliceState = Extract<StreamState, { kind: "slice" }>;
type ReviewRow = RawCommentRef & { baseScore: number | null; reviewingForReview: string | null };
type TurnRow = RawCommentRef & { contents: { markdown: string | null } | null };
type CanonicalSequence = NonNullable<RawPostFull["canonicalSequence"]>;

const TITLE = "What does this post say, and what is its status?";
/** ¶4.3, verbatim. */
const DESCRIPTION_QUOTE =
  "Read one post: metadata, status and text. post = id, URL or exact current slug (renamed posts lose their earlier slugs; a comment link opens its post). Returns title, authors including coauthors, publication date, last-edit date and version, karma and vote count (both usually include the author's automatic self-vote), AF status with AF karma and AF comment count, the comment count (~), status (curated, frontpage or not, pinned, Best of LessWrong, question, linkpost, dialogue, debate, event), tags ordered by relevance (a weighted vote score, shown), Annual Review results and the post's review comments (with ids), the post's glossary, a summary of reader reactions, related questions, the best answer of a question post, the site's canonical sequence for the post with the previous and next post in the order of that sequence's chapter list (at the ends, the neighbouring sequence of its collection, unless that crosses books that tie; the site's next and previous links can differ when chapters tie, and on the post's own page at the ends; a post can be in several sequences, see get_sequence), and the body as Markdown. Long bodies: the first page shows a numbered outline of headings; read one with section=<number>, or continue with the cursor. match=<text> returns only the paragraphs containing that text as whole words (case and accents ignored, punctuation read as a space). include_body=false returns everything but the text. Interactive widgets are omitted; the text is read from the post's page, as a logged-out reader sees it, and if the page can't be read the text is not shown; dialogues show speaker names, and text between messages is marked as outside the dialogue; an old-style debate's turns follow its body, which its page replaces with them. Answers and comments are in get_comments. A post the forum refuses to logged-out readers gives not_public; a post for logged-in readers only gives login_only; posts reachable by link only (flagged), quick-takes containers, sub-questions and group posts open by id or any URL containing it (not by slug).";

const POST_TASK = "reading the post";
const PARTS_TASK = "reading the post's reviews, turns and sequence";
const NEIGHBOUR_TASK = "reading the neighbouring sequence";

/** The `Partial:` section of each part. */
const SECTION = {
  reviews: "reviews",
  turns: "debate turns",
  sequence: "canonical sequence",
  neighbour: "neighbouring sequence",
} as const;

const TITLE_CAP = CONFIG.render.caps.title;
const NAME_CAP = CONFIG.render.caps.name;
const VERSION_CAP = 40;
const SEP = " · ";
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
  throwRemembered(ref, svc);
  const results = await svc.gql(resolutionOps(ref, "", { post: "...POST_FULL" }), ctx, POST_TASK);
  const resolved = readResolution(ref, "post", "", results, ctx, svc);
  const doc = resolved.doc as RawPostFull;
  if (doc.onlyVisibleToLoggedIn) throw loginOnly();
  return { resolved, doc };
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
 * previous and next are the post's neighbours in the view order (Q101). At an end, in a collection, the neighbour is the last or
 * first post of the adjacent sequence (the next entry of the books' `sequenceIds`, as the site steps; a hidden one carries its
 * flag), read by request 3; across books that tie (bestoflesswrong's unnumbered ones) none can be named, and an entry the
 * listing holds no row for is not publicly visible: the line says so, and nothing of it is requested.
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
  // The site finds the collection from the sequence's own slug (getSequenceCollectionBooks), not the post's.
  const slug = seq.canonicalCollectionSlug?.trim() ?? "";
  let stopped = false;

  if (ends.length > 0 && slug !== "") {
    // A `col` alias that failed adds its Partial line here, where the listing is needed; an unasked listing is read from the
    // cache only, never sent.
    const readable = listing.asked ? listing.part().ok : collectionsCached(svc);
    const collection = readable
      ? (await loadCollectionsListing(ctx, svc, listing.asked ? listing.results : undefined)).find((c) => c.slug === slug)
      : undefined;
    if (collection !== undefined) {
      const wanted: { dir: Dir; row: { _id: string; title: string; hidden: boolean } }[] = [];
      for (const dir of ends) {
        const adjacent = adjacentSequence(collection, seq._id, dir);
        const sequenceOf = `the ${DIR_WORD[dir]} sequence of ${oneLine(collection.slug, NAME_CAP)}`;
        if (!adjacent.reliable) {
          shown[dir] = `${sequenceOf} ${UNORDERED}`;
        } else if (adjacent.id !== undefined) {
          const row = bookSequenceRow(collection, adjacent.id);
          if (row === undefined) shown[dir] = `${sequenceOf} is not publicly visible`;
          else wanted.push({ dir, row });
        }
      }
      // P17: an adjacent sequence is a `Book.sequences` row of the listing, so it is confirmed public here.
      const ops = wanted.map((w) => neighbourChaptersOp(NEIGHBOUR_ALIAS[w.dir], ctx.confirmPublic("sequence", w.row._id)));
      const sent = await send(ops, NEIGHBOUR_TASK, ctx, svc, true);
      if (sent.kind === "stopped") stopped = true;
      let failure: string | undefined;
      for (const w of wanted) {
        const part = partOf(sent, ops, NEIGHBOUR_ALIAS[w.dir], SECTION.neighbour);
        if (!part.ok) {
          failure ??= part.partial;
          continue;
        }
        const order = readingOrder(rowsOf<RawChapter>(part.data));
        const post = w.dir === "next" ? order[0] : order.at(-1);
        if (post === undefined) continue;
        shown[w.dir] = `${DIR_WORD[w.dir]}: ${crossText(post.post, w.dir, collection.slug, w.row)}`;
      }
      // One section: request 3 reads both ends, and its failure is one Partial line.
      if (failure !== undefined) partials.push(failure);
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

/** ¶3.8.1: the post's tags line (`tagsText`), or none when it has no visible tag. */
function tagsLine(rec: PostRecord): string | undefined {
  return rec.tags.length === 0 ? undefined : `Tags (relevance): ${tagsText(rec.tags)}`;
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

/** P18: `karma N`, or `karma hidden on this post` (never 0) when the comment's or the post's karma is hidden. */
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
  const event = eventLine(doc);
  if (event !== undefined) lines.push(event);
  const optional = [tagsLine(rec), x.sequenceLine, relatedLine(doc), bestAnswerLine(doc), annualReviewLine(doc)];
  lines.push(...optional.filter((l): l is string => l !== undefined));
  // P11, Q50.11: reactions with a net above 0; posts have no agreement axis.
  const reacts = reactSummary(visibleReacts(parseReactions(doc.extendedScore)));
  if (reacts !== "") lines.push(`Reactions: ${reacts} (details: get_reactions {post: "${id}"})`);
  lines.push(`Comments: ~${fmtInt(doc.commentCount)} (site counter) — get_comments {post: "${id}"}`);
  return lines;
}

// the text (step 6)

/** A text with no page in the forum's answer (`pageText`). */
const NOT_SHOWN = "The text is not shown: it is read from the post's page, and the page could not be read. Try again later.";

/**
 * #71: an event's time, its place in person or its online link (the page hides the place of an online event), and its contact, as
 * the event's page shows them (PostsPageEventData, EventTime: a range, the one time given, or TBD); times in UTC.
 */
function eventLine(doc: RawPostFull): string | undefined {
  if (!doc.isEvent) return undefined;
  const at = (iso: string | null): string | undefined => (iso != null && Number.isFinite(Date.parse(iso)) ? minute(iso) : undefined);
  const start = at(doc.startTime);
  const end = at(doc.endTime);
  const time = start !== undefined && end !== undefined ? `${start} to ${end}` : start ?? end ?? "time TBD";
  const link = oneLine(doc.joinEventLink, TITLE_CAP);
  const place = doc.onlineEvent ? (link === "" ? "online" : `online at ${link}`)
    : oneLine(doc.location, TITLE_CAP) === "" ? undefined : `at ${quoted(doc.location, TITLE_CAP)}`;
  const contact = oneLine(doc.contactInfo, TITLE_CAP) === "" ? undefined : `contact ${quoted(doc.contactInfo, TITLE_CAP)}`;
  return [`Event: ${time}`, place, contact].filter((p): p is string => p !== undefined).join(SEP);
}

/**
 * #164: the forum's API returns no current text (null contents) when the current version is not public or missing (make_editable,
 * revisionCheckAccess): the text is not shown, and its public versions are listed by get_history.
 */
function noCurrentText(doc: RawPostFull, id: PublicPostId): string {
  const line = `The text is not shown here: the forum's API gives logged-out readers no current version of this post. Its public versions, if any: get_history {post: "${id}"}.`;
  const url = oneLine(doc.url, TITLE_CAP);
  return url === "" ? line : `${line} It links to ${url}.`;
}

/** #48: a debate's turns are read only for the whole post, so match and section say they are left out. */
const TURNS_LEFT_OUT = "Its debate turns are not searched or shown with section or match: read the post without either to see them.";

/**
 * An old-style debate post's page shows its turns in place of the post's own body (PostsPage: `!post.debate` guards the body; its
 * sidebar table of contents can still list the body's headings, so "only" would overstate). "Read", not "shown": an outline-only or
 * stopped first page shows none of the body's text, only its words or outline. The
 * debate editor asked authors to write their first dialogue comment in that body (debateEditorPlaceholder), so it was meant to be
 * read, and the forum still publishes it: search snippets, feed previews, RSS and its revision pages. So it is read, and the first
 * page of every read that uses it (its words, text, section, matches or outline) says so.
 */
const DEBATE_BODY = "Old-style debate post: its page shows the debate turns in place of the post's own body, where the debate editor asked authors to write their first dialogue comment. That body is read here; the forum still publishes it (in search results, for one).";

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
  doc: RawPostFull, id: PublicPostId, ask: Ask, body: ProcessedBody | undefined, turns: readonly TurnRow[], withheld: boolean,
): { items: PageItem[]; head: string[] } {
  if (!ask.includeBody) return { items: [], head: [] };
  // #48: a debate's turns are read only for the whole post, so a section or a match says they are left out.
  const left = doc.debate === true && (ask.section !== undefined || ask.match !== undefined) ? [TURNS_LEFT_OUT] : [];
  if (withheld) return { items: turns.map((t, i) => turnItem(t, i + 1)), head: [NOT_SHOWN, ...left] };
  if (doc.contents == null) return { items: turns.map((t, i) => turnItem(t, i + 1)), head: [noCurrentText(doc, id), ...left] };
  const md = blockText(body?.md);
  const label = `post_id ${id}, v${oneLine(body?.version, VERSION_CAP)}`;
  // #75: a named dialogue's speaker labels, as its text was written (no headings and no paragraphs of it).
  const labels = new Set(body?.labels ?? []);
  if (ask.section !== undefined) {
    const sliced = sliceSection(md, ask.section, "post", labels, new Set(body?.turnEnds ?? []));
    return { items: [{ text: sliced, fence: `${label}, section ${ask.section}` }], head: left };
  }
  if (ask.match !== undefined) {
    const { total, hits } = matchInText(md, ask.match, labels);
    return { items: hits.map(matchHitItem), head: [matchLine(hits.length, total, "paragraphs", ask.match), ...left] };
  }
  const empty = md.trim() === "";
  const items: PageItem[] = empty ? [] : [{ text: md, fence: label }];
  items.push(...turns.map((t, i) => turnItem(t, i + 1)));
  return { items, head: empty ? [emptyBodyLine(doc)] : [] };
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
  // An anonymous dialogue's body has no speakers, so a post that became one keeps no body that has them.
  const bodyKey = `${id}@${version ?? ""}${doc.collabEditorDialogue && doc.hideAuthor ? "#anonymous" : ""}`;
  const cached = contents == null ? undefined : svc.caches.get<ProcessedBody>("body", bodyKey);
  // Q53, Q109, #109: an old-style debate's turns follow the whole body (not a section or the matches); a post is one when its own
  // `debate` flag is set, as the site's page decides.
  const debate = ask.includeBody && ask.section === undefined && ask.match === undefined && doc.debate === true;
  // P17: the joined canonical sequence came back, so it is public (a hidden one too, P4).
  const seq = first && doc.canonicalSequenceId != null && sequencePublic(doc.canonicalSequence) ? doc.canonicalSequence : undefined;
  const sequenceId = seq === undefined ? undefined : ctx.confirmPublic("sequence", seq._id);
  // P7: an anonymous dialogue's turns are in order, with no labels.
  const speakers = doc.collabEditorDialogue && !doc.hideAuthor;
  const ops = getPostRequest2Ops({
    postId: id,
    // A continuation reads the reviews again only while their block is unfinished (≤ 3 requests a call).
    reviews: first ? doc.reviewCount > 0 : resume.reviews !== undefined,
    debate,
    ...(sequenceId !== undefined && { sequenceId }),
    listing: seq !== undefined && (seq.canonicalCollectionSlug?.trim() ?? "") !== "" && !collectionsCached(svc),
  });
  const sent = await send(ops, PARTS_TASK, ctx, svc, true);
  let stopped = sent.kind === "stopped";

  // Request 2's parts, in request order, so that the Partial lines are too.
  const partials: string[] = [];
  const rv = partOf(sent, ops, "rv", SECTION.reviews, partials);
  const dt = partOf(sent, ops, "dt", SECTION.turns, partials);
  const ch = partOf(sent, ops, "ch", SECTION.sequence, partials);
  const listing: ListingSource = ops.some((o) => o.alias === "col")
    ? { asked: true, part: () => partOf(sent, ops, "col", SECTION.neighbour, partials), ...(sent.kind === "ok" && { results: sent.results }) }
    : { asked: false };

  let body = cached;
  let withheld = false;
  if (body === undefined && contents != null) {
    // #75: the speaker labels and turn ends are marked as the page is converted, so processBody knows them by line.
    const text = pageText({ html: contents.html, speakers, markLabels: true });
    if (text === undefined) withheld = true;
    else {
      body = processBody({ markdown: text, version: contents.version });
      svc.caches.set("body", bodyKey, body);
    }
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
    if (Date.parse(doc.postedAt) < IMPORTED_BEFORE_MS) notes.push(CAVEAT["C-PRE2019"]);
  }
  // The first page leads with the context lines; a continuation only says when the text changed since the previous page.
  const edited = start?.version !== undefined && version !== undefined && start.version !== version;
  const lead = first
    ? contextLines({ doc, rec: toPostRecord(doc), id, ...(body !== undefined && { body }), ...(sequenceLine !== undefined && { sequenceLine }) })
    : edited ? [editedNote(version)] : [];

  // The debate label heads the first page of every read that uses the body, a stopped one too (its word count is the body's).
  const debateBody = first && doc.debate === true && body !== undefined && body.md.trim() !== "" ? [DEBATE_BODY] : [];

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
    return reply({ tool: "get_post", subject, request, notes, head: [...lead, ...partials, ...debateBody], ...shown, items: [] }, maxTokens, svc, () => ({
      kind: "stopped", why: ctx.stopped ?? "time limit", tool: "get_post", cursor: mint(svc, "get_post", input.args, input.effective, state),
    }));
  }

  const text = textOf(doc, id, ask, body, turns, withheld);
  // The slice stream: the items from where this page starts, the first resumed inside its text. A continuation whose
  // stream points past the last item shows only the blocks left, so nothing of the text (position, its notes) is printed.
  const slice = slicePosition(text.items, start);
  const showsText = first || (start?.block ?? 0) < text.items.length;
  const position = showsText ? slice.position : undefined;

  // The match line heads every page of the matches, and the line that the text is not shown any page it applies to; the
  // empty-body line belongs to the first page.
  const textHead = first || withheld || doc.contents == null || (ask.match !== undefined && showsText) ? text.head : [];
  // ¶3.7: the post is one item, however many slice items (body, turns, hits) carry its text, so a first page that shows them
  // all whole prints no `Position: text 1–100 %` (as get_tag); a cut page and every continuation keep the line.
  const spec = (head: readonly string[]): PageSpec => ({
    tool: "get_post", subject, request, ...(position !== undefined && { position }), oneItem: first, notes,
    head: [...lead, ...partials, ...debateBody, ...head, ...textHead], blocks, items: slice.items,
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
      ...resumedFrom(entry, ctx),
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
  description: `${DESCRIPTION_QUOTE}\n\n${FORUM_TEXT}`,
  schema,
  required: ["post"],
  run(p, ctx, svc) {
    if (p.section !== undefined && p.match !== undefined) throw badInput("match", "can't be combined with section", "Give section or match, not both.");
    const entry = openContinuation("get_post", p.cursor, svc);
    return entry === undefined ? firstPage(p, ctx, svc) : continuation(entry, p, ctx, svc);
  },
};
