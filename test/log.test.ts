import { describe, expect, it } from "vitest";
import { createLog } from "../src/log";

function capture(debug: boolean) {
  const lines: string[] = [];
  return { lines, log: createLog({ write: (l) => lines.push(l), debug }) };
}

describe("log (¶7 logging)", () => {
  it("one line per request: label, status, ms, bytes, hit or miss", () => {
    const { lines, log } = capture(false);
    log.request({ label: "get_post_main", status: 200, ms: 812, bytes: 48213, cached: false });
    log.request({ label: "get_post_main", status: 200, ms: 0, bytes: 48213, cached: true });
    expect(lines).toEqual([
      "[lesswrong-mcp] get_post_main 200 812ms 48213B miss",
      "[lesswrong-mcp] get_post_main 200 0ms 48213B hit",
    ]);
  });

  it("P14 debug lines carry a message and counts only, and only with LESSWRONG_MCP_DEBUG", () => {
    const off = capture(false);
    off.log.debug("dropped rows", { visibility: 3 });
    expect(off.lines).toEqual([]);
    const on = capture(true);
    on.log.debug("dropped rows", { visibility: 3, recheck: 0 });
    on.log.debug("aliases", undefined);
    expect(on.lines).toEqual([
      "[lesswrong-mcp] debug dropped rows visibility=3 recheck=0",
      "[lesswrong-mcp] debug aliases",
    ]);
  });

  it("info and error are single lines", () => {
    const { lines, log } = capture(false);
    log.info("node v22.20.0");
    log.error("Unexpected failure\n    at x (/srv/y.js:1:1)");
    expect(lines).toEqual([
      "[lesswrong-mcp] node v22.20.0",
      "[lesswrong-mcp] Unexpected failure at x (/srv/y.js:1:1)",
    ]);
  });
});
