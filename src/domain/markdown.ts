// Layer 3. A post's text and the body pipeline of ¶4.3 step 6: `pageText`, a post's page as Markdown, with a dialogue's speakers
// from the page (§6.4, Q95, Q134); widget fences replaced by a size note and `data:` images omitted (§6.5, Q78), the heading
// outline (ATX, setext h1/h2, whole-line bold paragraphs; Q93) with its numbered one-line form, `section = n` slicing, and `match`
// with section and paragraph numbers. The only module that imports turndown.
// Pure; only `sliceSection` throws (`bad_input`); caches nothing.
import TurndownService from "turndown";
import { CONFIG } from "../config";
import { badInput } from "../errors";
import { foldForMatch, matchesText } from "../text/phrases";
import { blockText, oneLine } from "../text/sanitize";

/** One heading of the outline: `n` numbers it 1…N in document order; `line` is the 0-based index of its text line. */
export interface Heading { n: number; level: number; text: string; line: number }

/**
 * A body after the pipeline of ¶4.3 step 6, measured after the clean-up. Plain JSON (it is cached by version).
 */
/**
 * `labels`: the line numbers of a named dialogue's speaker labels in `md`, and `turnEnds` those of each turn's last line, as the
 * converter marked them (see `pageText`).
 */
export interface ProcessedBody {
  md: string; version: string; words: number; headings: Heading[]; labels: readonly number[]; turnEnds: readonly number[];
}

const WIDGET_OPEN = /^```widget\[[^\]\n]*\]\s*$/;
const WIDGET_CLOSE = /^```\s*$/;
const DATA_IMAGE = /!\[[^\]]*\]\(data:[^)]*\)/g;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const COLLAPSIBLE_OPEN = /^ {0,3}\+\+\+[ \t]+\S/;
const COLLAPSIBLE_CLOSE = /^ {0,3}\+\+\+\s*$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const SETEXT_H1 = /^ {0,3}=+\s*$/;
const SETEXT_H2 = /^ {0,3}-+\s*$/;
/** A whole-line bold paragraph; one with a second bold run in it (`**A** and **B**`) is refused where it is matched (#75). */
const BOLD_LINE = /^ {0,3}(?:>\s*)?\*\*(\S(?:.*\S)?)\*\*\s*$/;
/**
 * A link's address, with the title the converter may write after it (whose parentheses are not escaped); raw wiki Markdown can
 * hold balanced parentheses in an address, as CommonMark allows (`…/Mercury_(planet)`).
 */
const LINK_ADDRESS = `\\((?:[^()\\s\\\\]|\\\\.|\\((?:[^()\\s\\\\]|\\\\.)*\\))*(?:\\s+"(?:[^"\\\\]|\\\\.)*")?\\)`;
/** The same wrapped in a link, which the site's table of contents counts too (its <strong> is the paragraph's whole text). */
const BOLD_LINK_LINE = new RegExp(`^ {0,3}(?:>\\s*)?\\[\\*\\*(\\S(?:.*\\S)?)\\*\\*\\]${LINK_ADDRESS}\\s*$`);
/**
 * The marks on a named dialogue's label lines and on each turn's last line while a converted text goes to `processBody` (see
 * `pageText`); never in any text shown. Each starts with U+0000, which no converted page holds: the HTML parser drops it from text
 * and makes it U+FFFD in a reference or an attribute (and the forum's database can't store it), so no author's line ends in one.
 */
const LABEL_MARK = "\u0000L";
const TURN_END_MARK = "\u0000E";
const MARKS = /\u0000[LE]/g;
const INDENTED = /^(?: {4}| {0,3}\t)/;
const LIST_ITEM = /^\s{0,3}([*+-]|\d+[.)])\s/;
const QUOTE_LINE = /^ {0,3}>/;
const BLANK = /^\s*$/;
const BLANK_OR_BARE_QUOTE = /^\s*>?\s*$/;
/** The raw level of a whole-line bold paragraph: below every ATX level, before renumbering. */
const BOLD_LEVEL = 7;

const WORD = /[\p{L}\p{N}]/u;

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

/**
 * #75: an outline entry's text, as the site titles one (the element's text, lib/tableOfContents.ts): a link's text without its
 * address, no image, footnote marker, emphasis or code mark, and turndown's escapes undone; an equation's TeX is left as it is.
 */
function headingText(md: string): string {
  return md
    .replace(new RegExp(`!\\[(?:\\\\.|[^\\]\\\\])*\\]${LINK_ADDRESS}`, "g"), "")
    .replace(new RegExp(`\\[((?:\\\\.|[^\\]\\\\])*)\\]${LINK_ADDRESS}`, "g"), (_: string, text: string) => text)
    .replace(/\[\^[^\]\s]+\]/g, "")
    .split(/(\$[^$\n]+\$)/)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/~~(.+?)~~|~([^~\s]+)~|\^([^^\s]+)\^/g, (_: string, s?: string, sub?: string, sup?: string) => s ?? sub ?? sup ?? "")
      .replace(/\\([\\*_\-+=#`~[\]>.|^])|[*`]/g, (_: string, e?: string) => e ?? "")))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¶3.7 §6.4 §6.5: the headings of `md`, skipping fenced code, indented code and `+++` collapsible bodies. A named dialogue's
 * speaker labels (`labels`, the numbers of the lines the converter marked) are no headings, as the site's table of contents
 * never counts one; an author's own bold line, even one equal to a label, still is (#75).
 */
function findHeadings(lines: readonly string[], labels?: ReadonlySet<number>): FoundHeading[] {
  const found: FoundHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  let collapsibleDepth = 0;
  const isSeparator = (i: number): boolean => i < 0 || i >= lines.length || BLANK_OR_BARE_QUOTE.test(lines[i]);
  const add = (raw: number, text: string, line: number, span: number): void => {
    const clean = headingText(text);
    if (clean !== "") found.push({ raw, text: clean, line, span });
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
    if (labels?.has(i) === true) continue;
    const bold = BOLD_LINE.exec(line) ?? BOLD_LINK_LINE.exec(line);
    const wholeLine = bold !== null && !bold[1].replace(/\\./g, "").includes("**");
    if (wholeLine && isSeparator(i - 1) && isSeparator(i + 1)) add(BOLD_LEVEL, bold[1], i, 1);
  }
  return found;
}

/** Q93: the outline, numbered 1…N in document order, the distinct raw levels renumbered 1…m in ascending order. */
export function outline(md: string, labels?: ReadonlySet<number>): Heading[] {
  const found = findHeadings(md.split("\n"), labels);
  const levels = [...new Set(found.map((h) => h.raw))].sort((a, b) => a - b);
  return found.map((h, i) => ({ n: i + 1, level: levels.indexOf(h.raw) + 1, text: h.text, line: h.line }));
}

/** ¶3.7: `1 A · 2   A.1 · …`, two spaces of indent per level below the top. */
export function outlineText(headings: readonly Heading[]): string {
  return headings.map((h) => `${h.n} ${"  ".repeat(h.level - 1)}${h.text}`).join(" · ");
}

/** ¶3.7: heading `n` through to the next heading of the same or a higher level (or the end). */
export function sliceSection(md: string, n: number, noun: "post" | "page", labels?: ReadonlySet<number>, ends?: ReadonlySet<number>): string {
  const headings = outline(md, labels);
  const count = headings.length;
  if (count === 0) throw badInput("section", `this ${noun} has no headings`, "Read it without section, or use match.");
  if (!Number.isInteger(n) || n < 1 || n > count) {
    throw badInput("section", `this ${noun} has ${count} section${count === 1 ? "" : "s"}`, `Use a number from 1 to ${count}.`);
  }
  const start = headings[n - 1];
  const end = headings.slice(n).find((h) => h.level <= start.level);
  const lines = md.split("\n");
  let to = end === undefined ? lines.length : end.line;
  if (labels === undefined || labels.size === 0) return lines.slice(start.line, to).join("\n").trimEnd();
  // In a named dialogue a section opens with the label of the turn it starts in, as the page's message box shows its speaker; a
  // label that opens the next section's turn belongs to that section, not to the end of this one. A heading after a turn's end
  // (`ends`) and in no message opens with no label (the final check).
  while (to > start.line && (BLANK.test(lines[to - 1]!) || labels.has(to - 1))) to--;
  let speaker: string | undefined;
  for (let i = start.line - 1; i >= 0 && speaker === undefined && ends?.has(i) !== true; i--) if (labels.has(i)) speaker = lines[i];
  const body = lines.slice(start.line, to).join("\n").trimEnd();
  return speaker === undefined ? body : `${speaker}\n\n${body}`;
}

/** One paragraph `matchInText` found: the heading it starts under (`null` before the first one), its number, its text. */
export type MatchHit = { section: number | null; paragraph: number; text: string };

/**
 * ¶4.3 `match`: the paragraphs (blocks between blank lines; in a dialogue a speaker's label is not one) that contain `needle` as
 * whole words once both are folded (case and accents ignored, punctuation read as a space). `section` is the heading the paragraph
 * starts under (`null` before the first one); `paragraph` counts from 1 among all `total` paragraphs. A needle that folds to nothing
 * matches nothing.
 */
export function matchInText(md: string, needle: string, labels?: ReadonlySet<number>): { total: number; hits: MatchHit[] } {
  const lines = md.split("\n");
  const found = findHeadings(lines, labels);
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
    const text = lines.slice(first, i).join("\n");
    if (labels?.has(first) === true) continue;
    total++;
    if (!matchesText(text, folded)) continue;
    const under = found.findLastIndex((h) => h.line <= first);
    hits.push({ section: under === -1 ? null : under + 1, paragraph: total, text });
  }
  return { total, hits };
}

/** The few DOM members the turndown rules read (turndown parses with domino; its types name the browser's `HTMLElement`). */
interface DomNode {
  nodeName: string;
  textContent: string | null;
  outerHTML: string;
  isBlock?: boolean;
  parentNode: DomNode;
  childNodes: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null | undefined;   // domino's answer for no match is undefined
  nextElementSibling: DomNode | null;
}

const dom = (node: unknown): DomNode => node as DomNode;
const hasClass = (el: DomNode, name: string): boolean => (el.getAttribute("class") ?? "").split(/\s+/).includes(name);

const isDialogueMessage = (el: DomNode): boolean => el.nodeName === "SECTION" && hasClass(el, "dialogue-message");

/** A dialogue's message input: never page text. */
const isMessageBox = (el: DomNode): boolean => hasClass(el, "dialogue-message-input") || hasClass(el, "dialogue-message-input-wrapper");

/** The conditions of a conditional block that a reader with no reading history can meet: inverted, and only these. */
const REQUISITE_BLOCKS: readonly unknown[] = ["knowsRequisite", "wantsRequisite", "ifPathBeforeOrAfter"];

/** A block in the HTML that the page never shows a logged-out reader: a to-do, a fix-me, a comment, or a condition they don't meet. */
function isHiddenBlock(el: DomNode): boolean {
  if (!hasClass(el, "conditionallyVisibleBlock")) return false;
  try {
    const options = JSON.parse(el.getAttribute("data-visibility") ?? "") as { type?: unknown; inverted?: unknown };
    return !(REQUISITE_BLOCKS.includes(options.type) && options.inverted === true);
  } catch {
    return true;
  }
}

/** How the text after a message is marked, so that it does not read as the words of the speaker above it. */
const OUTSIDE_THE_DIALOGUE = "**Outside the dialogue:**";
/** A message the page shows no name for (`speakerName`), so that it reads as a turn of its own, not as the words above it. */
const UNNAMED_SPEAKER = "Unnamed speaker";

/**
 * Whether anything a reader sees follows `message` before the next one, other than a heading, which is nobody's words. Footnotes
 * are the messages' own, and what the page leaves out or never shows does not count.
 */
function textFollows(message: DomNode): boolean {
  for (let el = message.nextElementSibling; el !== null && !isDialogueMessage(el); el = el.nextElementSibling) {
    if (/^(?:H[1-6]|STYLE)$/.test(el.nodeName) || hasClass(el, "footnotes") || isMessageBox(el) || isHiddenBlock(el)) continue;
    if (el.querySelector(".dialogue-message-input")) continue;
    if ((el.textContent ?? "").trim() !== "" || el.nodeName === "IMG" || el.querySelector("img, iframe")) return true;
  }
  return false;
}

/** An equation, in either form the forum has written: an `mjx-container` (MathJax 3, today's), or an older renderer's `mjx-chtml`. */
const isEquation = (el: DomNode): boolean => el.nodeName.toLowerCase() === "mjx-container" || hasClass(el, "mjx-chtml");

/**
 * Q134: an equation back to `$…$` or `$$…$$` from its TeX. An `mjx-container` has the TeX in its `aria-label` and a display equation
 * has `display`. An `mjx-chtml` has it in the `aria-label` of its `mjx-math`, and a display equation has the class `MJXc-display`, or
 * `mjpage__block` on the wrapper. Stored pages from 2026-02-11 to 2026-07-29 have no `aria-label`, and the forum's repair reached only
 * each post's latest version, so an older version's equation has no text to give. A blank label is a blank equation. An equation is
 * one line, as in the forum's Markdown: a line of its own holding only `=` would read as a heading's underline.
 */
function mathMarkdown(content: string, el: DomNode): string {
  const older = hasClass(el, "mjx-chtml");
  const label = ((older ? el.querySelector(".mjx-math") : el)?.getAttribute("aria-label") ?? "").trim().replace(/\s*\n\s*/g, " ");
  if (label === "") return !older && el.getAttribute("aria-label") === null ? EQUATION_NOTE : content.replaceAll(MARK, "");
  const display = older ? hasClass(el, "MJXc-display") || hasClass(el.parentNode, "mjpage__block") : el.getAttribute("display") === "true";
  return display ? `\n\n$$${label}$$\n\n` : `$${label}$`;
}

export const EQUATION_NOTE = "[equation]";
const WIDGET_NOTE = "[interactive widget omitted]";

/**
 * A dialogue message's speaker as the page names them. The forum writes the header from the current display name
 * (`handleDialogueHtml`) and leaves it out when it finds no such user; then the page names nobody, whatever `display-name` holds.
 */
const speakerName = (message: DomNode): string => (message.querySelector(".dialogue-message-header")?.textContent ?? "").trim();

/** A footnote's id, on its marker or its definition: `data-footnote-id`, in older pages inside the `id`, and in the Markdown editor's in the marker's link. */
const footnoteId = (el: DomNode): string =>
  (el.getAttribute("data-footnote-id") ?? el.getAttribute("id") ?? el.querySelector("a")?.getAttribute("href") ?? "").replace(/^#?fn(?:ref)?-?/, "");

/** The most columns a table cell is taken to span. */
const MAX_COLUMN_SPAN = 50;
const columnSpan = (cell: DomNode): number => Math.max(1, Math.min(Number(cell.getAttribute("colspan") ?? 1) || 1, MAX_COLUMN_SPAN));
const isCell = (node: DomNode): boolean => node.nodeName === "TH" || node.nodeName === "TD";
/** #69: whether `el` sits inside a table cell, where a quote has no line of its own. */
function inCell(el: DomNode): boolean {
  for (let n: DomNode | null | undefined = el.parentNode; n != null; n = n.parentNode) if (isCell(n)) return true;
  return false;
}
const cellsOf = (row: DomNode): DomNode[] => Array.from(row.childNodes).filter(isCell);

/** A table cell on one line, the first of its row opening it, and an empty cell for each further column it spans. */
function tableCell(content: string, cell: DomNode): string {
  const text = content.trim().replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|");
  return `${cellsOf(cell.parentNode)[0] === cell ? "| " : " "}${text} |${"   |".repeat(columnSpan(cell) - 1)}`;
}

/** A table row on a line of its own; the table's first row is its header, as the forum's Markdown has it. */
function tableRow(content: string, row: DomNode): string {
  const table = row.parentNode.nodeName === "TABLE" ? row.parentNode : row.parentNode.parentNode;
  if (table.querySelector("tr") !== row) return `\n${content}`;
  const columns = cellsOf(row).reduce((n, cell) => n + columnSpan(cell), 0);
  return `\n${content}\n| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
}

/** The lines of a spoiler, each marked as the forum's Markdown marks them. */
function spoiler(content: string): string {
  const text = content.replace(/^\n+|\n+$/g, "");
  return text === "" ? "" : `\n\n${text.split("\n").map((line) => (line === "" ? ">!" : `>! ${line}`)).join("\n")}\n\n`;
}

/** Bold or italic: spaces and line breaks at its edges go outside the marks, and marks already there are not doubled. */
function emphasis(marker: string): (content: string) => string {
  return (content) => {
    const core = content.trim();
    if (core === "" || (marker === "**" && core.startsWith("**") && core.endsWith("**"))) return content;
    const at = content.indexOf(core);
    return `${content.slice(0, at)}${marker}${core}${marker}${content.slice(at + core.length)}`;
  };
}

/** A link on one line, as a link's text must be; a link with no text is nothing on the page, and nothing here. */
function linkMarkdown(content: string, a: DomNode): string {
  const text = content.replace(/\s*\n\s*/g, " ").trim();
  if (text === "") return "";
  const title = a.getAttribute("title")?.replace(/\s*\n\s*/g, " ").replaceAll('"', '\\"');
  return `[${text}](${(a.getAttribute("href") ?? "").trim().replace(/[\t\n\r]/g, "").replace(/\s/g, encodeURIComponent).replace(/([()])/g, "\\$1")}${title ? ` "${title}"` : ""})`;
}

/**
 * A private-use character that goes first inside every `mjx-container`: MathJax 3 draws its glyphs from CSS, so the element holds no
 * text, and turndown would treat it as blank (no rule applies; it becomes "") and its whitespace collapsing would drop the space
 * after it. The equation rule discards it.
 */
const MARK = "\u{E000}";
/** An `mjx-container`'s start tag (a quoted attribute value may hold `>`). */
const EQUATION_TAG = /<mjx-container\b(?:"[^"]*"|'[^']*'|[^'">])*>/g;

/** The addresses the link rule met during one `pageLinks` call, in page order; `undefined` outside one (turndown runs synchronously). */
let linksMet: string[] | undefined;

/**
 * Whether `el` sits in a part the converter leaves out: a dialogue's message input or a hidden block. Turndown converts an element's
 * children before its own rule drops it, so the link rule asks this of each link.
 */
function offThePage(el: DomNode): boolean {
  for (let n: DomNode | null | undefined = el; n != null; n = n.parentNode) {
    if (typeof n.getAttribute === "function" && (isMessageBox(n) || isHiddenBlock(n))) return true;
  }
  return false;
}

/**
 * The page as Markdown, by the rules of the forum's own conversion (`getTurndown` in its `conversionUtils.ts`), so that the text reads
 * as the forum's Markdown does, for all that saved pages hold. Brackets stay bare unless they would read as a link's, a page's image
 * keeps the page's address, a widget is a note because the page has no code for it, and `speakers` sets each message under its speaker's name.
 */
function pageConverter(speakers: boolean): TurndownService {
  const service: TurndownService = new TurndownService({
    headingStyle: "setext",
    strongDelimiter: "**",
    emDelimiter: "*",
    blankReplacement: (_, node) => (hasClass(dom(node), "iframe-widget") ? `\n\n${WIDGET_NOTE}\n\n` : dom(node).isBlock ? "\n\n" : ""),
  })
    .remove("style")
    .addRule("notOnThePage", {
      filter: (node) => isMessageBox(dom(node)) || isHiddenBlock(dom(node)),
      replacement: () => "",
    })
    .addRule("equation", {
      filter: (node) => isEquation(dom(node)),
      replacement: (content, node) => mathMarkdown(content, dom(node)),
    })
    .addRule("link", {
      filter: (node) => dom(node).nodeName === "A" && !!dom(node).getAttribute("href"),
      replacement: (content, node) => {
        const md = linkMarkdown(content, dom(node));
        if (linksMet !== undefined && md !== "" && !offThePage(dom(node))) linksMet.push((dom(node).getAttribute("href") ?? "").trim());
        return md;
      },
    })
    .addRule("footnoteBackLink", {
      filter: (node) => hasClass(dom(node), "footnote-backref") || hasClass(dom(node), "footnote-back-link"),
      replacement: () => "",
    })
    .addRule("embed", {
      filter: "iframe",
      replacement: (_, node) => dom(node).outerHTML,
    })
    .addRule("dialogueMessageHeader", {
      filter: (node) => hasClass(dom(node), "dialogue-message-header"),
      replacement: () => "",
    })
    .addRule("dialogueMessage", {
      filter: (node) => isDialogueMessage(dom(node)),
      replacement: (content, node) => {
        // ¶3.7 Q79: a display name is a single-line field, so it cannot break the label's line or forge a heading.
        const label = speakers ? oneLine(speakerName(dom(node)), CONFIG.render.caps.name) || UNNAMED_SPEAKER : "";
        // Only blank lines go from the start (as turndown's own trim does), so a code block opening the message keeps its indent.
        const text = content.replace(/^\n+/, "").trimEnd();
        const mark = markingLabels ? LABEL_MARK : "";
        const end = markingLabels && text !== "" ? TURN_END_MARK : "";
        const turn = label === "" || text === "" ? `${text}${end}` : `**${label}:**${mark}\n\n${text}${end}`;
        const outside = speakers && textFollows(dom(node)) ? `${OUTSIDE_THE_DIALOGUE}${mark}\n\n` : "";
        return `\n\n${turn}\n\n${outside}`;
      },
    })
    .addRule("bold", { filter: ["b", "strong"] as unknown as "b", replacement: emphasis("**") })
    .addRule("italic", { filter: ["i", "em"] as unknown as "i", replacement: emphasis("*") })
    .addRule("subscript", { filter: "sub", replacement: (content) => `~${content}~` })
    .addRule("superscript", { filter: "sup", replacement: (content) => `^${content}^` })
    .addRule("strikethrough", { filter: ["del", "s", "strike"] as unknown as "del", replacement: (content) => `~~${content}~~` })
    .addRule("spoiler", {
      filter: (node) => ["spoilers", "spoiler-v2", "spoiler"].some((name) => hasClass(dom(node), name)),
      replacement: spoiler,
    })
    .addRule("footnoteMarker", {
      filter: (node) => hasClass(dom(node), "footnote-reference") || hasClass(dom(node), "footnote-ref"),
      replacement: (_, node) => `[^${footnoteId(dom(node))}]`,
    })
    .addRule("footnote", {
      filter: (node) => hasClass(dom(node), "footnote-item"),
      replacement: (_, node) => {
        // The whole item, its back link left out: the note's text and anything beside it, such as a list. Its links were met in place
        // when its children were converted; this second pass converts a detached copy, whose parts off the page can't be seen, so it
        // records none.
        const met = linksMet;
        linksMet = undefined;
        try {
          const text = service.turndown(node as unknown as Parameters<TurndownService["turndown"]>[0]).replace(/\s*\n\s*/g, " ").trim();
          return `[^${footnoteId(dom(node))}]: ${text} \n\n`;
        } finally {
          linksMet = met;
        }
      },
    })
    .addRule("collapsibleTitle", {
      filter: (node) => hasClass(dom(node), "detailsBlockTitle"),
      replacement: (content) => `\n\n+++ ${content.trim()}\n\n`,
    })
    .addRule("collapsible", {
      filter: (node) => hasClass(dom(node), "detailsBlock"),
      replacement: (content) => `\n\n${content.trim()}\n\n+++\n\n`,
    })
    .addRule("llmBlock", {
      filter: (node) => hasClass(dom(node), "llm-content-block"),
      replacement: (content, node) => `\n\n%%% llm-output model="${dom(node).getAttribute("data-model-name") || "unknown model"}"\n\n${content.trim()}\n\n%%% /llm-output\n\n`,
    })
    // #69: on the page a cell's quote is a block of its own; on the cell's one line it is set between curly quotation marks.
    .addRule("quoteInCell", {
      filter: (node) => dom(node).nodeName === "BLOCKQUOTE" && inCell(dom(node)),
      replacement: (content) => {
        const text = content.trim().replace(/\s*\n\s*/g, " ");
        return text === "" ? "" : `\n\n“${text}”\n\n`;
      },
    })
    .addRule("tableCell", { filter: ["th", "td"], replacement: (content, node) => tableCell(content, dom(node)) })
    .addRule("tableRow", { filter: "tr", replacement: (content, node) => tableRow(content, dom(node)) })
    .addRule("tableSection", { filter: ["thead", "tbody", "tfoot"] as unknown as "thead", replacement: (content) => content })
    .addRule("table", { filter: "table", replacement: (content) => `\n\n${content.replace(/^\n+/, "").replace(/\n\n/g, "\n")}\n\n` });
  const escape = service.escape.bind(service);
  service.escape = (text: string): string => escape(text).replace(/\\([[\]])(?!\()/g, "$1");
  return service;
}

const NAMING_SPEAKERS = pageConverter(true);
const NAMING_NOBODY = pageConverter(false);


/**
 * The addresses of the links a reader can follow on a post's page, in page order: every `<a href>` with text, outside the parts the
 * page doesn't show, as the forum's own link index counts a page's anchors. Read from the page, not from its Markdown, which can't
 * tell a link from link syntax shown as code. `undefined` for a page nested too deeply to convert.
 */
export function pageLinks(html: string): string[] | undefined {
  const met: string[] = [];
  linksMet = met;
  try {
    NAMING_NOBODY.turndown(html.replace(EQUATION_TAG, `$&${MARK}`));
    return met;
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  } finally {
    linksMet = undefined;
  }
}

/** Whether the conversion under way marks the label lines it writes (`pageText`'s `markLabels`); conversion is synchronous. */
let markingLabels = false;

/**
 * A post's text, from its page (`contents.html`, or a revision's `html`), as a logged-out reader sees it, as Markdown; nothing else is
 * read for a post's text. `undefined` when there is no page, or one nested too deeply to convert: the text is then not shown. With
 * `speakers`, a named dialogue's turns start with their speaker's label. With `markLabels` too, each label line the converter
 * writes, and each turn's last line, ends in a mark, for `processBody` to record by line and clear, so an author's own bold line,
 * even one equal to a label, stays the author's (#75), and a section knows whose turn its heading is in; such text is never shown
 * as it is.
 */
export function pageText(input: { html: string | null | undefined; speakers: boolean; markLabels?: boolean }): string | undefined {
  if (input.html == null) return undefined;
  markingLabels = input.speakers && input.markLabels === true;
  try {
    return (input.speakers ? NAMING_SPEAKERS : NAMING_NOBODY).turndown(input.html.replace(EQUATION_TAG, `$&${MARK}`)).replaceAll(MARK, "");
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  } finally {
    markingLabels = false;
  }
}

/** Whitespace-separated tokens that contain a letter or a digit. */
export function countWords(md: string): number {
  return md.split(/\s+/).filter((token) => WORD.test(token)).length;
}

/**
 * ¶4.3 step 6: a text as shown (its line breaks as `blockText` prints them, so its lines are numbered as printed), widgets and
 * `data:` images replaced, then measured and outlined.
 */
export function processBody(input: { markdown: string | null; version: string }): ProcessedBody {
  // The label lines and turn ends `pageText` marked (#75): recorded by number and cleared; labels are no words of the text either.
  const lines = stripWidgets(blockText(input.markdown)).split("\n");
  const labels = lines.flatMap((line, i) => (line.endsWith(LABEL_MARK) ? [i] : []));
  const turnEnds = lines.flatMap((line, i) => (line.endsWith(TURN_END_MARK) ? [i] : []));
  const md = lines.map((line) => line.replace(MARKS, "")).join("\n");
  const words = countWords(md.split("\n").filter((_, i) => !labels.includes(i)).join("\n"));
  return { md, version: input.version, words, headings: outline(md, new Set(labels)), labels, turnEnds };
}
