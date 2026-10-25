// Layer 4b. The only network code (¶7, ¶8): every forum request goes through `createHttp(...).fetch`, which calls the
// injected `fetchImpl`. It sends only POST to the two LessWrong endpoints (S1), with the D12 headers and
// `redirect: "manual"`; keeps one request in flight process-wide behind a FIFO gate and at least the (adaptive) spacing
// between request starts (D13); honours 429/503 with a process-wide pause (Q136); retries per the ¶7 table (a retry of the
// same request is not charged to the call's request cap, though it is spaced, counted in the session windows and bound by
// the 40 s mark); and times each request out after `min(45 s, time left before 50 s)` with `setTimeout` + `AbortController`.
// It keeps 200 answers in the raw-response cache (¶2.3), checked on arrival and again when a request leaves the queue; aborts an answer over
// 12 MB; charges every answer's bytes to the call (20 MB cap, ¶7); and refuses a request that would pass a rolling
// session window (D13). Time, randomness and I/O are injected, so the tests drive it on a fake clock. It imports no
// other forum module (¶2.1).
import { createHash } from "node:crypto";
import { CONFIG } from "../config";
import { forumError, internalError, politenessCap, rateLimited, timeoutError } from "../errors";
import type { CallContext, Http, HttpDeps, HttpRequest, HttpResponse } from "../types";

/** ¶2.3: the raw-response cache key, `"http:"` + the SHA-256 (hex) of the endpoint, a newline and the exact body. */
export function responseKey(endpoint: "graphql" | "search", body: string): string {
  return "http:" + createHash("sha256").update(endpoint + "\n" + body).digest("hex");
}

/** What the raw-response cache holds for one key: the answer's text and the bytes it took on the wire. */
interface StoredResponse {
  text: string;
  bytes: number;
}

/** D13: one request start of this process, with the bytes its answer took (0 until, or unless, an answer is read). */
interface SessionEntry {
  at: number;
  bytes: number;
}

/** Bytes per tenth of a megabyte (1 MB = 1,048,576 bytes, D13): a session's bytes are reported to one decimal. */
const TENTH_MB = 104857.6;

/** S1: the only URLs this server ever sends to; a config naming any other is refused when the transport is built. */
const ALLOWED_URLS = {
  graphql: "https://www.lesswrong.com/graphql",
  search: "https://www.lesswrong.com/api/search",
} as const;

/** The abort reason of the per-request timer, told apart from the caller's cancellation by identity. */
const TIMEOUT: unique symbol = Symbol("request timeout");

/** The abort reason of the gate-wait timer: the call's 40 s mark passed while the request waited for the gate (¶7). */
const MARK: unique symbol = Symbol("40 s mark");

/** The instant after which no request of the call may start: its 40 s mark (¶7, ¶2.2 step 5). */
function markOf(ctx: CallContext): number {
  return ctx.startedAt + CONFIG.call.noNewRequestAfterMs;
}

/** A 500, 502 or 504 with an empty or non-JSON body gets the one transient retry of a fetch (search fails this way, §5.9). */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 504]);

/** The first non-whitespace character is `{` or `[`. */
function looksJson(text: string): boolean {
  return /^\s*[{[]/.test(text);
}

/**
 * The shape of an RFC 7231 IMF-fixdate (`Thu, 22 Oct 2026 12:05:00 GMT`) or RFC 850 date (`Thursday, 22-Oct-26 12:05:00 GMT`).
 * `Date.parse` alone is too lenient: V8 reads "1.5", "-1" and "5 GMT" as dates in 2000–2001, which would give a pause of 0.
 */
const HTTP_DATE = /^[A-Za-z]{3,9}, \d{2}[ -][A-Za-z]{3}[ -]\d{2}(?:\d{2})? \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `Retry-After` as milliseconds from `now`: whole seconds, or an HTTP date (¶7); undefined when absent or anything else
 * (decimals, signed values, asctime dates, which V8 reads in local time, and garbage), so the escalating pause applies.
 */
function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!HTTP_DATE.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** One holder at a time; releasing hands the gate straight to the oldest waiter, so a caller that asks again at once queues behind the others. */
interface Gate {
  /** Resolves with the release function once this caller holds the gate; an abort while waiting rejects with the signal's reason and gives up the place. */
  acquire(signal: AbortSignal): Promise<() => void>;
}

function createGate(): Gate {
  let held = false;
  const waiters: (() => void)[] = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else held = false;
  };
  return {
    acquire(signal) {
      if (!held) {
        held = true;
        return Promise.resolve(release);
      }
      return new Promise((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        };
        const onAbort = (): void => {
          waiters.splice(waiters.indexOf(grant), 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(grant);
      });
    },
  };
}

/** What one send produced: the forum's answer with its body read, or a network failure (reset, DNS, TLS). */
type Sent = { kind: "answer"; status: number; headers: Headers; text: string; ms: number; bytes: number } | { kind: "network" };

/** One answer's body: its text and size, or, once it is known to pass the size cap, only the bytes read until then. */
type Body = { tooLarge: false; text: string; bytes: number } | { tooLarge: true; bytes: number };

/** The bytes an answer's body has yielded so far; the caller owns it, so a read that fails midway still has its count (¶7). */
interface Read {
  bytes: number;
}

/**
 * Reads an answer's body as UTF-8 and counts its bytes into `read` (a `null` body is "", 0 bytes). A declared
 * `Content-Length` over `maxBytes`, or a running count that passes it, stops the read and cancels the stream (¶7 size
 * cap); a read that fails (reset, timeout, cancellation) rejects like the fetch itself, `read.bytes` holding what arrived.
 */
async function readBody(res: Response, maxBytes: number, read: Read): Promise<Body> {
  if (res.body === null) return { tooLarge: false, text: "", bytes: 0 };
  const reader = res.body.getReader();
  const declared = res.headers.get("content-length");
  let tooLarge = declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  while (!tooLarge) {
    const { done, value } = await reader.read();
    if (done) {
      parts.push(decoder.decode());
      return { tooLarge: false, text: parts.join(""), bytes: read.bytes };
    }
    read.bytes += value.byteLength;
    tooLarge = read.bytes > maxBytes;
    if (!tooLarge) parts.push(decoder.decode(value, { stream: true }));
  }
  // The stream may already have failed; cancelling it then rejects, and there is nothing left to stop.
  await reader.cancel().catch(() => undefined);
  return { tooLarge: true, bytes: read.bytes };
}

/** Records on the call a raw-response key it stored or read, once (a call's keys are evicted when its subject is not public). */
function noteKey(ctx: CallContext, key: string): void {
  if (!ctx.cacheKeys.includes(key)) ctx.cacheKeys.push(key);
}

export function createHttp(deps: HttpDeps): Http {
  const { config } = deps;
  if (config.graphqlUrl !== ALLOWED_URLS.graphql || config.searchUrl !== ALLOWED_URLS.search) {
    throw internalError("http", "endpoint not allowed");
  }

  // Process-wide state, one set per transport.
  const gate = createGate();
  let lastStartAt = -Infinity;
  let spacing = config.spacingMs;
  let successes = 0;
  let notBefore = 0;
  let limitStatus = 0;
  let episodes = 0;
  let lastEpisodeAt = -Infinity;
  const inCallRetries = new WeakMap<CallContext, number>();
  // D13: the request starts of this process, oldest first, kept as long as the longest session window.
  const session: SessionEntry[] = [];
  const longestWindowMs = Math.max(0, ...config.sessionWindows.map((w) => w.ms));

  /**
   * D13: throws `politeness_cap` when a rolling window already holds its cap of request starts or of bytes. The pause
   * ends once enough of the window's oldest entries have left it for both caps to clear; when several windows are
   * exceeded, the one whose pause ends latest is reported.
   */
  const checkSessionCaps = (): void => {
    const now = deps.now();
    while (session.length > 0 && session[0].at <= now - longestWindowMs) session.shift();
    let worst: { count: number; sum: number; label: string; until: number } | undefined;
    for (const { ms, requests, bytes, label } of config.sessionWindows) {
      const inWindow = session.filter((e) => e.at > now - ms);
      const count = inWindow.length;
      const sum = inWindow.reduce((total, e) => total + e.bytes, 0);
      let until = -Infinity;
      if (count >= requests) until = inWindow[count - requests].at + ms;
      if (sum >= bytes) {
        // k = the fewest oldest entries whose departure brings the sum below the cap.
        let k = 0;
        for (let rest = sum; rest >= bytes; k++) rest -= inWindow[k].bytes;
        until = Math.max(until, inWindow[k - 1].at + ms);
      }
      if (until > (worst?.until ?? -Infinity)) worst = { count, sum, label, until };
    }
    if (worst) throw politenessCap(worst.count, Math.round(worst.sum / TENTH_MB) / 10, worst.label, worst.until);
  };

  /** ¶2.3: a stored answer for `key`, as a hit: logged and noted on the call; no request, no bytes, no session entry. */
  const fromCache = (req: HttpRequest, ctx: CallContext, key: string): HttpResponse | undefined => {
    // Only this module writes `http:` keys, and it writes only StoredResponse values.
    const stored = deps.cache.get(key) as StoredResponse | undefined;
    if (stored === undefined) return undefined;
    deps.log.request({ label: req.label, status: 200, ms: 0, bytes: stored.bytes, cached: true });
    noteKey(ctx, key);
    return { status: 200, text: stored.text, ms: 0, bytes: stored.bytes, cached: true, cacheKey: key };
  };

  const slowDown = (): void => {
    spacing = Math.min(spacing * 2, config.maxSpacingMs);
  };

  const noteSuccess = (): void => {
    successes += 1;
    if (successes >= config.halveAfterSuccesses) {
      spacing = Math.max(config.spacingMs, spacing / 2);
      successes = 0;
    }
  };

  /** A 429 or 503: sets the process-wide pause from `Retry-After`, else the next escalating pause (Q136). */
  const startEpisode = (status: number, retryAfter: string | null): void => {
    const now = deps.now();
    if (now - lastEpisodeAt > config.episodeResetMs) episodes = 0;
    lastEpisodeAt = now;
    const pause =
      retryAfterMs(retryAfter, now) ?? config.pausesMs[Math.min(episodes, config.pausesMs.length - 1)];
    episodes += 1;
    notBefore = now + Math.min(pause, config.retryAfterCapMs);
    limitStatus = status;
  };

  /** Sleeps until `at`, again if a real timer wakes a little early, so a start never comes before it. */
  const sleepUntil = async (at: number, signal: AbortSignal): Promise<void> => {
    for (let wait = at - deps.now(); wait > 0; wait = at - deps.now()) await deps.sleep(wait, signal);
  };

  /**
   * Holds the gate for the call, waiting no longer than its 40 s mark: a call queued behind a slow request then stops
   * with no request at the mark (`CallStopped("time limit")` from its own context, as for any request that may not
   * start), instead of learning only when the gate is granted that the mark has passed (¶7). The timer runs on
   * `setTimeout`, like the per-request timeout, and is cleared as soon as the gate is held.
   */
  const acquireBeforeMark = async (ctx: CallContext): Promise<() => void> => {
    const mark = markOf(ctx);
    const waiter = new AbortController();
    const onCancel = (): void => waiter.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => waiter.abort(MARK), Math.max(0, mark - deps.now()));
    try {
      return await gate.acquire(waiter.signal);
    } catch (e) {
      if (e !== MARK) throw e;
      // The timer and the clock can disagree by a few milliseconds; the context, on its own clock, records the stop.
      await sleepUntil(mark, ctx.signal);
      ctx.beginRequest();
      throw internalError("http", "the 40 s mark passed without a stop");
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onCancel);
    }
  };

  /**
   * One request: armed with its own controller, aborted by the caller's cancellation or by the per-request timer. Every
   * answer read, oversize included, is logged and its bytes charged to the call and to the request's session `entry`.
   */
  const send = async (req: HttpRequest, ctx: CallContext, entry: SessionEntry): Promise<Sent> => {
    const controller = new AbortController();
    const onCancel = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => controller.abort(TIMEOUT), ctx.requestTimeoutMs());
    const init: RequestInit = {
      method: "POST",
      headers: {
        "User-Agent": config.userAgent,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip",
      },
      body: req.body,
      redirect: "manual",
      signal: controller.signal,
    };
    const url = req.endpoint === "graphql" ? config.graphqlUrl : config.searchUrl;
    const start = deps.now();
    const read: Read = { bytes: 0 };
    try {
      // Only the exchange itself is read as a network failure; what follows it must never cause a re-send.
      let res: Response;
      let body: Body;
      try {
        res = await deps.fetchImpl(url, init);
        body = await readBody(res, config.maxResponseBytes, read);
      } catch {
        successes = 0;
        // ¶7: what arrived before the failure was downloaded all the same, so it counts for the call and the session window.
        ctx.charge(read.bytes);
        entry.bytes = read.bytes;
        // ¶7 Logging: one line per request, so a request that got no answer writes its own line. Never the error's text.
        const timedOut = controller.signal.reason === TIMEOUT;
        const outcome = timedOut ? "timeout" : ctx.signal.aborted ? "cancelled" : "network-error";
        deps.log.info(`${req.label} ${outcome} ${deps.now() - start}ms ${read.bytes}B miss`);
        if (timedOut) throw timeoutError(req.task);
        if (ctx.signal.aborted) throw ctx.signal.reason;
        return { kind: "network" };
      }
      const ms = deps.now() - start;
      deps.log.request({ label: req.label, status: res.status, ms, bytes: body.bytes, cached: false });
      ctx.charge(body.bytes);
      entry.bytes = body.bytes;
      if (body.tooLarge) {
        controller.abort();
        successes = 0;
        throw forumError(req.task, "response too large");
      }
      return { kind: "answer", status: res.status, headers: res.headers, text: body.text, ms, bytes: body.bytes };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onCancel);
    }
  };

  /** The attempt loop of one fetch, run while it holds the gate; `key` is the request's raw-response cache key. */
  const attempts = async (req: HttpRequest, ctx: CallContext, key: string): Promise<HttpResponse> => {
    let transientRetryUsed = false;
    // ¶7: the next attempt is a retry of the same request, so it is not charged to the call's request cap (CallContext.beginRetry).
    let retrying = false;
    const transientRetry = async (): Promise<void> => {
      transientRetryUsed = true;
      retrying = true;
      await deps.sleep(Math.round(config.retryDelayMs * (1 + config.retryJitter * deps.random())), ctx.signal);
    };

    const mark = markOf(ctx);
    for (;;) {
      if (deps.now() < notBefore) throw rateLimited(limitStatus, notBefore, deps.now());
      const begin = (): void => (retrying ? ctx.beginRetry() : ctx.beginRequest());
      // A request that may not start throws CallStopped here, before any spacing wait.
      if (retrying || !ctx.mayStartRequest()) begin();
      // The spacing wait ends at the 40 s mark at the latest: a slot past the mark is a stop, not a wait (¶7).
      await sleepUntil(Math.min(lastStartAt + spacing, mark), ctx.signal);
      checkSessionCaps();
      begin();
      retrying = false;
      lastStartAt = deps.now();
      const entry: SessionEntry = { at: lastStartAt, bytes: 0 };
      session.push(entry);

      const sent = await send(req, ctx, entry);
      if (sent.kind === "network") {
        if (!transientRetryUsed) {
          await transientRetry();
          continue;
        }
        throw forumError(req.task, "network error");
      }

      const { status, text, ms, bytes } = sent;
      // A 400 is the caller's to read: JSON from GraphQL (R9), the forum's text/plain message from the search endpoint (§5).
      if ((status === 200 && looksJson(text)) || (status === 400 && (req.endpoint === "search" || looksJson(text)))) {
        noteSuccess();
        // ¶2.3: only a 200 is stored, so no error (a 400 included) is ever served from here.
        if (status === 200) {
          const stored: StoredResponse = { text, bytes };
          deps.cache.set(key, stored, req.ttlMs ?? config.responseTtlMs);
          noteKey(ctx, key);
        }
        return { status, text, ms, bytes, cached: false, cacheKey: key };
      }
      successes = 0;
      if (status === 0 || (status >= 300 && status <= 399)) {
        throw forumError(req.task, "the forum redirected the request");
      }
      if (status === 429 || status === 503) {
        startEpisode(status, sent.headers.get("retry-after"));
        slowDown();
        const used = inCallRetries.get(ctx) ?? 0;
        const retryInCall =
          notBefore - deps.now() <= config.inCallRetryMaxWaitMs && notBefore <= mark && used < config.inCallRetriesMax;
        if (!retryInCall) throw rateLimited(status, notBefore, deps.now());
        inCallRetries.set(ctx, used + 1);
        retrying = true;
        await sleepUntil(notBefore, ctx.signal);
        continue;
      }
      if (status === 200 || status === 400) {
        // A non-JSON body where JSON is due (a 200, or a GraphQL 400): a bot challenge, so the spacing doubles (D13).
        slowDown();
        throw forumError(req.task, "unexpected non-JSON response (possibly bot protection)");
      }
      if (TRANSIENT_STATUSES.has(status) && !looksJson(text)) {
        if (!transientRetryUsed) {
          await transientRetry();
          continue;
        }
        throw forumError(req.task, req.endpoint === "search" ? "the forum's search failed" : `HTTP ${status}`);
      }
      throw forumError(req.task, `HTTP ${status}`);
    }
  };

  return {
    async fetch(req, ctx) {
      ctx.signal.throwIfAborted();
      const key = responseKey(req.endpoint, req.body);
      // A cached answer costs the forum nothing, so it is served even while a pause or a session cap holds.
      const early = fromCache(req, ctx, key);
      if (early) return early;
      if (deps.now() < notBefore) throw rateLimited(limitStatus, notBefore, deps.now());
      const release = await acquireBeforeMark(ctx);
      try {
        // ¶7 "Cache before sending": an identical request may have been answered while this one waited in the queue.
        // Checking once here suffices: while this fetch holds the gate, no other request can store an answer.
        return fromCache(req, ctx, key) ?? (await attempts(req, ctx, key));
      } finally {
        release();
      }
    },
    evict(keys) {
      for (const key of keys) deps.cache.delete(key);
    },
  };
}
