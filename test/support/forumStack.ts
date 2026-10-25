// test/support/forumStack.ts
import { Lru } from "../../src/cache";
import { createCallContext } from "../../src/call/context";
import { CONFIG, httpConfigWith } from "../../src/config";
import { createHttp } from "../../src/forum/http";
import { createLog } from "../../src/log";
import type { CallContext, Http, ToolName } from "../../src/types";
import { createFakeForum, type FakeForum } from "../fakeForum";
import { createClock, type FakeClock } from "./clock";
import type { FixtureEntry } from "./fixtures";

interface ForumStack {
  forum: FakeForum;
  http: Http;
  clock: FakeClock;
  logLines: string[];
  ctx(tool?: ToolName, maxRequests?: number): CallContext;
}

export function forumStack(opts: { fixtures: readonly FixtureEntry[]; lint?: boolean }): ForumStack {
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const logLines: string[] = [];
  const forum = createFakeForum({ fixtures: opts.fixtures, lint: opts.lint, sleep: (ms) => clock.sleep(ms) });
  const http = createHttp({
    fetchImpl: forum.fetchImpl,
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    random: () => 0.5,
    config: httpConfigWith({ spacingMs: 0 }),
    cache: new Lru({ maxBytes: CONFIG.cache.maxBytes, now: () => clock.now() }),
    log: createLog({ write: (line) => logLines.push(line), debug: false }),
  });
  return {
    forum,
    http,
    clock,
    logLines,
    ctx: (tool = "get_post", maxRequests = 50) => createCallContext(tool, { now: () => clock.now(), maxRequests }),
  };
}
