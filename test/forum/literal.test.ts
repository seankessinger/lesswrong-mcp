// test/forum/literal.test.ts
import fc from "fast-check";
import { parseValue, valueFromASTUntyped } from "graphql";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors";
import { bool, dateLit, enumTerm, idLit, int, list, obj, str } from "../../src/forum/literal";
import { badInputMessage } from "../support/errors";

describe("literal", () => {
  it("R4 str JSON-escapes quotes, backslashes and newlines, and keeps non-ASCII", () => {
    expect(str('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\nd"');
    expect(str("Gödel’s theorem")).toBe('"Gödel’s theorem"');
  });

  // 200 runs, pinned (fast-check's default would otherwise decide the count), with a timeout of its own: each run parses a
  // GraphQL literal, which under the full parallel suite on a loaded machine has taken over the default 5 s.
  it("R4 every well-formed string survives the round trip through a GraphQL string literal", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }).filter((s) => s.isWellFormed()),
        (s) => valueFromASTUntyped(parseValue(str(s))) === s,
      ),
      { numRuns: 200 },
    );
  }, 20_000);

  it("¶8 a lone surrogate is bad_input before anything is escaped", () => {
    expect(badInputMessage(() => str("a\uD800b", "phrases"))).toBe(
      "phrases: contains a character that is not valid text (an unpaired surrogate). Remove it and try again.",
    );
    expect(badInputMessage(() => str("\uDC00"))).toBe(
      "query: contains a character that is not valid text (an unpaired surrogate). Remove it and try again.",
    );
  });

  it("R3 idLit quotes a validated id and refuses anything else as an internal error", () => {
    expect(idLit("uMQ3cqWDPHhjtiesc")).toBe('"uMQ3cqWDPHhjtiesc"');
    expect(idLit("62bf5f5dc581cd211cc67d49")).toBe('"62bf5f5dc581cd211cc67d49"');
    for (const bad of ['uMQ3cqWDPHhjtiesc") { x', "", "agi-ruin-a-list-of", " uMQ3cqWDPHhjtiesc"])
      expect(() => idLit(bad)).toThrow("Unexpected failure in idLit (not a valid id). Please report this.");
  });

  it("Q11 dateLit prints exactly YYYY-MM-DDTHH:MM:SS.SSSZ", () => {
    expect(dateLit(Date.UTC(2019, 4, 31, 0, 0, 5, 1))).toBe('"2019-05-31T00:00:05.001Z"');
    expect(dateLit(Date.UTC(2026, 9, 22))).toBe('"2026-10-22T00:00:00.000Z"');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Date.UTC(10000, 0, 1)])
      expect(() => dateLit(bad)).toThrow(
        "Unexpected failure in dateLit (not a date in the literal range). Please report this.",
      );
  });

  it("int, bool, list and obj", () => {
    expect([int(500), int(-5), int(0)]).toEqual(["500", "-5", "0"]);
    expect(() => int(1.5)).toThrow("Unexpected failure in int (not a safe integer). Please report this.");
    expect([bool(true), bool(false)]).toEqual(["true", "false"]);
    expect(list([str("a"), str("b")])).toBe('["a", "b"]');
    expect(list([])).toBe("[]");
    expect(obj({ postId: idLit("uMQ3cqWDPHhjtiesc"), after: undefined, sortedBy: str("top") })).toBe(
      '{postId: "uMQ3cqWDPHhjtiesc", sortedBy: "top"}',
    );
    expect(obj({})).toBe("{}");
    expect(
      obj({ tags: list([obj({ tagId: idLit("56yXXrcxRjrQs6z9R"), filterMode: str("Required") })]) }),
    ).toBe('{tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}');
    expect(() => obj({ "bad key": "1" })).toThrow("Unexpected failure in obj (not a GraphQL name). Please report this.");
  });

  it("R4 Q8 enumTerm quotes a value from its closed set and refuses any other", () => {
    const POST_SORTS = ["new", "old", "top", "recentComments"] as const;
    expect(enumTerm("top", POST_SORTS)).toBe('"top"');
    expect(() => enumTerm("relevance" as "top", POST_SORTS)).toThrow(
      "Unexpected failure in enumTerm (value outside its closed set). Please report this.",
    );
  });

  it("R4 a refusal says what failed and never echoes the refused value", () => {
    const refusals: [() => unknown, string][] = [
      [() => idLit("SECRET-not-an-id"), "Unexpected failure in idLit (not a valid id). Please report this."],
      [() => dateLit(Number.NaN), "Unexpected failure in dateLit (not a date in the literal range). Please report this."],
      [() => int(123456.789), "Unexpected failure in int (not a safe integer). Please report this."],
      [() => obj({ "SECRET key": "1" }), "Unexpected failure in obj (not a GraphQL name). Please report this."],
      [
        () => enumTerm("SECRET" as "top", ["top"]),
        "Unexpected failure in enumTerm (value outside its closed set). Please report this.",
      ],
    ];
    for (const [refuse, message] of refusals) expect(refuse).toThrow(new ToolError("internal", message));
  });
});
