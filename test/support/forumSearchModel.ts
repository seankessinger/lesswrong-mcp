// A small model of what the forum's search does to text, so a test can ask whether a query could reach what a writer wrote.
// It follows the forum's own code (ForumMagnum's `ElasticExporter.ts` analyzers and `parseQuery.ts`, read on 2026-11-04) and
// what was measured against the forum that day. It is a model, not the forum: it says whether a query can match a text, not
// how hits rank, and it leaves out stemming, synonyms, typo matching, the title-prefix clause and matching per field.

/** `parseQuery`'s pattern: an optional `word:` or `-` prefix, then a double-quoted, single-quoted or bare token. */
const QUERY_TOKEN = /(\w+:|-)?("[^"]*"|'[^']*'|[^\s]+)/g;

/**
 * The `standard` tokenizer: apostrophes, periods and colons stay inside a word between letters; apostrophes, periods, commas and
 * semicolons between digits; underscores always. Every other mark splits words.
 */
const WORD = /[\p{L}\p{N}_]+(?:(?<=\p{L})['\u{2019}.:](?=\p{L})[\p{L}\p{N}_]+|(?<=\p{N})['\u{2019}.,;](?=\p{N})[\p{L}\p{N}_]+)*/gu;

/** The prefixes `parseQuery` acts on, compared case-sensitively: each makes the query advanced and the word a filter. */
const FILTER_PREFIXES: ReadonlySet<string | undefined> = new Set(["user:", "tag:", "wikitag:"]);

/** The `_english_` stop list of the `fm_english_stopwords` filter. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such",
  "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

const words = (s: string): string[] => s.toLowerCase().match(WORD) ?? [];

/** `fm_exact_analyzer`, the field a quoted phrase searches: the tokenizer and lower case, nothing else. */
export const exactWords = words;

/** `fm_synonym_analyzer`, the field unquoted text searches: `( ) _ -` become spaces, an apostrophe and what follows go, stop words go. */
export function looseWords(s: string): string[] {
  return words(s.replace(/[()_-]+/g, " "))
    .map((w) => w.replace(/['\u{2019}].*$/u, ""))
    .filter((w) => w !== "" && !STOPWORDS.has(w));
}

/** What `parseQuery` leaves of a token: dashes and underscores become spaces, and anything else outside `\w` and whitespace is deleted. */
const stripped = (token: string): string => token.replace(/[-_]/g, " ").replace(/[^\w\s]/g, "");

function hasRun(run: readonly string[], text: readonly string[]): boolean {
  if (run.length === 0) return false;
  return text.some((_, at) => run.every((w, i) => text[at + i] === w));
}

/** `minimum_should_match: "75%"`, rounded down, of the query's words, a repeated word counted each time. */
function mostWordsIn(query: string, text: string): boolean {
  const asked = looseWords(query);
  const present = new Set(looseWords(text));
  if (asked.length === 0) return false;
  return asked.filter((w) => present.has(w)).length >= Math.max(1, Math.floor(asked.length * 0.75));
}

/**
 * Whether the forum could return `text` for `query`. A quoted token or a `-word` puts the whole query in advanced mode, where every
 * token loses its punctuation: quoted tokens must then occur as a run of exact words, and bare ones only rank. Otherwise the query
 * reaches the analyzers as written. A filter prefix narrows to an author or tag, which the text alone can't satisfy.
 */
export function reaches(query: string, text: string): boolean {
  const tokens = [...query.matchAll(QUERY_TOKEN)].map(([, prefix, token]) => ({ prefix, token: token! }));
  if (tokens.some((t) => FILTER_PREFIXES.has(t.prefix))) return false;
  const quoted = tokens.filter((t) => /^".+"$|^'.+'$/.test(t.token));
  const excluded = tokens.filter((t) => t.prefix === "-");
  if (quoted.length === 0 && excluded.length === 0) return mostWordsIn(query, text);
  const hit = quoted.length > 0
    ? quoted.every((t) => hasRun(exactWords(stripped(t.token)), exactWords(text)))
    : tokens.some((t) => t.prefix !== "-" && mostWordsIn(stripped(t.token), text));
  return hit && !excluded.some((t) => mostWordsIn(stripped(t.token), text));
}
