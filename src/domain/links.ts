// Layer 3. Finds the outgoing links of a Markdown text (¶4.13): inline links, autolinks and bare URLs, outside fenced
// code and never images, in order of first appearance, de-duplicated by the entity they name. Each is classified with
// `parseLink` (ids/parse), which knows the onsite hosts of §12. The text is the body Markdown as the forum sent it,
// so only the current text is read, never the stored `pingbacks`. Pure: it never throws and never logs.
import { type LinkTarget, parseLink } from "../ids/parse";

/** One outgoing link: the address (site-relative ones resolved to https://www.lesswrong.com), its link text when it had one, and what it points at. */
export interface LinkRef { url: string; text?: string; target: LinkTarget }

const SITE = "https://www.lesswrong.com";
// A post body is author-controlled and this runs synchronously, out of reach of the call deadline, so every pattern here
// must take time linear in the text. What keeps them so: the alternatives of a repeated group start with different
// characters, and no group can run over what starts the next match (a raw `[` in link text, a `<` in an autolink, an
// unbalanced `(` in an address); a test feeds each known worst case to `extractLinks` and bounds the time.
/** An inline address: backslash escapes and one level of balanced parentheses (as CommonMark), no whitespace, `<` or `>`; an unbalanced `(` or `)` ends it. */
const ADDRESS = String.raw`(?:\\\S|[^\s()<>\\]|\((?:\\\S|[^\s()<>\\])*\))+`;
const TITLE = String.raw`(?:\s+"[^"]*")?`;
/** `![alt](url)`; the alt holds no raw bracket (an escaped one is fine). */
const IMAGE = String.raw`!\[(?:\\[\s\S]|[^\[\]\\])*\]\(\s*<?${ADDRESS}>?${TITLE}\s*\)`;
/**
 * `[text](url)` and `![alt](url)`, the address optionally in angle brackets and optionally followed by a title. The
 * text holds no raw `[` (so a match never spans another opening bracket) except as an image, `[![alt](src)](href)`,
 * which is how Turndown writes a clickable image. A match never starts at an escaped `[`.
 */
const INLINE = new RegExp(String.raw`(?<!\\)(!?)\[((?:\\[\s\S]|[^\[\]\\!]|!(?!\[)|${IMAGE})*)\]\(\s*<?(${ADDRESS})>?${TITLE}\s*\)`, "g");
const IMAGE_IN_TEXT = new RegExp(IMAGE, "g");
/** `<url>`; it stops at a `<`, so an unclosed `<` never makes the next ones rescan the same text. */
const AUTOLINK = /<(https?:\/\/[^<>\s]+)>/g;
/** A bare URL stops at whitespace, brackets, quotes and a backtick (the end of an inline code span); it holds balanced parentheses, so `Foo_(bar)` is whole and `(https://x.org/d)` is not. */
const BARE = /https?:\/\/(?:[^\s<>()[\]"'`]|\([^\s<>()[\]"'`]*\))+/g;
const TRAILING_PUNCTUATION = ".,;:!?";
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** A fence line is indented at most three spaces (CommonMark, as `domain/markdown` reads it); four or more is indented code, so a literal ``` there opens nothing. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

const blanks = (n: number): string => " ".repeat(n);

/** The text with its CommonMark backslash escapes removed (`\_` is `_`, `\(` is `(`), as Turndown writes them in addresses and text. Named so as not to shadow the global `unescape`. */
const unescapeMarkdown = (s: string): string => s.replace(BACKSLASH_ESCAPE, "$1");

/** The text without its trailing `.,;:!?`, cut by a scan from the end (a regex anchored at `$` rescans a long run of them from every start). */
function stripTrailingPunctuation(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/**
 * The text with every fenced code block (opening and closing fence lines included) overwritten by spaces, so offsets
 * and line lengths are unchanged. A fence closes with the same character, at least as long; an unclosed one runs to the
 * end. A backtick fence whose own line holds another backtick is an inline code span, not a fence, and a fence line
 * indented four spaces or more is indented code, neither opening nor closing one.
 */
function blankFences(md: string): string {
  const lines = md.split("\n");
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === undefined) {
      const open = FENCE_OPEN.exec(line);
      if (!open || (open[1][0] === "`" && open[2].includes("`"))) continue;
      fence = open[1];
    } else {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
    }
    lines[i] = blanks(line.length);
  }
  return lines.join("\n");
}

/** The text with the given ascending, non-overlapping `[start, end)` spans overwritten by spaces. */
function blankSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + blanks(end - start);
    at = end;
  }
  return out + text.slice(at);
}

/** An absolute web address as given, a `//host/…` address read as https, a `/…` path on the site; anything else (`mailto:`, `#…`, a bare relative path) is not a link to follow. */
function resolveUrl(raw: string): string | undefined {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `${SITE}${raw}`;
  return undefined;
}

interface Found { index: number; url: string; text?: string }

/**
 * ¶4.13, Q103: the links of `md`. Inline links come first from the text, then autolinks and bare URLs from what those
 * left, so the address of an image or of a link already taken is never read a second time. A linked image,
 * `[![alt](src)](href)`, is one link to `href` whose text has the image taken out (and so is absent when nothing else
 * is in it). Backslash escapes (`\_`, `\(`), which Turndown writes, are removed from inline addresses and bare URLs.
 * Trailing `.,;:!?` is stripped from bare URLs only. Two links name the same target when they share an entity
 * (`post:<id>`, `tag:<slug>`, …) or, for any other link, the same address; the first one stays, with its own address
 * and text. The text is the inline link's bracket text, absent for autolinks, bare URLs and empty brackets.
 */
export function extractLinks(md: string): LinkRef[] {
  const found: Found[] = [];
  let rest = blankFences(md);

  const inlineSpans: [number, number][] = [];
  for (const m of rest.matchAll(INLINE)) {
    inlineSpans.push([m.index, m.index + m[0].length]);
    if (m[1] === "") found.push({ index: m.index, url: unescapeMarkdown(m[3]), text: m[2].replace(IMAGE_IN_TEXT, "") });
  }
  rest = blankSpans(rest, inlineSpans);

  const autoSpans: [number, number][] = [];
  for (const m of rest.matchAll(AUTOLINK)) {
    autoSpans.push([m.index, m.index + m[0].length]);
    found.push({ index: m.index, url: m[1] });
  }
  rest = blankSpans(rest, autoSpans);

  for (const m of rest.matchAll(BARE)) found.push({ index: m.index, url: stripTrailingPunctuation(unescapeMarkdown(m[0])) });

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const links: LinkRef[] = [];
  for (const f of found) {
    const url = resolveUrl(f.url);
    if (url === undefined) continue;
    const target = parseLink(url);
    if (!target.onsite && target.domain === "") continue;
    const key = target.onsite && target.ref ? `${target.ref.kind}:${target.ref.value}` : url;
    if (seen.has(key)) continue;
    seen.add(key);
    const link: LinkRef = { url, target };
    if (f.text !== undefined && f.text.trim() !== "") link.text = f.text;
    links.push(link);
  }
  return links;
}
