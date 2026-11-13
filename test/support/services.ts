// `Services` wired to a fake forum and a fake clock: the deterministic assembly every tool test uses. Spacing is 0, the
// retry jitter is fixed (`random` 0.5), and nonces and cursor tokens come from one byte counter that starts at 0, so
// a nonce is `000102`, `030405`, … until cursors take bytes too. The log is in debug mode and collects its lines.
import { createLog } from "../../src/log";
import { createServices } from "../../src/services";
import type { CursorStore, HttpConfig, Services } from "../../src/types";
import type { FakeForum } from "../fakeForum";
import { createClock, type FakeClock } from "./clock";

export function servicesFor(
  forum: FakeForum,
  opts: {
    clock?: FakeClock;
    http?: Partial<HttpConfig>;
    /** Wraps the cursor store (a test that spies on or fails `issue`/`take`); applied before the services are returned. */
    wrapCursors?: (s: CursorStore) => CursorStore;
    /** Receives every log line; a fresh array when omitted. */
    logLines?: string[];
  } = {},
): Services {
  const clock = opts.clock ?? createClock("2026-10-22T12:00:00.000Z");
  const logLines = opts.logLines ?? [];
  let counter = 0;
  const svc = createServices({
    fetchImpl: forum.fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    log: createLog({ write: (line) => logLines.push(line), debug: true }),
    http: { spacingMs: 0, ...opts.http },
    randomBytes: (n) => Uint8Array.from({ length: n }, () => counter++ & 255),
  });
  return opts.wrapCursors ? { ...svc, cursors: opts.wrapCursors(svc.cursors) } : svc;
}
