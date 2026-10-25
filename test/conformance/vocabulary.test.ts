import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_ORDER } from "../../src/tools/registry";
import { listTools } from "../../src/server";
import { SORTS, VOCAB } from "../../src/params/vocabulary";
import type { ToolName } from "../../src/types";

type Json = Record<string, unknown>;
const listing = listTools(TOOLS);
const schemaOf = (t: ToolName) => listing.find((l) => l.name === t)!.inputSchema as { properties: Record<string, Json>; required?: string[]; additionalProperties?: boolean };
const sorted = (xs: readonly unknown[]) => [...xs].map(String).sort();

/** ¶4: the parameters each tool accepts. */
const ACCEPTS: Record<ToolName, string[]> = {
  find: ["items", "af_only", "limit", "cursor", "max_tokens"],
  search: ["kind", "query", "phrases", "exclude", "user", "tag", "post", "af_only", "date_from", "date_to", "sort", "limit", "cursor", "max_tokens"],
  get_post: ["post", "section", "match", "include_body", "cursor", "max_tokens"],
  get_comments: ["post", "comment", "tag", "user", "match", "sort", "af_only", "limit", "cursor", "max_tokens"],
  list_posts: ["user", "tag", "date_from", "date_to", "af_only", "curated_only", "frontpage_only", "questions_only", "min_karma", "sort", "query", "limit", "cursor", "max_tokens"],
  list_comments: ["user", "date_from", "date_to", "af_only", "quick_takes_only", "min_karma", "sort", "limit", "cursor", "max_tokens"],
  get_user: ["user", "af_only", "limit", "cursor", "max_tokens"],
  get_tag: ["tag", "section", "match", "sort", "limit", "af_only", "cursor", "max_tokens"],
  get_sequence: ["sequence", "post", "af_only", "limit", "cursor", "max_tokens"],
  list_sequences: ["user", "curated_only", "af_only", "sort", "limit", "cursor", "max_tokens"],
  get_history: ["post", "comment", "tag", "user", "revision", "compare_to", "phrases", "match", "sort", "limit", "cursor", "max_tokens"],
  first_use: ["forms", "include_comments", "af_only", "limit", "cursor", "max_tokens"],
  get_links: ["post", "tag", "direction", "sort", "af_only", "limit", "cursor", "max_tokens"],
  get_reactions: ["post", "comment", "tag", "cursor", "max_tokens"],
  get_feed: ["feed", "af_only", "date_from", "date_to", "sort", "limit", "cursor", "max_tokens"],
  list_tags: ["tag", "limit", "cursor", "max_tokens"],
};
const REQUIRED: Partial<Record<ToolName, string[]>> = { find: ["items"], get_post: ["post"], get_user: ["user"], get_tag: ["tag"], get_sequence: ["sequence"], first_use: ["forms"], get_feed: ["feed"] };

/** ¶3.2: the one shared definition of every parameter (enum and the declared exceptions are checked separately). */
const str = (min: number, max: number) => ({ type: "string", minLength: min, maxLength: max });
const flag = (dflt: boolean) => ({ type: "boolean", default: dflt });
const SHARED: Record<string, Json> = {
  post: str(1, 500), comment: str(1, 500), user: str(1, 500), tag: str(1, 500), sequence: str(1, 500), commented_on: str(1, 500),
  revision: str(1, 40), compare_to: str(1, 40), query: str(1, 300), match: str(2, 200), date_from: str(4, 40), date_to: str(4, 40), cursor: str(1, 64),
  phrases: { type: "array", minItems: 1, maxItems: 5, items: str(2, 100) },
  forms: { type: "array", minItems: 1, maxItems: 5, items: str(2, 100) },
  exclude: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", pattern: "^[A-Za-z0-9]{1,40}$" } }, // one ASCII word of 1–40 chars
  min_karma: { type: "integer", minimum: -100, maximum: 100000 },
  section: { type: "integer", minimum: 1, maximum: 500 },
  limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  max_tokens: { type: "integer", minimum: 2000, maximum: 40000, default: 15000 },
  af_only: flag(false), curated_only: flag(false), frontpage_only: flag(false), questions_only: flag(false), quick_takes_only: flag(false),
  include_comments: flag(true), include_body: flag(true),
  direction: { type: "string", default: "both" }, feed: { type: "string" },
};
const ENUMS: Record<string, string[]> = {
  direction: ["both", "incoming", "outgoing"],
  feed: ["best_of", "dialogues", "frontpage", "popular_comments", "quick_takes", "recent_discussion", "spotlight", "this_week", "wiki_activity"],
};

describe("vocabulary conformance (¶3.2, ¶9.3)", () => {
  it("D6 TOOLS is exactly the 16 tools in ¶4 order; no generic query tool or raw-filter parameter", () => {
    expect(TOOL_ORDER).toHaveLength(16);
    // ¶4.1–4.16, in the spec's section order.
    expect([...TOOL_ORDER]).toEqual(["find", "search", "get_post", "get_comments", "list_posts", "list_comments", "get_user", "get_tag", "get_sequence",
      "list_sequences", "get_history", "first_use", "get_links", "get_reactions", "get_feed", "list_tags"]);
    for (const t of TOOL_ORDER) for (const p of Object.keys(schemaOf(t).properties)) expect(["view", "fields", "filter", "selector", "graphql", "terms"]).not.toContain(p);
  });

  for (const t of Object.keys(ACCEPTS) as ToolName[]) {
    it(`${t}: accepts exactly its ¶4 parameters, each as ¶3.2 defines it`, () => {
      const s = schemaOf(t);
      expect(sorted(Object.keys(s.properties))).toEqual(sorted(ACCEPTS[t]));
      expect(s.additionalProperties).toBe(false);
      expect(s.required ?? []).toEqual(REQUIRED[t] ?? []);
      for (const [name, prop] of Object.entries(s.properties)) {
        expect(Object.keys(VOCAB)).toContain(name);
        if (name === "sort") {
          expect(prop.enum).toEqual(SORTS[t]!.allowed);
          expect(prop.default).toBe(SORTS[t]!.dflt);
          // ¶9.3 "equals": nothing besides type, enum, default and description (no length, pattern or bound).
          const { description: _d, enum: _e, default: _f, ...rest } = prop;
          expect(rest, `${t}.${name}`).toEqual({ type: "string" });
        } else if (name === "kind") {
          expect(sorted(prop.enum as string[])).toEqual(["comment", "post", "sequence", "tag", "user"]);
          expect(prop.default).toBe("post");
          const { description: _d, enum: _e, default: _f, ...rest } = prop;
          expect(rest, `${t}.${name}`).toEqual({ type: "string" });
        } else if (name !== "items") {
          // ¶9.3 "equals the shared definition": type, default, bounds and pattern are compared whole (description aside), and a
          // parameter that has no enum in ENUMS must not gain one.
          const { description: _d, enum: en, ...rest } = prop;
          expect(rest, `${t}.${name}`).toEqual(SHARED[name]);
          expect(en === undefined ? undefined : sorted(en as string[]), `${t}.${name} enum`).toEqual(ENUMS[name]);
        }
      }
    });
  }

  it("find items: 1–5 strict objects {kind (post, user, tag, sequence; required), query (1–300), commented_on (1–500)}", () => {
    const items = schemaOf("find").properties.items as { type: string; minItems: number; maxItems: number; items: { properties: Record<string, Json>; required: string[]; additionalProperties: boolean } };
    expect([items.type, items.minItems, items.maxItems]).toEqual(["array", 1, 5]);
    expect(sorted(Object.keys(items.items.properties))).toEqual(["commented_on", "kind", "query"]);
    for (const n of Object.keys(items.items.properties)) expect(Object.keys(VOCAB), `${n} (a find item property) is not a VOCAB entry`).toContain(n);
    expect(sorted(items.items.required)).toEqual(["kind", "query"]);
    expect(items.items.additionalProperties).toBe(false);
    expect(sorted(items.items.properties.kind.enum as string[])).toEqual(["post", "sequence", "tag", "user"]);
    // Compared whole: nothing but the type and the enum (no default, pattern or length) on the item kind.
    const { description: _kd, enum: _ke, ...kind } = items.items.properties.kind as Json;
    expect(kind).toEqual({ type: "string" });
    const { description: _qd, ...query } = items.items.properties.query;
    const { description: _cd, ...commentedOn } = items.items.properties.commented_on;
    expect(query).toEqual(SHARED.query);
    expect(commentedOn).toEqual(SHARED.commented_on);
  });

  it("every VOCAB entry names exactly the tools that accept it; list-valued entries state how items combine", () => {
    const has = (t: ToolName, name: string) => ACCEPTS[t].includes(name) || (t === "find" && ["kind", "query", "commented_on"].includes(name));
    for (const [name, def] of Object.entries(VOCAB)) expect(sorted(def.tools)).toEqual(sorted(TOOL_ORDER.filter((t) => has(t, name))));
    expect([VOCAB.phrases.combine, VOCAB.forms.combine, VOCAB.exclude.combine, VOCAB.items.combine]).toEqual(["AND", "OR", "OR", "EACH"]);
  });
});
