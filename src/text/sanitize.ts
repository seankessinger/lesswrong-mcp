// Layer 5 leaf. Makes forum text safe to print (¶3.7 "forum content is quoted data", Q79): a single-line field loses
// control characters and line breaks and is length-capped; block text only has its line breaks normalized, because it
// is quoted or fenced by the renderer. `cutMessage` is the ¶8 message hygiene for text that reaches an error or a log.
// Code points are written as `\u{2028}` throughout: the four-digit escape can reach a file as the literal character,
// and a literal U+2028 ends a regular-expression literal.
import { CONFIG } from "../config";

/** Every control character (`\p{Cc}`: tab, newline, CR, the C1 range), U+2028 and U+2029, and any run of spaces. */
const SPACE_RUN = /[\p{Cc}\u{2028}\u{2029} ]+/gu;

/**
 * The bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). In a name or a title they
 * only make the text display deceptively, so a single-line field loses them outright (they have no width). The other
 * format characters stay, ZWJ and ZWNJ among them, because scripts and emoji need them.
 */
const BIDI_CONTROL = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** A CRLF pair, a lone CR, U+2028 or U+2029: each is one line break. */
const LINE_BREAK = /\r\n|[\r\u{2028}\u{2029}]/gu;

/** The first line break of `cutMessage`: LF, CR, U+2028 or U+2029. */
const FIRST_BREAK = /[\n\r\u{2028}\u{2029}]/u;

// Built once; `en` only picks the rules' locale, and grapheme boundaries do not vary with it.
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A single-line field: the bidirectional controls are removed; control characters, newlines, CR, U+2028 and U+2029
 * become spaces (so a field can never forge a line), runs of spaces become one, the ends are trimmed. A result longer
 * than `max` code points is cut to the longest run of whole grapheme clusters that totals at most `max − 1` code points
 * (a cut never splits a ZWJ emoji or
 * leaves a combining mark without its base), trailing spaces trimmed, and ends with `…`, so it is at most `max` code
 * points long. `max` is at least 1. `null` and `undefined` are the empty string.
 */
export function oneLine(s: string | null | undefined, max: number): string {
  if (s === null || s === undefined) return "";
  const line = s.replace(BIDI_CONTROL, "").replace(SPACE_RUN, " ").trim();
  if (Array.from(line).length <= max) return line;
  const room = max - 1;
  let kept = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(line)) {
    const length = Array.from(segment).length;
    if (used + length > room) break;
    kept += segment;
    used += length;
  }
  return kept.trimEnd() + "…";
}

/** Block text (bodies, bios, wiki text): CRLF, CR, U+2028 and U+2029 become `\n`; nothing else changes. `null` and `undefined` are empty. */
export function blockText(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return s.replace(LINE_BREAK, "\n");
}

/** A message from the forum or from a failure, for an error or a log: only its first line, as `oneLine` capped at `max` (¶8: 200). */
export function cutMessage(s: string, max: number = CONFIG.render.caps.message): string {
  const first = FIRST_BREAK.exec(s);
  return oneLine(first === null ? s : s.slice(0, first.index), max);
}
