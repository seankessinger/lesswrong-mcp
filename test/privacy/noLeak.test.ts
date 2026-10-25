import { describe, it, expect, beforeAll } from "vitest";
import { GOLDEN } from "../support/goldenCases";
import { MARKERS, NEVER_FETCHED, findMarkers } from "../support/markers";
import { createFakeForum } from "../fakeForum";
import { ALL_FAMILIES, loadFamilies, type FixtureEntry, type FixtureFamily } from "../support/fixtures";
import { servicesFor } from "../support/services";
import { createClock } from "../support/clock";
import { createHarness } from "../support/harness";
import { printedCursor } from "../support/requests";
import {
  A_COMMENTER, SAMPLE_PERSON, gqlEntry, rawPostCard, rawTagList, rawCommentList, forestEntries, agiRuinForest, AGI_FOREST, samplePersonEntry,
  samplePersonPinnedPage, samplePersonWikiEdits, samplePersonWikiEditsEntry,
} from "../support/builders";
import { callTool } from "../../src/server";
import { TOOLS } from "../../src/tools/registry";
import { CURSOR_RE } from "../../src/paging/cursor";
import type { CursorStore, ToolName } from "../../src/types";

/** `outcome` is the path a privacy call must take (default "ok"), so that its absence checks never pass on a call that stopped rendering. */
interface Run { tool: ToolName; args: Record<string, unknown>; families: readonly FixtureFamily[]; extra?: FixtureEntry[]; follow?: boolean; markers?: string[]; outcome?: "ok" | "bad_input" | "not_found" }
interface Seen { run: Run; texts: string[]; responses: string[]; logs: string[]; bodies: string[]; lint: string[]; unmatched: string[] }

let issued = 0;
async function run(r: Run): Promise<Seen> {
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const forum = createFakeForum({ fixtures: [...(r.extra ?? []), ...loadFamilies(...r.families)], sleep: clock.sleep });
  const responses: string[] = []; const logs: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => { const res = await forum.fetchImpl(url, init); responses.push(await res.clone().text()); return res; };
  const wrapCursors = (s: CursorStore): CursorStore => ({
    issue: (tool, args, eff, state) => { issued++; return s.issue(tool, args, eff, { ...state, data: { ...(state.data ?? {}), planted: "PLANTED-P10-1" } }); },
    take: (tool, token) => s.take(tool, token),
  });
  const services = servicesFor({ ...forum, fetchImpl }, { clock, logLines: logs, wrapCursors });
  const call = (a: Record<string, unknown>) => callTool({ tools: TOOLS, services, now: clock.now }, r.tool, a).then((o) => o.text);
  const texts = [await call(r.args)];
  const c = printedCursor(texts[0]!);
  if (r.follow && c) texts.push(await call({ cursor: c }));
  return { run: r, texts, responses, logs, bodies: forum.requests.map((q) => q.body), lint: forum.lintErrors, unmatched: forum.unmatched };
}

const PLANTED_USER = { _id: "plantedUser000001", slug: "planted-user", displayName: "PLANTED-P19-1" };
/** `forestEntries` builds the forest views and the bodies entry. */
const plantedForest = () => {
  const f = agiRuinForest();
  const comments = f.comments.map((c) => c.deleted ? { ...c, userId: PLANTED_USER._id, user: PLANTED_USER }
    : c._id === AGI_FOREST.ids.orphan ? { ...c, parentCommentId: "PLANTED-P14-4" } : c);
  return forestEntries({ post: AGI_FOREST.postId }, comments, f.answers);
};
const coreGrouping = gqlEntry({ root: "TagsByCoreTagId", args: { coreTagId: "sYm3HiWcfZvrGu3ui" } }, { tags: [
  rawTagList({ _id: "aiRiskTag00000001", name: "AI Risk", slug: "ai-risk", coreTagId: "sYm3HiWcfZvrGu3ui" }),
  rawTagList({ _id: "adminOnlyTag00001", name: "PLANTED-P12-1", slug: "admin-only-tag", adminOnly: true, coreTagId: "sYm3HiWcfZvrGu3ui" }),
], totalCount: 2 }, "§10.6");
const hiddenSpotlight = gqlEntry({ root: "currentSpotlight" }, { documentType: "Post", customTitle: "PLANTED-P1-1", customSubtitle: "PLANTED-P1-2",
  lastPromotedAt: "2026-10-21T18:00:00.000Z", post: rawPostCard({ _id: "rejectedPost00001", title: "Rejected Post", slug: "rejected-post", rejected: true, userId: A_COMMENTER._id, user: A_COMMENTER }),
  sequence: null, tag: null }, "§14.3");
const R = (tool: ToolName, args: Record<string, unknown>, markers: string[], extra?: FixtureEntry[]): Run => ({ tool, args, families: ALL_FAMILIES, extra, markers });

/** Calls that reach every planted marker, whatever the golden suite covers. */
const PRIVACY_CALLS: Run[] = [
  R("get_feed", { feed: "spotlight" }, ["PLANTED-P1-1", "PLANTED-P1-2"], [hiddenSpotlight]),
  R("get_reactions", { comment: "rejPostJoinCmnt01" }, ["PLANTED-P2-1"]),
  R("search", { kind: "comment", query: "planted" }, ["PLANTED-P2-2", "PLANTED-P6-1", "PLANTED-P16-1", "PLANTED-P16-2"]),
  R("get_feed", { feed: "this_week" }, ["PLANTED-P2-3", "PLANTED-P3-1"]),
  R("get_feed", { feed: "dialogues" }, ["PLANTED-P2-4", "PLANTED-P3-2"]),
  R("get_feed", { feed: "frontpage" }, ["PLANTED-P2-5"]),
  R("get_feed", { feed: "best_of" }, ["PLANTED-P2-6", "PLANTED-P14-5"]),
  R("get_feed", { feed: "recent_discussion" }, ["PLANTED-P6-2", "PLANTED-P12-10"]),
  R("get_feed", { feed: "wiki_activity" }, ["PLANTED-P12-11", "PLANTED-P12-12"]),
  R("find", { items: [{ kind: "sequence", query: "Map and Territory" }] }, ["PLANTED-P4-1", "PLANTED-P14-2"]),
  { ...R("get_history", { comment: "placeholderCmnt01" }, ["PLANTED-P5-1"]), outcome: "bad_input" },
  { ...R("get_reactions", { comment: "placeholderCmnt01" }, ["PLANTED-P5-2"]), outcome: "bad_input" },
  R("get_post", { post: "anonPlantPost0001" }, ["PLANTED-P7-1"]),
  R("get_history", { post: "anonPlantPost0001" }, ["PLANTED-P7-2"]),
  R("search", { query: "anonymous essay" }, ["PLANTED-P7-3"]),
  R("get_user", { user: SAMPLE_PERSON.slug, limit: 3 }, ["PLANTED-P7-4"], samplePersonPinnedPage()),
  R("get_reactions", { comment: "reactsCmnt0000001" }, ["PLANTED-P8-1", "PLANTED-P11-1"]),
  R("get_reactions", { tag: "innerAlignTag0001" }, ["PLANTED-P8-2"]),
  R("get_reactions", { post: "a-post-readers-reacted-to" }, ["PLANTED-P11-2"]),
  R("get_reactions", { comment: "hiddenKarmaCmnt01" }, []),
  R("list_tags", { tag: "ai" }, ["PLANTED-P12-1"], [coreGrouping]),
  R("get_post", { post: "insSuggestPost001" }, ["PLANTED-P12-2", "PLANTED-P14-3", "PLANTED-P15-1", "PLANTED-P15-2", "PLANTED-P15-3"]),
  R("get_tag", { tag: "bayes-rule" }, ["PLANTED-P12-3"]),
  { ...R("get_reactions", { tag: "AdminPageLens0001" }, ["PLANTED-P12-4"]), outcome: "not_found" },
  { ...R("get_reactions", { tag: "orphanLens0000001" }, ["PLANTED-P12-5"]), outcome: "not_found" },
  { ...R("get_reactions", { tag: "orphanSummary0001" }, ["PLANTED-P12-6"]), outcome: "not_found" },
  { ...R("get_reactions", { tag: "DeadLensSummary01" }, ["PLANTED-P12-7"]), outcome: "not_found" },
  R("get_history", { user: SAMPLE_PERSON.slug }, ["PLANTED-P12-8", "PLANTED-P12-9"], [samplePersonEntry(), samplePersonWikiEditsEntry(samplePersonWikiEdits())]),
  R("search", { kind: "user", query: "Berkeley" }, ["PLANTED-P13-1"]),
  R("find", { items: [{ kind: "user", query: "Pat Namesake" }] }, ["PLANTED-P13-2"]),
  R("get_sequence", { sequence: "BiasesSequence001" }, ["PLANTED-P14-1"]),
  R("get_comments", { post: "uMQ3cqWDPHhjtiesc", user: "paulfchristiano" }, ["PLANTED-P14-4", "PLANTED-P19-1"], plantedForest()),
];

let seen: Seen[] = [];
beforeAll(async () => {
  const golden = GOLDEN.map((c): Run => ({ tool: c.tool, args: c.args, families: c.families, extra: c.extra?.(), follow: c.follow }));
  for (const r of [...golden, ...PRIVACY_CALLS]) seen.push(await run(r));
}, 120_000);

const texts = () => seen.flatMap((s) => s.texts);

describe("privacy regression (¶9.3, D1)", () => {
  it("no reply, continuation or log line contains any marker", () => {
    for (const s of seen) {
      for (const t of s.texts) expect(findMarkers(t), `${s.run.tool} ${JSON.stringify(s.run.args)}`).toEqual([]);
      expect(findMarkers(s.logs.join("\n"))).toEqual([]);
    }
  });
  it("every marker is planted; every fetched one reached the forum's answers; NEVER_FETCHED ones never did", () => {
    const fixtures = JSON.stringify([...loadFamilies(...ALL_FAMILIES), ...PRIVACY_CALLS.flatMap((r) => r.extra ?? [])]);
    const answers = seen.flatMap((s) => s.responses).join("\n");
    for (const m of MARKERS) expect(fixtures, m).toContain(m);
    for (const m of MARKERS.filter((x) => !NEVER_FETCHED.includes(x))) expect(answers, m).toContain(m);
    for (const m of NEVER_FETCHED) expect(answers, m).not.toContain(m);
    expect(new Set(PRIVACY_CALLS.flatMap((r) => r.markers ?? []))).toEqual(new Set(MARKERS));
  });
  it("every run is lint-clean and fully matched", () => {
    for (const s of seen) { expect(s.lint).toEqual([]); expect(s.unmatched).toEqual([]); }
  });
  it("every privacy call takes its intended path: a reply, or the intended refusal", () => {
    const calls = seen.filter((s) => PRIVACY_CALLS.includes(s.run));
    expect(calls).toHaveLength(PRIVACY_CALLS.length);
    for (const s of calls) {
      const outcome = s.run.outcome ?? "ok";
      const first = outcome === "ok" ? new RegExp(`^${s.run.tool} — `) : new RegExp(`^Error \\(${outcome}\\): `);
      expect(s.texts[0], `${s.run.tool} ${JSON.stringify(s.run.args)}`).toMatch(first);
    }
  });
  it("every printed cursor is a bare token", () => {
    for (const t of texts()) for (const m of t.matchAll(/cursor "([^"]*)"/g)) expect(m[1]).toMatch(CURSOR_RE);
  });

  it("P7 anonymous authors are never named", () => {
    // PLANTED-P7-1 plants only the display name, so the anonymous author's id and slug are checked too.
    for (const t of texts()) { expect(t).not.toContain("anonAuthorUser001"); expect(t).not.toContain("anon-author"); }
  });
  it("P8 deleted accounts show as account not publicly visible", () => {
    expect(seen.find((s) => s.run.args.comment === "reactsCmnt0000001")!.texts[0]).toContain("account not publicly visible");
  });
  it("P9 no request names a forbidden view, argument or term", () => {
    for (const s of seen) for (const b of s.bodies) expect(b).not.toMatch(/includeRejected|orderBy|authorIsUnreviewed: |\binput: /);
  });
  it("P10 stored cursor state is never rendered; no forum total is printed", () => {
    expect(issued).toBeGreaterThan(0);
    for (const t of texts()) expect(t).not.toContain("totalCount");
  });
  it("P10 a hidden row added between two pages changes no drift note; a new visible row does", async () => {
    const row = (i: number, o: Record<string, unknown> = {}) => rawCommentList({ _id: `driftCmnt${String(i).padStart(8, "0")}`, af: false, baseScore: 50 - i, postedAt: "2026-10-21T00:00:00.000Z", ...o });
    const five = [1, 2, 3, 4, 5].map((i) => row(i));
    const h = createHarness({ families: ["feeds"], extra: [gqlEntry({ root: "PopularComments" }, { results: five }, "§14.3")] });
    const answer = (rows: unknown[]) => h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("PopularComments"), times: 1, status: 200,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { f: { results: rows } } }) });
    const p1 = await h.call("get_feed", { feed: "popular_comments", limit: 2 });
    h.clock.advance(121_000);
    const withHidden = [five[0], row(9, { rejected: true }), ...five.slice(1)];
    answer(withHidden);
    const p2 = await h.call("get_feed", { cursor: printedCursor(p1.text)! });
    expect(p2.text).not.toContain("The list changed");
    h.clock.advance(121_000);
    answer([row(0), ...withHidden]);
    const p3 = await h.call("get_feed", { cursor: printedCursor(p2.text)! });
    expect(p3.text).toContain("The list changed since the previous page (1 new item); positions may have shifted.");
  });
  it("P13 locations and former slugs never show", () => {
    const t = seen.find((s) => s.run.args.query === "Berkeley")!.texts[0];
    expect(t).toContain("user_id berkeleyBioUser01");
    expect(t).not.toContain("locationOnlyUser1");
  });
  it("P15 unaccepted suggestions and unapproved or deleted glossary terms never show", () => {
    expect(seen.find((s) => s.run.args.post === "insSuggestPost001")!.texts[0]).toContain("Corrigibility");
  });
  it("P17 excluded paths are requested only for subjects confirmed public (the lint, over every run)", () => {
    for (const s of seen) expect(s.lint.filter((l) => l.includes("P17"))).toEqual([]);
  });
  it("P18 hidden comment karma is never printed as a number", () => {
    const t = seen.find((s) => s.run.args.comment === "hiddenKarmaCmnt01")!.texts[0];
    expect(t).toContain("karma not publicly visible");
    expect(t).not.toMatch(/karma -?\d|karma −\d|\d+ votes?\)/);
  });
  it("P19 placeholders and anonymous comments never count toward a person", () => {
    for (const t of texts()) expect(t).not.toContain("plantedUser000001");
  });
});
