import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_ORDER } from "../../src/tools/registry";
import { listTools, ANNOTATIONS } from "../../src/server";
import { createHarness } from "../support/harness";
import { GOLDEN } from "../support/goldenCases";
import type { ToolName, ToolOutput } from "../../src/types";

/** A minimal valid call per tool whose first request reaches the forum (all eleven families loaded). */
const MINIMAL: Record<ToolName, Record<string, unknown>> = {
  find: { items: [{ kind: "post", query: "AGI Ruin" }] }, search: { query: "inner alignment" }, get_post: { post: "uMQ3cqWDPHhjtiesc" },
  get_comments: { post: "uMQ3cqWDPHhjtiesc" }, list_posts: { tag: "ai" }, list_comments: { user: "eliezer_yudkowsky" }, get_user: { user: "eliezer_yudkowsky" },
  get_tag: { tag: "ai" }, get_sequence: { sequence: "5g5TkQTe9rmPS5vvM" }, list_sequences: {}, get_history: { post: "uMQ3cqWDPHhjtiesc" },
  first_use: { forms: ["inner alignment"] }, get_links: { post: "uMQ3cqWDPHhjtiesc" }, get_reactions: { post: "uMQ3cqWDPHhjtiesc" },
  get_feed: { feed: "frontpage" }, list_tags: {},
};
const LIMITED = "Error (rate_limited): The forum is limiting requests (HTTP 429). This server sends nothing to it until 2026-10-22 12:10 UTC (about 10 min); try again after that.";

describe("transport errors reach every tool (¶3.9, ¶7)", () => {
  for (const t of TOOL_ORDER) {
    it(`¶7 ${t}: a 429 on its first request is rate_limited; while the pause holds the next call sends nothing`, async () => {
      const h = createHarness();
      h.forum.inject({ status: 429, headers: { "retry-after": "600" } });
      expect((await h.call(t, MINIMAL[t])).text).toBe(LIMITED);
      const n = h.forum.requests.length;
      expect((await h.call(t, MINIMAL[t])).text).toBe(LIMITED);
      expect(h.forum.requests).toHaveLength(n);
    });
    it(`¶7 ${t}: a 502 on its first request and on the retry is forum_error`, async () => {
      const h = createHarness();
      h.forum.inject({ status: 502, times: 2 });
      expect((await h.call(t, MINIMAL[t])).text).toMatch(/^Error \(forum_error\): The forum returned an error while .+ \((HTTP 502|the forum's search failed)\)\. Try again later\.$/);
    });
    it(`¶7 ${t}: a 502 on its first request alone is retried without being charged to the call's cap: the reply is the one a clean run gives`, async () => {
      // A retry of the same request is not a step of the tool's sequence, so a transient failure the retry cures changes nothing,
      // not even for a tool whose mandatory sequence equals its cap. The first golden case of the tool that answers cleanly is
      // run twice, plain and with the one 502; the replies must be identical.
      let plain: ToolOutput | undefined;
      let withRetry: ToolOutput | undefined;
      for (const c of GOLDEN.filter((g) => g.tool === t)) {
        const h = createHarness({ families: c.families, extra: c.extra?.() });
        plain = await h.call(c.tool, c.args);
        if (plain.isError) continue;
        const hurt = createHarness({ families: c.families, extra: c.extra?.() });
        hurt.forum.inject({ status: 502, times: 1 });
        withRetry = await hurt.call(c.tool, c.args);
        expect(hurt.forum.requests.length, `${c.name}: one more fetch, the retry`).toBe(h.forum.requests.length + 1);
        break;
      }
      expect(plain?.isError, `${t} has a golden case that answers cleanly`).toBe(false);
      expect(withRetry?.text).toBe(plain!.text);
    });
  }
});

describe("titles and annotations (¶4)", () => {
  it("¶4 every tool is published with its question as title and the four annotations", () => {
    expect(Object.fromEntries(listTools(TOOLS).map((l) => [l.name, l.title]))).toEqual({
      find: "Which post, person, topic or sequence is this name?", search: "Where is X discussed?",
      get_post: "What does this post say, and what is its status?", get_comments: "What is the discussion, who disagreed, who replied to whom?",
      list_posts: "What did X post about T in a period, best first?", list_comments: "What has X been commenting on? What is being said lately?",
      get_user: "Who is this, and what have they done lately?", get_tag: "What does the wiki say, and what are the top posts?",
      get_sequence: "What is in this sequence or collection, in order?", list_sequences: "What sequences exist, by X, or curated?",
      get_history: "How was this edited? What did the original say? What wiki pages did X edit?", first_use: "Who first used this phrase, and was it original?",
      get_links: "What links to this post, and what does it link to?", get_reactions: "How was this post, comment or wiki page received, and who reacted how?",
      get_feed: "What is on the front page, active, or Best of?", list_tags: "What tags exist, or which tags sit under this core tag?",
    });
    for (const l of listTools(TOOLS)) expect(l.annotations).toEqual(ANNOTATIONS);
    expect(ANNOTATIONS).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  });
});
