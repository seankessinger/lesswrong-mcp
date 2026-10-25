import { describe, it, expect } from "vitest";
import { FEED_TEXT, getFeedEffective } from "../../src/tools/get_feed";
import { feedOp, FEED_LIMITS } from "../../src/forum/templates/get_feed";
import { CAVEAT, END_DEPTH, SHORT_PAGE_NOTE } from "../../src/render/messages";
import { expectClean } from "../support/harness";
import { feed, h0, ids, RD_SEL, WA_SEL } from "../support/feeds";
import { gqlTexts, printedCursor } from "../support/requests";
import { SAMPLE_AUTHOR, gqlEntry, rawCommentList, rawPostRef } from "../support/builders";

const FRONT = 'f: posts(selector: {magic: {forum: true, filterSettings: {personalBlog: "Hidden", tags: [{tagId: "Ng8Gice9KNkncxqcj", tagName: "Rationality", filterMode: "TagDefault"}, {tagId: "3uE2pXvbcnS9nnZRE", tagName: "World Modeling", filterMode: "TagDefault"}]}}}';

describe("get_feed: templates", () => {
  it("feed limits", () => {
    expect(FEED_LIMITS).toEqual({ popular_comments: 100, this_week: 300, dialogues: 100, best_of: 1000, recent_discussion: 20 });
  });

  it("Q19 Q113 Q114 the nine feed templates, exact text; isolation and TTLs", () => {
    const t = (o: ReturnType<typeof feedOp>) => [o.template, o.text, o.isolate ?? false, o.ttlMs];
    expect(t(feedOp("frontpage", { limit: 100, offset: 0 }))).toEqual(["feed_frontpage", `${FRONT}, limit: 100, offset: 0) { results { ...POST_CARD } }`, false, 120_000]);
    expect(feedOp("frontpage", { limit: 20 }).text).toBe(`${FRONT}, limit: 20, offset: 0) { results { ...POST_CARD } }`);
    expect(t(feedOp("recent_discussion", { limit: 20, cutoff: "2026-10-22T00:00:00.000Z", offset: 0 }))).toEqual(
      ["feed_recent_discussion", `f: RecentDiscussionFeed(limit: 20, cutoff: "2026-10-22T00:00:00.000Z", offset: 0) ${RD_SEL}`, true, 120_000]);
    expect(feedOp("recent_discussion", { limit: 3 }).text).toBe(`f: RecentDiscussionFeed(limit: 3) ${RD_SEL}`);
    expect(t(feedOp("popular_comments", {}))).toEqual(["feed_popular_comments", "f: PopularComments(limit: 100) { results { ...COMMENT_LIST } }", false, 120_000]);
    expect(t(feedOp("quick_takes", { limit: 20, offset: 40 }))).toEqual(["feed_quick_takes", "q: comments(selector: {shortformFrontpage: {}}, limit: 20, offset: 40) { results { ...COMMENT_LIST } }", false, 120_000]);
    expect(t(feedOp("this_week", {}))).toEqual(["feed_this_week", "f: CuratedAndPopularThisWeek(af: false, limit: 300) { results { ...POST_CARD } }", false, 120_000]);
    expect(t(feedOp("wiki_activity", { limit: 10, cutoff: "2026-10-22T00:00:00.000Z", offset: 0 }))).toEqual(
      ["feed_wiki_activity", `f: AllTagsActivityFeed(limit: 10, cutoff: "2026-10-22T00:00:00.000Z", offset: 0) ${WA_SEL}`, true, 120_000]);
    expect(t(feedOp("dialogues", {}))).toEqual(["feed_dialogues", "f: RecentlyActiveDialogues(limit: 100) { results { ...POST_CARD } }", false, 120_000]);
    expect(t(feedOp("best_of", {}))).toEqual(["feed_best_of", "f: reviewWinners(selector: {default: {}}, limit: 1000) { results { postId reviewYear category reviewRanking post { ...POST_CARD } } }", false, 3_600_000]);
    expect(t(feedOp("spotlight", {}))).toEqual(["feed_spotlight", "f: currentSpotlight { documentType customTitle customSubtitle lastPromotedAt post { ...POST_CARD } sequence { ...SEQ_CARD } tag { ...TAG_CARD } }", false, 1_800_000]);
  });

  it("Q19 cutoff null is never sent; RecentDiscussionFeed takes at most 20; never an af term", () => {
    expect(() => feedOp("recent_discussion", { limit: 20, cutoff: null })).toThrow("Unexpected failure in feed_recent_discussion (cutoff null is never sent). Please report this.");
    expect(() => feedOp("recent_discussion", { limit: 21 })).toThrow("Unexpected failure in feed_recent_discussion (limit 21 over 20 on RecentDiscussionFeed). Please report this.");
    expect(() => feedOp("frontpage", {})).toThrow("Unexpected failure in feed_frontpage (page.limit is required). Please report this.");
    expect(feedOp("frontpage", { limit: 100 }).text).not.toMatch(/magic: \{[^}]*\baf: /);
    expect(feedOp("recent_discussion", { limit: 20 }).text).not.toMatch(/RecentDiscussionFeed\([^)]*\baf: /);
  });
});

describe("get_feed: the offset feeds", () => {
  it("D10 D11 Q113 L5 frontpage: the forum's order, pinned first, events, hidden posts dropped, offset paging with C-DRIFT", async () => {
    const h = h0();
    const out = await feed(h, { feed: "frontpage", limit: 3 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("get_feed — frontpage");
    expect(lines[1]).toBe(`Request: feed frontpage · limit 3 · ${FEED_TEXT.frontpage.definition}`);
    expect(out).toContain(CAVEAT["C-FRONTPAGE-APPROX"]);
    expect(ids(out)).toEqual(["openThreadPost001", "uMQ3cqWDPHhjtiesc", "R5g8YT25G9DXJJ48n"]);
    expect(out).toMatch(/post_id openThreadPost001 · .* · pinned/);
    for (const s of ["PLANTED", "Berkeley Meetup", "rejectedPost00001"]) expect(out).not.toContain(s);
    expect(lines.at(-1)).toMatch(/^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 4–6\)\. Rankings can shift between pages as votes arrive\.$/);
    expect(gqlTexts(h.forum)[0]).toContain(`${FRONT}, limit: 20, offset: 0)`);
    const next = await feed(h, { cursor: printedCursor(out)! });
    expect(ids(next)[0]).toBe("SwYBLQvo8MddDcCwz");
    expectClean(h);
  });

  it("Q113 frontpage af_only: the same query with no af term, raw pages of 100, at most 2, kept in the forum's order", async () => {
    const h = h0();
    const out = await feed(h, { feed: "frontpage", af_only: true, limit: 3 });
    expect(ids(out)).toEqual(["uMQ3cqWDPHhjtiesc", "SwYBLQvo8MddDcCwz"]);
    expect(out).toContain("af_only kept 2 of the 6 posts checked; continue with the cursor.");
    const texts = gqlTexts(h.forum);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(`${FRONT}, limit: 100, offset: 0)`);
    expect(texts[1]).toContain(`${FRONT}, limit: 100, offset: 100)`);
    expectClean(h);
  });

  it("L5 quick_takes: the logged-out set in the forum's order, offset paging, C-DRIFT", async () => {
    const h = h0();
    const out = await feed(h, { feed: "quick_takes" });
    expect([...out.matchAll(/comment_id ([A-Za-z0-9]{17})$/gm)].map((m) => m[1])).toEqual(["quickTakeEy000001", "quickTakePaul0001"]);
    expect(out).toContain("\n  quick take\n");
    expect(out).toContain(SHORT_PAGE_NOTE);
    expect(out).not.toContain("privDeletedCmnt01");
    expect(gqlTexts(h.forum)[0]).toContain("q: comments(selector: {shortformFrontpage: {}}, limit: 20, offset: 0)");
    expect(out.split("\n").at(-1)).toMatch(/^Stopped early \(request cap\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\. Rankings can shift between pages as votes arrive\.$/);
    expect(h.forum.requests).toHaveLength(2);
  });

  it("C-DEPTH frontpage and quick_takes end at offset 2,000 with the bare forum-limit sentence: no hint names date_from or sort, which they refuse", async () => {
    const posts = [1, 2].map((i) => rawPostRef({ _id: `DeepFront${String(i).padStart(8, "0")}`, title: `Deep ${i}`, slug: `deep-${i}` }));
    const takes = [1, 2].map((i) => rawCommentList({ _id: `DeepTake0${String(i).padStart(8, "0")}`, postedAt: "2026-10-20T00:00:00.000Z" }));
    const h = h0([
      gqlEntry({ root: "posts", view: "magic", terms: { forum: true }, limit: 20, offset: 2000 }, { results: posts.map((p) => ({ ...p, postedAt: "2026-10-20T00:00:00.000Z", baseScore: 10, voteCount: 2, afBaseScore: null, commentCount: 0, afCommentCount: 0, url: null, debate: false, collabEditorDialogue: false, curatedDate: null, frontpageDate: "2026-10-20T00:00:00.000Z", sticky: false, legacy: false, lastCommentedAt: null, userId: "nmk3nLpQE89dMRzzN", user: { _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }, coauthors: [], tags: [], tagRelevance: {}, reviewWinner: null })) }, "§14.2"),
      gqlEntry({ root: "comments", view: "shortformFrontpage", limit: 20, offset: 2000 }, { results: takes }, "§14.4"),
    ]);
    const effective = (feed: "frontpage" | "quick_takes") => getFeedEffective({ feed, af_only: false, sort: "new", limit: 10, max_tokens: 15000 }, feed);
    const deep = (feed: "frontpage" | "quick_takes") =>
      h.services.cursors.issue("get_feed", { feed }, effective(feed), { streams: [{ kind: "offset", shown: 1990, offset: 2000 }], current: 0 });
    for (const f of ["frontpage", "quick_takes"] as const) {
      const out = await feed(h, { cursor: deep(f) });
      expect(out, f).toContain("Position: items 1,991–1,992");
      expect(out.split("\n").at(-1), f).toBe(`End of reachable results: ${END_DEPTH}.`);
      expect(out, f).not.toMatch(/date_from|sort new/);
    }
    expect(gqlTexts(h.forum).at(-1)).toContain("offset: 2000)");
    expectClean(h);
  });

  it("parameter refusals: dates and sort only for best_of; no limit for spotlight", async () => {
    const h = h0();
    expect(await feed(h, { feed: "frontpage", date_from: "2024" })).toBe("Error (bad_input): date_from: feed frontpage takes no date_from. Only best_of takes date_from, date_to and sort.");
    expect(await feed(h, { feed: "dialogues", sort: "old" })).toBe("Error (bad_input): sort: feed dialogues takes no sort. Only best_of takes date_from, date_to and sort.");
    expect(await feed(h, { feed: "spotlight", limit: 3 })).toBe("Error (bad_input): limit: feed spotlight takes no limit. The spotlight is one item.");
    expect(h.forum.requests).toHaveLength(0);
  });
});

describe("get_feed: continuations and edges", () => {
  it("¶3.6 a cursor repeated with another value is bad_input; the same value, or none, continues; the refusals hold for a cursor too", async () => {
    const h = h0();
    const cursor = printedCursor(await feed(h, { feed: "frontpage", limit: 3 }))!;
    expect(await feed(h, { cursor, limit: 5 })).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(limit: cursor has 3, call has 5\)/);
    expect(await feed(h, { cursor, feed: "dialogues" })).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(feed: cursor has "frontpage", call has "dialogues"\)/);
    expect(await feed(h, { cursor, date_from: "2024" })).toBe("Error (bad_input): date_from: feed frontpage takes no date_from. Only best_of takes date_from, date_to and sort.");
    expect(ids(await feed(h, { cursor, feed: "frontpage", limit: 3 }))).toEqual(["SwYBLQvo8MddDcCwz"]);
    expect(ids(await feed(h, { cursor }))).toEqual(["SwYBLQvo8MddDcCwz"]);
  });

  it("P2 P3 D11 the rows dropped are only counted in the log, never named", async () => {
    const h = h0();
    await feed(h, { feed: "frontpage", limit: 3 });
    const dropped = h.logLines.filter((line) => line.includes("get_feed rows dropped"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/dropped=2$/);
    expect(h.logLines.join("\n")).not.toMatch(/PLANTED|Berkeley|rejectedPost|eventPost/);
  });

  it("a feed with nothing in its window uses the feed template once the end is known; a page with no items and a cursor never does", async () => {
    const h = h0([gqlEntry({ root: "posts", view: "magic", terms: { forum: true } }, { results: [] }, "§4.4")]);
    const first = await feed(h, { feed: "frontpage", limit: 3 });
    expect(first).not.toContain("nothing in its window");
    expect(first).toMatch(/^Stopped early \(request cap\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\./m);
    // The two empty raw pages are cached now, so the third (the empty-page rule) fits the request cap.
    const again = await feed(h, { feed: "frontpage", limit: 3 });
    expect(again).toContain("frontpage: nothing in its window (the home page's post list).");
    expect(again.split("\n").at(-1)).toBe("End of results.");
    expect(again).not.toContain("Position:");
  });

  it("Q113 quick_takes af_only: kept locally, the short page names the filter", async () => {
    const h = h0();
    const out = await feed(h, { feed: "quick_takes", af_only: true, limit: 5 });
    expect([...out.matchAll(/comment_id ([A-Za-z0-9]{17})$/gm)].map((m) => m[1])).toEqual(["quickTakePaul0001"]);
    expect(out).toContain("af_only kept 1 of the 3 quick takes checked; continue with the cursor.");
    expect(out).toContain("Request: feed quick_takes · af_only true · limit 5 ·");
    expectClean(h);
  });

  it("¶3.7 rule 3 a quick take larger than the page is sliced and the cursor resumes inside it", async () => {
    const container = rawPostRef({ _id: "quickTakesBox0001", title: "Eliezer Yudkowsky's Shortform", slug: "eliezer-yudkowsky-s-shortform", af: false, shortform: true });
    // The list form caps the body at about 1,500 tokens, so a long profile slug in the header keeps the block larger than the page.
    const long = rawCommentList({
      _id: "quickTakeLong0001", postId: container._id, af: false, shortform: true, post: container, postedAt: "2026-10-21T18:00:00.000Z",
      user: { ...SAMPLE_AUTHOR, slug: `${SAMPLE_AUTHOR.slug}-${"x".repeat(200)}` },
      contents: { markdown: Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" "), wordCount: 4000 },
    });
    const h = h0([gqlEntry({ root: "comments", view: "shortformFrontpage", offset: 0 }, { results: [long] }, "§14.4")]);
    const first = await feed(h, { feed: "quick_takes", limit: 2, max_tokens: 2000 });
    expect(first).toMatch(/\[… continues: about [\d,]+ more words; use the cursor\]/);
    expect(first).toContain("comment_id quickTakeLong0001");
    expect(first).toMatch(/More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 1–2\)\./);
    const second = await feed(h, { cursor: printedCursor(first)!, max_tokens: 2000 });
    // Nothing is lost or repeated across the cut: the second page starts at the word after the last the first page showed.
    const words = (text: string): number[] => [...text.matchAll(/\bword(\d+)\b/g)].map((m) => Number(m[1]));
    expect(words(first)[0]).toBe(0);
    expect(words(second)[0]).toBe(words(first).at(-1)! + 1);
    expect(second).not.toContain("comment_id quickTakeLong0001");
    expect(second).toContain("[… cut; full text: get_comments {comment: \"quickTakeLong0001\"}]");
    expect(second.split("\n").at(-1)).toBe("End of results.");
    expectClean(h);
  });
});
