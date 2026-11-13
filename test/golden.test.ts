import { describe, it, expect } from "vitest";
import { GOLDEN } from "./support/goldenCases";
import { createHarness, expectClean } from "./support/harness";

describe("golden outputs", () => {
  it("GOLDEN case names are unique", () => {
    expect(new Set(GOLDEN.map((c) => c.name)).size).toBe(GOLDEN.length);
  });
  for (const c of GOLDEN) {
    it(`golden ${c.name}`, async () => {
      const h = createHarness({ families: c.families, extra: c.extra?.() });
      const first = await h.call(c.tool, c.args);
      expect({ isError: first.isError, text: first.text }).toMatchSnapshot();
      if (c.follow) {
        const m = /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(first.text);
        expect(m, "the first page printed a cursor").not.toBeNull();
        const next = await h.call(c.tool, c.followMax === undefined ? { cursor: m![1] } : { cursor: m![1], max_tokens: c.followMax });
        expect({ isError: next.isError, text: next.text }).toMatchSnapshot();
      }
      expectClean(h);
    });
  }
});
