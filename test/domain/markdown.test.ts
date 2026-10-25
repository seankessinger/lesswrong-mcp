import { describe, expect, it } from "vitest";
import {
  cleanSuggestions, countWords, dialogueHtmlToMarkdown, hasFootnotes, matchInText, needsHtml, outline, outlineText,
  processBody, sliceSection, stripWidgets,
} from "../../src/domain/markdown";
import { badInputMessage } from "../support/errors";

/** §6.4/§6.5 heading shapes: setext h1/h2, ATX, whole-line bold (also quoted), and lookalikes that are not headings. */
const DOC = [
  "Preamble line text", "", "Section A", "=========", "", "Some text.", "", "### A.1 Details", "", "**Bold heading**", "",
  "Para with **bold** inside.", "", "> **Quoted bold heading**", "", "**Two** runs **of bold**", "", "x | y", "---", "",
  "- item", "---", "", "```", "# not a heading", "```", "", "    # indented code, not a heading", "",
  "+++ Collapsible", "# hidden heading", "+++", "", "Section B", "---------", "", "#### B deep", "", "Last line.",
].join("\n");

const DIALOGUE_HTML =
  '<p>Intro paragraph.</p>' +
  '<section class="dialogue-message ContentStyles-debateResponseBody" user-id="u1" display-name="Alice" submitted-date="2024-01-02T03:04:05.000Z">' +
  '<p><b>Alice</b></p><p>Energy is <mjx-container class="MathJax" jax="CHTML" aria-label="E = mc^2"><mjx-math>junk</mjx-math></mjx-container> as usual.</p></section>' +
  '<section class="dialogue-message" user-id="u2" display-name="Bob" submitted-date="2024-01-02T03:05:00.000Z">' +
  '<p><b>Bob</b></p><p>Display:</p><mjx-container class="MathJax" jax="CHTML" display="true" aria-label="\\int_0^1 x\\,dx"><mjx-math>junk</mjx-math></mjx-container>' +
  '<p>I <b>strongly</b> agree.</p></section>';

describe("editor suggestions (P15, ¶3.7)", () => {
  it("P15 Q81 the HTML is needed only for dialogues and for editor-type post bodies with suggestion marks", () => {
    expect(needsHtml("text <ins>x</ins>", "ckEditorMarkup", false)).toBe(true);
    expect(needsHtml("text <del>x</del>", "lexical", false)).toBe(true);
    expect(needsHtml("text <ins>x</ins>", "markdown", false)).toBe(false);
    expect(needsHtml("text <del>x</del>", undefined, false)).toBe(false);
    expect(needsHtml("plain", "ckEditorMarkup", false)).toBe(false);
    expect(needsHtml(null, undefined, true)).toBe(true);
  });

  it("P15 Q81 a suggestion mark is removed only when the HTML confirms it", () => {
    const md = "Alpha <ins>inserted words</ins> beta <del>removed words</del> gamma <ins>kept insert</ins> delta <del>gone text</del>.";
    const html = "<p>Alpha beta removed words gamma kept&nbsp;insert delta.</p>";
    expect(cleanSuggestions(md, html, "ckEditorMarkup")).toEqual({
      md: "Alpha  beta removed words gamma <ins>kept insert</ins> delta <del>gone text</del>.", removed: true,
    });
    expect(cleanSuggestions(md, html, "lexical").removed).toBe(true);
  });

  it("Q81 Markdown- and HTML-type bodies and comments are never changed", () => {
    const md = "A literal <del>strike</del> typed by the author.";
    for (const type of ["markdown", "html", undefined]) expect(cleanSuggestions(md, "<p>A literal typed by the author.</p>", type)).toEqual({ md, removed: false });
  });

  it("L8 when the HTML confirms no span, nothing is removed", () => {
    expect(cleanSuggestions("A <ins>x y</ins> b <del>z w</del>.", "<p>A x y b.</p>", "ckEditorMarkup"))
      .toEqual({ md: "A <ins>x y</ins> b <del>z w</del>.", removed: false });
  });

  it("L8 a span with no text is never confirmed, so it stays", () => {
    expect(cleanSuggestions("A <ins> </ins> b <del></del>.", "<p>A b.</p>", "lexical")).toEqual({ md: "A <ins> </ins> b <del></del>.", removed: false });
    // an image alone has no words the HTML's text could hold
    const image = "A <ins>![alt text](https://x.org/i.png)</ins> b.";
    expect(cleanSuggestions(image, '<p>A <img src="https://x.org/i.png" alt="alt text"> b.</p>', "lexical")).toEqual({ md: image, removed: false });
  });

  it("P15 emphasis, escapes and adjacent markup are ignored when a mark is compared with the HTML", () => {
    const md = "A <ins>**Prediction markets** are \\_useful\\_</ins> b <ins>**bold**text</ins> c <del>_gone_ `now`</del> d.";
    const html = "<p>A <strong>Prediction markets</strong> are <em>useful</em> b <strong>bold</strong>text c gone <code>now</code> d.</p>";
    expect(cleanSuggestions(md, html, "lexical")).toEqual({
      md: "A <ins>**Prediction markets** are \\_useful\\_</ins> b <ins>**bold**text</ins> c _gone_ `now` d.", removed: true,
    });
  });

  it("P15 an entity and its literal character compare equal, whichever side holds the entity", () => {
    const literal = "A <ins>don’t panic… caf\u{E9}</ins> b.";
    const entities = "A <ins>don&#8217;t panic&hellip; caf&eacute;</ins> b.";
    expect(cleanSuggestions(literal, "<p>A don&#x2019;t panic&hellip; caf&eacute; b.</p>", "ckEditorMarkup")).toEqual({ md: literal, removed: false });
    expect(cleanSuggestions(entities, "<p>A don’t panic… café b.</p>", "ckEditorMarkup")).toEqual({ md: entities, removed: false });
    // a different word is still absent
    expect(cleanSuggestions("A <ins>don’t panic</ins> b.", "<p>A do panic b.</p>", "ckEditorMarkup")).toEqual({ md: "A  b.", removed: true });
  });

  it("P15 a link in a mark is compared by its text, as the HTML's anchor prints it", () => {
    const md = "See <ins>[the paper](https://x.org/p?a=1\\_2) and https://y.org/q</ins> now.";
    const html = '<p>See <a href="https://x.org/p?a=1_2">the paper</a> and <a href="https://y.org/q">https://y.org/q</a> now.</p>';
    expect(cleanSuggestions(md, html, "lexical")).toEqual({ md, removed: false });
  });

  it("P15 an empty HTML confirms nothing: no span is removed and suggestionsRemoved is false", () => {
    const md = "A <ins>kept</ins> b <del>also kept</del>.";
    expect(cleanSuggestions(md, "", "lexical")).toEqual({ md, removed: false });
    expect(cleanSuggestions(md, " <p></p> ", "lexical")).toEqual({ md, removed: false });
    expect(processBody({ markdown: md, html: "", type: "lexical", dialogue: false, version: "1.0.0" })).toMatchObject({ md, suggestionsRemoved: false });
  });
});

describe("embedded payloads (§6.5)", () => {
  it("Q78 widget fences become a size note; data: images are omitted; ordinary images and code stay", () => {
    const fence = "```widget[abc123]\n<div>" + "x".repeat(2048) + "</div>\n```";
    expect(stripWidgets(`Intro\n\n${fence}\n\nAfter ![chart](data:image/png;base64,AAAA) and ![ok](https://res.cloudinary.com/x.png)`))
      .toBe("Intro\n\n[interactive widget omitted, 3 KB]\n\nAfter [embedded image omitted] and ![ok](https://res.cloudinary.com/x.png)");
    expect(stripWidgets("```widget[w]\n<p>hi</p>\n```")).toBe("[interactive widget omitted, 1 KB]");
    expect(stripWidgets("```js\nconst x = 1;\n```")).toBe("```js\nconst x = 1;\n```");
  });
});

describe("outline and sections (¶3.7, §6.4, §6.5)", () => {
  it("Q93 setext h1/h2, ATX and whole-line bold paragraphs (also quoted); code, collapsibles, tables, lists and multi-run bold lines skipped", () => {
    expect(outline(DOC)).toEqual([
      { n: 1, level: 1, text: "Section A", line: 2 },
      { n: 2, level: 3, text: "A.1 Details", line: 7 },
      { n: 3, level: 5, text: "Bold heading", line: 9 },
      { n: 4, level: 5, text: "Quoted bold heading", line: 13 },
      { n: 5, level: 2, text: "Section B", line: 33 },
      { n: 6, level: 4, text: "B deep", line: 36 },
    ]);
  });

  it("the outline text numbers headings and indents by level", () => {
    expect(outlineText(outline(DOC))).toBe("1 Section A · 2     A.1 Details · 3         Bold heading · 4         Quoted bold heading · 5   Section B · 6       B deep");
  });

  it("section = n runs to the next heading of the same or a higher level", () => {
    expect(sliceSection(DOC, 3, "post")).toBe("**Bold heading**\n\nPara with **bold** inside.");
    expect(sliceSection(DOC, 5, "post")).toBe("Section B\n---------\n\n#### B deep\n\nLast line.");
    expect(sliceSection(DOC, 6, "page")).toBe("#### B deep\n\nLast line.");
    expect(sliceSection(DOC, 1, "post").startsWith("Section A\n=========\n\nSome text.")).toBe(true);
    expect(sliceSection(DOC, 1, "post").endsWith("Last line.")).toBe(true);
  });

  it("a section beyond the outline, or on a text without headings, is bad_input", () => {
    expect(badInputMessage(() => sliceSection(DOC, 7, "post"))).toBe("section: this post has 6 sections. Use a number from 1 to 6.");
    expect(badInputMessage(() => sliceSection("Just text.", 1, "page"))).toBe("section: this page has no headings. Read it without section, or use match.");
  });

  it("match keeps the paragraphs containing the needle (case, accents and punctuation ignored), with section and paragraph numbers", () => {
    const md = "Opening mesa optimizer remark.\n\n# Intro\n\nThe Mesa-Optimizer appears.\n\nNothing here.\n\n## Later\n\nA mesa optimizer again, Gödel-style.\n\nmesa optimizers plural.";
    expect(matchInText(md, "Mesa optimizer")).toEqual({
      total: 5,
      hits: [
        { section: null, paragraph: 1, text: "Opening mesa optimizer remark." },
        { section: 1, paragraph: 2, text: "The Mesa-Optimizer appears." },
        { section: 2, paragraph: 4, text: "A mesa optimizer again, Gödel-style." },
        { section: 2, paragraph: 5, text: "mesa optimizers plural." },
      ],
    });
    expect(matchInText(md, "inner alignment")).toEqual({ total: 5, hits: [] });
  });

  it("match: a paragraph that starts with its own heading line is in that heading's section; a needle that folds to nothing matches nothing", () => {
    const md = "# One\n\nFirst text.\n\nTwo\n---\nGlued text.";
    expect(matchInText(md, "glued")).toEqual({ total: 2, hits: [{ section: 2, paragraph: 2, text: "Two\n---\nGlued text." }] });
    expect(matchInText(md, "?!")).toEqual({ total: 2, hits: [] });
  });

  it("Q93 a fence closes only on a line of its own character at least as long; collapsibles nest", () => {
    const md = [
      "````md", "```", "# in code", "````", "", "# After code", "", "```js```", "", "# After inline code", "",
      "+++ Outer", "+++ Inner", "+++", "# still collapsed", "+++", "", "# After collapsibles",
    ].join("\n");
    expect(outline(md).map((h) => h.text)).toEqual(["After code", "After inline code", "After collapsibles"]);
  });
});

describe("dialogues, footnotes and words", () => {
  it("Q95 Q134 dialogue HTML: speaker names, MathJax back to $…$ and $$…$$ from aria-label, injected <b>Name</b> headers removed", () => {
    expect(dialogueHtmlToMarkdown(DIALOGUE_HTML)).toBe(
      "Intro paragraph.\n\n**Alice:**\n\nEnergy is $E = mc^2$ as usual.\n\n**Bob:**\n\nDisplay:\n\n$$\\int_0^1 x\\,dx$$\n\nI **strongly** agree.",
    );
  });

  it("Q134 MathJax output with no text (glyphs drawn by CSS) is still restored; a speaker paragraph with more than the name stays", () => {
    const html =
      '<section class="dialogue-message" display-name="Carol"><p><strong>Carol</strong></p>' +
      '<p>So <mjx-container class="MathJax" jax="CHTML" aria-label="x^2"><mjx-math><mjx-c class="mjx-c1D465"></mjx-c></mjx-math></mjx-container> grows.</p>' +
      "<p><b>Carol</b> again, with more.</p></section>";
    expect(dialogueHtmlToMarkdown(html)).toBe("**Carol:**\n\nSo $x^2$ grows.\n\n**Carol** again, with more.");
    expect(dialogueHtmlToMarkdown('<p>If <mjx-container class="MathJax" aria-label="a > b"><mjx-c></mjx-c></mjx-container> and <span class="MathJax" aria-label="c_1"></span> hold.</p>'))
      .toBe("If $a > b$ and $c_1$ hold.");
  });

  it("Q134 the injected header is removed bare (the §6.4 shape), in a paragraph and in a wrapper; a bold name in the text stays", () => {
    // The posts fixture's dialogue HTML: the header is the section's first child, outside any paragraph.
    const bare = '<section class="dialogue-message" user-id="u1" display-name="Alice" submitted-date="2024-01-01T00:00:00.000Z"><b>Alice</b><p>Hello there.</p></section>';
    expect(dialogueHtmlToMarkdown(bare)).toBe("**Alice:**\n\nHello there.");
    const header = '<section class="dialogue-message" display-name="Alice"><section class="dialogue-message-header"><b>Alice</b></section><p>Hello there.</p></section>';
    expect(dialogueHtmlToMarkdown(header)).toBe("**Alice:**\n\nHello there.");
    expect(dialogueHtmlToMarkdown('<section class="dialogue-message" display-name="Alice"> <div> <strong>Alice</strong> </div><p>Hello there.</p></section>'))
      .toBe("**Alice:**\n\nHello there.");
    const inText =
      '<section class="dialogue-message" display-name="Alice"><p>Hi.</p><p>I agree with <b>Alice</b>.</p><p><b>Alice</b> said so.</p>' +
      "<div><b>Alice</b> again.</div><b>Alice</b></section>";
    expect(dialogueHtmlToMarkdown(inText)).toBe("**Alice:**\n\nHi.\n\nI agree with **Alice**.\n\n**Alice** said so.\n\n**Alice** again.\n\n**Alice**");
  });

  it("Q79 a speaker's display name is printed as a single-line field, capped at 60 code points", () => {
    const forged = dialogueHtmlToMarkdown('<section class="dialogue-message" display-name="Al&#10;# Fake heading"><p>Text.</p></section>');
    expect(forged).toBe("**Al # Fake heading:**\n\nText.");
    // The injected header holds the name as written; it is still recognised, though the HTML parse collapses its line break.
    expect(dialogueHtmlToMarkdown('<section class="dialogue-message" display-name="Al&#10;# Fake heading"><b>Al\n# Fake heading</b><p>Text.</p></section>'))
      .toBe(forged);
    // The label is a whole-line bold paragraph like every speaker label; no ATX heading is forged from the name.
    expect(outline(forged).map((h) => h.text)).toEqual(["Al # Fake heading:"]);
    const long = "N".repeat(70);
    expect(dialogueHtmlToMarkdown(`<section class="dialogue-message" display-name="${long}"><b>${long}</b><p>Text.</p></section>`))
      .toBe(`**${"N".repeat(59)}…:**\n\nText.`);
  });

  it("footnotes are detected by a definition line; words are tokens with a letter or digit", () => {
    expect(hasFootnotes("Text[^1].\n\n[^1]: A note.")).toBe(true);
    expect(hasFootnotes("A reference [^1] without a definition.")).toBe(false);
    expect(countWords("Hello, world — 42 !\n\n**bold** `code`")).toBe(5);
  });
});

describe("processBody (the body pipeline of ¶4.3 step 6)", () => {
  it("an empty body", () => {
    expect(processBody({ markdown: null, dialogue: false, version: "1.0.0" }))
      .toEqual({ md: "", version: "1.0.0", words: 0, suggestionsRemoved: false, footnotes: false, headings: [] });
  });

  it("C-FOOTNOTES an editor-type body: confirmed suggestions removed, widgets replaced, then measured", () => {
    const out = processBody({
      markdown: "# Title\n\nAlpha <ins>secret insert</ins> beta.[^1]\n\n```widget[w1]\n<p>hi</p>\n```\n\n[^1]: A note.",
      html: "<h1>Title</h1><p>Alpha beta.</p>", type: "ckEditorMarkup", dialogue: false, version: "1.4.0",
    });
    expect(out).toEqual({
      md: "# Title\n\nAlpha  beta.[^1]\n\n[interactive widget omitted, 1 KB]\n\n[^1]: A note.", version: "1.4.0", words: 11,
      suggestionsRemoved: true, footnotes: true, headings: [{ n: 1, level: 1, text: "Title", line: 0 }],
    });
  });

  it("a dialogue takes its text from the HTML; a Markdown-type body is the author's own", () => {
    expect(processBody({ markdown: "Speakerless text.", html: DIALOGUE_HTML, type: "ckEditorMarkup", dialogue: true, version: "1.0.0" }).md)
      .toBe(dialogueHtmlToMarkdown(DIALOGUE_HTML));
    expect(processBody({ markdown: "Typed <del>as is</del>.", html: "<p>Typed.</p>", type: "markdown", dialogue: false, version: "1.0.0" }))
      .toMatchObject({ md: "Typed <del>as is</del>.", suggestionsRemoved: false });
  });
});
