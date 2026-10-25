// Layer 3. The cursor store of C1 and ¶3.6: opaque tokens (`c_` + 22 base64url characters from `randomBytes(16)`) that name
// continuation state kept in an in-memory LRU (at most 1,000 entries, 60 minutes from issue). The token carries nothing, a
// token is never consumed, and stored values are copies. `checkCursorParams` compares the parameters given with a cursor
// against the entry's stored effective values (¶2.2 step 2).
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { Lru } from "../cache";
import { CONFIG } from "../config";
import { ToolError, badCursor, internalError } from "../errors";
import { oneLine } from "../text/sanitize";
import type { CursorEntry, CursorState, CursorStore, ToolName } from "../types";

/** A well-formed token: `c_` and 22 base64url characters (the 16 random bytes, unpadded). */
export const CURSOR_RE = /^c_[A-Za-z0-9_-]{22}$/;

const TOKEN_BYTES = 16;
/** Most draws `issue` makes for one token when each hits a token the store already holds. */
const MAX_DRAWS = 16;
/** Longest rendering of a stored or given value in the conflict message, in code points. */
const SHOWN_VALUE_CAP = 60;

/**
 * A fresh, empty store: a new store stands for a restart. `now` is the clock (epoch ms). `randomBytes` defaults to
 * `node:crypto`'s; `maxEntries` and `ttlMs` default to `CONFIG.cursor`.
 */
export function createCursorStore(opts: {
  now: () => number;
  randomBytes?: (n: number) => Uint8Array;
  maxEntries?: number;
  ttlMs?: number;
}): CursorStore {
  const { now } = opts;
  const draw = opts.randomBytes ?? nodeRandomBytes;
  const ttlMs = opts.ttlMs ?? CONFIG.cursor.ttlMs;
  const lru = new Lru<CursorEntry>({ maxEntries: opts.maxEntries ?? CONFIG.cursor.maxEntries, now });

  return {
    issue(tool: ToolName, args: Record<string, unknown>, effective: Record<string, unknown>, state: CursorState): string {
      // A token the store already holds is drawn again, never reused. The redraws are bounded: with node:crypto the bound
      // is never reached, but a repeating source (a test's counter) would otherwise loop for ever, and a synchronous loop
      // cannot be interrupted by a test timeout.
      let token: string | undefined;
      for (let draws = 0; token === undefined && draws < MAX_DRAWS; draws++) {
        const candidate = "c_" + Buffer.from(draw(TOKEN_BYTES)).toString("base64url");
        if (lru.get(candidate) === undefined) token = candidate;
      }
      if (token === undefined) throw internalError(tool, `no unused cursor token after ${MAX_DRAWS} draws`);
      // Copies, so that nothing the caller keeps (or later changes) is shared with the store.
      lru.set(token, structuredClone({ tool, args, effective, state, issuedAt: now() }), ttlMs);
      return token;
    },

    take(tool: ToolName, token: string): CursorEntry {
      if (!CURSOR_RE.test(token)) throw badCursor();
      const entry = lru.get(token);
      // The age is checked here as well, so that expiry never depends on how the LRU treats reads.
      if (entry === undefined || entry.tool !== tool || now() - entry.issuedAt >= ttlMs) throw badCursor();
      return structuredClone(entry);
    },
  };
}

/** Deep equality for effective values: arrays by position, plain objects by key in any order, everything else by `===`. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length
    && ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `none` for an absent value, else its JSON on one line, cut to 60 characters. */
function shown(v: unknown): string {
  return v === undefined ? "none" : oneLine(JSON.stringify(v), SHOWN_VALUE_CAP);
}

/**
 * ¶3.6 "Conflicting parameters": every parameter in `given` (already resolved by the caller: slugs to ids, dates to
 * instants) must equal the entry's stored effective value; `cursor` and `max_tokens` are exempt, since only `max_tokens`
 * may change. The first mismatch, in the order the parameters were given, is a `bad_input` error.
 */
export function checkCursorParams(entry: CursorEntry, given: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(given)) {
    if (key === "cursor" || key === "max_tokens") continue;
    const stored = Object.hasOwn(entry.effective, key) ? entry.effective[key] : undefined;
    if (sameValue(stored, value)) continue;
    throw new ToolError(
      "bad_input",
      `this cursor was issued for different parameters (${oneLine(key, SHOWN_VALUE_CAP)}: cursor has ${shown(stored)}, call has ${shown(value)}). Pass only the cursor to continue, or repeat the call without it to start over.`,
    );
  }
}
