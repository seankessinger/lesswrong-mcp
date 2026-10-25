import { describe, expect, it, vi } from "vitest";
import { collectionOp, getSequenceRequest1Ops, getSequenceRequest2Ops } from "../../src/forum/templates/get_sequence";
import type { ParsedRef, PublicSequenceId, RawPostCard } from "../../src/types";
import { loadFamilies, type FixtureEntry } from "../support/fixtures";
import { estimateTokens } from "../../src/render/budget";
import { fence } from "../../src/render/layout";
import { gqlEntry, rawPostCard, rawPostFull, rawSeqCard, rawSeqRef } from "../support/builders";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, printedCursor } from "../support/requests";

const PW = "5g5TkQTe9rmPS5vvM";
const BS = "BiasesSequence001";
const FAMILIES = ["sequences", "posts", "users", "tags"] as const;
const postRef = (form: ParsedRef["form"], value: string): ParsedRef => ({ kind: "post", form, value, given: "id", notes: [] });

describe("get_sequence templates", () => {
  it("the collection: books with sequenceIds and SEQ_CARD sequences", () => {
    expect(collectionOp("oneQyj4pw77ynzwAF").text).toBe('c: collection(selector: {_id: "oneQyj4pw77ynzwAF"}) { result { _id title slug contents { markdown } books { _id title number postedAt sequenceIds sequences { ...SEQ_CARD } } } }');
  });

  it("request 1: the sequence, plus the given post with its canonical sequence", () => {
    expect(getSequenceRequest1Ops(PW).map((o) => o.text)).toEqual([
      's: sequence(selector: {_id: "5g5TkQTe9rmPS5vvM"}, allowNull: true) { result { ...SEQ_CARD contents { markdown } } }',
    ]);
    expect(getSequenceRequest1Ops(PW, postRef("id", "uMQ3cqWDPHhjtiesc"))[1].text)
      .toBe('p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_REF canonicalSequence { ...SEQ_REF } } }');
    expect(getSequenceRequest1Ops(PW, { kind: "post", form: "slug", value: "the-martial-art-of-rationality", given: "slug", notes: [] })[1].text)
      .toBe('ps: posts(selector: {slugPost: {slug: "the-martial-art-of-rationality"}}, limit: 2) { results { ...POST_REF canonicalSequence { ...SEQ_REF } } }');
  });

  it("request 1: a bare 17-character post sends both halves, an LW1 id its own alias, and every op names its template", () => {
    const both = getSequenceRequest1Ops(PW, postRef("idOrSlug", "uMQ3cqWDPHhjtiesc"));
    expect(both.map((o) => o.alias)).toEqual(["s", "p", "ps"]);
    const legacy = getSequenceRequest1Ops(PW, postRef("legacy", "2bz"));
    expect(legacy.map((o) => o.text)[1]).toBe('pl: posts(selector: {legacyIdPost: {legacyId: "2bz"}}, limit: 1) { results { ...POST_REF canonicalSequence { ...SEQ_REF } } }');
    expect([...both, ...legacy].every((o) => o.template === "get_sequence_req1")).toBe(true);
    expect(() => getSequenceRequest1Ops(PW, postRef("word", "original"))).toThrow("Unexpected failure in get_sequence_req1 (a post given as word). Please report this.");
    expect(collectionOp("oneQyj4pw77ynzwAF").template).toBe("get_sequence_collection");
    expect(getSequenceRequest2Ops({ sequenceId: PW as PublicSequenceId, listing: true }).every((o) => o.template === "get_sequence_req2")).toBe(true);
  });

  it("Q62 P14 request 2: chapters with POST_CARD posts, stats, and the listing only when asked", () => {
    const ops = getSequenceRequest2Ops({ sequenceId: PW as PublicSequenceId, listing: true });
    expect(ops.map((o) => o.text)).toEqual([
      'ch: chapters(selector: {SequenceChapters: {sequenceId: "5g5TkQTe9rmPS5vvM"}}, limit: 500) { results { _id title number posts { ...POST_CARD } } }',
      'st: getSequenceStats(sequenceId: "5g5TkQTe9rmPS5vvM") { totalWordCount totalReadTime }',
      'col: collections(selector: {default: {}}, limit: 10) { results { _id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } } } }',
    ]);
    expect(getSequenceRequest2Ops({ sequenceId: PW as PublicSequenceId, listing: false }).map((o) => o.alias)).toEqual(["ch", "st"]);
    expect(ops.map((o) => o.text).join(" ")).not.toContain("postIds");
  });
});

describe("get_sequence: a sequence", () => {
  it("Q62 Q50.35 Q50.36 two requests; header, counts with site figures, posts chapter by chapter", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text.split("\n")[0]).toBe('get_sequence — "A Sequence on Biases"');
    expect(out.text).toContain('Sequence "A Sequence on Biases" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky) · sequence_id BiasesSequence001 · https://www.lesswrong.com/s/BiasesSequence001 · LW only');
    expect(out.text).toContain("3 chapters · 8 publicly visible posts · ~12,027 words · ~47 min reading (site figures)");
    expect(out.text).not.toContain("~99");
    expect(out.text).toContain("Position: posts 1–8 of 8");
    expect(out.text).toContain("Chapter 1");
    expect(out.text).toContain('Chapter 2 · "Biases"');
    expect(out.text).toMatch(/--- begin text [0-9a-f]{6} \(sequence description; written by forum users\) ---/);
    const order = [1, 3, 4, 5, 6, 7, 8, 9].map((n) => out.text.indexOf(`post_id BsPost0000000000${n}`));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expectClean(h);
  });

  it("P2 P3 P7 P14 only public posts, unlisted and sub-question ones flagged; no anonymous author or hidden id printed", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS });
    expect(out.text).not.toContain("BsPost00000000002");
    expect(out.text).toContain("reachable by link only");
    expect(out.text).toContain("post_id BsPost00000000006");
    expect(out.text).toContain("sub-question (not in the site's main lists)");
    expect(out.text).toContain("author not publicly visible");
    expect(out.text).not.toContain("PLANTEDhiddenPst1");
  });

  it("Q62 Q102 P4 deleted → not_public and unknown → not_found with no chapters or stats request; hidden → shown flagged", async () => {
    const h = createHarness({ families: FAMILIES });
    const deleted = await h.call("get_sequence", { sequence: "deletedSeq0000001" });
    expect(deleted.text).toMatch(/^Error \(not_public\): The forum refuses to show .* it is a sequence that is not publicly visible/);
    const unknown = await h.call("get_sequence", { sequence: "UnknownSequence01" });
    expect(unknown.text).toBe('Error (not_found): No publicly visible sequence has the id "UnknownSequence01".');
    expect(gqlTexts(h.forum).join("\n")).not.toMatch(/SequenceChapters|getSequenceStats/);
    const hidden = await h.call("get_sequence", { sequence: "HiddenSequence001" });
    expect(hidden.text).toContain("not in the site's sequence lists");
    expect(hidden.text).toContain("post_id HiddenSeqPost0001");
  });

  it("af_only keeps the AF posts in order and says how many it removed", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS, af_only: true });
    expect(out.text).toContain("af_only removed 6 posts not on the Alignment Forum");
    expect(out.text.indexOf("BsPost00000000003")).toBeLessThan(out.text.indexOf("BsPost00000000007"));
    expect(out.text).not.toContain("post_id BsPost00000000001");
  });

  it("the list cursor repeats the chapter header when a page starts mid-chapter", async () => {
    const h = createHarness({ families: FAMILIES });
    const first = await h.call("get_sequence", { sequence: BS, limit: 3 });
    expect(first.text).toContain("More available: call get_sequence with cursor");
    expect(first.text).toContain("(next: posts 4–6)");
    const second = await h.call("get_sequence", { cursor: printedCursor(first.text)! });
    expect(second.text).toContain('Chapter 2 · "Biases"');
    expect(second.text).toContain("post_id BsPost00000000005");
    expect(second.text).not.toContain("post_id BsPost00000000004");
    expect(h.forum.requests).toHaveLength(2);
  });
});

describe("get_sequence: a marked post", () => {
  it("L4 the last post of a sequence in a numbered collection: next is the first post of the adjacent visible sequence (3 requests)", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: PW, post: "pwLastPost0000001" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2]).toContain('SequenceChapters: {sequenceId: "fakeBeliefsSeq001"}');
    expect(out.text).toContain('Position: post 2 of 2 · previous: "Preface" (post_id pwFirstPost000001, LW only) · next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    expect(out.text).toContain("→ 2.");
    expect(out.text).not.toContain("come before this");
    expect(out.text).not.toContain("hiddenSeq00000001");
    expectClean(h);
  });

  it("¶2.2 step 5 the boundary neighbour is optional: past 40 s it is not requested; the adjacent sequence is named without its post and the page stops early with a cursor", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("getSequenceStats"), delayMs: 41_000 });
    const out = await h.call("get_sequence", { sequence: PW, post: "pwLastPost0000001" });
    expect(h.forum.requests).toHaveLength(2);
    expect(out.isError).toBe(false);
    expect(out.text).toContain('next: in the next sequence of rationality: "Fake Beliefs" (sequence_id fakeBeliefsSeq001)');
    expect(out.text).toMatch(/Stopped early \(time limit\); call get_sequence with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  it("a marked post in a later chapter: the page starts at its chapter, with the note; outside any collection next is none (2 requests)", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS, post: "BsPost00000000009" });
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain('Position: post 8 of 8 · previous: "The Eighth Post" (post_id BsPost00000000008, LW only) · next: none');
    expect(out.text).toContain("Chapters 1–2 (posts 1–5) come before this; call get_sequence without post to read from the start");
    expect(out.text).toContain("→ 8.");
    expect(out.text).not.toContain("post_id BsPost00000000001");
    expectClean(h);
  });

  it("a post not in this sequence: said, with its canonical sequence (a hidden one named with its flag)", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS, post: "OtherSeqPost00001" });
    expect(out.text).toContain("This post is not in this sequence.");
    expect(out.text).toContain(`The site's canonical sequence for this post: "A hidden sequence" (sequence_id HiddenSequence001, LW only, not in the site's sequence lists)`);
    expect(out.text).toContain("post_id BsPost00000000001");
  });

  it("a post that differs from the URL's post part is bad_input before any request; the URL alone marks its post", async () => {
    const h = createHarness({ families: FAMILIES });
    const url = "https://www.lesswrong.com/s/BiasesSequence001/p/BsPost00000000009";
    const bad = await h.call("get_sequence", { sequence: url, post: "BsPost00000000008" });
    expect(bad.text).toBe('Error (bad_input): post: "BsPost00000000008" differs from the post in the sequence URL ("BsPost00000000009"). Give one of them.');
    expect(h.forum.requests).toHaveLength(0);
    const ok = await h.call("get_sequence", { sequence: url });
    expect(ok.text).toContain("Position: post 8 of 8");
  });
});

describe("get_sequence: collections", () => {
  it("L4 P4 P14 rationality: one request, books by number, titles trimmed, sequences in book order, hidden ones dropped", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: "rationality" });
    expect(h.forum.requests).toHaveLength(1);
    expect(out.text.split("\n")[0]).toBe('get_sequence — collection "Rationality: A-Z"');
    expect(out.text).toContain("collection_slug rationality");
    expect(out.text).toContain("Position: sequences 1–4 of 4");
    const at = (s: string) => out.text.indexOf(s);
    expect(at('Book 1 · "Map and Territory"')).toBeLessThan(at('Book 2 · "How to Actually Change Your Mind"'));
    expect(out.text).not.toContain('"Map and Territory "');
    expect(at("sequence_id 5g5TkQTe9rmPS5vvM")).toBeLessThan(at("sequence_id fakeBeliefsSeq001"));
    expect(at("sequence_id SeqThree000000001")).toBeLessThan(at("sequence_id SeqFour0000000001"));
    expect(out.text).not.toContain("hiddenSeq00000001");
    expectClean(h);
  });

  it("bestoflesswrong keeps the forum's book order and says it defines none", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: "bestoflesswrong" });
    expect(out.text).toContain("the forum defines no order for unnumbered books");
    const at = (s: string) => out.text.indexOf(s);
    expect(at("BestOfBookA")).toBe(-1);
    expect(at("Book · ")).toBeGreaterThan(0);
    // The forum's order (BestOfBookA..D: number null, 1, null, null), not a sort by number: the numbered 2019 book stays second.
    expect(at('"The 2018 Review"')).toBeLessThan(at('"The 2019 Review"'));
    expect(at('"The 2019 Review"')).toBeLessThan(at('"The 2020 Review"'));
    expect(at('"The 2020 Review"')).toBeLessThan(at('"The 2021 Review"'));
  });

  it("af_only on a collection keeps AF sequences and counts the removed ones", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: "rationality", af_only: true });
    expect(out.text).toContain("af_only removed 3 sequences not on the Alignment Forum");
    expect(out.text).toContain("sequence_id SeqThree000000001");
  });

  it("a misspelt collection slug is bad_input listing the 5 slugs (one wording for one error: ids/parse's)", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: "rationalty" });
    expect(out.text).toBe('Error (bad_input): sequence: "rationalty" is not a sequence id, URL or collection slug (rationality, codex, hpmor, highlights, bestoflesswrong). To look up a sequence by title, use find {items: [{kind: "sequence", query: "rationalty"}]}.');
    expect(h.forum.requests).toHaveLength(0);
  });
});

// Beyond the cases above: marked posts that are refused or filtered, the neighbours on either side, the continuation rules and
// the Partial lines.
const RAT = "oneQyj4pw77ynzwAF";
const MID = "MidSequence000001";
const BS_REF = { ...rawSeqRef({ _id: BS, title: "A Sequence on Biases" }), canonicalCollectionSlug: null };
const SLOW = "Something went wrong";
const card = (id: string, title: string, o: Partial<RawPostCard> = {}): RawPostCard =>
  rawPostCard({ _id: id, title, slug: title.toLowerCase().replace(/ /g, "-"), af: false, ...o });
/** A `post` document of the Biases sequence, for the posts the family fixtures do not hold. */
const bsPostEntry = (n: number): FixtureEntry => {
  const id = `BsPost0000000000${n}`;
  return gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: `Post ${n}`, slug: `post-${n}`, canonicalSequenceId: BS, canonicalSequence: BS_REF }) }, "§11.4");
};
/** A sequence of the rationality collection with one chapter: its document, chapters, stats and the `post` documents of its posts. */
function inRationality(id: string, title: string, posts: RawPostCard[]): FixtureEntry[] {
  const canonical = { ...rawSeqRef({ _id: id, title }), canonicalCollectionSlug: "rationality" };
  return [
    gqlEntry({ root: "sequence", id }, { result: rawSeqCard({ _id: id, title, contents: { plaintextDescription: "d", markdown: "d" } }) }, "§11.1"),
    gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: id }, limit: 500 }, { results: [{ _id: `${id}Chapter`.slice(0, 17), title: null, subtitle: null, number: 1, posts }] }, "§11.2"),
    gqlEntry({ root: "getSequenceStats", args: { sequenceId: id } }, { totalWordCount: 10, totalReadTime: 1 }, "§11.3"),
    ...posts.map((p) => gqlEntry(
      { root: "post", id: p._id },
      { result: rawPostFull({ _id: p._id, title: p.title, slug: p.slug, canonicalSequenceId: id, canonicalCollectionSlug: "rationality", canonicalSequence: canonical }) },
      "§11.4",
    )),
  ];
}
/** The collections listing with one numbered book of rationality holding `sequences` in this order. */
const rationalityBook = (sequences: [string, string][]): FixtureEntry => gqlEntry(
  { root: "collections", view: "default", limit: 10 },
  {
    results: [{
      _id: RAT, slug: "rationality", title: "Rationality: A-Z",
      books: [{
        _id: "midBook", title: "Mid", subtitle: null, number: 1, postedAt: "2018-12-01T00:00:00.000Z",
        sequenceIds: sequences.map(([id]) => id), sequences: sequences.map(([id, title]) => rawSeqRef({ _id: id, title })),
      }],
    }],
  },
  "§11.5",
);
const failing = (match: FixtureEntry["match"]): FixtureEntry => ({ source: "§11.2", match, error: { message: SLOW } });
const withoutCursors = (text: string): string => text.replace(/c_[A-Za-z0-9_-]{22}/g, "c_…");

describe("get_sequence: marked posts that are refused or filtered", () => {
  it("P1 P2 P3 a marked post that is unknown, rejected or refused reads as the usual post error, before any chapters request", async () => {
    const h = createHarness({ families: FAMILIES });
    // ¶8: a bare 17-character string, tried as id and as slug, reads in the slug form with the find hint; hidden and unknown alike
    const postNotFound = (x: string) =>
      `Error (not_found): No publicly visible post has the slug "${x}". Slugs are case-sensitive; to look up a name use find {items: [{kind: "post", query: "${x}"}]}. Renamed posts lose their earlier slugs; the id in a URL always works.`;
    expect((await h.call("get_sequence", { sequence: BS, post: "rejectedPost00001" })).text).toBe(postNotFound("rejectedPost00001"));
    expect((await h.call("get_sequence", { sequence: BS, post: "AAAAAAAAAAAAAAAAA" })).text).toBe(postNotFound("AAAAAAAAAAAAAAAAA"));
    expect((await h.call("get_sequence", { sequence: BS, post: "draftPost00000001" })).text)
      .toMatch(/^Error \(not_public\): The forum refuses to show the post with the id "draftPost00000001" to logged-out readers/);
    expect(gqlTexts(h.forum).join("\n")).not.toMatch(/SequenceChapters|getSequenceStats/);
  });

  it("an LW1 id or URL as post is read by its own alias", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: BS, post: "https://www.lesswrong.com/lw/g/some-title" });
    expect(gqlTexts(h.forum)[0]).toContain('legacyIdPost: {legacyId: "g"}');
    expect(out.text).toContain('post → "Some Title" (post_id lw1Post0000000016)');
    expect(out.text).toContain("This post is not in this sequence.");
    expect(out.text).not.toContain("The site's canonical sequence for this post");
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("a post given as a slug is compared with the URL's post part by the id it resolves to", async () => {
    const h = createHarness({ families: FAMILIES });
    const url = "https://www.lesswrong.com/s/BiasesSequence001/p/BsPost00000000009";
    const out = await h.call("get_sequence", { sequence: url, post: "agi-ruin-a-list-of-lethalities" });
    expect(out.text).toBe('Error (bad_input): post: "agi-ruin-a-list-of-lethalities" differs from the post in the sequence URL ("BsPost00000000009"). Give one of them.');
    expect(h.forum.requests).toHaveLength(1);
    const same = await h.call("get_sequence", { sequence: url, post: "BsPost00000000009" });
    expect(same.text).toContain("Position: post 8 of 8");
  });

  it("af_only filters before the post is located: its position is among the AF posts, and a non-AF post is said to be left out", async () => {
    const h = createHarness({ families: FAMILIES, extra: [gqlEntry({ root: "post", id: "BsPost00000000007" }, { result: rawPostFull({ _id: "BsPost00000000007", title: "Post 7", slug: "post-7", af: true, canonicalSequenceId: BS, canonicalSequence: BS_REF }) }, "§11.4")] });
    const marked = await h.call("get_sequence", { sequence: BS, post: "BsPost00000000007", af_only: true });
    expect(marked.text).toContain('Position: post 2 of 2 · previous: "Post 3" (post_id BsPost00000000003, AF) · next: none');
    expect(marked.text).toContain("Chapters 1–2 (post 1) come before this;");
    expect(marked.text).toContain("af_only removed 6 posts not on the Alignment Forum");
    const left = await h.call("get_sequence", { sequence: BS, post: "BsPost00000000009", af_only: true });
    expect(left.text).toContain("This post is in this sequence but not on the Alignment Forum, so af_only leaves it out.");
    expect(left.text).not.toContain("This post is not in this sequence.");
    expect(left.text).toContain("Position: posts 1–2 of 2");
  });

  it("a chapter before the marked one is told in the singular", async () => {
    const h = createHarness({ families: FAMILIES, extra: [bsPostEntry(5)] });
    const out = await h.call("get_sequence", { sequence: BS, post: "BsPost00000000005", limit: 1 });
    expect(out.text).toContain("Chapter 1 (posts 1–2) comes before this; call get_sequence without post to read from the start.");
    expect(out.text).toContain('Position: post 4 of 8 · previous: "Post 4" (post_id BsPost00000000004, LW only, reachable by link only) · next: "Post 6"');
  });

  it("the curated rank of a sequence that has one is in its header", async () => {
    const h = createHarness({
      families: FAMILIES,
      extra: [gqlEntry({ root: "sequence", id: BS }, { result: rawSeqCard({ _id: BS, title: "A Sequence on Biases", canonicalCollectionSlug: null, curatedOrder: 1200, contents: { plaintextDescription: "d", markdown: "d" } }) }, "§11.1")],
    });
    expect((await h.call("get_sequence", { sequence: BS })).text).toContain("· LW only · curated rank 1,200\n");
  });

  it("af_only that removes every item says so, for posts and for sequences", async () => {
    const h = createHarness({ families: FAMILIES });
    const posts = await h.call("get_sequence", { sequence: "HiddenSequence001", af_only: true });
    expect(posts.text).toContain("af_only removed 1 post not on the Alignment Forum");
    expect(posts.text).toContain("No posts match: AF only.");
    expect(posts.text.split("\n").at(-1)).toBe("End of results.");
    const sequences = await h.call("get_sequence", { sequence: "bestoflesswrong", af_only: true });
    expect(sequences.text).toContain("af_only removed 4 sequences not on the Alignment Forum");
    expect(sequences.text).toContain('No sequences match: in collection "Best of LessWrong", AF only.');
  });

  it("a post cannot be combined with a collection", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: "rationality", post: "pwLastPost0000001" });
    expect(out.text).toBe("Error (bad_input): post: can't be combined with a collection. Give a sequence with post, or a collection without it.");
    expect(h.forum.requests).toHaveLength(0);
  });
});

describe("get_sequence: the neighbours on either side", () => {
  it("Q101 L4 the first post of a sequence: previous is the last post of the preceding sequence, next stays inside (request 3 reads one sequence)", async () => {
    const posts = [card("MidPostFirst00001", "Mid First"), card("MidPostSecond0001", "Mid Second")];
    const h = createHarness({ families: FAMILIES, extra: [...inRationality(MID, "The Middle", posts), rationalityBook([[PW, "Predictably Wrong"], [MID, "The Middle"]])] });
    const out = await h.call("get_sequence", { sequence: MID, post: "MidPostFirst00001" });
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text).toContain('Position: post 1 of 2 · previous: "The Last Post of Predictably Wrong" (post_id pwLastPost0000001, LW only, in the previous sequence of rationality: "Predictably Wrong") · next: "Mid Second" (post_id MidPostSecond0001, LW only)');
    expect(gqlTexts(h.forum)[2]).toContain(`SequenceChapters: {sequenceId: "${PW}"}`);
    expectClean(h);
  });

  it("Q101 a one-post sequence between two: both neighbours come from one request 3", async () => {
    const h = createHarness({
      families: FAMILIES,
      extra: [...inRationality(MID, "The Middle", [card("MidPostOnly000001", "Mid Only")]), rationalityBook([[PW, "Predictably Wrong"], [MID, "The Middle"], ["fakeBeliefsSeq001", "Fake Beliefs"]])],
    });
    const out = await h.call("get_sequence", { sequence: MID, post: "MidPostOnly000001" });
    expect(h.forum.requests).toHaveLength(3);
    expect(gqlTexts(h.forum)[2].match(/SequenceChapters/g)).toHaveLength(2);
    expect(out.text).toContain('Position: post 1 of 1 · previous: "The Last Post of Predictably Wrong" (post_id pwLastPost0000001, LW only, in the previous sequence of rationality: "Predictably Wrong") · next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
  });

  it("Q101 the ends of a collection have no neighbour (no request 3)", async () => {
    const h = createHarness({ families: FAMILIES });
    const out = await h.call("get_sequence", { sequence: PW, post: "pwFirstPost000001" });
    expect(out.text).toContain('Position: post 1 of 2 · previous: none · next: "The Last Post of Predictably Wrong" (post_id pwLastPost0000001, LW only)');
    expect(h.forum.requests).toHaveLength(2);
  });

  // af_only removes posts; it does not move the ends of the sequence. A side where only non-AF posts lie beyond the marked post is
  // not an end (nothing to name there, and no request 3 for it); at a real end the neighbour is the adjacent sequence's first or
  // last AF post, never a post af_only would have removed.
  it("¶4.9 af_only: a side with only non-AF posts beyond is none, and spends no request 3", async () => {
    const posts = [card("MidAfFirst0000001", "Mid AF First", { af: true }), card("MidNonAfLast00001", "Mid Non-AF Last")];
    const h = createHarness({ families: FAMILIES, extra: [...inRationality(MID, "The Middle", posts), rationalityBook([[MID, "The Middle"], ["fakeBeliefsSeq001", "Fake Beliefs"]])] });
    const out = await h.call("get_sequence", { sequence: MID, post: "MidAfFirst0000001", af_only: true });
    expect(out.text).toContain("Position: post 1 of 1 · previous: none · next: none");
    expect(out.text).not.toContain("fbFirstPost000001");
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });

  it("¶4.9 af_only: at the end of the sequence the neighbour is the first AF post of the adjacent sequence, not the post af_only removes", async () => {
    const posts = [card("MidNonAfFirst0001", "Mid Non-AF First"), card("MidAfLast00000001", "Mid AF Last", { af: true })];
    const fbPosts = [card("fbFirstPost000001", "Making Beliefs Pay Rent (in Anticipated Experiences)"), card("fbSecondAfPost001", "Second Belief", { af: true })];
    const fakeBeliefs = gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: "fakeBeliefsSeq001" }, limit: 500 }, { results: [{ _id: "fbChapter0000001", title: null, subtitle: null, number: 1, posts: fbPosts }] }, "§11.2");
    const h = createHarness({ families: FAMILIES, extra: [fakeBeliefs, ...inRationality(MID, "The Middle", posts), rationalityBook([[MID, "The Middle"], ["fakeBeliefsSeq001", "Fake Beliefs"]])] });
    const out = await h.call("get_sequence", { sequence: MID, post: "MidAfLast00000001", af_only: true });
    expect(out.text).toContain('Position: post 1 of 1 · previous: none · next: "Second Belief" (post_id fbSecondAfPost001, AF, in the next sequence of rationality: "Fake Beliefs")');
    expect(out.text).not.toContain("fbFirstPost000001");
    expect(h.forum.requests).toHaveLength(3);
    expectClean(h);
  });

  it("¶4.9 af_only: an adjacent sequence with no AF post is named alone, as for a stopped request", async () => {
    const posts = [card("MidNonAfFirst0001", "Mid Non-AF First"), card("MidAfLast00000001", "Mid AF Last", { af: true })];
    const h = createHarness({ families: FAMILIES, extra: [...inRationality(MID, "The Middle", posts), rationalityBook([[MID, "The Middle"], ["fakeBeliefsSeq001", "Fake Beliefs"]])] });
    const out = await h.call("get_sequence", { sequence: MID, post: "MidAfLast00000001", af_only: true });
    expect(out.text).toContain('Position: post 1 of 1 · previous: none · next: in the next sequence of rationality: "Fake Beliefs" (sequence_id fakeBeliefsSeq001)');
    expect(out.text).not.toContain("fbFirstPost000001");
    expect(h.forum.requests).toHaveLength(3);
  });

  it("Q20 bestoflesswrong: the adjacent sequence is not determined, and no request 3 is sent", async () => {
    const bol = "bolSequence000001";
    const h = createHarness({
      families: FAMILIES,
      extra: [
        gqlEntry({ root: "sequence", id: bol }, { result: rawSeqCard({ _id: bol, title: "Best of 2018", canonicalCollectionSlug: "bestoflesswrong", contents: { plaintextDescription: "d", markdown: "d" } }) }, "§11.5"),
        gqlEntry({ root: "getSequenceStats", args: { sequenceId: bol } }, { totalWordCount: 10, totalReadTime: 1 }, "§11.3"),
      ],
    });
    const out = await h.call("get_sequence", { sequence: bol, post: "bolLastPost000001" });
    const unordered = "the adjacent sequence in bestoflesswrong can't be determined reliably (the forum defines no order for its unnumbered books)";
    expect(out.text).toContain(`Position: post 1 of 1 · previous: ${unordered} · next: ${unordered}`);
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
  });
});

describe("get_sequence: Partial lines", () => {
  it("¶3.9 the site's figures failing leave the posts, with a Partial line and no figures", async () => {
    const h = createHarness({ families: FAMILIES, extra: [failing({ root: "getSequenceStats", args: { sequenceId: BS } })] });
    const out = await h.call("get_sequence", { sequence: BS });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: site word count and reading time unavailable (forum_error: Something went wrong).");
    expect(out.text).toContain("3 chapters · 8 publicly visible posts\n");
    expect(out.text).toContain("post_id BsPost00000000009");
  });

  it("¶3.9 a collection the forum fails to read is the call's error", async () => {
    const h = createHarness({ families: FAMILIES, extra: [failing({ root: "collection", id: RAT })] });
    const out = await h.call("get_sequence", { sequence: "rationality" });
    expect(out.text).toBe("Error (forum_error): The forum returned an error while reading the collection (Something went wrong). Try again later.");
  });

  it("¶3.9 the chapters failing are the call's error", async () => {
    const h = createHarness({ families: FAMILIES, extra: [failing({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: BS } })] });
    const out = await h.call("get_sequence", { sequence: BS });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Error \(forum_error\): The forum returned an error while reading the sequence's posts/);
  });

  it("¶3.9 an unreadable collections listing leaves the sides it would name out, with a Partial line", async () => {
    const h = createHarness({ families: FAMILIES, extra: [failing({ root: "collections", view: "default", limit: 10 })] });
    const out = await h.call("get_sequence", { sequence: PW, post: "pwLastPost0000001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: neighbouring sequence unavailable (forum_error: Something went wrong).");
    expect(out.text).toContain('Position: post 2 of 2 · previous: "Preface" (post_id pwFirstPost000001, LW only)\n');
    expect(h.forum.requests).toHaveLength(2);
  });

  it("¶3.9 request 3 failing names the adjacent sequence without its post, with a Partial line", async () => {
    const h = createHarness({ families: FAMILIES, extra: [failing({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: "fakeBeliefsSeq001" } })] });
    const out = await h.call("get_sequence", { sequence: PW, post: "pwLastPost0000001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Partial: neighbouring sequence unavailable (forum_error: Something went wrong).");
    expect(out.text).toContain('next: in the next sequence of rationality: "Fake Beliefs" (sequence_id fakeBeliefsSeq001)');
    expect(out.text.split("\n").at(-1)).toBe("End of results.");
  });
});

describe("get_sequence: continuations", () => {
  it("¶3.6 a hand-off pasted back whole with its cursor continues like the cursor alone; another subject or value is bad_input", async () => {
    const h = createHarness({ families: FAMILIES });
    const cursor = printedCursor((await h.call("get_sequence", { sequence: BS, limit: 3 })).text)!;
    const alone = await h.call("get_sequence", { cursor });
    const whole = await h.call("get_sequence", { sequence: "https://www.lesswrong.com/s/BiasesSequence001", limit: 3, cursor });
    expect(alone.text).toContain("Position: posts 4–6 of 8");
    expect(withoutCursors(whole.text)).toBe(withoutCursors(alone.text));
    const different = /^Error \(bad_input\): this cursor was issued for different parameters \((\w+): /;
    expect(different.exec((await h.call("get_sequence", { sequence: PW, cursor })).text)?.[1]).toBe("sequence");
    expect(different.exec((await h.call("get_sequence", { sequence: BS, limit: 4, cursor })).text)?.[1]).toBe("limit");
    expect(different.exec((await h.call("get_sequence", { sequence: BS, af_only: true, cursor })).text)?.[1]).toBe("af_only");
    expect(different.exec((await h.call("get_sequence", { post: "BsPost00000000009", cursor })).text)?.[1]).toBe("post");
  });

  it("¶3.6 a marked page's cursor keeps the marked post: later pages show ranges, the arrow and the chapter header", async () => {
    const h = createHarness({ families: FAMILIES, extra: [bsPostEntry(5)] });
    const first = await h.call("get_sequence", { sequence: BS, post: "BsPost00000000005", limit: 1 });
    expect(first.text).toContain("(next: posts 4–4)");
    const second = await h.call("get_sequence", { cursor: printedCursor(first.text)! });
    expect(second.text).toContain("Position: posts 4–4 of 8");
    expect(second.text).toContain('Chapter 2 · "Biases"');
    expect(second.text).toContain('→ 4. "Post 5"');
    expect(second.text).toContain("post → post_id BsPost00000000005");
    expect(second.text).not.toContain("come before this");
    const again = await h.call("get_sequence", { cursor: printedCursor(first.text)!, post: "BsPost00000000005" });
    expect(again.text).toContain('post → "Post 5" (post_id BsPost00000000005)');
    expect(again.text).toContain("Position: posts 4–4 of 8");
    const other = await h.call("get_sequence", { cursor: printedCursor(first.text)!, post: "BsPost00000000009" });
    expect(other.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(post: /);
  });

  it("¶2.2 step 5 ¶3.6 a page stopped before the boundary neighbour is shown again by its cursor, now with the neighbour", async () => {
    const h = createHarness({ families: FAMILIES });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("getSequenceStats"), delayMs: 41_000 });
    const stopped = await h.call("get_sequence", { sequence: PW, post: "pwLastPost0000001" });
    const next = await h.call("get_sequence", { cursor: printedCursor(stopped.text)! });
    expect(next.text).toContain('next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    expect(next.text).toContain("→ 2.");
    expect(next.text).toContain("--- begin text");
    expect(next.text.split("\n").at(-1)).toBe("End of results.");
    expectClean(h);
  });

  it("¶3.7 ¶3.6 a page cut by the budget continues at the first post it did not show: every post once, in order, chapter headers repeated", async () => {
    const big = "BigSequence000001";
    const posts = Array.from({ length: 40 }, (_, i) => card(`BigPost${String(i + 1).padStart(10, "0")}`, `A rather long title for big post number ${i + 1}`));
    const chapters = [{ _id: "BigChapter000001", title: "The only chapter", subtitle: null, number: 1, posts }];
    const h = createHarness({
      families: FAMILIES,
      extra: [
        gqlEntry({ root: "sequence", id: big }, { result: rawSeqCard({ _id: big, title: "Big", canonicalCollectionSlug: null, contents: { plaintextDescription: "d", markdown: "d" } }) }, "§11.1"),
        gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: big }, limit: 500 }, { results: chapters }, "§11.2"),
        gqlEntry({ root: "getSequenceStats", args: { sequenceId: big } }, { totalWordCount: 10, totalReadTime: 1 }, "§11.3"),
      ],
    });
    const pages = [(await h.call("get_sequence", { sequence: big, limit: 50, max_tokens: 2000 })).text];
    while (printedCursor(pages.at(-1)!) !== undefined && pages.length < 20) {
      pages.push((await h.call("get_sequence", { cursor: printedCursor(pages.at(-1)!)! })).text);
    }
    expect(pages.length).toBeGreaterThan(1);
    const ids = pages.flatMap((p) => [...p.matchAll(/post_id (BigPost\d+)/g)].map((m) => m[1]));
    expect(ids).toEqual(posts.map((p) => p._id));
    expect(pages.every((p) => p.includes('Chapter 1 · "The only chapter"'))).toBe(true);
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
  });

  it("¶3.6 a list that changed between pages says so, and an unchanged one does not", async () => {
    const h = createHarness({ families: FAMILIES });
    const cursor = printedCursor((await h.call("get_sequence", { sequence: BS, limit: 3 })).text)!;
    expect((await h.call("get_sequence", { cursor })).text).not.toContain("The list changed");
    h.clock.advance(300_001);
    const posts = ["BsPost00000000001", "BsPost00000000003", "BsPost00000000004", "BsPost00000000005", "BsPost00000000006", "BsPost00000000007", "BsPost00000000008", "BsPost00000000009", "BsPostNew0000001", "BsPostNew0000002"]
      .map((id) => card(id, `Post ${id.slice(-2)}`));
    h.forum.inject({
      endpoint: "graphql", when: (b) => b.includes("getSequenceStats"),
      body: JSON.stringify({ data: { ch: { results: [{ _id: "BsChapter00000001", title: null, subtitle: null, number: null, posts }] }, st: { totalWordCount: 1, totalReadTime: 1 } } }),
    });
    const changed = await h.call("get_sequence", { cursor });
    expect(changed.text).toContain("The list changed since the previous page (2 new items); positions may have shifted.");
    expect(changed.text).toContain("Position: posts 4–6 of 10");
  });

  it("D1 a continuation after the cached sequence expired asks again, and a sequence refused meanwhile is not_public", async () => {
    const h = createHarness({ families: FAMILIES });
    const cursor = printedCursor((await h.call("get_sequence", { sequence: BS, limit: 3 })).text)!;
    h.clock.advance(1_800_001);
    h.forum.inject({
      endpoint: "graphql", when: (b) => b.includes("get_sequence_req1"),
      body: JSON.stringify({ data: { s: null }, errors: [{ message: "app.operation_not_allowed", path: ["s"] }] }),
    });
    const out = await h.call("get_sequence", { cursor });
    expect(out.text).toMatch(/^Error \(not_public\): The forum refuses to show the sequence with the id "BiasesSequence001"/);
  });

  it("¶2.3 a collection's pages repeat the book header where a page starts mid-book, and the cursor compares the collection given again", async () => {
    const h = createHarness({ families: FAMILIES });
    const first = await h.call("get_sequence", { sequence: "rationality", limit: 1 });
    const second = await h.call("get_sequence", { sequence: "https://www.lesswrong.com/rationality", limit: 1, cursor: printedCursor(first.text)! });
    expect(second.text).toContain('Book 1 · "Map and Territory"');
    expect(second.text).toContain("sequence_id fakeBeliefsSeq001");
    expect(second.text).toContain("Position: sequences 2–2 of 4");
    const third = await h.call("get_sequence", { cursor: printedCursor(second.text)! });
    expect(third.text).toContain('Book 2 · "How to Actually Change Your Mind"');
    const wrong = await h.call("get_sequence", { sequence: "codex", cursor: printedCursor(first.text)! });
    expect(wrong.text).toMatch(/^Error \(bad_input\): this cursor was issued for different parameters \(sequence: /);
  });
});

// The description of a sequence or collection is fenced in the head, which a page always keeps. It takes at most a quarter of the
// budget; a longer one is cut at a paragraph end and a line after the fence says so, so that the first posts stay on page 1.
describe("get_sequence: a description longer than its share of the page", () => {
  const paragraph = (i: number): string => `Paragraph ${i} of a very long description that goes on and on about this series of posts.`;
  const longText = (n: number): string => Array.from({ length: n }, (_, i) => paragraph(i + 1)).join("\n\n");
  const longSequence = (n: number): FixtureEntry => gqlEntry(
    { root: "sequence", id: BS },
    { result: rawSeqCard({ _id: BS, title: "A Sequence on Biases", canonicalCollectionSlug: null, contents: { plaintextDescription: "long", markdown: longText(n) } }) },
    "§11.1",
  );
  /** The fence of the description with the line after it (the cut marker, when there is one). */
  const descriptionLines = (text: string): string[] => {
    const lines = text.split("\n");
    const begin = lines.findIndex((l) => l.startsWith("--- begin text "));
    const end = lines.findIndex((l) => l.startsWith("--- end text "));
    return begin < 0 || end < begin ? [] : lines.slice(begin, end + 2);
  };
  const shareOf = (maxTokens: number): number => Math.floor(0.25 * Math.floor(0.95 * maxTokens));
  const MARKER = /^\[… description cut: about ([\d,]+) more words; a larger max_tokens shows more\]$/;
  const wordsLeft = (block: string[]): number => Number(MARKER.exec(block.at(-1)!)![1]!.replace(/,/g, ""));

  it("a sequence: a quarter of the page at a paragraph end, a marker after the fence, the posts still on page 1", async () => {
    const h = createHarness({ families: FAMILIES, extra: [longSequence(600)] });
    const out = await h.call("get_sequence", { sequence: BS, max_tokens: 2000 });
    expect(out.isError).toBe(false);
    expect(out.text.match(/^--- begin text /gm)).toHaveLength(1);
    expect(out.text.match(/^--- end text /gm)).toHaveLength(1);
    const block = descriptionLines(out.text);
    expect(block.at(-1)).toMatch(MARKER);
    expect(block.at(-2)).toMatch(/^--- end text [0-9a-f]{6} ---$/);
    expect(block.at(-3)).toMatch(/^Paragraph \d+ of a very long description that goes on and on about this series of posts\.$/);
    expect(estimateTokens(block.join("\n"))).toBeLessThanOrEqual(shareOf(2000));
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(Math.floor(0.95 * 2000));
    expect(out.text).toContain("post_id BsPost00000000001");
    expect(out.text.indexOf("--- end text")).toBeLessThan(out.text.indexOf("post_id BsPost00000000001"));
    expectClean(h);
  });

  it("the posts are reached by the cursor, which does not repeat the description", async () => {
    const h = createHarness({ families: FAMILIES, extra: [longSequence(600)] });
    const first = await h.call("get_sequence", { sequence: BS, max_tokens: 2000, limit: 3 });
    expect(first.text).toContain("post_id BsPost00000000004");
    const second = await h.call("get_sequence", { cursor: printedCursor(first.text)! });
    expect(second.text).toContain("post_id BsPost00000000005");
    expect(second.text).not.toContain("--- begin text");
    expect(second.text).not.toContain("description cut");
  });

  it("a larger max_tokens shows more of it, as the marker says", async () => {
    const h = createHarness({ families: FAMILIES, extra: [longSequence(900)] });
    const small = descriptionLines((await h.call("get_sequence", { sequence: BS, max_tokens: 2000 })).text);
    const large = descriptionLines((await h.call("get_sequence", { sequence: BS, max_tokens: 20_000 })).text);
    expect(large.length).toBeGreaterThan(small.length * 4);
    expect(estimateTokens(large.join("\n"))).toBeLessThanOrEqual(shareOf(20_000));
    expect(wordsLeft(large)).toBeLessThan(wordsLeft(small));
  });

  it("a description that fits its share is printed whole with no marker; one paragraph more is cut", async () => {
    const fenced = (n: number): string => fence("sequence description", longText(n), "000000");
    let n = 1;
    while (estimateTokens(fenced(n + 1)) <= shareOf(2000)) n += 1;
    expect(n).toBeGreaterThan(5);
    const fits = createHarness({ families: FAMILIES, extra: [longSequence(n)] });
    const whole = await fits.call("get_sequence", { sequence: BS, max_tokens: 2000 });
    expect(whole.text).toContain(paragraph(n));
    expect(whole.text).not.toContain("description cut");
    const over = createHarness({ families: FAMILIES, extra: [longSequence(n + 1)] });
    const cut = await over.call("get_sequence", { sequence: BS, max_tokens: 2000 });
    expect(cut.text).not.toContain(paragraph(n + 1));
    expect(descriptionLines(cut.text).at(-1)).toMatch(MARKER);
    const short = await createHarness({ families: FAMILIES }).call("get_sequence", { sequence: BS, max_tokens: 2000 });
    expect(short.text).not.toContain("description cut");
  });

  it("a collection: cut the same way, and its first sequences stay on page 1", async () => {
    const root = loadFamilies("sequences").find((e) => "root" in e.match && e.match.root === "collection" && e.match.id === "oneQyj4pw77ynzwAF")!;
    const document = (root.result as { result: Record<string, unknown> }).result;
    const h = createHarness({ families: FAMILIES, extra: [{ ...root, result: { result: { ...document, contents: { markdown: longText(600) } } } }] });
    const out = await h.call("get_sequence", { sequence: "rationality", max_tokens: 2000 });
    expect(out.isError).toBe(false);
    expect(out.text.match(/^--- begin text [0-9a-f]{6} \(collection description; written by forum users\) ---$/gm)).toHaveLength(1);
    expect(out.text.match(/^--- end text /gm)).toHaveLength(1);
    const block = descriptionLines(out.text);
    expect(block.at(-1)).toMatch(MARKER);
    expect(block.at(-3)).toMatch(/^Paragraph \d+ of a very long description/);
    expect(estimateTokens(block.join("\n"))).toBeLessThanOrEqual(shareOf(2000));
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(Math.floor(0.95 * 2000));
    expect(out.text).toContain("sequence_id 5g5TkQTe9rmPS5vvM");
    expect(out.text.indexOf("--- end text")).toBeLessThan(out.text.indexOf("sequence_id 5g5TkQTe9rmPS5vvM"));
  });
});

describe("get_sequence: hidden subjects leave nothing behind", () => {
  it("P1 P4 ¶2.3 a refused sequence evicts the raw responses and is remembered: asked again it costs no request", async () => {
    const h = createHarness({ families: FAMILIES });
    const evict = vi.spyOn(h.services, "evictResponses");
    await h.call("get_sequence", { sequence: "UnknownSequence01" });
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict.mock.calls[0]![0].length).toBeGreaterThan(0);
    const again = await h.call("get_sequence", { sequence: "UnknownSequence01" });
    expect(again.text).toBe('Error (not_found): No publicly visible sequence has the id "UnknownSequence01".');
    expect(h.forum.requests).toHaveLength(1);
  });
});
