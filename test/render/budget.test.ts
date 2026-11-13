// test/render/budget.test.ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Budget, UNITS_PER_TOKEN, estimateTokens, lineUnits, sliceText, tokenUnits } from "../../src/render/budget";
import { para } from "../support/text";

describe("estimateTokens (¶3.7)", () => {
  it("counts runs of 12+ id or URL characters at chars/2", () => {
    expect(estimateTokens("uMQ3cqWDPHhjtiesc")).toBe(9); // 17 / 2
    expect(estimateTokens("https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities")).toBe(40);
    expect(estimateTokens("c_" + "A".repeat(22))).toBe(12); // a cursor token
  });
  it("counts other ASCII, including runs shorter than 12, at chars/3.3", () => {
    expect(estimateTokens("The quick brown fox")).toBe(6);
    expect(estimateTokens("abcdefghijk")).toBe(4); // 11 characters: not a dense run
    expect(estimateTokens("abcdefghijkl")).toBe(6); // 12 characters: dense
  });
  it("counts every non-ASCII code point as 1", () => {
    expect(estimateTokens("Gödel")).toBe(3);
    expect(estimateTokens("😀")).toBe(1); // one code point, two UTF-16 units
    expect(estimateTokens("")).toBe(0);
  });
  it("works in exact integer units of 1/66 token", () => {
    expect(UNITS_PER_TOKEN).toBe(66);
    expect(tokenUnits("ab")).toBe(40);
    expect(tokenUnits("abcdefghijkl")).toBe(396);
    expect(tokenUnits("ö")).toBe(66);
    expect(lineUnits("abc")).toBe(80);
  });
  it("is additive over lines joined by a newline (a dense run never crosses one)", () => {
    for (const [a, b] of [["uMQ3cqWDPHhjtiesc", "Gödel and more"], [para(10), "https://www.lesswrong.com/w/ai"]]) {
      expect(tokenUnits(a + "\n" + b)).toBe(tokenUnits(a) + 20 + tokenUnits(b));
    }
  });
});

describe("Budget (¶3.7)", () => {
  it("fills pages to at most 95 % of max_tokens", () => {
    expect(new Budget(15000).limit).toBe(14250);
    expect(new Budget(2000).limit).toBe(1900);
    expect(new Budget(40000).limit).toBe(38000);
  });
  it("charges each line with its joining newline", () => {
    const b = new Budget(2000);
    b.take("abc");
    expect(b.used).toBeCloseTo(80 / 66, 10);
    expect(b.remaining()).toBeCloseTo(1900 - 80 / 66, 10);
  });
  it("fits() is exact at the limit; reserve() and release() move raw units", () => {
    const b = new Budget(2000); // 1,900 tokens = 125,400 units
    b.reserve(125400 - lineUnits("ab"));
    expect(b.fits("ab")).toBe(true);
    expect(b.fits("abc")).toBe(false);
    b.take("ab");
    expect(b.remaining()).toBe(0);
    b.release(20);
    expect(b.remaining()).toBeCloseTo(20 / 66, 10);
  });
  it("share() floors a fraction of the limit (outline 0.25, signals 0.15, text 0.4)", () => {
    expect(new Budget(15000).share(0.25)).toBe(3562);
    expect(new Budget(15000).share(0.15)).toBe(2137);
    expect(new Budget(15000).share(0.4)).toBe(5700);
    expect(new Budget(2000).share(0.15)).toBe(285);
  });
});

describe("sliceText: fitting rule 3 cut points (¶3.7)", () => {
  it("cuts at the last blank line that fits", () => {
    const s = [para(100), para(100), para(100)].join("\n\n");
    expect(sliceText(s, 200)).toEqual({ text: para(100) + "\n\n" + para(100), next: 602, inCode: false, moreWords: 100 });
  });
  it("never cuts at a blank line inside a code fence", () => {
    const s = "Intro text here.\n\n```\nline one\n\nline two\n```\n\n" + para(200);
    expect(sliceText(s, 13)).toEqual({ text: "Intro text here.", next: 18, inCode: false, moreWords: 206 });
    expect(sliceText(s, 14)).toEqual({ text: "Intro text here.\n\n```\nline one\n\nline two\n```", next: 46, inCode: false, moreWords: 200 });
  });
  it("never cuts at a blank line inside a $$ block", () => {
    const s = "Intro.\n\n$$\na = b\n\nc = d\n$$\n\n" + para(200);
    expect(sliceText(s, 8)).toEqual({ text: "Intro.", next: 8, inCode: false, moreWords: 208 });
    expect(sliceText(s, 9)).toEqual({ text: "Intro.\n\n$$\na = b\n\nc = d\n$$", next: 28, inCode: false, moreWords: 200 });
  });
  it("falls back to the last sentence end", () => {
    const s = "First sentence here. Second sentence here. " + para(300);
    expect(sliceText(s, 40)).toEqual({ text: "First sentence here. Second sentence here.", next: 43, inCode: false, moreWords: 300 });
  });
  it("falls back to whitespace that is not inside a Markdown link", () => {
    const s = "aa bb [cc dd ee ff gg hh](https://example.com/x) ii jj " + para(300);
    expect(sliceText(s, 7)).toEqual({ text: "aa bb", next: 6, inCode: false, moreWords: 308 });
  });
  it("cuts a code block larger than the whole budget at a line break, with inCode", () => {
    const s = "```\n" + "const x = 1;\n".repeat(400) + "```";
    expect(sliceText(s, 50)).toEqual({ text: "```\n" + "const x = 1;\n".repeat(11) + "const x = 1;", next: 160, inCode: true, moreWords: 1553 });
  });
  it("takes from as an offset and returns absolute positions", () => {
    const s = [para(100), para(100), para(100)].join("\n\n");
    expect(sliceText(s, 100)).toEqual({ text: para(100), next: 301, inCode: false, moreWords: 200 });
    expect(sliceText(s, 200, 602)).toEqual({ text: para(100), next: undefined, inCode: false, moreWords: 0 });
  });
  it("never splits a surrogate pair, and returns nothing when not one character fits", () => {
    expect(sliceText("😀".repeat(10), 3)).toEqual({ text: "😀😀😀", next: 6, inCode: false, moreWords: 1 });
    expect(sliceText("😀😀😀", 0)).toEqual({ text: "", next: 0, inCode: false, moreWords: 1 });
  });
  it("property: the slice never exceeds maxTokens and always makes progress when it can", () => {
    const POOL = ["ab", "Gödel", "uMQ3cqWDPHhjtiesc", "https://x.org/abcdefghijklmn", "```", "$$", "\n\n", "\n", "😀", "end.", "[a b](https://e.com/x y)", "x"];
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...POOL), { maxLength: 400 }), fc.integer({ min: 1, max: 200 }), fc.integer({ min: 0, max: 50 }),
      (parts, max, f) => {
        const s = parts.join(" ");
        const from = Math.min(f, s.length);
        const r = sliceText(s, max, from);
        expect(estimateTokens(r.text)).toBeLessThanOrEqual(max);
        expect(r.next === undefined).toBe(estimateTokens(s.slice(from)) <= max);
        if (r.next !== undefined && r.text !== "") expect(r.next).toBeGreaterThan(from);
      },
    ), { numRuns: 300 });
  });
});

describe("sliceText: edge cases", () => {
  it("floors a fractional maxTokens: the slice never estimates above it", () => {
    const r = sliceText("x".repeat(40), 2.5); // 2 tokens = 132 units = 6 characters
    expect(r.text).toBe("x".repeat(6));
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(2.5);
  });
  it("skips a cut that would leave only whitespace before it", () => {
    const s = "   \n\n   " + para(100); // the blank line at 3 would cut off nothing but spaces
    expect(sliceText(s, 5)).toEqual({ text: "   \n\n   ab ab", next: 14, inCode: false, moreWords: 98 });
  });
  it("trims trailing whitespace from the text but not leading whitespace", () => {
    expect(sliceText("  para one  \n\n" + para(100), 8)).toEqual({ text: "  para one", next: 14, inCode: false, moreWords: 100 });
  });
  it("gives next at the end of the text when only whitespace is left after the cut", () => {
    expect(sliceText("end. \n \n", 2)).toEqual({ text: "end.", next: 8, inCode: false, moreWords: 0 });
  });
  it("returns an empty slice for an empty text, and for an offset past the end", () => {
    expect(sliceText("", 5)).toEqual({ text: "", next: undefined, inCode: false, moreWords: 0 });
    expect(sliceText("abc", 5, 10)).toEqual({ text: "", next: undefined, inCode: false, moreWords: 0 });
  });
  it("property: paging through a text shows every non-whitespace character exactly once, in order", () => {
    const POOL = ["ab", "Gödel", "uMQ3cqWDPHhjtiesc", "```", "$$", "\n\n", "\n", "😀", "end.", "[a b](https://e.com/x y)", "x", "[", "("];
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...POOL), { maxLength: 200 }), fc.integer({ min: 1, max: 60 }),
      (parts, max) => {
        const s = parts.join(" ");
        let shown = "";
        let from = 0;
        for (let pages = 0; ; pages++) {
          expect(pages).toBeLessThan(s.length + 2); // every page moves on
          const r = sliceText(s, max, from);
          shown += r.text.replace(/\s/g, "");
          if (r.next === undefined) break;
          expect(r.next).toBeGreaterThan(from);
          from = r.next;
        }
        expect(shown).toBe(s.replace(/\s/g, ""));
      },
    ), { numRuns: 200 });
  });
});

describe("sliceText: the whole rest, when it fits, comes back unchanged", () => {
  it("keeps the trailing whitespace of a rest that fits; only a cut text is trimmed", () => {
    expect(sliceText("abc\n\n", 100)).toEqual({ text: "abc\n\n", next: undefined, inCode: false, moreWords: 0 });
    const cut = sliceText("abc " + para(200) + "\n\n", 100); // does not fit: cut, and trimmed
    expect(cut.next).toBeDefined();
    expect(cut.text).toBe(cut.text.trimEnd());
  });
});

describe("sliceText: a call that resumes inside a code fence or a $$ block (¶3.7 rule 3, ¶9.2)", () => {
  const rows = (line: string) => (line + "\n").repeat(20) + "\n"; // 20 lines and a blank line, all inside the block
  const paras = Array.from({ length: 10 }, () => para(100)).join("\n\n"); // 10 paragraphs of 100 words

  /** Pages through `s`, `max` tokens at a time: each page with the offset it started from. */
  function pagesOf(s: string, max: number) {
    const pages: { from: number; r: ReturnType<typeof sliceText> }[] = [];
    for (let from: number | undefined = 0; from !== undefined; ) {
      expect(pages.length).toBeLessThan(200); // every page moves on
      const r = sliceText(s, max, from);
      pages.push({ from, r });
      from = r.next;
    }
    return pages;
  }

  const BLOCKS: [string, string, string][] = [
    ["a ``` fence", "```", rows("const x = 1;")],
    ["a ~~~ fence", "~~~", rows("const x = 1;")],
    ["a $$ block", "$$", rows("a = b + 1")],
  ];

  it.each(BLOCKS)("%s larger than a page: every page is full inside it and inCode is true exactly there", (_name, mark, body) => {
    const s = mark + "\n" + body.repeat(5) + mark + "\n\n" + paras;
    const bodyStart = mark.length;                       // after the opening mark
    const blockEnd = s.indexOf(mark, bodyStart) + mark.length; // after the closing mark
    for (const max of [60, 100, 250, 600]) {
      const pages = pagesOf(s, max);
      if (max <= 100) expect(pages.filter((p) => p.r.inCode).length).toBeGreaterThan(1); // pages that resume inside the block
      for (const { from, r } of pages) {
        const textEnd = from + r.text.length;
        const inside = textEnd >= bodyStart && textEnd < blockEnd;
        expect(r.inCode).toBe(inside);
        if (inside) {
          expect(s[r.next! - 1]).toBe("\n");             // a line break, never a blank line chosen early
          expect(estimateTokens(r.text)).toBeGreaterThanOrEqual(max - 6); // the page is full, not cut short
        }
      }
    }
  });

  it("pins the pages of an oversize ``` block: page 2 does not stop at a blank line inside the fence", () => {
    // The closing fence starts at 1309; the paragraphs start at 1314 and the last blank line in page 2's window is at 2215.
    const s = "```\n" + rows("const x = 1;").repeat(5) + "```\n\n" + paras;
    const p1 = sliceText(s, 100);
    expect(p1).toEqual({ text: s.slice(0, 329), next: 330, inCode: true, moreWords: 75 * 4 + 1 + 1000 });
    const p2 = sliceText(s, 600, p1.next);
    expect(p2).toEqual({ text: s.slice(330, 2215), next: 2217, inCode: false, moreWords: 700 });
    expect(p2.text).toContain("\n```\n\n"); // the closing fence is inside the page, with the fence state closed by it
  });

  it("pins the pages of an oversize $$ block: page 2 does not stop at a blank line inside the block", () => {
    // The closing $$ starts at 1008; the paragraphs start at 1012 and the last blank line in page 2's window is at 2214.
    const s = "$$\n" + rows("a = b + 1").repeat(5) + "$$\n\n" + paras;
    const p1 = sliceText(s, 100);
    expect(p1).toEqual({ text: s.slice(0, 323), next: 324, inCode: true, moreWords: 68 * 5 + 1 + 1000 });
    const p2 = sliceText(s, 600, p1.next);
    expect(p2).toEqual({ text: s.slice(324, 2214), next: 2216, inCode: false, moreWords: 600 });
    expect(p2.text).toContain("\n$$\n\n");
  });

  it("an indented fence whose indentation the previous cut skipped still opens the block", () => {
    // Page 1 ends at the sentence end and resumes after the indentation, at the ``` of a fence line that began before it.
    const s = "Intro sentence here.\n   ```\ncode one\n\ncode two\n```\n\n" + paras;
    const p1 = sliceText(s, 8);
    expect(p1).toEqual({ text: "Intro sentence here.", next: 24, inCode: false, moreWords: 6 + 1000 });
    const p2 = sliceText(s, 50, 24);
    expect(p2).toEqual({ text: "```\ncode one\n\ncode two\n```", next: 52, inCode: false, moreWords: 1000 });
  });

  it("a resume in the middle of a line does not read the rest of that line as a fence line", () => {
    const s = "Intro words. ```js" + " word".repeat(60) + "\n\n" + para(300);
    const p1 = sliceText(s, 10);
    expect(p1).toEqual({ text: "Intro words.", next: 13, inCode: false, moreWords: 1 + 60 + 300 });
    const p2 = sliceText(s, 150, 13);
    expect(p2).toEqual({ text: s.slice(13, 318), next: 320, inCode: false, moreWords: 300 }); // cut at the blank line
  });

  it("a resume in the middle of a line inside a block stays inside it", () => {
    const longLine = "x".repeat(11) + (" y".repeat(400)); // one code line far longer than a page
    const s = "```\n" + longLine + "\n\n" + longLine + "\n```\n\n" + paras;
    const pages = pagesOf(s, 60);
    const close = s.lastIndexOf("```");
    for (const { from, r } of pages) {
      const textEnd = from + r.text.length;
      expect(r.inCode).toBe(textEnd >= 3 && textEnd < close + 3);
    }
  });

  it("property: inCode agrees with the block state of the text before the cut, on every page", () => {
    const LINES = ["ab", "cd", "```", "~~~", "$$", "", "e=mc2", "x$$y"]; // no spaces: the cuts are blank lines and line breaks
    const blockAt = (s: string, p: number): boolean => { // an independent scan of the lines that start before p
      let fence = false;
      let math = false;
      let at = 0;
      for (const line of s.split("\n")) {
        if (at >= p) break;
        if (line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~")) fence = !fence;
        if (!fence && line.split("$$").length % 2 === 0) math = !math; // an odd number of "$$"
        at += line.length + 1;
      }
      return fence || math;
    };
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...LINES), { minLength: 20, maxLength: 120, size: "max" }), fc.integer({ min: 8, max: 40 }),
      (lines, max) => {
        const s = lines.join("\n");
        for (let from: number | undefined = 0, pages = 0; from !== undefined; pages++) {
          expect(pages).toBeLessThan(s.length + 2);
          const r = sliceText(s, max, from);
          if (r.next !== undefined) expect(r.inCode).toBe(blockAt(s, r.next));
          from = r.next;
        }
      },
    ), { numRuns: 300 });
  });
});

describe("sliceText: slicing never inside a Markdown link (¶9.2), and an unmatched bracket bars nothing", () => {
  it("a sentence end inside link text is not a cut point", () => {
    const s = "Intro [Dr. Smith's long essay](https://x.org/y) " + para(300);
    expect(sliceText(s, 20)).toEqual({ text: "Intro [Dr. Smith's long essay](https://x.org/y) ab ab", next: 54, inCode: false, moreWords: 298 });
  });
  it("a [ that is never closed is not a link: interval notation does not hide the sentence end after it", () => {
    const s = "Probability in [0, 1) is fine. Then more words here, and " + "word ".repeat(400);
    expect(sliceText(s, 30)).toEqual({ text: "Probability in [0, 1) is fine.", next: 31, inCode: false, moreWords: 405 });
  });
  it("a [ that is never closed on its line does not bar the rest of the line", () => {
    const s = "see [1 " + "word ".repeat(5000);
    expect(sliceText(s, 50)).toEqual({ text: "see [1 " + "word ".repeat(30) + "word", next: 162, inCode: false, moreWords: 4969 });
  });
  it("an unmatched [ before a complete link bars only the link", () => {
    const s = "aa [bb cc [dd ee](https://e.com/x) ff gg " + para(300);
    expect(sliceText(s, 17)).toEqual({ text: "aa [bb cc [dd ee](https://e.com/x) ff gg ab", next: 44, inCode: false, moreWords: 299 });
  });
  it("a ( that is never closed after a link bars nothing", () => {
    const s = "aa [bb](cc dd ee " + "word ".repeat(100);
    expect(sliceText(s, 10)).toEqual({ text: "aa [bb](cc dd ee word word word", next: 32, inCode: false, moreWords: 97 });
  });
  it("a nested link is one span: no cut inside the outer link, whatever is closed within it", () => {
    const s = "xx [aa [bb cc] dd](https://e.com/p q) yy " + para(300);
    const r = sliceText(s, 12); // the window ends inside the address of the outer link
    expect(r).toEqual({ text: "xx", next: 3, inCode: false, moreWords: 6 + 300 });
  });
  it("a sentence end that the ) of a link address closes is the end of the link, so it is still a cut point", () => {
    const s = "Start. See [x](e.com/a.) and " + para(100);
    expect(sliceText(s, 10)).toEqual({ text: "Start. See [x](e.com/a.)", next: 25, inCode: false, moreWords: 1 + 100 });
  });
  it("a link span ends where its ) is: the space after it is a cut point", () => {
    const s = "xx [aa bb](e.com/p q) " + para(300);
    expect(sliceText(s, 7)).toEqual({ text: "xx [aa bb](e.com/p q)", next: 22, inCode: false, moreWords: 300 });
  });
});

describe("sliceText: time on author-controlled text (linear, not quadratic)", () => {
  const LONG: [string, string][] = [
    ["stray open brackets", "[a ".repeat(300_000)],
    ["unbalanced parentheses after a link", "[a](( ".repeat(200_000)],
    ["sentence closers", "A.)))))))))) ".repeat(100_000)],
    ["a run of dots and closers", ".".repeat(1_000_000) + ")".repeat(1_000_000)],
    ["half a million short lines", "x\n".repeat(500_000)],
    ["a code block of 100,000 lines", "```\n" + "const x = 1;\n".repeat(100_000)],
    ["a whitespace tail", "a." + " ".repeat(2_000_000)],
  ];

  it.each(LONG)("%s: sliceText finishes within 1,000 ms", (_name, text) => {
    const start = performance.now();
    sliceText(text, 15_000);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  // A resumed call rebuilds the fence state from the text before `from`: one pass, linear in `from`.
  it("a resumed call deep into half a million short lines finishes within 1,000 ms", () => {
    const text = "x\n".repeat(500_000);
    const start = performance.now();
    const r = sliceText(text, 15_000, 900_000);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(r.next).toBeGreaterThan(900_000);
  });
  it("a resumed call deep into a 100,000-line code block finishes within 1,000 ms and stays inside the block", () => {
    const text = "```\n" + "const x = 1;\n".repeat(100_000) + "```\n\nafter";
    const start = performance.now();
    const r = sliceText(text, 15_000, 4 + 13 * 60_000); // a line start 60,000 lines in
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(r.inCode).toBe(true);
    expect(r.next).toBeGreaterThan(4 + 13 * 60_000);
  });
  it("a resumed call into one 2 MB line finishes within 1,000 ms", () => {
    const text = "word ".repeat(400_000);
    const start = performance.now();
    const r = sliceText(text, 15_000, 1_000_001);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(r.next).toBeGreaterThan(1_000_001);
  });
});
