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
  { mechanism: "get_history quirks", tools: ["get_history"], texts: ["match reads whole words"] },
  // The site's links sort chapters by number alone (ties undefined); a post's own page follows its stored next and previous posts.
  { mechanism: "sequence neighbours", tools: ["get_post", "get_sequence"], texts: ["the site's next and previous links can differ when chapters tie"] },
  { mechanism: "sequence neighbours (a post's own page)", tools: ["get_post"], texts: ["and on the post's own page at the ends"] },
  // Tag relevance is a vote score, and the site's tagging bot applies tags too (TagRel.autoApplied): "tagged" is not "readers tagged".
  { mechanism: "tag relevance", tools: ["get_post"], texts: ["tags ordered by relevance (a weighted vote score, shown)"] },
  { mechanism: "tag relevance (lists)", tools: ["list_posts"], texts: ["tag (only posts tagged with it, relevance 1 or more)", "tag_relevance (needs tag: the tag's relevance score on the post, not quality)"] },
  { mechanism: "tag relevance (a page's posts)", tools: ["get_tag"], texts: ["Only posts actually tagged are listed (relevance 1 or more)", "or placeholder page, not yet created"] },
  // /tags/all redirects to /wikitags/all, grouped by core tag; wiki-only pages hold posts tagged before; placeholders are not yet created.
  // Many wiki-only pages were created wiki-only (Arbital imports, the site's "wiki page" option), so "no longer" was false of them.
  // The site's tag pickers leave wiki-only pages out (AddTagButton, TagMultiselect), but the API and the parent-tag cascade can
  // still apply one, and many were created wiki-only: "the site doesn't offer" is what holds.
  { mechanism: "list_tags pages", tools: ["list_tags"], texts: ["(about 1,010), alphabetically.", "(articles the site doesn't offer as tags, though some hold posts)", "Placeholder pages (pages not yet created) are not listed"] },
  { mechanism: "wiki-only pages", tools: ["get_tag"], texts: ["wiki-only page, which the site doesn't offer as a tag, though it can hold posts"] },
  { mechanism: "wiki-only pages (find)", tools: ["find"], texts: ["(articles the site doesn't offer as tags, though some hold posts)"] },
  // #135: the site's concepts page lists admin-only pages under their core tag (TagsByCoreTagId), and so does this server, flagged.
  { mechanism: "core groupings", tools: ["list_tags"], texts: ["all the tags grouped under it, in the forum's order"] },
  // A post's own debate flag decides whether the site shows its turns (PostsPage); there is no fixed list of six.
  // …and that page never shows the body (PostsPage: `!post.debate`), though get_post prints it, labelled.
  { mechanism: "debates", tools: ["get_post"], texts: ["an old-style debate's turns follow its body, which its page replaces with them"] },
  { mechanism: "debates (get_comments)", tools: ["get_comments"], texts: ["The debate turns of old-style debate posts are in get_post", "parent comment not shown"] },
  // Only a quick-takes thread's root is a quick take; the hide-everywhere rule shows no comment on a hidden post or page.
  { mechanism: "comment places", tools: ["list_comments"], texts: ["\"in a quick take\""] },
  // Wiki pages keep real versions from before 2019; only posts exist as the February-2019 import snapshot.
  { mechanism: "pre-2019 texts", tools: ["get_history"], texts: ["post texts from before 13 February 2019"] },
];
/** Wording a description must not carry: each was false (the audit's #80-83, #131, #134, #255, #125 and, once they opened, #135). */
const NEVER: readonly string[] = [
  "readers tagged", "readers applied", "readers tied", "readers actually tagged", "relevance votes", "as on the site's all-tags page",
  "can no longer be applied", "articles that can't be applied to posts", "can't be applied to posts, though", "empty wiki stubs",
  "6 old-style debate", "or a post or wiki page that is not publicly visible", "placeholder page with no content", "limits: texts from before",
  "except admin-only pages",
  // #19 #188 (3 of 339 winners differ), #190 #194 #198 (the forum's source is public), #200 (no date window: every dialogue).
  "a winner's review year is its posting year", "page code isn't public", "page code is not public", "recently active dialogues",
  // The extra: a URL's id opens only a publicly visible post.
  "the id in any URL works", "the id in a URL always works",
  // P18: a post that hides its comments' karma; the site's search page still shows it, so "not publicly visible" was false.
  "karma not publicly visible", "karma is not publicly visible",
  // The forum's stored last-comment date is never printed: drafts move it and no page shows it.
  "last comment date unknown", "each post shows that date", "count their posting date; that date isn't printed",
  // recentComments' 18-hour window starts 18 hours before each item's own stored date and has no end (Posts.recentComments), not at the page's newest item.
  "the 18 hours before the newest item on the page", "comments from the 18 hours before its stored latest-comment date", "so some items show none",
  // get_history takes no comment (post, tag or user only).
  "when the post or comment was published",
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
  it("no description carries a wording found false", () => {
    for (const l of listTools(TOOLS)) for (const x of NEVER) expect(norm(l.description), `${l.name}: ${x}`).not.toContain(norm(x));
  });
  it("C6 the 16 descriptions total at most 48,000 characters", () => {
    expect(TOOLS.reduce((n, t) => n + t.description.length, 0)).toBeLessThanOrEqual(48_000);
  });
});

describe("S rows of the quirk ledger (¶A), by their canonical sentences", () => {
  it("Q12 S both caller bounds are inclusive (conventions line)", () => { expect(CONVENTIONS_LINE).toContain("date_to includes the whole day, month or year it names"); });
  it("Q28 S search: unquoted words are near-OR", () => has(["search"], "with several words most but not all must match (two need only one)"));
  it("Q29 S search and first_use: punctuation lost inside quoted phrases", () => {
    has(["search"], "The forum's exact matching can't reach a word it keeps whole with punctuation inside");
    has(["first_use"], "A form holding such a word is searched loosely");
  });
  it("Q30 S search: exclude, phrases and query words", () => has(["search"], "With exclude and no phrases, any one of the query words is enough; with phrases, query words only affect ranking, unless every phrase is searched loosely, when they count as words to match; beside a quoted phrase or an exclude, punctuation and accented letters in query words are dropped"));
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
  // #76: the forum's thread views never return a hidden comment, so a reply's missing parent is only known not to be shown.
  it("Q52 #76 S get_comments: replies whose parent is not shown", () => {
    has(["get_comments"], 'Threads mark a reply whose parent is not shown "parent comment not shown" ("reply to a debate turn by …" for the debate\'s turns)');
    expect(TOOLS.find((t) => t.name === "get_comments")!.description).not.toContain("parent comment not publicly visible");
  });
  it("#116 S get_reactions: a debate turn has its karma and reactions only", () => has(["get_reactions"], "a debate turn has just karma and reactions"));
  // P18: a comment's hideKarma follows its post's hideCommentKarma (updateCommentHideKarma), and the site says "This post has disabled karma visibility".
  it("P18 S get_reactions: hidden comment karma is the post's setting", () => has(["get_reactions"], 'If a comment\'s post hides comment karma, its scores and reactions are unavailable ("karma hidden on this post")'));
  // The site's "Recent Comments" sort; the forum's stored date also moves for a draft comment, so it is not printed.
  it("S list_posts: sort active is the forum's latest-comment order, its date not printed", () => has(["list_posts"], 'active (the forum\'s latest-comment date first, as the site\'s "Recent Comments" sort; that date isn\'t printed: a draft comment moves it too'));
  // The window has a start only (postedAt > stored date − 18 h): a draft published after the stored date is listed too.
  it("S get_feed: recent_discussion's 18-hour window is each item's own", () => has(["get_feed"], "the forum includes only positive-karma comments posted since 18 hours before its stored latest-comment date"));
  // The forum's own feeds leave out an item whose comments are all hidden, unless it was probably never commented on.
  it("S get_feed: recent_discussion leaves out quick-takes items with no comment listed, and posts unless never commented on", () => has(["get_feed"], "its stored latest-comment date; a quick take with none is dropped, a post too unless never commented on)"));
  it("Q56 S get_links: no backlinks from non-positive-karma posts", () => has(["get_links"], "the forum leaves out linking posts with zero or negative karma"));
  it("Q65 S get_feed: popular_comments' rules", () => has(["get_feed"], "for each frontpage post, at most its single top comment from the last 7 days, if it has karma 15 or more"));
  it("Q66 S get_feed: quick takes' karma rules", () => has(["get_feed"], "with karma at least 1 once older than 2 hours"));
  it("Q72 S get_feed: recent discussion's silent filters", () => has(["get_feed"], "The forum leaves out posts with zero or negative karma and posts moderators removed from recent discussion"));
  it("Q88 S get_post: current slug only; posts reachable by link only open by id", () => {
    has(["get_post"], "renamed posts lose their earlier slugs");
    // #96 #57: the forum's slug view skips four kinds of public post.
    has(["get_post"], "posts reachable by link only (flagged), quick-takes containers, sub-questions and group posts open by id or any URL containing it (not by slug)");
  });
  it("S get_post and get_history: a post's text is its page, as a logged-out reader sees it", () => {
    has(["get_post"], "the text is read from the post's page, as a logged-out reader sees it, and if the page can't be read the text is not shown");
    has(["get_history"], "A post's text comes from that version's page, as a logged-out reader sees it; a version whose page can't be read gives an error");
  });
  it("Q89 S find and get_user: exact slugs and namesakes", () => {
    has(["find"], 'slug guesses are labelled "may be a namesake"');
    has(["get_user"], "exact slug (case-sensitive)");
  });
  it("Q106 S get_reactions: agreement exists only on comments", () => has(["get_reactions"], "comments only; posts have no agreement voting"));
  it("Q113 S get_feed: the front page is an approximation", () => has(["get_feed"], "an approximation of the post list a logged-out visitor sees on the home page"));
  it("#185 S get_feed: frontpage leaves out posts over 90 days old, as the site's list does", () => has(["get_feed"], "pinned posts first; posts over about 90 days old and event posts excluded"));
  it("#19 #188 S get_feed: a best_of winner's review year can differ from its posting year", () => has(["get_feed"], "filtered with date_from/date_to on the posting date (a winner's review year can differ)"));
  // #200: no date window, every dialogue by its newest posting or dialogue message; the server reads the first 100 (the forum's
  // access check runs after its LIMIT, so a short answer is the end of those 100, not of all dialogues).
  it("#200 S get_feed: dialogues are the 100 newest, by posting or dialogue message", () => has(["get_feed"], "dialogues — the 100 newest dialogues by posting or dialogue message"));
  it("Q133 S get_history: wiki edits only for a person", () => has(["get_history"], "or user (wiki edits only; post histories are read one post at a time)"));
});
