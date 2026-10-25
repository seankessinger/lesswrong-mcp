// Layer 3. The standard record layouts of ¶3.8.1 for posts, comments, people, tags, sequences, revisions and search
// snippets, the one-line references to posts, comments, sequences and tags, the thread header and outline line of
// `get_comments`, and the outline line and match hits of a text (`get_post`, `get_tag`). Each field has exactly one format and the tests assert the strings; tools never vary them. Fields are
// joined with ` · `; a field that does not apply is left out. Every single-line forum string passes `oneLine` here even
// where the domain already cut it (idempotent on clean text, ¶3.7, Q79): names at 60 characters (display names, tag, page
// and lens names), titles at 300 (posts, sequences), post and tag excerpts at 280, sequence excerpts at 200, bios at 150,
// snippets at 300. Block text (a comment body) is only
// ever printed as a `> ` quote. Nothing here prints an id the caller did not hand in as a visible reference (P1, P14).
// Pure: no I/O, never throws.
import { CONFIG } from "../config";
import { outlineText, type Heading, type MatchHit } from "../domain/markdown";
import { reactSummary, visibleReacts } from "../domain/reactions";
import { day, isoMs, minute } from "../text/dates";
import { blockText, oneLine } from "../text/sanitize";
import type {
  CommentRecord, PageItem, ParentRef, Person, Place, PostRecord, PostRef, RankedThread, RevisionRecord, SeqRef, SequenceRecord, StatusFlags,
  TagRecord, Thread, UserRecord, VisibleTagRef, WikiEditPage,
} from "../types";
import { estimateTokens, sliceText } from "./budget";
import { FLAG, fmtInt, listCutMarker } from "./messages";

const SEP = " · ";
const NEWLINE_CODE = 0x0a;
/** ¶3.8.1: a post line lists at most this many tags, then `+N more`. */
const TAGS_SHOWN = 6;
/** ¶3.8.1: the outline line quotes the opening 60 characters of a thread's root. */
const OPENING_CHARS = 60;

/** ¶3.5: a user card says so for a member of the Alignment Forum group. */
const AF_MEMBER = "AF member";
/** C-COUNTER, P10: a tag's or sequence's post counter is the site's own, marked `~` and named. */
const SITE_COUNTER = "(site counter)";

/** The forum's default highlight tags; searches ask for `**` marks already, so this only catches a snippet that came back with these. */
const HIGHLIGHT_TAGS = /<\/?em>/gi;

const HIDDEN_POST = "a post that is not publicly visible";
const HIDDEN_SEQUENCE = "a sequence that is not publicly visible";

type UserPerson = Extract<Person, { kind: "user" }>;
type MaskedWhy = Extract<Person, { kind: "none" }>["why"];

/** How a reply names a parent whose author is masked (¶3.8.1). */
const MASKED_PARENT: Readonly<Record<MaskedWhy, string>> = {
  "author not publicly visible": "a comment whose author is not publicly visible",
  "account not publicly visible": "a comment whose author is not publicly visible",
  "comment placeholder": "a comment placeholder",
};

// ---------- small pieces

const quoted = (s: string): string => `"${s}"`;
const nameText = (s: string): string => quoted(oneLine(s, CONFIG.render.caps.name));
const titleText = (s: string): string => quoted(oneLine(s, CONFIG.render.caps.title));
const afWord = (af: boolean): string => (af ? FLAG.AF : FLAG.LW_ONLY);

/** A whole count with its noun, comma-grouped from 1,000: `1 vote`, `612 votes`, `7 people`. */
function counted(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** `user_slug <slug>`, or `user_id <id>` for an account that has no slug (¶3.1.3). */
const identOf = (p: UserPerson): string => (p.slug ? `user_slug ${p.slug}` : `user_id ${p.id}`);

/** ¶3.7: block text as a `> ` quote, line by line; CR, U+2028 and U+2029 are line breaks, an empty line is a bare `>`, trailing newlines go. */
export function quote(body: string): string {
  const text = blockText(body);
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === NEWLINE_CODE) end -= 1;
  return text.slice(0, end).split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

// ---------- people and references (¶3.1.3)

/** P7, P8: `"<Name>" (user_slug …)`, `"<Name>" (user_id …)` for an account without a slug, else the masked form's own words. */
export function personText(p: Person): string {
  return p.kind === "none" ? p.why : `${nameText(p.name)} (${identOf(p)})`;
}

/** P14: `"<title>" (post_id …, AF | LW only[, event][, reachable by link only])`; a masked post exposes nothing. */
export function postRefText(r: PostRef): string {
  if (r.hidden) return HIDDEN_POST;
  const facts = [`post_id ${r.id}`, afWord(r.af)];
  if (r.event) facts.push(FLAG.EVENT);
  if (r.unlisted) facts.push(FLAG.UNLISTED);
  return `${titleText(r.title)} (${facts.join(", ")})`;
}

/** ¶3.5: a comment named on one line carries its id and `AF | LW only`. */
export function commentRefText(r: { id: string; af: boolean }): string {
  return `comment_id ${r.id} (${afWord(r.af)})`;
}

/** D7: `"<title>" (sequence_id …, AF | LW only[, not in the site's sequence lists])`. */
export function seqRefText(r: SeqRef): string {
  if (r.hidden) return HIDDEN_SEQUENCE;
  const facts = [`sequence_id ${r.id}`, afWord(r.af)];
  if (r.hiddenFromLists) facts.push(FLAG.HIDDEN_SEQUENCE);
  return `${titleText(r.title)} (${facts.join(", ")})`;
}

/** `"<name>" (tag_slug …)`; a page's name is a name (60, ¶3.7), as the request echo prints it. */
export function tagRefText(r: VisibleTagRef): string {
  return `${nameText(r.name)} (tag_slug ${r.slug})`;
}

/** ¶3.8.1: always `agreement ±N (k agreement votes)`; a zero score is `0`, a negative one starts with U+2212. */
export function agreementText(a: { score: number; votes: number }): string {
  const score = a.score > 0 ? `+${fmtInt(a.score)}` : fmtInt(a.score);
  return `agreement ${score} (${counted(a.votes, "agreement vote")})`;
}

// ---------- posts (¶3.8.1, ¶3.8.2)

/** Q50.12: `AF (AF karma N, ~M AF comments)` for an AF post (the karma only when it is known), else `LW only`; a non-AF post's stored AF karma is never read. */
export function afBlock(r: PostRecord): string {
  if (!r.af) return FLAG.LW_ONLY;
  const facts = r.afKarma === null ? [] : [FLAG.afKarma(r.afKarma)];
  facts.push(`~${counted(r.afCommentCount, "AF comment")}`);
  return `${FLAG.AF} (${facts.join(", ")})`;
}

/** ¶3.8.2, in the fixed order. */
export function statusTexts(s: StatusFlags): string[] {
  const out: string[] = [];
  if (s.curatedDate !== undefined) out.push(FLAG.curated(day(s.curatedDate)));
  out.push(s.frontpage ? FLAG.FRONTPAGE : FLAG.NOT_FRONTPAGED);
  if (s.pinned) out.push(FLAG.PINNED);
  if (s.bestOf !== undefined) out.push(FLAG.bestOf(s.bestOf.year, oneLine(s.bestOf.category, CONFIG.render.caps.title), s.bestOf.rank));
  if (s.question) out.push(FLAG.QUESTION);
  if (s.linkUrl !== undefined && s.linkUrl.trim() !== "") out.push(FLAG.linkpost(s.linkUrl));
  if (s.dialogue) out.push(FLAG.DIALOGUE);
  if (s.debate) out.push(FLAG.DEBATE);
  if (s.event) out.push(FLAG.EVENT);
  if (s.shortform) out.push(FLAG.CONTAINER);
  if (s.subQuestion) out.push(FLAG.SUB_QUESTION);
  if (s.groupPost) out.push(FLAG.GROUP_POST);
  if (s.unlisted) out.push(FLAG.UNLISTED);
  if (s.placeholderDate) out.push(FLAG.PLACEHOLDER_DATE);
  return out;
}

export interface PostLineOpts {
  /** Print the `> <excerpt>` line, when the record has an excerpt (lists only). */
  excerpt?: boolean;
  /** Under `sort: active` and in `recent_discussion`: a date prints `last comment <date>`, `null` prints `no comments yet`, absent prints nothing. */
  lastComment?: string | null;
  /** Replaces the bullet `• `; the lines after the first are indented two spaces more than the prefix's leading spaces. */
  prefix?: string;
}

/**
 * ¶3.8.1: the post in list form, 2 to 5 lines: title and authors; ids, date, karma, counters, AF block, flags; the URL;
 * up to 6 tags by relevance and `+N more`; the excerpt. People are printed from `authors` only (P7).
 */
export function postLine(r: PostRecord, opts: PostLineOpts = {}): string {
  const prefix = opts.prefix ?? "• ";
  const indent = " ".repeat(/^ */.exec(prefix)![0].length + 2);
  const authors = r.authors.map(personText).join(", ");
  const lines = [`${prefix}${titleText(r.title)}${authors === "" ? "" : ` — ${authors}`}`];

  const facts = [
    `post_id ${r.id}`, day(r.postedAt), `karma ${fmtInt(r.karma)} (${counted(r.votes, "vote")})`,
    `~${counted(r.commentCount, "comment")}`, afBlock(r), ...statusTexts(r.status),
  ];
  if (opts.lastComment !== undefined) facts.push(opts.lastComment === null ? FLAG.NO_COMMENTS_YET : FLAG.lastComment(day(opts.lastComment)));
  lines.push(indent + facts.join(SEP), indent + r.url);

  if (r.tags.length > 0) {
    const shown = r.tags.slice(0, TAGS_SHOWN).map(({ tag, relevance }) => `${nameText(tag.name)} ${fmtInt(relevance)} (tag_slug ${tag.slug})`);
    const rest = r.tags.length - TAGS_SHOWN;
    if (rest > 0) shown.push(`+${fmtInt(rest)} more`);
    lines.push(`${indent}tags (relevance): ${shown.join(SEP)}`);
  }
  if (opts.excerpt && r.excerpt !== undefined) {
    const excerpt = oneLine(r.excerpt, CONFIG.render.excerptChars);
    if (excerpt !== "") lines.push(`${indent}> ${excerpt}`);
  }
  return lines.join("\n");
}

// ---------- comments (¶3.8.1, ¶3.5)

/** P1: where a list-form comment is. A masked post or wiki page is named by no id, title or slug. */
export function placeText(p: Place): string {
  switch (p.kind) {
    case "post": return `on ${postRefText(p.post)}`;
    case "tag": return `on wiki page ${tagRefText(p.tag)}`;
    case "quick take": return FLAG.QUICK_TAKE;
    case "hidden post": return FLAG.ON_HIDDEN_POST;
    case "hidden tag": return FLAG.ON_HIDDEN_TAG;
  }
}

/** P14: the parent of a list-form comment, named by id only when it is visible; `""` for no parent. */
export function parentText(p: ParentRef): string {
  switch (p.kind) {
    case "none": return "";
    case "hidden": return FLAG.PARENT_HIDDEN;
    case "deleted": return `reply to a comment placeholder (comment_id ${p.id})`;
    case "comment": {
      const who = p.author.kind === "user" ? `${nameText(p.author.name)} (${identOf(p.author)}, ` : `${MASKED_PARENT[p.author.why]} (`;
      return `reply to ${who}comment_id ${p.id}, ${afWord(p.af)})`;
    }
  }
}

export interface CommentOpts {
  form: "thread" | "list";
  /** Thread form only: the position label (`T3.1`, `A1`). */
  label?: string;
  /** The discussion's post is on AF: a non-AF comment is then `not on AF` in the thread form. */
  postAf?: boolean;
  /** Thread form only: the comment is shown alone, with no discussion around it; a non-AF one is then `LW only`, as in the list form. */
  alone?: boolean;
  marker?: "★" | "◆";
  /** List form: the body is cut at about this many tokens (default `CONFIG.render.listCommentCapTokens`). */
  bodyCapTokens?: number;
  /** Caller-made flags (`parent comment not publicly visible`, `reply to a debate turn by "…"`), printed after the record's own. A placeholder has no flags of its own, but these still print before its `comment_id`. */
  extraFlags?: readonly string[];
}

/** The author slot of a header: a placeholder names no author, only its deletion reason (P5). */
const authorText = (c: CommentRecord): string => (c.placeholder === undefined ? personText(c.author) : FLAG.deletedPlaceholder(c.placeholder.reason));

/** P18: `karma N (V votes)`, or `karma not publicly visible`, never 0. */
function karmaText(karma: number | null, votes: number | null, hidden: boolean): string {
  if (hidden || karma === null) return FLAG.KARMA_HIDDEN;
  return votes === null ? `karma ${fmtInt(karma)}` : `karma ${fmtInt(karma)} (${counted(votes, "vote")})`;
}

/**
 * ¶3.5, D2: an AF comment prints `AF karma N` (`AF` without a visible karma); a non-AF one `LW only` in lists and when shown alone,
 * `not on AF` inside an AF post's discussion, else nothing.
 */
function afMark(af: boolean, afKarma: number | null, hidden: boolean, form: "thread" | "list" | "alone", postAf: boolean): string | undefined {
  if (af) return hidden || afKarma === null ? FLAG.AF : FLAG.afKarma(afKarma);
  if (form !== "thread") return FLAG.LW_ONLY;
  return postAf ? FLAG.NOT_ON_AF : undefined;
}

/** ¶3.8.2, in the fixed order. `quick take` is a thread-form flag: the list form says it in its place line. C4: the moderator mark needs an attributable author. */
function commentFlags(c: CommentRecord, form: "thread" | "list"): string[] {
  const flags: string[] = [];
  if (c.answer) flags.push(FLAG.ANSWER);
  if (c.reviewYear !== undefined) flags.push(FLAG.review(oneLine(c.reviewYear, CONFIG.render.caps.name)));
  if (c.quickTake && form === "thread") flags.push(FLAG.QUICK_TAKE);
  if (c.debateTurn) flags.push(FLAG.DEBATE_TURN);
  if (c.moderatorHat && c.author.kind === "user") flags.push(FLAG.MODERATOR);
  if (c.retracted) flags.push(FLAG.RETRACTED);
  if (c.edited) flags.push(FLAG.EDITED);
  if (c.pinnedOnProfile) flags.push(FLAG.PINNED_ON_PROFILE);
  return flags;
}

/**
 * The first line of a comment record. A deleted placeholder shows its reason, its date and its `comment_id`, with no author,
 * scores, marks or flags of its own (P5); the caller's position notes (`extraFlags`) still print, since a reply to a private
 * comment is marked whatever the reply is (P5, ¶4.4). Under hidden karma there are no votes, agreement or reactions (P18).
 * Only the comment's own id is printed (P14).
 */
function headerLine(c: CommentRecord, opts: CommentOpts): string {
  const fields: string[] = [];
  if (opts.form === "thread" && opts.label !== undefined) fields.push(opts.label);
  fields.push(authorText(c), minute(c.postedAt));
  if (c.placeholder === undefined) {
    const hidden = c.karmaHidden || c.karma === null;
    fields.push(karmaText(c.karma, c.votes, hidden));
    if (!hidden && c.reactions.agreement !== undefined) fields.push(agreementText(c.reactions.agreement));
    const mark = afMark(c.af, c.afKarma, hidden, opts.alone === true ? "alone" : opts.form, opts.postAf === true);
    if (mark !== undefined) fields.push(mark);
    const reacts = hidden ? "" : reactSummary(visibleReacts(c.reactions));
    if (reacts !== "") fields.push(`reacts: ${reacts}`);
    fields.push(...commentFlags(c, opts.form));
  }
  fields.push(...(opts.extraFlags ?? []), `comment_id ${c.id}`);
  return `▶ ${opts.marker === undefined ? "" : `${opts.marker} `}${fields.join(SEP)}`;
}

/** Thread form: the one header line. List form: that line plus, when the record has a place or a parent, the indented place line. */
export function commentHeader(r: CommentRecord, opts: CommentOpts): string {
  const head = headerLine(r, opts);
  if (opts.form === "thread") return head;
  const where = [r.place === undefined ? "" : placeText(r.place), r.parent === undefined ? "" : parentText(r.parent)].filter((s) => s !== "");
  return where.length === 0 ? head : `${head}\n  ${where.join(SEP)}`;
}

/**
 * The header and the quoted body. A placeholder, or a record whose text was not fetched, has the header alone. The thread
 * form quotes the whole body; the list form quotes it cut at `bodyCapTokens` and, when words remain beyond the cut, adds
 * the unquoted `listCutMarker` line (a cut that leaves only whitespace has nothing to point at, so it adds none).
 */
export function commentBlock(r: CommentRecord, opts: CommentOpts): string {
  const lines = [commentHeader(r, opts)];
  if (r.body === undefined || r.placeholder !== undefined) return lines[0]!;
  if (opts.form === "thread") {
    lines.push(quote(r.body));
  } else {
    const cut = sliceText(r.body, opts.bodyCapTokens ?? CONFIG.render.listCommentCapTokens);
    lines.push(quote(cut.text));
    if (cut.next !== undefined && cut.moreWords > 0) lines.push(listCutMarker(r.id));
  }
  return lines.join("\n");
}

// ---------- thread header and outline line (¶3.8.1)

/** The root's karma and AF mark as the thread header and the outline print them; a placeholder root has neither (P5). The id is `thread.rootId` (P14). */
function rootScore(t: Thread, postAf: boolean): string[] {
  const root = t.root.c;
  if (root.placeholder !== undefined) return [];
  const hidden = root.karmaHidden || t.rootKarma === null;
  const out = [karmaText(t.rootKarma, null, hidden)];
  const mark = afMark(root.af, t.rootAfKarma, hidden, "thread", postAf);
  if (mark !== undefined) out.push(mark);
  return out;
}

/** `## <label> · root by <person> · comment_id … · karma … · <AF mark> · N comments · M people · [contested N · ]newest <date>`. */
export function threadHeader(rt: RankedThread, postAf: boolean): string {
  const t = rt.thread;
  const fields = [`## ${rt.label}`, `root by ${authorText(t.root.c)}`, `comment_id ${t.rootId}`, ...rootScore(t, postAf), counted(t.size, "comment"), counted(t.participants, "person", "people")];
  if (t.contested > 0) fields.push(`contested ${fmtInt(t.contested)}`);
  fields.push(`newest ${day(t.newestMs)}`);
  return fields.join(SEP);
}

/** `<label> · <person> · comment_id … · karma … · <AF mark> · N comments · [contested N · ]<date> · "<opening 60 characters>"`, the opening only once the root's text is fetched. */
export function outlineLine(rt: RankedThread, postAf: boolean): string {
  const t = rt.thread;
  const root = t.root.c;
  const fields = [rt.label, authorText(root), `comment_id ${t.rootId}`, ...rootScore(t, postAf), counted(t.size, "comment")];
  if (t.contested > 0) fields.push(`contested ${fmtInt(t.contested)}`);
  fields.push(day(root.postedAt));
  if (root.body !== undefined && root.placeholder === undefined) {
    const opening = oneLine(root.body, OPENING_CHARS);
    if (opening !== "") fields.push(quoted(opening));
  }
  return fields.join(SEP);
}

// ---------- the outline and the match hits of a text (¶3.7, ¶4.3; `get_post`, `get_tag`)

/**
 * ¶3.7: `Outline (<n>): 1 A · 2 B · 3   B.1 …` on one line; over 25 % of the budget of `maxTokens`, only the top two levels, and
 * should even those pass it, as many of them as fit, then `…`.
 */
export function textOutlineLine(raw: readonly Heading[], maxTokens: number): string {
  const cap = Math.floor(CONFIG.render.shares.outline * Math.floor(CONFIG.render.fill * maxTokens));
  const head = `Outline (${fmtInt(raw.length)}): `;
  // A heading is a single-line field of forum text (¶3.7); the indentation `outlineText` adds is the line's own.
  const headings = raw.map((h) => ({ ...h, text: oneLine(h.text, CONFIG.render.caps.title) }));
  const line = (hs: readonly Heading[], more = false): string => head + outlineText(hs) + (more ? `${SEP}…` : "");
  const full = line(headings);
  if (estimateTokens(full) <= cap) return full;
  const top = headings.filter((h) => h.level <= 2);
  if (estimateTokens(line(top)) <= cap) return line(top);
  let lo = 1;
  let hi = top.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(line(top.slice(0, mid), true)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return line(top.slice(0, lo), true);
}

/** A hit's first line, `section N · paragraph M` (no section before the first heading). */
function matchHitHeader(h: MatchHit): string {
  return `${h.section === null ? "" : `section ${h.section}${SEP}`}paragraph ${h.paragraph}`;
}

/** ¶4.3 `match`: one matching paragraph as an item's text: `section N · paragraph M` (no section before the first heading), then the paragraph quoted. */
export function matchHitText(h: MatchHit): string {
  return `${matchHitHeader(h)}\n${quote(h.text)}`;
}

/** ¶4.3 `match`: a hit as a page item, which a later page resumes under its own first line when the page cut it (¶3.7 rule 3). */
export function matchHitItem(h: MatchHit): PageItem {
  return { text: matchHitText(h), header: matchHitHeader(h) };
}

// ---------- people, tags, sequences, revisions and search hits (¶3.8.1)

/**
 * ¶3.8.1: `<index>. ` (or `• `), the name, `user_slug`, `user_id`, karma, `AF karma` (when there is some, or the person is a
 * member), `AF member`, `member since <date>`, the site counters with `~`; then the bio line, indented to the prefix's width.
 */
export function userCard(u: UserRecord, index?: number): string {
  const prefix = index === undefined ? "• " : `${index}. `;
  const facts = [nameText(u.name), `user_slug ${u.slug}`, `user_id ${u.id}`, `karma ${fmtInt(u.karma)}`];
  if (u.afKarma !== 0 || u.afMember) facts.push(FLAG.afKarma(u.afKarma));
  if (u.afMember) facts.push(AF_MEMBER);
  facts.push(`member since ${day(u.createdAt)}`, `~${counted(u.postCount, "post")}`, `~${counted(u.commentCount, "comment")}`);
  const lines = [prefix + facts.join(SEP)];
  const bio = oneLine(u.bioExcerpt, CONFIG.render.bioCardChars);
  if (bio !== "") lines.push(`${" ".repeat(prefix.length)}> bio: ${bio}`);
  return lines.join("\n");
}

/** ¶3.8.1: the tag card (its name at the name cap), its parent as a tag reference; `opts.excerpt` adds the `  > <excerpt>` line of the description. The post counter is the site's own and appears in cards only (P10, Q119). */
export function tagCard(t: TagRecord, opts: { excerpt?: boolean } = {}): string {
  const facts = [
    nameText(t.name), `tag_slug ${t.slug}`, `tag_id ${t.id}`, `page type: ${t.pageType}`, `~${counted(t.postCount, "tagged post")} ${SITE_COUNTER}`,
  ];
  if (t.parent !== undefined) facts.push(`parent: ${tagRefText(t.parent)}`);
  const lines = [`• ${facts.join(SEP)}`];
  const excerpt = opts.excerpt ? oneLine(t.excerpt, CONFIG.render.excerptChars) : "";
  if (excerpt !== "") lines.push(`  > ${excerpt}`);
  return lines.join("\n");
}

/** ¶3.8.1, D7: `"<title>" — <author> · sequence_id … · ~N posts (site counter) · created <date> · [collection_slug …] · AF | LW only[ · not in the site's sequence lists]`, then the description excerpt. */
export function sequenceLine(s: SequenceRecord): string {
  const facts = [personText(s.author), `sequence_id ${s.id}`, `~${counted(s.postsCount, "post")} ${SITE_COUNTER}`, `created ${day(s.createdAt)}`];
  if (s.collectionSlug) facts.push(`collection_slug ${s.collectionSlug}`);
  facts.push(afWord(s.af));
  if (s.hiddenFromLists) facts.push(FLAG.HIDDEN_SEQUENCE);
  const lines = [`• ${titleText(s.title)} — ${facts.join(SEP)}`];
  const excerpt = oneLine(s.excerpt, CONFIG.render.sequenceExcerptChars);
  if (excerpt !== "") lines.push(`  > ${excerpt}`);
  return lines.join("\n");
}

/**
 * ¶4.7 step 6: where a wiki edit landed, from the page's tag reference: the page, one of its lenses, the summary of the page,
 * or the summary of one of its lenses. A record that lacks the lens or the summary it names still says which part it was.
 */
export function wikiEditPageText(p: WikiEditPage): string {
  const page = tagRefText(p.page);
  const lens = p.lens === undefined ? "lens" : `lens ${nameText(p.lens.title)} (lens_slug ${p.lens.slug})`;   // a lens name is a name (60, ¶3.7)
  const summary = p.summaryId === undefined ? "summary" : `summary (summary_id ${p.summaryId})`;
  switch (p.part) {
    case "page": return page;
    case "lens": return `${lens} of ${page}`;
    case "summary": return `${summary} of ${page}`;
    case "lens summary": return `${summary} of ${lens} of ${page}`;
  }
}

/**
 * ¶3.8.1, ¶4.11: `• revision_id … · v… · <ISO time> · <kind>[ by <editor>] · forum change count +a/−r chars · N words`, then the
 * labels (one equal to the kind is not repeated), the folded image copies and the wiki page and part. The editor is named only
 * when the record has one (P7: none on a document whose author is hidden); a zero change prints no count (C-CHANGEMETRICS).
 * The document's own id is not printed.
 */
export function revisionLine(r: RevisionRecord): string {
  const facts = [`revision_id ${r.id}`, `v${r.version}`, isoMs(r.editedMs)];
  const edit = [r.kind ?? "", r.editor === undefined ? "" : `by ${personText(r.editor)}`].filter((part) => part !== "").join(" ");
  if (edit !== "") facts.push(edit);
  if (r.change !== undefined && (r.change.added !== 0 || r.change.removed !== 0)) {
    facts.push(`forum change count +${fmtInt(r.change.added)}/−${fmtInt(r.change.removed)} chars`);
  }
  facts.push(counted(r.wordCount, "word"), ...r.labels.filter((label) => label !== r.kind));
  if (r.cdnCopiesFolded === 1) facts.push("+ automatic image copy");
  else if (r.cdnCopiesFolded > 1) facts.push(`+ ${fmtInt(r.cdnCopiesFolded)} automatic image copies`);
  if (r.page !== undefined) facts.push(wikiEditPageText(r.page));
  return `• ${facts.join(SEP)}`;
}

/** ¶3.8.1, ¶4.2: `snippet: "…"` on one line, highlight marks as `**`, at most the snippet cap. */
export function snippetText(s: string): string {
  return `snippet: "${oneLine(s.replace(HIGHLIGHT_TAGS, "**"), CONFIG.render.caps.snippet)}"`;
}
