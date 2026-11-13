// Layer 5 leaf. The in-memory LRU of ¶2.3 and C1, and the named-cache facade over it. One `Lru` with a 64 MB cap
// (an entry's size is the length of its JSON at insert) is shared by the raw-response cache (key prefix `http:`) and
// the named caches; the cursor store uses the entry-capped variant. Nothing is written to disk.
import { CONFIG } from "./config";
import type { CacheNs, Caches, LruLike } from "./types";

export interface LruOptions {
  /** Cap on the summed size of the entries, each measured as `JSON.stringify(value).length` at insert. */
  maxBytes?: number;
  /** Cap on the number of entries. */
  maxEntries?: number;
  /** The clock, in epoch milliseconds; tests inject a fake one. */
  now: () => number;
}

interface Entry<V> { value: V; expiresAt: number; size: number }

/**
 * A least-recently-used cache with a per-entry time to live. The `Map` is kept in recency order, oldest first: `get`
 * deletes and re-inserts the entry it returns. An entry is alive while `now() < expiresAt`, counted from insert (a
 * `get` refreshes recency, never the TTL). Entries are evicted from the oldest end while a cap is exceeded.
 */
export class Lru<V = unknown> implements LruLike {
  private readonly entries = new Map<string, Entry<V>>();
  private totalBytes = 0;
  private readonly maxBytes: number | undefined;
  private readonly maxEntries: number | undefined;
  private readonly clock: () => number;

  constructor(opts: LruOptions) {
    this.maxBytes = opts.maxBytes;
    this.maxEntries = opts.maxEntries;
    this.clock = opts.now;
  }

  /** The number of entries held, expired ones included until a `get` or an eviction removes them. */
  get size(): number {
    return this.entries.size;
  }

  /** The summed size of the entries; always 0 when no `maxBytes` is set (sizes are then not measured). */
  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.clock() >= entry.expiresAt) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.delete(key);
    // JSON.stringify answers undefined for an undefined value; it counts as size 0 rather than throwing.
    const size = this.maxBytes === undefined ? 0 : (JSON.stringify(value)?.length ?? 0);
    if (this.maxBytes !== undefined && size > this.maxBytes) return;
    this.entries.set(key, { value, expiresAt: this.clock() + ttlMs, size });
    this.totalBytes += size;
    while (this.overCap()) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.totalBytes -= entry.size;
  }

  private overCap(): boolean {
    return (this.maxEntries !== undefined && this.entries.size > this.maxEntries)
      || (this.maxBytes !== undefined && this.totalBytes > this.maxBytes);
  }
}

/**
 * The named caches of ¶2.3 over one shared `Lru`: the key is `<ns>:<key>`, and `set` uses the explicit TTL when one is
 * given, otherwise the namespace's entry in `ttlMs` (default `CONFIG.cache.ttlMs`).
 */
export function createCaches(lru: Lru<unknown>, ttlMs: Readonly<Record<CacheNs, number>> = CONFIG.cache.ttlMs): Caches {
  return {
    get<T>(ns: CacheNs, key: string): T | undefined {
      return lru.get(`${ns}:${key}`) as T | undefined;
    },
    set<T>(ns: CacheNs, key: string, value: T, ttl?: number): void {
      lru.set(`${ns}:${key}`, value, ttl ?? ttlMs[ns]);
    },
    delete(ns: CacheNs, key: string): void {
      lru.delete(`${ns}:${key}`);
    },
  };
}
