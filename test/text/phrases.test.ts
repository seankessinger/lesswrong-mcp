import { describe, expect, it } from "vitest";
import {
  classify, sanitizeQuery, normalizeText, contains, foldForMatch, queryTermsIn, asciiSuggestion,
} from "../../src/text/phrases";
import { ToolError } from "../../src/errors";
import { badInputMessage } from "../support/errors";

describe("classify: ¶3.2.1 rules 1–5 and 7, the §5.2 rows relied on", () => {
  it("Q29 Q135 apostrophe rule: Newcomb's is sent without the possessive, the needle keeps it", () => {
    expect(classify("Newcomb's problem", "phrases")).toEqual({
      given: "Newcomb's problem", sent: "Newcomb problem", mode: "rewritten", needle: "newcomb's problem",
    });
    expect(classify("don’t trust", "phrases")).toMatchObject({ sent: "don trust", mode: "rewritten", needle: "don't trust" });
  });

  it("Q29 punctuation inside a word or a non-ASCII letter makes the phrase loose, sent as plain words", () => {
    expect(classify("GPT-4.5", "phrases")).toEqual({
      given: "GPT-4.5", sent: "GPT 4 5", mode: "loose", needle: "gpt 4.5",
    });
    expect(classify("Gödel", "forms")).toMatchObject({ sent: "Gödel", mode: "loose", needle: "gödel" });
    expect(classify("and/or", "phrases")).toMatchObject({ sent: "and or", mode: "loose", needle: "and/or" });
    expect(classify("R&D", "phrases")).toMatchObject({ sent: "R D", mode: "loose", needle: "r&d" });
    expect(classify("Löb's theorem", "forms")).toMatchObject({ sent: "Löb theorem", mode: "loose", needle: "löb's theorem" });
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

describe("match helpers", () => {
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

describe("asciiSuggestion (¶4.12 step 1)", () => {
  it("folds accents and drops punctuation inside words, keeping apostrophes and hyphens", () => {
    expect(asciiSuggestion("Löb's theorem")).toBe("Lob's theorem");
    expect(asciiSuggestion("Gödel")).toBe("Godel");
    expect(asciiSuggestion("Højmark")).toBe("Hojmark");
    expect(asciiSuggestion("GPT-4.5")).toBe("GPT-45");
    expect(asciiSuggestion("R&D")).toBe("RD");
  });
});

describe("edges the rules imply (¶3.2.1)", () => {
  it("the apostrophe rule removes each in-word apostrophe with the word characters after it", () => {
    expect(classify("rock'n'roll", "phrases")).toEqual({
      given: "rock'n'roll", sent: "rock", mode: "rewritten", needle: "rock'n'roll",
    });
  });

  it("rule 7 for a phrase that is one contraction: the apostrophe rule caused the shortfall, and the message says so", () => {
    const message = (p: string, param: "phrases" | "forms"): string => {
      try {
        classify(p, param);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        return (e as ToolError).message;
      }
      throw new Error("expected bad_input");
    };
    expect(message("I'm", "phrases")).toBe(
      `phrases: "I'm" leaves fewer than 2 letters or digits once the apostrophe and the rest of its word are removed, as the forum's search does. Add a neighbouring word to the phrase, as in "five o'clock".`,
    );
    expect(message("o'clock", "forms")).toBe(
      `forms: "o'clock" leaves fewer than 2 letters or digits once the apostrophe and the rest of its word are removed, as the forum's search does. Add a neighbouring word to the phrase, as in "five o'clock".`,
    );
  });

  it("given is cut to 100 characters on one line", () => {
    const long = classify("alignment ".repeat(30), "phrases");
    expect(Array.from(long.given)).toHaveLength(100);
    expect(long.given.endsWith("…")).toBe(true);
  });

  it("normalizeText takes time linear in the text, even for a very long run of punctuation", () => {
    const run = "a" + ".".repeat(100_000) + "b";
    expect(normalizeText(run)).toBe(run);
    expect(normalizeText("a" + ".".repeat(100_000) + " b")).toBe("a b");
  });

  it("asciiSuggestion folds every letter of the table and keeps only apostrophe and dash runs", () => {
    expect(asciiSuggestion("Ø Æ Œ ß Ł Đ Þ Ð ø æ œ ł đ þ ð ı")).toBe("O AE OE ss L D Th D o ae oe l d th d i");
    expect(asciiSuggestion("it’s a--b a.-b a_b")).toBe("it’s a--b ab a_b");
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
