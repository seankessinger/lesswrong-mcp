// Layer 1. Assembles the `Services` object of every tool call from injected I/O (¶2.1 layer 1): the transport
// (`forum/http.ts`) over one shared LRU, the GraphQL and search runners over it, the named caches over the same LRU
// (¶2.3: one 64 MB cache for raw responses and named entries alike), the cursor store (which keeps its own entry-capped
// LRU, C1), the per-reply nonce and the log. The clock, the network, the sleep, the jitter and the log come only from
// `ServicesDeps` (`src/index.ts` injects the real ones, `test/support/services.ts` deterministic ones); the bytes of nonces
// and cursor tokens come from `deps.randomBytes`, which defaults to `node:crypto`'s.
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { Lru, createCaches } from "./cache";
import { CONFIG, httpConfigWith } from "./config";
import { createGql } from "./forum/gql";
import { createHttp } from "./forum/http";
import { createSearch } from "./forum/search";
import { createCursorStore } from "./paging/cursor";
import type { HttpConfig, HttpDeps, Log, Services } from "./types";

export interface ServicesDeps {
  /** The only way to reach the network; `forum/http.ts` is its only caller. */
  fetchImpl: HttpDeps["fetchImpl"];
  /** The clock, in epoch milliseconds. */
  now: () => number;
  sleep: HttpDeps["sleep"];
  /** Uniform in [0, 1): the jitter of in-call retries. */
  random: () => number;
  log: Log;
  /** Overrides of `CONFIG.http` (tests set `spacingMs: 0`); production passes none. */
  http?: Partial<HttpConfig>;
  /** The source of nonce and cursor-token bytes; defaults to `node:crypto`'s. */
  randomBytes?: (n: number) => Uint8Array;
}

export function createServices(deps: ServicesDeps): Services {
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  const lru = new Lru({ maxBytes: CONFIG.cache.maxBytes, now: deps.now });
  const http = createHttp({
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    sleep: deps.sleep,
    random: deps.random,
    config: httpConfigWith(deps.http ?? {}),
    cache: lru,
    log: deps.log,
  });
  return {
    gql: createGql(http),
    search: createSearch(http),
    caches: createCaches(lru),
    cursors: createCursorStore({ now: deps.now, randomBytes }),
    evictResponses: http.evict,
    now: deps.now,
    nonce: () => Buffer.from(randomBytes(3)).toString("hex"),
    log: deps.log,
  };
}
