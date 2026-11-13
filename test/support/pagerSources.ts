// Fake page sources for the pager tests. They reproduce the forum's paging. The large sets are
// generated here, not inline in a test file.
import type { KeysetSource, OffsetSource, RawPage } from "../../src/paging/pager";
import { createCallContext } from "../../src/call/context";
import type { CallContext } from "../../src/types";

export interface Row { id: string; t: number; hidden?: boolean }
export interface OffsetCall { offset: number; size: number; first: boolean }
export interface KeysetCall { window: { after?: number; before?: number }; offset: number; first: boolean }
export const T0 = Date.parse("2024-06-01T00:00:00.000Z");
export const rows = (n: number, hidden: (i: number) => boolean = () => false, prefix = "r"): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: prefix + String(i).padStart(4, "0"), t: T0 - i * 1000, hidden: hidden(i) }));
export const ids = (xs: readonly Row[]): string[] => xs.map((r) => r.id);
export const ctxOf = (maxRequests = 100): CallContext => createCallContext("list_posts", { now: () => T0, maxRequests });

function page(slice: readonly Row[], all: number, size: number, withTotal: boolean): RawPage<Row> {
  const visible = slice.filter((r) => !r.hidden);
  return { rows: visible, rawCount: size, totalCount: withTotal ? (slice.length === size ? all : visible.length) : undefined };
}
export function offsetSource(raw: readonly Row[], bounded: boolean, log: OffsetCall[] = []): OffsetSource<Row> {
  return {
    kind: "offset", bounded, idOf: (r) => r.id,
    async fetch(offset, size, first, ctx) {
      ctx.beginRequest();
      log.push({ offset, size, first });
      return page(raw.slice(offset, offset + size), raw.length, size, bounded && first);
    },
  };
}
/** The rows 0…n−1, as a `scanFetch` set of `n` rows holds them. */
export const scanRows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
/**
 * A light-scan fetch over the rows 0…total−1 in raw pages of `rawCount`, of which only `visible` rows come back; the first
 * page also carries a `totalCount`. `log` gets each offset.
 */
export const scanFetch = (total: number, rawCount: number, visible: (i: number) => boolean = () => true, log: number[] = []) =>
  async (offset: number, first: boolean): Promise<RawPage<number>> => {
    log.push(offset);
    const slice = scanRows(Math.max(0, Math.min(rawCount, total - offset))).map((k) => offset + k);
    const rowsOut = slice.filter(visible);
    return { rows: rowsOut, rawCount, totalCount: first ? (slice.length === rawCount ? total : rowsOut.length) : undefined };
  };
export function keysetSource(raw: readonly Row[], dir: "new" | "old", o: { bounded?: boolean; depthGuard?: boolean } = {}, log: KeysetCall[] = []): KeysetSource<Row> {
  const bounded = o.bounded ?? false;
  return {
    kind: "keyset", dir, bounded, range: {}, depthGuard: o.depthGuard ?? false, idOf: (r) => r.id, timeOf: (r) => r.t,
    async fetch(window, offset, size, first, ctx) {
      ctx.beginRequest();
      log.push({ window, offset, first });
      const inWindow = raw
        .filter((r) => (window.after === undefined || r.t >= window.after) && (window.before === undefined || r.t < window.before))
        .sort((a, b) => (dir === "new" ? b.t - a.t : a.t - b.t) || (a.id < b.id ? 1 : -1)); // the forum's order: date, then _id desc
      return page(inWindow.slice(offset, offset + size), inWindow.length, size, bounded && first);
    },
  };
}
