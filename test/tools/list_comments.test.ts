import { describe, expect, it } from "vitest";
import { allRecentCommentsOp, topShortformOp } from "../../src/forum/templates/list_comments";
import { depthGuarded, listCommentsEffective, tool } from "../../src/tools/list_comments";
import { SHORT_PAGE_NOTE } from "../../src/render/messages";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { A_COMMENTER, ANON_AUTHOR, SAMPLE_PERSON, gqlEntry, rawCommentLight, rawCommentList, rawPostRef, samplePersonEntry } from "../support/builders";

const EY = "nmk3nLpQE89dMRzzN";
/** The made-up person whose comment list the hand fixtures hold. */
const SAMPLE_COMMENTER = { _id: "sampleCommenter01", slug: "sample-commenter", displayName: "Sample Commenter" };
const MARCH = { after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z" };
const FAMILIES = ["users", "posts", "comments", "lists", "joins"] as const;
const HIDDEN_KARMA = "Comments whose karma is not publicly visible are left out of karma-ordered and karma-filtered lists.";

describe("list_comments templates", () => {
  it("Q73 allRecentComments carries every term as a literal, never a view term or a limit inside the view", () => {
    const o = allRecentCommentsOp("n", { userId: EY, sortBy: "new", ...MARCH, minimumKarma: 5 }, { limit: 40 }, "list");
    expect(o.text).toBe('n: comments(selector: {allRecentComments: {userId: "nmk3nLpQE89dMRzzN", sortBy: "new", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z", minimumKarma: 5}}, limit: 40) { results { ...COMMENT_LIST } }');
    expect(o.template).toBe("list_comments_allRecent");
  });

  it("site-wide top pages by offset, without enableTotal", () => {
    expect(allRecentCommentsOp("t", { sortBy: "top", ...MARCH }, { limit: 40, offset: 40 }, "list").text)
      .toBe('t: comments(selector: {allRecentComments: {sortBy: "top", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 40, offset: 40) { results { ...COMMENT_LIST } }');
  });

  it("a person's light scan and the af_only scan select COMMENT_LIGHT", () => {
    expect(allRecentCommentsOp("pl", { userId: EY, sortBy: "new" }, { limit: 2000, enableTotal: true }, "light").text)
      .toBe('pl: comments(selector: {allRecentComments: {userId: "nmk3nLpQE89dMRzzN", sortBy: "new"}}, limit: 2000, enableTotal: true) { results { ...COMMENT_LIGHT } totalCount }');
    expect(allRecentCommentsOp("af", { sortBy: "new" }, { limit: 500 }, "light").text)
      .toBe('af: comments(selector: {allRecentComments: {sortBy: "new"}}, limit: 500) { results { ...COMMENT_LIGHT } }');
  });

  it("Q74 quick takes use topShortform with no sortBy; enableTotal only with a userId", () => {
    const q = topShortformOp("q", { userId: EY, ...MARCH }, { limit: 2000, enableTotal: true });
    expect(q.text).toBe('q: comments(selector: {topShortform: {userId: "nmk3nLpQE89dMRzzN", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 2000, enableTotal: true) { results { ...COMMENT_LIGHT } totalCount }');
    expect(q.template).toBe("list_comments_quick_takes");
    expect(topShortformOp("q", MARCH, { limit: 2000 }).text)
      .toBe('q: comments(selector: {topShortform: {after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 2000) { results { ...COMMENT_LIGHT } }');
    expect(q.text).not.toContain("sortBy");
  });
});

describe("list_comments definition", () => {
  it("listCommentsEffective resolves ids and dates and applies defaults", () => {
    const p = tool.schema.parse({ user: "eliezer_yudkowsky" }) as Parameters<typeof listCommentsEffective>[0];
    expect(listCommentsEffective(p, { userId: EY })).toEqual({
      user: EY, date_from: undefined, date_to: undefined, af_only: false, quick_takes_only: false,
      min_karma: undefined, sort: "new", limit: 10,
    });
  });

  it("depth guard: only an unnarrowed site-wide new/old list; af_only alone does not narrow", () => {
    expect(depthGuarded({ sort: "new", quick_takes_only: false })).toBe(true);
    expect(depthGuarded({ sort: "old", quick_takes_only: false })).toBe(true);
    expect(depthGuarded({ sort: "new", quick_takes_only: false, user: "x" })).toBe(false);
    expect(depthGuarded({ sort: "new", quick_takes_only: false, date_from: "2024" })).toBe(false);
    expect(depthGuarded({ sort: "new", quick_takes_only: false, min_karma: 1 })).toBe(false);
    expect(depthGuarded({ sort: "top", quick_takes_only: false })).toBe(false);
  });
});

describe("list_comments: a person's comments (example 5's hand-off target)", () => {
  async function commenterPage() {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("list_comments", { user: SAMPLE_COMMENTER.slug });
    return { h, out };
  }

  it("Q73 one resolve and one allRecentComments page sorted new; never profileComments", async () => {
    const { h, out } = await commenterPage();
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    const texts = gqlTexts(h.forum);
    expect(texts[1]).toContain(`allRecentComments: {userId: "${SAMPLE_COMMENTER._id}", sortBy: "new"}}, limit: 20, enableTotal: true`);
    expect(texts.join("\n")).not.toContain("profileComments");
    expect(out.text.split("\n")[0]).toBe(`list_comments — comments by "${SAMPLE_COMMENTER.displayName}"`);
    expect(out.text).toContain("sort new (default)");
    expect(out.text).toContain("limit 10 (default)");
    expectClean(h);
  });

  it("P1 places by tagId first: post, wiki page, quick take, or a hidden post or page with no id", async () => {
    const { out } = await commenterPage();
    expect(out.text).toContain('on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)');
    expect(out.text).toContain('on wiki page "AI" (tag_slug ai)');
    expect(out.text).toContain("quick take");
    expect(out.text).not.toContain(`${SAMPLE_COMMENTER.displayName}'s Shortform`);
    expect(out.text).toContain("on a wiki page that is not publicly visible");
    expect(out.text).toContain("on a post that is not publicly visible");
    expect(out.text).not.toContain("HiddenWikiPage001");
    expect(out.text).not.toContain("HiddenDraftPost01");
  });

  it("P5 P6 parent forms: named, deleted placeholder, anonymous, and hidden parents without an id", async () => {
    const { out } = await commenterPage();
    expect(out.text).toContain('reply to "paulfchristiano" (user_slug paulfchristiano, comment_id HRDoDnHv8bvoW7oPZ, AF)');
    expect(out.text).toContain("reply to a comment placeholder (comment_id PlaceholderPar001)");
    expect(out.text).toContain("reply to a comment whose author is not publicly visible (comment_id AnonymousParent01, LW only)");
    expect(out.text).toContain("parent comment not publicly visible");
    expect(out.text).not.toContain("PrivDeletedPar001");
  });

  it("P18 hidden karma prints karma not publicly visible", async () => {
    const { out } = await commenterPage();
    expect(out.text).toContain("comment_id LcHiddenKarma0001");
    expect(out.text).toContain("karma not publicly visible");
  });

  it("P7 a person's own anonymous comment is left out of their list", async () => {
    // A made-up person, so that the comment is their own and only the anonymity rule leaves it out.
    const own = (_id: string, o: Partial<ReturnType<typeof rawCommentList>> = {}) =>
      rawCommentList({ _id, userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON, postedAt: "2026-10-01T00:00:00.000Z", ...o });
    const h = createHarness({ families: FAMILIES, extra: [samplePersonEntry(), gqlEntry(
      { root: "comments", view: "allRecentComments", terms: { userId: SAMPLE_PERSON._id, sortBy: "new" } },
      { results: [own("sampleOwnCmnt0001"), own("sampleAnonCmnt001", { hideAuthor: true, postedAt: "2026-09-30T00:00:00.000Z" })], totalCount: 2 }, "§9.4",
    )] });
    const out = await h.call("list_comments", { user: SAMPLE_PERSON.slug });
    expect(out.text).toContain("comment_id sampleOwnCmnt0001");
    expect(out.text).not.toContain("sampleAnonCmnt001");
    expectClean(h);
  });

  it("Q26 keyset continuation: before boundary + 1 ms, the boundary id skipped, then End of results", async () => {
    const { h, out } = await commenterPage();
    expect(out.text).toContain("Position: items 1–10");
    expect(out.text).not.toContain("LcReplyToUnrevw01");
    const cursor = printedCursor(out.text)!;
    expect(out.text).toContain(`More available: call list_comments with cursor "${cursor}" (next: items 11–20).`);
    const next = await h.call("list_comments", { cursor });
    expect(gqlTexts(h.forum).at(-1)).toContain('before: "2026-10-09T09:00:00.001Z"');
    expect(next.text).toContain("comment_id LcReplyToUnrevw01");
    expect(next.text).not.toContain("comment_id LcHiddenKarma0001");
    expect(next.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("¶3.6 a cursor used a minute later with the same date period repeated continues (the clamp of date_to moved)", async () => {
    const h = createHarness({ families: FAMILIES });
    const args = { user: SAMPLE_COMMENTER.slug, date_from: "2026", date_to: "2026" };
    const cursor = printedCursor((await h.call("list_comments", args)).text)!;
    h.clock.advance(60_000);
    const p2 = await h.call("list_comments", { ...args, cursor });
    expect(p2.isError).toBe(false);
    expect(p2.text).toContain("comment_id LcReplyToUnrevw01");
  });

  it("a repeated identical call is answered from the caches", async () => {
    const { h } = await commenterPage();
    await h.call("list_comments", { user: SAMPLE_COMMENTER.slug });
    expect(h.forum.requests).toHaveLength(2);
  });
});

describe("list_comments: site-wide windows", () => {
  it("¶3.4 site-wide top and quick takes need both dates at most 31 days apart; nothing is sent", async () => {
    const h = createHarness({ families: FAMILIES });
    for (const args of [
      { sort: "top" }, { quick_takes_only: true },
      { sort: "top", date_from: "2024-01-15", date_to: "2024-02-15" },
    ]) {
      const out = await h.call("list_comments", args);
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/^Error \(bad_input\): /);
      expect(out.text).toContain('date_from "2024-03-01", date_to "2024-03-31"');
    }
    expect(h.forum.requests).toHaveLength(0);
  });

  it("L3 site-wide top pages by offset in the forum's order (no local re-sort) with C-DRIFT", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => rawCommentList({
      _id: `TopMarch${String(i).padStart(9, "0")}`, postedAt: `2024-03-${String(10 + (i % 9)).padStart(2, "0")}T00:00:00.000Z`,
      baseScore: i === 3 ? 500 : 100 - i, post: rawPostRef({ _id: "uMQ3cqWDPHhjtiesc" }), postId: "uMQ3cqWDPHhjtiesc",
    }));
    const page = gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "top", ...MARCH }, limit: 20 }, { results: rows }, "§9.4");
    const h = createHarness({ families: FAMILIES, extra: [page] });
    const out = await h.call("list_comments", { sort: "top", date_from: "2024-03-01", date_to: "2024-03-31" });
    expect(gqlTexts(h.forum)[0]).toContain('allRecentComments: {sortBy: "top", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 20)');
    expect(gqlTexts(h.forum)[0]).not.toContain("enableTotal");
    expect(out.text.indexOf("TopMarch000000002")).toBeLessThan(out.text.indexOf("TopMarch000000003"));
    expect(out.text).toContain("Rankings can shift between pages as votes arrive.");
    expect(out.text).toContain(HIDDEN_KARMA);
    expectClean(h);
  });
});

describe("list_comments: light sets", () => {
  it("Q74 quick takes by a person: a topShortform light set, ranked locally, only the page hydrated", async () => {
    const light = [
      rawCommentLight({ _id: "QuickTakeLow00001", postedAt: "2026-01-03T00:00:00.000Z", baseScore: 4, userId: EY }),
      rawCommentLight({ _id: "QuickTakeHigh0001", postedAt: "2026-01-01T00:00:00.000Z", baseScore: 40, userId: EY }),
      rawCommentLight({ _id: "QuickTakeHidden01", postedAt: "2026-01-02T00:00:00.000Z", baseScore: null, hideKarma: true, userId: EY }),
    ];
    const container = rawPostRef({ _id: "quickTakesBox0001", title: "Eliezer Yudkowsky's Shortform", shortform: true });
    const full = (id: string, score: number) => rawCommentList({ _id: id, userId: EY, baseScore: score, shortform: true, postId: container._id, post: container, parentCommentId: null, topLevelCommentId: null });
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "topShortform", terms: { userId: EY }, limit: 2000 }, { results: light, totalCount: 3 }, "§8.11"),
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: ["QuickTakeHigh0001", "QuickTakeLow00001"] } },
        { results: [full("QuickTakeLow00001", 4), full("QuickTakeHigh0001", 40)] }, "§8.1"),
    ] });
    const out = await h.call("list_comments", { user: "eliezer_yudkowsky", quick_takes_only: true, sort: "top" });
    const texts = gqlTexts(h.forum);
    expect(h.forum.requests).toHaveLength(3);
    expect(texts[1]).toContain('topShortform: {userId: "nmk3nLpQE89dMRzzN"}}, limit: 2000, enableTotal: true');
    expect(texts[1]).not.toContain("sortBy");
    expect(texts[2]).toContain('commentIds: ["QuickTakeHigh0001", "QuickTakeLow00001"]');
    expect(out.text.indexOf("QuickTakeHigh0001")).toBeLessThan(out.text.indexOf("QuickTakeLow00001"));
    expect(out.text).not.toContain("QuickTakeHidden01");
    expect(out.text).toContain(HIDDEN_KARMA);
    expectClean(h);
  });

  it("too_broad: more than 2,000 quick takes, or 2,000 comments of a person by top", async () => {
    const many = Array.from({ length: 2000 }, (_, i) => rawCommentLight({ _id: `Light${String(i).padStart(12, "0")}`, userId: EY }));
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "topShortform", terms: { userId: EY }, limit: 2000 }, { results: many, totalCount: 2400 }, "§8.1"),
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "new" }, limit: 2000 }, { results: many, totalCount: 7757 }, "§9.7"),
    ] });
    const quick = await h.call("list_comments", { user: "eliezer_yudkowsky", quick_takes_only: true });
    expect(quick.text).toBe("Error (too_broad): More than 2,000 quick takes match. Narrow with date_from/date_to.");
    const top = await h.call("list_comments", { user: "eliezer_yudkowsky", sort: "top" });
    expect(top.text).toBe("Error (too_broad): More than 2,000 comments match. Narrow with date_from/date_to.");
    expect(top.text).not.toContain("7,757");
  });

  it("P18 Q73 a person's top: hidden-karma rows left out, min_karma re-checked locally", async () => {
    const light = [
      rawCommentLight({ _id: "PersonTopA0000001", baseScore: 50, userId: EY, postedAt: "2025-01-01T00:00:00.000Z" }),
      rawCommentLight({ _id: "PersonTopB0000001", baseScore: 2, userId: EY, postedAt: "2025-01-02T00:00:00.000Z" }),
      rawCommentLight({ _id: "PersonTopHidden01", baseScore: null, hideKarma: true, userId: EY, postedAt: "2025-01-03T00:00:00.000Z" }),
    ];
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "new" }, limit: 2000 }, { results: light, totalCount: 3 }, "§9.4"),
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: ["PersonTopA0000001"] } }, { results: [rawCommentList({ _id: "PersonTopA0000001", userId: EY, baseScore: 50 })] }, "§8.1"),
    ] });
    const out = await h.call("list_comments", { user: "eliezer_yudkowsky", sort: "top", min_karma: 10 });
    expect(out.text).toContain("comment_id PersonTopA0000001");
    expect(out.text).not.toContain("PersonTopB0000001");
    expect(out.text).not.toContain("PersonTopHidden01");
    expect(out.text).toContain(HIDDEN_KARMA);
  });
});

describe("list_comments: af_only and the caps", () => {
  /** A made-up person's own comments: a public one, and pages of 20 rejected ones (`Rej<n>…`). */
  const ownComment = (_id: string) => rawCommentList({ _id, userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON });
  const ownRejected = (n: number) => Array.from({ length: 20 }, (_, i) =>
    rawCommentList({ _id: `Rej${n}${String(i).padStart(13, "0")}`, rejected: true, userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON }));

  const scanRows = (page: number, af: number[]) => Array.from({ length: 500 }, (_, i) => rawCommentLight({
    _id: `Scan${page}${String(i).padStart(12, "0")}`, af: af.includes(i),
    postedAt: new Date(Date.parse("2026-10-20T00:00:00.000Z") - (page * 500 + i) * 60_000).toISOString(),
  }));

  it("af_only scans 500 light rows at a time, at most 3 pages, then hydrates the kept ids", async () => {
    const pages = [scanRows(0, [1]), scanRows(1, [2]), scanRows(2, [3])];
    // The af_only scan: raw offsets 0, 500, 1000 inside the one window; specific entries first, the offset-less page 0 last.
    const extra = [2, 1, 0].map((i) => gqlEntry(
      { root: "comments", view: "allRecentComments", terms: { sortBy: "new" }, limit: 500, ...(i > 0 ? { offset: i * 500 } : {}) },
      { results: pages[i] }, "§16"));
    const kept = [pages[0][1], pages[1][2], pages[2][3]].map((r) => r._id);
    extra.unshift(gqlEntry({ root: "comments", view: "default", terms: { commentIds: kept } },
      { results: kept.map((id) => rawCommentList({ _id: id, af: true, afBaseScore: 3 })) }, "§8.1"));
    const h = createHarness({ families: FAMILIES, extra });
    const out = await h.call("list_comments", { af_only: true });
    expect(h.forum.requests).toHaveLength(4);
    expect(gqlTexts(h.forum).slice(0, 3).map((t) => /offset: (\d+)/.exec(t)?.[1] ?? "0")).toEqual(["0", "500", "1000"]);
    expect(out.text).toContain("af_only kept 3 of the 1,500 comments checked; continue with the cursor");
    for (const id of kept) expect(out.text).toContain(`comment_id ${id}`);
    expect(printedCursor(out.text)).toMatch(/^c_/);
    expectClean(h);
  });

  it("a budget-cut af_only page translates its index through the rows the hydrate dropped: each kept comment is shown exactly once, in order", async () => {
    // Four AF light rows among twenty; the first is rejected once hydrated. Each shown body is about 1,500 tokens, so a page of
    // max_tokens 2000 holds one comment: the cursor after the first printed row must continue at the next kept light row.
    // A made-up person's own comments, the rejected one included.
    const light = Array.from({ length: 20 }, (_, i) => rawCommentLight({ _id: `Cut${String(i).padStart(14, "0")}`, af: i < 4, userId: SAMPLE_PERSON._id, postedAt: new Date(Date.parse("2026-10-20T00:00:00.000Z") - i * 60_000).toISOString() }));
    const kept = light.slice(0, 4).map((r) => r._id);
    const markdown = Array.from({ length: 1200 }, (_, j) => `word${j % 9}`).join(" ");
    const full = (id: string) => rawCommentList({ _id: id, af: true, afBaseScore: 3, userId: SAMPLE_PERSON._id, user: SAMPLE_PERSON, contents: { markdown, wordCount: 1200 },
      ...(id === kept[0] && { rejected: true }) });
    const h = createHarness({ families: FAMILIES, extra: [
      samplePersonEntry(),
      ...[0, 1, 2, 3].map((from) => gqlEntry({ root: "comments", view: "default", terms: { commentIds: kept.slice(from) } }, { results: kept.slice(from).map(full) }, "§8.1")),
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: SAMPLE_PERSON._id, sortBy: "new" }, limit: 500, enableTotal: true }, { results: light, totalCount: 20 }, "§16"),
    ] });
    const pages = [await h.call("list_comments", { user: SAMPLE_PERSON.slug, af_only: true, max_tokens: 2000 })];
    for (let c = printedCursor(pages[0].text); c !== undefined && pages.length < 6; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("list_comments", { cursor: c }));
    expect(pages.every((p) => !p.isError)).toBe(true);
    const shown = pages.flatMap((p) => p.text.split("\n").filter((l) => l.startsWith("▶ ")).map((l) => /comment_id (Cut\d{14})/.exec(l)![1]));
    expect(shown).toEqual(kept.slice(1));
    expect(pages[0].text.split("\n").filter((l) => l.startsWith("▶ "))).toHaveLength(1);
    expect(pages.map((p) => p.text).join("\n")).not.toContain(kept[0]);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("Stopped early (time limit): no optional scan starts after 40 s; zero items use the scan-page wording", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "new" }, limit: 500 }, { results: scanRows(0, []) }, "§16"),
    ] });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const out = await h.call("list_comments", { af_only: true });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(1);
    expect(out.text).toContain("None found among the first 500 checked; continue with the cursor.");
    expect(out.text).toMatch(/Stopped early \(time limit\); call list_comments with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  it("Error (timeout): an af_only scan that keeps rows but ends past 40 s cannot start the mandatory hydrate (¶2.2 step 5)", async () => {
    // Characterization: the 40 s mark refuses every new request, mandatory ones too, and light ids that were never
    // hydrated are not printable (D1). A later change that exempts mandatory requests must be a conscious decision.
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "new" }, limit: 500 }, { results: scanRows(0, [1]) }, "§16"),
    ] });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    const out = await h.call("list_comments", { af_only: true });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("Error (timeout): The forum did not answer in time while running list_comments (about 50 s per call). Large discussions can be slow; try again, or narrow the request.");
    expect(h.forum.requests).toHaveLength(1);
  });

  it("¶3.6 a page that is short and also stopped prints the Stopped early footer alone, never the neutral short-page note too", async () => {
    const page0 = [ownComment("KeptAmongHidden01"), ...ownRejected(0).slice(1)];
    const h = createHarness({ families: FAMILIES, extra: [samplePersonEntry(), ...[1, 2, 3, 0].map((n) =>
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: SAMPLE_PERSON._id, sortBy: "new" }, offset: n * 20 || undefined, limit: 20 },
        { results: n === 0 ? page0 : ownRejected(n), totalCount: 500 }, "§4.4"))] });
    const out = await h.call("list_comments", { user: SAMPLE_PERSON.slug });
    expect(h.forum.requests).toHaveLength(5);
    expect(out.text).toContain("comment_id KeptAmongHidden01");
    expect(out.text).not.toContain(SHORT_PAGE_NOTE);
    expect(out.text).toMatch(/Stopped early \(request cap\); call list_comments with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  it("Stopped early (request cap): refills stop at 5 requests when raw pages show no row", async () => {
    const h = createHarness({ families: FAMILIES, extra: [samplePersonEntry(), ...[1, 2, 3, 0].map((n) =>
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: SAMPLE_PERSON._id, sortBy: "new" }, offset: n * 20 || undefined, limit: 20 },
        { results: ownRejected(n), totalCount: 500 }, "§4.4"))] });
    const out = await h.call("list_comments", { user: SAMPLE_PERSON.slug });
    expect(h.forum.requests).toHaveLength(5);
    expect(out.text).toContain("None found among the first 80 checked; continue with the cursor.");
    expect(out.text).toMatch(/Stopped early \(request cap\); call list_comments with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    expect(out.text).not.toMatch(/Rej\d/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The wiring: windows, light sets and filters, continuations and the hand-off.

const containerPost = () => rawPostRef({ _id: "quickTakesBox0001", title: "Eliezer Yudkowsky's Shortform", shortform: true });
/** A top-level quick take as the by-id hydrate returns it. */
const quickTake = (id: string, o: Partial<ReturnType<typeof rawCommentList>> = {}) => rawCommentList({
  _id: id, shortform: true, postId: containerPost()._id, post: containerPost(), parentCommentId: null, topLevelCommentId: null, ...o,
});

describe("list_comments: windows, light sets and filters", () => {
  it("the window error names the case that needs it, quick takes or site-wide top", async () => {
    const h = createHarness({ families: FAMILIES });
    const top = await h.call("list_comments", { sort: "top" });
    expect(top.text).toContain("list_comments with sort top and no user needs both date_from and date_to, at most 31 days apart");
    const quick = await h.call("list_comments", { quick_takes_only: true, sort: "top" });
    expect(quick.text).toContain("list_comments with quick_takes_only and no user needs both date_from and date_to");
    const long = await h.call("list_comments", { quick_takes_only: true, date_from: "2024-01-01", date_to: "2024-03-31" });
    expect(long.text).toContain("the window is 91 days; list_comments with quick_takes_only and no user allows at most 31");
    expect(h.forum.requests).toHaveLength(0);
  });

  it("Q74 site-wide quick takes: no enableTotal, newest first, no resolve; 2,000 rows is too_broad", async () => {
    const light = [
      rawCommentLight({ _id: "SiteQuickOld00001", postedAt: "2024-03-02T00:00:00.000Z", baseScore: 3 }),
      rawCommentLight({ _id: "SiteQuickNew00001", postedAt: "2024-03-20T00:00:00.000Z", baseScore: 1 }),
    ];
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "topShortform", terms: MARCH, limit: 2000 }, { results: light }, "§8.11"),
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: ["SiteQuickNew00001", "SiteQuickOld00001"] } },
        { results: [quickTake("SiteQuickOld00001", { postedAt: "2024-03-02T00:00:00.000Z" }), quickTake("SiteQuickNew00001", { postedAt: "2024-03-20T00:00:00.000Z" })] }, "§8.1"),
    ] });
    const out = await h.call("list_comments", { quick_takes_only: true, date_from: "2024-03-01", date_to: "2024-03-31" });
    expect(h.forum.requests).toHaveLength(2);
    expect(gqlTexts(h.forum)[0]).toContain('topShortform: {after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 2000)');
    expect(gqlTexts(h.forum)[0]).not.toContain("enableTotal");
    expect(out.text.split("\n")[0]).toBe("list_comments — quick takes site-wide");
    expect(out.text.indexOf("SiteQuickNew00001")).toBeLessThan(out.text.indexOf("SiteQuickOld00001"));
    expect(out.text).toContain("quick_takes_only true");
    expectClean(h);

    const many = Array.from({ length: 2000 }, (_, i) => rawCommentLight({ _id: `SiteQuick${String(i).padStart(8, "0")}`, postedAt: "2024-03-02T00:00:00.000Z" }));
    const broad = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "topShortform", terms: MARCH, limit: 2000 }, { results: many }, "§8.11")] });
    expect((await broad.call("list_comments", { quick_takes_only: true, date_from: "2024-03-01", date_to: "2024-03-31" })).text)
      .toBe("Error (too_broad): More than 2,000 quick takes match. Narrow with date_from/date_to.");
  });

  it("the empty text of quick takes restates the period and the filter", async () => {
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "topShortform", terms: MARCH, limit: 2000 }, { results: [] }, "§8.11")] });
    const out = await h.call("list_comments", { quick_takes_only: true, date_from: "2024-03-01", date_to: "2024-03-31" });
    expect(out.text).toContain("No comments match: posted 2024-03-01 to 2024-03-31 UTC, quick takes only.");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("a person's top over a period that includes now is read once: the light set is keyed by the period, not the clamped instant", async () => {
    const ids = ["PeriodSetA0000000", "PeriodSetB0000000", "PeriodSetC0000000"];
    const light = ids.map((_id, i) => rawCommentLight({ _id, baseScore: 30 - 10 * i, userId: EY, postedAt: `2026-03-0${i + 1}T00:00:00.000Z` }));
    const full = (i: number) => rawCommentList({ _id: ids[i], baseScore: 30 - 10 * i, userId: EY, postedAt: `2026-03-0${i + 1}T00:00:00.000Z` });
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "new" }, limit: 2000 }, { results: light, totalCount: 3 }, "§9.4"),
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: [ids[0], ids[1]] } }, { results: [full(1), full(0)] }, "§8.1"),
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: [ids[2]] } }, { results: [full(2)] }, "§8.1"),
    ] });
    const args = { user: "eliezer_yudkowsky", sort: "top", date_from: "2026", date_to: "2026", limit: 2 };
    const first = await h.call("list_comments", args);
    expect(first.text.indexOf(ids[0])).toBeLessThan(first.text.indexOf(ids[1]));
    expect(h.forum.requests).toHaveLength(3);
    h.clock.advance(60_000);
    const next = await h.call("list_comments", { ...args, cursor: printedCursor(first.text)! });
    expect(next.text).toContain(`comment_id ${ids[2]}`);
    expect(h.forum.requests).toHaveLength(4);
    expect(next.text).not.toContain("The list changed");
    expectClean(h);
  });

  it("sort old and min_karma: sortBy old; minimumKarma only from 1 up; every row re-checked, hidden karma left out", async () => {
    const rows = [
      rawCommentList({ _id: "KarmaFloorHigh001", userId: EY, baseScore: 9, postedAt: "2025-02-01T00:00:00.000Z" }),
      rawCommentList({ _id: "KarmaFloorLow0001", userId: EY, baseScore: 3, postedAt: "2025-03-01T00:00:00.000Z" }),
      rawCommentList({ _id: "KarmaFloorHidden1", userId: EY, baseScore: null, hideKarma: true, afBaseScore: null, extendedScore: null, postedAt: "2025-04-01T00:00:00.000Z" }),
    ];
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "old" } }, { results: rows, totalCount: 3 }, "§9.4")] });
    const out = await h.call("list_comments", { user: "eliezer_yudkowsky", sort: "old", min_karma: 5 });
    expect(gqlTexts(h.forum)[1]).toContain('allRecentComments: {userId: "nmk3nLpQE89dMRzzN", sortBy: "old", minimumKarma: 5}}');
    expect(out.text).toContain("comment_id KarmaFloorHigh001");
    expect(out.text).not.toContain("KarmaFloorLow0001");
    expect(out.text).not.toContain("KarmaFloorHidden1");
    expect(out.text).toContain("min_karma 5");
    expect(out.text).toContain("sort old");
    expect(out.text).toContain(HIDDEN_KARMA);
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);

    const zero = await h.call("list_comments", { user: "eliezer_yudkowsky", sort: "old", min_karma: 0 });
    expect(gqlTexts(h.forum).at(-1)).not.toContain("minimumKarma");
    expect(zero.text).toContain("comment_id KarmaFloorLow0001");
    expect(zero.text).not.toContain("KarmaFloorHidden1");
    expect(zero.text.indexOf("KarmaFloorHigh001")).toBeLessThan(zero.text.indexOf("KarmaFloorLow0001"));
  });

  it("D1 P5 P7 site-wide new: placeholders, debate turns and hidden comments are not listed; an anonymous comment has no author", async () => {
    const at = "2026-10-01T00:00:00.000Z";
    const by = (u: typeof A_COMMENTER) => ({ userId: u._id, user: u });
    const rows = [
      rawCommentList({ _id: "SiteNewPlacehold1", postedAt: at, deleted: true, deletedPublic: true, deletedReason: "Requested", ...by(A_COMMENTER) }),
      rawCommentList({ _id: "SiteNewDebateTurn", postedAt: at, debateResponse: true }),
      rawCommentList({ _id: "SiteNewRejected01", postedAt: at, rejected: true, ...by(A_COMMENTER) }),
      rawCommentList({ _id: "SiteNewUnreviewd1", postedAt: at, authorIsUnreviewed: true, ...by(A_COMMENTER) }),
      rawCommentList({ _id: "SiteNewVisible001", postedAt: at }),
      rawCommentList({ _id: "SiteNewAnon000001", postedAt: at, hideAuthor: true, ...by(ANON_AUTHOR) }),
    ];
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "new" }, limit: 20 }, { results: rows }, "§9.4")] });
    const out = await h.call("list_comments", { limit: 2 });
    expect(out.text.split("\n")[0]).toBe("list_comments — comments site-wide");
    expect(out.text).toContain("comment_id SiteNewVisible001");
    expect(out.text).toContain("comment_id SiteNewAnon000001");
    expect(out.text).toContain("author not publicly visible");
    expect(out.text).not.toMatch(/PLANTED|anon-author|anonAuthorUser001/);
    for (const hidden of ["SiteNewPlacehold1", "SiteNewDebateTurn", "SiteNewRejected01", "SiteNewUnreviewd1"]) expect(out.text).not.toContain(hidden);
    expect(h.forum.requests).toHaveLength(1);
    expectClean(h);
  });

  it("P18 site-wide top leaves out a comment whose karma is hidden, in the forum's order otherwise", async () => {
    const rows = [
      rawCommentList({ _id: "TopHiddenKarma001", postedAt: "2024-03-10T00:00:00.000Z", hideKarma: true, baseScore: null, afBaseScore: null, extendedScore: null }),
      rawCommentList({ _id: "TopVisibleFirst001", postedAt: "2024-03-11T00:00:00.000Z", baseScore: 7 }),
      rawCommentList({ _id: "TopVisibleLast0001", postedAt: "2024-03-12T00:00:00.000Z", baseScore: 90 }),
    ];
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "top", ...MARCH }, limit: 20 }, { results: rows }, "§9.4")] });
    const out = await h.call("list_comments", { sort: "top", date_from: "2024-03-01", date_to: "2024-03-31", limit: 2 });
    expect(out.text).not.toContain("TopHiddenKarma001");
    expect(out.text.indexOf("TopVisibleFirst001")).toBeLessThan(out.text.indexOf("TopVisibleLast0001"));
    expect(out.text).toContain(HIDDEN_KARMA);
    expectClean(h);
  });

  it("an empty bounded af_only scan restates the person and the filter", async () => {
    const rows = [rawCommentLight({ _id: "NoAfComment000001", af: false, userId: EY }), rawCommentLight({ _id: "NoAfComment000002", af: false, userId: EY })];
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "new" }, limit: 500 }, { results: rows, totalCount: 2 }, "§16")] });
    const out = await h.call("list_comments", { user: "eliezer_yudkowsky", af_only: true });
    expect(gqlTexts(h.forum)[1]).toContain('allRecentComments: {userId: "nmk3nLpQE89dMRzzN", sortBy: "new"}}, limit: 500, enableTotal: true) { results { ...COMMENT_LIGHT } totalCount }');
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain('No comments match: by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky), AF only.');
    expect(out.text).toContain("af_only true");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("site-wide top with af_only scans light rows in the forum's order by raw offset, then hydrates the kept ids; C-DRIFT", async () => {
    const scan = (page: number, af: number[]) => Array.from({ length: 500 }, (_, i) => rawCommentLight({
      _id: `ScanTop${page}${String(i).padStart(9, "0")}`, af: af.includes(i), postedAt: "2024-03-10T00:00:00.000Z", baseScore: 100 - i,
    }));
    const pages = [scan(0, [4]), scan(1, [7]), scan(2, [1])];
    const kept = [pages[0][4], pages[1][7], pages[2][1]].map((r) => r._id);
    const extra = [
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: kept } }, { results: [...kept].reverse().map((id) => rawCommentList({ _id: id, af: true, postedAt: "2024-03-10T00:00:00.000Z" })) }, "§8.1"),
      ...[2, 1, 0].map((i) => gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "top", ...MARCH }, limit: 500, ...(i > 0 ? { offset: i * 500 } : {}) }, { results: pages[i] }, "§16")),
    ];
    const h = createHarness({ families: FAMILIES, extra });
    const out = await h.call("list_comments", { sort: "top", af_only: true, date_from: "2024-03-01", date_to: "2024-03-31" });
    const texts = gqlTexts(h.forum);
    expect(texts[0]).toContain('allRecentComments: {sortBy: "top", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 500) { results { ...COMMENT_LIGHT } }');
    expect(texts.slice(0, 3).map((t) => /offset: (\d+)/.exec(t)?.[1] ?? "0")).toEqual(["0", "500", "1000"]);
    expect(texts.join("\n")).not.toContain("enableTotal");
    expect(h.forum.requests).toHaveLength(4);
    expect(texts[3]).toContain(`commentIds: ["${kept.join('", "')}"]`);
    // The forum's order, not the order the hydrate answered in.
    const places = kept.map((id) => out.text.indexOf(`comment_id ${id}`));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(places.every((p) => p >= 0)).toBe(true);
    expect(out.text).toContain("af_only kept 3 of the 1,500 comments checked; continue with the cursor");
    expect(out.text).toContain("Rankings can shift between pages as votes arrive.");
    expect(out.text).toContain(HIDDEN_KARMA);
    expectClean(h);
    // The cursor resumes the scan where it stopped: the next raw page is at offset 1500 (the offset-less fixture answers it).
    await h.call("list_comments", { cursor: printedCursor(out.text)! });
    expect(gqlTexts(h.forum)[4]).toContain('sortBy: "top", after: "2024-03-01T00:00:00.000Z", before: "2024-04-01T00:00:00.000Z"}}, limit: 500, offset: 1500)');
  });
});

describe("list_comments: continuations and hand-offs", () => {
  it("a printed call pasted back whole continues like the cursor alone; another person or sort is bad_input", async () => {
    const h = createHarness({ families: FAMILIES });
    const cursor = printedCursor((await h.call("list_comments", { user: SAMPLE_COMMENTER.slug })).text)!;
    const alone = await h.call("list_comments", { cursor });
    const whole = await h.call("list_comments", { user: SAMPLE_COMMENTER.slug, sort: "new", limit: 10, cursor });
    expect(whole.isError).toBe(false);
    // The echo drops "(default)" from what the repeated call gave; the page is the same.
    const withoutEcho = (text: string) => text.split("\n").filter((line) => !line.startsWith("Request:"));
    expect(withoutEcho(whole.text)).toEqual(withoutEcho(alone.text));
    expect(whole.text).toContain("sort new · limit 10");
    const other = await h.call("list_comments", { user: "paulfchristiano", cursor });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/^Error \(bad_input\): .*this cursor was issued for different parameters \(user: /);
    const sorted = await h.call("list_comments", { sort: "old", cursor });
    expect(sorted.text).toContain('different parameters (sort: cursor has "new", call has "old")');
  });

  it("the get_user hand-off: a keyset state at the last comment shown, the person as an id, continues the dated list", async () => {
    const h = createHarness({ families: FAMILIES });
    const given = tool.schema.parse({ user: SAMPLE_COMMENTER._id, limit: 3 }) as Parameters<typeof listCommentsEffective>[0];
    const cursor = h.services.cursors.issue("list_comments", { limit: 3 }, listCommentsEffective(given, { userId: SAMPLE_COMMENTER._id }), {
      streams: [{ kind: "keyset", shown: 3, dir: "new", boundaryMs: Date.parse("2026-10-09T09:00:00.000Z"), idsAtBoundary: ["LcHiddenKarma0001"], windowOffset: 0 }],
      current: 0,
    });
    const out = await h.call("list_comments", { cursor });
    expect(out.isError).toBe(false);
    expect(gqlTexts(h.forum).at(-1)).toContain('before: "2026-10-09T09:00:00.001Z"');
    expect(out.text).toContain("Position: items 4–4");
    expect(out.text).toContain("comment_id LcReplyToUnrevw01");
    expect(out.text).not.toContain("comment_id LcHiddenKarma0001");
    expect(out.text).toContain("limit 3");
    expectClean(h);
  });

  it("¶3.6 a comment larger than the page is cut by the budget and continued by the cursor, every word once", async () => {
    const body = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
    const long = rawCommentList({ _id: "LongBodyComment01", userId: EY, postedAt: "2026-10-01T00:00:00.000Z", post: rawPostRef({ title: "T".repeat(300) }), contents: { markdown: body, wordCount: 6000 } });
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: EY, sortBy: "new" }, limit: 20 }, { results: [long], totalCount: 1 }, "§9.4")] });
    const first = await h.call("list_comments", { user: "eliezer_yudkowsky", max_tokens: 2000 });
    expect(first.text).toMatch(/\[… continues: about \d+ more words; use the cursor\]/);
    const lastWord = /word(\d+) *\n\[… continues/.exec(first.text)![1];
    const next = await h.call("list_comments", { cursor: printedCursor(first.text)!, max_tokens: 2000 });
    expect(next.text).toContain(`> word${Number(lastWord) + 1} `);
    expect(next.text).toContain('[… cut; full text: get_comments {comment: "LongBodyComment01"}]');
    expect(next.text.trimEnd().endsWith("End of results.")).toBe(true);
    expect(next.text).not.toContain(`word${lastWord} `);
    expectClean(h);
  });

  it("¶3.6 depth guard: a site-wide list in date order ends after 500 comments with the guard's reason", async () => {
    const base = Date.parse("2026-10-20T00:00:00.000Z");
    const when = (i: number): number => base - i * 60_000;
    const comment = (i: number) => rawCommentList({ _id: `Guard${String(i).padStart(12, "0")}`, postedAt: new Date(when(i)).toISOString() });
    const window = (from: number) => Array.from({ length: 100 }, (_, j) => comment(from + j));
    // Page k (50 comments) starts a window just after the last one shown; the first page has no bound.
    const extra = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((k) => k === 0
      ? gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "new" }, limit: 100 }, { results: window(0) }, "§9.4")
      : gqlEntry({ root: "comments", view: "allRecentComments", terms: { sortBy: "new", before: new Date(when(50 * k - 1) + 1).toISOString() }, limit: 100 }, { results: window(50 * k - 1) }, "§9.4"));
    const h = createHarness({ families: FAMILIES, extra });
    let cursor: string | undefined;
    let text = "";
    for (let page = 0; page < 10; page++) {
      text = (await h.call("list_comments", cursor === undefined ? { limit: 50, max_tokens: 40000 } : { cursor, max_tokens: 40000 })).text;
      cursor = printedCursor(text);
      expect(text).toContain(`Position: items ${50 * page + 1}–${50 * page + 50}`);
      expect(text.includes("More available")).toBe(page < 9);
    }
    expect(text).toContain("End of reachable results: this server stops site-wide lists in date order after 500 items unless a person, tag, date range, status or karma filter narrows them");
    expect(cursor).toBeUndefined();
    expect(text).toContain("comment_id Guard000000000499");
    expectClean(h);
  });

  it("Q4 C-DEPTH site-wide top pages by offset up to 2000, then ends with the forum's limit and C-DRIFT", async () => {
    const row = (i: number) => rawCommentList({ _id: `TopDeep${String(i).padStart(10, "0")}`, postedAt: "2024-03-10T00:00:00.000Z", baseScore: 5000 - i });
    const page = (k: number) => Array.from({ length: 100 }, (_, j) => row(100 * k + j));
    const extra = Array.from({ length: 21 }, (_, n) => 20 - n).map((k) => gqlEntry(
      { root: "comments", view: "allRecentComments", terms: { sortBy: "top", ...MARCH }, limit: 100, ...(k > 0 ? { offset: 100 * k } : {}) }, { results: page(k) }, "§9.4"));
    const h = createHarness({ families: FAMILIES, extra });
    const args = { sort: "top", date_from: "2024-03-01", date_to: "2024-03-31", limit: 50, max_tokens: 40000 };
    let cursor: string | undefined;
    let text = "";
    let calls = 0;
    do {
      text = (await h.call("list_comments", cursor === undefined ? args : { cursor, max_tokens: 40000 })).text;
      cursor = printedCursor(text);
      calls++;
    } while (cursor !== undefined && calls < 60);
    expect(cursor).toBeUndefined();
    // ¶3.6: the forum-limit sentence with list_comments' own hint, which names only parameters it accepts
    expect(text.split("\n").at(-1)).toBe("End of reachable results: the forum can't list beyond about the 2,000th result in this order; narrow with date_from/date_to, or use sort new or old.");
    expect(h.forum.requests.map((r) => /offset: (\d+)/.exec(r.body)?.[1] ?? "0").at(-1)).toBe("2000");
    expectClean(h);
  });
});
