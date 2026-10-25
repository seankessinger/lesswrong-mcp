// Layer 5 leaf. The one-line logs of ¶7. `write` receives each line without its trailing newline (src/index.ts writes it
// to stderr, because stdout carries MCP). What createLog guarantees: every line is `[lesswrong-mcp] ` plus
// `oneLine(content, 2000)`, so no content can forge a second log line. It does not guarantee what the content says. `request` and `debug` carry a
// label or message plus numbers; the types constrain only the numbers, so callers must pass fixed literal strings there,
// never an id, title or text of a masked or dropped row (P14). `info` and `error` take free text, and a caller quoting
// forum or error text should cut it with `cutMessage` first (¶8).
import { oneLine } from "./text/sanitize";
import type { Log } from "./types";

export const LOG_PREFIX = "[lesswrong-mcp] ";
const LINE_MAX = 2000;

export interface LogOptions {
  /** Receives one finished line, without its trailing newline. */
  write: (line: string) => void;
  /** `LESSWRONG_MCP_DEBUG=1`: debug lines are written; otherwise they are dropped. */
  debug: boolean;
}

export function createLog(opts: LogOptions): Log {
  const emit = (content: string): void => opts.write(LOG_PREFIX + oneLine(content, LINE_MAX));
  return {
    request({ label, status, ms, bytes, cached }) {
      emit(`${label} ${status} ${ms}ms ${bytes}B ${cached ? "hit" : "miss"}`);
    },
    debug(message, counts) {
      if (!opts.debug) return;
      const pairs = Object.entries(counts ?? {}).map(([key, n]) => ` ${key}=${n}`);
      emit(`debug ${message}${pairs.join("")}`);
    },
    info(message) {
      emit(message);
    },
    error(message) {
      emit(message);
    },
  };
}
