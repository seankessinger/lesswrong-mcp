// The tool-test harness (¶9.2): calls tools through the server's own `callTool` (strict parse, bad_input wording, CallContext,
// error wrapper) with the deterministic services of support/services.ts over a fake forum loaded with fixture families, on a
// fake clock. `expectClean` asserts that the run sent only lint-clean requests, every one answered by a fixture whose documents
// carried every field asked for.
import { expect } from "vitest";
import { callTool } from "../../src/server";
import { TOOLS } from "../../src/tools/registry";
import type { HttpConfig, Services, ToolDef, ToolName, ToolOutput } from "../../src/types";
import { createFakeForum, type FakeForum } from "../fakeForum";
import { createClock, type FakeClock } from "./clock";
import { ALL_FAMILIES, loadFamilies, type FixtureEntry, type FixtureFamily } from "./fixtures";
import { servicesFor } from "./services";

export interface Harness {
  call(tool: ToolName, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<ToolOutput>;
  forum: FakeForum;
  clock: FakeClock;
  services: Services;
  /** Every log line, debug lines included. */
  logLines: string[];
}

export function createHarness(
  opts: {
    families?: readonly FixtureFamily[];
    /** Entries matched before the families' (overrides first). */
    extra?: readonly FixtureEntry[];
    http?: Partial<HttpConfig>;
    /** Default: `TOOLS`. */
    tools?: readonly ToolDef[];
  } = {},
): Harness {
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const fixtures = [...(opts.extra ?? []), ...loadFamilies(...(opts.families ?? ALL_FAMILIES))];
  const forum = createFakeForum({ fixtures, sleep: clock.sleep, now: clock.now });
  const logLines: string[] = [];
  const services = servicesFor(forum, { clock, http: opts.http, logLines });
  const tools = opts.tools ?? TOOLS;
  return {
    call: (tool, args, o) => callTool({ tools, services, now: clock.now }, tool, args, o?.signal),
    forum,
    clock,
    services,
    logLines,
  };
}

/** No lint error, no missing-field warning and no unmatched request in the run (an unmatched alias is answered with an error, not thrown). */
export function expectClean(h: Harness): void {
  expect(h.forum.lintErrors).toEqual([]);
  expect(h.forum.warnings).toEqual([]);
  expect(h.forum.unmatched).toEqual([]);
}
