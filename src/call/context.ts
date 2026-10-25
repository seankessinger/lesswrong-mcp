// Layer 5 leaf. The budget of one tool call (¶2.2 step 5, ¶7): a 50 s deadline after which nothing
// more is sent and no new forum request starts after 40 s, the per-tool request cap, the 20 MB download cap, the
// cancellation signal, the parameter names the caller gave, and the subjects confirmed public in this call (P17).
// Every method is a closure over the call's state, so none of them depends on how it is called.
import { CONFIG } from "../config";
import { CallStopped } from "../errors";
import type { CallContext, PublicId, PublicKind, StopReason, ToolName } from "../types";

export interface CallContextOptions {
  /** The clock; tests pass a fake one. */
  now: () => number;
  /** The MCP request's cancellation signal; a call without one cannot be cancelled. */
  signal?: AbortSignal;
  /** The names of the parameters present in the call's arguments (the echo marks the others `(default)`). */
  given?: Iterable<string>;
  /** Overrides the tool's cap in `CONFIG.call.maxRequests`. */
  maxRequests?: number;
}

export function createCallContext(tool: ToolName, opts: CallContextOptions): CallContext {
  const { deadlineMs, noNewRequestAfterMs, maxCallBytes } = CONFIG.call;
  const startedAt = opts.now();
  const elapsed = (): number => opts.now() - startedAt;
  const confirmed = new Set<string>();

  const ctx: CallContext = {
    tool,
    signal: opts.signal ?? new AbortController().signal,
    startedAt,
    maxRequests: opts.maxRequests ?? CONFIG.call.maxRequests[tool],
    given: new Set(opts.given ?? []),
    requestsUsed: 0,
    bytesUsed: 0,
    cacheKeys: [],
    now: () => opts.now(),
    mayStartRequest: () => blockedBy() === undefined,
    beginRequest() {
      ctx.signal.throwIfAborted();
      const reason = blockedBy();
      if (reason !== undefined) throw new CallStopped(reason);
      ctx.requestsUsed += 1;
    },
    // ¶7: a transport retry of the same request (the one transient retry per fetch, the in-call 429/503 retries) is not a step
    // of the tool's sequence, so it is not counted against the request cap; the 40 s mark and the byte cap still bind it.
    beginRetry() {
      ctx.signal.throwIfAborted();
      const reason = blockedBy(true);
      if (reason !== undefined) throw new CallStopped(reason);
    },
    requestTimeoutMs: () => Math.max(0, Math.min(CONFIG.http.requestTimeoutMaxMs, deadlineMs - elapsed())),
    charge(bytes) {
      ctx.bytesUsed += bytes;
    },
    // The only place in src/ that makes a Public*Id (P17): the cast is sound because the subject was just confirmed.
    confirmPublic<K extends PublicKind>(kind: K, id: string): PublicId<K> {
      confirmed.add(`${kind}:${id}`);
      return id as PublicId<K>;
    },
    isConfirmed: (kind, id) => confirmed.has(`${kind}:${id}`),
  };

  /**
   * Why no new request may start now, or undefined while one may; for a `retry` the request cap does not count. The first
   * reason ever met stays in `ctx.stopped`.
   */
  function blockedBy(retry = false): StopReason | undefined {
    let met: StopReason | undefined;
    if (elapsed() >= noNewRequestAfterMs) met = "time limit";
    else if ((!retry && ctx.requestsUsed >= ctx.maxRequests) || ctx.bytesUsed >= maxCallBytes) met = "request cap";
    if (met === undefined) return undefined;
    ctx.stopped ??= met;
    return ctx.stopped;
  }

  return ctx;
}
