// Layer 5 leaf. The phrase rules of ¶3.2.1, implemented once: how a `phrases` / `forms` entry is classified and what is
// sent to the forum (rules 1–5 and 7), how text and phrase are normalized for the local check (rule 6), the lenient
// `match` normalization, `query` sanitizing (Q32) and the ASCII spelling `first_use` suggests for a loose form (¶4.12).
//
// Terms. A word character is a letter or a digit (`[\p{L}\p{N}]`); punctuation is `[\p{P}\p{S}]`; the quote characters
// are " “ ” „ ‟ « » ‘ (the apostrophes ' and ’ are not among them); the dashes are - _ – —; edge punctuation is a run of
// punctuation at the start or end of a text or next to whitespace. Code points are written as `\u{…}` (see sanitize.ts).
// Nothing here makes forum text safe to print: callers pass what they show through text/sanitize.
import { badInput } from "../errors";
import type { ClassifiedPhrase } from "../types";
import { oneLine } from "./sanitize";

/** ¶3.2.1 rule 1: a phrase as it is echoed back is cut to this many characters. */
const GIVEN_MAX = 100;

const QUOTE_CHARS = /["\u{201C}\u{201D}\u{201E}\u{201F}\u{AB}\u{BB}\u{2018}]/gu;
const DASHES = /[-_\u{2013}\u{2014}]/gu;
const PUNCT_RUN = /[\p{P}\p{S}]+/gu;
const PUNCT = /[\p{P}\p{S}]/gu;
const WORD_CHARS = /[\p{L}\p{N}]/gu;
const WHITESPACE = /\s+/gu;
const SPACE = /\s/u;
const NON_ASCII = /[^\u{0}-\u{7F}]/u;
const PUNCT_INSIDE_WORD = /[\p{L}\p{N}][\p{P}\p{S}]+[\p{L}\p{N}]/u;

/** An apostrophe with a word character on both sides, and the word characters after it (rule 2). */
const APOSTROPHE_TAIL = /(?<=[\p{L}\p{N}])['\u{2019}][\p{L}\p{N}]+/gu;
/** An apostrophe that does not sit between two word characters. */
const STRAY_APOSTROPHE = /(?<![\p{L}\p{N}])['\u{2019}]|['\u{2019}](?![\p{L}\p{N}])/gu;

/** A backslash before ASCII punctuation (Markdown escapes). */
const ESCAPED_PUNCT = /\\([\u{21}-\u{2F}\u{3A}-\u{40}\u{5B}-\u{60}\u{7B}-\u{7E}])/gu;

/** The letters NFKD leaves whole, folded to ASCII (`foldForMatch`, `asciiSuggestion`). */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ß: "ss", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", Þ: "Th", ð: "d", Ð: "D", ı: "i",
};
const FOLDABLE_LETTERS = /[øØæÆœŒßłŁđĐþÞðÐı]/gu;

/** The ends of a query word that the forum would read as syntax (Q32). */
const LEADING_DASHES = /^-+(?=[^\s-])/u;
const FIELD_PREFIX = /^[A-Za-z0-9_]+:(?=\S)/u;

/** A run of punctuation that `asciiSuggestion` keeps between two word characters: only apostrophes and dashes. */
const KEPT_RUN = /^['\u{2019}\-_\u{2013}\u{2014}]+$/u;
const IN_WORD_PUNCT_RUN = /(?<=[\p{L}\p{N}])[\p{P}\p{S}]+(?=[\p{L}\p{N}])/gu;

function collapse(s: string): string {
  return s.replace(WHITESPACE, " ").trim();
}

function wordCharCount(s: string): number {
  return (s.match(WORD_CHARS) ?? []).length;
}

/** Edge punctuation removed: each maximal run of punctuation at either end of `s` or touching whitespace. */
function dropEdgePunctuation(s: string): string {
  return s.replace(PUNCT_RUN, (run, at: number) => {
    const edge = at === 0 || at + run.length === s.length || SPACE.test(s[at - 1]) || SPACE.test(s[at + run.length]);
    return edge ? "" : run;
  });
}

/** NFKD, combining marks removed, and the table of letters that NFKD leaves whole. Case is kept. */
function foldAccents(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").replace(FOLDABLE_LETTERS, (c) => LETTER_FOLDS[c]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

/** `needle` occurs in `text` with no word character right before or after it. */
function hasWhole(text: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * ¶3.2.1 rules 1–5 and 7. `given` is the phrase on one line (NFKC, quote characters removed, at most 100 characters); `sent`
 * is what goes to the forum; `needle` is the normalized phrase every hit is checked for, apostrophe form kept (rule 6).
 * `param` names the parameter in the `bad_input` of rule 7.
 */
export function classify(phrase: string, param: "phrases" | "forms"): ClassifiedPhrase {
  const given = oneLine(phrase.normalize("NFKC").replace(QUOTE_CHARS, ""), GIVEN_MAX);
  const s2 = given.replace(APOSTROPHE_TAIL, "");
  const s4 = collapse(dropEdgePunctuation(s2.replace(DASHES, " ")));
  if (wordCharCount(s4) < 2) {
    // The apostrophe rule is the only step that removes word characters: when `given` itself has 2 or more, it caused the shortfall ("I'm", "o'clock").
    if (wordCharCount(given) >= 2) {
      throw badInput(
        param,
        `${JSON.stringify(given)} leaves fewer than 2 letters or digits once the apostrophe and the rest of its word are removed, as the forum's search does`,
        `Add a neighbouring word to the phrase, as in "five o'clock".`,
      );
    }
    throw badInput(
      param,
      `${JSON.stringify(given)} has fewer than 2 letters or digits`,
      "A phrase needs at least 2 letters or digits; punctuation alone matches nothing.",
    );
  }
  const loose = NON_ASCII.test(s4) || PUNCT_INSIDE_WORD.test(s4);
  const sent = loose ? collapse(s4.replace(PUNCT, " ")) : s4;
  const mode = loose ? "loose" : s2 !== given ? "rewritten" : "exact";
  return { given, sent, mode, needle: normalizeText(given) };
}

/**
 * ¶3.2.1 rule 6, the one normalization of text and phrase: NFKC; lower case; curly quotes straightened; backslash
 * escapes of ASCII punctuation unescaped; `*` removed; dashes to spaces; edge punctuation removed; whitespace collapsed.
 * Accented letters and punctuation inside words are kept.
 */
export function normalizeText(s: string): string {
  const plain = s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{2018}\u{2019}]/gu, "'")
    .replace(/[\u{201C}\u{201D}]/gu, '"')
    .replace(ESCAPED_PUNCT, "$1")
    .replace(/\*/gu, "")
    .replace(DASHES, " ");
  return collapse(dropEdgePunctuation(plain));
}

/**
 * Whether `text` contains the phrase (rule 6): "exact" when the needle occurs as whole words; otherwise the other side of
 * the apostrophe rule: "without-possessive" when the needle has a possessive (`newcomb's problem`) and the text has only
 * `newcomb problem`, "with-possessive" when the needle has none and the text has the possessive form; else false.
 */
export function contains(text: string, phrase: ClassifiedPhrase): "exact" | "without-possessive" | "with-possessive" | false {
  const t = normalizeText(text);
  if (hasWhole(t, phrase.needle)) return "exact";
  const plain = phrase.needle.replace(APOSTROPHE_TAIL, "");
  if (plain !== phrase.needle) return hasWhole(t, plain) ? "without-possessive" : false;
  return hasWhole(t.replace(APOSTROPHE_TAIL, ""), phrase.needle) ? "with-possessive" : false;
}

/** The `match` normalization: rule 6, then accents folded and every remaining punctuation character turned into a space. */
export function foldForMatch(s: string): string {
  return collapse(foldAccents(normalizeText(s)).replace(PUNCT, " "));
}

/** At least one word of `query` that has 2 or more letters or digits occurs as a whole word in `text` (both folded); false when the query has no such word. */
export function queryTermsIn(text: string, query: string): boolean {
  const words = foldForMatch(query).split(" ").filter((w) => wordCharCount(w) >= 2);
  if (words.length === 0) return false;
  const present = new Set(foldForMatch(text).split(" "));
  return words.some((w) => present.has(w));
}

/**
 * Q32: `query` is sent unquoted, so quote characters (and apostrophes that are not inside a word), a leading `-` and a
 * `word:` prefix are removed from it. `removed` has one entry per removal, in the order met; the entries carry the
 * caller's words as given.
 */
export function sanitizeQuery(q: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const unquoted = q.replace(QUOTE_CHARS, "").replace(STRAY_APOSTROPHE, "");
  if (unquoted !== q) removed.push("quote characters");
  const words: string[] = [];
  for (const word of unquoted.split(WHITESPACE)) {
    if (word === "") continue;
    let kept = word;
    const dashes = LEADING_DASHES.exec(kept);
    if (dashes) {
      removed.push(`leading "-" of "${word}"`);
      kept = kept.slice(dashes[0].length);
    }
    const prefix = FIELD_PREFIX.exec(kept);
    if (prefix) {
      removed.push(`prefix "${prefix[0]}"`);
      kept = kept.slice(prefix[0].length);
    }
    words.push(kept);
  }
  return { text: words.join(" "), removed };
}

/** ¶4.12 step 1: `form` as written with accents folded, and every punctuation run between two word characters dropped unless it is only apostrophes and dashes. */
export function asciiSuggestion(form: string): string {
  return foldAccents(form).replace(IN_WORD_PUNCT_RUN, (run) => (KEPT_RUN.test(run) ? run : ""));
}
