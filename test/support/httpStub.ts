// The transport test rig: the real createHttp over a stub fetchImpl that records every call and answers with
// `answer`, a fake clock from 2026-10-22T12:00:00.000Z, the real config unless overridden, and `random` 0.5.
import { Lru } from "../../src/cache";
import { createCallContext } from "../../src/call/context";
import { CONFIG, httpConfigWith } from "../../src/config";
import { createHttp } from "../../src/forum/http";
import { createLog } from "../../src/log";
import type { CallContext, Http, HttpConfig, HttpDeps, HttpRequest, ToolName } from "../../src/types";
import { createClock, type FakeClock } from "./clock";

interface StubCall { url: string; init: RequestInit; body: string; at: number }
type Answer = (call: StubCall, index: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

interface HttpRig {
  http: Http;
  clock: FakeClock;
  calls: StubCall[];
  logLines: string[];
  cache: Lru<unknown>;
  inFlightMax(): number;
  ctx(tool?: ToolName, over?: { maxRequests?: number; signal?: AbortSignal }): CallContext;
}

export function httpRig(answer: Answer, opts: { config?: Partial<HttpConfig> } = {}): HttpRig {
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const calls: StubCall[] = [];
  const logLines: string[] = [];
  let inFlight = 0;
  let max = 0;
  const fetchImpl: HttpDeps["fetchImpl"] = async (url, init) => {
    const call = { url, init, body: String(init.body), at: clock.now() };
    calls.push(call);
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      return await answer(call, calls.length - 1);
    } finally {
      inFlight -= 1;
    }
  };
  const cache = new Lru<unknown>({ maxBytes: CONFIG.cache.maxBytes, now: () => clock.now() });
  const http = createHttp({
    fetchImpl,
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    random: () => 0.5,
    config: httpConfigWith(opts.config ?? {}),
    cache,
    log: createLog({ write: (line) => logLines.push(line), debug: false }),
  });
  return {
    http,
    clock,
    calls,
    logLines,
    cache,
    inFlightMax: () => max,
    ctx: (tool = "get_post", over = {}) => createCallContext(tool, { now: () => clock.now(), ...over }),
  };
}

export function req(body = '{"query":"query t { a }"}', endpoint: "graphql" | "search" = "graphql"): HttpRequest {
  return { endpoint, body, label: "t", task: endpoint === "graphql" ? "loading the post" : "searching" };
}
