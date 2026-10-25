// The output-shape checks of ¶9.3, used by the conformance suite (test/conformance/output.test.ts) and the injection tests.
// `shapeViolations` reads one tool reply and names every rule it breaks; `itemIds` gives the identity of each item, for
// "a continuation repeats no item". Forum text (a nonce fence's lines and every `> ` quote) is data, so no check reads it.
import { CURSOR_RE } from "../../src/paging/cursor";
import type { ParamName } from "../../src/params/vocabulary";
import type { ToolName } from "../../src/types";

/** ¶3.1.3: every id label a reply may print, with the parameters that accept it (many labels map to one parameter). */
export const LABEL_PARAMS: Readonly<Record<string, readonly ParamName[]>> = {
  post_id: ["post", "commented_on"],
  comment_id: ["comment"],
  user_slug: ["user"],
  user_id: ["user"],
  tag_slug: ["tag"],
  tag_id: ["tag"],
  lens_slug: ["tag"],
  summary_id: ["tag"],
  sequence_id: ["sequence"],
  collection_slug: ["sequence"],
  revision_id: ["revision", "compare_to"],
};

const ERROR_RE = /^Error \((bad_input|bad_cursor|not_found|not_public|login_only|too_broad|rate_limited|politeness_cap|timeout|forum_error|internal)\): /;
/** A double-quoted segment of a line (titles, names, quotes), with its escapes. */
const QUOTED = /"(?:[^"\\]|\\.)*"/g;
const LABELS = Object.keys(LABEL_PARAMS);
const HAS_LABEL = new RegExp(`\\b(?:${LABELS.join("|")}) `);
const ANY_LABEL = /\b([a-z]+(?:_[a-z]+)*_(?:id|slug))\b/g;
const DRIFT = "( Rankings can shift between pages as votes arrive\\.)?";
/** The four footer forms of ¶3.6; `tool` is the capture group that names the tool to call, when the form names one. */
const FOOTERS: readonly { re: RegExp; tool?: number }[] = [
  { re: /^End of results\.$/ },
  { re: new RegExp(`^More available: call (\\w+) with cursor "[^"]*" \\(next: .+\\)\\.${DRIFT}$`), tool: 1 },
  { re: /^End of reachable results: .+\.$/ },
  { re: new RegExp(`^Stopped early \\((time limit|request cap)\\); call (\\w+) with cursor "[^"]*" to continue\\.${DRIFT}$`), tool: 2 },
];
/** A parent reference with no AF or LW only word after its id (¶3.5; the double-quoted name is already removed). Group 1 is set for `a comment placeholder`, group 2 is the id. */
const PARENT_REF = /reply to (?:|a comment whose author is not publicly visible|(a comment placeholder)) \((?:user_(?:slug|id) [^,)]+, )?comment_id ([A-Za-z0-9]+)(?![A-Za-z0-9])(?!, (?:AF|LW only)\))/g;
/** What starts an item; the thread header (`## T3 …`, `## A1 …`) is an item for the shape check but not an identity (a continuation repeats it). */
const ITEM_START = /^(• ("|revision_id |wiki edit |new tag |wiki page |quick takes by )|▶ |\s*\d+\. )/;
const THREAD_HEADER = /^## [TA]\d/;
/** Identity order of `itemIds`: the first label of an item found in this order names it. */
const ID_PRIORITY = ["revision_id", "comment_id", "post_id", "sequence_id", "tag_id", "summary_id", "lens_slug", "tag_slug", "user_id", "user_slug", "collection_slug"];

interface Line { n: number; text: string }
interface Block { first: string; text: string }

/** A line with its double-quoted segments (titles, names, quotes) removed. */
const stripQuoted = (s: string): string => s.replace(QUOTED, "");

/** The lines outside every nonce fence (begin line through the end line with the same nonce, both included) and outside every `> ` quote. */
function visibleLines(text: string): Line[] {
  const out: Line[] = [];
  let nonce: string | undefined;
  text.split("\n").forEach((line, n) => {
    if (nonce !== undefined) {
      if (line === `--- end text ${nonce} ---`) nonce = undefined;
      return;
    }
    const begin = /^--- begin text (\S+) \(/.exec(line);
    if (begin) { nonce = begin[1]; return; }
    if (line.startsWith(">")) return;
    out.push({ n, text: line });
  });
  return out;
}

/** The items of a reply: an item's first line and its visible continuation lines (those that start with a space and start no item). */
function itemBlocks(visible: readonly Line[], threadHeaders: boolean): Block[] {
  const starts = (line: string): boolean => ITEM_START.test(line) || (threadHeaders && THREAD_HEADER.test(line));
  const blocks: Block[] = [];
  let current: { first: string; lines: string[] } | undefined;
  const close = (): void => {
    if (current) blocks.push({ first: current.first, text: current.lines.map(stripQuoted).join("\n") });
    current = undefined;
  };
  for (const { text } of visible) {
    if (starts(text)) { close(); current = { first: text, lines: [text] }; }
    else if (current && text.startsWith(" ")) current.lines.push(text);
    else close();
  }
  close();
  return blocks;
}

export function shapeViolations(tool: ToolName, text: string, isError: boolean, opts: { afCommentIds?: ReadonlySet<string> } = {}): string[] {
  if (isError) return ERROR_RE.test(text) ? [] : [`error: does not match ${ERROR_RE.source}`];
  const found: string[] = [];
  const add = (violation: string): void => { if (!found.includes(violation)) found.push(violation); };
  const lines = text.split("\n");
  const visible = visibleLines(text);

  if (!lines[0].startsWith(`${tool} — `)) add(`title: expected "${tool} — " at the start of line 1`);
  if (!(lines[1] ?? "").startsWith("Request: ")) add('request: expected "Request: " at the start of line 2');

  const position = visible.filter((l) => l.text.startsWith("Position:"));
  if (position.length > 1 || position.some((l) => l.n !== 2)) add('layout: "Position:" is not on line 3');
  const notes = visible.filter((l) => l.text.startsWith("Notes:"));
  if (notes.length > 1 || notes.some((l) => l.n !== 2 && l.n !== 3)) add('layout: "Notes:" is not on line 3 or 4');

  const footers = visible.flatMap((l) => FOOTERS.flatMap((f) => { const m = f.re.exec(l.text); return m ? [{ line: l, tool: f.tool === undefined ? undefined : m[f.tool] }] : []; }));
  if (footers.length !== 1) add(`footer: expected exactly one footer line, found ${footers.length}`);
  else {
    if (footers[0].line.n !== lines.length - 1) add("footer: the last line is not the footer");
    const named = footers[0].tool;
    if (named !== undefined && named !== tool) add(`footer: names ${named} instead of ${tool}`);
  }

  for (const { text: line } of visible) {
    for (const m of line.matchAll(/cursor "([^"]*)"/g)) if (!CURSOR_RE.test(m[1])) add(`cursor: "${m[1]}" is not a bare token`);
  }

  for (const { n, text: line } of visible) {
    const bare = stripQuoted(line);
    for (const m of bare.matchAll(ANY_LABEL)) if (!Object.hasOwn(LABEL_PARAMS, m[1])) add(`label: unknown id label ${m[1]}`);
    if (line.startsWith("▶ ")) {
      const id = /comment_id ([A-Za-z0-9]+)/.exec(bare)?.[1];
      if (id !== undefined && opts.afCommentIds?.has(id) && / · karma −?\d/.test(bare) && !bare.includes("AF karma")) {
        add(`af: comment_id ${id} is on AF but its header has no "AF karma"`);
      }
    }
    // ¶9.3 cites ¶3.5, whose table also puts `AF karma N` on thread headers, outline lines and signal lines. Those print the comment's
    // karma right after its id (`comment_id X · karma 299 · AF karma 87 · …`); `karma not publicly visible` (P18) has no digit, so it is skipped.
    for (const m of bare.matchAll(/comment_id ([A-Za-z0-9]+) · karma −?\d/g)) {
      if (opts.afCommentIds?.has(m[1]) && !bare.includes("AF karma")) add(`af: comment_id ${m[1]} is on AF but its header has no "AF karma"`);
    }
    if (n >= 2) {
      // The post rule needs a boundary after the id (no backtracking into it), and the comment rule leaves the position-labelled facts
      // of thread and reply-map lines (`comment_id X (T1 · … · AF karma 87 · …)`) to their own checks.
      for (const m of bare.matchAll(/\(post_id ([A-Za-z0-9]+)(?![A-Za-z0-9])(?!, (?:AF|LW only))/g)) add(`ref: post_id ${m[1]} reference without AF or LW only`);
      for (const m of bare.matchAll(/comment_id ([A-Za-z0-9]+) \((?!AF\)|LW only\)|[TA]\d)/g)) add(`ref: comment_id ${m[1]} reference without AF or LW only`);
      // The parent of a list-form comment (¶3.8.1) prints `reply to "<Name>" (user_slug …, comment_id X, AF | LW only)`; the quoted name
      // is already gone from `bare`, so it leaves `reply to  (`. The id needs the same no-backtracking boundary as the post rule. A deleted
      // parent has no author, and ¶3.8.1 prints it as `reply to a comment placeholder (comment_id X)` with the id alone: that form passes.
      for (const m of bare.matchAll(PARENT_REF)) {
        if (m[1] !== undefined && bare[m.index + m[0].length] === ")") continue;
        add(`ref: comment_id ${m[2]} reference without AF or LW only`);
      }
    }
  }

  for (const block of itemBlocks(visible, true)) {
    if (!HAS_LABEL.test(block.text)) add(`item: no id label in "${block.first.slice(0, 60)}"`);
  }
  return found;
}

/**
 * ¶3.5: the ids of the comment documents with `af: true` anywhere in `values` (comment-shaped: they carry `parentCommentId`), the
 * set `shapeViolations` checks `AF karma` against. The conformance suite walks a case's fixture results.
 */
export function afCommentIdsOf(values: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o._id === "string" && o.af === true && "parentCommentId" in o) out.add(o._id);
      Object.values(o).forEach(walk);
    }
  };
  for (const v of values) walk(v);
  return out;
}

/** The identity of each item, in order: the value of the first label of its block, by `ID_PRIORITY` (thread headers are not items here). */
export function itemIds(text: string): string[] {
  const ids: string[] = [];
  for (const block of itemBlocks(visibleLines(text), false)) {
    for (const label of ID_PRIORITY) {
      const m = new RegExp(`\\b${label} ([A-Za-z0-9_-]+)`).exec(block.text);
      if (m) { ids.push(m[1]); break; }
    }
  }
  return ids;
}
