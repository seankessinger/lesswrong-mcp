// Layer 5 leaf. The phrase rules of ¶3.2.1, implemented once: how a `phrases` / `forms` entry is classified and what is
// sent to the forum (rules 1–5 and 7), how text and phrase are normalized for the local check (rule 6), the lenient
// `match` normalization and `query` sanitizing (Q32).
//
// The forum's search decides what a phrase can reach. Its index is built by Elasticsearch's `standard` tokenizer, which keeps some
// punctuation inside a word (`goodhart's`, `node.js`, `4.5`, `1,000`, `cousin_it`) and splits at the rest (`R&D`, `and/or`). Its query
// parser deletes punctuation from quoted text, and from every word of a query that holds a quoted phrase or a `-word`. So a quoted
// phrase can reach words split at punctuation, sent with spaces, and can't reach a word the index keeps whole: `"node.js"` is
// searched as `nodejs`. Unquoted text goes through the same analyzer as the index, so it reaches both, loosely.
//
// Terms. A word character is a letter or a digit (`[\p{L}\p{N}]`); punctuation is `[\p{P}\p{S}]`; the quote characters
// are " “ ” „ ‟ « » ‘ (the apostrophes ' and ’ are not among them); the dashes are the hyphens (U+2010–2012 among them), the en,
// em and horizontal-bar dashes and the minus sign; edge punctuation is a run of punctuation at the start or end of a text or next
// to whitespace. Code points are written as `\u{…}` (see sanitize.ts).
// Nothing here makes forum text safe to print: callers pass what they show through text/sanitize.
import { badInput, type ToolError } from "../errors";
import type { ClassifiedPhrase } from "../types";
import { oneLine } from "./sanitize";

/** ¶3.2.1 rule 1: a phrase as it is echoed back is cut to this many characters. */
const GIVEN_MAX = 100;

const QUOTE_CHARS = /["\u{201C}\u{201D}\u{201E}\u{201F}\u{AB}\u{BB}\u{2018}]/gu;
const DASHES = /[-\u{2010}-\u{2015}\u{2212}]/gu;
/** What a reader does not see inside a word: the soft hyphen, zero-width spaces and joiners, direction marks, the word joiner and the byte-order mark. */
const INVISIBLE = /[\u{AD}\u{200B}-\u{200F}\u{2060}\u{FEFF}]/gu;
/** An underscore not between two word characters: emphasis, or the edge of a word. Between them it joins a name (`cousin_it`). */
const LOOSE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const PUNCT_RUN = /[\p{P}\p{S}]+/gu;
const PUNCT = /[\p{P}\p{S}]/gu;
const WORD_CHARS = /[\p{L}\p{N}]/gu;
const WHITESPACE = /\s+/gu;
const SPACE = /\s/u;
const NON_ASCII = /[^\u{0}-\u{7F}]/u;
/**
 * Punctuation the index keeps inside a word (the Unicode word-break rules of the `standard` tokenizer): an apostrophe, period or
 * colon between letters; an apostrophe, period, comma or semicolon between digits; an underscore beside a word character, even at
 * the word's edge.
 */
const KEPT_IN_WORD = /\p{L}['.:]\p{L}|\p{N}['.,;]\p{N}|[\p{L}\p{N}]_|_[\p{L}\p{N}]/u;
/** The stop words the forum's analyzers drop from unquoted text (Elasticsearch's `_english_` list). */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such",
  "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

/** A possessive: an apostrophe and an `s` ending a word. Other apostrophe tails make a contraction (`won't`), another word altogether. */
const POSSESSIVE = /(?<=[\p{L}\p{N}])['\u{2019}]s(?![\p{L}\p{N}])/gu;
/** An apostrophe that does not sit between two word characters. */
const STRAY_APOSTROPHE = /(?<![\p{L}\p{N}])['\u{2019}]|['\u{2019}](?![\p{L}\p{N}])/gu;

/**
 * What a reader of the Markdown's page does not see, in the middle of what they read: a link's or image's target, with its brackets
 * escaped or balanced (an escaped `]` is text), and a footnote's marker.
 */
const MD_TARGET = /(?<!\\)\]\((?:\\[()]|[^()\s]|\([^()\s]*\))*(?:\s+"(?:\\.|[^"\\])*")?\)/gu;
/** An image's alternative text, which the page shows only in place of the image: what stays is a link target, which MD_TARGET removes. */
const MD_IMAGE_ALT = /!\[[^\]\n]*\](?=\()/gu;
const MD_FOOTNOTE = /\[\^[^[\]\s]*\]/gu;
/**
 * The marks of a subscript or superscript glued to a word, which a reader sees only as smaller letters: `CO~2~`. A caret that is
 * the text's own (`a^2+b^2`) holds more than letters and digits before the next one.
 */
const MD_SUB_SUP = /(?<=[\p{L}\p{N}])([~^])([\p{L}\p{N}]{1,10})\1(?![\p{L}\p{N}])/gu;
/** A paragraph break or the start of a list item, inside a quote too: the words after it do not follow on from the words before. */
const BLOCK_BREAK = /\n(?:[^\S\n]*>)*[^\S\n]*(?:\n|(?:[-*+]|\d+[.)])[^\S\n]+)\s*/gu;
/** Stands in a normalized text where a clause or a table cell ends, so that a phrase can't run across it. */
const STOP = "\u{E000}";
/** What ends a clause. A comma does not: "Gödel, Escher, Bach" holds "Godel Escher Bach". */
const CLAUSE_END = /[.:;!?|]/u;
/** Marks that belong to the word beside them: after a word `C++`, `C#`, `99%`; before one `.NET`. */
const TAIL_MARKS = /^[+#%]*/u;
const LEAD_DOT = /(?<!\.)\.$/u;
/** Scripts written without spaces between words, so a phrase in them needs no word edge; the long-vowel mark `ー` goes with Katakana. */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u{30FC}]/u;
/** A backslash before ASCII punctuation (Markdown escapes). */
const ESCAPED_PUNCT = /\\([\u{21}-\u{2F}\u{3A}-\u{40}\u{5B}-\u{60}\u{7B}-\u{7E}])/gu;

/** The letters NFKD leaves whole, folded to ASCII (`foldForMatch`). */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ß: "ss", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", Þ: "Th", ð: "d", Ð: "D", ı: "i",
};
const FOLDABLE_LETTERS = /[øØæÆœŒßłŁđĐþÞðÐı]/gu;

/** The ends of a query word that the forum would read as syntax (Q32). */
const LEADING_DASHES = /^-+(?=[^\s-])/u;
const FIELD_PREFIX = /^[A-Za-z0-9_]+:(?=\S)/u;
/** The prefixes the forum's parser turns into filters, in the lower case it compares with, at the start of a word sent unquoted. */
const FILTER_PREFIXES = /(?<!\S)(?:user|wikitag|tag):/gu;
/** A colon before apostrophes: the parser reads what comes before the colon as a prefix, and an apostrophe as opening a quoted token. */
const COLON_QUOTE = /:'+/gu;

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

/**
 * Edge punctuation settled for the check: a run inside a word stays, as do the marks of the word beside it; the rest goes, leaving
 * `STOP` where it ended a clause in the middle of the text.
 */
function settleEdgePunctuation(s: string): string {
  return s.replace(PUNCT_RUN, (run, at: number) => {
    const before = s[at - 1] ?? " ";
    const after = s[at + run.length] ?? " ";
    const wordBefore = !SPACE.test(before);
    const wordAfter = !SPACE.test(after);
    if (wordBefore && wordAfter) return run;
    const tail = wordBefore ? TAIL_MARKS.exec(run)![0] : "";
    const lead = (/\p{L}/u.test(after) && LEAD_DOT.exec(run)?.[0]) || "";
    const rest = run.slice(tail.length, run.length - lead.length);
    const inText = at > 0 && at + run.length < s.length;
    return `${tail}${inText && CLAUSE_END.test(rest) ? ` ${STOP} ` : ""}${lead}`;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

/**
 * `needle` occurs in `text` as whole words: no word character or word mark beside it, and no punctuation the index keeps inside a
 * word (KEPT_IN_WORD) joining it to more, so that `gpt 4` is not in `gpt 4.5`, `net` not in `.net`, `they won` not in `they won't`;
 * a possessive `'s` after it is allowed. A needle in a script written without spaces needs no edge.
 */
function hasWhole(text: string, needle: string): boolean {
  const chars = [...needle];
  const open = SPACELESS.test(chars[0] ?? "") ? "" : "(?<![\\p{L}\\p{N}.]|\\p{L}[':]|\\p{N}[',;]|[\\p{L}\\p{N}]_)";
  const close = SPACELESS.test(chars.at(-1) ?? "") ? ""
    : "(?![\\p{L}\\p{N}]|[+#%]+(?![\\p{L}\\p{N}])|\\.[\\p{L}\\p{N}]|(?<=\\p{L}):\\p{L}|(?<=\\p{N})[,;]\\p{N}|_[\\p{L}\\p{N}]|(?<=[\\p{L}\\p{N}])'(?!s(?![\\p{L}\\p{N}]))[\\p{L}\\p{N}])";
  return new RegExp(`${open}${escapeRegExp(needle)}${close}`, "u").test(text);
}

/**
 * ¶3.2.1 rules 1–5 and 7. `given` is the phrase on one line (NFKC, quote characters removed, at most 100 characters); `sent`
 * is what goes to the forum; `needle` is the normalized phrase every hit is checked for, apostrophe form kept (rule 6).
 * `param` names the parameter in the `bad_input` of rule 7. A phrase holding a word the index keeps whole, or a non-ASCII
 * character (which quotes delete), is `loose`: sent as written, unquoted. Any other is `exact`: quoted, with spaces for punctuation.
 */
export function classify(phrase: string, param: "phrases" | "forms"): ClassifiedPhrase {
  const given = oneLine(phrase.normalize("NFKC").replace(QUOTE_CHARS, ""), GIVEN_MAX);
  const spaced = given.replace(DASHES, " ");
  const words = collapse(dropEdgePunctuation(spaced));
  if (wordCharCount(words) < 2) {
    throw badInput(
      param,
      `${JSON.stringify(given)} has fewer than 2 letters or digits`,
      "A phrase needs at least 2 letters or digits; punctuation alone matches nothing.",
    );
  }
  const needle = normalizeText(given);
  // What the check reads: a phrase that is all footnote marker or link address leaves nothing to look for.
  if (wordCharCount(needle) < 2) {
    throw badInput(
      param,
      `${JSON.stringify(given)} holds fewer than 2 letters or digits outside link and footnote syntax`,
      "A phrase needs at least 2 letters or digits that a reader sees.",
    );
  }
  if (NON_ASCII.test(words) || KEPT_IN_WORD.test(spaced)) return { given, sent: asUnquoted(words), mode: "loose", needle };
  return { given, sent: collapse(words.replace(PUNCT, " ")), mode: "exact", needle };
}

/** `words` so that the forum's parser reads them as text: its prefixes are case-sensitive and the analyzers lower-case, so capitals keep the word. */
function asUnquoted(words: string): string {
  return collapse(words.replace(COLON_QUOTE, " ")).replace(FILTER_PREFIXES, (prefix) => prefix[0]!.toUpperCase() + prefix.slice(1));
}

/**
 * Whether nothing of a loose phrase reaches the forum: each of its words, cut at the apostrophe as the analyzers do, is a stop word
 * (`it's`, `that's it`). Quoting can't help, because quotes delete the apostrophe, so such a phrase can only be checked locally.
 */
export function onlyStopWords(phrase: ClassifiedPhrase): boolean {
  return phrase.mode === "loose" && phrase.sent.toLowerCase().split(" ").every((word) => STOP_WORDS.has(word.replace(/['\u{2019}].*$/u, "")));
}

/** The `bad_input` of a phrase that nothing else in the search can carry (`onlyStopWords`). */
export function stopWordsRefusal(phrase: ClassifiedPhrase, param: "phrases" | "forms"): ToolError {
  return badInput(
    param,
    `${JSON.stringify(phrase.given)} holds only words the forum's search ignores once each apostrophe and what follows it are dropped`,
    `Add a neighbouring word to the phrase, as in "it's raining".`,
  );
}

/** The phrase without its possessives: the other form `contains` reports. */
export function plainForm(phrase: ClassifiedPhrase): string {
  return phrase.given.replace(POSSESSIVE, "");
}

/**
 * ¶3.2.1 rule 6, the one normalization of text and phrase: link targets and footnote markers removed, so a phrase crosses them, and
 * a paragraph or list item break marked, and an image's alternative text removed; NFKC; lower case; quote characters removed and
 * the curly apostrophe straightened; backslash escapes of ASCII punctuation unescaped; `*`, the marks of a subscript or superscript
 * and invisible characters removed; dashes, and an underscore not inside a
 * name, to spaces; edge punctuation removed, except a word's own marks, and marked where it ends a clause; whitespace collapsed.
 * Accented letters and punctuation inside words are kept. So a phrase crosses what a reader reads past, commas and quotes among
 * them, and not the end of a sentence.
 */
export function normalizeText(s: string): string {
  const plain = s
    .replace(MD_IMAGE_ALT, "]")
    .replace(MD_TARGET, "")
    .replace(MD_FOOTNOTE, " ")
    .replace(BLOCK_BREAK, ` ${STOP} `)
    .normalize("NFKC")
    .toLowerCase()
    .replace(QUOTE_CHARS, "")
    .replace(/\u{2019}/gu, "'")
    .replace(ESCAPED_PUNCT, "$1")
    .replace(/\*/gu, "")
    .replace(MD_SUB_SUP, "$2")
    .replace(INVISIBLE, "")
    .replace(DASHES, " ")
    .replace(LOOSE_UNDERSCORE, " ");
  return collapse(settleEdgePunctuation(plain));
}

/**
 * Whether `text` contains the phrase (rule 6): "exact" when the needle occurs as whole words; otherwise the other side of
 * the apostrophe rule: "without-possessive" when the needle has a possessive (`newcomb's problem`) and the text has only
 * `newcomb problem`, "with-possessive" when the needle has none and the text has the possessive form; else false.
 */
export function contains(text: string, phrase: ClassifiedPhrase): "exact" | "without-possessive" | "with-possessive" | false {
  const t = normalizeText(text);
  if (hasWhole(t, phrase.needle)) return "exact";
  const plain = phrase.needle.replace(POSSESSIVE, "");
  if (plain !== phrase.needle) return hasWhole(t, plain) ? "without-possessive" : false;
  return hasWhole(t.replace(POSSESSIVE, ""), phrase.needle) ? "with-possessive" : false;
}

/** The `match` normalization: rule 6, then accents folded and every remaining punctuation character, and each clause end, turned into a space. */
export function foldForMatch(s: string): string {
  return collapse(foldAccents(normalizeText(s)).replaceAll(STOP, " ").replace(PUNCT, " "));
}

/** `match`: whether `text`, folded, holds `folded` (a needle already folded) as whole words; an empty needle matches nothing. */
export function matchesText(text: string, folded: string): boolean {
  return folded !== "" && ` ${foldForMatch(text)} `.includes(` ${folded} `);
}

/**
 * At least one word of `query` that has 2 or more letters or digits, and is not a word the forum's search ignores, occurs as a
 * whole word in `text` (both folded); false when the query has no such word.
 */
export function queryTermsIn(text: string, query: string): boolean {
  const words = foldForMatch(query).split(" ").filter((w) => wordCharCount(w) >= 2 && !STOP_WORDS.has(w));
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
