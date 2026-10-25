// ¶3.6: the C-DEPTH end line is the bare forum-limit sentence plus a hint that is true for the tool that prints it. For every
// tool and source that can print the line, every parameter the hint names is in that tool's input schema and is accepted with
// the tool's current arguments. The per-tool tests pin the printed footers; this file pins the hints' truth and that every
// pager source is accounted for.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPTH_HINT } from "../../src/render/messages";
import { VOCAB } from "../../src/params/vocabulary";
import { TOOLS } from "../../src/tools/registry";
import { listTools } from "../../src/server";
import { createHarness } from "../support/harness";
import type { FixtureFamily } from "../support/fixtures";
import type { ToolName } from "../../src/types";

type HintKey = keyof typeof DEPTH_HINT;

/** Every (tool, source) that can print the C-DEPTH end line: the arguments of a call that reaches it, and the hint it then prints. */
const SOURCES: { tool: ToolName; source: string; families: readonly FixtureFamily[]; args: Record<string, unknown>; hint: HintKey | undefined }[] = [
  { tool: "list_posts", source: "offset: sort top, active, tag_relevance, curated_date, af_top", families: ["posts", "lists", "users", "tags"], args: { sort: "top" }, hint: "dates" },
  { tool: "list_posts", source: "keyset: sort new or old", families: ["posts", "lists", "users", "tags"], args: { sort: "new", user: "eliezer_yudkowsky" }, hint: "datesOnly" },
  { tool: "list_comments", source: "offset: site-wide sort top", families: ["users", "posts", "comments", "lists", "joins"], args: { sort: "top", date_from: "2024-03-01", date_to: "2024-03-31" }, hint: "dates" },
  { tool: "list_comments", source: "keyset: sort new or old", families: ["users", "posts", "comments", "lists", "joins"], args: { sort: "new", user: "sample-commenter" }, hint: "datesOnly" },
  { tool: "get_links", source: "offset: incoming posts, sort top", families: ["posts", "lists", "tags", "sequences", "comments", "users", "revisions"], args: { post: "uMQ3cqWDPHhjtiesc", direction: "incoming" }, hint: "afOnly" },
  { tool: "get_links", source: "offset: incoming posts, sort top, af_only given", families: ["posts", "lists", "tags", "sequences", "comments", "users", "revisions"], args: { post: "uMQ3cqWDPHhjtiesc", direction: "incoming", af_only: true }, hint: undefined },
  { tool: "get_feed", source: "offset: frontpage", families: ["feeds"], args: { feed: "frontpage" }, hint: undefined },
  { tool: "get_feed", source: "offset: quick_takes", families: ["feeds"], args: { feed: "quick_takes" }, hint: undefined },
];

/** A value for each parameter a hint may name, to add to the printing call's arguments. */
const SAMPLE: Record<string, unknown[]> = { date_from: ["2024-03-01"], date_to: ["2024-03-31"], sort: ["new", "old"], af_only: [true] };

const listing = listTools(TOOLS);
const schemaOf = (t: ToolName) => (listing.find((l) => l.name === t)!.inputSchema as { properties: Record<string, unknown> }).properties;
/** The parameter names a hint speaks of: its words that are parameters of ¶3.2. */
const named = (hint: string): string[] => [...new Set((hint.match(/[a-z_]+/g) ?? []).filter((w) => Object.hasOwn(VOCAB, w)))];

const TOOLS_DIR = join(__dirname, "../../src/tools");
const toolSources = () => readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts")).map((f) => ({ name: f.replace(/\.ts$/, ""), text: readFileSync(join(TOOLS_DIR, f), "utf8") }));

describe("the C-DEPTH end line's hint names only parameters the printing tool accepts (¶3.6)", () => {
  it("every hint speaks of parameters of ¶3.2, and the samples cover them", () => {
    for (const hint of Object.values(DEPTH_HINT)) {
      const params = named(hint);
      expect(params.length, hint).toBeGreaterThan(0);
      for (const p of params) expect(Object.keys(SAMPLE), `${hint}: ${p}`).toContain(p);
    }
  });

  for (const s of SOURCES) {
    if (s.hint === undefined) continue;
    const hint = DEPTH_HINT[s.hint];
    it(`${s.tool} (${s.source}): "${hint}"`, async () => {
      for (const p of named(hint)) {
        expect(Object.keys(schemaOf(s.tool)), `${s.tool} schema has ${p}`).toContain(p);
        for (const value of SAMPLE[p]!) {
          // Accepted with the tool's current arguments: the call is never refused for that parameter (it may end any other way).
          const h = createHarness({ families: s.families });
          const out = await h.call(s.tool, { ...s.args, [p]: value });
          expect(out.text, `${s.tool} ${JSON.stringify({ ...s.args, [p]: value })}`).not.toMatch(new RegExp(`^Error \\(bad_input\\): ${p}:`));
        }
      }
    });
  }

  it("every tool that pages through the shared pager is listed above with the hints its sources pass", () => {
    const listed = new Map<string, Set<string>>();
    for (const s of SOURCES) {
      const set = listed.get(s.tool) ?? new Set<string>();
      if (s.hint !== undefined) set.add(s.hint);
      listed.set(s.tool, set);
    }
    for (const { name, text } of toolSources()) {
      // A tool pages through the pager when it imports `collect` or `scanThenKeep` from it (search has a `collect` of its own).
      const pages = /import \{[^}]*\b(collect|scanThenKeep)\b[^}]*\} from "\.\.\/paging\/pager"/.test(text);
      const used = new Set([...text.matchAll(/DEPTH_HINT\.(\w+)/g)].map((m) => m[1]!));
      if (!pages && used.size === 0) continue;
      expect(listed.has(name), `${name} pages through the pager or names a depth hint but has no row above`).toBe(true);
      expect([...used].sort(), `${name}: the hints its sources pass`).toEqual([...listed.get(name)!].sort());
    }
  });
});
