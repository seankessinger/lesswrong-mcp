// Layer 3. Revision records and their labels (¶3.8.1, ¶4.11 steps 3–8; §7.3, §7.4): a REV_ROW becomes a
// `RevisionRecord` with its edit kind, editor, the forum's change count and its own labels; `labelRevisions` folds the
// automatic image copies into the edit before them and marks repeated version strings over the rows it returns;
// `originalOf` picks the version current at publication; `allListed` is the fullness test of ¶3.6; `wordDiff` is the
// local word diff of two public texts (Q98: the forum's `RevisionsDiff` is never used); `findIntroduction` is the one
// k-ary search for the version that introduced a phrase, shared by `get_history` and `first_use`. Rows arrive already
// public (`revisionsOnDocument` of a confirmed document, or wiki edits that passed `revisionRowPublic`). Nothing here
// throws or logs; `findIntroduction` only awaits the texts its caller fetches (a failure there propagates). This is the
// only module that imports jsdiff.
import { type ChangeObject, diffArrays } from "diff";
import { contains } from "../text/phrases";
import type { ClassifiedPhrase, RawRevRow, RevisionDoc, RevisionLabel, RevisionRecord } from "../types";
import { authorOf, wikiEditPage } from "./visibility";

/** §7.3: every pre-2019-02-13 text was copied into a migration snapshot on 2019-02-13, dated back to its posting time. */
const SNAPSHOT_BEFORE_MS = Date.parse("2019-02-14T00:00:00.000Z");
/** §7.4: snapshots carry a 24-hex ObjectId, never a 17-character forum id. */
const SNAPSHOT_ID = /^[0-9a-f]{24}$/;
/** §7.3: publish revisions land 0.14–0.6 s after `postedAt`; anything within 5 s still counts as published. */
const PUBLICATION_SLACK_MS = 5_000;
/** §7.3, §7.4: the commit message of the forum's automatic copies of external images. */
const CDN_COMMIT_MESSAGE = "Move images to CDN";
const CDN_COPY: RevisionLabel = "image copy to CDN";
const REPEATS: RevisionLabel = "version number repeats";

/** ¶4.11 step 4: the edit kind of each `updateType`. */
const KIND_OF_UPDATE: Readonly<Record<NonNullable<RawRevRow["updateType"]>, RevisionRecord["kind"]>> = {
  initial: "first version",
  major: "published",
  minor: "edit",
  patch: "small automatic save",
};

/** Q50.38, Q97: the 2019 import snapshot is recognised by its id, its missing update type and its backdated date. */
function isSnapshot(raw: RawRevRow, editedMs: number): boolean {
  return raw.updateType === null && SNAPSHOT_ID.test(raw._id) && editedMs < SNAPSHOT_BEFORE_MS;
}

/**
 * ¶3.8.1, ¶4.11 step 4: the record of one visible revision row. A row with `updateType: null` that is not a snapshot
 * (or an update type the forum adds later) has no kind. No editor is named on a `hideAuthor` document (P7) or on a
 * system revision (`userId: null`); a deleted editor is `account not publicly visible`. `change` is the forum's own count and can
 * differ from the visible diff, so 0/0 is labelled and never read as "no change" (Q50.39). Wiki
 * edits of `revisionsByUser` and the feeds (rows that carry a `tag`, `lens` or `summary` key) name their page (P12 (c)).
 */
export function toRevisionRecord(raw: RawRevRow, doc: RevisionDoc): RevisionRecord {
  const editedMs = Date.parse(raw.editedAt);
  const snapshot = isSnapshot(raw, editedMs);
  const change = raw.changeMetrics
    ? { added: raw.changeMetrics.added ?? 0, removed: raw.changeMetrics.removed ?? 0 }
    : undefined;
  const labels: RevisionLabel[] = [];
  if (snapshot) labels.push("2019 import snapshot");
  if (raw.commitMessage === CDN_COMMIT_MESSAGE) labels.push(CDN_COPY);
  if (change !== undefined && change.added === 0 && change.removed === 0) {
    labels.push("forum change count +0/−0 chars (the text may still have changed)");
  }
  if (doc.postedAt !== undefined && editedMs < Date.parse(doc.postedAt) - PUBLICATION_SLACK_MS) {
    labels.push("before publication");
  }
  const record: RevisionRecord = {
    id: raw._id,
    version: raw.version,
    editedAt: raw.editedAt,
    editedMs,
    kind: raw.updateType === null ? (snapshot ? "2019 import snapshot" : null) : (KIND_OF_UPDATE[raw.updateType] ?? null),
    wordCount: raw.wordCount,
    labels,
    cdnCopiesFolded: 0,
  };
  if (!doc.hideAuthor && raw.userId !== null) record.editor = authorOf(raw.user, { hideAuthor: false });
  if (change !== undefined) record.change = change;
  if ("tag" in raw || "lens" in raw || "summary" in raw) {
    const page = wikiEditPage(raw);
    if (page !== undefined) record.page = page;
  }
  return record;
}

/**
 * ¶4.11 step 4, Q50.37, Q97: the rows to list, newest first in and out. Each image copy to the CDN is folded into the
 * nearest older row that is not one ("+ automatic image copy"); a copy with no older edit stays a row. Then every row
 * whose version string occurs on two or more of the returned rows is labelled `version number repeats`; the label is
 * recomputed on every call, so labelling a list again (a cached list extended later) gives the same rows. Under
 * `hideAuthor` no row names an editor (P7). The input records are copied, never mutated.
 */
export function labelRevisions(rows: readonly RevisionRecord[], doc: RevisionDoc): RevisionRecord[] {
  const keptOldestFirst: RevisionRecord[] = [];
  let olderEdit: RevisionRecord | undefined;   // the nearest older kept row that is not a CDN copy
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const cdnCopy = row.labels.includes(CDN_COPY);
    if (cdnCopy && olderEdit !== undefined) {
      olderEdit.cdnCopiesFolded += 1;
      continue;
    }
    const copy: RevisionRecord = { ...row, labels: row.labels.filter((l) => l !== REPEATS) };
    if (doc.hideAuthor) delete copy.editor;
    keptOldestFirst.push(copy);
    if (!cdnCopy) olderEdit = copy;
  }
  const kept = keptOldestFirst.reverse();
  const versions = new Map<string, number>();
  for (const r of kept) versions.set(r.version, (versions.get(r.version) ?? 0) + 1);
  for (const r of kept) if ((versions.get(r.version) ?? 0) >= 2) r.labels.push(REPEATS);
  return kept;
}

export type OriginalResult =
  | { status: "found"; row: RevisionRecord; snapshot: boolean }
  | { status: "not yet" }
  | { status: "not available"; earliest?: RevisionRecord };

function found(row: RevisionRecord): OriginalResult {
  return { status: "found", row, snapshot: row.kind === "2019 import snapshot" };
}

/**
 * ¶4.11 step 5, §7.3: the original. For posts and comments it is the newest visible row edited at most 5 s after
 * `postedAt`, determined as soon as the newest-first rows reach one; a pre-2019 text's original is its snapshot
 * (C-PRE2019). Image copies to the CDN fold into the preceding edit's line (¶4.11 step 4), so the original never lands
 * on one while that edit may still arrive on a later page: a qualifying row that is a CDN copy is passed over for an
 * older qualifying edit, and counts only once the list is complete (it then has no older edit); until then the
 * original is not determined yet. This also picks the edit when the rows are passed unfolded. When every public
 * version is listed (`complete`) and none qualifies, it is not available, and the earliest public version is given
 * for the message. Tags, lenses and summaries have no publication time: their original is the oldest public version,
 * known only once the list is complete.
 */
export function originalOf(rowsNewestFirst: readonly RevisionRecord[], doc: RevisionDoc, complete: boolean): OriginalResult {
  if (doc.postedAt !== undefined) {
    const publishedByMs = Date.parse(doc.postedAt) + PUBLICATION_SLACK_MS;
    const qualifies = (r: RevisionRecord): boolean => r.editedMs <= publishedByMs;
    const original = rowsNewestFirst.find((r) => qualifies(r) && !r.labels.includes(CDN_COPY));
    if (original !== undefined) return found(original);
    const copy = complete ? rowsNewestFirst.find(qualifies) : undefined;
    if (copy !== undefined) return found(copy);
  }
  if (!complete) return { status: "not yet" };
  const oldest = rowsNewestFirst.at(-1);
  if (oldest === undefined) return { status: "not available" };
  return doc.postedAt !== undefined ? { status: "not available", earliest: oldest } : found(oldest);
}

/**
 * ¶3.6, ¶4.11 step 3, Q50.40: whether a raw page held every stored row. `totalCount` is used only for this test (it is
 * inconsistent, §7.4, and never printed); without it, a page shorter than its limit is the last one. A short or empty
 * page says nothing about the rows that follow a full one (§7.2).
 */
export function allListed(page: { rows: number; limit: number; totalCount: number | null }): boolean {
  return page.totalCount !== null ? page.totalCount < page.limit : page.rows < page.limit;
}

// ---------------- word diffs (¶4.11 step 7) ----------------

export interface DiffResult { paragraphs: { context?: string; text: string }[]; added: number; removed: number; changed: number }

/**
 * A changed paragraph pair that needs more token edits than this is shown removed and added whole. jsdiff runs
 * synchronously in time that grows with the edit count (a rewritten 10,000-word paragraph, such as a large table, took
 * about 10 s); a paragraph with more changes than this does not read as an inline diff anyway.
 */
const MAX_TOKEN_EDITS = 1_000;
/**
 * The same bound on the paragraph-level diff: a text whose paragraphs need more edits than this is one region, its
 * paragraphs paired in order (a text rewritten throughout reads no better paragraph-matched).
 */
const MAX_PARAGRAPH_EDITS = 1_000;

/** A stretch of jsdiff's output: common items, or one maximal run of adjacent removed and added parts. */
type Run<T> = { common: T[] } | { removed: T[]; added: T[] };

/** `into.push(...items)` without the spread: a common run of a long text can hold more items than the call stack takes as arguments. */
function append<T>(into: T[], items: readonly T[]): void {
  for (const item of items) into.push(item);
}

function runsOf<T>(parts: readonly ChangeObject<T[]>[]): Run<T>[] {
  const runs: Run<T>[] = [];
  for (const part of parts) {
    if (!part.added && !part.removed) {
      runs.push({ common: part.value });
      continue;
    }
    let change = runs.at(-1);
    if (change === undefined || "common" in change) {
      change = { removed: [], added: [] };
      runs.push(change);
    }
    append(part.added ? change.added : change.removed, part.value);
  }
  return runs;
}

/** Blocks separated by blank lines, trimmed, empty ones dropped. */
function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/u).map((p) => p.trim()).filter((p) => p !== "");
}

function tokensOf(paragraph: string): string[] {
  return paragraph.split(/\s+/u).filter(Boolean);
}

/**
 * One changed paragraph against its counterpart: common tokens as they are, each change as `[-…-]` then `{+…+}`; the
 * whole pair as one change when it needs more than `MAX_TOKEN_EDITS` edits.
 */
function tokenDiff(a: string, b: string, counts: { added: number; removed: number }): string {
  const older = tokensOf(a), newer = tokensOf(b);
  const parts = diffArrays(older, newer, { maxEditLength: MAX_TOKEN_EDITS });
  const pieces: string[] = [];
  for (const run of parts !== undefined ? runsOf(parts) : [{ removed: older, added: newer }]) {
    if ("common" in run) {
      append(pieces, run.common);
      continue;
    }
    if (run.removed.length > 0) pieces.push(`[-${run.removed.join(" ")}-]`);
    if (run.added.length > 0) pieces.push(`{+${run.added.join(" ")}+}`);
    counts.removed += run.removed.length;
    counts.added += run.added.length;
  }
  return pieces.join(" ");
}

/**
 * ¶4.11 step 7, Q98: the local word diff of two public texts, `a` the older. Paragraphs are diffed with jsdiff by
 * their words, so a paragraph whose words are unchanged (only its whitespace differs) is common; each maximal run of
 * removed and added paragraphs is one region, whose removed and added paragraphs are paired in order and diffed by
 * whitespace-separated tokens, a paragraph left over being removed or added whole. Only changed paragraphs are
 * returned; the first of each region carries the common paragraph just before it, as it reads in `b`, as `context`
 * (none at the start of the text). `added` and `removed` count tokens; `changed` counts the entries. A paragraph diff
 * that needs more than `MAX_PARAGRAPH_EDITS` edits is one region of every paragraph (jsdiff's time grows with the edit
 * count, and the diff is synchronous).
 */
export function wordDiff(a: string, b: string): DiffResult {
  const words = (p: string): string => tokensOf(p).join(" ");
  const older = paragraphsOf(a);
  const newer = paragraphsOf(b);
  const counts = { added: 0, removed: 0 };
  const paragraphs: DiffResult["paragraphs"] = [];
  let context: string | undefined;
  let inNewer = 0;   // paragraphs of `b` walked so far
  const parts = diffArrays(older.map(words), newer.map(words), { maxEditLength: MAX_PARAGRAPH_EDITS });
  for (const run of parts !== undefined ? runsOf(parts) : [{ removed: older.map(words), added: newer.map(words) }]) {
    if ("common" in run) {
      inNewer += run.common.length;
      context = newer[inNewer - 1];
      continue;
    }
    inNewer += run.added.length;
    const texts: string[] = [];
    const paired = Math.min(run.removed.length, run.added.length);
    for (let i = 0; i < paired; i += 1) texts.push(tokenDiff(run.removed[i], run.added[i], counts));
    for (const p of run.removed.slice(paired)) {
      const tokens = tokensOf(p);
      counts.removed += tokens.length;
      texts.push(`[-${tokens.join(" ")}-]`);
    }
    for (const p of run.added.slice(paired)) {
      const tokens = tokensOf(p);
      counts.added += tokens.length;
      texts.push(`{+${tokens.join(" ")}+}`);
    }
    texts.forEach((text, i) => paragraphs.push(i === 0 && context !== undefined ? { context, text } : { text }));
  }
  return { paragraphs, added: counts.added, removed: counts.removed, changed: paragraphs.length };
}

// ---------------- phrase introduction (¶4.11 step 8, ¶4.12 step 8) ----------------

export interface IntroSeries { key: string; rows: readonly RevisionRecord[]; phrases: readonly ClassifiedPhrase[] }
/** Each phrase's interval of row indexes, keyed `<series key>|<phrase.given>`: absent at `lo`, present at `hi`. */
export type IntroState = Record<string, { lo: number; hi: number }>;

/**
 * One series' probe rows for a round of `findIntroduction`: at most `probes` rows, placed per distinct open interval
 * `(lo, hi)` (one with a row inside it; shared intervals once, nested or overlapping ones as they are), never over their
 * hull, where every probe could fall in the gap between two phrases' intervals and none narrow. Every interval gets one
 * probe (when there are more intervals than probes, those with the most rows inside, ties to the lower `lo`); the rest go
 * one at a time to the interval whose spacing `(hi − lo) / (k + 1)` is widest, ties to the lower `lo`, never more than
 * the rows inside it. An interval with `k` probes takes the rows `lo + round(i (hi − lo) / (k + 1))`, i = 1..k, so a
 * single interval is probed as an even spread of `min(probes, hi − lo − 1)` rows. Deduplicated and ascending.
 */
function probeRows(intervals: readonly { lo: number; hi: number }[], probes: number): number[] {
  const inside = ({ lo, hi }: { lo: number; hi: number }): number => hi - lo - 1;
  const shares = [...new Map(intervals.filter((v) => inside(v) > 0).map(({ lo, hi }) => [`${lo}:${hi}`, { lo, hi, k: 0 }])).values()]
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  // The sort is stable, so among intervals with as many rows inside, the lower `lo` comes first.
  for (const v of [...shares].sort((a, b) => inside(b) - inside(a)).slice(0, Math.max(0, probes))) v.k = 1;
  for (let left = probes - shares.filter((v) => v.k > 0).length; left > 0; left -= 1) {
    let widest: (typeof shares)[number] | undefined;
    for (const v of shares) {
      // (hi − lo) / (k + 1) compared exactly, by cross-multiplying; on a tie the interval met first (the lower `lo`) stays
      if (v.k < inside(v) && (widest === undefined || (v.hi - v.lo) * (widest.k + 1) > (widest.hi - widest.lo) * (v.k + 1))) widest = v;
    }
    if (widest === undefined) break;
    widest.k += 1;
  }
  const rows = shares.flatMap(({ lo, hi, k }) =>
    Array.from({ length: k }, (_, i) => lo + Math.round(((i + 1) * (hi - lo)) / (k + 1))).filter((j) => j > lo && j < hi));
  return [...new Set(rows)].sort((x, y) => x - y);
}

/**
 * ¶4.11 step 8, ¶4.12 step 8: the version that introduced each phrase, by a k-ary search over each series' visible
 * rows (oldest first; the phrase absent at the first row and present at the last, or within the interval carried in
 * `state`). Each round sends one `fetchTexts` call (one forum request) with up to `probes` rows per series that still
 * has an unresolved phrase, all series together. A series' rows are spread over its unresolved phrases' distinct open
 * intervals, not their hull (`probeRows`): each interval gets at least one row inside it when there are no more intervals
 * than probes, so every unresolved phrase narrows every round and a continuation always makes progress. Each phrase reads
 * only the probes strictly inside its own interval and narrows to the first transition among them from absent to present
 * (present = `contains(…) === "exact"`, rule 6), so a phrase removed and re-added is dated by its first appearance among
 * the probes. At most `rounds` rounds; none when nothing is open (adjacent rows need no text). A phrase whose interval
 * closed is `found` at its `hi` row; one left open is reported `between` its two rows, and `state` holds every interval,
 * for a continuation.
 */
export async function findIntroduction(
  series: readonly IntroSeries[],
  fetchTexts: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  opts: { rounds: number; probes: number; state?: IntroState },
): Promise<{ found: Record<string, RevisionRecord>; between: Record<string, { from: RevisionRecord; to: RevisionRecord }>; state: IntroState }> {
  const iv: IntroState = {};
  const searches = series.map((s) => ({
    s,
    phrases: s.phrases.map((phrase) => {
      const key = `${s.key}|${phrase.given}`;
      const start = opts.state?.[key] ?? { lo: 0, hi: s.rows.length - 1 };
      iv[key] = { lo: start.lo, hi: start.hi };
      return { key, phrase };
    }),
  }));
  for (let round = 0; round < opts.rounds; round += 1) {
    const plans = searches.map(({ s, phrases }) => {
      const open = phrases.filter(({ key }) => iv[key].hi - iv[key].lo > 1);
      return { s, open, idx: probeRows(open.map(({ key }) => iv[key]), opts.probes) };
    });
    const ids = [...new Set(plans.flatMap(({ s, idx }) => idx.map((j) => s.rows[j].id)))];
    if (ids.length === 0) break;
    const texts = await fetchTexts(ids);
    for (const { s, open, idx } of plans) {
      for (const { key, phrase } of open) {
        const { lo, hi } = iv[key];
        const probed = idx.flatMap((j) => {
          const text = j > lo && j < hi ? texts.get(s.rows[j].id) : undefined;
          return text === undefined ? [] : [{ j, present: contains(text, phrase) === "exact" }];
        });
        const newHi = probed.find((p) => p.present)?.j ?? hi;
        const absentBelow = probed.filter((p) => !p.present && p.j < newHi).map((p) => p.j);
        iv[key] = { lo: Math.max(lo, ...absentBelow), hi: newHi };
      }
    }
  }
  const found: Record<string, RevisionRecord> = {};
  const between: Record<string, { from: RevisionRecord; to: RevisionRecord }> = {};
  for (const { s, phrases } of searches) {
    for (const { key } of phrases) {
      const { lo, hi } = iv[key];
      if (hi - lo <= 1) found[key] = s.rows[hi];
      else between[key] = { from: s.rows[lo], to: s.rows[hi] };
    }
  }
  return { found, between, state: iv };
}
