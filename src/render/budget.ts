// Layer 3. The token estimate, the page budget and safe text slicing (¶3.7 "Estimating tokens", "Budget", fitting rule 3).
// Estimates are exact integers in units of 1/66 token (66 = 2 × 3.3 × 10), so that the 95 % fill, the sub-cap shares and
// the "does this line fit" test never meet floating-point rounding: a character of a dense run (12 or more characters of
// `[A-Za-z0-9_\-/.:%=+]`: ids, URLs, cursors) costs 33 units (chars / 2), any other ASCII character 20 (chars / 3.3), and
// a non-ASCII code point 66 (one token). The constants can be recalibrated here (¶3.7). Pure: no I/O, never throws.
import { CONFIG } from "../config";

/** Estimates are integers in units of 1/`UNITS_PER_TOKEN` token. */
export const UNITS_PER_TOKEN = 66;

const DENSE_MIN_RUN = 12;
const DENSE_UNITS = 33;
const ASCII_UNITS = 20;
const NON_ASCII_UNITS = 66;
/** The unit cost of a joining newline; it is not a dense character, so a dense run never crosses it. */
const NEWLINE_UNITS = ASCII_UNITS;

/** Indexed by ASCII code: 1 for a character of the dense class, written once from the spec's own class. */
const DENSE_CLASS = new Uint8Array(128);
for (let code = 0; code < 128; code++) {
  if (/[A-Za-z0-9_\-/.:%=+]/.test(String.fromCharCode(code))) DENSE_CLASS[code] = 1;
}

const runUnits = (run: number): number => run * (run >= DENSE_MIN_RUN ? DENSE_UNITS : ASCII_UNITS);

/**
 * The estimate of `s` in units of 1/66 token. A run of dense characters is charged when it ends, by its whole length;
 * every other ASCII character costs 20 and every code point above U+007F 66 (a surrogate pair is one code point, a lone
 * surrogate counts as one). Never decreases when characters are appended, which `sliceText` relies on.
 */
export function tokenUnits(s: string): number {
  let units = 0;
  let run = 0;                                   // length of the current run of dense characters
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128 && DENSE_CLASS[c] === 1) {
      run += 1;
      continue;
    }
    units += runUnits(run);
    run = 0;
    if (c < 128) {
      units += ASCII_UNITS;
      continue;
    }
    units += NON_ASCII_UNITS;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;   // the pair is one code point
    }
  }
  return units + runUnits(run);
}

/** A line plus the newline that joins it to the next. */
export function lineUnits(s: string): number {
  return tokenUnits(s) + NEWLINE_UNITS;
}

/** The estimated number of tokens of `s`, rounded up. */
export function estimateTokens(s: string): number {
  return Math.ceil(tokenUnits(s) / UNITS_PER_TOKEN);
}

/**
 * One reply's token budget: `max_tokens` filled to at most `CONFIG.render.fill` (95 %). It keeps its charge as an
 * integer number of units; `used` and `remaining()` are reported in tokens (fractional).
 */
export class Budget {
  /** Whole tokens available: `floor(fill × max_tokens)`. */
  readonly limit: number;
  private readonly limitUnits: number;
  private usedUnits = 0;

  constructor(maxTokens: number) {
    this.limit = Math.floor(CONFIG.render.fill * maxTokens);
    this.limitUnits = this.limit * UNITS_PER_TOKEN;
  }

  /** Tokens charged so far. */
  get used(): number {
    return this.usedUnits / UNITS_PER_TOKEN;
  }

  /** Tokens still free; exactly 0 when the budget is spent to the unit. */
  remaining(): number {
    return (this.limitUnits - this.usedUnits) / UNITS_PER_TOKEN;
  }

  /** Whether a line (with its joining newline) fits in what is left. */
  fits(s: string): boolean {
    return lineUnits(s) <= this.limitUnits - this.usedUnits;
  }

  /** Charges a line with its joining newline. It never refuses: callers test `fits` first. */
  take(s: string): void {
    this.usedUnits += lineUnits(s);
  }

  /** Charges raw units (room kept back for a footer, a block or a cursor). */
  reserve(units: number): void {
    this.usedUnits += units;
  }

  /** Refunds raw units that `reserve` charged. */
  release(units: number): void {
    this.usedUnits -= units;
  }

  /** A sub-cap in whole tokens: `floor(fraction × limit)` (outline 0.25, signals 0.15, text 0.4). */
  share(fraction: number): number {
    return Math.floor(fraction * this.limit);
  }
}

/** One slice of a text: what to print now and where the rest starts. */
export interface Slice {
  /**
   * A prefix of `s.slice(from)` with `estimateTokens(text) ≤ maxTokens`: the whole rest, unchanged, when it fits;
   * otherwise cut, with trailing whitespace removed.
   */
  text: string;
  /** The absolute offset in `s` where the rest starts; `undefined` when the whole rest fits. */
  next?: number;
  /** True when the cut fell inside a code fence or a `$$` block. */
  inCode: boolean;
  /** The number of `\S+` runs in `s.slice(next)`; 0 when nothing is left. */
  moreWords: number;
}

const FENCE_LINE = /^\s*(?:```|~~~)/;
const WHITESPACE = /\s/;
const NEWLINE = /\n/;
const SPACE_OR_TAB = /[ \t]/;
/** What may follow a sentence's `.`, `!` or `?` and still close it: a quote, a bracket or an emphasis mark. */
const SENTENCE_CLOSERS = "\"')]*_";

const NEWLINE_CODE = 0x0a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const SPACE = 0x20;
const TAB = 0x09;
const DOT = 0x2e;
const BANG = 0x21;
const QUESTION = 0x3f;

/** The index after the run of characters matching `re` that starts at `at`. */
function skipRun(s: string, at: number, re: RegExp): number {
  let i = at;
  while (i < s.length && re.test(s[i]!)) i += 1;
  return i;
}

/** Whether a line is inside a code fence or a `$$` block. */
interface BlockState { fence: boolean; math: boolean }

/** The number of non-overlapping `$$` in a line. */
function countDisplayMath(line: string): number {
  let n = 0;
  for (let i = line.indexOf("$$"); i !== -1; i = line.indexOf("$$", i + 2)) n += 1;
  return n;
}

/**
 * The one rule for the state of code fences and `$$` blocks, applied to each line as it starts: a line whose
 * `trimStart()` begins with three backticks or three tildes toggles the fence; outside a fence, a line with an odd
 * number of `$$` toggles the block. `findCut` (the part that fits) and `blockStateBefore` (the text before a resumed
 * call) both use it, so they cannot disagree.
 */
function applyLine(state: BlockState, line: string): void {
  if (FENCE_LINE.test(line)) state.fence = !state.fence;
  if (!state.fence && countDisplayMath(line) % 2 === 1) state.math = !state.math;
}

/**
 * The state where `s.slice(from)` begins, so that a call resuming at `from` knows whether it resumes inside a code
 * fence or a `$$` block: every line that starts before `from`, applied in order and each whole (a line that `from`
 * falls inside has had its toggles applied, and `findCut` must not apply them again). One pass over `s[0, from)`.
 */
function blockStateBefore(s: string, from: number): BlockState {
  const state: BlockState = { fence: false, math: false };
  let lineStart = 0;
  while (lineStart < from) {
    const nl = s.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? s.length : nl + 1;
    applyLine(state, s.slice(lineStart, lineEnd));
    lineStart = lineEnd;
  }
  return state;
}

/** The latest sentence end and the latest space or tab found so far, as indexes in the text (-1: none yet). */
interface Candidates { sentence: number; space: number }

/**
 * For each `(` that directly follows a `]` on the line `s[lineStart, lineEnd)`, the index of the `)` that matches it
 * (parentheses nest); a `(` that is never closed on the line is left out. One pass.
 */
function matchLinkParens(s: string, lineStart: number, lineEnd: number): Map<number, number> {
  const closeOf = new Map<number, number>();
  const open: number[] = [];
  for (let i = lineStart; i < lineEnd; i++) {
    const c = s.charCodeAt(i);
    if (c === OPEN_PAREN) {
      open.push(i);
    } else if (c === CLOSE_PAREN && open.length > 0) {
      const at = open.pop()!;
      if (at > lineStart && s.charCodeAt(at - 1) === CLOSE_BRACKET) closeOf.set(at, i);
    }
  }
  return closeOf;
}

/**
 * Where the sentence end that the `.`, `!` or `?` at `i` would make is cut: the index after the closers that follow it,
 * when whitespace follows them before `limit`; -1 when the mark is not at the end of a sentence.
 */
function sentenceEndAfter(s: string, i: number, limit: number): number {
  let j = i + 1;
  while (j < limit && SENTENCE_CLOSERS.includes(s[j]!)) j += 1;
  return j < limit && WHITESPACE.test(s[j]!) ? j : -1;
}

/**
 * The last sentence end and the last space or tab of one line (`s[lineStart, lineEnd)`) that lie before `limit` and
 * outside every Markdown link; the ones it finds go into `found`. A link is a `[` matched by a `]` on the same line
 * (brackets nest: a `]` closes the innermost open `[`), together with the `(…)` that directly follows that `]` when its
 * `(` has a matching `)` on the line. A `[` or `(` that is never matched bars nothing. A cut is inside a link when it is
 * after the link's first character and before its end. The whole line is read, past `limit`, because a link that opens
 * in the part that fits may close beyond it. One pass: each open `[` keeps the candidates seen before it and gives them
 * back when its `]` comes, which discards what lay between.
 */
function scanLine(s: string, lineStart: number, lineEnd: number, limit: number, found: Candidates): void {
  let sentence = -1;
  let space = -1;
  let pending = -1;                                   // where a sentence end already seen is registered
  let opens: number[] | undefined;                    // per open "[": the space and the sentence end seen before it
  let closeOf: Map<number, number> | undefined;       // built when the first "](" is met
  for (let i = lineStart; i < lineEnd; i++) {
    if (i >= limit && (opens === undefined || opens.length === 0)) break;   // nothing left can change a candidate
    if (i === pending) {
      sentence = i;
      pending = -1;
    }
    const c = s.charCodeAt(i);
    if (c === OPEN_BRACKET) {
      (opens ??= []).push(space, sentence);
    } else if (c === CLOSE_BRACKET) {
      if (opens !== undefined && opens.length > 0) {
        sentence = opens.pop()!;
        space = opens.pop()!;
        if (s.charCodeAt(i + 1) === OPEN_PAREN) {
          closeOf ??= matchLinkParens(s, lineStart, lineEnd);
          const open = i + 1;
          const close = closeOf.get(open);
          if (close !== undefined) {
            // The address belongs to the link: skip it. A sentence end that its `)` closes ("…(see x.) Next") is the
            // end of the link, not inside it, so it is still a cut point.
            let mark = close;
            while (mark > open && SENTENCE_CLOSERS.includes(s[mark]!)) mark -= 1;
            const c0 = s.charCodeAt(mark);
            if (mark > open && (c0 === DOT || c0 === BANG || c0 === QUESTION)) pending = sentenceEndAfter(s, mark, limit);
            i = close;
          }
        }
      }
    } else if (i < limit) {
      if (c === SPACE || c === TAB) space = i;
      else if (c === DOT || c === BANG || c === QUESTION) pending = sentenceEndAfter(s, i, limit);
    }
  }
  if (sentence !== -1) found.sentence = sentence;
  if (space !== -1) found.space = space;
}

/** Where `rest` is cut: the text is `rest.slice(0, textEnd)`, the remainder starts at `nextAt`. */
interface Cut { textEnd: number; nextAt: number; inCode: boolean }

/**
 * The cut of `rest` within its first `end` characters (the part that fits): the latest candidate of the first of these
 * rules that has one, each leaving some text before it. The part that fits is read line by line with `applyLine`,
 * starting from `state`, the state where `rest` begins; when `rest` begins in the middle of a line (`midLine`), that
 * line's toggles are already in `state` and are not applied again.
 *  1. a blank line outside code; 2. a sentence end outside code and outside every link; 3. a space or tab outside
 *  code and outside every link (`scanLine`); 4. the last line break (`inCode` as of that line); 5. a hard cut at
 *  `end` (`inCode` as of `end`).
 */
function findCut(rest: string, end: number, state: BlockState, midLine: boolean): Cut {
  const first = rest.search(/\S/);
  const content = first === -1 ? Infinity : first;   // a cut must leave a character before it
  const found: Candidates = { sentence: -1, space: -1 };
  let blank = -1;
  let newline = -1;
  let newlineInCode = false;
  let lineStart = 0;
  while (lineStart < end) {
    const nl = rest.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? rest.length : nl + 1;   // the whole line, with its newline when it has one
    const limit = Math.min(lineEnd, end);               // the part of it that fits
    if (lineStart > 0 || !midLine) applyLine(state, rest.slice(lineStart, limit));
    const code = state.fence || state.math;
    if (!code) scanLine(rest, lineStart, lineEnd, limit, found);
    if (nl !== -1 && nl < end) {
      newline = nl;
      newlineInCode = code;
      if (!code && nl + 1 < end && rest.charCodeAt(nl + 1) === NEWLINE_CODE) blank = nl;
    }
    lineStart = lineEnd;
  }
  if (blank > content) return { textEnd: blank, nextAt: skipRun(rest, blank, NEWLINE), inCode: false };
  if (found.sentence > content) return { textEnd: found.sentence, nextAt: skipRun(rest, found.sentence, WHITESPACE), inCode: false };
  if (found.space > content) return { textEnd: found.space, nextAt: skipRun(rest, found.space, SPACE_OR_TAB), inCode: false };
  if (newline > content) return { textEnd: newline, nextAt: newline + 1, inCode: newlineInCode };
  return { textEnd: end, nextAt: end, inCode: state.fence || state.math };
}

/**
 * The largest index `end` such that `s.slice(0, end)` costs at most `maxUnits`, by binary search (the cost never falls
 * as the prefix grows). A character costs at least 20 units per UTF-16 unit, so nothing past `maxUnits / 20` can fit.
 */
function fitEnd(s: string, maxUnits: number): number {
  let lo = 0;
  let hi = Math.min(s.length, Math.floor(maxUnits / ASCII_UNITS));
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tokenUnits(s.slice(0, mid)) <= maxUnits) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The number of `\S+` runs in `s.slice(from)`, counted without building the slice or the matches. */
function countWords(s: string, from: number): number {
  const word = /\S+/g;
  word.lastIndex = from;
  let n = 0;
  while (word.exec(s) !== null) n += 1;
  return n;
}

/**
 * Fitting rule 3 (¶3.7): the part of `s.slice(from)` that fits `maxTokens`, cut where a reader loses least (see
 * `findCut`). `next` is the absolute offset where the rest starts, so a cursor can resume there; nothing is ever cut
 * inside a surrogate pair. When not even one character fits, `text` is empty and `next` is `from`. `s` is the whole
 * text and `from` an absolute offset into it: a call that resumes rebuilds the code fence and `$$` state from the text
 * before `from` (`blockStateBefore`), so `inCode` and the cut points are right for a continuation as for a first page.
 */
export function sliceText(s: string, maxTokens: number, from = 0): Slice {
  const rest = s.slice(from);
  // estimateTokens(text) ≤ maxTokens ⇔ tokenUnits(text) ≤ floor(maxTokens) × 66. Every UTF-16 unit costs at least 20
  // units, so a rest longer than maxUnits / 20 cannot fit and is not read whole: the cost is bounded by the budget.
  const maxUnits = Math.floor(maxTokens) * UNITS_PER_TOKEN;
  if (rest.length * ASCII_UNITS <= maxUnits && tokenUnits(rest) <= maxUnits) {
    return { text: rest, next: undefined, inCode: false, moreWords: 0 };
  }
  let end = fitEnd(rest, maxUnits);
  const last = rest.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;   // never leave a pair's high half behind
  if (end <= 0) return { text: "", next: from, inCode: false, moreWords: countWords(s, from) };
  const midLine = from > 0 && s.charCodeAt(from - 1) !== NEWLINE_CODE;   // `from` is inside a line the prefix scan took whole
  const cut = findCut(rest, end, blockStateBefore(s, from), midLine);
  const next = from + cut.nextAt;
  return { text: rest.slice(0, cut.textEnd).trimEnd(), next, inCode: cut.inCode, moreWords: countWords(s, next) };
}
