// Layer 5 leaf. Parses date_from / date_to (¶3.4), maps a range to the forum's view terms and search filters, and
// prints dates. Every instant is UTC; a partial date names a whole period. This is the only date validator
// (params/vocabulary bounds only the length), so the date wording users see is the wording here.
import { badInput } from "../errors";
import type { DateRange } from "../types";

const DAY_MS = 86_400_000;
const MIN_MS = Date.UTC(2000, 0, 1);

const FORM_FIX = "Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).";
const BOUNDS_FIX = "Give a date between 2000-01-01 and now.";
const WINDOW_FIX = 'For example date_from "2024-03-01", date_to "2024-03-31" (31 days).';

// The only accepted forms. Without the `u` flag `\d` is ASCII 0-9, and without `m` `$` matches only at the very end.
// A timestamp's `T` and `Z` may be lowercase (ISO 8601 allows it; Python's isoformat writes up to nine fraction digits).
const YEAR_ONLY = /^(\d{4})$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/i;

/** The instants a date value names: `start` inclusive, `end` exclusive (epoch ms). */
interface Period { start: number; end: number }

/** `Date.UTC` except that years 0–99 stay years 0–99 (not 1900–1999); `month` is 0-based, and `month` and `date` may overflow. */
function utc(year: number, month: number, date = 1): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month, date);
  return t.getTime();
}

/** A value as it reads in a message: JSON-quoted, and on one line even for U+2028 and U+2029 (this module comes before `oneLine`). */
function quoted(v: string): string {
  return JSON.stringify(v).replace(/[\u{2028}\u{2029}]/gu, " ");
}

/** The period `v` names, or `bad_input` naming `param` when `v` is not one of the accepted forms or a component is out of range. */
function periodOf(param: string, v: string): Period {
  const notADate = () => badInput(param, `${quoted(v)} is not a date`, FORM_FIX);

  const y = YEAR_ONLY.exec(v);
  if (y) {
    const year = Number(y[1]);
    return { start: utc(year, 0), end: utc(year + 1, 0) };
  }

  const ym = MONTH_ONLY.exec(v);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    if (month < 1 || month > 12) throw notADate();
    return { start: utc(year, month - 1), end: utc(year, month) };
  }

  const m = DATE_ONLY.exec(v) ?? TIMESTAMP.exec(v);
  if (!m) throw notADate();
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  if (month < 1 || month > 12) throw notADate();
  if (date < 1 || date > new Date(utc(year, month, 0)).getUTCDate()) throw notADate();   // day 0 of the next month: this month's last day
  const dayStart = utc(year, month - 1, date);
  if (m[4] === undefined) return { start: dayStart, end: dayStart + DAY_MS };

  const hours = Number(m[4]);
  const minutes = Number(m[5]);
  const seconds = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));   // ".5" is 500 ms; digits past the third are dropped
  if (hours > 23 || minutes > 59 || seconds > 59) throw notADate();
  let offsetMs = 0;
  const zone = m[8]?.toUpperCase();
  if (zone !== undefined && zone !== "Z") {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 23 || zoneMinutes > 59) throw notADate();
    offsetMs = (zone.startsWith("-") ? -1 : 1) * (zoneHours * 60 + zoneMinutes) * 60_000;
  }
  const start = dayStart + ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis - offsetMs;
  return { start, end: start + 1 };
}

interface Given extends Period { value: string }

/** The period of a given value whose start lies between 2000-01-01 and `now` (¶3.4 bounds); an absent value stays absent. */
function given(param: string, value: string | undefined, now: number): Given | undefined {
  if (value === undefined) return undefined;
  const p = periodOf(param, value);
  if (p.start < MIN_MS) throw badInput(param, `${quoted(value)} starts before 2000-01-01`, BOUNDS_FIX);
  if (p.start > now) throw badInput(param, `${quoted(value)} starts in the future`, BOUNDS_FIX);
  return { ...p, value };
}

/** `date_from` is the first instant of its period, `date_to` ends with its whole period, clamped to `now` (¶3.4); an absent side is an absent property. */
export function parseRange(from: string | undefined, to: string | undefined, now: number): DateRange {
  const f = given("date_from", from, now);
  const t = given("date_to", to, now);
  if (f && t && f.start >= t.end) {
    throw badInput("date_from", `${quoted(f.value)} is after date_to ${quoted(t.value)}`, "Give date_from on or before date_to.");
  }
  const range: DateRange = {};
  if (f) range.start = f.start;
  if (t) {
    range.endExclusive = Math.min(t.end, now);
    if (t.end > now) range.clampedTo = now;
  }
  return range;
}

/** Both bounds are required and at most `maxDays` days apart, both days included; `tool` is the phrase naming the case that needs the window. */
export function requireWindow(r: DateRange, maxDays: number, tool: string): void {
  if (r.start === undefined || r.endExclusive === undefined) {
    throw badInput(
      r.start === undefined ? "date_from" : "date_to",
      `${tool} needs both date_from and date_to, at most ${maxDays} days apart`,
      WINDOW_FIX,
    );
  }
  const length = r.endExclusive - r.start;
  if (length > maxDays * DAY_MS) {
    throw badInput("date_to", `the window is ${Math.ceil(length / DAY_MS)} days; ${tool} allows at most ${maxDays}`, WINDOW_FIX);
  }
}

/** Post and comment views (Q12): `after` is inclusive, `before` exclusive. */
export function toViewTerms(r: DateRange): { after?: string; before?: string } {
  const terms: { after?: string; before?: string } = {};
  if (r.start !== undefined) terms.after = isoMs(r.start);
  if (r.endExclusive !== undefined) terms.before = isoMs(r.endExclusive);
  return terms;
}

/** Search `numericFilters` (Q35, Q36): two different fields, because two bounds on one field are ORed; integer epoch ms, only `>=` and `<`. */
export function toSearchFilters(r: DateRange): string[] {
  const filters: string[] = [];
  if (r.start !== undefined) filters.push(`publicDateMs>=${r.start}`);
  if (r.endExclusive !== undefined) filters.push(`postedAt<${r.endExclusive}`);
  return filters;
}

/** `YYYY-MM-DDTHH:MM:SS.SSSZ`: the one format the forum is sent and `get_history` prints. */
export function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** `YYYY-MM-DD`, UTC. */
export function day(isoOrMs: string | number): string {
  return isoMs(typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs)).slice(0, 10);
}

/** `YYYY-MM-DD HH:MMZ`, UTC. */
export function minute(isoOrMs: string | number): string {
  const iso = isoMs(typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs));
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/** The echo line for a `date_to` that ran past now. */
export function clampNote(r: DateRange): string | undefined {
  return r.clampedTo === undefined ? undefined : `date_to clamped to now (${isoMs(r.clampedTo)})`;
}

/**
 * The identity of a given date for cursor comparisons (¶3.6): the first instant of `v`'s period (`"from"`) or its last
 * millisecond (`"to"`), never clamped to now, so a repeated `date_to: "2026"` still equals itself an hour later.
 * Called only after `parseRange` accepted `v`.
 */
export function effectiveDate(v: string | undefined, side: "from" | "to"): string | undefined {
  if (v === undefined) return undefined;
  const p = periodOf(side === "from" ? "date_from" : "date_to", v);
  return isoMs(side === "from" ? p.start : p.end - 1);
}
