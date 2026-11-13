// `pageText`: a post's text is its page, as a logged-out reader sees it; these tests pin the conversion of each thing a page can
// hold.
import { describe, expect, it } from "vitest";
import { pageText, processBody, sliceSection, type ProcessedBody } from "../../src/domain/markdown";
import { classify, contains } from "../../src/text/phrases";

const read = (html: string | null | undefined, speakers = false): string | undefined => pageText({ html, speakers });

/** A page converted for get_post, its labels marked, then through the body pipeline. */
const marked = (html: string): ProcessedBody => processBody({ markdown: pageText({ html, speakers: true, markLabels: true })!, version: "1.0.0" });

const message = (name: string, body: string, header = true): string =>
  `<section class="dialogue-message ContentStyles-debateResponseBody" message-id="m1" user-id="u1" display-name="${name}" submitted-date="2024-01-01T00:00:00.000Z" user-order="1">` +
  `${header ? `<section class="dialogue-message-header CommentUserName-author UsersNameDisplay-noColor"><b>${name}</b></section>` : ""}<div>${body}</div></section>`;

describe("when there is no page", () => {
  it.each([["no answer", undefined], ["a null", null]])("%s: nothing is shown", (_, html) => {
    expect(read(html)).toBeUndefined();
  });

  it("a page nested too deeply to convert is a page that can't be read", () => {
    expect(read(`${"<div>".repeat(5000)}Text.${"</div>".repeat(5000)}`)).toBeUndefined();
  });

  it("an empty page is a page, with no text on it", () => {
    expect(read("")).toBe("");
  });
});

describe("what a page holds", () => {
  it("headings, paragraphs, emphasis and links", () => {
    expect(read('<h1>Title</h1><p>Some <em>emphasis</em> and <strong>bold</strong>, and a <a href="https://example.org/a">link</a>.</p><h2>Section</h2>'))
      .toBe("Title\n=====\n\nSome *emphasis* and **bold**, and a [link](https://example.org/a).\n\nSection\n-------");
  });

  it("a link's address with parentheses, and its title", () => {
    expect(read('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" title="A title">a page</a></p>')).toBe('[a page](https://en.wikipedia.org/wiki/Foo_\\(bar\\) "A title")');
  });

  it("a link with no text goes, and a link's text stays on one line", () => {
    expect(read('<p>One <a href="https://example.org/a"></a>two.</p>')).toBe("One two.");
    expect(read('<p><a href="https://example.org/a"><span>One</span><br><span>two</span></a></p>')).toBe("[One two](https://example.org/a)");
  });

  it("square brackets in text stay as written, unless they would read as a link", () => {
    expect(read("<p>Children [and adolescents] grow.</p>")).toBe("Children [and adolescents] grow.");
    expect(read("<p>The text [the guide](/posts/abc) is only text.</p>")).toBe("The text [the guide\\](/posts/abc) is only text.");
  });

  it("images, with what the page says of them", () => {
    expect(read('<figure class="image"><img src="https://example.org/a.png" alt="A caption"></figure>')).toBe("![A caption](https://example.org/a.png)");
    expect(read('<figure class="image"><img src="https://example.org/a.png"></figure>')).toBe("![](https://example.org/a.png)");
  });

  it("lists, quotes and code", () => {
    expect(read("<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><blockquote><p>Said.</p></blockquote><pre><code>let x = 1;</code></pre>"))
      .toBe("*   One\n*   Two\n\n1.  First\n\n> Said.\n\n    let x = 1;");
  });

  it("bold or italic around a line break, or doubled, stays well formed", () => {
    expect(read("<p><strong>Heading<br></strong><br>Text</p>")).toBe("**Heading**  \n  \nText");
    expect(read("<p><b><strong>Text</strong></b></p>")).toBe("**Text**");
    expect(read("<p><strong> Spaced </strong>out</p>")).toBe("**Spaced** out");
    expect(read("<p><em>Note<br></em>Text</p>")).toBe("*Note*  \nText");
  });

  it("superscripts, subscripts and strikethrough", () => {
    expect(read("<p>About 10<sup>6</sup> people, x<sub>1</sub>, <s>ten</s> <del>nine</del> <strike>eight</strike> five.</p>"))
      .toBe("About 10^6^ people, x~1~, ~~ten~~ ~~nine~~ ~~eight~~ five.");
  });

  it("a table, its first row the header", () => {
    expect(read("<figure class=\"table\"><table><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Alpha</td><td>1 | 2</td></tr></tbody></table></figure>"))
      .toBe("| Name | Score |\n| --- | --- |\n| Alpha | 1 \\| 2 |");
    expect(read("<table><tbody><tr><td><p>One</p><p>two</p></td><td>Three</td></tr><tr><td>Four</td><td>Five</td></tr></tbody></table>"))
      .toBe("| One two | Three |\n| --- | --- |\n| Four | Five |");
  });

  it("a table cell spanning columns keeps the columns", () => {
    expect(read('<table><tbody><tr><td colspan="2">Wide</td><td>Three</td></tr><tr><td>One</td><td>Two</td><td>Three</td></tr></tbody></table>'))
      .toBe("| Wide |   | Three |\n| --- | --- | --- |\n| One | Two | Three |");
  });

  it("a cell's column span is at least one", () => {
    expect(read('<table><tbody><tr><td colspan="-1">a</td></tr></tbody></table>')).toBe("| a |\n| --- |");
  });

  it("footnotes, in either form the forum writes their ids", () => {
    const current = '<p>Text.<span class="footnote-reference" data-footnote-reference="" data-footnote-index="1" data-footnote-id="abc" role="doc-noteref" id="fnrefabc"><sup><a href="#fnabc">[1]</a></sup></span></p>' +
      '<ol class="footnotes" data-footnote-section="" role="doc-endnotes"><li class="footnote-item" data-footnote-item="" data-footnote-index="1" data-footnote-id="abc" role="doc-endnote" id="fnabc">' +
      '<span class="footnote-back-link" data-footnote-back-link="" data-footnote-id="abc"><sup><strong><a href="#fnrefabc">^</a></strong></sup></span><div class="footnote-content" data-footnote-content="" data-footnote-id="abc"><p>A <a href="https://example.org/n">linked</a> note.</p></div></li></ol>';
    expect(read(current)).toBe("Text.[^abc]\n\n[^abc]: A [linked](https://example.org/n) note.");
    const older = '<p>Text.<span class="footnote-reference" role="doc-noteref" id="fnrefdef"><sup><a href="#fndef">[1]</a></sup></span></p>' +
      '<ol class="footnotes" role="doc-endnotes"><li class="footnote-item" role="doc-endnote" id="fndef"><span class="footnote-back-link"><sup><strong><a href="#fnrefdef">^</a></strong></sup></span><div class="footnote-content"><p>A note.</p></div></li></ol>';
    expect(read(older)).toBe("Text.[^def]\n\n[^def]: A note.");
  });

  it("a link address with a space keeps the link whole, so the words around it read on", () => {
    const text = read('<p>The <a href="https://en.wikipedia.org/wiki/Priming (psychology)">word</a> priming experiment.</p>');
    expect(text).toBe("The [word](https://en.wikipedia.org/wiki/Priming%20\\(psychology\\)) priming experiment.");
    expect(contains(text!, classify("word priming experiment", "forms"))).toBe("exact");
  });

  it("a link address loses the spaces and line breaks a browser drops; one inside it is encoded", () => {
    expect(read('<p>See <a href=" https://example.org/a ">the page</a> now</p>')).toBe("See [the page](https://example.org/a) now");
    expect(read('<p>See <a href="https://example.org/very/long\n/path">the page</a> now</p>')).toBe("See [the page](https://example.org/very/long/path) now");
  });

  it("a footnote's list beside its text is part of the note", () => {
    const html = '<p>Text.<span class="footnote-reference" data-footnote-id="g" role="doc-noteref" id="fnrefg"><sup><a href="#fng">[1]</a></sup></span></p>' +
      '<ol class="footnotes" role="doc-endnotes"><li class="footnote-item" data-footnote-id="g" role="doc-endnote" id="fng"><span class="footnote-back-link" data-footnote-id="g"><sup><strong><a href="#fnrefg">^</a></strong></sup></span>' +
      '<div class="footnote-content"><p>Goals defined in terms of sense data are</p></div><ul><li>manipulable</li><li>fragile</li></ul></li></ol>';
    const text = read(html);
    expect(text).toMatch(/^\[\^g\]: Goals defined in terms of sense data are .*manipulable.*fragile/m);
    expect(text).not.toMatch(/\[\^g\]: \^/);
  });

  it("footnotes of the Markdown editor, whose text sits in the item itself", () => {
    const html = '<p>Text<sup class="footnote-ref"><a href="#fn-abc-1" id="fnref-abc-1">[1]</a></sup>.</p>\n<hr class="footnotes-sep">\n<section class="footnotes">\n<ol class="footnotes-list">\n' +
      '<li id="fn-abc-1" class="footnote-item"><p>A <a href="https://example.org/n">linked</a> note. <a href="#fnref-abc-1" class="footnote-backref">↩︎</a></p>\n</li>\n</ol>\n</section>';
    expect(read(html)).toBe("Text[^abc-1].\n\n* * *\n\n[^abc-1]: A [linked](https://example.org/n) note.");
  });

  it("a collapsible section", () => {
    expect(read('<p>Before.</p><div class="detailsBlock"><div class="detailsBlockTitle"><p>More</p></div><div class="detailsBlockContent"><p>Inside.</p></div></div><p>After.</p>'))
      .toBe("Before.\n\n+++ More\n\nInside.\n\n+++\n\nAfter.");
  });

  it("a spoiler, in each form", () => {
    expect(read('<div class="spoilers"><p>The butler did it.</p><p>Really.</p></div>')).toBe(">! The butler did it.\n>!\n>! Really.");
    expect(read('<p class="spoiler-v2">The butler did it.</p>')).toBe(">! The butler did it.");
    expect(read('<p class="spoiler">The butler did it.</p>')).toBe(">! The butler did it.");
  });

  it("an LLM block, named as the page names it", () => {
    expect(read('<div class="llm-content-block" data-model-name="A Model"><div class="llm-content-block-content"><p>Generated.</p></div></div>'))
      .toBe('%%% llm-output model="A Model"\n\nGenerated.\n\n%%% /llm-output');
    expect(read('<div class="llm-content-block" data-model-name><p>Generated.</p></div>')).toContain('model="unknown model"');
  });

  it("embeds and widgets", () => {
    expect(read('<iframe src="https://example.org/embed"></iframe>')).toBe('<iframe src="https://example.org/embed"></iframe>');
    expect(read('<p>Try it:</p><div class="iframe-widget" data-iframe-widget-id="G7Y85KvrWzXcbewFv"></div><p>Done.</p>')).toBe("Try it:\n\n[interactive widget omitted]\n\nDone.");
  });

  it("no stylesheet", () => {
    expect(read("<style>.a {color: red}</style><p>Text.</p>")).toBe("Text.");
  });
});

describe("equations", () => {
  const current = (tex: string, display = false): string =>
    `<span class="math-tex"><mjx-container class="MathJax" jax="CHTML" style="font-size: 104.1%;"${display ? ' display="true"' : ""} aria-label="${tex}" role="math"><mjx-math class=" MJX-TEX"></mjx-math></mjx-container></span>`;
  const older = (tex: string, display = false): string =>
    `<span class="math-tex"><span class="mjpage${display ? " mjpage__block" : ""}"><span class="mjx-chtml${display ? " MJXc-display" : ""}"><span class="mjx-math" aria-label="${tex}"><span class="mjx-mrow" aria-hidden="true">x</span></span><style>.mjx-chtml {display: inline-block}</style></span></span></span>`;
  const draftJS = (tex: string): string => `<span><style>.mjx-chtml {display: inline-block}</style><span class="mjx-chtml"><span class="mjx-math" aria-label="${tex}"><span aria-hidden="true">x</span></span></span></span>`;

  it.each([["today's form", current], ["the older form", older], ["the oldest form", draftJS]])("%s, inline", (_, equation) => {
    expect(read(`<p>An equation ${equation("x^2")} and a word.</p>`)).toBe("An equation $x^2$ and a word.");
  });

  it.each([["today's form", current], ["the older form", older]])("%s, displayed", (_, equation) => {
    expect(read(`<p>Before.</p><p>${equation("E=mc^2", true)}</p><p>After.</p>`)).toBe("Before.\n\n$$E=mc^2$$\n\nAfter.");
  });

  it("a page with no TeX for an equation says one was there", () => {
    expect(read('<p>An equation <mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"></mjx-math></mjx-container> and a word.</p>')).toBe("An equation [equation] and a word.");
  });

  it("an equation stays on one line, so none of its lines can read as a heading or a fence", () => {
    expect(read(`<p>${current("a\n=\nb").replace("a\n=\nb", "a&#10;=&#10;b", )}</p>`)).toBe("$a = b$");
  });

  it("an equation's label can hold >", () => {
    expect(read(`<p>${current("a &gt; b").replace("a &gt; b", 'a > b')}</p>`)).toBe("$a > b$");
  });

  it("an equation inside code leaves nothing of the conversion behind", () => {
    expect(read('<pre><code><mjx-container aria-label="x"></mjx-container>code</code></pre>')).toBe("    code");
  });

  it("a blank equation prints nothing", () => {
    expect(read('<p>Text <mjx-container class="MathJax" aria-label=" "></mjx-container>here.</p>')).toBe("Text here.");
  });
});

describe("parts the converter leaves out", () => {
  it("a dialogue's message input is not text", () => {
    const box = '<div><section class="dialogue-message-input" user-id="u1" user-order="1" display-name="Alice"><p>PLANTED.</p></section></div>';
    const older = '<section class="dialogue-message-input"><p>PLANTED.</p></section>';
    const wrapped = '<div class="dialogue-message-input-wrapper"><p class="dialogue-message-input">PLANTED.</p></div>';
    for (const held of [box, older, wrapped]) expect(read(message("Alice", "<p>Said.</p>") + held, true)).toBe("**Alice:**\n\nSaid.");
  });

  it("a block only an editor sees, and not one a reader does", () => {
    const block = (visibility: string, text: string): string =>
      `<div class="conditionallyVisibleBlock defaultHidden" data-visibility="${visibility.replaceAll('"', "&quot;")}"><p>${text}</p></div>`;
    const html = `<p>Said.</p>${block('{"type":"todo"}', "PLANTED a to-do.")}${block('{"type":"knowsRequisite","otherPage":"a"}', "PLANTED a requisite.")}`
      + `${block("not json", "PLANTED unreadable.")}${block('{"type":"knowsRequisite","otherPage":"a","inverted":true}', "Shown to all.")}<p>The end.</p>`;
    expect(read(html)).toBe("Said.\n\nShown to all.\n\nThe end.");
  });
});

describe("speakers", () => {
  const HTML = message("Alice", "<p>Said.</p>") + message("Bob", "<p>A reply.</p>");

  it("are named when asked for", () => {
    expect(read(HTML, true)).toBe("**Alice:**\n\nSaid.\n\n**Bob:**\n\nA reply.");
  });

  it("are not named otherwise, though the page names them", () => {
    expect(read(HTML, false)).toBe("Said.\n\nA reply.");
  });

  // The final check: a message the page shows no name for is a turn of its own, not more words of the turn or the note above it.
  it("a message whose page has no header names nobody (display-name is not on the page) and is a turn of its own", () => {
    expect(read(message("Hidden Name", "<p>Said.</p>", false), true)).toBe("**Unnamed speaker:**\n\nSaid.");
    expect(read(`${message("Alice", "<p>Hello.</p>")}<p>A note.</p>${message("Hidden Name", "<p>Said.</p>", false)}`, true))
      .toBe("**Alice:**\n\nHello.\n\n**Outside the dialogue:**\n\nA note.\n\n**Unnamed speaker:**\n\nSaid.");
    expect(read(message("Hidden Name", "<p>Said.</p>", false), false)).toBe("Said.");
  });

  // The last check: a message's text was trimmed at both edges, so a code block opening it lost its first line's indent.
  it("a message that opens with a code block keeps it a code block, named or not", () => {
    const html = message("Alice", "<pre><code>def f():\n    return 1</code></pre><p>after</p>");
    expect(read(html, true)).toBe("**Alice:**\n\n    def f():\n        return 1\n\nafter");
    expect(read(html, false)).toBe("    def f():\n        return 1\n\nafter");
    expect(marked(html).md).toBe("**Alice:**\n\n    def f():\n        return 1\n\nafter");
  });

  it("a message with no text has no label", () => {
    expect(read(message("Alice", "") + message("Bob", "<p>A reply.</p>"), true)).toBe("**Bob:**\n\nA reply.");
  });

  it("are named as the page names them, not by the name the message was written under", () => {
    const renamed = message("Old Name", "<p>Said.</p>").replace("<b>Old Name</b>", "<b>New Name</b>");
    expect(read(renamed, true)).toBe("**New Name:**\n\nSaid.");
  });

  it("an embed alone keeps its speaker", () => {
    expect(read(message("Alice", '<iframe src="https://example.org/embed"></iframe>'), true)).toBe('**Alice:**\n\n<iframe src="https://example.org/embed"></iframe>');
  });

  it("a bold name in the text stays", () => {
    expect(read(message("Alice", "<p><strong>Bob:</strong> said so.</p>"), true)).toBe("**Alice:**\n\n**Bob:** said so.");
  });

  it("a name is capped at 60 code points", () => {
    expect(read(message("N".repeat(80), "<p>Said.</p>"), true)).toBe(`**${"N".repeat(59)}…:**\n\nSaid.`);
  });

  it("text between messages is marked, so that it does not read as the speaker's above", () => {
    const html = `${message("Alice", "<p>Said.</p>")}<p>An editor's note.</p>${message("Bob", "<p>A reply.</p>")}`;
    expect(read(html, true)).toBe("**Alice:**\n\nSaid.\n\n**Outside the dialogue:**\n\nAn editor's note.\n\n**Bob:**\n\nA reply.");
  });

  it("text after the last message is marked, and the mark comes once", () => {
    expect(read(`${message("Alice", "<p>Said.</p>")}<p>One note.</p><p>Another.</p>`, true)).toBe("**Alice:**\n\nSaid.\n\n**Outside the dialogue:**\n\nOne note.\n\nAnother.");
  });

  it("text under a heading of its own between messages is marked before the heading", () => {
    expect(read(`${message("Alice", "<p>Said.</p>")}<h2>Afterwards</h2><p>A note.</p>${message("Bob", "<p>A reply.</p>")}`, true))
      .toBe("**Alice:**\n\nSaid.\n\n**Outside the dialogue:**\n\nAfterwards\n----------\n\nA note.\n\n**Bob:**\n\nA reply.");
  });

  it("a heading alone between messages is no one's words and takes no mark", () => {
    expect(read(`${message("Alice", "<p>Said.</p>")}<h2>Part two</h2>${message("Bob", "<p>A reply.</p>")}`, true)).toBe("**Alice:**\n\nSaid.\n\nPart two\n--------\n\n**Bob:**\n\nA reply.");
  });

  it("text before the first message has no speaker above it, and footnotes are not text outside", () => {
    const notes = '<ol class="footnotes" role="doc-endnotes"><li class="footnote-item" data-footnote-id="a" role="doc-endnote"><div class="footnote-content"><p>A note.</p></div></li></ol>';
    expect(read(`<p>Before.</p>${message("Alice", "<p>Said.</p>")}${notes}`, true)).toBe("Before.\n\n**Alice:**\n\nSaid.\n\n[^a]: A note.");
  });

  it("nothing left of a removed input, a rule or a hidden block counts as text outside", () => {
    const hidden = '<div class="conditionallyVisibleBlock" data-visibility="{&quot;type&quot;:&quot;todo&quot;}"><p>PLANTED.</p></div>';
    expect(read(`${message("Alice", "<p>Said.</p>")}<div></div><hr>${hidden}${message("Bob", "<p>A reply.</p>")}`, true)).toBe("**Alice:**\n\nSaid.\n\n* * *\n\n**Bob:**\n\nA reply.");
  });

  it("an image between messages is marked like text", () => {
    expect(read(`${message("Alice", "<p>Said.</p>")}<figure class="image"><img src="https://example.org/a.png"></figure>`, true))
      .toBe("**Alice:**\n\nSaid.\n\n**Outside the dialogue:**\n\n![](https://example.org/a.png)");
  });

  it("no mark when no speakers are named", () => {
    expect(read(`${message("Alice", "<p>Said.</p>")}<p>A note.</p>`, false)).toBe("Said.\n\nA note.");
  });

  it("a name is one line", () => {
    expect(read(message("Two\nlines", "<p>Said.</p>"), true)).toBe("**Two lines:**\n\nSaid.");
  });
});

// #69: on the page a cell's quote is a block of its own, so the reply after it is visibly separate; in one Markdown row it is
// printed between curly quotation marks.
describe("#69 a quote inside a table cell", () => {
  it("is printed between curly quotation marks on the cell's line, so what follows it in the cell is told apart", () => {
    expect(read("<table><tbody><tr><td><p><strong>[Y][14:30]</strong></p><blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote><p>The reply.</p></td></tr></tbody></table>"))
      .toBe("| **[Y][14:30]** “Quoted one. Quoted two.” The reply. |\n| --- |");
  });
  it("alone in a cell it is quoted the same way; an empty quote adds nothing; a quote outside a table is unchanged", () => {
    expect(read("<table><tbody><tr><td><blockquote><p>Q only</p></blockquote></td><td>x</td></tr></tbody></table>")).toBe("| “Q only” | x |\n| --- | --- |");
    expect(read("<table><tbody><tr><td><blockquote></blockquote><p>y</p></td></tr></tbody></table>")).toBe("| y |\n| --- |");
    expect(read("<blockquote><p>Said.</p></blockquote>")).toBe("> Said.");
  });
});

// The review and the recheck (#75): a named dialogue's labels are the lines the converter wrote, marked as it writes them, so an
// author's own bold line equal to one stays the author's.
describe("a named dialogue's labels", () => {
  it("are the lines the converter wrote, a name with a * in it and the outside-the-dialogue mark too", () => {
    const html = message("Alice", "<p><strong>Bob:</strong></p><p>Hello.</p>") + "<p>An editor's note.</p>" + message("J*", "<p>Hi.</p>");
    const body = processBody({ markdown: pageText({ html, speakers: true, markLabels: true })!, version: "1.0.0" });
    expect(body.md).toBe("**Alice:**\n\n**Bob:**\n\nHello.\n\n**Outside the dialogue:**\n\nAn editor's note.\n\n**J*:**\n\nHi.");
    expect(body.labels).toEqual([0, 6, 10]);
    expect(body.headings.map((h) => h.text)).toEqual(["Bob:"]);
  });
  it("are not marked unless asked for", () => {
    expect(read(message("Alice", "<p>Hello.</p>"), true)).toBe("**Alice:**\n\nHello.");
  });
  it("are no words of the body", () => {
    const body = marked(message("Alice", "<p>Hello there, Bob.</p>") + "<p>A note.</p>");
    expect(body).toEqual({ md: "**Alice:**\n\nHello there, Bob.\n\n**Outside the dialogue:**\n\nA note.", version: "1.0.0", words: 5, headings: [],
      labels: [0, 4], turnEnds: [2] });
  });
  // The final check: the labels were numbered before a line separator or a carriage return in a message became a line break.
  it("are numbered on the text as shown, where a line separator or a carriage return in a message is a line of its own", () => {
    for (const said of ["<p>Hello\u2028there.</p>", "<p>Hello\u2029there.</p>", "<pre><code>a&#13;b</code></pre>"]) {
      const body = marked(message("Alice", said) + message("Bob", "<h1>Second</h1><p>More.</p>") + message("Alice", "<p>Bye.</p>"));
      const lines = body.md.split("\n");
      expect(body.md, said).not.toMatch(/[\r\u2028\u2029]/);
      expect(body.labels.map((i) => lines[i]), said).toEqual(["**Alice:**", "**Bob:**", "**Alice:**"]);
      expect(body.headings.map((h) => lines[h.line]), said).toEqual(["Second"]);
    }
  });
  // The final check: a line ending in the old mark, a private-use character an author can type, read as a label in any post.
  it("are only the lines the converter wrote: an author's private-use character stays, in a dialogue or not", () => {
    const own = "<h1>One</h1><p>Hello friend\uE001</p><h1>Two</h1><p>World.</p>";
    for (const [html, speakers] of [[own, false], [message("Alice", own), true]] as const) {
      const body = processBody({ markdown: pageText({ html, speakers, markLabels: true })!, version: "1.0.0" });
      expect(body.md, String(speakers)).toContain("\n\nHello friend\uE001\n\n");
      expect(body.labels, String(speakers)).toEqual(speakers ? [0] : []);
      expect(body.words, String(speakers)).toBe(5);
    }
  });
});

// The final check: a section opened with the label above its heading even when the heading sat in no message, or in one the page
// names nobody for; a turn's end is marked as well, so a section opens with a speaker only when its heading is in that turn.
describe("a named dialogue's sections", () => {
  const sections = (html: string) => {
    const body = marked(html);
    return (n: number): string => sliceSection(body.md, n, "post", new Set(body.labels), new Set(body.turnEnds));
  };
  it("a heading between two messages, with nothing after it, is in no turn", () => {
    expect(sections(`${message("Alice", "<p>Hello.</p>")}<h1>Interlude</h1>${message("Bob", "<p>Hi.</p>")}`)(1)).toBe("Interlude\n=========\n\n**Bob:**\n\nHi.");
  });
  it("a heading after the last message is in no turn", () => {
    expect(sections(`${message("Alice", "<p>Hello.</p>")}<h1>Coda</h1>`)(1)).toBe("Coda\n====");
  });
  it("a heading in a message the page names nobody for opens with that turn's label, after a turn or a note outside", () => {
    const unnamed = message("Gone", "<h1>A point</h1><p>x</p>", false);
    expect(sections(`${message("Alice", "<p>Hello.</p>")}${unnamed}`)(1)).toBe("**Unnamed speaker:**\n\nA point\n=======\n\nx");
    expect(sections(`${message("Alice", "<p>Hello.</p>")}<p>A note.</p>${unnamed}`)(1)).toBe("**Unnamed speaker:**\n\nA point\n=======\n\nx");
  });
  it("an empty turn adds nothing", () => {
    const body = marked(`${message("Alice", "<p>Hello.</p>")}${message("Bob", "")}${message("Carol", "<p>Hi.</p>")}`);
    expect(body).toMatchObject({ md: "**Alice:**\n\nHello.\n\n**Carol:**\n\nHi.", labels: [0, 4], turnEnds: [2, 6] });
  });
  it("a heading on a turn's last line is still in that turn", () => {
    expect(sections(`${message("Alice", "<p>Hello.</p><h3>Closing thoughts</h3>")}${message("Bob", "<p>Hi.</p>")}`)(1))
      .toBe("**Alice:**\n\n### Closing thoughts\n\n**Bob:**\n\nHi.");
  });
  it("a heading outside the dialogue with text after it opens with the outside mark; one in a turn opens with its speaker", () => {
    expect(sections(`${message("Alice", "<p>Hello.</p>")}<h1>Interlude</h1><p>A note.</p>${message("Bob", "<p>Hi.</p>")}`)(1))
      .toBe("**Outside the dialogue:**\n\nInterlude\n=========\n\nA note.\n\n**Bob:**\n\nHi.");
    const two = sections(`${message("Alice", "<p>Hello.</p><h2>Mine</h2><p>x</p><h2>Also mine</h2><p>y</p>")}${message("Bob", "<p>Hi.</p>")}`);
    expect(two(1)).toBe("**Alice:**\n\nMine\n----\n\nx");
    expect(two(2)).toBe("**Alice:**\n\nAlso mine\n---------\n\ny\n\n**Bob:**\n\nHi.");
  });
});
