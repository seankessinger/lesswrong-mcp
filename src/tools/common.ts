// Layer 2. Plumbing shared by the tools: opening a continuation and checking the parameters repeated with it (¶2.2 step 2,
// ¶3.6 "Conflicting parameters"), the arguments a cursor stores, resolving the identifier filters of a list or search in one
// request, the request-echo setting items (¶3.7), one rendered reply page, minting a cursor, hand-off calls printed whole
// (¶3.6: `list_posts {tag: "…", sort: "top", cursor: "c_…"}`), the position and `next:` texts, the date echo and the period
// an empty template names, and the two readers of a GraphQL answer's shape (`isRecord`, `rowsOf`).
import { parseRef } from "../ids/parse";
import { cachedResolution, readResolution, resolutionOps } from "../ids/resolve";
import { checkCursorParams } from "../paging/cursor";
import { renderPage } from "../render/layout";
import { fmtInt } from "../render/messages";
import { clampNote, day, isoMs } from "../text/dates";
import type {
  CallContext, Consumed, CursorEntry, CursorState, DateRange, Footer, PageSpec, ParsedRef, Resolved, Services, ToolName, ToolOutput,
} from "../types";

/** A plain object (not null, not an array): the shape of every GraphQL document and of a `{ results }` answer. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rows of a `{ results }` answer; anything else is no rows. */
export function rowsOf<T>(data: unknown): T[] {
  return isRecord(data) && Array.isArray(data.results) ? (data.results.filter(isRecord) as unknown as T[]) : [];
}

/** The stored continuation of `cursor` for `tool`, or undefined without a cursor; `bad_cursor` for a token it does not hold for `tool`. */
export function openContinuation(tool: ToolName, cursor: string | undefined, svc: Services): CursorEntry | undefined {
  return cursor === undefined ? undefined : svc.cursors.take(tool, cursor);
}

/**
 * Compares the parameters the call gave (already resolved by the tool, so a slug equals its id) with the entry's stored
 * effective values: only the keys of `givenEffective` that are in `ctx.given`, in the order given, without `cursor` and
 * `max_tokens`. A mismatch is `bad_input`.
 */
export function checkContinuation(entry: CursorEntry, givenEffective: Readonly<Record<string, unknown>>, ctx: CallContext): void {
  const compared: Record<string, unknown> = {};
  for (const key of ctx.given) {
    if (key !== "cursor" && key !== "max_tokens" && Object.hasOwn(givenEffective, key)) compared[key] = givenEffective[key];
  }
  checkCursorParams(entry, compared);
}

/** The arguments a cursor stores for the echo: the parameters the call gave, in `p`'s (schema) order, without `cursor` and `max_tokens`. */
export function givenArgs(p: Readonly<Record<string, unknown>>, ctx: CallContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) if (key !== "cursor" && key !== "max_tokens" && ctx.given.has(key)) args[key] = value;
  return args;
}

/** The identifier filters a list or search takes; each names its own entity kind. */
export type FilterParam = "user" | "tag" | "post";
export type Filters = Partial<Record<FilterParam, Resolved>>;

/** The filters in the order they are resolved and echoed. */
export const FILTER_PARAMS: readonly FilterParam[] = ["user", "tag", "post"];
const RESOLVE_TASK = "resolving the filters";

/**
 * The filters given in `inputs`, resolved together: cached ones cost nothing, the rest share one request, which is also
 * their visibility check (P1, P17); each is parsed as its own kind, so a malformed one is `bad_input` before any request.
 */
export async function resolveFilters(inputs: Partial<Record<FilterParam, string>>, ctx: CallContext, svc: Services): Promise<Filters> {
  const refs = FILTER_PARAMS.flatMap((param) => {
    const value = inputs[param];
    return value === undefined ? [] : [[param, parseRef(param, value, [param])] as const];
  });
  const filters: Filters = {};
  const pending: (readonly [FilterParam, ParsedRef])[] = [];
  for (const [param, ref] of refs) {
    const hit = cachedResolution(ref, ctx, svc);
    if (hit === undefined) pending.push([param, ref]);
    else filters[param] = hit;
  }
  if (pending.length > 0) {
    const results = await svc.gql(pending.flatMap(([param, ref]) => resolutionOps(ref, param)), ctx, RESOLVE_TASK);
    for (const [param, ref] of pending) filters[param] = readResolution(ref, param, param, results, ctx, svc);
  }
  return filters;
}

/** P12: a lens or summary given as `tag` filters by its page. */
export const tagIdOf = (r: Resolved): string => (r.kind === "lens" || r.kind === "summary" ? r.pageId ?? r.id : r.id);

/** A `tag` filter as an empty template names it: `"<name>" (tag_slug …)`, or the lens or summary that stands for the page (P12). */
export function tagFilterText(r: Resolved): string {
  const ident = r.kind === "summary" ? `summary_id ${r.id}` : r.slug === undefined ? `tag_id ${r.id}` : `${r.kind === "lens" ? "lens_slug" : "tag_slug"} ${r.slug}`;
  return `"${r.name}" (${ident})`;
}

/**
 * ¶3.7, ¶4.5: the request-echo items of a date range, the same in every tool that takes dates: `date_from`/`date_to` as
 * settings whose value is the period they name in UTC (its first instant; its last millisecond, clamped to now), then
 * the clamp note. Dates are settings, so the `→` of an identifier is not used.
 */
export function dateEchoes(range: DateRange): string[] {
  const out: string[] = [];
  if (range.start !== undefined) out.push(`date_from ${isoMs(range.start)}`);
  if (range.endExclusive !== undefined) out.push(`date_to ${isoMs(range.endExclusive - 1)}`);
  const clamped = clampNote(range);
  if (clamped !== undefined) out.push(clamped);
  return out;
}

/** A request-echo setting: `<name> <value>`, with ` (default)` when the caller did not give the parameter. */
export function setting(ctx: CallContext, name: string, value: string | number | boolean): string {
  return `${name} ${String(value)}${ctx.given.has(name) ? "" : " (default)"}`;
}

/** One page within `maxTokens`, fenced with a fresh nonce. */
export function reply(spec: PageSpec, maxTokens: number, svc: Services, footerFor: (c: Consumed) => Footer): ToolOutput {
  return { text: renderPage(spec, maxTokens, svc.nonce(), footerFor).text, isError: false };
}

/** A cursor for `tool` holding the call's arguments (for the echo), their effective values (for every comparison) and the state. */
export function mint(svc: Services, tool: ToolName, args: Record<string, unknown>, effective: Record<string, unknown>, state: CursorState): string {
  return svc.cursors.issue(tool, args, effective, state);
}

/** A value as a call prints it: strings JSON-quoted, numbers and booleans as they are (hand-off arguments are only these). */
function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** `key: value` pairs in key order, without undefined values. */
function pairs(record: Readonly<Record<string, unknown>>): string {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${literal(value)}`)
    .join(", ");
}

/** A complete call to paste back: `<tool> {<args>, cursor: "<cursor>"}`, the cursor last. */
export function handOffCall(tool: ToolName, args: Readonly<Record<string, unknown>>, cursor: string): string {
  const { cursor: _ignored, ...rest } = args;
  return `${tool} {${pairs({ ...rest, cursor })}}`;
}

/** `<unit> <from>–<to>`, then ` of <total>` when the total is known. */
export function positionText(unit: string, from: number, to: number, total?: number): string {
  return `${unit} ${fmtInt(from)}–${fmtInt(to)}${total === undefined ? "" : ` of ${fmtInt(total)}`}`;
}

/** The `next:` text of a `More available` footer: `<unit> <from>–<to>`. */
export function nextText(unit: string, from: number, to: number): string {
  return positionText(unit, from, to);
}

/** The posting dates a range asks for, in UTC days, as the ¶3.9 empty templates name them; undefined for no range. */
export function periodText(range: DateRange): string | undefined {
  const { start, endExclusive } = range;
  if (start !== undefined && endExclusive !== undefined) return `posted ${day(start)} to ${day(endExclusive - 1)} UTC`;
  if (start !== undefined) return `posted from ${day(start)} UTC`;
  if (endExclusive !== undefined) return `posted up to ${day(endExclusive - 1)} UTC`;
  return undefined;
}
