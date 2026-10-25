import { describe, it, expect } from "vitest";
import { setting, handOffCall, positionText, nextText, openContinuation, checkContinuation, reply, mint, givenArgs } from "../../src/tools/common";
import { createCallContext } from "../../src/call/context";
import { CURSOR_RE } from "../../src/paging/cursor";
import { createFakeForum } from "../fakeForum";
import { servicesFor } from "../support/services";
import { errorText } from "../../src/render/messages";

const svc = () => servicesFor(createFakeForum({ fixtures: [] }));
const ctx = (given: string[]) => createCallContext("list_posts", { now: () => 0, given });

describe("tools/common", () => {
  it("setting marks defaults", () => {
    expect(setting(ctx(["sort"]), "sort", "top")).toBe("sort top");
    expect(setting(ctx([]), "limit", 10)).toBe("limit 10 (default)");
  });
  it("handOffCall prints a complete call, cursor last", () => {
    expect(handOffCall("list_posts", { tag: "interpretability-ml-and-ai", sort: "top", limit: 10, af_only: false }, "c_AAAAAAAAAAAAAAAAAAAAAA"))
      .toBe('list_posts {tag: "interpretability-ml-and-ai", sort: "top", limit: 10, af_only: false, cursor: "c_AAAAAAAAAAAAAAAAAAAAAA"}');
  });
  it("positionText and nextText", () => {
    expect(positionText("items", 1, 10)).toBe("items 1–10");
    expect(positionText("threads", 1, 4, 158)).toBe("threads 1–4 of 158");
    expect(positionText("posts", 11, 20, 1137)).toBe("posts 11–20 of 1,137");
    expect(nextText("items", 11, 20)).toBe("items 11–20");
  });
  it("mint issues a token the tool can open again; another tool's token is bad_cursor", () => {
    const s = svc();
    const c = mint(s, "list_posts", { tag: "ai" }, { tag: "sYm3HiWcfZvrGu3ui", sort: "top" }, { streams: [{ kind: "offset", shown: 10, offset: 20 }], current: 0 });
    expect(c).toMatch(CURSOR_RE);
    expect(openContinuation("list_posts", c, s)?.effective).toEqual({ tag: "sYm3HiWcfZvrGu3ui", sort: "top" });
    expect(openContinuation("list_posts", undefined, s)).toBeUndefined();
    try { openContinuation("search", c, s); throw new Error("no error"); } catch (e) {
      expect(errorText(e as never)).toBe("Error (bad_cursor): This cursor is unknown: the server restarted since it was issued, it expired, or it belongs to another tool. Repeat the original call without a cursor.");
    }
  });
  it("checkContinuation compares only the parameters the call gave", () => {
    const s = svc();
    const entry = openContinuation("list_posts", mint(s, "list_posts", {}, { sort: "top", limit: 10 }, { streams: [], current: 0 }), s)!;
    expect(() => checkContinuation(entry, { sort: "new", limit: 10 }, ctx(["cursor", "limit"]))).not.toThrow();
    try { checkContinuation(entry, { sort: "new", limit: 10 }, ctx(["cursor", "sort"])); throw new Error("no error"); } catch (e) {
      expect(errorText(e as never)).toBe('Error (bad_input): this cursor was issued for different parameters (sort: cursor has "top", call has "new"). Pass only the cursor to continue, or repeat the call without it to start over.');
    }
  });
  it("givenArgs keeps the caller's given keys in parameter order", () => {
    const p = { post: "a", sort: "top", af_only: false, limit: 10, cursor: undefined, max_tokens: 15000 };
    const args = givenArgs(p, ctx(["limit", "post", "max_tokens"]));
    expect(args).toEqual({ post: "a", limit: 10 });
    expect(Object.keys(args)).toEqual(["post", "limit"]);
  });
  it("givenArgs leaves out cursor, max_tokens and defaults the caller did not give", () => {
    const p = { post: "a", sort: "top", af_only: false, limit: 10, cursor: "c_AAAAAAAAAAAAAAAAAAAAAA", max_tokens: 2000 };
    expect(givenArgs(p, ctx(["cursor", "max_tokens", "sort"]))).toEqual({ sort: "top" });
    expect(givenArgs(p, ctx([]))).toEqual({});
    expect(Object.keys(givenArgs(p, ctx(["max_tokens", "cursor", "limit", "af_only", "sort", "post"])))).toEqual(["post", "sort", "af_only", "limit"]);
  });
  it("reply renders one page with the footer", () => {
    const out = reply({ tool: "find", subject: "1 item", request: ["items 1–1", "limit 10 (default)"], notes: [], head: [], items: [{ text: "Item 1" }] }, 15000, svc(), () => ({ kind: "end" }));
    expect(out).toEqual({ isError: false, text: "find — 1 item\nRequest: items 1–1 · limit 10 (default)\nItem 1\nEnd of results." });
  });
});
