import { describe, it, expect } from "vitest";
import { TOOLS } from "../../src/tools/registry";
import { listTools } from "../../src/server";
import { CONVENTIONS_LINE } from "../../src/params/vocabulary";
import { CAVEAT } from "../../src/render/messages";
import type { ToolName } from "../../src/types";

const desc = (t: ToolName) => TOOLS.find((x) => x.name === t)!.description;
const norm = (s: string) => s.toLowerCase().replace(/\.$/, "");
const has = (tools: readonly ToolName[], text: string) => { for (const t of tools) expect(norm(desc(t)), `${t} lacks: ${text}`).toContain(norm(text)); };

/** ¶9.3: canonical sentences keyed by mechanism; every tool that uses the mechanism contains them. */
const PHRASES: readonly { mechanism: string; tools: readonly ToolName[]; texts: readonly string[] }[] = [
  { mechanism: "offset paging in a vote-driven order", tools: ["list_posts", "list_comments", "get_links", "get_feed"], texts: [CAVEAT["C-DEPTH"], CAVEAT["C-DRIFT"]] },
  { mechanism: "search-backed results", tools: ["search", "first_use"], texts: [CAVEAT["C-SEARCH"]] },
  { mechanism: "event exclusion", tools: ["list_posts", "get_user", "get_tag"], texts: [CAVEAT["C-EVENTS"]] },
  { mechanism: "event exclusion (feeds)", tools: ["get_feed"], texts: ["event posts excluded", "events, group posts and posts moderators excluded from recommendations are left out"] },
  { mechanism: "list_posts quirks", tools: ["list_posts"], texts: ["coauthored", "relevance 1 or more"] },
  { mechanism: "search quirks", tools: ["search"], texts: ["primary author", "negative karma", "10,000", "debate turn", "any one of the query words"] },
  { mechanism: "get_feed quirks", tools: ["get_feed"], texts: ["zero or negative karma", "single top comment", "karma at least 1"] },
  { mechanism: "get_history quirks", tools: ["get_history"], texts: ["match ignores accents"] },
];
const LIMIT_PHRASE: Partial<Record<ToolName, string>> = {
  find: "limit counts candidates per item", search: "limit counts hits", get_comments: "limit counts threads", list_posts: "limit counts posts",
  list_comments: "limit counts comments", get_user: "limit items in each of", get_tag: "limit counts posts", get_sequence: "limit counts posts",
  list_sequences: "limit counts sequences", get_history: "limit counts versions", first_use: "limit counts candidates per page",
  get_links: "limit counts incoming items", get_feed: "limit counts items per page", list_tags: "limit counts tags",
};

describe("description conformance (¶4, ¶9.3, C6)", () => {
  it("every description names every parameter its schema accepts", () => {
    // The conventions line closes every description and itself names af_only, items, post, user, tag and more, so it is stripped:
    // each parameter must appear as a whole word in the tool's own text. Only cursor and max_tokens are named by the conventions
    // line for every tool (¶4), so those two are looked for there.
    const suffix = "\n\n" + CONVENTIONS_LINE;
    for (const l of listTools(TOOLS)) {
      expect(l.description.endsWith(suffix), `${l.name} ends with the conventions line`).toBe(true);
      const own = l.description.slice(0, -suffix.length);
      const names = Object.keys((l.inputSchema as { properties: object }).properties);
      for (const n of [...names, ...(l.name === "find" ? ["kind", "query", "commented_on"] : [])]) {
        const text = ["cursor", "max_tokens"].includes(n) ? CONVENTIONS_LINE : own;
        expect(text, `${l.name} never names ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
      }
    }
  });
  it("every tool with limit says what limit counts", () => {
    for (const l of listTools(TOOLS)) if ("limit" in (l.inputSchema as { properties: object }).properties) has([l.name], LIMIT_PHRASE[l.name]!);
  });
  it("af_only never reorders (the conventions line)", () => { expect(CONVENTIONS_LINE).toContain("af_only keeps Alignment Forum items (people: AF members) and never reorders"); });
  for (const row of PHRASES) it(`phrase table: ${row.mechanism}`, () => { for (const x of row.texts) has(row.tools, x); });
  it("C6 the 16 descriptions total at most 48,000 characters", () => {
    expect(TOOLS.reduce((n, t) => n + t.description.length, 0)).toBeLessThanOrEqual(48_000);
  });
});

describe("S rows of the quirk ledger (¶A), by their canonical sentences", () => {
  it("Q12 S both caller bounds are inclusive (conventions line)", () => { expect(CONVENTIONS_LINE).toContain("date_to includes the whole day, month or year it names"); });
  it("Q28 S search: unquoted words are near-OR", () => has(["search"], "with several words most but not all must match (two need only one)"));
  it("Q29 S search and first_use: punctuation lost inside quoted phrases", () => {
    has(["search"], "a word with an apostrophe is searched without the part after it");
    has(["first_use"], "A form with an apostrophe is searched without the part after the apostrophe");
  });
  it("Q30 S search: exclude, phrases and query words", () => has(["search"], "With exclude and no phrases, any one of the query words is enough; with phrases, query words only affect ranking; in both cases accented letters in query words are dropped"));
  it("Q33 S search and find: no synonym or abbreviation expansion", () => { has(["search"], "Abbreviations and synonyms are not expanded"); has(["find"], "the forum expands no abbreviations"); });
  it("Q34 S find and search: no diacritic folding", () => { has(["find"], "Accents matter"); has(["search"], "accented letters in query words are dropped"); });
  it("Q40 S search and list_posts: only the primary author is indexed", () => {
    has(["search"], "the primary author only, so coauthored posts are missed");
    has(["list_posts"], "it knows only primary authors, so coauthored posts are missed");
  });
  it("Q42 S search and first_use: only the current text is indexed", () => has(["search", "first_use"], "Search matches each item's current text only"));
  it("Q43 Q120 S search and first_use: what search leaves out, retracted comments included", () => has(["search", "first_use"], CAVEAT["C-SEARCH"]));
  it("Q46 S search: karma as of the index's last update", () => has(["search"], "top (karma as of the search index's last update)"));
  it("Q48 S search: a name also matches what the person wrote", () => has(["search"], "A person's name in query also matches what they wrote"));
  it("Q49 S search: typo tolerance and stopwords", () => has(["search"], "typos barely, OR and AND are ignored"));
  it("Q52 S get_comments: replies whose parent is not publicly visible", () => has(["get_comments"], 'Replies whose parent comment is not publicly visible are marked "parent comment not publicly visible"'));
  it("Q56 S get_links: no backlinks from non-positive-karma posts", () => has(["get_links"], "the forum leaves out linking posts with zero or negative karma"));
  it("Q65 S get_feed: popular_comments' rules", () => has(["get_feed"], "for each frontpage post, at most its single top comment from the last 7 days, if it has karma 15 or more"));
  it("Q66 S get_feed: quick takes' karma rules", () => has(["get_feed"], "with karma at least 1 once older than 2 hours"));
  it("Q72 S get_feed: recent discussion's silent filters", () => has(["get_feed"], "The forum leaves out posts with zero or negative karma and posts moderators removed from recent discussion"));
  it("Q88 S get_post: current slug only; posts reachable by link only open by id", () => {
    has(["get_post"], "renamed posts lose their earlier slugs");
    has(["get_post"], "a post that is reachable by link only opens by id or any URL containing its id (not by slug)");
  });
  it("Q89 S find and get_user: exact slugs and namesakes", () => {
    has(["find"], 'slug guesses are labelled "may be a namesake"');
    has(["get_user"], "exact slug (case-sensitive)");
  });
  it("Q106 S get_reactions: agreement exists only on comments", () => has(["get_reactions"], "comments only; posts have no agreement voting"));
  it("Q113 S get_feed: the front page is an approximation", () => has(["get_feed"], "an approximation of the post list a logged-out visitor sees on the home page"));
  it("Q133 S get_history: wiki edits only for a person", () => has(["get_history"], "or user (wiki edits only; post and comment histories are read one post or comment at a time)"));
});
