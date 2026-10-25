// Layer 3. The exact wording of everything the server says besides record data (¶3.6 footers and notes, ¶3.7 match line
// and cut markers, ¶3.8.1 number format and approximation notations, ¶3.8.2 flags, ¶3.8.3 caveats, ¶3.9 error prefix,
// empty results and `Partial:` lines). Tests assert these strings, and descriptions quote them, so each text is written
// out once here and nothing else in `src/` spells it. Free text that goes inside a message passes `oneLine` (¶3.7:
// forum content is quoted data); everything else is built from numbers, ids and the caller's own already-clean words.
// Pure: no I/O, never throws.
import { CONFIG } from "../config";
import type { ToolError } from "../errors";
import { VOCAB } from "../params/vocabulary";
import { oneLine } from "../text/sanitize";
import type { Footer } from "../types";

const MINUS = "−";   // U+2212

/**
 * ¶3.8.1: a whole number of 1,000 or more has a comma between each group of three digits; a fraction is kept as
 * `String(n)` writes it; a negative number starts with U+2212. Every count printed anywhere goes through this; ids,
 * versions and dates never do. A value `String` writes in exponent form, `NaN` and the infinities are printed as `String`
 * writes them (no count reaches them).
 */
export function fmtInt(n: number): string {
  const sign = n < 0 ? MINUS : "";
  const text = String(Math.abs(n));
  const parts = /^(\d+)(\.\d+)?$/.exec(text);
  if (parts === null) return sign + text;
  return sign + parts[1]!.replace(/\B(?=(?:\d{3})+$)/g, ",") + (parts[2] ?? "");
}

/** `s` without one trailing period, when it has one. */
const withoutFinalPeriod = (s: string): string => (s.endsWith(".") ? s.slice(0, -1) : s);

// ---------- errors (¶3.9)

/** `Error (<category>): <message>`; the message is already worded and cut by `errors.ts` (¶8). */
export function errorText(e: ToolError): string {
  return `Error (${e.category}): ${e.message}`;
}

/** `Partial: <section> unavailable (<category>: <message without its final period>).` The rest of the answer is returned beside it (¶3.9). */
export function partialLine(section: string, e: ToolError): string {
  return `Partial: ${section} unavailable (${e.category}: ${withoutFinalPeriod(e.message)}).`;
}

// ---------- caveats (¶3.8.3)

export type CaveatId =
  | "C-COUNTER" | "C-KARMA" | "C-FRONTPAGE" | "C-SEARCH" | "C-COAUTHOR-SEARCH" | "C-TAGGED"
  | "C-PRE2019" | "C-REACT-SNAPSHOT" | "C-FRONTPAGE-APPROX" | "C-DEPTH" | "C-DRIFT" | "C-FOOTNOTES"
  | "C-STALE-CACHE" | "C-KARMA-LAG" | "C-CHANGEMETRICS" | "C-LABELS" | "C-HIDDEN-KARMA-ORDER" | "C-EVENTS";

/** The fixed caveat texts, verbatim. C-STALE-CACHE has two variants and is `staleCacheCaveat`. */
export const CAVEAT: Readonly<Record<Exclude<CaveatId, "C-STALE-CACHE">, string>> = Object.freeze({
  "C-COUNTER": "Numbers marked ~ are the site's own counters and can differ from what is listed.",
  "C-KARMA": "'karma' is LessWrong karma; 'AF karma' is the Alignment Forum score.",
  "C-FRONTPAGE": "'not frontpaged' can mean a personal-blog post or a recent post that may still be frontpaged (frontpaging has taken up to about 2 days).",
  "C-SEARCH": "Search matches each item's current text only, dated by its original posting date, and leaves out posts with negative karma and retracted comments.",
  "C-COAUTHOR-SEARCH": "Search knows only each post's primary author; coauthored posts are missed.",
  "C-TAGGED": "'Tagged' means readers applied the tag with relevance 1 or more; untagged posts on the topic are not in this list.",
  "C-PRE2019": "Texts from before 13 February 2019 exist only as a February-2019 import snapshot dated to the original posting time; earlier wording and edits were not kept.",
  "C-REACT-SNAPSHOT": "Reactor and liker names are as of the item's last vote.",
  "C-FRONTPAGE-APPROX": "An approximation of the logged-out home page: the site's own page code isn't public.",
  "C-DEPTH": "The forum can't list beyond about the 2,000th result in this order.",
  "C-DRIFT": "Rankings can shift between pages as votes arrive.",
  "C-FOOTNOTES": "Links inside footnotes are lost in the forum's text conversion.",
  "C-KARMA-LAG": "min_karma: a post that only just reached this karma can be missing for a while (the forum's threshold uses a background-updated maximum).",
  "C-CHANGEMETRICS": "Change counts are the forum's own.",
  "C-LABELS": "Labels such as T3.1 are positions in this result and change with sort and filters; refer to comments by comment_id.",
  "C-HIDDEN-KARMA-ORDER": "Comments whose karma is not publicly visible are left out of karma-ordered and karma-filtered lists.",
  "C-EVENTS": "Event and meetup posts are not listed here; they open by id and can appear in search.",
});

/** C-STALE-CACHE: the forum's refresh period, plus the 2 minutes this server keeps a feed (¶2.3). */
export function staleCacheCaveat(refreshMinutes: 5 | 10): string {
  return `The forum refreshes this feed every ${refreshMinutes} minutes and this server keeps it for up to 2 more, so it can be up to about ${refreshMinutes + 2} minutes old.`;
}

// ---------- flags (¶3.8.2)

/**
 * The flag texts, verbatim. `MODERATOR` is the one place the moderator-comment label is spelled (L6: if the site's own label
 * differs, it changes only there). The functions build the flags that carry a value.
 */
export const FLAG = Object.freeze({
  AF: "AF",
  LW_ONLY: "LW only",
  NOT_ON_AF: "not on AF",
  FRONTPAGE: "frontpage",
  NOT_FRONTPAGED: "not frontpaged",
  PINNED: "pinned",
  QUESTION: "question",
  DIALOGUE: "dialogue",
  DEBATE: "debate",
  EVENT: "event",
  CONTAINER: "quick takes container",
  SUB_QUESTION: "sub-question (not in the site's main lists)",
  GROUP_POST: "group post",
  UNLISTED: "reachable by link only",
  HIDDEN_SEQUENCE: "not in the site's sequence lists",
  ANSWER: "answer",
  QUICK_TAKE: "quick take",
  DEBATE_TURN: "debate turn",
  MODERATOR: "moderator comment",
  RETRACTED: "retracted",
  EDITED: "edited",
  DELETED_ACCOUNT: "account not publicly visible",
  ANONYMOUS: "author not publicly visible",
  KARMA_HIDDEN: "karma not publicly visible",
  PLACEHOLDER_DATE: "date may be a placeholder",
  PARENT_HIDDEN: "parent comment not publicly visible",
  ON_HIDDEN_POST: "on a post that is not publicly visible",
  ON_HIDDEN_TAG: "on a wiki page that is not publicly visible",
  PINNED_ON_PROFILE: "pinned on profile",
  NO_COMMENTS_YET: "no comments yet",
  ONLY_WITH_POSSESSIVE: "matches only with a possessive",

  afKarma: (n: number): string => `AF karma ${fmtInt(n)}`,
  curated: (day: string): string => `curated ${day}`,
  /** `rank` is the 1-based rank (`reviewRanking + 1`, already added by `domain/status`). */
  bestOf: (year: number, category: string, rank: number): string => `Best of LessWrong ${year} (${category}, #${rank})`,
  /** The URL is author-typed forum text: one line, at most the title cap (¶3.7). */
  linkpost: (url: string): string => `linkpost → ${oneLine(url, CONFIG.render.caps.title)}`,
  review: (year: string | number): string => `review (${year})`,
  /** The placeholder's reason is forum text: one line, at most the title cap. No reason, or an empty one, leaves the bare flag. */
  deletedPlaceholder: (reason: string | null): string => {
    const why = oneLine(reason, CONFIG.render.caps.title);
    return why === "" ? "comment placeholder" : `comment placeholder (reason: ${why})`;
  },
  replyToDebateTurn: (name: string): string => `reply to a debate turn by "${oneLine(name, CONFIG.render.caps.name)}"`,
  lastComment: (day: string): string => `last comment ${day}`,
  withoutPossessive: (form: string): string => `matches without the possessive ("${form}")`,
  /** ¶4.5, P10: the `totalCount` of a full first page of a tag post list. */
  forumCount: (n: number): string => `about ${fmtInt(n)} posts (the forum's count)`,
  /** Q50.42: a search `nbHits`. */
  looseCount: (n: number): string => `about ${fmtInt(n)} matches (the forum's loose count)`,
} as const);

// ---------- the ¶3.7 match line

/** `k of n <paragraphs|comments> contain "<needle>".` The needle is the caller's text, on one line, at most 200 characters. */
export function matchLine(k: number, n: number, unit: "paragraphs" | "comments", needle: string): string {
  return `${fmtInt(k)} of ${fmtInt(n)} ${unit} contain "${oneLine(needle, 200)}".`;
}

// ---------- empty results (¶3.9: five templates)

export type EmptyTemplate =
  | { kind: "filtered"; items: string; filters: string; suggestions?: readonly string[] }
  | { kind: "subject"; what: "comments on" | "posts in" | "versions of"; subject: string }
  | { kind: "match"; n: number; unit: "paragraphs" | "comments"; needle: string }
  | { kind: "feed"; feed: string; window: string }
  | { kind: "scan"; checked: number };

/**
 * The first suggestion starts the sentence after the filters, so it gets a capital (¶3.9's example: `Without af_only
 * there are posts …`), unless its first word is a parameter name (`af_only and date filters narrow a lot`, `user …`),
 * which is the caller's own word and is kept as written.
 */
function sentenceCase(s: string): string {
  const first = /^[a-z]+(?=\s|$)/.exec(s)?.[0];
  return first === undefined || Object.hasOwn(VOCAB, first) ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The five empty-result texts. `filtered` restates the filters and then gives at most two suggestions (each without its
 * final period, the first in sentence case, joined by `; or `); `subject` and `filtered` take words their caller has
 * already made clean; a `match` is the ¶3.7 match line with zero hits; `scan` is a page with no items that still has a
 * cursor, so the list has not ended and the wording must not say it has.
 */
export function emptyText(t: EmptyTemplate): string {
  switch (t.kind) {
    case "filtered": {
      const head = `No ${t.items} match: ${t.filters}.`;
      const picked = (t.suggestions ?? []).map(withoutFinalPeriod).filter((s) => s !== "").slice(0, 2).map((s, i) => (i === 0 ? sentenceCase(s) : s));
      return picked.length === 0 ? head : `${head} ${picked.join("; or ")}.`;
    }
    case "subject":
      return `No publicly visible ${t.what} ${t.subject}.`;
    case "match":
      return matchLine(0, t.n, t.unit, t.needle);
    case "feed":
      return `${t.feed}: nothing in its window (${t.window}).`;
    case "scan":
      return `None found among the first ${fmtInt(t.checked)} checked; continue with the cursor.`;
  }
}

// ---------- footers and their end lines (¶3.6)

/**
 * Exactly one of four forms. `drift` (only on the two cursor forms) appends the C-DRIFT sentence. `next` is cut to 60
 * characters and `reason` to 200 on one line; the cursor is printed as it is (it is a `c_…` token the server made).
 */
export function footerText(f: Footer): string {
  switch (f.kind) {
    case "end":
      return "End of results.";
    case "more": {
      const text = `More available: call ${f.tool} with cursor "${f.cursor}" (next: ${oneLine(f.next, 60)}).`;
      return f.drift ? `${text} ${CAVEAT["C-DRIFT"]}` : text;
    }
    case "reachable":
      return `End of reachable results: ${oneLine(f.reason, 200)}.`;
    case "stopped": {
      const text = `Stopped early (${f.why}); call ${f.tool} with cursor "${f.cursor}" to continue.`;
      return f.drift ? `${text} ${CAVEAT["C-DRIFT"]}` : text;
    }
  }
}

/**
 * The C-DEPTH end line's sentence (¶3.6): lists in other orders end at the forum's limit of about 2,000 results. The tool
 * that prints it adds its hint with `endDepth`. Has no final period; `footerText` adds it.
 */
export const END_DEPTH = "the forum can't list beyond about the 2,000th result in this order";

/**
 * ¶3.6: the hints a tool may add to the C-DEPTH end line, each naming only parameters that tool accepts with the
 * call's arguments and that really shorten the list. `dates`: `list_posts` and `list_comments` in a non-date order;
 * `datesOnly`: the same tools in date order (`new`/`old`, whose window had no visible row to re-anchor at); `afOnly`:
 * `get_links`' incoming posts without `af_only`. `get_feed`'s offset feeds take no dates or sort and add nothing.
 */
export const DEPTH_HINT = Object.freeze({
  dates: "narrow with date_from/date_to, or use sort new or old",
  datesOnly: "narrow with date_from/date_to",
  afOnly: "use af_only to shorten the list",
});

/** The C-DEPTH end line: the sentence alone, or the sentence and the printing tool's hint after `; `. */
export function endDepth(hint?: string): string {
  return hint === undefined ? END_DEPTH : `${END_DEPTH}; ${hint}`;
}

/** The depth guard's one wording (¶3.6): site-wide date-ordered lists stop after 500 items. */
export const END_DEPTH_GUARD =
  "this server stops site-wide lists in date order after 500 items unless a person, tag, date range, status or karma filter narrows them; narrow with date_from/date_to";

/** The search depth limit: `page × hitsPerPage + hitsPerPage ≤ 10,000`. */
export const END_SEARCH_DEPTH = "the forum's search stops at 10,000 results; add filters or phrases";

/** A single-request set that came back exactly as long as this server asked for: the end is unknown, so it never says `End of results`. */
export function endMostReturned(n: number): string {
  return `the forum returned the most this server requests (${fmtInt(n)}); more may exist`;
}

// ---------- notes and cut markers (¶3.6, ¶3.7; P10: they count only what was checked or is visible)

export const SHORT_PAGE_NOTE = "This page has fewer than limit items; continue with the cursor.";

/** A short page caused by a filter the caller asked for (`af_only`, `min_karma`). */
export function filterKeptNote(filter: string, kept: number, checked: number, unit: string): string {
  return `${filter} kept ${fmtInt(kept)} of the ${fmtInt(checked)} ${unit} checked; continue with the cursor.`;
}

/** A `list` cursor whose fingerprint changed; `n` counts visible rows only. */
export function driftNote(n: number): string {
  return `The list changed since the previous page (${fmtInt(n)} new ${n === 1 ? "item" : "items"}); positions may have shifted.`;
}

/** The end of a capped block that the cursor resumes before anything else. */
export const CONTINUED = "(continued with the cursor)";

/** The end of a sliced text: about `words` more words follow. */
export function cutMarker(words: number): string {
  return `[… continues: about ${fmtInt(words)} more words; use the cursor]`;
}

/** A block larger than the whole budget is cut at a line break, and this says the cut fell inside a code block. */
export const CUT_IN_CODE = "(cut inside a code block)";

/** The end of a comment body cut in a list (`list_comments`, `get_user`, `get_feed`). */
export function listCutMarker(commentId: string): string {
  return `[… cut; full text: get_comments {comment: "${commentId}"}]`;
}
