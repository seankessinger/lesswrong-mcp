import { describe, expect, it } from "vitest";
import { sequenceSetOp } from "../../src/forum/templates/list_sequences";
import { listSequencesEffective, loadSequenceSet, orderSequences, tool } from "../../src/tools/list_sequences";
import { createCallContext } from "../../src/call/context";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";
import { fullSequenceSet, gqlEntry, rawSeqCard, rawSeqLight, seqLightRows, sequenceSetEntry } from "../support/builders";

const EY = "nmk3nLpQE89dMRzzN";
const OTHER = "OtherUserId000001";
const seq = (k: string, o: Partial<ReturnType<typeof rawSeqLight>>) => rawSeqLight({
  _id: `SeqLight${k}00000001`, af: false, hidden: false, userId: EY, curatedOrder: null, userProfileOrder: null, hideFromAuthorPage: false, ...o,
});
const SET = [
  seq("A", { createdAt: "2024-01-01T00:00:00.000Z", curatedOrder: 5, userProfileOrder: 2 }),
  seq("B", { createdAt: "2023-01-01T00:00:00.000Z", af: true }),
  seq("C", { createdAt: "2025-01-01T00:00:00.000Z", userId: OTHER, curatedOrder: 9 }),
  seq("D", { createdAt: "2022-01-01T00:00:00.000Z", userProfileOrder: 1, hideFromAuthorPage: true }),
  seq("E", { createdAt: "2021-01-01T00:00:00.000Z", curatedOrder: 5, af: true }),
  seq("H", { createdAt: "2026-01-01T00:00:00.000Z", hidden: true, curatedOrder: 10, userId: OTHER }),
];
const ids = (rows: readonly { _id: string }[]) => rows.map((r) => r._id.slice(8, 9)).join("");
const hydrate = (keys: string) => gqlEntry({ root: "sequences", view: "default", terms: { sequenceIds: [...keys].map((k) => `SeqLight${k}00000001`) } },
  { results: [...keys].sort((a, b) => SET.find((s) => s._id[8] === b)!.createdAt.localeCompare(SET.find((s) => s._id[8] === a)!.createdAt))
    .map((k) => rawSeqCard({ _id: `SeqLight${k}00000001`, title: `Sequence ${k}`, postsCount: 7, user: ownerOf(k) })) }, "§11.1");
/** The owner a light row names, as its card names them. */
function ownerOf(k: string) {
  return SET.find((s) => s._id[8] === k)!.userId === OTHER
    ? { _id: OTHER, slug: "other_user", displayName: "Other User" }
    : { _id: EY, slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" };
}

describe("list_sequences templates and ordering", () => {
  it("the light set: the default view, limit 1000, enableTotal, at offsets 0, 1000 and 2000", () => {
    expect(sequenceSetOp(0).text).toBe("l: sequences(selector: {default: {}}, limit: 1000, offset: 0, enableTotal: true) { results { ...SEQ_LIGHT } totalCount }");
    expect(sequenceSetOp(2000).text).toBe("l: sequences(selector: {default: {}}, limit: 1000, offset: 2000, enableTotal: true) { results { ...SEQ_LIGHT } totalCount }");
    expect(sequenceSetOp(0).template).toBe("list_sequences");
  });

  it("any other offset is an internal error naming the template, so lightScan's callback passes its offset uncast", () => {
    for (const offset of [-1000, 1, 500, 3000]) {
      expect(() => sequenceSetOp(offset), String(offset)).toThrow("Unexpected failure in list_sequences (offset must be 0, 1000 or 2000)");
    }
  });

  it("P4 site_order for all public sequences is newest first; hidden ones never appear", () => {
    expect(ids(orderSequences(SET, { curated: false, af: false }, "site_order"))).toBe("CABDE");
  });

  it("a person's site_order: their profile order (unset first, then newest), hideFromAuthorPage left out", () => {
    expect(ids(orderSequences(SET, { userId: EY, curated: false, af: false }, "site_order"))).toBe("BEA");
  });

  it("Q70 curated means curatedOrder set; rank higher first, ties newer first; with a person, their profile order", () => {
    expect(ids(orderSequences(SET, { curated: true, af: false }, "site_order"))).toBe("CAE");
    expect(ids(orderSequences(SET, { userId: EY, curated: true, af: false }, "site_order"))).toBe("EA");
  });

  it("af_only keeps AF sequences; new and old by creation date", () => {
    expect(ids(orderSequences(SET, { curated: false, af: true }, "site_order"))).toBe("BE");
    expect(ids(orderSequences(SET, { curated: false, af: false }, "new"))).toBe("CABDE");
    expect(ids(orderSequences(SET, { curated: false, af: false }, "old"))).toBe("EDBAC");
  });

  it("ties are broken newer first, then by id descending, in every order", () => {
    const day = "2024-05-05T00:00:00.000Z";
    const tied = [seq("1", { createdAt: day }), seq("3", { createdAt: day }), seq("2", { createdAt: day })];
    for (const sort of ["site_order", "new", "old"] as const) expect(ids(orderSequences(tied, { curated: false, af: false }, sort)), sort).toBe("321");
    expect(ids(orderSequences(tied, { userId: EY, curated: false, af: false }, "site_order"))).toBe("321");
    expect(ids(orderSequences(tied, { curated: true, af: false }, "site_order"))).toBe("");
  });

  it("the rows it is given are left as they were", () => {
    const before = SET.map((s) => s._id);
    orderSequences(SET, { curated: false, af: false }, "old");
    expect(SET.map((s) => s._id)).toEqual(before);
  });

  it("effective values", () => {
    const p = tool.schema.parse({ user: "eliezer_yudkowsky" }) as Parameters<typeof listSequencesEffective>[0];
    expect(listSequencesEffective(p, { userId: EY })).toEqual({ user: EY, curated_only: false, af_only: false, sort: "site_order", limit: 10 });
    // A key for every parameter but cursor and max_tokens, absent values included.
    expect(Object.hasOwn(listSequencesEffective(p, {}), "user")).toBe(true);
  });
});

describe("list_sequences: the light set", () => {
  it("Q70 a short raw page is not the end; the set is then cached", async () => {
    const h = createHarness({
      families: ["sequences"], extra: [sequenceSetEntry(seqLightRows("SeqShortA", 990), 0, 1764), sequenceSetEntry(seqLightRows("SeqShortB", 600), 1000, 600)],
    });
    const ctx = createCallContext("list_sequences", { now: h.clock.now });
    const set = await loadSequenceSet(ctx, h.services);
    expect(set.rows).toHaveLength(1590);
    expect(set.maybeMore).toBe(false);
    expect(gqlTexts(h.forum)[1]).toContain("offset: 1000, enableTotal: true");
    await loadSequenceSet(createCallContext("list_sequences", { now: h.clock.now }), h.services);
    expect(h.forum.requests).toHaveLength(2);
  });

  it("a short first raw page is the whole set: one request, hidden rows dropped, nothing more may exist", async () => {
    const h = createHarness({ families: ["sequences"], extra: [sequenceSetEntry(SET, 0, 764)] });
    const set = await loadSequenceSet(createCallContext("list_sequences", { now: h.clock.now }), h.services);
    expect(ids(set.rows)).toBe("ABCDE");
    expect(set.maybeMore).toBe(false);
    expect(h.forum.requests).toHaveLength(1);
  });

  it("three full raw pages: the last page says more may exist", async () => {
    const h = createHarness({ families: ["sequences"], extra: fullSequenceSet() });
    const pages = [await h.call("list_sequences", { limit: 50 })];
    for (let c = printedCursor(pages[0].text); c; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("list_sequences", { cursor: c }));
    expect(pages).toHaveLength(60);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of reachable results: the forum returned the most this server requests (3,000); more may exist.")).toBe(true);
    expect(pages.slice(0, -1).some((p) => p.text.includes("more may exist"))).toBe(false);
    expect(h.forum.requests.filter((r) => r.body.includes("limit: 1000"))).toHaveLength(3);
  });

  it("a third raw page that is short ends the set without saying more may exist", async () => {
    const h = createHarness({
      families: ["sequences"],
      extra: [sequenceSetEntry(seqLightRows("SeqThirdA", 1000), 0, 2600), sequenceSetEntry(seqLightRows("SeqThirdB", 1000), 1000, 2600), sequenceSetEntry(seqLightRows("SeqThirdC", 600), 2000, 600)],
    });
    const set = await loadSequenceSet(createCallContext("list_sequences", { now: h.clock.now }), h.services);
    expect(set.rows).toHaveLength(2600);
    expect(set.maybeMore).toBe(false);
    expect(h.forum.requests).toHaveLength(3);
  });
});

describe("list_sequences: the tool", () => {
  it("P4 P10 all public sequences: the set plus one hydrate, ~N posts, the cover-image note; hidden ones and the raw total never shown", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 764), hydrate("CABDE")] });
    const out = await h.call("list_sequences", {});
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text.split("\n")[0]).toBe("list_sequences — all public sequences");
    expect(out.text).toContain("sort site_order (default)");
    expect(out.text).toContain("~7 posts (site counter)");
    expect(out.text).toContain("The site's curated and community pages show only sequences with a cover image; this list includes all.");
    expect(out.text).not.toContain("SeqLightH00000001");
    expect(out.text).not.toContain("764");
    expect(gqlTexts(h.forum)[0]).not.toContain("gridImageId");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("R10 a person's sequences: resolve, set, hydrate; printed in the local order, not the hydrate's", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("BEA")] });
    const out = await h.call("list_sequences", { user: "eliezer_yudkowsky" });
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text.split("\n")[0]).toBe('list_sequences — sequences by "Eliezer Yudkowsky"');
    const at = (k: string) => out.text.indexOf(`sequence_id SeqLight${k}00000001`);
    expect(at("B")).toBeGreaterThan(0);
    expect(at("B")).toBeLessThan(at("E"));
    expect(at("E")).toBeLessThan(at("A"));
    expect(out.text).not.toContain("SeqLightD00000001");
  });

  it("¶3.5 af_only keeps the AF sequences in order and says how many it removed", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("BE")] });
    const out = await h.call("list_sequences", { af_only: true });
    expect(out.text).toContain("af_only removed 3 sequences not on the Alignment Forum");
    expect(out.text.indexOf("sequence_id SeqLightB00000001")).toBeLessThan(out.text.indexOf("sequence_id SeqLightE00000001"));
    expect(out.text).not.toContain("SeqLightA00000001");
  });

  it("¶2.2 step 5 a slow first raw page leaves no time for the rest of the set: the timeout error, and nothing is cached", async () => {
    const h = createHarness({ families: ["sequences"], extra: [sequenceSetEntry(seqLightRows("SeqSlowA", 1000), 0, 1764)] });
    h.forum.inject({ endpoint: "graphql", delayMs: 41_000, times: 1 });
    expect((await h.call("list_sequences", {})).text).toBe(
      "Error (timeout): The forum did not answer in time while running list_sequences (about 50 s per call). Large discussions can be slow; try again, or narrow the request.",
    );
    expect(h.forum.requests).toHaveLength(1);
    expect(h.services.caches.get("seqset", "all")).toBeUndefined();
  });

  it("the empty filtered-list text restates the filters", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET.filter((s) => s.curatedOrder === null), 0, 2)] });
    const out = await h.call("list_sequences", { user: "eliezer_yudkowsky", curated_only: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('No sequences match: by "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky), curated.');
  });

  it("paging continues in the cached set; one hydrate per page", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("CA"), hydrate("BD"), hydrate("E")] });
    const first = await h.call("list_sequences", { limit: 2 });
    expect(first.text).toContain("(next: items 3–4)");
    const second = await h.call("list_sequences", { cursor: printedCursor(first.text)! });
    expect(second.text).toContain("sequence_id SeqLightB00000001");
    expect(h.forum.requests).toHaveLength(3);
  });

  it("an unknown person is not_found before the set is read", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6)] });
    const out = await h.call("list_sequences", { user: "no_such_person" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Error (not_found): No publicly visible user has the slug \"no_such_person\"");
    expect(h.forum.requests).toHaveLength(1);
  });

  it("an empty set restates that there are no filters", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry([], 0, 0)] });
    const out = await h.call("list_sequences", {});
    expect(out.isError).toBe(false);
    expect(out.text).toContain("No sequences match: all public sequences.");
    expect(out.text).not.toContain("Position:");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(1);
  });
});

describe("list_sequences: pages and continuations", () => {
  it("a page cut by the budget continues right after the last sequence shown: every sequence once, in order", async () => {
    const t0 = Date.parse("2022-01-01T00:00:00.000Z");
    const rows = seqLightRows("SeqCutA", 40).map((row, i) => ({ ...row, createdAt: new Date(t0 + (40 - i) * 86_400_000).toISOString() }));
    const all = rows.map((r) => r._id);
    const description = "A long description of what this sequence is about. ".repeat(6);
    // The hydrate a continuation sends depends on where the budget cut the page before it: one entry for each possible start.
    const hydrates = all.map((_, from) => gqlEntry(
      { root: "sequences", view: "default", terms: { sequenceIds: all.slice(from) } },
      { results: all.slice(from).map((id) => rawSeqCard({ _id: id, title: id, contents: { plaintextDescription: description } })) }, "§11.1",
    ));
    const h = createHarness({ families: ["sequences"], extra: [sequenceSetEntry(rows, 0, 40), ...hydrates] });
    const pages = [await h.call("list_sequences", { limit: 40, max_tokens: 2000 })];
    for (let c = printedCursor(pages[0].text); c; c = printedCursor(pages.at(-1)!.text)) pages.push(await h.call("list_sequences", { cursor: c }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => !p.isError)).toBe(true);
    expect(pages.flatMap((p) => [...p.text.matchAll(/sequence_id (SeqCutA\d{10})/g)].map((m) => m[1]))).toEqual(all);
    expect(pages[1].text).toMatch(/Position: items \d+–\d+ of 40/);
    expect(pages.at(-1)!.text.trimEnd().endsWith("End of results.")).toBe(true);
    expect(h.forum.requests).toHaveLength(1 + pages.length);
  });

  it("P4 a card the forum hides, or does not return, is skipped; the cursor still continues after the page", async () => {
    const card = (k: string, o: object = {}) => rawSeqCard({ _id: `SeqLight${k}00000001`, title: `Sequence ${k}`, ...o });
    const dropped = gqlEntry(
      { root: "sequences", view: "default", terms: { sequenceIds: ["C", "A", "B"].map((k) => `SeqLight${k}00000001`) } },
      { results: [card("C", { hidden: true }), card("A")] }, "§11.1",
    );
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), dropped] });
    const out = await h.call("list_sequences", { limit: 3 });
    expect(out.text).toContain("sequence_id SeqLightA00000001");
    expect(out.text).not.toContain("SeqLightC00000001");
    expect(out.text).not.toContain("SeqLightB00000001");
    expect(out.text).toContain("Position: items 1–3 of 5");
    expect(out.text).toContain("(next: items 4–5)");
  });

  it("¶3.6 a changed parameter with the cursor is bad_input; the same call pasted back whole continues; another person is refused", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("BE"), hydrate("A")] });
    const first = await h.call("list_sequences", { user: "eliezer_yudkowsky", limit: 2 });
    expect(first.text).toContain("(next: items 3–3)");
    const cursor = printedCursor(first.text)!;
    const changed = await h.call("list_sequences", { cursor, sort: "new" });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain('this cursor was issued for different parameters (sort: cursor has "site_order", call has "new")');
    const other = await h.call("list_sequences", { user: "paulfchristiano", cursor });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("this cursor was issued for different parameters (user:");
    const whole = await h.call("list_sequences", { user: "eliezer_yudkowsky", limit: 2, cursor });
    expect(whole.isError).toBe(false);
    expect(whole.text).toContain("sequence_id SeqLightA00000001");
    expect(whole.text).not.toContain("sequence_id SeqLightB00000001");
    expect(whole.text.split("\n")[0]).toBe('list_sequences — sequences by "Eliezer Yudkowsky"');
    expect(whole.text.trimEnd().endsWith("End of results.")).toBe(true);
  });

  it("D1 a person's list continued with the cursor alone after the resolution cache lapsed: the person is resolved again by id, the next page follows, no drift note", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("BE"), hydrate("A")] });
    const first = await h.call("list_sequences", { user: "eliezer_yudkowsky", limit: 2 });
    expect(h.forum.requests).toHaveLength(3);
    h.clock.advance(31 * 60_000); // the resolution (30 min) and the set (10 min) both lapsed
    const second = await h.call("list_sequences", { cursor: printedCursor(first.text)! });
    expect(second.isError).toBe(false);
    const texts = gqlTexts(h.forum);
    expect(texts).toHaveLength(6);
    expect(texts[3]).toContain('user(selector: {_id: "nmk3nLpQE89dMRzzN"}');   // the stored effective value is the id, not the slug
    expect(texts[4]).toContain("l: sequences(");
    expect(second.text.split("\n")[0]).toBe('list_sequences — sequences by "Eliezer Yudkowsky"');
    expect(second.text).toContain("sequence_id SeqLightA00000001");
    expect(second.text).not.toContain("SeqLightB00000001");
    expect(second.text).not.toContain("The list changed");
    expect(second.text.trimEnd().endsWith("End of results.")).toBe(true);
    expectClean(h);
  });

  it("D1 after the cached set expired within the cursor's hour the set is read again, the page resumes after the last sequence shown, with the drift note", async () => {
    const h = createHarness({ families: ["sequences", "users"], extra: [sequenceSetEntry(SET, 0, 6), hydrate("CA"), hydrate("BD")] });
    const first = await h.call("list_sequences", { limit: 2 });
    expect(first.text).toContain("sequence_id SeqLightC00000001");
    h.clock.advance(11 * 60_000);
    // The next read of the set sees a sequence published meanwhile, newer than all the rest.
    const newer = seq("N", { createdAt: "2026-06-01T00:00:00.000Z" });
    h.forum.inject({
      endpoint: "graphql", when: (body) => body.includes("l: sequences("), times: 1,
      body: JSON.stringify({ data: { l: { results: [...SET, newer], totalCount: 7 } } }),
    });
    const second = await h.call("list_sequences", { cursor: printedCursor(first.text)! });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("The list changed since the previous page (1 new item); positions may have shifted.");
    expect(second.text).toContain("sequence_id SeqLightB00000001");
    expect(second.text).not.toContain("sequence_id SeqLightN00000001");
    expect(h.forum.requests.filter((r) => r.body.includes("l: sequences("))).toHaveLength(2);
  });
});
