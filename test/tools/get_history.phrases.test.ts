import { describe, expect, it } from "vitest";
import { historyUserEffective, tool } from "../../src/tools/get_history";
import { loadUserWikiEdits } from "../../src/tools/loaders";
import { createCallContext } from "../../src/call/context";
import type { AliasResults } from "../../src/types";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import {
  SAMPLE_PERSON, eyRef, gqlEntry, longIntroHistory, rawRevRow, rawTagRef, revisionHistory as history, samplePersonEntry, samplePersonWikiEdits,
  samplePersonWikiEditsEntry, wikiEditRows,
} from "../support/builders";

const LEAN = "zHhGa3iQBQcdSifFL";
const EY = "nmk3nLpQE89dMRzzN";
const FAMILIES = ["posts", "comments", "tags", "revisions", "users"] as const;

describe("get_history phrases", () => {
  it("phrases and user add to the schema; their combinations are bad_input", async () => {
    expect(tool.oneOf).toEqual([["post", "comment", "tag", "user"]]);
    const h = createHarness({ families: FAMILIES });
    expect((await h.call("get_history", { user: "eliezer_yudkowsky", revision: "current" })).text)
      .toBe("Error (bad_input): revision: not available with user (a person's wiki edits). Use only sort, limit, cursor and max_tokens with user.");
    expect((await h.call("get_history", { post: LEAN, phrases: ["kernel"], revision: "current" })).text)
      .toBe("Error (bad_input): phrases: can't be combined with revision or compare_to. Leave revision out to check phrases.");
    expect(h.forum.requests).toHaveLength(0);
  });

  it("present at publication and absent in both: the original and current texts in one request", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, phrases: ["proof assistant", "theorem prover"] });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toMatch(/r1: revision\(selector: \{_id: "LeanRev000000000[27]"\}\).*r2: revision/s);
    expect(out.text).toContain('Phrases checked in post "A critical look at Lean4" (post_id zHhGa3iQBQcdSifFL, LW only):');
    expect(out.text).toContain('"proof assistant": present at publication');
    expect(out.text).toContain('"theorem prover": not in the original or the current text');
    expectClean(h);
  });

  it("Q98 added by a later edit: one round of probes finds the first version containing it", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: LEAN, phrases: ["trusted kernel"] });
    expect(h.forum.requests).toHaveLength(4);
    expect(out.text).toContain('"trusted kernel": first appears in v1.11.0 (revision_id LeanRev0000000005, 2024-12-01), assuming it was not removed and re-added');
  });

  it("a wiki page's phrase present in its oldest public version; one added by its next version needs no probe", async () => {
    const bayes = (id: string, version: string, editedAt: string, markdown: string) =>
      gqlEntry({ root: "revision", id }, { result: { _id: id, documentId: "RkznxXmmh9b5ovdSq", fieldName: "description", version, editedAt, wordCount: 5, markdown } }, "§7.4");
    const h = createHarness({ families: FAMILIES, extra: [
      bayes("BayesRev000000001", "1.2.0", "2024-06-01T00:00:00.000Z", "Bayes' rule updates beliefs."),
      bayes("BayesRev000000002", "1.3.0", "2025-02-02T00:00:00.000Z", "Bayes' rule updates beliefs with evidence."),
    ] });
    const out = await h.call("get_history", { tag: "RkznxXmmh9b5ovdSq", phrases: ["updates beliefs", "with evidence"] });
    expect(out.isError, out.text).toBe(false);
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text).toContain(`Phrases checked in wiki page "Bayes' rule" (tag_slug bayes-rule):`);
    expect(out.text).toContain('"updates beliefs": present in the oldest public version');
    expect(out.text).toContain('"with evidence": first appears in v1.3.0 (revision_id BayesRev000000002, 2025-02-02), assuming it was not removed and re-added');
    expect(out.text).not.toContain("present at publication");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("a post whose published text is not public: the earliest public version stands in for the original, and the page says so", async () => {
    const late = Date.parse("2020-02-01T00:00:00.000Z");
    const n = late / 60_000;
    const rid = (i: number) => `RevLong${String(n - i).padStart(10, "0")}`;
    const text = (i: number) => gqlEntry({ root: "revision", id: rid(i) }, {
      result: { _id: rid(i), documentId: "LongHistoryPost01", fieldName: "contents", version: `1.${n - i}.0`, editedAt: new Date(late - i * 60_000).toISOString(), wordCount: 4, markdown: i === 2 ? "Edited after publication." : "Edited after publication, twice." },
    }, "§7.4");
    // Three public versions, all a month after publication (2020-01-01): the as-published text is not public.
    const h = createHarness({ families: FAMILIES, extra: [...history("LongHistoryPost01", [{ offset: 0, rows: 3, totalCount: 3, startMs: late }]), text(0), text(1), text(2)] });
    const out = await h.call("get_history", { post: "LongHistoryPost01", phrases: ["after publication", "twice"] });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain(`"after publication": present in the earliest public version (v1.${n - 2}.0, after publication); the published text is not available`);
    expect(out.text).toContain(`"twice": first appears in v1.${n - 1}.0 (revision_id ${rid(1)}, 2020-01-31), assuming it was not removed and re-added`);
    expect(out.text).toContain(`Original: published text not available: the earliest public version (v1.${n - 2}.0, 2020-01-31T23:58:00.000Z) is from after publication`);
    expect(out.text).toContain("Evidence:");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("Q97 pre-2019 content: present in the oldest kept text, original wording not recorded", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { post: "PreNineteenPost01", phrases: ["Goodhart's law"] });
    expect(out.text).toContain(`"Goodhart's law": present in the oldest kept text (a February-2019 snapshot); original wording not recorded`);
  });

  it("an interval left after 2 rounds is carried in the cursor and finished on the next call", async () => {
    const h = createHarness({ families: FAMILIES, extra: longIntroHistory() });
    const first = await h.call("get_history", { post: "LongIntroPost0001", phrases: ["rare phrase"] });
    expect(h.forum.requests.length).toBeLessThanOrEqual(7);
    expect(first.text).toMatch(/"rare phrase": first appears between v1\.\d+\.0 and v1\.\d+\.0; continue with the cursor/);
    const second = await h.call("get_history", { cursor: printedCursor(first.text)! });
    expect(second.text).toMatch(/"rare phrase": first appears in v1\.333\.0 \(revision_id IntroRev000000333, 2020-01-14\), assuming it was not removed and re-added/);
  });

  it("two phrases added far apart (v1.100.0 and v1.400.0) are both dated: the cursor's continuation narrows both intervals instead of probing the versions between them", async () => {
    const markdown = (k: number) => `${k >= 100 ? "The early phrase is here. " : ""}${k >= 400 ? "The late phrase is here." : "Nothing more."}`;
    const h = createHarness({ families: FAMILIES, extra: longIntroHistory(markdown) });
    const pages = [await h.call("get_history", { post: "LongIntroPost0001", phrases: ["early phrase", "late phrase"] })];
    for (let c = printedCursor(pages[0].text); c && pages.length < 3; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("get_history", { cursor: c }));
    const last = pages.at(-1)!.text;
    expect(last).toContain('"early phrase": first appears in v1.100.0 (revision_id IntroRev000000100, 2020-01-05), assuming it was not removed and re-added');
    expect(last).toContain('"late phrase": first appears in v1.400.0 (revision_id IntroRev000000400, 2020-01-17), assuming it was not removed and re-added');
    expect(last.trimEnd().endsWith("End of results.")).toBe(true);
    // Round 1 leaves v1.91.0–v1.136.0 and v1.363.0–v1.408.0; round 2 gives each 5 versions of its own.
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain('"early phrase": first appears between v1.99.0 and v1.106.0; continue with the cursor');
    expect(pages[0].text).toContain('"late phrase": first appears between v1.393.0 and v1.401.0; continue with the cursor');
  });

  it("¶2.2 step 5 a time-limit stop before the second round keeps what the first round narrowed; the cursor finishes the search", async () => {
    const h = createHarness({ families: FAMILIES, extra: longIntroHistory() });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("r3: revision"), delayMs: 41_000, times: 1 }); // round 1 answers after 41 s
    const first = await h.call("get_history", { post: "LongIntroPost0001", phrases: ["rare phrase"] });
    expect(first.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(4);
    // Round 1 answered (ten probes over v1.0.0–v1.499.0); only round 2 was refused: its narrowing is reported, not the whole list.
    expect(first.text).toContain('"rare phrase": first appears between v1.318.0 and v1.363.0; continue with the cursor');
    expect(first.text).toMatch(/Stopped early \(time limit\); call get_history with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
    const pages = [first];
    for (let c = printedCursor(first.text); c && pages.length < 4; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("get_history", { cursor: c }));
    expect(pages.at(-1)!.text).toContain('"rare phrase": first appears in v1.333.0 (revision_id IntroRev000000333, 2020-01-14)');
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("¶3.6 a phrase cursor over a changed version list starts the search again instead of reusing stale row indexes", async () => {
    const entries = longIntroHistory();
    const rows = (entries[1]!.result as { results: { _id: string }[] }).results;
    const h = createHarness({ families: FAMILIES, extra: entries });
    const first = await h.call("get_history", { post: "LongIntroPost0001", phrases: ["rare phrase"] });
    expect(first.text).toContain('"rare phrase": first appears between v1.330.0 and v1.334.0; continue with the cursor');
    // Eleven minutes later the cached list has expired, and the forum now hides versions 1.100.0–1.199.0.
    h.clock.advance(11 * 60_000);
    const shorter = rows.filter((r) => !/^IntroRev0000001\d\d$/.test(r._id));
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("revisionsOnDocument"), body: JSON.stringify({ data: { l: { results: shorter, totalCount: 400 } } }) });
    const second = await h.call("get_history", { cursor: printedCursor(first.text)! });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("The list changed since the previous page (0 new items); positions may have shifted.");
    expect(second.text).toContain('"rare phrase": first appears between v1.331.0 and v1.334.0; continue with the cursor');
    const third = await h.call("get_history", { cursor: printedCursor(second.text)! });
    expect(third.text).toContain('"rare phrase": first appears in v1.333.0 (revision_id IntroRev000000333, 2020-01-14)');
    expect(third.text).not.toContain("The list changed");
  });
});

describe("get_history user: a person's wiki edits", () => {
  it("Q133 L1 R7 one light set via revisionsByUser (userId only), sorted locally", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { user: "eliezer_yudkowsky" });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    const [operation] = gqlTexts(h.forum)[1].split("\n"); // the fragment definitions that follow select fieldName themselves
    expect(operation).toContain('w0: revisions(selector: {revisionsByUser: {userId: "nmk3nLpQE89dMRzzN"}}, limit: 1000, enableTotal: true) { results { ...REV_ROW tag { ...TAG_REF } lens { ...MDOC_REF } summary { ...MDOC_REF } } totalCount }');
    expect(operation).not.toContain("fieldName");
    expect(out.text.split("\n")[0]).toBe('get_history — wiki edits by "Eliezer Yudkowsky"');
    expect(out.text).toContain('Wiki edits by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    const at = (n: number) => out.text.indexOf(`revision_id EyWikiEdit000000${n}`);
    expect(at(2)).toBeGreaterThan(0);
    expect(at(2)).toBeLessThan(at(4));
    expect(at(4)).toBeLessThan(at(1));
    expect(at(1)).toBeLessThan(at(3));
    expect(out.text).toContain(`lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
    expect(out.text).toContain('summary (summary_id InterpSummary0001) of "Interpretability (ML & AI)" (tag_slug interpretability-ml-and-ai)');
    expect(out.text).toContain(`summary (summary_id GuideSummary0001x) of lens "Guide" (lens_slug bayes-rule-guide) of "Bayes' rule" (tag_slug bayes-rule)`);
    expectClean(h);
  });

  it("P12 a person's wiki edits of pages that are not public are left out, and only their number is logged", async () => {
    // A made-up person, so that the edits are their own and only the page rules leave three out.
    const h = createHarness({ families: FAMILIES, extra: [samplePersonEntry(), samplePersonWikiEditsEntry(samplePersonWikiEdits())] });
    const out = await h.call("get_history", { user: SAMPLE_PERSON.slug });
    expect(out.text).toContain("revision_id sampleWikiEdit001");
    expect(out.text).toContain('"AI" (tag_slug ai)');
    expect(out.text).not.toMatch(/PLANTED|sampleWikiEdit00[234]/);
    expect(h.logLines.join("\n")).not.toMatch(/PLANTED|sampleWikiEdit00[234]|sampleAdminLens01|sampleDeadSumm001/);
    expectClean(h);
  });

  it("sort old reverses the same set; historyUserEffective", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_history", { user: "eliezer_yudkowsky", sort: "old" });
    const at = (n: number) => out.text.indexOf(`revision_id EyWikiEdit000000${n}`);
    expect(at(3)).toBeGreaterThan(0);
    expect(at(3)).toBeLessThan(at(1));
    expect(at(1)).toBeLessThan(at(4));
    expect(at(4)).toBeLessThan(at(2));
    const p = tool.schema.parse({ user: "eliezer_yudkowsky" }) as Parameters<typeof historyUserEffective>[0];
    expect(historyUserEffective(p, EY)).toEqual({ user: EY, sort: "new", limit: 10 });
  });

  it("more than 2,000 wiki revisions: two raw pages, and the last page says only the first 2,000 are listed", async () => {
    const h = createHarness({ families: FAMILIES, extra: [
      gqlEntry({ root: "revisions", view: "revisionsByUser", terms: { userId: EY }, offset: 1000 }, { results: wikiEditRows("EyBulkEdit", 1000, eyRef()) }, "§7.1"),
      gqlEntry({ root: "revisions", view: "revisionsByUser", terms: { userId: EY } }, { results: wikiEditRows("EyBulkEdit", 0, eyRef()), totalCount: 2600 }, "§7.1"),
    ] });
    const pages = [await h.call("get_history", { user: "eliezer_yudkowsky", limit: 50 })];
    expect(gqlTexts(h.forum)[2]).toContain('w1: revisions(selector: {revisionsByUser: {userId: "nmk3nLpQE89dMRzzN"}}, limit: 1000, offset: 1000)');
    for (let c = printedCursor(pages[0].text); c; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("get_history", { cursor: c }));
    expect(pages).toHaveLength(40);
    expect(h.forum.requests).toHaveLength(3);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of reachable results: this person has more than 2,000 wiki revisions, and the forum's order for them is not documented; only the first 2,000 it returns are listed, newest first.")).toBe(true);
    expect(pages.map((p) => p.text).join("\n")).not.toContain("2,600");
  });

  it("loadUserWikiEdits reads get_user's we alias when given, then serves the cache", async () => {
    const h = createHarness({ families: FAMILIES });
    const row = rawRevRow({ _id: "EyWikiEdit0000001", documentId: "sYm3HiWcfZvrGu3ui", collectionName: "Tags", editedAt: "2025-03-03T00:00:00.000Z", userId: EY, user: eyRef(),
      tag: rawTagRef({ _id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", core: true }) });
    const results: AliasResults = new Map([["we", { data: { results: [row], totalCount: 1 } }]]);
    const one = await loadUserWikiEdits(EY, createCallContext("get_user", { now: h.clock.now }), h.services, results);
    expect(one.rows.map((r) => r.id)).toEqual(["EyWikiEdit0000001"]);
    expect(one.over2000).toBe(false);
    await loadUserWikiEdits(EY, createCallContext("get_history", { now: h.clock.now }), h.services);
    expect(h.forum.requests).toHaveLength(0);
  });
});
