import { describe, it, expect } from "vitest";
import { CAVEAT } from "../../src/render/messages";
import { getFeedEffective } from "../../src/tools/get_feed";
import { expectClean } from "../support/harness";
import { feed, h0, ids, RD_SEL, WA_SEL } from "../support/feeds";
import { gqlTexts, printedCursor } from "../support/requests";
import { SAMPLE_AUTHOR, gqlEntry, rawCommentList, rawPostCard, rawPostRef, rawTagRef, rawUserRef } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";

const C1 = "2026-10-21T00:00:00.000Z";
// A fixture item carries every field its selection asks for: the three it does not fill are null.
const rdItem = (i: number) => ({ type: "postCommented", shortformCommented: null, tagDiscussed: null, tagRevised: null, postCommented: { ...rawPostCard({ _id: `rdSynth${String(i).padStart(10, "0")}`, title: `Synthetic discussion ${i}`, slug: `synthetic-discussion-${i}`, af: false, postedAt: "2026-10-20T00:00:00.000Z", lastCommentedAt: "2026-10-21T00:00:00.000Z", commentCount: 3 }), recentComments: [] } });
const rdPages = (): FixtureEntry[] => [
  gqlEntry({ root: "RecentDiscussionFeed", args: { cutoff: C1 }, offset: 20 }, { cutoff: "2026-10-20T00:00:00.000Z", endOffset: 40, results: Array.from({ length: 20 }, (_, i) => rdItem(20 + i)) }, "§14.3"),
  gqlEntry({ root: "RecentDiscussionFeed" }, { cutoff: C1, endOffset: 20, results: Array.from({ length: 20 }, (_, i) => rdItem(i)) }, "§14.3"),
];

describe("get_feed: the feed-cursor feeds", () => {
  it("Q19 Q50.5 recent_discussion: four item types, P6 P12 drops, last comment / no comments yet, the feed cursor never resends cutoff null", async () => {
    const h = h0();
    const out = await feed(h, { feed: "recent_discussion", limit: 3 });
    expect(out).toMatch(/• "AGI Ruin: A List of Lethalities" — .*\n  post_id uMQ3cqWDPHhjtiesc · .* · last comment 2026-10-22/);
    expect(out).toContain('▶ "paulfchristiano" (user_slug paulfchristiano) · 2026-10-22 10:30Z · karma 12 (5 votes) · AF karma 6 · comment_id rdPaulComment0001');
    expect(out).toContain('• wiki page "AI" (tag_slug ai) has new discussion comments — get_comments {tag: "ai"}');
    expect(out).toContain('• quick takes by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · last comment 2026-10-22');
    expect(out).toContain("▶ \"Eliezer Yudkowsky\" (user_slug eliezer_yudkowsky)");
    for (const s of ["PLANTED", "rdUnrevComment001", "rdTagRevision0001", "subscribeReminder", "meetupsPoke"]) expect(out).not.toContain(s);
    expect(out.split("\n").at(-1)).toMatch(/^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 4–6\)\.$/);
    const body = JSON.parse(h.forum.requests[0].body);
    expect(Array.isArray(body) && body.length === 1).toBe(true);
    expect(gqlTexts(h.forum)[0]).toContain(`f: RecentDiscussionFeed(limit: 3) ${RD_SEL}`);
    const next = await feed(h, { cursor: printedCursor(out)! });
    expect(ids(next)).toEqual(["R5g8YT25G9DXJJ48n", "zHhGa3iQBQcdSifFL"]);
    expect(next).toMatch(/post_id R5g8YT25G9DXJJ48n · .* · no comments yet/);
    expect(next).toContain('  latest comments not provided by the forum; get_comments {post: "zHhGa3iQBQcdSifFL"}');
    expect(next.endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain('f: RecentDiscussionFeed(limit: 3, cutoff: "2026-10-22T09:00:00.000Z", offset: 7)');
    expect(gqlTexts(h.forum).join("\n")).not.toMatch(/cutoff: null|RecentDiscussionFeed\([^)]*\baf: /);
    expectClean(h);
  });

  it("Q19 recent_discussion: a limit over 20 takes a second request; over 40 it stops at 40 with Stopped early (request cap)", async () => {
    const h = h0(rdPages());
    const out = await feed(h, { feed: "recent_discussion", limit: 45 });
    expect(out.match(/^• "Synthetic discussion \d+"/gm)).toHaveLength(40);
    expect(out.split("\n").at(-1)).toMatch(/^Stopped early \(request cap\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(gqlTexts(h.forum)[1]).toContain(`f: RecentDiscussionFeed(limit: 20, cutoff: "${C1}", offset: 20)`);
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("recent_discussion: a deadline after the first request ends with Stopped early (time limit); a failed second request is a Partial line", async () => {
    const slow = h0(rdPages()); slow.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const a = await feed(slow, { feed: "recent_discussion", limit: 30 });
    expect(a.match(/^• "Synthetic discussion \d+"/gm)).toHaveLength(20);
    expect(a.split("\n").at(-1)).toMatch(/^Stopped early \(time limit\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    // An empty 500 gets the transport's one transient retry, which is not charged to the call's cap of 2 (¶7), so the second
    // request fails with the forum_error the Partial line names after its retry: three fetches.
    const bad = h0(rdPages()); bad.forum.inject({ endpoint: "graphql", when: (b) => b.includes("offset: 20"), status: 500, body: "", times: 2 });
    const b = await bad.call("get_feed", { feed: "recent_discussion", limit: 30 });
    expect(b.isError).toBe(false);
    expect(b.text).toContain("Partial: recent_discussion items after 20 unavailable (forum_error: The forum returned an error while reading the recent_discussion feed (HTTP 500). Try again later).");
    expect(bad.forum.requests).toHaveLength(3);
  });

  it("P12 wiki_activity: new tags, edits and discussion comments; hidden pages dropped whole; af_only refused", async () => {
    const h = h0();
    const out = await feed(h, { feed: "wiki_activity" });
    expect(out).toContain('• new tag "Gradient Hacking" (tag_slug gradient-hacking)');
    expect(out).toContain('• wiki edit · "AI" (tag_slug ai) · revision_id wikiRevision00001 · 2026-10-22T07:00:00.000Z · by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · forum change count +120/−4 chars');
    expect(out).toContain('  on wiki page "AI" (tag_slug ai)');
    expect(out).toContain(CAVEAT["C-CHANGEMETRICS"]);
    for (const s of ["PLANTED", "wikiRevision00002", "adminTagNew000001"]) expect(out).not.toContain(s);
    expect(gqlTexts(h.forum)[0]).toContain(`f: AllTagsActivityFeed(limit: 10) ${WA_SEL}`);
    expect(out.endsWith("End of results.")).toBe(true);
    expect(await feed(h, { feed: "wiki_activity", af_only: true })).toBe("Error (bad_input): af_only: wiki items have no AF status. Remove af_only for wiki_activity.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The paging states, the filters, the notes and the edges the four tests above leave out.

/** A raw page of `recent_discussion` whose items carry every field the selection asks for: the ones their type does not fill are null. */
const rdPage = (results: Record<string, unknown>[], cutoff: string | null = null, endOffset = results.length) => ({
  cutoff, endOffset, results: results.map((r) => ({ postCommented: null, shortformCommented: null, tagDiscussed: null, tagRevised: null, ...r })),
});
const waPage = (results: Record<string, unknown>[]) => ({
  cutoff: null, endOffset: results.length, results: results.map((r) => ({ tagCreated: null, tagRevision: null, tagDiscussionComment: null, ...r })),
});
const AI = rawTagRef({ _id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", core: true });
/** The two pages of `rdPages()` and the empty one after them, where the feed ends (the fixture's own last page answers `cutoff: null`). */
const rdThreePages = (): FixtureEntry[] => [
  gqlEntry({ root: "RecentDiscussionFeed", args: { cutoff: "2026-10-20T00:00:00.000Z" }, offset: 40 }, { cutoff: null, endOffset: 40, results: [] }, "§14.3"),
  ...rdPages(),
];
const titles = (text: string) => [...text.matchAll(/^• "([^"]+)"/gm)].map((m) => m[1]);
const synthetic = (text: string) => [...text.matchAll(/^• "Synthetic discussion (\d+)"/gm)].map((m) => Number(m[1]));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("get_feed: recent_discussion and wiki_activity, paging and edges", () => {
  it("Q19 the feed cursor names the raw page and the item inside it: a page cut by max_tokens resumes after the last item shown, from the cached raw page", async () => {
    const h = h0(rdPages());
    const first = await feed(h, { feed: "recent_discussion", limit: 20, max_tokens: 2000 });
    const shown = synthetic(first);
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.length).toBeLessThan(20);
    expect(shown).toEqual(range(0, shown.length));
    expect(first.split("\n").at(-1)).toMatch(new RegExp(`^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \\(next: items ${shown.length + 1}–${shown.length + 20}\\)\\.$`));
    const second = await feed(h, { cursor: printedCursor(first)!, max_tokens: 2000 });
    const more = synthetic(second);
    expect(more[0]).toBe(shown.length);
    expect(second).toContain(`Position: items ${shown.length + 1}–`);
    // Nothing is repeated or skipped across the cut. The first raw page is read again from the cache, so only the second one is sent.
    expect([...shown, ...more]).toEqual(range(0, shown.length + more.length));
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[1]).toContain(`f: RecentDiscussionFeed(limit: 20, cutoff: "${C1}", offset: 20)`);
    expectClean(h);
  });

  it("Q19 a deadline's cursor goes on at the second raw page with the cutoff and offset the first one answered, and the feed ends at cutoff null", async () => {
    const slow = h0(rdThreePages());
    slow.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const a = await feed(slow, { feed: "recent_discussion", limit: 30 });
    const b = await feed(slow, { cursor: printedCursor(a)! });
    expect(synthetic(b)).toEqual(range(20, 40));
    expect(b).toContain("Position: items 21–40");
    expect(b.endsWith("End of results.")).toBe(true);
    expect(gqlTexts(slow.forum)[1]).toContain(`f: RecentDiscussionFeed(limit: 20, cutoff: "${C1}", offset: 20)`);
    expect(gqlTexts(slow.forum)[2]).toContain('f: RecentDiscussionFeed(limit: 20, cutoff: "2026-10-20T00:00:00.000Z", offset: 40)');
    expect(slow.forum.requests).toHaveLength(3);
    expectClean(slow);
  });

  it("¶7 a transient 500 on the second page is retried once although the call is at its cap of 2 (a retry is not charged); a second 500 is a Partial line, and the cursor reads that page again", async () => {
    // A retry of the same request is not charged to the per-call cap, so a transient failure on an optional page never reads as
    // this server's own cap stop; after its retry it is the forum_error the Partial line names.
    const h = h0(rdThreePages());
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("offset: 20"), status: 500, body: "", times: 2 });
    const first = await h.call("get_feed", { feed: "recent_discussion", limit: 30 });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("Partial: recent_discussion items after 20 unavailable (forum_error: The forum returned an error while reading the recent_discussion feed (HTTP 500). Try again later).");
    expect(first.text).not.toContain("Stopped early");
    expect(synthetic(first.text)).toEqual(range(0, 20));
    expect(h.forum.requests).toHaveLength(3);
    const second = await feed(h, { cursor: printedCursor(first.text)! });
    expect(synthetic(second)).toEqual(range(20, 40));
    expect(second).not.toContain("Partial:");
  });

  it("the first page failing is the call's error; a later page failing keeps the items and the cursor goes on at that page", async () => {
    const down = '{"errors":[{"message":"Internal server error"}]}';
    const gone = h0(rdThreePages());
    gone.forum.inject({ endpoint: "graphql", status: 500, body: down });
    const failed = await gone.call("get_feed", { feed: "recent_discussion", limit: 30 });
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe("Error (forum_error): The forum returned an error while reading the recent_discussion feed (HTTP 500). Try again later.");

    const h = h0(rdThreePages());
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("offset: 20"), status: 500, body: down });
    const partial = await feed(h, { feed: "recent_discussion", limit: 30 });
    expect(synthetic(partial)).toEqual(range(0, 20));
    expect(partial).toContain("This page has fewer than limit items; continue with the cursor.");
    expect(partial.split("\n").at(-1)).toMatch(/^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 21–50\)\.$/);
    const retried = await feed(h, { cursor: printedCursor(partial)! });
    expect(synthetic(retried)).toEqual(range(20, 40));
    expect(retried).not.toContain("Partial:");
  });

  it("a raw page answered with the cutoff and endOffset it was asked for ends the feed as unreachable: it is never asked for again", async () => {
    // The documented forum never repeats a page (§14.3: the cutoff strictly decreases); if it did, the identical request would be
    // served from the raw-response cache without a request, so the loop must end on its own rather than spin to the 40 s mark.
    const repeated = gqlEntry({ root: "RecentDiscussionFeed", args: { cutoff: C1 }, offset: 20 }, rdPage([{ type: "subscribeReminder" }], C1, 20), "§14.3");
    const h = h0([repeated, rdPages()[1]!]);
    const out = await feed(h, { feed: "recent_discussion", limit: 25 });
    expect(synthetic(out)).toEqual(range(0, 20));
    expect(out).not.toContain("Stopped early");
    expect(out.split("\n").at(-1)).toBe("End of reachable results: the forum repeated a page of this feed, so it can't be read further.");
    expect(h.forum.requests).toHaveLength(2);
    expect(h.logLines.join("\n")).toContain("get_feed a raw page repeated by the forum");
    expect(h.logLines.join("\n")).not.toContain(C1);
    // A cursor standing at that page returns too, from the cached answer, with nothing shown twice.
    const effective = getFeedEffective({ feed: "recent_discussion", af_only: false, sort: "new", limit: 25, max_tokens: 15000 }, "recent_discussion");
    const atPage = h.services.cursors.issue("get_feed", { feed: "recent_discussion", limit: 25 }, effective, { streams: [{ kind: "feed", shown: 20, cutoff: C1, endOffset: 20, index: 0 }], current: 0 });
    const next = await feed(h, { cursor: atPage });
    expect(next).not.toContain("Synthetic discussion");
    expect(next.split("\n").at(-1)).toBe("End of reachable results: the forum repeated a page of this feed, so it can't be read further.");
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("¶3.5 recent_discussion af_only keeps the AF post items and every wiki item, in the forum's order, and says so when it ends", async () => {
    const h = h0();
    const out = await feed(h, { feed: "recent_discussion", af_only: true, limit: 5 });
    expect(titles(out)).toEqual(["AGI Ruin: A List of Lethalities"]);
    expect(out).toContain('• wiki page "AI" (tag_slug ai) has new discussion comments');
    for (const s of ["quick takes by", "GLM-5.3", "A critical look at Lean4"]) expect(out).not.toContain(s);
    expect(out).toContain("Request: feed recent_discussion · af_only true · af_only does not apply to wiki pages · limit 5 ·");
    expect(out.endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("¶3.6 recent_discussion af_only with no AF item among the raw pages read: no items and a cursor never use empty-result wording", async () => {
    const h = h0(rdPages());
    const out = await feed(h, { feed: "recent_discussion", af_only: true, limit: 3 });
    expect(out).toContain("None found among the first 40 checked; continue with the cursor.");
    expect(out).not.toContain("nothing in its window");
    expect(out).not.toContain("Position:");
    expect(out.split("\n").at(-1)).toMatch(/^Stopped early \(request cap\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  it("¶3.6 recent_discussion af_only that shortens a page says so", async () => {
    const af = rawPostCard({ _id: "rdAfPost00000001", title: "An AF discussion", slug: "an-af-discussion", af: true, lastCommentedAt: "2026-10-21T00:00:00.000Z", postedAt: "2026-10-20T00:00:00.000Z", commentCount: 2 });
    const page = [rdItem(0), { type: "postCommented", shortformCommented: null, tagDiscussed: null, tagRevised: null, postCommented: { ...af, recentComments: [] } }, rdItem(1)];
    const h = h0([
      gqlEntry({ root: "RecentDiscussionFeed", args: { cutoff: C1 }, offset: 3 }, { cutoff: "2026-10-20T00:00:00.000Z", endOffset: 5, results: [rdItem(2), rdItem(3)] }, "§14.3"),
      gqlEntry({ root: "RecentDiscussionFeed" }, { cutoff: C1, endOffset: 3, results: page }, "§14.3"),
    ]);
    const out = await feed(h, { feed: "recent_discussion", af_only: true, limit: 5 });
    expect(titles(out)).toEqual(["An AF discussion"]);
    expect(out).toContain("af_only kept 1 of the 5 items checked; continue with the cursor.");
    expect(out).not.toContain("This page has fewer than limit items");
    expect(out.split("\n").at(-1)).toMatch(/^Stopped early \(request cap\); call get_feed with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expectClean(h);
  });

  it("P12 P7 D11 recent_discussion: a wiki edit has no editor and brings C-CHANGEMETRICS; hidden pages, unknown types and an anonymous owner are handled", async () => {
    const hidden = rawTagRef({ _id: "adminOnlyTag00001", name: "PLANTED-P12-20", slug: "admin-only-tag", adminOnly: true });
    const box = rawPostRef({ _id: "anonQuickBox00001", title: "Hidden's Shortform", slug: "hidden-s-shortform", af: false, shortform: true, hideAuthor: true });
    const host = rawUserRef({ _id: "meetupHost0000001", slug: "meetup-host", displayName: "Meetup Host" });
    const event = rawPostCard({ _id: "rdEventPost00001", title: "A meetup", slug: "a-meetup", af: false, isEvent: true, postedAt: "2026-10-20T00:00:00.000Z", lastCommentedAt: "2026-10-20T00:00:00.000Z", commentCount: 0, userId: host._id, user: host });
    const h = h0([gqlEntry({ root: "RecentDiscussionFeed" }, rdPage([
      { type: "tagRevised", tagRevised: { _id: "rdTagRevision0002", documentId: AI._id, editedAt: "2026-10-22T09:30:00.000Z", changeMetrics: { added: 150, removed: 0 }, tag: AI } },
      { type: "tagDiscussed", tagDiscussed: hidden },
      { type: "shortformCommented", shortformCommented: { ...box, lastCommentedAt: "2026-10-22T08:00:00.000Z", user: rawUserRef(), recentComments: [] } },
      { type: "postCommented", postCommented: { ...event, recentComments: [] } },
      { type: "somethingTheForumAddedLater" },
    ]), "§14.3")]);
    const out = await feed(h, { feed: "recent_discussion" });
    expect(out).toContain('• wiki edit · "AI" (tag_slug ai) · revision_id rdTagRevision0002 · 2026-10-22T09:30:00.000Z · forum change count +150/−0 chars');
    expect(out).not.toContain(" · by ");
    expect(out).toContain(CAVEAT["C-CHANGEMETRICS"]);
    expect(out).toContain("• quick takes by author not publicly visible · last comment 2026-10-22");
    expect(out).toContain('  latest comments not provided by the forum; get_comments {post: "anonQuickBox00001"}');
    expect(out).toMatch(/• "A meetup" — .*\n  post_id rdEventPost00001 · .* · event · no comments yet/);
    for (const s of ["PLANTED", "admin-only-tag", SAMPLE_AUTHOR.slug, "somethingTheForumAddedLater"]) expect(out).not.toContain(s);
    expectClean(h);
  });

  it("¶3.8.1 row 5 recent_discussion: a post whose counted comments are 0 reads `no comments yet` even with a later lastCommentedAt, and points to no comments", async () => {
    const zero = rawPostCard({ _id: "rdZeroCount000001", title: "A counter at zero", slug: "a-counter-at-zero", af: false, postedAt: "2026-10-20T00:00:00.000Z", lastCommentedAt: "2026-10-21T00:00:00.000Z", commentCount: 0 });
    const h = h0([gqlEntry({ root: "RecentDiscussionFeed" }, rdPage([{ type: "postCommented", postCommented: { ...zero, recentComments: [] } }]), "§14.3")]);
    const out = await feed(h, { feed: "recent_discussion" });
    expect(out).toMatch(/• "A counter at zero" — .*\n  post_id rdZeroCount000001 · .* · no comments yet$/m);
    expect(out).not.toContain("last comment");
    expect(out).not.toContain("latest comments not provided by the forum");
    expectClean(h);
  });

  it("P12 P14 the rows dropped are only counted in the log of either feed, never named", async () => {
    const h = h0();
    await feed(h, { feed: "recent_discussion", limit: 3 });
    await feed(h, { feed: "wiki_activity" });
    const dropped = h.logLines.filter((line) => line.includes("get_feed rows dropped"));
    expect(dropped.map((line) => line.replace(/^.*get_feed/, "get_feed"))).toEqual([
      "get_feed rows dropped by the re-checks dropped=4", "get_feed rows dropped by the re-checks dropped=2",
    ]);
    expect(h.logLines.join("\n")).not.toMatch(/PLANTED|rdTagRevision|rdUnrev|wikiRevision00002|adminTagNew|subscribeReminder|meetupsPoke/);
  });

  it("wiki_activity: limit counts items, the cursor goes on inside the cached raw page, and the feed ends at cutoff null", async () => {
    const h = h0();
    const first = await feed(h, { feed: "wiki_activity", limit: 2 });
    expect(first).toContain('• new tag "Gradient Hacking" (tag_slug gradient-hacking)');
    expect(first).toContain("• wiki edit · ");
    expect(first).not.toContain("waDiscussCmnt0001");
    expect(first.split("\n").at(-1)).toMatch(/^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 3–4\)\.$/);
    expect(gqlTexts(h.forum)[0]).toContain("f: AllTagsActivityFeed(limit: 2) ");
    const second = await feed(h, { cursor: printedCursor(first)! });
    expect(second).toContain("comment_id waDiscussCmnt0001");
    expect(second).not.toContain("Gradient Hacking");
    expect(second).toContain("Position: items 3–3");
    expect(second.endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(1);
    expectClean(h);
  });

  it("wiki_activity: a removed-only edit, a wiki-only new tag, a deleted editor and a comment on a hidden page", async () => {
    const wikiOnly = rawTagRef({ _id: "wikiOnlyNewTag001", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true });
    const hidden = rawTagRef({ _id: "adminOnlyTag00001", name: "PLANTED-P12-21", slug: "admin-only-tag", adminOnly: true });
    const onHidden = rawCommentList({ _id: "waHiddenCmnt0001", postId: null, tagId: hidden._id, post: null, tag: hidden, af: false, contents: { markdown: "PLANTED-P12-22", wordCount: 1 } });
    const h = h0([gqlEntry({ root: "AllTagsActivityFeed" }, waPage([
      { type: "tagCreated", tagCreated: wikiOnly },
      { type: "tagRevision", tagRevision: { _id: "wikiRevision00003", documentId: AI._id, editedAt: "2026-10-22T04:00:00.000Z", changeMetrics: { removed: 30 }, user: null, tag: AI } },
      { type: "tagDiscussionComment", tagDiscussionComment: onHidden },
    ]), "§14.3")]);
    const out = await feed(h, { feed: "wiki_activity" });
    expect(out).toContain('• new tag "Bayes\' rule" (tag_slug bayes-rule) · wiki-only page');
    expect(out).toContain('• wiki edit · "AI" (tag_slug ai) · revision_id wikiRevision00003 · 2026-10-22T04:00:00.000Z · by account not publicly visible · forum change count +0/−30 chars');
    expect(out).not.toContain("PLANTED");
    expectClean(h);
  });

  it("¶3.7 rule 3 an item larger than the page is sliced and the cursor resumes inside it, then goes on with the next item", async () => {
    const long = rawCommentList({
      _id: "rdLongComment0001", af: true, postedAt: "2026-10-22T10:00:00.000Z",
      contents: { markdown: Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" "), wordCount: 4000 },
    });
    const page = [
      { type: "postCommented", postCommented: { ...rawPostCard({ lastCommentedAt: "2026-10-22T10:00:00.000Z" }), recentComments: [long] } },
      { type: "tagDiscussed", tagDiscussed: AI },
    ];
    const h = h0([gqlEntry({ root: "RecentDiscussionFeed" }, rdPage(page), "§14.3")]);
    const first = await feed(h, { feed: "recent_discussion", limit: 2, max_tokens: 2000 });
    expect(first).toMatch(/\[… continues: about [\d,]+ more words; use the cursor\]/);
    expect(first).not.toContain("has new discussion comments");
    expect(first.split("\n").at(-1)).toMatch(/^More available: call get_feed with cursor "c_[A-Za-z0-9_-]{22}" \(next: items 1–2\)\.$/);
    const second = await feed(h, { cursor: printedCursor(first)!, max_tokens: 2000 });
    // The second page starts at the word after the last one the first page showed, and no item is lost.
    const words = (text: string): number[] => [...text.matchAll(/\bword(\d+)\b/g)].map((m) => Number(m[1]));
    expect(words(second)[0]).toBe(words(first).at(-1)! + 1);
    expect(second).toContain('• wiki page "AI" (tag_slug ai) has new discussion comments');
    expect(second.endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(1);
    expectClean(h);
  });

  it("a cutoff feed with nothing in it uses the feed-window template and ends", async () => {
    const h = h0([gqlEntry({ root: "RecentDiscussionFeed" }, rdPage([]), "§14.3"), gqlEntry({ root: "AllTagsActivityFeed" }, waPage([]), "§14.3")]);
    const rd = await feed(h, { feed: "recent_discussion" });
    expect(rd).toContain("recent_discussion: nothing in its window (recently commented posts, quick takes and wiki pages).");
    expect(rd.split("\n").at(-1)).toBe("End of results.");
    expect(rd).not.toContain("Position:");
    const wa = await feed(h, { feed: "wiki_activity" });
    expect(wa).toContain("wiki_activity: nothing in its window (recent new tags, wiki edits and wiki discussion comments).");
    expectClean(h);
  });

  it("¶3.6 a repeated cursor with another limit or feed is bad_input; the same values continue", async () => {
    const h = h0();
    const cursor = printedCursor(await feed(h, { feed: "recent_discussion", limit: 3 }))!;
    expect(await feed(h, { cursor, limit: 5 })).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(limit: cursor has 3, call has 5\)/);
    expect(await feed(h, { cursor, feed: "wiki_activity" })).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(feed: /);
    expect(ids(await feed(h, { cursor, feed: "recent_discussion", limit: 3 }))).toEqual(["R5g8YT25G9DXJJ48n", "zHhGa3iQBQcdSifFL"]);
  });
});
