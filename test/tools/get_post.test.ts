import { describe, it, expect } from "vitest";
import { getPostRequest2Ops } from "../../src/forum/templates/get_post";
import { createCallContext } from "../../src/call/context";
import { CAVEAT, CONTINUED } from "../../src/render/messages";
import type { ProcessedBody } from "../../src/domain/markdown";
import { estimateTokens } from "../../src/render/budget";
import { createHarness, expectClean, type Harness } from "../support/harness";
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

describe("get_post", () => {
  it("get_post_request2: exact text of each part", () => {
    const ctx = createCallContext("get_post", { now: () => 0 });
    const ops = getPostRequest2Ops({ postId: ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc"), reviews: true, debate: true, html: true,
      sequenceId: ctx.confirmPublic("sequence", "5g5TkQTe9rmPS5vvM"), listing: true });
    expect(ops.map((o) => o.text)).toEqual([
      'rv: comments(selector: {reviews: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 50) { results { ...COMMENT_REF baseScore reviewingForReview } }',
      'dt: comments(selector: {debateResponses: {postId: "uMQ3cqWDPHhjtiesc"}}, limit: 500) { results { ...COMMENT_REF contents { markdown } } }',
      'h: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { _id contents { html } } }',
      'ch: chapters(selector: {SequenceChapters: {sequenceId: "5g5TkQTe9rmPS5vvM"}}, limit: 500) { results { _id number posts { ...POST_REF postedAt } } }',
      'col: collections(selector: {default: {}}, limit: 10) { results { _id slug title books { _id title number postedAt sequenceIds sequences { ...SEQ_REF } } } }']);
    expect(getPostRequest2Ops({ postId: ctx.confirmPublic("post", "uMQ3cqWDPHhjtiesc"), reviews: false, debate: false, html: false, listing: false })).toEqual([]);
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
    expect(out.text).toContain("Best of LessWrong 2022 (ai safety, #1)");
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
  it("§7.7 a pre-2009 legacy post says it was originally on Overcoming Bias", async () => {
    expect((await get({ post: "obPost00000000001", include_body: false })).out.text).toContain("originally on Overcoming Bias");
  });
  it("Q111 P11 P12 P14 P15 hidden material in the header never shows", async () => {
    const t = (await get({ post: "uMQ3cqWDPHhjtiesc", include_body: false })).out.text;
    // The glossary is a capped block, one term per line (¶4.3 Paging).
    expect(t).toContain('Glossary:\n  "mesa-optimizer" — an optimizer found by an optimizer');
    expect(t).not.toContain("PLANTED-NEGATIVE-REACT");
    // A made-up post's admin-only tag, unapproved and deleted glossary terms and related question that is not public.
    const s = (await get({ post: "insSuggestPost001", include_body: false })).out.text;
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
  it("Q95 Q134 dialogue speakers come from the HTML (request 2)", async () => {
    const { h, out } = await get({ post: "dialoguePost00001" });
    expect(h.forum.requests[1].body).toContain('h: post(selector: {_id: \\"dialoguePost00001\\"}, allowNull: true) { result { _id contents { html } } }');
    expect(out.text).toContain("Alice");
  });
  it("Q81 P15 confirmed suggestions are removed, and no note is added", async () => {
    const t = (await get({ post: "suggestPost000001" })).out.text;
    expect(t).not.toContain("PLANTED-INSERT");
    expect(t).toContain("kept deleted");
    expect(t.split("\n")[2]).toBe(`Notes: ${CAVEAT["C-COUNTER"]} ${CAVEAT["C-FRONTPAGE"]}`);
  });
  it("Q101 Q50.14 neighbours from the chapter list, across the collection boundary (request 3)", async () => {
    const { h, out } = await get({ post: "pwLastPost0000001", include_body: false });
    expect(h.forum.requests).toHaveLength(3);
    expect(out.text).toContain('Canonical sequence: "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM) · previous: "Preface" (post_id pwFirstPost000001, LW only) · next: "Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
  });
  it("bestoflesswrong gives no cross-sequence neighbour", async () => {
    const { h, out } = await get({ post: "bolLastPost000001", include_body: false });
    expect(h.forum.requests).toHaveLength(2);
    expect(out.text).toContain("the next sequence of bestoflesswrong can't be determined reliably (the forum defines no order for its unnumbered books)");
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
    const doc = (version: string) => rawPostFull({ _id: "longPost000000001", title: "Long", slug: "long", contents: { version, editedAt: "2024-01-01T00:00:00.000Z", markdown: md, originalContents: { type: "markdown" } } });
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
    expect(out.text).toContain("Partial: neighbouring sequence unavailable (forum_error: Something went wrong).");
  });
  it("¶2.3 the processed body is cached as <postId>@<version>; a body shown without the HTML it needed is a Partial line and is not cached", async () => {
    const h = createHarness({ families: FAMS });
    await h.call("get_post", { post: "dialoguePost00001" });
    expect(h.services.caches.get<ProcessedBody>("body", "dialoguePost00001@1.0.0")?.md).toContain("**Alice:**");
    const failing = createHarness({ families: FAMS });
    failing.forum.inject({ endpoint: "graphql", when: (b) => b.includes("contents { html }"), body: JSON.stringify({ data: { h: null }, errors: [{ message: "Something went wrong", path: ["h"] }] }) });
    const out = (await failing.call("get_post", { post: "dialoguePost00001" })).text;
    expect(out).toContain("Partial: speaker names unavailable (forum_error: Something went wrong).");
    expect(out).toContain("Hello there.");
    expect(out).not.toContain("**Alice:**");
    expect(failing.services.caches.get("body", "dialoguePost00001@1.0.0")).toBeUndefined();
  });
  it("a post body that needs its HTML part, shown without it, is a Partial line naming the post HTML, and is not cached", async () => {
    const doc = rawPostFull({
      _id: "markedPost0000001", title: "Marked", slug: "marked",
      contents: { version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", originalContents: { type: "ckEditorMarkup" }, markdown: "Some text with <del>a marked passage</del>." },
    });
    const failing = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "markedPost0000001" }, { result: doc }, "made-up post")] });
    failing.forum.inject({ endpoint: "graphql", when: (b) => b.includes("contents { html }"), body: JSON.stringify({ data: { h: null }, errors: [{ message: "Something went wrong", path: ["h"] }] }) });
    const out = (await failing.call("get_post", { post: "markedPost0000001" })).text;
    expect(failing.forum.requests[1].body).toContain("contents { html }");
    expect(out).toContain("Partial: post HTML unavailable (forum_error: Something went wrong).");
    expect(failing.services.caches.get("body", "markedPost0000001@1.0.0")).toBeUndefined();
  });

  // ¶4.3 Paging ("a slice cursor over the context blocks and the body") and the ¶3.6 slice row.
  it("¶4.3 ¶3.6 a long glossary is a capped block: page 1 keeps the header lines, and the cursor shows every term once, in order, and the text through 100 %", async () => {
    const terms = Array.from({ length: 60 }, (_, i) => `gterm-${pad(i + 1, 2)}`);
    const definition = "An explanation in plain words of what this term means in the post, given at some length. ".repeat(4).slice(0, 295).trim();
    const doc = rawPostFull({
      _id: "glossaryPost00001", title: "Glossary", slug: "glossary",
      glossary: terms.map((term, i) => ({ _id: `glossaryTerm${pad(i + 1, 5)}`, term, approved: true, deleted: false, contents: { markdown: definition } })),
      contents: {
        version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", originalContents: { type: "markdown" },
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
  it("P7 an anonymous dialogue shows no speakers", async () => {
    const html = '<section class="dialogue-message" user-id="u1" display-name="PLANTED-SPEAKER" submitted-date="2024-01-01T00:00:00.000Z"><b>PLANTED-SPEAKER</b><p>Hello there.</p></section>';
    const base = rawPostFull({ _id: "anonDialogue00001", title: "An Anonymous Dialogue", slug: "an-anonymous-dialogue", hideAuthor: true, collabEditorDialogue: true });
    const doc = { ...base, contents: { ...base.contents, markdown: "Hello there.", html } };
    const h = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "anonDialogue00001" }, { result: doc }, "§6.4, §6.6") ] });
    const out = await h.call("get_post", { post: "anonDialogue00001" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Post "An Anonymous Dialogue" — author not publicly visible');
    expect(out.text).toContain("Hello there.");
    expect(out.text).not.toContain("PLANTED-SPEAKER");
    expect(h.forum.requests.some((r) => r.body.includes("contents { html }"))).toBe(false);
    // The same dialogue with its authors shown reads the HTML and names the speaker (the existing rule, unchanged).
    const named = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "anonDialogue00001" }, { result: { ...doc, hideAuthor: false } }, "§6.4")] });
    const shown = (await named.call("get_post", { post: "anonDialogue00001" })).text;
    expect(shown).toContain("**PLANTED-SPEAKER:**");
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
    const long = rawPostFull({ _id: "longHitPost000001", title: "Long Hit", slug: "long-hit", contents: { version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", markdown: `# Intro\n\n${hit}`, originalContents: { type: "markdown" } } });
    const m = createHarness({ families: FAMS, extra: [gqlEntry({ root: "post", id: "longHitPost000001" }, { result: long }, "§6.5")] });
    const hitPages = await allPages(m, { post: "longHitPost000001", match: "needle" }, 2000);
    expect(hitPages.length).toBeGreaterThan(1);
    for (const p of hitPages) {
      expect(p).toContain('1 of 1 paragraphs contain "needle".');
      expect(p).toMatch(/^section 1 · paragraph 1$/m);
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
