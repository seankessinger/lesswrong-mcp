// Layer 3. One reply page within its budget (D3, ¶3.7): the title `<tool> — <subject>`, the `Request:` echo, the
// `Position:` line (left out when the reply is one item shown whole: `PageSpec.oneItem`), the `Notes:` line with each
// caveat once, the head lines, the capped blocks, the items under fitting rules 1–3, the trailing outline (¶4.4 step 14),
// the tail and exactly one footer. Forum text is fenced between per-reply nonce lines, so a body cannot forge a marker,
// a footer or a cursor line outside its fence (Q79); an unfenced (quoted or record) item resumed inside a line is
// marked `> ` or `… `, so the rest of its line never starts a page line unquoted. Every charge is `lineUnits` of a line
// or of a multi-line block (which counts its joining newline), so the page's estimate is the sum of its charges and
// never passes `floor(0.95 × max_tokens)` (¶9.2).
// Pure: no I/O; never throws; guarantees the budget for any `max_tokens` the parameter accepts (2,000–40,000, ¶3.7).
import { blockText, oneLine } from "../text/sanitize";
import type { Consumed, Footer, PageItem, PageSpec, Rendered, ToolName } from "../types";
import { Budget, UNITS_PER_TOKEN, estimateTokens, lineUnits, sliceText, tokenUnits } from "./budget";
import { CONTINUED, CUT_IN_CODE, cutMarker, fmtInt, footerText } from "./messages";

/** The cap of a single-line field that is never cut: the subject, the request parts, the notes, the position. */
const WHOLE = Number.POSITIVE_INFINITY;

/** The longest fence label printed; a label is a reference the tool builds (`post_id …, v1.2.0`, `bio`). */
const LABEL_CAP = 300;

/**
 * A cursor as wide as any the store issues (`c_` + 22 characters, C1). Its characters are all in the dense class, as a
 * real cursor's are, so it costs what a real one does: 24 / 2 tokens.
 */
const WIDEST_CURSOR = "c_" + "0".repeat(22);

/** U+2013 costs the most per character (66 units, as every non-ASCII code point); `footerText` cuts `next` to 60 and `reason` to 200. */
const WIDEST_NEXT = "\u{2013}".repeat(60);
const WIDEST_REASON = "\u{2013}".repeat(200);

/** Room kept beyond the first estimate of the position line, which is written only once the page is known (step 3). */
const POSITION_SLACK_UNITS = 24 * UNITS_PER_TOKEN;

/** The widest cut marker a slice can end with: more words than any forum text has, cut inside a code block. */
const WIDEST_MARKER = `${cutMarker(9_999_999)} ${CUT_IN_CODE}`;

/** The cost of a line's joining newline alone. */
const NEWLINE_UNITS = lineUnits("");

/** The end of a trailing outline that did not fit whole; the cursor reaches the rest. */
const andMore = (left: number): string => `and ${fmtInt(left)} more`;

const fenceBegin = (label: string, nonce: string): string =>
  `--- begin text ${nonce} (${oneLine(label, LABEL_CAP)}; written by forum users) ---`;
const fenceEnd = (nonce: string): string => `--- end text ${nonce} ---`;

/**
 * Forum-written block text between this reply's nonce lines (¶3.7): CR, CRLF, U+2028 and U+2029 become `\n`
 * (`blockText`), and the label is one line of at most 300 characters.
 */
export function fence(label: string, body: string, nonce: string): string {
  return `${fenceBegin(label, nonce)}\n${blockText(body)}\n${fenceEnd(nonce)}`;
}

/** An item's text as printed: fenced when it is forum text (`fence` set), else as it is. */
function wrap(item: PageItem, text: string, nonce: string): string {
  return item.fence === undefined ? text : fence(item.fence, text, nonce);
}

/** What a resumed item prints before the rest of a quote line, so that the rest stays inside the quote. */
const QUOTE_RESUME = "> ";
/** What a resumed item prints before the rest of any other line: the line began on an earlier page. */
const LINE_RESUME = "… ";

/**
 * The mark printed before an item's text when it resumes at `from` inside a line of `text` and has no fence (¶3.7:
 * block text is a `> ` quote or fenced, so the rest of a line never starts a page line unmarked, where a body could
 * forge a footer or a cursor line outside its block): `> ` when that line begins with `>`, `… ` otherwise. Nothing when
 * the item is fenced (its fence encloses it) or `from` starts a line. Print-only: `from` and `sliceTo` do not change.
 */
function resumeMark(item: PageItem, text: string, from: number): string {
  if (item.fence !== undefined || from === 0 || text[from - 1] === "\n") return "";
  return text.startsWith(">", text.lastIndexOf("\n", from - 1) + 1) ? QUOTE_RESUME : LINE_RESUME;
}

/** The most units any footer of this tool can cost, so that the footer fits whatever `footerFor` returns (step 2). */
function footerReserve(tool: ToolName): number {
  const widest: Footer[] = [
    { kind: "end" },
    { kind: "more", tool, cursor: WIDEST_CURSOR, next: WIDEST_NEXT, drift: true },
    { kind: "stopped", why: "request cap", tool, cursor: WIDEST_CURSOR, drift: true },
    { kind: "reachable", reason: WIDEST_REASON },
  ];
  return Math.max(...widest.map((f) => lineUnits(footerText(f))));
}

const positionLine = (text: string): string => `Position: ${oneLine(text, WHOLE)}`;

/** The cost of lines printed one under the other: each with its joining newline. */
const linesUnits = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + lineUnits(line), 0);

/**
 * The most lines of `lines` (from the first) that fit `cap` units under `title`, followed by `endLine(left)` when lines
 * are left over; 0 when not even one does. Showing them all needs no end line, so that count is tried too.
 */
function fitLines(title: string, lines: readonly string[], cap: number, endLine: (left: number) => string): number {
  let used = lineUnits(title);
  let best = 0;
  for (let k = 1; k <= lines.length; k++) {
    used += lineUnits(lines[k - 1]!);
    if (used > cap) break;                     // every longer prefix costs more still
    const total = k < lines.length ? used + lineUnits(endLine(lines.length - k)) : used;
    if (total <= cap) best = k;
  }
  return best;
}

/**
 * The lines of `text` cut to `room` tokens, as step 10's guard prints them: the slice, then the end-fence line when the
 * cut left one of this reply's fences open (a footer inside a fence would read as forum text, Q79), then the cut marker.
 * A cut that lands on a fence's begin line drops that line rather than half-print it. The caller reserves the room for
 * the two added lines. Nothing but the marker when not even a word fits.
 */
function cutLines(text: string, room: number, nonce: string): string[] {
  const s = sliceText(text, Math.max(0, room));
  if (s.next === undefined) return s.text === "" ? [] : [s.text];
  const begin = `--- begin text ${nonce} (`;
  const end = fenceEnd(nonce);
  const lines = s.text === "" ? [] : s.text.split("\n");
  if (lines.at(-1)?.startsWith(begin)) lines.pop();   // a begin line as the last line opens nothing worth printing, whole or cut
  let open = false;
  for (const line of lines) {
    if (line.startsWith(begin)) open = true;
    else if (line === end) open = false;
  }
  const marker = `${cutMarker(s.moreWords)}${s.inCode ? ` ${CUT_IN_CODE}` : ""}`;
  return [...(lines.length === 0 ? [] : [lines.join("\n")]), ...(open ? [end] : []), marker];
}

/**
 * Step 10's guard, for a page whose fixed parts alone overflow `limit`: the body is cut to fit above the footer, the
 * cut is marked, and a fence the cut left open is closed (`cutLines`). The title and request lines (`frame`) are kept
 * whole and the cut falls in the lines after them (`rest`), so a cut can never leave the request line half-printed;
 * only when the two lines alone leave no room is the whole body cut. The result's estimate is at most `limit` whenever
 * the footer, the marker and an end-fence line alone are.
 */
function cutToFit(frame: readonly string[], rest: readonly string[], footer: string, limit: number, nonce: string): string {
  const footerTokens = estimateTokens(footer);
  // The joining newlines (`- 1`), the widest marker and the end-fence line, each with its newline, are reserved.
  const added = estimateTokens(WIDEST_MARKER) + 1 + estimateTokens(fenceEnd(nonce)) + 1;
  const restRoom = limit - estimateTokens(frame.join("\n")) - footerTokens - 1 - added;
  if (restRoom < 0) return [...cutLines([...frame, ...rest].join("\n"), limit - footerTokens - 1 - added, nonce), footer].join("\n");
  return [...frame, ...cutLines(rest.join("\n"), restRoom, nonce), footer].join("\n");
}

/**
 * One page (D3, ¶3.7), filled to at most `floor(0.95 × maxTokens)` tokens: `estimateTokens(text)` never passes it.
 * The title, request echo, notes and head lines are taken first; then room is reserved for the widest footer, the
 * position line and the trailing outline. Capped blocks take at most their share; items follow fitting rules 1–3 (a
 * first item that does not fit is sliced, and on the next page resumes at `from`, after its `header`); the trailing
 * outline and the tail fill what is left. `footerFor` is called exactly once, after fitting; `spec.position` (when a
 * function) and `spec.trailing.lines` are called more than once and must be pure.
 *
 * A fenced item is sliced and measured on `blockText(item.text)`, the text its fence prints, so its `from` and the
 * `sliceTo` it yields index that normalized text (for text with LF line breaks only, the same as `item.text`). A first
 * item without a fence that resumes inside a line (`from > 0` and `text[from − 1]` is not `\n`) prints `> ` before
 * the rest of that line when the line begins with `>` (a quote line) and `… ` otherwise, so the rest never starts a
 * page line outside its quote (¶3.7, Q79). The mark is charged to the page and is print-only: `from`, `sliceTo` and
 * `consumed` are what they would be without it.
 */
export function renderPage(spec: PageSpec, maxTokens: number, nonce: string, footerFor: (c: Consumed) => Footer): Rendered {
  const budget = new Budget(maxTokens);
  const room = (): number => Math.round(budget.remaining() * UNITS_PER_TOKEN);   // exact: the budget counts whole units

  // 1. The title, the request echo, the notes (each once) and the head lines: always shown.
  const title = `${spec.tool} — ${oneLine(spec.subject, WHOLE)}`;
  const request = `Request: ${spec.request.map((p) => oneLine(p, WHOLE)).join(" · ")}`;
  const notes = [...new Set(spec.notes)];
  const notesLines = notes.length === 0 ? [] : [`Notes: ${notes.map((n) => oneLine(n, WHOLE)).join(" ")}`];
  for (const line of [title, request, ...notesLines, ...spec.head]) budget.take(line);

  // 2–3. The footer and the position line, reserved before anything optional.
  budget.reserve(footerReserve(spec.tool));
  const position = spec.position;
  const positionOf = (c: Consumed): string => positionLine(typeof position === "function" ? position(c) : position ?? "");
  const positionUnits = position === undefined ? 0 : lineUnits(positionOf({ items: spec.items.length, blocks: {} })) + POSITION_SLACK_UNITS;
  budget.reserve(positionUnits);

  // 4. Capped blocks, each resumed at its `from` and held to its share.
  const blocks: Record<string, number> = {};
  const blockLines: string[] = [];
  for (const block of spec.blocks ?? []) {
    const from = block.from ?? 0;
    const lines = block.lines.slice(from);
    const k = fitLines(block.title, lines, Math.min(budget.share(block.share) * UNITS_PER_TOKEN, room()), () => CONTINUED);
    blocks[block.key] = from + k;
    if (k === 0) continue;
    const shown = [block.title, ...lines.slice(0, k), ...(k < lines.length ? [CONTINUED] : [])];
    budget.take(shown.join("\n"));
    blockLines.push(...shown);
  }

  // 5. Room for the trailing outline, kept back while the items are fitted.
  const trailing = spec.trailing;
  const trailingUnits = trailing === undefined ? 0 : Math.min(
    budget.share(trailing.share) * UNITS_PER_TOKEN,
    linesUnits([trailing.title, ...trailing.lines({ items: 0, blocks: {} })]),
  );
  budget.reserve(trailingUnits);

  // 6. The items: rule 1 adds whole items while they fit, rule 2 ends the page before the first that does not once one
  // is on it, rule 3 slices a first item that does not fit.
  const itemLines: string[] = [];
  let items = 0;
  let sliceTo: number | undefined;
  for (const [i, item] of spec.items.entries()) {
    // Forum text is sliced and measured as it is printed: `fence` prints `blockText`, so CRLF, CR, U+2028 and U+2029
    // paragraph breaks and code fences are seen by rule 3, and `from` and `sliceTo` index the normalized text.
    const text = item.fence === undefined ? item.text : blockText(item.text);
    const from = i === 0 ? item.from ?? 0 : 0;
    const header = i === 0 && from > 0 && item.header !== undefined ? [item.header] : [];
    const mark = resumeMark(item, text, from);
    const whole = [...header, wrap(item, mark + text.slice(from), nonce)].join("\n");
    if (budget.fits(whole)) {
      budget.take(whole);
      itemLines.push(whole);
      items += 1;
      continue;
    }
    if (i > 0) break;
    // The mark ends in a space, so no dense run joins it to the text: it costs its own `tokenUnits` exactly. It is
    // charged here because the `− 1` token below leaves only 46 units spare, and `… ` costs 86.
    const fenceUnits = item.fence === undefined ? 0 : lineUnits(fenceBegin(item.fence, nonce)) + lineUnits(fenceEnd(nonce));
    const textRoom = room() - linesUnits(header) - fenceUnits - lineUnits(WIDEST_MARKER) - tokenUnits(mark);
    const s = sliceText(text, Math.floor(textRoom / UNITS_PER_TOKEN) - 1, from);
    // Nothing but whitespace left after the slice: the item counts as shown whole, with no marker and no offset to
    // resume at. Otherwise the item resumes at `s.next`, even when the slice is empty and `s.next` is its own `from`:
    // an unset `sliceTo` would restart it from its first character.
    const finished = s.next === undefined || s.moreWords === 0;
    if (finished) items = 1;
    else sliceTo = s.next;
    if (s.text !== "") {
      const marker = finished ? [] : [`${cutMarker(s.moreWords)}${s.inCode ? ` ${CUT_IN_CODE}` : ""}`];
      const sliced = [...header, wrap(item, mark + s.text, nonce), ...marker].join("\n");
      budget.take(sliced);
      itemLines.push(sliced);
    }
    break;
  }
  const consumed: Consumed = sliceTo === undefined ? { items, blocks } : { items, sliceTo, blocks };

  // 7. The trailing outline: what was not shown, within its share of what is left, ending "and N more".
  const trailingLines: string[] = [];
  if (trailing !== undefined) {
    budget.release(trailingUnits);
    const lines = trailing.lines(consumed);
    const k = fitLines(trailing.title, lines, Math.min(budget.share(trailing.share) * UNITS_PER_TOKEN, room()), andMore);
    if (k > 0) {
      trailingLines.push(trailing.title, ...lines.slice(0, k), ...(k < lines.length ? [andMore(lines.length - k)] : []));
      budget.take(trailingLines.join("\n"));
    }
  }

  // 8. The tail, line by line while each fits.
  const tail: string[] = [];
  for (const line of spec.tail ?? []) {
    if (!budget.fits(line)) break;
    budget.take(line);
    tail.push(line);
  }

  // 9. The footer, then the position line, which needs the page's final `consumed`; it is left out when the reply is
  // one item shown whole (one item, unless the tool says otherwise with `oneItem`: every item of the page shown whole,
  // the first from its start), and cut to its reservation should it have grown past it.
  const footer = footerText(footerFor(consumed));
  const oneItem = spec.oneItem ?? spec.items.length === 1;
  const oneWhole = oneItem && spec.items.length > 0 && items === spec.items.length && !((spec.items[0]!.from ?? 0) > 0);
  const positionLines: string[] = [];
  if (position !== undefined && !oneWhole) {
    const line = positionOf(consumed);
    positionLines.push(lineUnits(line) <= positionUnits
      ? line
      : sliceText(line, Math.floor((positionUnits - NEWLINE_UNITS) / UNITS_PER_TOKEN)).text);
  }

  // 10. Assembly, and the guard for fixed parts that alone overflow the page.
  const frame = [title, request];
  const rest = [...positionLines, ...notesLines, ...spec.head, ...blockLines, ...itemLines, ...trailingLines, ...tail];
  const text = [...frame, ...rest, footer].join("\n");
  return { text: estimateTokens(text) > budget.limit ? cutToFit(frame, rest, footer, budget.limit, nonce) : text, consumed };
}

/** A trial render needs a nonce as wide as a real one; nothing of it is printed. */
const TRIAL_NONCE = "000000";

/** Whether every item of `spec` fits a page of `maxTokens` whole, from a trial render (¶3.7: the outline rule of a text that does not fit). */
export function fitsWhole(spec: PageSpec, maxTokens: number): boolean {
  const c = renderPage(spec, maxTokens, TRIAL_NONCE, () => ({ kind: "end" })).consumed;
  return c.items === spec.items.length && c.sliceTo === undefined;
}
