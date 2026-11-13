import { describe, expect, it } from "vitest";
import { countWords, matchInText, outline, outlineText, processBody, sliceSection, stripWidgets } from "../../src/domain/markdown";
import { badInputMessage } from "../support/errors";

/** §6.4/§6.5 heading shapes: setext h1/h2, ATX, whole-line bold (also quoted), and lookalikes that are not headings. */
const DOC = [
  "Preamble line text", "", "Section A", "=========", "", "Some text.", "", "### A.1 Details", "", "**Bold heading**", "",
  "Para with **bold** inside.", "", "> **Quoted bold heading**", "", "**Two** runs **of bold**", "", "x | y", "---", "",
  "- item", "---", "", "```", "# not a heading", "```", "", "    # indented code, not a heading", "",
  "+++ Collapsible", "# hidden heading", "+++", "", "Section B", "---------", "", "#### B deep", "", "Last line.",
].join("\n");

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

  it("match keeps the paragraphs containing the needle as whole words (case and accents ignored, punctuation read as a space), with section and paragraph numbers", () => {
    const md = "Opening mesa optimizer remark.\n\n# Intro\n\nThe Mesa-Optimizer appears.\n\nNothing here.\n\n## Later\n\nA mesa optimizer again, Gödel-style.\n\nmesa optimizers plural.";
    expect(matchInText(md, "Mesa optimizer")).toEqual({
      total: 7,
      hits: [
        { section: null, paragraph: 1, text: "Opening mesa optimizer remark." },
        { section: 1, paragraph: 3, text: "The Mesa-Optimizer appears." },
        { section: 2, paragraph: 6, text: "A mesa optimizer again, Gödel-style." },
      ],
    });
    expect(matchInText(md, "inner alignment")).toEqual({ total: 7, hits: [] });
  });

  it("match finds a phrase across a link, and text in a heading or a paragraph that is all bold", () => {
    const md = "# A title\n\n**A whole paragraph in bold.**\n\nThe [map](https://example.org/a) is not it.";
    expect(matchInText(md, "map is not").hits.map((h) => h.text)).toEqual(["The [map](https://example.org/a) is not it."]);
    expect(matchInText(md, "paragraph in bold").hits.map((h) => h.text)).toEqual(["**A whole paragraph in bold.**"]);
    expect(matchInText(md, "A title").hits.map((h) => h.text)).toEqual(["# A title"]);
    expect(matchInText(md, "nothing here").total).toBe(3);
  });

  it("match does not take a speaker's label for a paragraph", () => {
    const md = "**Alice:**\n\nHello there.\n\n**Bob:**\n\nAlice said hello.";
    expect(matchInText(md, "Alice", new Set([0, 4]))).toMatchObject({ total: 2, hits: [{ text: "Alice said hello." }] }); // the label lines
    // Outside a dialogue a bold line ending in a colon is a paragraph like any other.
    expect(matchInText(md, "Alice")).toMatchObject({ total: 4, hits: [{ text: "**Alice:**" }, { text: "Alice said hello." }] });
  });

  it("match: a paragraph that starts with its own heading line is in that heading's section; a needle that folds to nothing matches nothing", () => {
    const md = "# One\n\nFirst text.\n\nTwo\n---\nGlued text.";
    expect(matchInText(md, "glued")).toEqual({ total: 3, hits: [{ section: 2, paragraph: 3, text: "Two\n---\nGlued text." }] });
    expect(matchInText(md, "?!")).toEqual({ total: 3, hits: [] });
  });

  it("Q93 a fence closes only on a line of its own character at least as long; collapsibles nest", () => {
    const md = [
      "````md", "```", "# in code", "````", "", "# After code", "", "```js```", "", "# After inline code", "",
      "+++ Outer", "+++ Inner", "+++", "# still collapsed", "+++", "", "# After collapsibles",
    ].join("\n");
    expect(outline(md).map((h) => h.text)).toEqual(["After code", "After inline code", "After collapsibles"]);
  });
});

describe("words", () => {
  it("words are tokens with a letter or digit", () => {
    expect(countWords("Hello, world — 42 !\n\n**bold** `code`")).toBe(5);
  });
});

describe("processBody (the body pipeline of ¶4.3 step 6)", () => {
  it("an empty body", () => {
    expect(processBody({ markdown: null, version: "1.0.0" })).toEqual({ md: "", version: "1.0.0", words: 0, headings: [], labels: [], turnEnds: [] });
  });

  it("widgets replaced, then measured and outlined", () => {
    const out = processBody({ markdown: "# Title\n\nAlpha beta.\n\n```widget[w1]\n<p>hi</p>\n```", version: "1.4.0" });
    expect(out).toEqual({ md: "# Title\n\nAlpha beta.\n\n[interactive widget omitted, 1 KB]", version: "1.4.0", words: 8, headings: [{ n: 1, level: 1, text: "Title", line: 0 }], labels: [], turnEnds: [] });
  });
});

// #75: the site's table of contents counts headings and whole-paragraph bold, never a dialogue's speaker header (its <b> sits in no
// paragraph), and titles each entry by its text (lib/tableOfContents.ts).
describe("#75 the outline: headings only, in clean text", () => {
  const dialogue = "**Alice:**\n\nIntro\n=====\n\nHello there, Bob.\n\n**Bob:**\n\nHi Alice.\n\n**Alice:**\n\n0\\. Prefatory comments\n----------------------\n\nText.\n\n**Bob:**\n\nYes.";
  /** The line numbers of `md`'s lines that are `labels` (as the converter's marks give them; a test names them by text). */
  const at = (md: string, ...labels: string[]): Set<number> => new Set(md.split("\n").flatMap((l, i) => (labels.includes(l) ? [i] : [])));
  const labels = at(dialogue, "**Alice:**", "**Bob:**");
  it("a named dialogue's speaker labels are not headings; a section opens with the speaker of the turn it starts in", () => {
    expect(outline(dialogue, labels).map((h) => h.text)).toEqual(["Intro", "0. Prefatory comments"]);
    expect(sliceSection(dialogue, 2, "post", labels).split("\n").slice(0, 3)).toEqual(["**Alice:**", "", "0\\. Prefatory comments"]);
    expect(matchInText(dialogue, "Yes", labels).hits.map((h) => h.section)).toEqual([2]);
  });
  // The recheck: a label that opens the next section's turn belongs to that section, not to the end of this one.
  it("a section does not end with the label of a turn that opens the next section", () => {
    const md = "**Alice:**\n\nIntro\n=====\n\nHello there, Bob.\n\n**Bob:**\n\nSecond\n======\n\nMore.\n\n**Alice:**\n\nFine.";
    const marks = at(md, "**Alice:**", "**Bob:**");
    expect(sliceSection(md, 1, "post", marks)).toBe("**Alice:**\n\nIntro\n=====\n\nHello there, Bob.");
    expect(sliceSection(md, 2, "post", marks)).toBe("**Bob:**\n\nSecond\n======\n\nMore.\n\n**Alice:**\n\nFine.");
  });
  // The review and the recheck: an author's own bold line looks like a label, even one equal to a speaker's; only the lines the
  // converter marked are labels.
  it("an author's own bold line ending in a colon stays a heading and a paragraph, even one equal to a speaker's label", () => {
    const md = "**Alice:**\n\n**Key point:**\n\nMore words.\n\n**Bob:**\n\nHi.\n\n**J*:**\n\nHello.";
    const marks = new Set([0, 6, 10]); // Alice's, Bob's and J*'s labels; line 2 is Alice's own
    expect(outline(md, marks).map((h) => h.text)).toEqual(["Key point:"]);
    expect(matchInText(md, "Key point", marks)).toEqual({ total: 4, hits: [{ section: 1, paragraph: 1, text: "**Key point:**" }] });
    const own = "**Alice:**\n\n**Bob:**\n\nI said the plan works.\n\n**Bob:**\n\nHi.";
    expect(matchInText(own, "Bob", new Set([0, 6]))).toMatchObject({ total: 3, hits: [{ paragraph: 1, text: "**Bob:**" }] });
  });
  it("the marks of ~, ^ and ~~ leave heading text only around a single word or a struck-out phrase; TeX keeps its own", () => {
    const md = "## Approx ~5 people and ~10 dogs\n\nT.\n\n## Why 2^10 and 2^20 matter\n\nT.\n\n## ~~old one~~ new\n\nT.\n\n## Bound $x^{n}y^{m}$\n\nT.";
    expect(outline(md).map((h) => h.text)).toEqual(["Approx ~5 people and ~10 dogs", "Why 2^10 and 2^20 matter", "old one new", "Bound $x^{n}y^{m}$"]);
  });
  it("a link's title and a linked image leave heading text; a bold link with words after it is no heading; one in a quote is", () => {
    const md = "## A [link](https://x.org/b \"t (x)\") in it\n\nT.\n\n## [![badge](https://x.org/i.png)](https://x.org/l) Title\n\nT.\n\n" +
      "[**Titled**](https://x.org/a \"see (here)\")\n\nT.\n\n[**Read**](https://x.org/a) (5 min)\n\nT.\n\n> [**Quoted link heading**](https://x.org/q)\n\nT.";
    expect(outline(md).map((h) => h.text)).toEqual(["A link in it", "Title", "Titled", "Quoted link heading"]);
  });
  // The final check: raw wiki Markdown (get_tag) can hold a link address with balanced parentheses, which CommonMark allows.
  it("a link address with balanced parentheses is still a link: its text titles the entry, and a bold link line counts", () => {
    const md = "## See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))\n\nT.\n\n[**Mercury**](https://en.wikipedia.org/wiki/Mercury_(planet))\n\nT.";
    expect(outline(md).map((h) => h.text)).toEqual(["See Mercury", "Mercury"]);
  });
  it("a bold paragraph wrapped in a link is a heading, as on the site, titled by its text", () => {
    expect(outline("[**Linked heading**](https://x.org/a)\n\nText.").map((h) => h.text)).toEqual(["Linked heading"]);
  });
  it("superscript, subscript and strikethrough marks and an image leave a heading's text; an image-only heading is no entry", () => {
    const md = "## Growth of x^2^ and H~2~O, ~~old~~ new\n\nText.\n\n# Title ![a diagram](https://x.org/d.png)\n\nText.\n\n# ![only](https://x.org/o.png)\n\nText.";
    expect(outline(md).map((h) => h.text)).toEqual(["Growth of x2 and H2O, old new", "Title"]);
  });
  it("without the dialogue flag a whole-line bold paragraph still counts, as on the site", () => {
    expect(outline("**Note:**\n\nText.").map((h) => h.text)).toEqual(["Note:"]);
  });
  it("an entry's text is its words: no link address, escape, emphasis mark or footnote marker", () => {
    const md = "# A [linked](https://x.org/) heading\n\nText.\n\n# 0\\. Prefatory comments\n\nText.\n\n**Bold h2**\n---\n\nText.\n\n# Has a note [^f1]\n\nText.";
    expect(outline(md).map((h) => h.text)).toEqual(["A linked heading", "0. Prefatory comments", "Bold h2", "Has a note"]);
  });
  it("a whole-line bold paragraph with italics inside counts, as on the site; two bold runs on one line do not", () => {
    const md = "***Bold italic heading***\n\nText.\n\n**Part *one* here**\n\nText.\n\n**A** and **B**\n\nText.";
    expect(outline(md).map((h) => h.text)).toEqual(["Bold italic heading", "Part one here"]);
  });
  it("an equation in a heading keeps its TeX", () => {
    expect(outline("# Has $\\alpha * \\beta_1$ in it\n\nText.").map((h) => h.text)).toEqual(["Has $\\alpha * \\beta_1$ in it"]);
  });
});
