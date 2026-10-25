// Layer 3. The body clean-up of ¶3.7 and the body pipeline of ¶4.3 step 6: the suggestion clean-up of P15 (Q81, L8),
// widget fences replaced by a size note and `data:` images omitted (§6.5, Q78), the heading outline (ATX, setext h1/h2,
// whole-line bold paragraphs; Q93) with its numbered one-line form, `section = n` slicing, `match` with section and
// paragraph numbers, and collaborative dialogues converted from `contents.html` with speaker names, MathJax restored from
// `aria-label` and the injected `<b>Name</b>` headers removed (§6.4, Q95, Q134). The only module that imports turndown.
// Pure; only `sliceSection` throws (`bad_input`); caches nothing.
import TurndownService from "turndown";
import { CONFIG } from "../config";
import { badInput } from "../errors";
import { foldForMatch } from "../text/phrases";
import { oneLine } from "../text/sanitize";

/** One heading of the outline: `n` numbers it 1…N in document order; `line` is the 0-based index of its text line. */
export interface Heading { n: number; level: number; text: string; line: number }

/**
 * A body after the pipeline of ¶4.3 step 6, measured after the clean-up. Plain JSON (it is cached by version).
 * No reply prints `suggestionsRemoved`; it stays so that tests can check whether the clean-up removed anything.
 */
export interface ProcessedBody { md: string; version: string; words: number; suggestionsRemoved: boolean; footnotes: boolean; headings: Heading[] }

/** The editor types whose bodies get the suggestion clean-up. */
const EDITOR_TYPES: ReadonlySet<string> = new Set(["ckEditorMarkup", "lexical"]);
const isEditorType = (type: string | undefined): boolean => type !== undefined && EDITOR_TYPES.has(type);

const SUGGESTION_MARK = /<(ins|del)\b/;
const SUGGESTION_SPAN = /<(ins|del)\b[^>]*>([\s\S]*?)<\/\1>/g;
const TAG = /<[^>]*>/g;
/** Any character reference: numeric (decimal or hex) or named. */
const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;
/**
 * The named references the forum's HTML or its Markdown may hold where the words matter: the XML five, the non-breaking
 * space, and the Latin-1 letters (HTML 4 §24.2), which decode to letters the comparison keeps. Punctuation references
 * (`&hellip;`, `&mdash;`) need no entry: the comparison drops punctuation, and an unknown reference becomes a space.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u{A0}",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó",
  Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è",
  eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ", ograve: "ò",
  oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
  thorn: "þ", yuml: "ÿ", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ",
};
/** Markdown forms whose address is not text: an image (no words of its own in the HTML's text), an inline link, an autolink. */
const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MD_AUTOLINK = /<(https?:\/\/[^<>\s]+)>/g;
/** Everything the comparison ignores: whatever is not a letter or a digit. */
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

const WIDGET_OPEN = /^```widget\[[^\]\n]*\]\s*$/;
const WIDGET_CLOSE = /^```\s*$/;
const DATA_IMAGE = /!\[[^\]]*\]\(data:[^)]*\)/g;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const COLLAPSIBLE_OPEN = /^ {0,3}\+\+\+[ \t]+\S/;
const COLLAPSIBLE_CLOSE = /^ {0,3}\+\+\+\s*$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const SETEXT_H1 = /^ {0,3}=+\s*$/;
const SETEXT_H2 = /^ {0,3}-+\s*$/;
const BOLD_LINE = /^ {0,3}(?:>\s*)?\*\*([^*]+)\*\*\s*$/;
const INDENTED = /^(?: {4}| {0,3}\t)/;
const LIST_ITEM = /^\s{0,3}([*+-]|\d+[.)])\s/;
const QUOTE_LINE = /^ {0,3}>/;
const BLANK = /^\s*$/;
const BLANK_OR_BARE_QUOTE = /^\s*>?\s*$/;
/** The raw level of a whole-line bold paragraph: below every ATX level, before renumbering. */
const BOLD_LEVEL = 7;

const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:/m;
const WORD = /[\p{L}\p{N}]/u;

/** P15 Q81: whether the HTML is needed: for a dialogue (speakers, §6.4) or for the suggestion clean-up. */
export function needsHtml(md: string | null, type: string | undefined, dialogue: boolean): boolean {
  return dialogue || (isEditorType(type) && md !== null && SUGGESTION_MARK.test(md));
}

/** A character reference decoded (in one pass, so `&amp;lt;` stays `&lt;`); one that is not known becomes a space. */
function decodeEntity(_: string, name: string): string {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  }
  return ENTITIES[name] ?? " ";
}

/**
 * The words of a text as the HTML's rendering and the Markdown's writing share them: tags replaced by spaces, character
 * references decoded, then only letters and digits, lower-cased and NFC-normalized, with no spaces between them (a tag or
 * an emphasis mark beside a word must not split it). `markdown` first reduces an image to nothing, an inline link to its
 * text and an autolink to its address, which is what the HTML's anchor prints.
 */
function wordKey(s: string, markdown: boolean): string {
  const text = markdown ? s.replace(MD_IMAGE, " ").replace(MD_LINK, " $1 ").replace(MD_AUTOLINK, " $1 ") : s;
  return text.replace(TAG, " ").replace(ENTITY, decodeEntity).normalize("NFC").toLowerCase().replace(NOT_WORD, "");
}

/**
 * P15 Q81 L8: suggestion marks are removed where the HTML confirms them; other body types are never changed. A mark is
 * compared by its words (`wordKey`): the Markdown writes emphasis marks, backslash escapes and link addresses the HTML's
 * text does not have, and either side may hold a character reference, so the rule errs toward keeping. A mark with no
 * words is never confirmed, so it stays; and an HTML with no words confirms nothing.
 */
export function cleanSuggestions(md: string, html: string, type: string | undefined): { md: string; removed: boolean } {
  if (!isEditorType(type)) return { md, removed: false };
  const htmlText = wordKey(html, false);
  if (htmlText === "") return { md, removed: false };
  let removed = false;
  const out = md.replace(SUGGESTION_SPAN, (span, tag: string, inner: string) => {
    const text = wordKey(inner, true);
    if (text === "") return span;
    const present = htmlText.includes(text);
    if (tag === "ins" && !present) {
      removed = true;
      return "";
    }
    if (tag === "del" && present) {
      removed = true;
      return inner;
    }
    return span;
  });
  return { md: out, removed };
}

/** Q78 §6.5: each ```` ```widget[…] ```` block becomes `[interactive widget omitted, N KB]`; each `data:` image is omitted. */
export function stripWidgets(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!WIDGET_OPEN.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !WIDGET_CLOSE.test(lines[end])) end++;
    const inner = lines.slice(i + 1, end).join("\n");
    out.push(`[interactive widget omitted, ${Math.max(1, Math.ceil(new TextEncoder().encode(inner).length / 1024))} KB]`);
    i = end;
  }
  return out.join("\n").replace(DATA_IMAGE, "[embedded image omitted]");
}

/** A heading as found, before its level is renumbered; `span` counts its lines (2 for a setext heading's underline). */
interface FoundHeading { raw: number; text: string; line: number; span: number }

/** ¶3.7 §6.4 §6.5: the headings of `md`, skipping fenced code, indented code and `+++` collapsible bodies. */
function findHeadings(lines: readonly string[]): FoundHeading[] {
  const found: FoundHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  let collapsibleDepth = 0;
  const isSeparator = (i: number): boolean => i < 0 || i >= lines.length || BLANK_OR_BARE_QUOTE.test(lines[i]);
  const add = (raw: number, text: string, line: number, span: number): void => {
    const trimmed = text.trim();
    if (trimmed !== "") found.push({ raw, text: trimmed, line, span });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      const close = FENCE_OPEN.exec(line);
      if (close !== null && close[1][0] === fence.char && close[1].length >= fence.length && BLANK.test(close[2])) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    if (COLLAPSIBLE_OPEN.test(line)) {
      collapsibleDepth++;
      continue;
    }
    if (collapsibleDepth > 0) {
      if (COLLAPSIBLE_CLOSE.test(line)) collapsibleDepth--;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      add(atx[1].length, atx[2], i, 1);
      continue;
    }
    const next = lines[i + 1];
    const setextText = next !== undefined && !BLANK.test(line) && !INDENTED.test(line) && !line.includes("|") &&
      !LIST_ITEM.test(line) && !QUOTE_LINE.test(line);
    if (setextText && (SETEXT_H1.test(next) || SETEXT_H2.test(next))) {
      add(SETEXT_H1.test(next) ? 1 : 2, line, i, 2);
      i++;
      continue;
    }
    const bold = BOLD_LINE.exec(line);
    if (bold !== null && isSeparator(i - 1) && isSeparator(i + 1)) add(BOLD_LEVEL, bold[1], i, 1);
  }
  return found;
}

/** Q93: the outline, numbered 1…N in document order, the distinct raw levels renumbered 1…m in ascending order. */
export function outline(md: string): Heading[] {
  const found = findHeadings(md.split("\n"));
  const levels = [...new Set(found.map((h) => h.raw))].sort((a, b) => a - b);
  return found.map((h, i) => ({ n: i + 1, level: levels.indexOf(h.raw) + 1, text: h.text, line: h.line }));
}

/** ¶3.7: `1 A · 2   A.1 · …`, two spaces of indent per level below the top. */
export function outlineText(headings: readonly Heading[]): string {
  return headings.map((h) => `${h.n} ${"  ".repeat(h.level - 1)}${h.text}`).join(" · ");
}

/** ¶3.7: heading `n` through to the next heading of the same or a higher level (or the end). */
export function sliceSection(md: string, n: number, noun: "post" | "page"): string {
  const headings = outline(md);
  const count = headings.length;
  if (count === 0) throw badInput("section", `this ${noun} has no headings`, "Read it without section, or use match.");
  if (!Number.isInteger(n) || n < 1 || n > count) {
    throw badInput("section", `this ${noun} has ${count} section${count === 1 ? "" : "s"}`, `Use a number from 1 to ${count}.`);
  }
  const start = headings[n - 1];
  const end = headings.slice(n).find((h) => h.level <= start.level);
  const lines = md.split("\n");
  return lines.slice(start.line, end === undefined ? lines.length : end.line).join("\n").trimEnd();
}

/** One paragraph `matchInText` found: the heading it starts under (`null` before the first one), its number, its text. */
export type MatchHit = { section: number | null; paragraph: number; text: string };

/**
 * ¶4.3 `match`: the paragraphs (blocks between blank lines, heading-only blocks left out) that contain `needle` once both
 * are folded (case, accents and punctuation ignored). `section` is the heading the paragraph starts under (`null` before
 * the first one); `paragraph` counts from 1 among all `total` paragraphs. A needle that folds to nothing matches nothing.
 */
export function matchInText(md: string, needle: string): { total: number; hits: MatchHit[] } {
  const lines = md.split("\n");
  const found = findHeadings(lines);
  const headingLines = new Set(found.flatMap((h) => Array.from({ length: h.span }, (_, k) => h.line + k)));
  const folded = foldForMatch(needle);
  const hits: MatchHit[] = [];
  let total = 0;
  let i = 0;
  while (i < lines.length) {
    if (BLANK.test(lines[i])) {
      i++;
      continue;
    }
    const first = i;
    while (i < lines.length && !BLANK.test(lines[i])) i++;
    if (lines.slice(first, i).every((_, k) => headingLines.has(first + k))) continue;
    total++;
    const text = lines.slice(first, i).join("\n");
    if (folded === "" || !foldForMatch(text).includes(folded)) continue;
    const under = found.findLastIndex((h) => h.line <= first);
    hits.push({ section: under === -1 ? null : under + 1, paragraph: total, text });
  }
  return { total, hits };
}

/** The few DOM members the turndown rules read (turndown parses with domino; its types name the browser's `HTMLElement`). */
interface DomNode {
  nodeName: string;
  nodeType: number;
  textContent: string | null;
  parentNode: DomNode | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
type Attribute = (name: string) => string | null;
const hasClass = (attribute: Attribute, name: string): boolean => (attribute("class") ?? "").split(/\s+/).includes(name);
/** MathJax output: an `mjx-container`, or any element with an `aria-label` and the class `MathJax`. */
const isMath = (tag: string, attribute: Attribute): boolean =>
  tag.toLowerCase() === "mjx-container" || (attribute("aria-label") !== null && hasClass(attribute, "MathJax"));
const isMathNode = (el: DomNode): boolean => isMath(el.nodeName, (name) => el.getAttribute(name));
const isDialogueMessage = (el: DomNode): boolean =>
  el.nodeName.toLowerCase() === "section" && hasClass((name) => el.getAttribute(name), "dialogue-message");

/** An HTML start tag (a quoted attribute value may hold `>`), and one attribute in its attribute text. */
const START_TAG = /<([A-Za-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/**
 * Put first inside every MathJax element before turndown parses the HTML. MathJax CHTML draws its glyphs from CSS, so the
 * element holds no text: turndown would then treat it as blank (no rule applies; it becomes "") and its whitespace
 * collapsing would drop the space after it. A private-use character is text, and the math rule discards it.
 */
const MATH_MARK = "\u{E000}";

function markMath(html: string): string {
  return html.replace(START_TAG, (tag, name: string, attributes: string) => {
    const values = new Map<string, string>();
    for (const [, key, double, single, bare] of attributes.matchAll(ATTRIBUTE)) values.set(key.toLowerCase(), double ?? single ?? bare ?? "");
    return isMath(name, (key) => values.get(key) ?? null) ? tag + MATH_MARK : tag;
  });
}

/** Q134: MathJax output back to `$…$` or `$$…$$` from its `aria-label`; without a label, whatever its children gave. */
function mathMarkdown(content: string, el: DomNode): string {
  const label = (el.getAttribute("aria-label") ?? "").trim();
  if (label === "") return content.replaceAll(MATH_MARK, "");
  return el.getAttribute("display") === "true" ? `\n\n$$${label}$$\n\n` : `$${label}$`;
}

/** The dialogue message `el` sits in, if any. */
function dialogueMessageOf(el: DomNode): DomNode | null {
  for (let p = el.parentNode; p !== null; p = p.parentNode) if (p.nodeType === ELEMENT_NODE && isDialogueMessage(p)) return p;
  return null;
}

/** A dialogue message's speaker as the forum wrote it (trimmed): what its injected header holds. */
const speakerName = (message: DomNode): string => (message.getAttribute("display-name") ?? "").trim();
/** Whitespace runs as one space, trimmed: turndown collapses the header's text this way when it parses the HTML. */
const collapsed = (s: string): string => s.replace(/\s+/g, " ").trim();
const isBold = (el: DomNode): boolean => ["b", "strong"].includes(el.nodeName.toLowerCase());
/** The children that give a header its shape: elements, and text that is not blank (comments and whitespace do not count). */
const meaningfulChildren = (el: DomNode): DomNode[] =>
  Array.from(el.childNodes).filter((c) => c.nodeType === ELEMENT_NODE || (c.nodeType === TEXT_NODE && !BLANK.test(c.textContent ?? "")));
const HEADER_TAGS: ReadonlySet<string> = new Set(["b", "strong", "p", "div", "section"]);

/**
 * Q134: the forum's injected speaker header inside a dialogue message with a name, in any of three shapes: a `<b>Name</b>`
 * (or `<strong>`) that is the message's first child (the §6.4 shape), or a `p`, `div` or `section` holding only that bold
 * name. The name is compared as the forum wrote it (whitespace runs aside), not as it is printed (cut at 60). A bold
 * name inside the text stays.
 */
function isInjectedHeader(el: DomNode): boolean {
  if (!HEADER_TAGS.has(el.nodeName.toLowerCase()) || isDialogueMessage(el)) return false;
  const message = dialogueMessageOf(el);
  if (message === null) return false;
  const name = collapsed(speakerName(message));
  if (name === "" || collapsed(el.textContent ?? "") !== name) return false;
  if (isBold(el)) return el.parentNode === message && meaningfulChildren(message)[0] === el;
  const children = meaningfulChildren(el);
  return children.length === 1 && isBold(children[0]);
}

const dialogueTurndown = new TurndownService({ headingStyle: "setext", strongDelimiter: "**" })
  .addRule("mathjax", {
    filter: (node) => isMathNode(node as unknown as DomNode),
    replacement: (content, node) => mathMarkdown(content, node as unknown as DomNode),
  })
  .addRule("dialogueMessage", {
    filter: (node) => isDialogueMessage(node as unknown as DomNode),
    replacement: (content, node) => {
      // ¶3.7 Q79: a display name is a single-line field, so it cannot break the label's line or forge a heading.
      const label = oneLine(speakerName(node as unknown as DomNode), CONFIG.render.caps.name);
      return label === "" ? `\n\n${content.trim()}\n\n` : `\n\n**${label}:**\n\n${content.trim()}\n\n`;
    },
  })
  .addRule("injectedSpeakerHeader", {
    filter: (node) => isInjectedHeader(node as unknown as DomNode),
    replacement: () => "",
  });

/** Q95 Q134 §6.4: a collaborative dialogue's HTML as Markdown, each message under its speaker's name. */
export function dialogueHtmlToMarkdown(html: string): string {
  return dialogueTurndown.turndown(markMath(html));
}

/** A footnote definition line (`[^id]: …`), not a mere reference. */
export function hasFootnotes(md: string): boolean {
  return FOOTNOTE_DEFINITION.test(md);
}

/** Whitespace-separated tokens that contain a letter or a digit. */
export function countWords(md: string): number {
  return md.split(/\s+/).filter((token) => WORD.test(token)).length;
}

/**
 * ¶4.3 step 6: a dialogue's text from its HTML, any other body from `contents.markdown`; suggestions removed where the
 * HTML confirms them (never for a dialogue); widgets and `data:` images replaced; then measured and outlined.
 */
export function processBody(input: { markdown: string | null; html?: string; type?: string; dialogue: boolean; version: string }): ProcessedBody {
  let md = input.dialogue && input.html ? dialogueHtmlToMarkdown(input.html) : input.markdown ?? "";
  let suggestionsRemoved = false;
  if (!input.dialogue && input.html !== undefined) {
    const cleaned = cleanSuggestions(md, input.html, input.type);
    md = cleaned.md;
    suggestionsRemoved = cleaned.removed;
  }
  md = stripWidgets(md);
  return { md, version: input.version, words: countWords(md), suggestionsRemoved, footnotes: hasFootnotes(md), headings: outline(md) };
}
