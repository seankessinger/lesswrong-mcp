import { describe, expect, it } from "vitest";
import {
  classify, sanitizeQuery, normalizeText, contains, foldForMatch, matchesText, onlyStopWords, plainForm, queryTermsIn,
} from "../../src/text/phrases";
import { ToolError } from "../../src/errors";
import { badInputMessage } from "../support/errors";

describe("classify: ¶3.2.1 rules 1–5 and 7, the §5.2 rows relied on", () => {
  it("Q29 Q135 a word the index keeps whole is sent as written, unquoted; the needle keeps the apostrophe form", () => {
    expect(classify("Newcomb's problem", "phrases")).toEqual({
      given: "Newcomb's problem", sent: "Newcomb's problem", mode: "loose", needle: "newcomb's problem",
    });
    expect(classify("don’t trust", "phrases")).toMatchObject({ sent: "don’t trust", mode: "loose", needle: "don't trust" });
  });

  it.each([
    ["GPT-4.5", "GPT 4.5", "gpt 4.5"],
    ["Node.js", "Node.js", "node.js"],
    ["U.S.", "U.S", "u.s"],
    ["e.g.", "e.g", "e.g"],
    ["x.com", "x.com", "x.com"],
    ["1,000", "1,000", "1,000"],
    ["3.14", "3.14", "3.14"],
    ["v1.2", "v1.2", "v1.2"],
    ["1;2", "1;2", "1;2"],
    ["1'000", "1'000", "1'000"],
    ["cousin_it", "cousin_it", "cousin_it"],
    ["__init__ method", "init method", "init method"],
    ["foo_ bar", "foo bar", "foo bar"],
    ["_foo bar", "foo bar", "foo bar"],
    ["Re:Zero", "Re:Zero", "re:zero"],
    ["TL:DR", "TL:DR", "tl:dr"],
    ["Gödel", "Gödel", "gödel"],
    ["Löb's theorem", "Löb's theorem", "löb's theorem"],
    ["Bayes’s rule", "Bayes’s rule", "bayes's rule"],
  ])("Q29 %s holds a word the index keeps whole, or an accented letter: sent loose as %s", (given, sent, needle) => {
    expect(classify(given, "phrases")).toEqual({ given, sent, mode: "loose", needle });
  });

  it.each([
    ["R&D", "R D", "r&d"],
    ["AT&T", "AT T", "at&t"],
    ["and/or", "and or", "and/or"],
    ["P(doom)", "P doom", "p(doom"],
    ["10:30", "10 30", "10:30"],
    ["std::vector", "std vector", "std::vector"],
    ["E=mc^2", "E mc 2", "e=mc^2"],
    ["90's", "90 s", "90's"],
  ])("Q29 punctuation that splits words stays exact: %s is quoted as %s", (given, sent, needle) => {
    expect(classify(given, "forms")).toEqual({ given, sent, mode: "exact", needle });
  });

  it("Q32 a word the forum would read as a filter is sent so that it is not: the prefixes are case-sensitive and the index is not", () => {
    expect(classify("user:foo's bar", "phrases")).toMatchObject({ sent: "User:foo's bar", mode: "loose" });
    expect(classify("tag:Node.js", "phrases")).toMatchObject({ sent: "Tag:Node.js", mode: "loose" });
    expect(classify("a.b wikitag:c", "phrases")).toMatchObject({ sent: "a.b Wikitag:c", mode: "loose" });
  });

  it("Q32 only a prefix at the start of a word acts, so a later one is left alone", () => {
    expect(classify("x:user:bob's", "phrases")).toMatchObject({ sent: "x:user:bob's", mode: "loose" });
  });

  it("Q32 an apostrophe after a prefix would open a quoted token, so the two are split", () => {
    expect(classify("Title:'Goodhart's Law'", "phrases")).toMatchObject({ sent: "Title Goodhart's Law", mode: "loose" });
    expect(classify("a:'b:'c's", "phrases")).toMatchObject({ sent: "a b c's", mode: "loose" });
    expect(classify("a:''b's", "phrases")).toMatchObject({ sent: "a b's", mode: "loose" });
  });

  it.each(["it's", "It’s", "that's it", "there's no", "they're not", "a's"])("%s holds only stop words once each apostrophe tail is cut", (phrase) => {
    expect(onlyStopWords(classify(phrase, "phrases"))).toBe(true);
  });

  it.each(["isn't", "I'm", "Goodhart's law", "it's raining", "of the", "Node.js"])("%s holds a word the forum searches", (phrase) => {
    expect(onlyStopWords(classify(phrase, "phrases"))).toBe(false);
  });

  it("Q135 plainForm is the phrase without its possessives", () => {
    expect(plainForm(classify("Newcomb's problem", "phrases"))).toBe("Newcomb problem");
    expect(plainForm(classify("don’t trust", "phrases"))).toBe("don’t trust");   // a contraction is no possessive
    expect(plainForm(classify("mesa optimizer", "phrases"))).toBe("mesa optimizer");
  });

  it("Q29 hyphens count as spaces; harmless punctuation and quote characters are dropped; the phrase stays exact", () => {
    expect(classify("mesa-optimizer", "phrases")).toEqual({
      given: "mesa-optimizer", sent: "mesa optimizer", mode: "exact", needle: "mesa optimizer",
    });
    expect(classify("“inner alignment”", "phrases")).toEqual({
      given: "inner alignment", sent: "inner alignment", mode: "exact", needle: "inner alignment",
    });
    expect(classify("(corrigibility)", "phrases")).toMatchObject({ sent: "corrigibility", mode: "exact", needle: "corrigibility" });
    expect(classify("  inner\n  alignment ", "phrases")).toMatchObject({ given: "inner alignment", sent: "inner alignment", mode: "exact" });
  });

  it("rule 7 names the parameter it refuses: forms as well as phrases", () => {
    expect(badInputMessage(() => classify("?!", "forms"))).toBe(
      'forms: "?!" has fewer than 2 letters or digits. A phrase needs at least 2 letters or digits; punctuation alone matches nothing.',
    );
    expect(badInputMessage(() => classify("'s", "forms"))).toMatch(/^forms: /);
  });

  it("rule 7 counts what the check reads: a phrase that is only a footnote marker or a link address is bad_input", () => {
    for (const phrase of ["[^a-z]", "[^12]", "](ab)"]) expect(() => classify(phrase, "phrases")).toThrow(ToolError);
  });

  it("rule 7: fewer than 2 letters or digits is bad_input", () => {
    for (const p of ["?!", "'s"]) {
      try {
        classify(p, "phrases");
        throw new Error("expected bad_input");
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).message).toBe(
          `phrases: ${JSON.stringify(p)} has fewer than 2 letters or digits. A phrase needs at least 2 letters or digits; punctuation alone matches nothing.`,
        );
      }
    }
  });
});

describe("normalizeText and contains: ¶3.2.1 rule 6", () => {
  it("NFKC, lower case, straight quotes, dashes to spaces, emphasis and escapes removed, edge punctuation removed", () => {
    expect(normalizeText("  The *Mesa–Optimizer*, (again)\\_x  ")).toBe("the mesa optimizer again x");
    expect(normalizeText("Newcomb’s **problem**")).toBe("newcomb's problem");
    expect(normalizeText("ﬁne GPT-4.5 Gödel")).toBe("fine gpt 4.5 gödel");
  });

  it("a phrase crosses a link, whatever its address, and a footnote's marker: a reader sees neither", () => {
    const phrase = classify("map is not", "phrases");
    expect(contains("The [map](https://example.org/a) is not the territory.", phrase)).toBe("exact");
    expect(contains('The [map](https://en.wikipedia.org/wiki/Map_\\(chart\\) "A title") is not it.', phrase)).toBe("exact");
    expect(contains("The map[^abc] is not it.", phrase)).toBe("exact");
    expect(contains("The map[^abc], is not it.", phrase)).toBe("exact");
    expect(normalizeText("See [the map](https://example.org/a).")).toBe("see the map");
  });

  it("Q135 the needle keeps the apostrophe form; the other form is reported, never counted as the phrase", () => {
    const withS = classify("Newcomb's problem", "phrases");
    const plain = classify("Newcomb problem", "phrases");
    expect(contains("On **Newcomb’s problem** again", withS)).toBe("exact");
    expect(contains("On **Newcomb’s problem** again", plain)).toBe("with-possessive");
    expect(contains("The Newcomb problem", withS)).toBe("without-possessive");
    expect(contains("The Newcomb problem", plain)).toBe("exact");
    expect(contains("Newcomb's problems", withS)).toBe(false);
    expect(contains("newcomb", plain)).toBe(false);
  });

  it("Q29 loose phrases are checked exactly; whole words only", () => {
    expect(contains("I used GPT-4.5 today", classify("GPT-4.5", "phrases"))).toBe("exact");
    expect(contains("GPT 4 5 is out", classify("GPT-4.5", "phrases"))).toBe(false);
    expect(contains("a mesa\\-optimizer!", classify("mesa-optimizer", "phrases"))).toBe("exact");
    expect(contains("mesa optimizers", classify("mesa-optimizer", "phrases"))).toBe(false);
    expect(contains("Gödel's theorem", classify("Gödel", "phrases"))).toBe("exact");
  });

  it("rule 6 a needle with regex-special characters is matched as text, never as a pattern: f(x)=y, a[b]c, a|b, a backslash", () => {
    const fx = classify("f(x)=y", "phrases");
    expect(fx.needle).toBe("f(x)=y");
    expect(contains("so f(x)=y holds", fx)).toBe("exact");
    expect(contains("so fx=y holds", fx)).toBe(false);      // a group would match this
    const abc = classify("a[b]c", "phrases");
    expect(contains("then a[b]c again", abc)).toBe("exact");
    expect(contains("then abc again", abc)).toBe(false);    // a character class would match this
    const alt = classify("a|b", "phrases");
    expect(contains("choose a|b now", alt)).toBe("exact");
    expect(contains("choose a now", alt)).toBe(false);      // an alternation would match this
    expect(contains("choose b now", alt)).toBe(false);
    const bs = classify("a\\b", "phrases");
    expect(bs.needle).toBe("a\\b");
    expect(contains("path a\\b here", bs)).toBe("exact");
    expect(contains("path a b here", bs)).toBe(false);      // a word-boundary escape would match this
  });
});

describe("contains reads a phrase as a reader sees it", () => {
  it.each([
    ["a link glued to the next letters", "LLMs are great", "[LLM](https://x.org/a)s are great"],
    ["a link whose address holds a space or a lone bracket", "word priming experiment", "the [word](https://en.wikipedia.org/wiki/Priming%20\\(psychology) priming experiment"],
    ["a subscript glued to letters", "CO2 levels", "rising CO~2~ levels now"],
    ["a subscript in a name", "Hypothesis H1 is true", "if Hypothesis H~1~ is true then"],
    ["a comma between the words", "Godel Escher Bach", "read Godel, Escher, Bach twice"],
    ["a non-breaking hyphen in the text", "non native", "a non\u2011native speaker"],
    ["a non-breaking hyphen in the phrase", "non\u2011native", "a non-native speaker"],
    ["a soft hyphen inside a word", "nonnative", "a non\u00ADnative speaker"],
    ["a minus sign", "x y", "so x\u2212y holds"],
    ["C++ beside punctuation", "C++ programming", "good C++ programming."],
    ["C# in brackets", "C# code", "(C# code) is nice"],
    [".NET in brackets", ".NET framework", "the (.NET framework) thing"],
    ["a percentage", "99% sure", "at 99% sure, then"],
    ["an underscore name", "cousin_it", "by cousin_it here"],
    ["a version at a clause end", "GPT-4", "use GPT-4, or not"],
    ["Han characters inside a longer run", "\u4e2d\u56fd", "\u4e2d\u56fd\u7f51\u4fe1 says"],
    ["Han characters with more before them", "\u4e2d\u56fd", "\u6211\u5728\u4e2d\u56fd\u7684\u65f6\u5019"],
    ["a line break inside a paragraph", "two lines", "two\nlines in one paragraph"],
    ["an abbreviation written the same way", "Dr. Smith", "by Dr. Smith today"],
    ["emphasis and quotes", "alignment forum", "the *alignment* \"forum\""],
    ["a possessive", "mesa optimizer", "a mesa optimizer's goal"],
    ["a literal caret", "a^2", "so a^2+b^2=c^2 holds"],
    ["a power of ten", "10^6", "from 10^6/10^9 steps"],
    ["inline maths", "probability 0.5 of rain", "with probability $0.5$ of rain"],
    ["a comma with no space after it", "I agree", "I agree,but not fully"],
    ["a semicolon with no space after it", "it failed", "it failed;then we retried"],
    ["quotes inside a word", 'print("hello world")', 'Run `print("hello world")` first'],
    ["quotes inside a number", '5"x7" print', 'a 5"x7" print'],
    ["a curly quote used as an apostrophe", "O\u2018Brien family", "the O\u2018Brien family"],
    ["a katakana word ending in a long vowel mark", "\u30b3\u30f3\u30d4\u30e5\u30fc\u30bf\u30fc", "\u3053\u306e\u30b3\u30f3\u30d4\u30e5\u30fc\u30bf\u30fc\u306f\u901f\u3044"],
    ["a zero-width space inside a word", "foobar", "the foo\u200Bbar here"],
    ["an image between the words", "the icon to", "Click the ![gear](https://x.org/g.png) icon to open"],
    ["a link title with a quote in it", "map is not", 'The [map](https://x.org "say \\"hi\\"") is not it'],
  ])("holds the phrase across %s", (_, phrase, text) => {
    expect(contains(text, classify(phrase, "forms"))).toBe("exact");
  });

  it.each([
    ["the end of a sentence", "value learning", "social value. Learning is hard"],
    ["a paragraph break", "here happy", "up to here\n\nHappy days"],
    ["the start of a list item", "obligations when", "- obligations\n- When it"],
    ["a table cell", "alpha beta", "| alpha | beta |"],
    ["a colon", "AI alignment", "on AI: alignment"],
    ["C++ against C", "C++ programming", "C programming is fine"],
    ["C against C++", "C programming", "good C++ programming."],
    ["C# against C", "C code", "(C# code) is nice"],
    ["net against .NET", "net positive", "the .NET positive"],
    ["a percentage against money", "99% sure", "only $99 sure"],
    ["an underscore name against a space", "cousin_it", "my cousin it was"],
    ["a space against an underscore name", "cousin it", "by cousin_it here"],
    ["a version inside a longer one", "GPT-4", "only GPT-4.5 here"],
    ["an abbreviation inside a longer one", "U.S.", "the U.S.A. is"],
    ["a version number inside a longer one", "Claude 3", "Claude 3.5 Sonnet"],
    ["a contraction", "they won", "they won't come"],
    ["a contraction, whose other form is no possessive", "I can do it", "I can't do it"],
    ["a word after an apostrophe", "clock sharp", "at five o'clock sharp"],
    ["a paragraph break inside a quote", "first start", "> the end of first\n> \n> Start of second"],
    ["list items inside a quote", "obligations when", "> *   obligations\n> *   When it"],
  ])("does not hold the phrase across %s", (_, phrase, text) => {
    expect(contains(text, classify(phrase, "forms"))).toBe(false);
  });
});

describe("match helpers", () => {
  it("matchesText: the needle as whole words of the folded text", () => {
    expect(matchesText("He said so", foldForMatch("AI"))).toBe(false);
    expect(matchesText("On AI safety", foldForMatch("AI"))).toBe(true);
    expect(matchesText("a part of art", foldForMatch("art"))).toBe(true);
    expect(matchesText("a party", foldForMatch("art"))).toBe(false);
    expect(matchesText("it ends. Here it starts", foldForMatch("ends here"))).toBe(true);
    expect(matchesText("anything", "")).toBe(false);
  });

  it("foldForMatch folds accents and turns all remaining punctuation into spaces", () => {
    expect(foldForMatch("Gödel’s Incompleteness—Theorem!")).toBe("godel s incompleteness theorem");
    expect(foldForMatch("Højmark")).toBe("hojmark");
  });

  it("queryTermsIn: a query word of 2+ letters or digits occurs as a whole word", () => {
    expect(queryTermsIn("Inner alignment is hard", "inner alignment problem")).toBe(true);
    expect(queryTermsIn("Gödel's theorem", "godel")).toBe(true);
    expect(queryTermsIn("Posted by Eliezer Yudkowsky", "corrigibility")).toBe(false);
    expect(queryTermsIn("Innermost thoughts", "inner")).toBe(false);
    expect(queryTermsIn("anything", "a ?")).toBe(false);
    // A word the forum's search ignores is no query word: "cousin_it" reads as "cousin" and "it", and "it" alone is not enough.
    expect(queryTermsIn("We talk about it weekly.", "cousin_it")).toBe(false);
    expect(queryTermsIn("My cousin writes.", "cousin_it")).toBe(true);
  });
});

describe("sanitizeQuery (Q32)", () => {
  it("removes quote characters, leading '-' and 'word:' prefixes, and reports each removal", () => {
    expect(sanitizeQuery('"inner alignment" -shutdown title:corrigibility')).toEqual({
      text: "inner alignment shutdown corrigibility",
      removed: ["quote characters", 'leading "-" of "-shutdown"', 'prefix "title:"'],
    });
    expect(sanitizeQuery("'inner alignment' user:eliezer_yudkowsky")).toEqual({
      text: "inner alignment eliezer_yudkowsky",
      removed: ["quote characters", 'prefix "user:"'],
    });
    expect(sanitizeQuery("Newcomb's problem mesa-optimizer AI: risks")).toEqual({ text: "Newcomb's problem mesa-optimizer AI: risks", removed: [] });
  });
});

describe("edges the rules imply (¶3.2.1)", () => {
  it("every in-word apostrophe is kept", () => {
    expect(classify("rock'n'roll", "phrases")).toEqual({
      given: "rock'n'roll", sent: "rock'n'roll", mode: "loose", needle: "rock'n'roll",
    });
  });

  it("rule 7 counts every letter and digit, so a phrase that is one contraction is searched", () => {
    expect(classify("I'm", "phrases")).toMatchObject({ sent: "I'm", mode: "loose" });
    expect(classify("o'clock", "forms")).toMatchObject({ sent: "o'clock", mode: "loose" });
    expect(() => classify("'", "phrases")).toThrow(ToolError);
  });

  it("given is cut to 100 characters on one line", () => {
    const long = classify("alignment ".repeat(30), "phrases");
    expect(Array.from(long.given)).toHaveLength(100);
    expect(long.given.endsWith("…")).toBe(true);
  });

  it("normalizeText takes time linear in the text, even for a very long run of punctuation", () => {
    const run = "a" + ".".repeat(100_000) + "b";
    expect(normalizeText(run)).toBe(run);
    expect(normalizeText("a" + "~".repeat(100_000) + " b")).toBe("a b");
    expect(contains("a" + ".".repeat(100_000) + " b", classify("a b", "phrases"))).toBe(false);
  });

  it("foldForMatch folds the same table, after lower-casing", () => {
    expect(foldForMatch("Ørsted Æon ŒUVRE Straße Łódź Đorđe Þór Ðe ınput")).toBe("orsted aeon oeuvre strasse lodz dorde thor de input");
  });

  it("sanitizeQuery keeps a lone '-' or '--', reports both removals of '-title:x', and keeps in-word apostrophes", () => {
    expect(sanitizeQuery("a - b -- c")).toEqual({ text: "a - b -- c", removed: [] });
    expect(sanitizeQuery("-title:x")).toEqual({ text: "x", removed: ['leading "-" of "-title:x"', 'prefix "title:"'] });
    expect(sanitizeQuery("it’s ‘quoted’ don't 'x")).toEqual({ text: "it’s quoted don't x", removed: ["quote characters"] });
  });
});
