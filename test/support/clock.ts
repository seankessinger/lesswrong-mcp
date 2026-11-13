// A fake clock for the tests: virtual time that only moves when a test says so, or when something "sleeps".
// `now`, `sleep` and `advance` are closures over the time, so they are safe to pass unbound (`{ now: clock.now }`,
// `sleep: clock.sleep`); `sleep` fits `HttpDeps.sleep`.

export interface FakeClock {
  now(): number;
  /** Moves virtual time forward by `ms` at once and resolves; rejects with `signal.reason` (and moves nothing) when `signal` is already aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  advance(ms: number): void;
}

/** Virtual time starts at `Date.parse(startIso)`. */
export function createClock(startIso: string): FakeClock {
  let time = Date.parse(startIso);
  return {
    now: () => time,
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      time += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      time += ms;
    },
  };
}
