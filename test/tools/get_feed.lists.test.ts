import { describe, it, expect } from "vitest";
import { FEED_TEXT } from "../../src/tools/get_feed";
import { staleCacheCaveat } from "../../src/render/messages";
import { expectClean } from "../support/harness";
import { feed, h0, ids } from "../support/feeds";
import { gqlTexts, printedCursor } from "../support/requests";
import { A_COMMENTER, OTHER_USER, gqlEntry, rawPostCard, rawCommentList, rawSeqCard, rawTagCard, rawUserRef } from "../support/builders";
import { loadFamilies } from "../support/fixtures";

// the same helpers as test/tools/get_feed.test.ts: test/support/feeds.ts
const spot = (o: Record<string, unknown>) => gqlEntry({ root: "currentSpotlight" }, { documentType: "Post", customTitle: "Best of LessWrong 2024", customSubtitle: null, lastPromotedAt: "2026-10-21T18:00:00.000Z", post: null, sequence: null, tag: null, ...o }, "§14.3");

describe("get_feed: the list feeds and the spotlight", () => {
  it("Q65 Q50.43 popular_comments: one request of 100, cached 2 minutes, C-STALE-CACHE (5 + 2), comments in list form, a hidden post unnamed", async () => {
    const h = h0();
    const out = await feed(h, { feed: "popular_comments" });
    expect(out).toContain(staleCacheCaveat(5));
    expect([...out.matchAll(/comment_id ([A-Za-z0-9]{17})$/gm)].map((m) => m[1])).toEqual(["popCmntOnAgi00001", "popCmntOnGlm00001", "popCmntHidden0001"]);
    expect(out).toContain("  on a post that is not publicly visible");
    expect(out).not.toContain("draftPost00000001");
    expect(out.endsWith("End of results.")).toBe(true);
    expect(gqlTexts(h.forum)[0]).toContain("f: PopularComments(limit: 100) { results { ...COMMENT_LIST } }");
    h.clock.advance(119_000); await feed(h, { feed: "popular_comments" });
    expect(h.forum.requests).toHaveLength(1);
    h.clock.advance(2_000); await feed(h, { feed: "popular_comments" });
    expect(h.forum.requests).toHaveLength(2);
    const af = await feed(h0(), { feed: "popular_comments", af_only: true });
    expect(af).toContain("af_only: the AF site's own list uses a 30-day window.");
    expect(af).toContain("comment_id popCmntOnAgi00001");
    expect(af).not.toContain("popCmntOnGlm00001");
  });

  it("Q129 Q65 a list feed that returned exactly its internal limit ends 'more may exist'; an empty one uses the feed-window template", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => rawCommentList({ _id: `popSynth${String(i).padStart(9, "0")}`, af: false, baseScore: 200 - i, postedAt: "2026-10-21T00:00:00.000Z" }));
    const h = h0([gqlEntry({ root: "PopularComments" }, { results: rows }, "§14.3")]);
    const p1 = await feed(h, { feed: "popular_comments", limit: 50 });
    const p2 = await feed(h, { cursor: printedCursor(p1)! });
    expect(p2.split("\n").at(-1)).toBe("End of reachable results: the forum returned the most this server requests (100); more may exist.");
    const dl = Array.from({ length: 100 }, (_, i) => rawPostCard({ _id: `dlgSynth${String(i).padStart(9, "0")}`, collabEditorDialogue: true }));
    const d = h0([gqlEntry({ root: "RecentlyActiveDialogues" }, { results: dl }, "§14.3")]);
    const d1 = await feed(d, { feed: "dialogues", limit: 50 });
    expect((await feed(d, { cursor: printedCursor(d1)! })).split("\n").at(-1)).toBe("End of reachable results: the forum returned the most this server requests (100); more may exist.");
    const e = await feed(h0([gqlEntry({ root: "PopularComments" }, { results: [] }, "§14.3")]), { feed: "popular_comments" });
    expect(e).toContain("popular_comments: nothing in its window (comments of 15+ karma on frontpage posts in the last 7 days).");
  });

  it("Q64 D11 L5 this_week: af false, limit 300; hidden and event posts dropped; the forum's order", async () => {
    const h = h0();
    const out = await feed(h, { feed: "this_week" });
    expect(ids(out)).toEqual(["SwYBLQvo8MddDcCwz", "R5g8YT25G9DXJJ48n"]);
    for (const s of ["PLANTED", "unlistedPost00001", "Berkeley Meetup"]) expect(out).not.toContain(s);
    expect(gqlTexts(h.forum)[0]).toContain("f: CuratedAndPopularThisWeek(af: false, limit: 300) { results { ...POST_CARD } }");
    expect(out.endsWith("End of results.")).toBe(true);
  });

  it("Q64 Q50.43 dialogues: hidden posts dropped; C-STALE-CACHE (10 + 2)", async () => {
    const out = await feed(h0(), { feed: "dialogues" });
    expect(ids(out)).toEqual(["dialoguePost00001"]);
    expect(out).toContain(staleCacheCaveat(10));
    expect(out).toMatch(/post_id dialoguePost00001 · .* · dialogue/);
    expect(out).not.toContain("PLANTED");
  });

  it("Q114 Q50.41 P14 best_of: sorted locally by year and rank, new and old, date filters on the posting date; only public winners", async () => {
    const h = h0();
    const neu = await feed(h, { feed: "best_of" });
    expect(ids(neu)).toEqual(["uMQ3cqWDPHhjtiesc", "bestOf2022Post002", "bestOf2019Post001", "bestOf2018Post001"]);
    expect(neu.split("\n")[1]).toBe(`Request: feed best_of · sort new (default) · limit 10 (default) · ${FEED_TEXT.best_of.definition}`);
    expect(neu).toContain("Best of LessWrong 2022 (ai safety, #1)");
    for (const s of ["PLANTED", "rejectedPost00001", "9999"]) expect(neu).not.toContain(s);
    expect(ids(await feed(h, { feed: "best_of", sort: "old" }))).toEqual(["bestOf2018Post001", "bestOf2019Post001", "uMQ3cqWDPHhjtiesc", "bestOf2022Post002"]);
    expect(ids(await feed(h, { feed: "best_of", date_from: "2022", date_to: "2022" }))).toEqual(["uMQ3cqWDPHhjtiesc", "bestOf2022Post002"]);
    expect(h.forum.requests).toHaveLength(1);
    h.clock.advance(3_599_000); await feed(h, { feed: "best_of" });
    expect(h.forum.requests).toHaveLength(1);
    expect(await feed(h0([gqlEntry({ root: "reviewWinners", view: "default" }, { results: [] }, "§14.6")]), { feed: "best_of", date_from: "2025", date_to: "2025" }))
      .toContain("best_of: nothing in its window (Annual Review winners from 2018 on, posted 2025-01-01 to 2025-12-31 UTC).");
  });

  it("P1 P2 P3 P4 Q50.43 spotlight: the item with its custom title; masked, flagged and non-AF cases", async () => {
    const out = await feed(h0(), { feed: "spotlight" });
    expect(out).toContain('Spotlight "Best of LessWrong 2024" · "A spotlight subtitle" · promoted 2026-10-21');
    expect(out).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(out.split("\n")[1]).toBe(`Request: feed spotlight · ${FEED_TEXT.spotlight.definition}`);
    const masked = await feed(h0([spot({ customTitle: "PLANTED-P1-1", customSubtitle: "PLANTED-P1-2", post: rawPostCard({ _id: "rejectedPost00001", title: "Rejected Post", slug: "rejected-post", rejected: true, userId: A_COMMENTER._id, user: A_COMMENTER }) })]), { feed: "spotlight" });
    expect(masked).toContain("There is no spotlight item to show.");
    for (const s of ["PLANTED", "rejectedPost00001", "Rejected Post"]) expect(masked).not.toContain(s);
    expect(await feed(h0([spot({ post: rawPostCard({ _id: "unlistedPost00001", title: "An Unlisted Post", slug: "unlisted-post", unlisted: true }) })]), { feed: "spotlight" })).toContain("reachable by link only");
    expect(await feed(h0([spot({ documentType: "Sequence", sequence: rawSeqCard({ _id: "hiddenSeq00000001", title: "A Hidden Sequence", hidden: true, user: OTHER_USER }) })]), { feed: "spotlight" })).toContain("not in the site's sequence lists");
    expect(await feed(h0([spot({ post: rawPostCard({ _id: "R5g8YT25G9DXJJ48n", af: false }) })]), { feed: "spotlight", af_only: true })).toContain("The current spotlight is not on the Alignment Forum.");
    expect(await feed(h0([gqlEntry({ root: "currentSpotlight" }, null, "§14.3")]), { feed: "spotlight" })).toContain("spotlight: nothing in its window (the home page's current featured item).");
  });

  it("¶7 every feed stays within 2 requests", async () => {
    for (const f of ["frontpage", "recent_discussion", "popular_comments", "quick_takes", "this_week", "wiki_activity", "dialogues", "best_of", "spotlight"]) {
      const h = h0(); const out = await feed(h, { feed: f });
      // No feed is left unimplemented: each answers a page, never an error.
      expect(out).not.toMatch(/^Error/);
      expect(h.forum.requests.length).toBeLessThanOrEqual(2);
      expectClean(h);
    }
  });

  it("¶3.5 af_only keeps the AF items of this_week, dialogues and best_of, in the forum's order", async () => {
    expect(ids(await feed(h0(), { feed: "this_week", af_only: true }))).toEqual(["SwYBLQvo8MddDcCwz"]);
    expect(ids(await feed(h0(), { feed: "dialogues", af_only: true }))).toEqual(["dialoguePost00001"]);
    const best = await feed(h0(), { feed: "best_of", af_only: true });
    expect(ids(best)).toEqual(["uMQ3cqWDPHhjtiesc", "bestOf2022Post002"]);
    expect(best).toContain("Request: feed best_of · sort new (default) · af_only true · limit 10 (default) ·");
    // The echo names a filter that removed nothing else; no note about a short page (the set is filtered before it is paged).
    expect(best).not.toContain("continue with the cursor");
  });

  it("¶3.6 best_of pages keep the dates and the order of the first call; an open range names its side in the empty window", async () => {
    const h = h0();
    const p1 = await feed(h, { feed: "best_of", date_from: "2019", limit: 2 });
    expect(ids(p1)).toEqual(["uMQ3cqWDPHhjtiesc", "bestOf2022Post002"]);
    expect(p1).toMatch(/More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 3–4\)\.$/);
    expect(p1).not.toContain("Rankings can shift");
    const p2 = await feed(h, { cursor: printedCursor(p1)! });
    expect(ids(p2)).toEqual(["bestOf2019Post001"]);
    // Dates are settings, echoed `<name> <value>` as in list_posts; the arrow is for identifiers.
    expect(p2).toContain(" · date_from 2019-01-01T00:00:00.000Z · ");
    expect(p2).not.toContain("date_from →");
    expect(p2).toContain("Position: items 3–3");
    expect(p2.split("\n").at(-1)).toBe("End of results.");
    expect(h.forum.requests).toHaveLength(1);
    expect(await feed(h, { cursor: printedCursor(p1)!, date_from: "2018" })).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(date_from:/);
    expect(await feed(h, { feed: "best_of", date_from: "2023" })).toContain("(Annual Review winners from 2018 on, posted from 2023-01-01 UTC).");
    expect(await feed(h, { feed: "best_of", date_to: "2017" })).toContain("(Annual Review winners from 2018 on, posted up to 2017-12-31 UTC).");
  });

  it("P10 popular_comments after its cache expired within the cursor's hour: read again, resumed after the last comment shown, a hidden addition changes nothing", async () => {
    const h = h0();
    const base = (loadFamilies("feeds").find((e) => "root" in e.match && e.match.root === "PopularComments")!.result as { results: unknown[] }).results;
    const first = await feed(h, { feed: "popular_comments", limit: 2 });
    const cursor = printedCursor(first)!;
    const answer = (rows: unknown[]) => ({ endpoint: "graphql" as const, when: (b: string) => b.includes("PopularComments("), times: 1, body: JSON.stringify({ data: { f: { results: rows } } }) });
    const comments = (text: string) => [...text.matchAll(/comment_id ([A-Za-z0-9]{17})$/gm)].map((m) => m[1]);
    // The same comments, with one more public comment now first: the page after the last one shown is the third, and the note counts it.
    h.clock.advance(3 * 60_000);
    h.forum.inject(answer([rawCommentList({ _id: "popCmntNewer00001", af: false, postedAt: "2026-10-22T11:00:00.000Z" }), ...base]));
    const grown = await feed(h, { cursor });
    expect(comments(grown)).toEqual(["popCmntHidden0001"]);
    expect(grown).toContain("The list changed since the previous page (1 new item); positions may have shifted.");
    // A rejected comment is not public: the visible set is as it was, so there is no note.
    h.clock.advance(3 * 60_000);
    h.forum.inject(answer([rawCommentList({ _id: "popCmntRejected001", rejected: true, postedAt: "2026-10-22T11:30:00.000Z" }), ...base]));
    const same = await feed(h, { cursor });
    expect(comments(same)).toEqual(["popCmntHidden0001"]);
    expect(same).not.toContain("The list changed");
    expect(h.forum.requests).toHaveLength(3);
  });

  it("popular_comments at a small budget: long bodies are paged through the cursor from the one answer, every comment once and in order", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => rawCommentList({
      _id: `popLong${String(i).padStart(10, "0")}`, af: false, baseScore: 200 - i, postedAt: "2026-10-21T00:00:00.000Z",
      contents: { markdown: Array.from({ length: 300 }, (_, w) => `w${i}x${w}`).join(" "), wordCount: 300 },
    }));
    const h = h0([gqlEntry({ root: "PopularComments" }, { results: rows }, "§14.3")]);
    let out = await feed(h, { feed: "popular_comments", max_tokens: 2000 });
    const pages = [out];
    for (let n = 0; n < 20 && printedCursor(out) !== undefined; n++) {
      out = await feed(h, { cursor: printedCursor(out)!, max_tokens: 2000 });
      pages.push(out);
    }
    expect(pages.length).toBeGreaterThan(1);
    const seen = pages.flatMap((page) => [...page.matchAll(/comment_id (popLong\d+)$/gm)].map((m) => m[1]!));
    expect(seen).toEqual(rows.map((r) => r._id));
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
    expect(h.forum.requests).toHaveLength(1);
    expectClean(h);
  });

  it("P2 P3 P14 the rows dropped are only counted in the log, never named", async () => {
    const h = h0();
    await feed(h, { feed: "this_week" });
    await feed(h, { feed: "dialogues" });
    await feed(h, { feed: "best_of" });
    await feed(h, { feed: "popular_comments" });
    const dropped = h.logLines.filter((line) => line.includes("get_feed rows dropped"));
    expect(dropped.map((line) => /dropped=(\d+)$/.exec(line)?.[1])).toEqual(["3", "2", "2"]);
    expect(h.logLines.join("\n")).not.toMatch(/PLANTED|rejectedPost|unlistedPost|eventPost|Berkeley/);
  });

  it("P1 P2 P12 spotlight: a wiki page keeps af_only and says so; a missing title is left out; a hidden or unknown document is masked", async () => {
    const tag = rawTagCard({ _id: "innerAlignTag0001", name: "Inner Alignment", slug: "inner-alignment" });
    const wiki = await feed(h0([spot({ documentType: "Tag", customTitle: null, tag })]), { feed: "spotlight", af_only: true });
    expect(wiki).toContain("Request: feed spotlight · af_only true · af_only does not apply to wiki pages · ");
    expect(wiki).toContain("\nSpotlight · promoted 2026-10-21\n");
    expect(wiki).toContain("tag_id innerAlignTag0001");
    expect(await feed(h0([spot({ documentType: "Sequence", sequence: rawSeqCard({ _id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong" }) })]), { feed: "spotlight" })).toContain("sequence_id 5g5TkQTe9rmPS5vvM");
    const masked = [
      spot({ documentType: "Tag", tag: rawTagCard({ _id: "adminOnlyTag00001", name: "PLANTED-P12-13", adminOnly: true }), customSubtitle: "PLANTED-P12-14" }),
      spot({ documentType: "Sequence", sequence: null, customSubtitle: "PLANTED-P4-1" }),
      spot({ documentType: "Post", post: null, customSubtitle: "PLANTED-P1-3" }),
      spot({ documentType: "Collection", customSubtitle: "PLANTED-P1-4" }),
    ];
    for (const entry of masked) {
      const h = h0([entry]);
      const out = await feed(h, { feed: "spotlight" });
      expect(out).toContain("There is no spotlight item to show.");
      expect(out).not.toContain("nothing in its window");
      for (const s of ["PLANTED", "Best of LessWrong 2024", "adminOnlyTag00001"]) expect(out).not.toContain(s);
      expect(out.split("\n").at(-1)).toBe("End of results.");
      expect(h.logLines.filter((line) => line.includes("get_feed rows dropped")).map((line) => /dropped=(\d+)$/.exec(line)?.[1])).toEqual(["1"]);
    }
  });

  it("¶3.6 ¶3.7 rule 3 a spotlight record larger than the page is sliced: the cursor is a slice cursor and nothing is lost or repeated across the cuts", async () => {
    const coauthors = Array.from({ length: 300 }, (_, i) => rawUserRef({ _id: `coauthor${String(i).padStart(9, "0")}`, slug: `co-author-${i}`, displayName: `Coauthor${i}` }));
    const h = h0([spot({ post: rawPostCard({ coauthors }) })]);
    let out = await feed(h, { feed: "spotlight", max_tokens: 2000 });
    const pages = [out];
    while (printedCursor(out) !== undefined) {
      expect(out).toMatch(/\(next: text from \d+ %\)\.$/);
      out = await feed(h, { cursor: printedCursor(out)!, max_tokens: 2000 });
      pages.push(out);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toMatch(/\nPosition: text 1–\d+ %\n/);
    expect(pages[1]).toMatch(/\nPosition: text \d+–\d+ %\n/);
    for (const page of pages) expect(page).toContain('Spotlight "Best of LessWrong 2024" · promoted 2026-10-21');
    const numbers = pages.flatMap((page) => [...page.matchAll(/\bCoauthor(\d+)\b/g)].map((m) => Number(m[1])));
    expect(numbers).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
    expect(pages.at(-1)).toContain("post_id uMQ3cqWDPHhjtiesc");
    // The item is read once: the continuation reuses the answer the transport kept for 30 minutes.
    expect(h.forum.requests).toHaveLength(1);
  });

  it("¶3.6 a sliced spotlight that changed before the next page starts again at the beginning of the new item and says so; an unchanged one carries on", async () => {
    const people = (prefix: string) => Array.from({ length: 300 }, (_, i) => rawUserRef({ _id: `${prefix.toLowerCase()}${String(i).padStart(9, "0")}`, slug: `${prefix.toLowerCase()}-${i}`, displayName: `${prefix}${i}` }));
    const h = h0([spot({ post: rawPostCard({ coauthors: people("Coauthor") }) })]);
    const first = await feed(h, { feed: "spotlight", max_tokens: 2000 });
    const cursor = printedCursor(first)!;
    expect(cursor).toBeDefined();
    // The cache lapsed (30 minutes) and the forum now features another item: a new promotion date, another record.
    h.clock.advance(31 * 60_000);
    const answer = { documentType: "Post", customTitle: "Best of LessWrong 2025", customSubtitle: null, lastPromotedAt: "2026-10-22T18:00:00.000Z", post: rawPostCard({ _id: "newSpotlightPost01", coauthors: people("Other") }), sequence: null, tag: null };
    h.forum.inject({ endpoint: "graphql" as const, when: (b: string) => b.includes("currentSpotlight"), times: 1, body: JSON.stringify({ data: { f: answer } }) });
    let out = await feed(h, { cursor, max_tokens: 2000 });
    const pages = [out];
    expect(out).toContain("The spotlight changed since the previous page; starting again at the beginning of the new item.");
    expect(out).toMatch(/\nPosition: text 1–\d+ %\n/);
    expect(out).toContain('Spotlight "Best of LessWrong 2025" · promoted 2026-10-22');
    expect(out).not.toContain("Coauthor");
    while (printedCursor(out) !== undefined) {
      out = await feed(h, { cursor: printedCursor(out)!, max_tokens: 2000 });
      pages.push(out);
    }
    // The new item is shown whole and once, from its first character; the note is on the page where the change was noticed only.
    expect(pages.flatMap((page) => [...page.matchAll(/\bOther(\d+)\b/g)].map((m) => Number(m[1])))).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(pages.filter((page) => page.includes("The spotlight changed since the previous page"))).toHaveLength(1);
    expect(pages.join("\n")).toContain("post_id newSpotlightPost01");
    expect(pages.join("\n")).not.toContain("Coauthor");
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
    expect(h.forum.requests).toHaveLength(2);
    // The same spotlight after the cache lapsed: no note, and the text goes on where the first page stopped.
    const g = h0([spot({ post: rawPostCard({ coauthors: people("Coauthor") }) })]);
    const g1 = await feed(g, { feed: "spotlight", max_tokens: 2000 });
    g.clock.advance(31 * 60_000);
    const g2 = await feed(g, { cursor: printedCursor(g1)!, max_tokens: 2000 });
    expect(g.forum.requests).toHaveLength(2);
    expect(g2).not.toContain("The spotlight changed");
    const lastOn1 = Math.max(...[...g1.matchAll(/\bCoauthor(\d+)\b/g)].map((m) => Number(m[1])));
    expect([...g2.matchAll(/\bCoauthor(\d+)\b/g)][0]![1]).toBe(String(lastOn1 + 1));
  });
});
