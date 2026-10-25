import { describe, expect, it } from "vitest";
import { extractLinks } from "../../src/domain/links";

/** §12 link shapes: inline, autolink, bare, site-relative, image, code block, mailto. */
const MD = [
  "See [AGI Ruin](https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities) and <https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities>.",
  "Paper: https://arxiv.org/abs/2105.14111. Again [same post](/posts/uMQ3cqWDPHhjtiesc).",
  "![chart](https://res.cloudinary.com/lesswrong-2-0/image/upload/v1/chart.png)",
  "Topics: [Interpretability](https://www.lesswrong.com/w/interpretability-ml-and-ai), [Eliezer](https://www.lesswrong.com/users/eliezer_yudkowsky), [orthogonality](https://arbital.com/p/orthogonality/) (see https://example.com/page).",
  "",
  "```text",
  "https://www.lesswrong.com/posts/zHhGa3iQBQcdSifFL/a-critical-look-at-lean4-1",
  "```",
  "",
  "Write to [me](mailto:someone@example.com).",
].join("\n");

describe("extractLinks (¶4.13)", () => {
  it("Q103 links come from the current text: inline, autolinks and bare URLs; images, code and mailto excluded; de-duplicated by target", () => {
    const links = extractLinks(MD);
    expect(links.map((l) => l.url)).toEqual([
      "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities",
      "https://arxiv.org/abs/2105.14111",
      "https://www.lesswrong.com/w/interpretability-ml-and-ai",
      "https://www.lesswrong.com/users/eliezer_yudkowsky",
      "https://arbital.com/p/orthogonality/",
      "https://example.com/page",
    ]);
    expect(links.map((l) => l.text)).toEqual(["AGI Ruin", undefined, "Interpretability", "Eliezer", "orthogonality", undefined]);
    expect(links[0].target).toMatchObject({ onsite: true, ref: { kind: "post", value: "uMQ3cqWDPHhjtiesc" } });
    expect(links[1].target).toMatchObject({ onsite: false, domain: "arxiv.org" });
    expect(links[2].target).toMatchObject({ onsite: true, ref: { kind: "tag", value: "interpretability-ml-and-ai" } });
    expect(links[3].target).toMatchObject({ onsite: true, ref: { kind: "user", value: "eliezer_yudkowsky" } });
    expect(links[4].target).toMatchObject({ onsite: true, ref: { kind: "tag", value: "orthogonality" } });
    expect(links[5].target).toMatchObject({ onsite: false, domain: "example.com" });
  });

  it("a site-relative link resolves against https://www.lesswrong.com", () => {
    expect(extractLinks("Read [this](/posts/uMQ3cqWDPHhjtiesc).")).toEqual([{
      url: "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc", text: "this",
      target: expect.objectContaining({ onsite: true, ref: expect.objectContaining({ kind: "post", value: "uMQ3cqWDPHhjtiesc" }) }),
    }]);
    expect(extractLinks("No links, just [a bracket] and #anchor.")).toEqual([]);
  });

  it("Q103 an inline link may carry a title or angle brackets; its text is the bracket text, absent when empty", () => {
    const links = extractLinks([
      'A [titled](https://example.com/a "A title"), an [angled](<https://example.com/b>) and an [](https://example.com/c) link.',
      "A [spaced]( https://example.com/d  ) one.",
    ].join("\n"));
    expect(links.map((l) => [l.url, l.text])).toEqual([
      ["https://example.com/a", "titled"], ["https://example.com/b", "angled"], ["https://example.com/c", undefined], ["https://example.com/d", "spaced"],
    ]);
    expect(links[2]).not.toHaveProperty("text");
  });

  it("Q103 an image never yields a link, whether its address is bare or in angle brackets, and no bare URL is read out of it", () => {
    expect(extractLinks("![a](<https://example.com/a.png>) ![b](https://example.com/b.png \"B\") and https://example.com/c")
      .map((l) => l.url)).toEqual(["https://example.com/c"]);
  });

  it("Q103 only web links count: mailto, anchors, relative paths and other schemes are dropped; // links read as https", () => {
    const links = extractLinks([
      "[a](mailto:someone@example.com) [b](#section) [c](relative/page) [d](ftp://example.com/file) [e](tel:+15551234)",
      "[f](//example.org/page) [g](HTTPS://Example.com/Upper)",
    ].join("\n"));
    expect(links.map((l) => [l.url, l.text])).toEqual([["https://example.org/page", "f"], ["HTTPS://Example.com/Upper", "g"]]);
    expect(links[0].target).toMatchObject({ onsite: false, domain: "example.org" });
  });

  it("Q103 a bare URL loses trailing sentence punctuation and stops at brackets, parentheses and quotes", () => {
    expect(extractLinks('Go to https://example.com/a?x=1. Or https://example.com/b, or https://example.com/c; also (https://example.com/d) and "https://example.com/e"! Done: https://example.com/f?!')
      .map((l) => l.url)).toEqual([
      "https://example.com/a?x=1", "https://example.com/b", "https://example.com/c", "https://example.com/d", "https://example.com/e", "https://example.com/f",
    ]);
  });

  it("Q103 fenced code is ignored whatever the fence: ~~~, longer fences holding shorter ones, an unclosed fence", () => {
    const md = [
      "Before https://example.com/before",
      "~~~",
      "https://example.com/tilde",
      "~~~",
      "Between [kept](https://example.com/between)",
      "````md",
      "```",
      "https://example.com/nested",
      "```",
      "[x](https://example.com/still-inside)",
      "````",
      "After https://example.com/after",
      "```python",
      "https://example.com/unclosed",
      "[y](https://example.com/unclosed-too)",
    ].join("\n");
    expect(extractLinks(md).map((l) => l.url)).toEqual([
      "https://example.com/before", "https://example.com/between", "https://example.com/after",
    ]);
  });

  it("Q103 a fence line indented four spaces or more is indented code, not a fence (open or close), so the links after it stay", () => {
    const md = [
      "Before https://example.com/before",
      "    ```",
      "    an indented code sample that shows a literal fence",
      "After [kept](https://example.com/after)",
      "   ```",
      "https://example.com/inside",
      "    ```",
      "https://example.com/still-inside",
      "```",
      "Last https://example.com/last",
    ].join("\n");
    expect(extractLinks(md).map((l) => l.url)).toEqual(["https://example.com/before", "https://example.com/after", "https://example.com/last"]);
  });

  it("Q103 a fence line holding its own closing backticks is code in a line, not a fence", () => {
    expect(extractLinks("```x``` https://example.com/one\nhttps://example.com/two").map((l) => l.url)).toEqual([
      "https://example.com/one", "https://example.com/two",
    ]);
  });

  it("Q103 links are de-duplicated by the entity they name, else by URL, and the first appearance wins", () => {
    const links = extractLinks([
      "[first](https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities)",
      "[second](/posts/uMQ3cqWDPHhjtiesc) <https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc>",
      "https://example.com/page [again](https://example.com/page) https://example.com/other",
    ].join("\n"));
    expect(links.map((l) => [l.url, l.text])).toEqual([
      ["https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities", "first"],
      ["https://example.com/page", undefined],
      ["https://example.com/other", undefined],
    ]);
  });

  it("Q103 an address that names no host is not a link", () => {
    expect(extractLinks("[a](http://) and https://. and [b](https://example.com/ok)").map((l) => l.url)).toEqual(["https://example.com/ok"]);
  });

  it("Q103 an empty text and a text without links give none", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("Plain words only.\n\n> a quote")).toEqual([]);
  });
});

describe("extractLinks: linked images (¶4.13, images excluded)", () => {
  const TARGET = "https://target.example.com/page";

  it("Q103 a linked image lists only its target, without text, whether the alt is given, empty or the image has a title", () => {
    for (const image of [
      "![alt](https://cdn.example.com/i.png)",
      "![](https://cdn.example.com/i.png)",
      '![alt](https://cdn.example.com/i.png "An image title")',
      "![alt](<https://cdn.example.com/i.png>)",
      "![alt](/img/i.png)",
    ]) {
      const links = extractLinks(`Click [${image}](${TARGET}) now.`);
      expect(links.map((l) => l.url), image).toEqual([TARGET]);
      expect(links[0], image).not.toHaveProperty("text");
    }
  });

  it("Q103 text around a nested image stays the link text, the image itself is removed from it", () => {
    const links = extractLinks(`[see ![x](https://cdn.example.com/x.png) here](${TARGET})`);
    expect(links.map((l) => [l.url, l.text])).toEqual([[TARGET, "see  here"]]);
  });

  it("Q103 a linked image beside a plain link and a plain image: the image CDN is never an outgoing link", () => {
    const links = extractLinks([
      `[![a](https://cdn.example.com/1.png)](${TARGET})`,
      "![b](https://cdn.example.com/2.png) and [plain](https://example.com/plain)",
      "[![c](https://cdn.example.com/3.png)](/posts/uMQ3cqWDPHhjtiesc)",
    ].join("\n"));
    expect(links.map((l) => [l.url, l.text])).toEqual([
      [TARGET, undefined], ["https://example.com/plain", "plain"], ["https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc", undefined],
    ]);
  });

  it("Q103 an exclamation mark or an escaped bracket in the text does not hide the link; an escaped opening bracket starts none", () => {
    expect(extractLinks("[Wow! really!](https://example.com/wow) and [a \\] b](https://example.com/closing) and \\[not](https://example.com/bare)")
      .map((l) => [l.url, l.text])).toEqual([
      ["https://example.com/wow", "Wow! really!"], ["https://example.com/closing", "a \\] b"], ["https://example.com/bare", undefined],
    ]);
  });
});

describe("extractLinks: parentheses, escapes and code spans in addresses", () => {
  it("Q103 an inline address keeps parentheses, escaped as Turndown writes them or raw and balanced", () => {
    const links = extractLinks([
      "[escaped](https://en.wikipedia.org/wiki/Entropy_\\(information_theory\\)) then [raw](https://en.wikipedia.org/wiki/Foo_(bar)) then [plain](https://example.com/end).",
      "[quoted](https://en.wikipedia.org/wiki/Baz_(qux) \"A title\") and [angled](<https://en.wikipedia.org/wiki/Quux_(corge)>)",
    ].join("\n"));
    expect(links.map((l) => [l.url, l.text])).toEqual([
      ["https://en.wikipedia.org/wiki/Entropy_(information_theory)", "escaped"],
      ["https://en.wikipedia.org/wiki/Foo_(bar)", "raw"],
      ["https://example.com/end", "plain"],
      ["https://en.wikipedia.org/wiki/Baz_(qux)", "quoted"],
      ["https://en.wikipedia.org/wiki/Quux_(corge)", "angled"],
    ]);
  });

  it("Q103 backslash escapes are removed from an inline address", () => {
    expect(extractLinks("[a](https://example.com/a\\_b\\*c) [b](/users/eliezer\\_yudkowsky)").map((l) => l.url)).toEqual([
      "https://example.com/a_b*c", "https://www.lesswrong.com/users/eliezer_yudkowsky",
    ]);
  });

  it("Q103 an unbalanced closing parenthesis still ends an inline link and a bare URL", () => {
    expect(extractLinks("([a](https://example.com/one)) (https://example.com/two) (see https://example.com/three)").map((l) => l.url)).toEqual([
      "https://example.com/one", "https://example.com/two", "https://example.com/three",
    ]);
  });

  it("Q103 a bare URL keeps balanced parentheses and still loses the sentence's full stop", () => {
    expect(extractLinks("See https://en.wikipedia.org/wiki/Foo_(bar). Also (https://en.wikipedia.org/wiki/Baz_(qux)), and https://example.com/end.")
      .map((l) => l.url)).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Baz_(qux)", "https://example.com/end",
    ]);
  });

  it("Q103 a bare URL written by Turndown with escaped underscores names the entity it points at", () => {
    const links = extractLinks("Ask https://www.lesswrong.com/users/eliezer\\_yudkowsky about it, or https://example.com/a\\_b\\*c.");
    expect(links.map((l) => l.url)).toEqual(["https://www.lesswrong.com/users/eliezer_yudkowsky", "https://example.com/a_b*c"]);
    expect(links[0].target).toMatchObject({ onsite: true, ref: { kind: "user", value: "eliezer_yudkowsky" } });
  });

  it("Q103 a bare URL in an inline code span does not take the closing backtick", () => {
    expect(extractLinks("Call `https://example.com/api` or ``https://example.com/other`` first.").map((l) => l.url)).toEqual([
      "https://example.com/api", "https://example.com/other",
    ]);
  });
});

describe("extractLinks: time on author-controlled text (linear, not quadratic)", () => {
  // Each input made the committed code take over 3 s (4.5 s for the last), because a regex rescanned the text from every start.
  const PATHOLOGICAL: [string, string][] = [
    ["open inline links", "[a](".repeat(20_000)],
    ["open brackets", "[".repeat(100_000)],
    ["open angle brackets", "<http://a".repeat(20_000)],
    ["a run of dots inside a bare URL", `https://a${".".repeat(50_000)}x`],
    ["escaped brackets", "\\[".repeat(40_000)],
  ];

  it.each(PATHOLOGICAL)("Q103 %s: extractLinks finishes within 1,000 ms", (_name, text) => {
    const start = performance.now();
    extractLinks(text);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
