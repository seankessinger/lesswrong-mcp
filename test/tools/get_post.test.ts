import { describe, it, expect } from "vitest";
import { getPostRequest2Ops } from "../../src/forum/templates/get_post";
import { createCallContext } from "../../src/call/context";
import { CAVEAT, CONTINUED } from "../../src/render/messages";
import type { ProcessedBody } from "../../src/domain/markdown";
import { estimateTokens } from "../../src/render/budget";
import { createHarness, expectClean, type Harness } from "../support/harness";
import { loadFamilies, type FixtureEntry } from "../support/fixtures";
import { gqlEntry, longPostEntries, rawCommentRef, rawPostFull, rawUserRef } from "../support/builders";

const FAMS = ["posts", "comments", "sequences", "users", "tags"] as const;
const get = async (args: Record<string, unknown>, h = createHarness({ families: FAMS })) => ({ h, out: await h.call("get_post", args) });

const FOOTER = /^(End of results\.|More available: |Stopped early )/;
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** Every page of a call, following each printed cursor (at most 40 pages); each within the budget and with exactly one footer, last. */
async function allPages(h: Harness, args: Record<string, unknown>, maxTokens: number): Promise<string[]> {
  const pages: string[] = [];
  let next: Record<string, unknown> = { ...args, max_tokens: maxTokens };
  for (let i = 0; i < 40; i++) {
    const out = await h.call("get_post", next);
    expect(out.isError).toBe(false);
    const lines = out.text.split("\n");
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(Math.floor(0.95 * maxTokens));
    expect(lines.filter((l) => FOOTER.test(l))).toEqual([lines.at(-1)]);
    pages.push(out.text);
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(lines.at(-1)!)?.[1];
    if (cursor === undefined) return pages;
    next = { cursor, max_tokens: maxTokens };
  }
  throw new Error("more than 40 pages");
}

/** The lines of the block titled `title` on `page`: the lines after the title that start with two spaces, then the line after them. */
function blockOf(page: string, title: string): { lines: string[]; after: string | undefined } {
  const lines = page.split("\n");
  const at = lines.indexOf(title);
  if (at < 0) return { lines: [], after: undefined };
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => !l.startsWith("  "));
  return { lines: end < 0 ? rest : rest.slice(0, end), after: end < 0 ? undefined : rest[end] };
}

describe("get_post: an old /lw/ link", () => {
  it("an old id the forum finds no listed post for is not_found, and the hint says an unlisted post opens from its /posts/ URL", async () => {
    const h = createHarness({ families: ["posts", "comments", "users", "tags", "sequences"], extra: [
      gqlEntry({ root: "posts", view: "legacyIdPost", terms: { legacyId: "zz1" }, limit: 1 }, { results: [] }, "§3.1"),
    ] });
    expect((await h.call("get_post", { post: "https://www.lesswrong.com/lw/zz1/an_old_post/" })).text).toBe(
      'Error (not_found): No publicly visible post has the id "zz1". The forum finds a post by its old /lw/ id only while the post is listed; '
      + "an unlisted post opens from its /posts/ URL.",
    );
    expectClean(h);
  });
});

describe("get_post", () => {
  it("get_post_request2: exact text of each part", () => {
    const ctx = createCallContext("get_post", { now: () => 0 });
    const ops = getPostRequest2Ops({ postId: ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc"), reviews: true, debate: true,
      sequenceId: ctx.confirmPublic("sequence", "5g5TkQTe9rmPS5vvM"), listing: true });
    expect(ops.map((o) => o.text)).toEqual([
      'rv: comments(selector: {reviews: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 50) { results { ...COMMENT_REF baseScore reviewingForReview } }',
      'dt: comments(selector: {debateResponses: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 500) { results { ...COMMENT_REF contents { markdown } } }',
      'ch: chapters(selector: {SequenceChapters: {sequenceId: "5g5TkQTe9rmPS5vvM"}}, limit: 500) { results { _id number posts { ...POST_REF postedAt } } }',
      'col: collections(selector: {default: {}}, limit: 10) { results { _id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } } } }']);
    expect(getPostRequest2Ops({ postId: ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc"), reviews: false, debate: false, listing: false })).toEqual([]);
  });

  it("Q82 the header from request 1 (POST_FULL) and the reviews from request 2", async () => {
    const { h, out } = await get({ post: "uMQ3cqWDPHhjtiesc", include_body: false });
    expect(h.forum.requests).toHaveLength(2);
    expect(h.forum.requests[0].body).toContain('p: post(selector: {_id: \\"uMQ3cqWDPHhjtiesc\\"}, allowNull: true) { result { ...POST_FULL } }');
    const lines = out.text.split("\n");
    expect(lines.slice(0, 2)).toEqual(['get_post — "AGI Ruin: A List of Lethalities"',
      'Request: post → "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc) by "Eliezer Yudkowsky" · include_body false']);
    expect(lines).toContain('Post "AGI Ruin: A List of Lethalities" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(lines).toContain("post_id uMQ3cqWDPHhjtiesc · https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities");
    expect(out.text).toContain("Published 2022-06-05 · last edited 2024-02-27 (v1.12.0)");
    expect(out.text).toContain("karma 1,055 (612 votes) · AF (AF karma 156, ~145 AF comments)");
    expect(out.text).toContain("Best of LessWrong 2022 (ai safety, #1 of the year)");
    expect(lines).toContain('Tags (relevance): "AI Risk" 25 (tag_slug ai-risk) · "AI" 9 (tag_slug ai)');
    expect(lines).toContain("Annual Review: 3 reviews · final vote score 1,234.6");
    expect(out.text).toContain('  review (2022) by "Rob Bensinger" (user_slug robbb) · karma 45 · comment_id agiReview00000001 (AF)');
    expect(lines).toContain('Comments: ~717 (site counter) — get_comments {post: "uMQ3cqWDPHhjtiesc"}');
    expect(out.text).toContain('Reactions: insightful 2 (details: get_reactions {post: "uMQ3cqWDPHhjtiesc"})');
    expect(lines.at(-1)).toBe("End of results.");
    expectClean(h);
  });
  it("¶8 ¶3.9 a failing part of request 2 is a Partial line; the header still renders and isError stays false", async () => {
    const h = createHarness({ families: FAMS, extra: [{ source: "§8.10", match: { root: "comments", view: "reviews", terms: { postId: "uMQ3cqWDPHhjtiesc" } }, error: { message: "Something went wrong" } }] });
    const out = await h.call("get_post", { post: "uMQ3cqWDPHhjtiesc", include_body: false });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Post "AGI Ruin: A List of Lethalities" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(out.text).toContain("Partial: reviews unavailable (forum_error: Something went wrong).");
    expect(out.text).not.toContain("agiReview00000001");
    expect(out.text.split("\n").at(-1)).toBe("End of results.");
  });
  it("P2 P5 P7 P18 the best answer of a question post: shown with its ids; a deleted placeholder without an author; a rejected one omitted", async () => {
    const h = createHarness({ families: FAMS });
    expect((await h.call("get_post", { post: "questionPost00001", include_body: false })).text)
      .toContain('Best answer: comment_id bestAnswerCmnt001 (LW only) by "Answerer" (user_slug answerer) (karma 42)');
    const dead = (await h.call("get_post", { post: "deadAnswerPost001", include_body: false })).text;
    expect(dead).toContain("Best answer: comment_id deadAnswerCmnt01x (LW only) · comment placeholder (reason: Comment deleted by its author)");
    expect(dead).not.toContain("PLANTED");
    const rejected = (await h.call("get_post", { post: "rejAnswerPost0001", include_body: false })).text;
    expect(rejected).not.toContain("Best answer");
    expect(rejected).not.toContain("PLANTED");
  });
  it("P1 P14 related questions: visible parents and sub-questions with post_id and AF status, hidden ones omitted", async () => {
    const out = (await get({ post: "questionPost00001", include_body: false })).out.text;
    expect(out).toContain('Related questions: parent "The parent question" (post_id parentQPost000001, LW only) · sub-question "The sub-question" (post_id subQPost000000001, AF)');
    expect(out).not.toContain("PLANTED");
  });
  it("C-PRE2019 a post from before the 2019 import gets the snapshot note, by its date, not by its legacy flag", async () => {
    expect((await get({ post: "pwLastPost0000001", include_body: false })).out.text).toContain("Texts from before 13 February 2019 exist only as");
    expect((await get({ post: "uMQ3cqWDPHhjtiesc", include_body: false })).out.text).not.toContain("Texts from before 13 February 2019");
  });
  it("§7.7 a pre-2009 legacy post says it was originally on Overcoming Bias", async () => {
    expect((await get({ post: "obPost00000000001", include_body: false })).out.text).toContain("originally on Overcoming Bias");
  });
  it("Q111 P11 P12 P14 P15 hidden material in the header never shows", async () => {
    const t = (await get({ post: "uMQ3cqWDPHhjtiesc", include_body: false })).out.text;
    // The glossary is a capped block, one term per line (¶4.3 Paging).
    expect(t).toContain('Glossary:\n  "mesa-optimizer" — an optimizer found by an optimizer');
    expect(t).not.toContain("PLANTED-NEGATIVE-REACT");
    // A made-up post's admin-only tag, unapproved and deleted glossary terms and related question that is not public.
    const s = (await get({ post: "plantedNotes00001", include_body: false })).out.text;
    expect(s).toContain('Glossary:\n  "Corrigibility" — An agent that lets itself be corrected.');
    for (const m of ["PLANTED", "admin-only-tag", "Related questions"]) expect(s).not.toContain(m);
  });
  it("Q53 Q109 P5 debate turns follow the body, without turn karma; a deleted turn shows no author", async () => {
    const { h, out } = await get({ post: "qbcuk8WwFnTZcXTd6" });
    expect(h.forum.requests[1].body).toContain("debateResponses");
    expect(out.text).toContain('▶ turn 1 · "Thomas Kwa" (user_slug thomas-kwa) · 2023-09-06 14:00Z · comment_id kwaTurn0000000001 (LW only)');
    expect(out.text).toContain("▶ turn 2 · comment placeholder (reason: Requested account deletion) · ");
    expect(out.text).not.toContain("PLANTED-TURN-AUTHOR");
    expect(out.text.split("\n").filter((l) => l.startsWith("▶ turn")).some((l) => l.includes("karma"))).toBe(false);
    // ¶3.7: the post is one item; its text and turns shown whole on page 1 print no `Position: text 1–100 %`.
    expect(out.text).not.toContain("Position:");
    expect(out.text.trimEnd().endsWith("End of results.")).toBe(true);
  });
  it("¶3.7 a text cut on page 1 keeps its Position line, and so does every continuation, the last one ending at 100 %", async () => {
    const h = createHarness({ families: FAMS, extra: longPostEntries() });
    const pages = await allPages(h, { post: "longPost000000001" }, 2000);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toMatch(/^Position: text 1–\d+ %$/m);
    for (const p of pages.slice(1)) expect(p).toMatch(/^Position: text \d+–\d+ %$/m);
    expect(pages.at(-1)).toMatch(/^Position: text \d+–100 %$/m);
  });
  it("Q95 Q134 dialogue speakers come from the HTML, which request 1 reads", async () => {
    const { h, out } = await get({ post: "dialoguePost00001" });
    expect(h.forum.requests).toHaveLength(1);
    expect(out.text).toContain("Alice");
  });
  it("Q81 P15 only the page's text is shown, and no note is added", async () => {
    const t = (await get({ post: "plantedPost000001" })).out.text;
    expect(t).not.toContain("PLANTED-OFFPAGE");
    expect(t).toContain("And this too.");
    expect(t.split("\n")[2]).toBe(`Notes: ${CAVEAT["C-COUNTER"]} ${CAVEAT["C-FRONTPAGE"]}`);
  });
  it("Q101 Q50.14 neighbours from the chapter list, across the collection boundary (request 3)", async () => {
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false });
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text).toContain('Canonical sequence: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM) · previous: "Preface" (post_id pwFirstPost000001, LW only) · next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
  });
  it("#129 a collection whose one book has no number still names the next sequence's first post (as hpmor and highlights)", async () => {
    const listing = loadFamilies(...FAMS).find((e) => "root" in e.match && e.match.root === "collections")!;
    const copy = JSON.parse(JSON.stringify(listing)) as FixtureEntry & { result: { results: { slug: string; books: { number: number | null; sequenceIds: string[] }[] }[] } };
    const rationality = copy.result.results.find((c) => c.slug === "rationality")!;
    rationality.books = [{ ...rationality.books.find((b) => b.number === 1)!, number: null }];
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false }, createHarness({ families: FAMS, extra: [copy] }));
    expect(out.text).toContain('· next: "Making Beliefs Pay Rent (in Anticipated Experiences)"');
    expect(out.text).not.toContain("can't be determined");
    expectClean(h);
  });

  it("bestoflesswrong gives no cross-sequence neighbour", async () => {
    const { h, out } = await get({ post: "bolLastPost000001", include_body: false });
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain("the next sequence of bestoflesswrong can't be determined reliably (the forum defines no order among books that share a number or have none)");
  });
  it("Q50.14 a stored pointer the chapter list does not confirm", async () => {
    expect((await get({ post: "notInSeqPost00001", include_body: false })).out.text).toContain(
      'The site\'s stored canonical-sequence pointer names "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM), but this post is not currently in that sequence.');
  });
  it("outline, section and match", async () => {
    const h = createHarness({ families: FAMS });
    expect((await h.call("get_post", { post: "outlinePost000001" })).text).toContain("Outline (4): 1 A · 2 B · 3   B.1 · 4 C");
    const s2 = (await h.call("get_post", { post: "outlinePost000001", section: 2 })).text;
    expect(s2).toContain("text b1"); expect(s2).not.toContain("text c");
    expect((await h.call("get_post", { post: "outlinePost000001", section: 9 })).text).toMatch(/^Error \(bad_input\): section: this post has 4 sections/);
    const m = (await h.call("get_post", { post: "outlinePost000001", match: "text b" })).text;
    expect(m).toMatch(/^\d+ of \d+ paragraphs contain "text b"\.$/m);
    // Each hit is an item: `section N · paragraph M`, then the paragraph quoted (render/records matchHitText, shared with get_tag).
    expect(m).toMatch(/^section \d+ · paragraph \d+\n> text b/m);
    expect((await h.call("get_post", { post: "outlinePost000001", section: 1, match: "x y" })).text)
      .toBe("Error (bad_input): match: can't be combined with section. Give section or match, not both.");
  });
  it("Q96 an empty body; a quick-takes container (no body) points to its quick takes", async () => {
    expect((await get({ post: "emptyBodyPost0001" })).out.text).toContain("This post has no body text.");
    expect((await get({ post: "emptyLinkPost0001" })).out.text).toContain("This post has no body text. It links to https://example.com/x.");
    expect((await get({ post: "quickTakesBox0001" })).out.text).toContain('Its quick takes are comments: list_comments {user: "eliezer_yudkowsky", quick_takes_only: true}.');
  });
  it("P3 an unlisted post opens by id, flagged", async () => {
    expect((await get({ post: "unlistedPost00001" })).out.text).toContain("reachable by link only");
  });
  it("Q50.15 the slice cursor continues the text and notes an edit between pages", async () => {
    const md = Array.from({ length: 600 }, (_, i) => `Paragraph ${i} of a long post with some words in it.`).join("\n\n");
    const doc = (version: string) => rawPostFull({ _id: "longPost000000001", title: "Long", slug: "long", contents: { version, editedAt: "2024-01-01T00:00:00.000Z", markdown: md } });
    const h = createHarness({ families: FAMS, extra: [{ source: "§6.5", match: { root: "post", id: "longPost000000001" }, result: { result: doc("1.0.0") } }] });
    const p1 = await h.call("get_post", { post: "longPost000000001", max_tokens: 2000 });
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})" \(next: text from \d+ %\)\.$/.exec(p1.text)![1];
    h.clock.advance(300_001);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("longPost000000001"), body: JSON.stringify({ data: { p: { result: doc("1.1.0") } } }) });
    const p2 = await h.call("get_post", { cursor });
    expect(p2.text).toContain("This post was edited since the previous page (now v1.1.0); continuing at the same character position.");
  });
  it("Stopped early under a fake deadline before the boundary neighbour", async () => {
    const h = createHarness({ families: FAMS }); h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("SequenceChapters"), delayMs: 41_000 });
    expect((await h.call("get_post", { post: "pwLastPost0000001" })).text).toMatch(/Stopped early \(time limit\); call get_post with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });
  it("¶2.2 step 5 past 40 s request 3 is not sent at all: not even an answer an earlier call left in the cache is used", async () => {
    const h = createHarness({ families: FAMS });
    await h.call("get_post", { post: "pwLastPost0000001" });
    expect(h.forum.requests).toHaveLength(3);
    // Request 2 is sent again (the collections listing, now cached, no longer rides along) and answers after 41 s.
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("ch: chapters"), delayMs: 41_000 });
    const out = (await h.call("get_post", { post: "pwLastPost0000001" })).text;
    expect(h.forum.requests).toHaveLength(4);
    expect(out.split("\n")).toContain('Canonical sequence: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM) · previous: "Preface" (post_id pwFirstPost000001, LW only)');
    expect(out).not.toContain("in the next sequence of rationality");
    expect(out).toMatch(/Stopped early \(time limit\); call get_post with cursor "c_[A-Za-z0-9_-]{22}" to continue\.$/);
  });

  // The continuation rules, the stop's cursor, request 3's Partial line and the body cache.
  it("¶3.6 a stopped first page continues as the first page again, now with the boundary neighbour and the body", async () => {
    const h = createHarness({ families: FAMS }); h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("SequenceChapters"), delayMs: 41_000 });
    const stopped = (await h.call("get_post", { post: "pwLastPost0000001" })).text;
    expect(stopped).not.toContain("--- begin text");
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(stopped)![1];
    const next = (await h.call("get_post", { cursor })).text;
    expect(next).toContain('in the next sequence of rationality: "Fake Beliefs")');
    expect(next).toContain("--- begin text");
    expect(next.split("\n").at(-1)).toBe("End of results.");
  });
  it("¶3.6 a continuation compares a repeated post by id: the same post continues, another is bad_input", async () => {
    const h = createHarness({ families: FAMS, extra: longPostEntries() });
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec((await h.call("get_post", { post: "longPost000000001", max_tokens: 2000 })).text)![1];
    expect((await h.call("get_post", { cursor, post: "https://www.lesswrong.com/posts/longPost000000001/long", max_tokens: 2000 })).text).toMatch(/^Position: text 1\d–\d+ %$/m);
    expect((await h.call("get_post", { cursor, post: "uMQ3cqWDPHhjtiesc" })).text).toBe(
      'Error (bad_input): this cursor was issued for different parameters (post: cursor has "longPost000000001", call has "uMQ3cqWDPHhjtiesc"). Pass only the cursor to continue, or repeat the call without it to start over.');
  });
  it("¶8 the boundary neighbour's request failing is a Partial line; the neighbour inside the sequence still shows", async () => {
    const h = createHarness({ families: FAMS, extra: [{ source: "§11.2", match: { root: "chapters", view: "SequenceChapters", terms: { sequenceId: "fakeBeliefsSeq001" } }, error: { message: "Something went wrong" } }] });
    const out = await h.call("get_post", { post: "pwLastPost0000001", include_body: false });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Canonical sequence: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM) · previous: "Preface" (post_id pwFirstPost000001, LW only)\n');
    expect(out.text.match(/^Partial: .*$/gm)).toEqual(["Partial: neighbouring sequence unavailable (forum_error: Something went wrong)."]);
  });
  it("¶2.3 the processed body is cached as <postId>@<version>", async () => {
    const h = createHarness({ families: FAMS });
    await h.call("get_post", { post: "dialoguePost00001" });
    expect(h.services.caches.get<ProcessedBody>("body", "dialoguePost00001@1.0.0")?.md).toContain("**Alice:**");
  });

  // ¶4.3 Paging ("a slice cursor over the context blocks and the body") and the ¶3.6 slice row.
  it("¶4.3 ¶3.6 a long glossary is a capped block: page 1 keeps the header lines, and the cursor shows every term once, in order, and the text through 100 %", async () => {
    const terms = Array.from({ length: 60 }, (_, i) => `gterm-${pad(i + 1, 2)}`);
    const definition = "An explanation in plain words of what this term means in the post, given at some length. ".repeat(4).slice(0, 295).trim();
    const doc = rawPostFull({
      _id: "glossaryPost00001", title: "Glossary", slug: "glossary",
      glossary: terms.map((term, i) => ({ _id: `glossaryTerm${pad(i + 1, 5)}`, term, approved: true, deleted: false, contents: { markdown: definition } })),
      contents: {
        version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z",
        markdown: Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of the glossary post.`).join("\n\n"),
      },
    });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "glossaryPost00001" }, { result: doc }, "§6.6, P15")] });
    const pages = await allPages(h, { post: "glossaryPost00001" }, 2000);
    expect(pages.length).toBeGreaterThan(2);

    const first = pages[0]!.split("\n");
    for (const start of ['Post "Glossary" — ', "post_id glossaryPost00001 · ", "Published 2022-06-05 · ", 'Comments: ~717 (site counter) — get_comments {post: "glossaryPost00001"}']) {
      expect(first.some((l) => l.startsWith(start))).toBe(true);
    }
    const block = blockOf(pages[0]!, "Glossary:");
    expect(block.lines.length).toBeGreaterThan(0);
    expect(block.after).toBe(CONTINUED);
    expect(first.at(-1)).toMatch(new RegExp(`\\(next: glossary from term ${block.lines.length + 1}\\)\\.$`));

    const shown = pages.flatMap((p) => blockOf(p, "Glossary:").lines);
    expect(shown).toEqual(terms.map((t) => `  "${t}" — ${definition}`));
    const paragraphs = pages.flatMap((p) => [...p.matchAll(/^Paragraph (\d+) of the glossary post\./gm)].map((m) => Number(m[1])));
    expect(paragraphs).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(pages.some((p) => /^Position: text \d+–100 %$/m.test(p))).toBe(true);
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
    expectClean(h);
  });
  it("¶4.3 ¶3.6 50 reviews are a capped block the cursor continues (include_body false): each review once and in order, then the more-may-exist line", async () => {
    const id = "manyReviewPost001";
    const reviewIds = Array.from({ length: 50 }, (_, i) => `manyReviewCmnt${pad(i + 1, 3)}`);
    const rows = reviewIds.map((rid, i) => ({
      ...rawCommentRef({ _id: rid, postId: id, af: false, user: rawUserRef({ _id: `manyReviewerU${pad(i + 1, 4)}`, slug: `reviewer-${i + 1}`, displayName: `Reviewer ${i + 1}` }) }),
      baseScore: 10, reviewingForReview: "2023",
    }));
    const h = createHarness({
      families: FAMS,
      extra: [
        gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "Reviewed", slug: "reviewed", reviewCount: 50 }) }, "§8.10"),
        gqlEntry({ root: "comments", view: "reviews", terms: { postId: id }, limit: 50 }, { results: rows }, "§8.10"),
      ],
    });
    const pages = await allPages(h, { post: id, include_body: false }, 2000);
    expect(pages.length).toBeGreaterThan(2);

    const first = pages[0]!.split("\n");
    expect(first).toContain("Annual Review: 50 reviews");
    expect(first).toContain(`Comments: ~717 (site counter) — get_comments {post: "${id}"}`);
    const block = blockOf(pages[0]!, "Reviews (50):");
    expect(block.after).toBe(CONTINUED);
    expect(first.at(-1)).toMatch(new RegExp(`\\(next: reviews from ${block.lines.length + 1}\\)\\.$`));
    for (const p of pages.slice(1)) expect(p).not.toContain("Annual Review:");

    const shown = pages.flatMap((p) => blockOf(p, "Reviews (50):").lines);
    expect(shown.slice(0, 50).map((l) => /comment_id (\w+) \(LW only\)$/.exec(l)?.[1])).toEqual(reviewIds);
    expect(shown.slice(50)).toEqual(["  more may exist; every review also appears in get_comments, flagged review"]);
    expect(pages.at(-1)!.split("\n").at(-1)).toBe("End of results.");
    expectClean(h);
  });

  // P7 on a dialogue, the login-only flag, the collections listing read only when a neighbour needs it, and the continuation's
  // re-check sent as page 1 sent it.
  it("§6.4 a dialogue reads as its page, with its speakers: equations, tables, strikethrough and no stylesheet", async () => {
    const style = '<style>@font-face {font-family: MJXZERO; src: url("https://cdn.example.org/MathJax_Zero.woff")}</style>';
    const math = `${style}<mjx-container class="MathJax" jax="CHTML" aria-label="E = mc^2" role="math"><mjx-math class=" MJX-TEX"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D438 TEX-I"></mjx-c></mjx-mi></mjx-math></mjx-container>`;
    const message = (name: string, body: string): string =>
      `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2024-01-01T00:00:00.000Z" user-order="1">` +
      `<section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    const html = message("Alice", `<p>Energy is ${math}.</p>`) + message("Bob", "<table><tbody><tr><td>a</td></tr></tbody></table><p><s>Struck</s> text.</p>");
    const base = rawPostFull({ _id: "mathDialogue00001", title: "A Dialogue With Equations", slug: "a-dialogue-with-equations", collabEditorDialogue: true });
    const doc = { ...base, contents: { ...base.contents, markdown: "PLANTED-OFFPAGE text.", html } };
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "mathDialogue00001" }, { result: doc }, "§6.4")] });
    const out = await h.call("get_post", { post: "mathDialogue00001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("**Alice:**\n\nEnergy is $E = mc^2$.\n\n**Bob:**\n\n| a |\n| --- |\n\n~~Struck~~ text.");
    expect(out.text).not.toMatch(/font-face|woff|mjx-|PLANTED-OFFPAGE/);
    expectClean(h);
  });

  it("P7 an anonymous dialogue shows no speakers", async () => {
    const html = '<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="PLANTED-SPEAKER" submitted-date="2024-01-01T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>PLANTED-SPEAKER</b></section><div><p>Hello there.</p></div></section>';
    const base = rawPostFull({ _id: "anonDialogue00001", title: "An Anonymous Dialogue", slug: "an-anonymous-dialogue", hideAuthor: true, collabEditorDialogue: true });
    const doc = { ...base, contents: { ...base.contents, markdown: "Hello there.", html } };
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "anonDialogue00001" }, { result: doc }, "§6.4, §6.6") ] });
    const out = await h.call("get_post", { post: "anonDialogue00001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Post "An Anonymous Dialogue" — author not publicly visible');
    expect(out.text).toContain("Hello there.");
    expect(out.text).not.toContain("PLANTED-SPEAKER");
    // The same dialogue with its authors shown names the speaker (the existing rule, unchanged).
    const named = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "anonDialogue00001" }, { result: { ...doc, hideAuthor: false } }, "§6.4")] });
    const shown = (await named.call("get_post", { post: "anonDialogue00001" })).text;
    expect(shown).toContain("**PLANTED-SPEAKER:**");
    expectClean(h);
  });
  // #75: in a named dialogue a speaker's label is no heading (the site's table of contents never counts one), so section 1 is the
  // first real heading, not the label above it (johq6Bti9frjuRGXc's shape).
  it("the review: a named dialogue's outline lists its headings and an author's own bold line ending in a colon, never a speaker; match finds that line", async () => {
    const message = (name: string, body: string) => `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2024-01-01T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    const html = message("Alice", "<h1>One</h1><p>a</p><p><strong>Key point:</strong></p><p>b</p>") + message("Bob", "<h1>Two</h1><p>c</p><h1>Three</h1><p>d</p>") + message("Alice", "<h1>Four</h1><p>e</p>");
    const base = rawPostFull({ _id: "namedDialogue0002", title: "Another Named Dialogue", slug: "another-named-dialogue", collabEditorDialogue: true, hideAuthor: false });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "namedDialogue0002" }, { result: { ...base, contents: { ...base.contents, html } } }, "§6.4")] });
    const out = (await h.call("get_post", { post: "namedDialogue0002" })).text;
    const line = out.split("\n").find((l) => l.startsWith("Outline ("));
    expect(line).toBe("Outline (5): 1 One · 2   Key point: · 3 Two · 4 Three · 5 Four");
    expect((await h.call("get_post", { post: "namedDialogue0002", match: "Key point" })).text).toContain('1 of 10 paragraphs contain "Key point".');
    expectClean(h);
  });
  it("#75 section 1 of a named dialogue starts at its first real heading, not a speaker's label", async () => {
    const message = (name: string, body: string) => `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2024-01-01T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    const html = message("Alice", "<h1>Intro</h1><p>Hello there, Bob.</p>") + message("Bob", "<p>Hi Alice.</p><h1>Second</h1><p>More.</p>");
    const base = rawPostFull({ _id: "namedDialogue0001", title: "A Named Dialogue", slug: "a-named-dialogue", collabEditorDialogue: true, hideAuthor: false });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "namedDialogue0001" }, { result: { ...base, contents: { ...base.contents, html } } }, "§6.4")] });
    // The recheck: each section opens with the speaker of the turn it starts in, as the page's message box shows it.
    expect((await h.call("get_post", { post: "namedDialogue0001", section: 1 })).text).toMatch(/\*\*Alice:\*\*\n\nIntro\n=+\n\nHello there, Bob\.\n\n\*\*Bob:\*\*\n\nHi Alice\./);
    expect((await h.call("get_post", { post: "namedDialogue0001", section: 2 })).text).toMatch(/\*\*Bob:\*\*\n\nSecond\n=+\n\nMore\./);
    expectClean(h);
  });
  // The final check: the labels were numbered before a line separator in a message became a line break, so every later one was a
  // line off; and a section opened with the label above a heading that sits in no message.
  it("the final check: a named dialogue's sections and match after a line separator, and a heading after the last message", async () => {
    const message = (name: string, body: string) => `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2024-01-01T00:00:00.000Z" user-order="1"><section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;
    const html = message("Alice", "<p>Hello\u2028there.</p>") + message("Bob", "<h1>Second</h1><p>More.</p>") + message("Alice", "<p>Bye.</p>") + "<h1>Coda</h1>";
    const base = rawPostFull({ _id: "namedDialogue0003", title: "A Third Named Dialogue", slug: "a-third-named-dialogue", collabEditorDialogue: true, hideAuthor: false });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "namedDialogue0003" }, { result: { ...base, contents: { ...base.contents, html } } }, "§6.4")] });
    expect((await h.call("get_post", { post: "namedDialogue0003", section: 1 })).text).toMatch(/\*\*Bob:\*\*\n\nSecond\n=+\n\nMore\.\n\n\*\*Alice:\*\*\n\nBye\./);
    const coda = (await h.call("get_post", { post: "namedDialogue0003", section: 2 })).text;
    expect(coda).toMatch(/\nCoda\n====/);
    expect(coda).not.toContain("**Alice:**");
    expect((await h.call("get_post", { post: "namedDialogue0003", match: "Bob" })).text).toContain('0 of 5 paragraphs contain "Bob".');
    expectClean(h);
  });
  it("a post flagged for logged-in readers only is login_only, not 'no body text'", async () => {
    const doc = rawPostFull({ _id: "loginOnlyPost0001", title: "Members Only", slug: "members-only", onlyVisibleToLoggedIn: true, contents: null });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "loginOnlyPost0001" }, { result: doc }, "§6.1")] });
    const out = await h.call("get_post", { post: "loginOnlyPost0001" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("Error (login_only): This post is only visible to logged-in users; this server reads the forums logged out.");
    expect(h.forum.requests).toHaveLength(1);
  });
  it("¶8 a failed collections listing is no Partial line when both neighbours are inside the sequence: the listing was never needed", async () => {
    const seq = "midSequence000001";
    const doc = rawPostFull({
      _id: "midSeqPost0000001", title: "The Middle Post", slug: "the-middle-post", canonicalSequenceId: seq, canonicalCollectionSlug: "rationality",
      canonicalSequence: { _id: seq, title: "A Middle Sequence", af: false, hidden: false, canonicalCollectionSlug: "rationality" },
    });
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id: "midSeqPost0000001" }, { result: doc }, "§11.4"),
      gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: seq } }, { results: [{ _id: "midChapter0000001", title: null, subtitle: null, number: 1,
        posts: [chapterPost("midSeqPostBefore1", "Before", 1), chapterPost("midSeqPost0000001", "The Middle Post", 2), chapterPost("midSeqPostAfter01", "After", 3)] }] }, "§11.2"),
      { source: "§11.5", match: { root: "collections", view: "default" }, error: { message: "Something went wrong" } },
    ] });
    const out = await h.call("get_post", { post: "midSeqPost0000001", include_body: false });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Canonical sequence: "A Middle Sequence" (sequence_id midSequence000001) · previous: "Before" (post_id midSeqPostBefore1, LW only) · next: "After" (post_id midSeqPostAfter01, LW only)');
    expect(out.text).not.toContain("Partial:");
    expect(h.forum.requests).toHaveLength(2);
  });
  it("¶3.6 a continuation without post re-checks the post as page 1 gave it: a URL's one alias repeats page 1's request, which the raw cache answers", async () => {
    const h = createHarness({ families: FAMS, extra: longPostEntries() });
    const p1 = await h.call("get_post", { post: "https://www.lesswrong.com/posts/longPost000000001/long", max_tokens: 2000 });
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(p1.text)![1];
    const n = h.forum.requests.length;
    expect(n).toBe(1);
    const p2 = await h.call("get_post", { cursor, max_tokens: 2000 });
    expect(p2.isError).toBe(false);
    expect(p2.text).toMatch(/^Position: text \d+–\d+ %$/m);
    expect(h.forum.requests).toHaveLength(n);
    expectClean(h);
  });
  it("#109 a debate post outside the old list of six gets its turns: the post's own debate flag decides, as on the site", async () => {
    const id = "debateSeven000001";
    const turn = { ...rawCommentRef({ _id: "seventhTurn000001", postId: id, af: false, debateResponse: true, postedAt: "2023-09-06T14:00:00.000Z" }), contents: { markdown: "The seventh debate's first turn." } };
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "Another Debate", slug: "another-debate", debate: true }) }, "test"),
      gqlEntry({ root: "comments", view: "debateResponses", terms: { postId: id } }, { results: [turn] }, "test"),
    ] });
    const out = (await h.call("get_post", { post: id })).text;
    expect(h.forum.requests[1]?.body).toContain("debateResponses");
    expect(out).toContain("The seventh debate's first turn.");
    expectClean(h);
  });
  it("#109 a post whose own debate flag is off gets no turns, whatever its id", async () => {
    const id = "iNYdKoGsh4ffxbQ5t"; // one of the six once listed
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "Not A Debate Now", slug: "not-a-debate-now", debate: false }) }, "test")] });
    await h.call("get_post", { post: id });
    expect(h.forum.requests.map((r) => r.body).join("\n")).not.toContain("debateResponses");
  });

  // #164: the forum's API returns null contents when a post's current version is not public or missing (make_editable,
  // revisionCheckAccess); its public versions are still listed by get_history.
  it("#164 a post whose current text the forum returns as none: not 'no body text', but where its public versions are", async () => {
    const id = "nullContents00001";
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "No current text", slug: "no-current-text", contents: null }) }, "test")] });
    const line = `The text is not shown here: the forum's API gives logged-out readers no current version of this post. Its public versions, if any: get_history {post: "${id}"}.`;
    for (const args of [{}, { match: "anything" }, { section: 1 }]) {
      const out = (await h.call("get_post", { post: id, ...args })).text;
      expect(out, JSON.stringify(args)).toContain(line);
      expect(out, JSON.stringify(args)).not.toMatch(/no body text|0 of 0 paragraphs|has no headings/);
    }
    expectClean(h);
  });
  it("#164 a linkpost with no current text says where it links", async () => {
    const id = "nullContents00002";
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "A link", slug: "a-link", contents: null, url: "https://example.com/y" }) }, "test")] });
    expect((await h.call("get_post", { post: id })).text).toContain(`no current version of this post. Its public versions, if any: get_history {post: "${id}"}. It links to https://example.com/y.`);
    expectClean(h);
  });
  it("#164 a debate post with no current text shows the line, then its public turns; the line heads every page", async () => {
    const id = "nullDebate0000001";
    const turnText = Array.from({ length: 400 }, (_, i) => `Turn paragraph ${i + 1} of a long debate turn with a few more words in it.`).join("\n\n");
    const turn = { ...rawCommentRef({ _id: "nullDebateTurn001", postId: id, af: false, debateResponse: true, postedAt: "2023-09-06T14:00:00.000Z" }), contents: { markdown: turnText } };
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "A debate with no current text", slug: "a-debate-with-no-current-text", debate: true, contents: null }) }, "test"),
      gqlEntry({ root: "comments", view: "debateResponses", terms: { postId: id } }, { results: [turn] }, "test"),
    ] });
    const line = `The text is not shown here: the forum's API gives logged-out readers no current version of this post. Its public versions, if any: get_history {post: "${id}"}.`;
    const first = (await h.call("get_post", { post: id, max_tokens: 2000 })).text;
    expect(first).toContain(line);
    expect(first).toContain("Turn paragraph 1 of a long debate turn");
    expect(first).not.toContain("Old-style debate post");
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(first)![1];
    expect((await h.call("get_post", { cursor, max_tokens: 2000 })).text).toContain(line);
    // The recheck: with match the turns are not read, and the page says so after the line.
    expect((await h.call("get_post", { post: id, match: "paragraph" })).text).toContain(`${line}\nIts debate turns are not searched or shown with section or match: read the post without either to see them.`);
    expectClean(h);
  });
  // The final check: the page-not-read line is followed by the debate-turns line too.
  it("a debate post whose page can't be read, read with section or match, says so and that its turns are left out", async () => {
    const id = "noPageDebate00001";
    const base = rawPostFull({ _id: id, title: "A debate without its page", slug: "a-debate-without-its-page", debate: true });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id }, { result: { ...base, contents: { ...base.contents, html: null } } }, "test")] });
    const lines = "The text is not shown: it is read from the post's page, and the page could not be read. Try again later.\n" +
      "Its debate turns are not searched or shown with section or match: read the post without either to see them.";
    for (const args of [{ section: 1 }, { match: "anything" }]) expect((await h.call("get_post", { post: id, ...args })).text, JSON.stringify(args)).toContain(lines);
    expect(h.forum.requests.map((r) => r.body).join("\n")).not.toContain("debateResponses");
    expectClean(h);
  });
  // #71: an event's page shows its time, its place (in person) or its online link, and a contact (PostsPageEventData).
  const eventDoc = (o: Record<string, unknown>) => rawPostFull({ _id: "eventPost00000001", title: "A meetup", slug: "a-meetup", isEvent: true,
    startTime: null, endTime: null, onlineEvent: false, location: null, joinEventLink: null, contactInfo: null, ...o });
  const eventOut = async (o: Record<string, unknown>) => {
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "eventPost00000001" }, { result: eventDoc(o) }, "test")] });
    const out = (await h.call("get_post", { post: "eventPost00000001" })).text;
    expectClean(h);
    return { h, out };
  };
  it("#71 an in-person event shows its time, place and contact, as its page does", async () => {
    const { h, out } = await eventOut({ startTime: "2024-05-01T18:00:00.000Z", endTime: "2024-05-01T21:00:00.000Z", location: "2nd St, Berkeley, CA", contactInfo: "host@example.com" });
    expect(out).toContain('Event: 2024-05-01 18:00Z to 2024-05-01 21:00Z · at "2nd St, Berkeley, CA" · contact "host@example.com"');
    expect(h.forum.requests[0]!.body).toMatch(/startTime endTime onlineEvent location joinEventLink contactInfo/);
  });
  it("#71 an online event shows its link and never a location, which its page hides; no time reads as TBD", async () => {
    const linked = (await eventOut({ startTime: "2024-05-01T18:00:00.000Z", onlineEvent: true, joinEventLink: "https://zoom.us/j/1", location: "PLANTED-ONLINE-LOCATION" })).out;
    expect(linked.split("\n").find((l) => l.startsWith("Event:"))).toBe("Event: 2024-05-01 18:00Z · online at https://zoom.us/j/1");
    expect(linked).not.toContain("PLANTED");
    const tbd = (await eventOut({ onlineEvent: true, location: "PLANTED-ONLINE-LOCATION" })).out;
    expect(tbd).toContain("Event: time TBD · online");
    expect(tbd).not.toContain("PLANTED");
  });
  it("#71 an event with an end time only shows that time, as its page does", async () => {
    expect((await eventOut({ endTime: "2024-05-01T21:00:00.000Z", location: "2nd St" })).out).toContain('Event: 2024-05-01 21:00Z · at "2nd St"');
  });
  it("#71 a post that is not an event shows no event line, whatever its event fields hold", async () => {
    expect((await eventOut({ isEvent: false, startTime: "2024-05-01T18:00:00.000Z", location: "Somewhere" })).out).not.toContain("Event:");
  });
  // #48: the turns are read only for the whole post, so match and section say so on a debate post.
  it("#48 match or section on a debate post says its turns are not searched or shown with them", async () => {
    const id = "debateSeven000001";
    const turn = { ...rawCommentRef({ _id: "seventhTurn000001", postId: id, af: false, debateResponse: true, postedAt: "2023-09-06T14:00:00.000Z" }), contents: { markdown: "The banana split argument holds." } };
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "Another Debate", slug: "another-debate", debate: true,
        contents: { version: "1.0.0", editedAt: "2023-09-06T12:00:00.000Z", html: "<h1>One</h1><p>Intro one.</p><h1>Two</h1><p>Intro two.</p>" } }) }, "test"),
      gqlEntry({ root: "comments", view: "debateResponses", terms: { postId: id } }, { results: [turn] }, "test"),
    ] });
    const line = "Its debate turns are not searched or shown with section or match: read the post without either to see them.";
    const matched = (await h.call("get_post", { post: id, match: "banana split" })).text;
    expect(matched).toContain(`0 of 4 paragraphs contain "banana split".\n${line}`); // the two headings count as paragraphs
    expect((await h.call("get_post", { post: id, section: 1 })).text).toContain(line);
    expect(h.forum.requests.map((r) => r.body).join("\n")).not.toContain("debateResponses");
    const whole = (await h.call("get_post", { post: id })).text;
    expect(whole).not.toContain(line);
    expect(whole).toContain("The banana split argument holds.");
    expectClean(h);
  });
  // An old-style debate post's page shows its turns in place of the post's own body (PostsPage: `!post.debate` guards the body), yet
  // the forum still publishes that body (the page's search-engine data, search snippets, feed previews, RSS): it is read, labelled.
  // The debate editor asked authors to write their first dialogue comment in the body (debateEditorPlaceholder): it was meant to be read.
  const DEBATE_BODY = "Old-style debate post: its page shows the debate turns in place of the post's own body, where the debate editor asked authors to write their first dialogue comment. That body is read here; the forum still publishes it (in search results, for one).";
  const debateEntries = (id: string, html: string) => [
    gqlEntry({ root: "post", id }, { result: rawPostFull({ _id: id, title: "Another Debate", slug: "another-debate", debate: true,
      contents: { version: "1.0.0", editedAt: "2023-09-06T12:00:00.000Z", html } }) }, "test"),
    gqlEntry({ root: "comments", view: "debateResponses", terms: { postId: id } }, {
      results: [{ ...rawCommentRef({ _id: "seventhTurn000001", postId: id, af: false, debateResponse: true, postedAt: "2023-09-06T14:00:00.000Z" }), contents: { markdown: "The first turn." } }],
    }, "test"),
  ];
  it("an old-style debate post's own body is labelled on the first page of every read: whole, section, match and outline", async () => {
    const id = "debateSeven000001";
    const h = createHarness({ families: FAMS, extra: debateEntries(id, "<h1>One</h1><p>Intro one.</p><h1>Two</h1><p>Intro two.</p>") });
    for (const args of [{}, { section: 1 }, { match: "intro" }, { include_body: false }]) {
      const out = (await h.call("get_post", { post: id, ...args })).text;
      expect(out, JSON.stringify(args)).toContain(DEBATE_BODY);
      expect(out.split("\n").filter((l) => l === DEBATE_BODY), JSON.stringify(args)).toHaveLength(1);
    }
    // It heads the text: before the body (whole), the outline (include_body false) and the match line.
    const whole = (await h.call("get_post", { post: id })).text;
    expect(whole.indexOf(DEBATE_BODY)).toBeLessThan(whole.indexOf("Intro one."));
    expect(whole).toContain("The first turn.");
    const outline = (await h.call("get_post", { post: id, include_body: false })).text;
    expect(outline.indexOf(DEBATE_BODY)).toBeLessThan(outline.indexOf("Outline"));
    const matched = (await h.call("get_post", { post: id, match: "intro" })).text;
    expect(matched).toContain(`${DEBATE_BODY}\n2 of 4 paragraphs contain "intro".`);
    expectClean(h);
  });
  it("a stopped first page of a debate post, whose word count is the body's, carries the label; so does its restart", async () => {
    const id = "debateSeven000001";
    const h = createHarness({ families: FAMS, extra: debateEntries(id, "<h1>One</h1><p>Intro one.</p><h1>Two</h1><p>Intro two.</p>") });
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes(id) && !b.includes("debateResponses"), delayMs: 41_000 });
    const stopped = (await h.call("get_post", { post: id })).text;
    expect(stopped).toMatch(/Stopped early \(time limit\)/);
    expect(stopped).toMatch(/~\d+ words? · /);
    expect(stopped).not.toContain("--- begin text");
    expect(stopped).toContain(DEBATE_BODY);
    const cursor = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(stopped)![1];
    const next = (await h.call("get_post", { cursor })).text;
    expect(next.split("\n").filter((l) => l === DEBATE_BODY)).toHaveLength(1);
    expect(next).toContain("Intro one.");
  });
  it("the debate label is on the first page only", async () => {
    const id = "debateLong0000001";
    const paras = Array.from({ length: 300 }, (_, i) => `<p>Body paragraph ${i + 1} of a long debate post, with a few more words in it.</p>`).join("");
    const h = createHarness({ families: FAMS, extra: debateEntries(id, paras) });
    const pages = await allPages(h, { post: id }, 2000);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toContain(DEBATE_BODY);
    for (const p of pages.slice(1)) expect(p).not.toContain("Old-style debate post");
    expectClean(h);
  });
  it("no debate label on a debate post with no body text, nor on any other post", async () => {
    const id = "debateEmpty000001";
    const h = createHarness({ families: FAMS, extra: [...debateEntries(id, ""), gqlEntry({ root: "post", id: "plainPost00000001" }, { result: rawPostFull({ _id: "plainPost00000001", title: "Plain", slug: "plain" }) }, "test")] });
    const empty = (await h.call("get_post", { post: id })).text;
    expect(empty).toContain("This post has no body text.");
    expect(empty).toContain("The first turn.");
    expect(empty).not.toContain("Old-style debate post");
    expect((await h.call("get_post", { post: "plainPost00000001" })).text).not.toContain("Old-style debate post");
    expectClean(h);
  });
  it("¶3.7 a debate turn and a match hit cut by the page resume under their own first line: `▶ turn n · …` and `section N · paragraph M`", async () => {
    const debate = "iNYdKoGsh4ffxbQ5t"; // one of the 6 debate posts (CONFIG.debatePostIds), with no fixture of its own
    const turnText = Array.from({ length: 400 }, (_, i) => `Turn paragraph ${i + 1} of a long debate turn with a few more words in it.`).join("\n\n");
    const turn = { ...rawCommentRef({ _id: "longTurn000000001", postId: debate, af: false, debateResponse: true, postedAt: "2023-09-06T14:00:00.000Z" }), contents: { markdown: turnText } };
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id: debate }, { result: rawPostFull({ _id: debate, title: "A Long Debate", slug: "a-long-debate", debate: true }) }, "§8.9"),
      gqlEntry({ root: "comments", view: "debateResponses", terms: { postId: debate } }, { results: [turn] }, "§8.9"),
    ] });
    const pages = await allPages(h, { post: debate }, 2000);
    const withTurnText = pages.filter((p) => /Turn paragraph \d+ of a long debate turn/.test(p));
    expect(withTurnText.length).toBeGreaterThan(2);
    const header = /^▶ turn 1 · "Sample Author" \(user_slug sample-author\) · 2023-09-06 14:00Z · comment_id longTurn000000001 \(LW only\)$/m;
    for (const p of withTurnText) expect(p).toMatch(header);
    expect(pages.join("\n").match(/Turn paragraph 400 of/g)).toHaveLength(1);
    // A match hit: one 3,000-word paragraph under a heading, cut at 2,000 tokens, resumes under its `section N · paragraph M` line.
    const hit = Array.from({ length: 300 }, (_, i) => `sentence ${i + 1} mentions the needle word again`).join(", ") + ".";
    const long = rawPostFull({ _id: "longHitPost000001", title: "Long Hit", slug: "long-hit", contents: { version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", markdown: `# Intro\n\n${hit}` } });
    const m = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "longHitPost000001" }, { result: long }, "§6.5")] });
    const hitPages = await allPages(m, { post: "longHitPost000001", match: "needle" }, 2000);
    expect(hitPages.length).toBeGreaterThan(1);
    for (const p of hitPages) {
      expect(p).toContain('1 of 2 paragraphs contain "needle".');
      expect(p).toMatch(/^section 1 · paragraph 2$/m);
    }
    expect(hitPages.join("\n").match(/sentence 300 mentions/g)).toHaveLength(1);
  });

  // Two more canonical-sequence cases.
  it("P4 D7 a hidden canonical sequence is named with its flag, on the Canonical sequence line and on the stored-pointer line", async () => {
    const seq = "hiddenCanon000001";
    const doc = rawPostFull({
      _id: "hiddenCanonPost01", title: "In A Hidden Sequence", slug: "in-a-hidden-sequence", canonicalSequenceId: seq,
      canonicalSequence: { _id: seq, title: "A Hidden Canonical Sequence", af: false, hidden: true, canonicalCollectionSlug: null },
    });
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id: "hiddenCanonPost01" }, { result: doc }, "§11.1"),
      gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: seq } }, { results: [{ _id: "hiddenCanonCh0001", title: null, subtitle: null, number: 1,
        posts: [chapterPost("hiddenCanonPost01", "In A Hidden Sequence", 1)] }] }, "§11.2"),
    ] });
    const out = await h.call("get_post", { post: "hiddenCanonPost01", include_body: false });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Canonical sequence: \"A Hidden Canonical Sequence\" (sequence_id hiddenCanon000001, not in the site's sequence lists)");
    expect(h.forum.requests).toHaveLength(2);
    expectClean(h);
    // The stored pointer to a hidden sequence the post is no longer in carries the flag too.
    const stale = (await get({ post: "OtherSeqPost00001", include_body: false })).out.text;
    expect(stale).toContain("names \"A hidden sequence\" (sequence_id HiddenSequence001, not in the site's sequence lists), but this post is not currently in that sequence.");
  });
  it("Q101 the first post of a sequence reads the previous sequence's chapters (the pb alias of request 3) for its previous post", async () => {
    const fb = "fakeBeliefsSeq001";
    const title = "Making Beliefs Pay Rent (in Anticipated Experiences)";
    const doc = rawPostFull({
      _id: "fbFirstPost000001", title, slug: "making-beliefs-pay-rent-in-anticipated-experiences", canonicalSequenceId: fb, canonicalCollectionSlug: "rationality",
      canonicalSequence: { _id: fb, title: "Fake Beliefs", af: false, hidden: false, canonicalCollectionSlug: "rationality" },
    });
    const h = createHarness({ families: FAMS, extra: [
      gqlEntry({ root: "post", id: "fbFirstPost000001" }, { result: doc }, "§11.4"),
      // This test's view of the chapter: a second post after the first, so only the previous side needs another sequence.
      gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: fb } }, { results: [{ _id: "fbChapter00000001", title: null, subtitle: null, number: 1,
        posts: [chapterPost("fbFirstPost000001", title, 1), chapterPost("fbSecondPost00001", "Belief in Belief", 2)] }] }, "§11.2"),
    ] });
    const out = await h.call("get_post", { post: "fbFirstPost000001", include_body: false });
    expect(out.isError).toBe(false);
    expect(h.forum.requests).toHaveLength(3);
    expect(h.forum.requests[2].body).toContain('pb: chapters(selector: {SequenceChapters: {sequenceId: \\"5g5TkQTe9rmPS5vvM\\"}}');
    expect(h.forum.requests[2].body).not.toContain("nb: ");
    expect(out.text).toContain('Canonical sequence: "Fake Beliefs" (sequence_id fakeBeliefsSeq001) · previous: "The Last Post of Predictably Wrong" (post_id pwLastPost0000001, LW only, in the previous sequence of rationality: "Predictably Wrong") · next: "Belief in Belief" (post_id fbSecondPost00001, LW only)');
    expectClean(h);
  });
  // The site finds the collection from the sequence's own canonicalCollectionSlug (getSequenceCollectionBooks), not the post's.
  const pwLastWith = (postSlug: string | null, sequenceSlug: string | null): FixtureEntry => {
    const entry = loadFamilies("posts").find((e) => "root" in e.match && e.match.root === "post" && e.match.id === "pwLastPost0000001")!;
    const copy = JSON.parse(JSON.stringify(entry)) as FixtureEntry & { result: { result: { canonicalCollectionSlug: string | null; canonicalSequence: { canonicalCollectionSlug: string | null } } } };
    copy.result.result.canonicalCollectionSlug = postSlug;
    copy.result.result.canonicalSequence.canonicalCollectionSlug = sequenceSlug;
    return copy;
  };
  it("the collection is the canonical sequence's, as the site finds it: a sequence in none crosses nowhere, whatever the post names", async () => {
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false }, createHarness({ families: FAMS, extra: [pwLastWith("rationality", null)] }));
    expect(out.text).toContain('Canonical sequence: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM) · previous: "Preface" (post_id pwFirstPost000001, LW only)\n');
    expect(h.forum.requests).toHaveLength(2);
    expect(h.forum.requests[1].body).not.toContain("collections(");
    expectClean(h);
  });
  it("the collection is the canonical sequence's, as the site finds it: a post that names none still crosses when its sequence is in one", async () => {
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false }, createHarness({ families: FAMS, extra: [pwLastWith(null, "rationality")] }));
    expect(out.text).toContain('· next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    expect(h.forum.requests).toHaveLength(3);
    expectClean(h);
  });
  // The site's links step one entry of the books' sequenceIds, whatever that entry is (getSurroundingSequencePostIdTuples).
  it("the last post before a hidden sequence: the site links into it, so its first post is named, with the flag", async () => {
    const listing = loadFamilies(...FAMS).find((e) => "root" in e.match && e.match.root === "collections")!;
    const copy = JSON.parse(JSON.stringify(listing)) as FixtureEntry & { result: { results: { slug: string; books: { number: number | null; sequenceIds: string[]; sequences: Record<string, unknown>[] }[] }[] } };
    const book = copy.result.results.find((c) => c.slug === "rationality")!.books.find((b) => b.number === 1)!;
    book.sequenceIds = ["5g5TkQTe9rmPS5vvM", "HidSequence000001", ...book.sequenceIds.slice(1)];
    book.sequences.push({ ...book.sequences[0], _id: "HidSequence000001", title: "Off the Lists", hidden: true });
    const chapters = gqlEntry({ root: "chapters", view: "SequenceChapters", terms: { sequenceId: "HidSequence000001" } },
      { results: [{ _id: "HidChapter0000001", title: null, subtitle: null, number: 1, posts: [chapterPost("HidPostFirst00001", "Hidden First", 1)] }] }, "§11.2");
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false }, createHarness({ families: FAMS, extra: [copy, chapters] }));
    expect(out.text).toContain('· next: "Hidden First" (post_id HidPostFirst00001, LW only, in the next sequence of rationality: "Off the Lists", not in the site\'s sequence lists)');
    expect(h.forum.requests[2].body).toContain('nb: chapters(selector: {SequenceChapters: {sequenceId: \\"HidSequence000001\\"}}');
    expectClean(h);
  });
  it("the last post before an entry the listing holds no row for: not publicly visible, said so, and nothing of it is requested", async () => {
    const fb = "fakeBeliefsSeq001";
    const title = "Making Beliefs Pay Rent (in Anticipated Experiences)";
    const doc = rawPostFull({
      _id: "fbFirstPost000001", title, slug: "making-beliefs-pay-rent-in-anticipated-experiences", canonicalSequenceId: fb, canonicalCollectionSlug: "rationality",
      canonicalSequence: { _id: fb, title: "Fake Beliefs", af: false, hidden: false, canonicalCollectionSlug: "rationality" },
    });
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "fbFirstPost000001" }, { result: doc }, "§11.4")] });
    const out = await h.call("get_post", { post: "fbFirstPost000001", include_body: false });
    expect(out.text).toContain('Canonical sequence: "Fake Beliefs" (sequence_id fakeBeliefsSeq001) · previous: "The Last Post of Predictably Wrong" (post_id pwLastPost0000001, LW only, in the previous sequence of rationality: "Predictably Wrong") · the next sequence of rationality is not publicly visible\n');
    expect(h.forum.requests).toHaveLength(3);
    expect(h.forum.requests[2].body).not.toContain("nb: ");
    expect(out.text).not.toContain("PLANTED-P14-2");
    expectClean(h);
  });
});

/** A `POST_REF` for a chapter's post list, public and off AF. */
function rawPostRefOf(id: string, title: string) {
  return { _id: id, title, slug: title.toLowerCase().replace(/\s+/g, "-"), af: false, question: false, rejected: false, unlisted: false, shortform: false,
    hideAuthor: false, isEvent: false, hiddenRelatedQuestion: false, groupId: null, userId: "nmk3nLpQE89dMRzzN", user: rawUserRef() };
}

/** A chapter's post row (`POST_REF` plus `postedAt`), posted on 2015-03-1<day>. */
function chapterPost(id: string, title: string, day: number) {
  return { ...rawPostRefOf(id, title), postedAt: `2015-03-1${day}T00:00:00.000Z` };
}
