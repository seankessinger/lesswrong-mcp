// A post's text is read only from its page. Every route that reads a post's text is in this file, each given a fake answer whose
// other fields carry planted text: none may show it, quote it, list a link from it or confirm a phrase in it, and a route without the
// page shows no text at all.
import { describe, expect, it } from "vitest";
import { createHarness, expectClean, type Harness } from "../support/harness";
import { printedCursor } from "../support/requests";
import { gqlEntry, rawCommentList, rawPostCard, rawPostFull, rawRevRow, searchEntry } from "../support/builders";

const POST = "plantedDialogue01";
const POSTED = "2023-12-01T00:00:00.000Z";
const LATER = "2024-01-01T00:00:00.000Z";
const REV_1 = "PlantedRevision01";
const REV_2 = "PlantedRevision02";
const SAID = "Hello there, and thank you for coming along to talk this over with me in public today.";
const SAID_LATER = `${SAID} One more thing worth saying.`;
const PLANT = "PLANTEDOFFPAGE spare words";
const PLANT_LINK = "https://example.org/planted-link";
const PAGE_LINK = "https://example.org/published-link";

const withPlant = (markdown: string, plant: string): string => `${markdown}\n\n# PLANTEDOFFPAGE heading\n\n${plant} and [a spare link](${PLANT_LINK})`;

/** A message in the form the forum's page has it. */
const message = (name: string, body: string): string =>
  `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2023-12-01T00:00:00.000Z" user-order="1">` +
  `<section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section><div>${body}</div></section>`;

const page = (text: string): string => message("PLANTED-SPEAKER", `<p>${text} <a href="${PAGE_LINK}">Read on</a></p>`);
const written = (text: string, plant = PLANT): string => withPlant(`${text} [Read on](${PAGE_LINK})`, plant);

const noPage = (entry: { contents: Record<string, unknown> | null }) => ({ ...entry, contents: { ...entry.contents, html: null } });

const post = (hideAuthor: boolean) => {
  const base = rawPostFull({ _id: POST, title: "A Planted Dialogue", slug: "a-planted-dialogue", postedAt: POSTED, hideAuthor, collabEditorDialogue: true });
  return { ...base, contents: { ...base.contents!, version: "1.1.0", editedAt: LATER, markdown: written(SAID_LATER), html: page(SAID_LATER) } };
};

const revision = (id: string, version: string, editedAt: string, text: string, plant: string) =>
  gqlEntry({ root: "revision", id }, { result: { _id: id, documentId: POST, fieldName: "contents", version, editedAt, wordCount: 30, markdown: written(text, plant), html: page(text) } }, "§7.4");

const REVISIONS = [
  gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: POST, fieldName: "contents" } }, {
    results: [
      rawRevRow({ _id: REV_2, documentId: POST, version: "1.1.0", editedAt: LATER, updateType: "minor" }),
      rawRevRow({ _id: REV_1, documentId: POST, version: "1.0.0", editedAt: POSTED, updateType: "initial" }),
    ],
    totalCount: 2,
  }, "§7.2"),
  revision(REV_1, "1.0.0", POSTED, SAID, "PLANTEDOFFPAGE an earlier plant"),
  revision(REV_2, "1.1.0", LATER, SAID_LATER, PLANT),
];

const harness = (hideAuthor = false, page = true): Harness => createHarness({
  families: ["posts", "users", "comments", "tags", "sequences"],
  extra: [gqlEntry({ root: "post", id: POST }, { result: page ? post(hideAuthor) : noPage(post(hideAuthor)) }, "§6.4"), ...REVISIONS],
});

const nothingPlanted = (text: string): void => {
  expect(text).not.toMatch(/PLANTEDOFFPAGE|planted-link/);
};

describe.each([["named", false], ["anonymous", true]] as const)("get_post, a %s dialogue", (_, hideAuthor) => {
  it("shows the page's text and not the planted text", async () => {
    const h = harness(hideAuthor);
    const out = await h.call("get_post", { post: POST });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(SAID_LATER);
    nothingPlanted(out.text);
    expectClean(h);
  });

  it("a match on the planted words finds nothing", async () => {
    const out = await harness(hideAuthor).call("get_post", { post: POST, match: "spare words" });
    expect(out.text).toContain("0 of");
    nothingPlanted(out.text);
  });

  it("without the page the text is not shown, and the reply says so", async () => {
    const out = await harness(hideAuthor, false).call("get_post", { post: POST });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("The text is not shown: it is read from the post's page, and the page could not be read.");
    expect(out.text).not.toContain("no body text");
    expect(out.text).not.toContain(SAID);
    nothingPlanted(out.text);
  });

  it("a body shown is cached without the planted text; one that was withheld is not cached", async () => {
    const key = `${POST}@1.1.0${hideAuthor ? "#anonymous" : ""}`;
    const shown = harness(hideAuthor);
    await shown.call("get_post", { post: POST });
    const body = shown.services.caches.get("body", key);
    expect(body).toBeDefined();
    nothingPlanted(JSON.stringify(body));
    const failing = harness(hideAuthor, false);
    await failing.call("get_post", { post: POST });
    expect(failing.services.caches.get("body", key)).toBeUndefined();
  });
});

describe("get_post, the parts of a text", () => {
  it("an outline has no heading from the planted text, and a section none of it", async () => {
    const long = Array.from({ length: 6 }, (_, i) => `## Heading ${i + 1}\n\n${SAID}`).join("\n\n");
    const html = message("PLANTED-SPEAKER", Array.from({ length: 6 }, (_, i) => `<h2>Heading ${i + 1}</h2><p>${SAID}</p>`).join(""));
    const base = post(false);
    const doc = { ...base, contents: { ...base.contents, markdown: withPlant(long, PLANT), html } };
    const h = createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [gqlEntry({ root: "post", id: POST }, { result: doc }, "§6.4")] });
    const outline = await h.call("get_post", { post: POST, include_body: false });
    expect(outline.text).toContain("Heading 6");
    nothingPlanted(outline.text);
    nothingPlanted((await h.call("get_post", { post: POST, section: 6 })).text);
  });

  it("a page read later without its page says so, and continues with no text", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of what was published, in a fair number of words.`);
    const base = post(false);
    const doc = { ...base, contents: { ...base.contents, markdown: withPlant(long.join("\n\n"), PLANT), html: message("PLANTED-SPEAKER", long.map((p) => `<p>${p}</p>`).join("")) } };
    const h = createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [gqlEntry({ root: "post", id: POST }, { result: doc }, "§6.4")] });
    const first = await h.call("get_post", { post: POST, max_tokens: 2000 });
    nothingPlanted(first.text);
    h.clock.advance(31 * 60_000);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("POST_FULL"), body: JSON.stringify({ data: { p: { result: noPage(doc) }, s: { results: [] } } }) });
    const next = await h.call("get_post", { cursor: printedCursor(first.text), max_tokens: 2000 });
    expect(next.text).toContain("The text is not shown");
    expect(next.text).not.toContain("of what was published");
    nothingPlanted(next.text);
  });
});

describe("an ordinary post: only its page's text is read", () => {
  const PLAIN = "plainPlantedPost1";
  const PAGE_TEXT = "An ordinary published paragraph with enough words to it that one planted paragraph is a small part of the whole text here.";
  const PLANTED = `${PAGE_TEXT}\n\nPLANTEDOFFPAGE a spare paragraph with [a link](${PLANT_LINK}).\n\nThe last paragraph, with a spare word.`;
  const SHOWN = `<p>${PAGE_TEXT}</p><p>The last paragraph, with a spare word.</p>`;
  const doc = () => {
    const base = rawPostFull({ _id: PLAIN, title: "An Ordinary Post", slug: "an-ordinary-post", postedAt: POSTED });
    return { ...base, contents: { ...base.contents!, version: "1.0.0", markdown: PLANTED, html: SHOWN } };
  };
  const row = rawRevRow({ _id: REV_1, documentId: PLAIN, version: "1.0.0", editedAt: POSTED, updateType: "initial" });
  const h = (): Harness => createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [
    gqlEntry({ root: "post", id: PLAIN }, { result: doc() }, "§6.1"),
    gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: PLAIN, fieldName: "contents" } }, { results: [row], totalCount: 1 }, "§7.2"),
    gqlEntry({ root: "revision", id: REV_1 }, { result: { _id: REV_1, documentId: PLAIN, fieldName: "contents", version: "1.0.0", editedAt: POSTED, wordCount: 30, markdown: PLANTED, html: SHOWN } }, "§7.4"),
  ] });

  it("get_post shows the page's text", async () => {
    const out = await h().call("get_post", { post: PLAIN });
    expect(out.text).toContain(PAGE_TEXT);
    expect(out.text).toContain("The last paragraph, with a spare word.");
    nothingPlanted(out.text);
  });

  it("get_links lists no link from it", async () => {
    nothingPlanted((await h().call("get_links", { post: PLAIN, direction: "outgoing" })).text);
  });

  it("get_history shows the page's text, and phrases find nothing else", async () => {
    nothingPlanted((await h().call("get_history", { post: PLAIN, revision: "current" })).text);
    expect((await h().call("get_history", { post: PLAIN, phrases: ["spare paragraph"] })).text).toMatch(/neither|not in/);
  });
});

describe("get_post, an anonymous dialogue", () => {
  it("names no speaker, even when it was read with its speakers before it became anonymous", async () => {
    const named = post(false);
    const h = createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [gqlEntry({ root: "post", id: POST }, { result: named }, "§6.4")] });
    expect((await h.call("get_post", { post: POST })).text).toContain("PLANTED-SPEAKER");
    h.clock.advance(6 * 60_000);
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("POST_FULL"), body: JSON.stringify({ data: { p: { result: post(true) }, s: { results: [] } } }) });
    expect((await h.call("get_post", { post: POST })).text).not.toContain("PLANTED-SPEAKER");
  });
});

describe("a debate post with no page", () => {
  it("shows no text and still shows its turns, which are comments", async () => {
    const debate = "qbcuk8WwFnTZcXTd6";
    const base = rawPostFull({ _id: debate, title: "A Debate", slug: "a-debate", debate: true });
    const doc = { ...base, contents: { ...base.contents!, markdown: `${SAID} PLANTEDOFFPAGE`, html: null } };
    const h = createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [gqlEntry({ root: "post", id: debate }, { result: doc }, "§6.1")] });
    const out = await h.call("get_post", { post: debate });
    expect(out.text).toContain("The text is not shown");
    expect(out.text).toContain("▶ turn 1");
    nothingPlanted(out.text);
  });
});

describe("get_links", () => {
  it("lists the page's links and not the planted link, whatever was called before it", async () => {
    const first = harness();
    const out = await first.call("get_links", { post: POST, direction: "outgoing" });
    expect(out.text).toContain(PAGE_LINK);
    nothingPlanted(out.text);
    const second = harness();
    await second.call("get_post", { post: POST });
    expect((await second.call("get_links", { post: POST, direction: "outgoing" })).text).toBe(out.text);
  });

  it("without the page the links are a Partial line", async () => {
    const out = await harness(false, false).call("get_links", { post: POST, direction: "outgoing" });
    expect(out.text).toContain("Partial:");
    nothingPlanted(out.text);
  });
});

describe("get_history", () => {
  it.each([["current"], ["original"], [REV_2]])("revision %s shows the page's text and not the planted text", async (rev) => {
    const out = await harness().call("get_history", { post: POST, revision: rev });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(SAID);
    nothingPlanted(out.text);
  });

  it("a comparison holds no planted word", async () => {
    const out = await harness().call("get_history", { post: POST, revision: "original", compare_to: "current" });
    expect(out.text).toContain("One more thing");
    nothingPlanted(out.text);
  });

  it("match on the planted words finds nothing", async () => {
    const out = await harness().call("get_history", { post: POST, revision: "current", match: "spare words" });
    expect(out.text).toContain("0 of");
    nothingPlanted(out.text);
  });

  it("phrases find nothing the page does not hold", async () => {
    const out = await harness().call("get_history", { post: POST, phrases: ["spare words"] });
    expect(out.text).not.toMatch(/present in|first appears/);
    expect(out.text).toMatch(/neither|not in/);
  });

  it.each([
    ["a version", { revision: "current" }],
    ["a comparison", { revision: "original", compare_to: "current" }],
    ["phrases", { phrases: ["spare words"] }],
  ])("%s without the page shows no text and confirms nothing", async (_, args) => {
    const h = harness();
    const row = (id: string, version: string, editedAt: string, text: string) => ({ result: { _id: id, documentId: POST, fieldName: "contents", version, editedAt, wordCount: 30, markdown: written(text), html: null } });
    const older = row(REV_1, "1.0.0", POSTED, SAID);
    const newer = row(REV_2, "1.1.0", LATER, SAID_LATER);
    // Two rows are asked for the original first; one is the current version.
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("revision_text"), body: JSON.stringify({ data: "compare_to" in args || "phrases" in args ? { r1: older, r2: newer } : { r1: newer } }) });
    const out = await h.call("get_history", { post: POST, ...args });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("The forum did not return this text's page");
    expect(out.text).not.toContain(SAID);
    nothingPlanted(out.text);
  });
});

describe("a version whose page has no equation text", () => {
  const COPY = "PlantedRevision03";
  const page = (equation: string) => `<p>An equation ${equation} here, with some words around it.</p>`;
  const noTeX = '<mjx-container class="MathJax" jax="CHTML"></mjx-container>';
  const tex = '<mjx-container class="MathJax" jax="CHTML" aria-label="x^2"></mjx-container>';
  const text = (id: string, version: string, editedAt: string, html: string) =>
    gqlEntry({ root: "revision", id }, { result: { _id: id, documentId: POST, fieldName: "contents", version, editedAt, wordCount: 30, html } }, "§7.4");
  const h = (): Harness => createHarness({ families: ["posts", "users", "comments", "tags", "sequences"], extra: [
    gqlEntry({ root: "post", id: POST }, { result: post(false) }, "§6.4"),
    gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: POST, fieldName: "contents" } }, {
      results: [
        rawRevRow({ _id: COPY, documentId: POST, version: "1.1.1", editedAt: "2024-01-01T00:00:05.000Z", updateType: "patch", commitMessage: "Move images to CDN" }),
        rawRevRow({ _id: REV_2, documentId: POST, version: "1.1.0", editedAt: LATER, updateType: "minor" }),
        rawRevRow({ _id: REV_1, documentId: POST, version: "1.0.0", editedAt: POSTED, updateType: "initial" }),
      ],
      totalCount: 3,
    }, "§7.2"),
    text(REV_1, "1.0.0", POSTED, page(noTeX)),
    text(REV_2, "1.1.0", LATER, page(noTeX)),
    text(COPY, "1.1.1", "2024-01-01T00:00:05.000Z", page(tex)),
  ] });

  it("the current version is read from the image copy folded into it, whose page the forum repaired", async () => {
    const out = await h().call("get_history", { post: POST, revision: "current" });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("An equation $x^2$ here");
    expect(out.text).not.toContain("[equation]");
    expect(out.text).not.toContain("holds no equation text");
  });

  it("an older version says what its [equation] means, and that a comparison can show it as changed", async () => {
    const shown = await h().call("get_history", { post: POST, revision: "original" });
    expect(shown.text).toContain("An equation [equation] here");
    expect(shown.text).toContain("[equation] marks an equation that this version's page holds no text for");
    const compared = await h().call("get_history", { post: POST, revision: "original", compare_to: "current" });
    expect(compared.text).toContain("[equation] marks an equation that this version's page holds no text for");
  });
});

describe("a comment's earlier versions", () => {
  const ID = "EditedComment0001";
  const POSTED_THEN = "2020-05-01T00:00:00.000Z";
  const phrase = "rare comment phrase";
  const firstUse = (postedAt: string, lastEditedAt: string | null): Harness => createHarness({ families: ["users", "tags"], extra: [
    searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
    searchEntry({ index: "comments_oldest_first" }, { hits: [{ objectID: ID, _id: ID, postedAt, body: `The ${phrase} is here.`, af: false }], nbHits: 1 }, "§7.7"),
    gqlEntry({ root: "comment", id: ID }, { result: rawCommentList({ _id: ID, postedAt, lastEditedAt, af: false }) }, "§8.13"),
  ] });

  it("get_history takes no comment, and sends nothing for one", async () => {
    const h = createHarness({ families: ["posts", "comments", "tags", "revisions", "users"] });
    const out = await h.call("get_history", { comment: "HRDoDnHv8bvoW7oPZ" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Error \(bad_input\): /);
    expect(h.forum.requests).toHaveLength(0);
  });

  it("first_use reads no version of a comment: one never edited holds what it held when posted", async () => {
    const h = firstUse(POSTED_THEN, null);
    const out = await h.call("first_use", { forms: [phrase] });
    expect(out.text).toContain(`Earliest verified: comment_id ${ID}`);
    expect(out.text).toContain("present at publication");
    expect(out.text).toContain(`Read it: get_comments {comment: "${ID}"}`);
    for (const r of h.forum.requests) expect(r.body).not.toMatch(/revisionsOnDocument|revision_text/);
    expectClean(h);
  });

  it("a comment edited after posting can't be verified", async () => {
    const h = firstUse(POSTED_THEN, "2021-05-01T00:00:00.000Z");
    const out = await h.call("first_use", { forms: [phrase] });
    expect(out.text).not.toContain("Earliest verified:");
    expect(out.text).toContain("in its current text, but it was edited after posting, and a comment's earlier versions are not available");
    for (const r of h.forum.requests) expect(r.body).not.toMatch(/revisionsOnDocument|revision_text/);
  });

  it("an edit within the minute after posting is not an edit", async () => {
    const out = await firstUse(POSTED_THEN, "2020-05-01T00:00:30.000Z").call("first_use", { forms: [phrase] });
    expect(out.text).toContain("present at publication");
  });

  it("a comment from before the 2019 import exists only as that snapshot", async () => {
    const out = await firstUse("2012-05-01T00:00:00.000Z", null).call("first_use", { forms: [phrase] });
    expect(out.text).toContain("in the oldest kept text (a February-2019 snapshot)");
  });
});

describe("how the texts are read", () => {
  it("a wiki page's version is read as Markdown", async () => {
    const text = gqlEntry({ root: "revision", id: "BayesRev000000001" }, { result: { _id: "BayesRev000000001", documentId: "RkznxXmmh9b5ovdSq", fieldName: "description", version: "1.0.0", editedAt: POSTED, wordCount: 3, markdown: "A wiki text." } }, "§7.4");
    const page = createHarness({ families: ["posts", "comments", "tags", "revisions", "users"], extra: [text] });
    const out = await page.call("get_history", { tag: "RkznxXmmh9b5ovdSq", revision: "original" });
    expect(out.isError, out.text).toBe(false);
    const asked = page.forum.requests.filter((r) => r.body.includes("revision_text"));
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect(r.body).not.toContain("html");
  });

  it("texts too large for one answer are read in smaller requests", async () => {
    const big = "A long version of a post, repeated many times over here. ".repeat(2000);
    const row = (id: string, version: string, editedAt: string) => gqlEntry({ root: "revision", id }, { result: { _id: id, documentId: POST, fieldName: "contents", version, editedAt, wordCount: 30, markdown: `${SAID} ${big}`, html: `<p>${SAID} ${big}</p>${big}` } }, "§7.4");
    const h = createHarness({
      families: ["posts", "users", "comments", "tags", "sequences"],
      http: { maxResponseBytes: 300_000 },
      extra: [gqlEntry({ root: "post", id: POST }, { result: post(false) }, "§6.4"), REVISIONS[0]!, row(REV_1, "1.0.0", POSTED), row(REV_2, "1.1.0", LATER)],
    });
    const out = await h.call("get_history", { post: POST, revision: "original", compare_to: "current" });
    expect(out.isError, out.text).toBe(false);
    expect(h.forum.requests.filter((r) => r.body.includes("revision_text")).length).toBeGreaterThan(1);
  });
});

describe("first_use", () => {
  /** A phrase on the page only from the later version: it was not published until then. */
  function phrased() {
    const phrase = "rare planted phrase";
    const text = (present: boolean) => (present ? `${SAID} The ${phrase} arrives.` : SAID);
    const entry = (id: string, version: string, editedAt: string, present: boolean) => gqlEntry({ root: "revision", id }, {
      result: { _id: id, documentId: POST, fieldName: "contents", version, editedAt, wordCount: 30, markdown: `${text(present)}\n\nThe ${phrase} as spare text.`, html: message("PLANTED-SPEAKER", `<p>${text(present)}</p>`) },
    }, "§7.4");
    const posted = Date.parse(POSTED);
    return createHarness({ families: [], extra: [
      searchEntry({ index: "posts_oldest_first", query: `"${phrase}"` }, { hits: [{ objectID: POST, _id: POST, title: "A Planted Dialogue", postedAt: POSTED, body: text(true) }], nbHits: 1 }, "§7.7"),
      searchEntry({ index: "comments_oldest_first" }, { hits: [], nbHits: 0 }, "§5.9"),
      gqlEntry({ root: "posts", view: "default" }, { results: [rawPostCard({ _id: POST, title: "A Planted Dialogue", postedAt: POSTED, af: false, tags: [], collabEditorDialogue: true })] }, "§6.1"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: POST, before: new Date(posted + 5001).toISOString() } },
        { results: [{ _id: REV_1, version: "1.0.0", editedAt: POSTED, updateType: "initial" }], totalCount: 1 }, "§7.3"),
      gqlEntry({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: POST, after: new Date(posted + 5000).toISOString() } },
        { results: [rawRevRow({ _id: REV_2, documentId: POST, version: "1.1.0", editedAt: LATER, updateType: "minor" })], totalCount: 1 }, "§7.3"),
      entry(REV_1, "1.0.0", POSTED, false),
      entry(REV_2, "1.1.0", LATER, true),
    ] });
  }

  it("a phrase on the page only from a later version is dated by that version", async () => {
    const out = await phrased().call("first_use", { forms: ["rare planted phrase"] });
    expect(out.text).toMatch(/added by an edit on 2024-01-01/);
  });

  it("a second form finds nothing the page does not hold either", async () => {
    const out = await phrased().call("first_use", { forms: ["rare planted phrase", "spare text"] });
    expect(out.text).toMatch(/added by an edit on 2024-01-01/);
    expect(out.text).not.toMatch(/in the (?:original|published) text/);
  });

  it("a text with no page gives no verdict, and says why", async () => {
    const h = phrased();
    h.forum.inject({ endpoint: "graphql", when: (b) => b.includes("revision_text"), body: JSON.stringify({ data: { r1: { result: { _id: REV_1, documentId: POST, fieldName: "contents", version: "1.0.0", editedAt: POSTED, wordCount: 30, markdown: "The rare planted phrase as spare text.", html: null } } } }) });
    const out = await h.call("first_use", { forms: ["rare planted phrase"] });
    expect(out.text).toContain("Partial:");
    expect(out.text).toContain("The forum did not return this text's page");
    expect(out.text).not.toContain("in the published text");
  });
});
