import { describe, expect, it } from "vitest";
import { createCallContext } from "../../src/call/context";
import { CallStopped, ToolError } from "../../src/errors";
import {
  aliasPart, bookSequenceRow, crossText, DIR_WORD, partOf, revisionTexts, send, UNORDERED, type Sent, type WantedText,
} from "../../src/tools/loaders";
import type { AliasResult, AliasResults, CallContext, GqlOp, RawBook, RawCollection, Services } from "../../src/types";
import { rawPostRef, rawSeqRef } from "../support/builders";
import { createHarness } from "../support/harness";
import { gqlTexts } from "../support/requests";

// The neighbour wording get_post (¶4.3 steps 4-5) and get_sequence (¶4.9 Position) share: one definition, so that the two tools
// cannot print the adjacency sentence differently.
const book = (id: string, sequences: [string, string][]): RawBook => ({
  _id: id, title: id, number: 1, postedAt: "2018-12-01T00:00:00.000Z",
  sequenceIds: sequences.map(([s]) => s), sequences: sequences.map(([s, title]) => rawSeqRef({ _id: s, title })),
});
const collection = (books: RawBook[]): RawCollection => ({ _id: "oneQyj4pw77ynzwAF", slug: "rationality", title: "Rationality: A-Z", books });
/** The adjacent sequence as crossText reads it: its title and whether it is hidden from lists. */
const seqOf = (title: string | null, hidden = false) => ({ title, hidden });

describe("loaders: the neighbour wording shared by get_post and get_sequence", () => {
  it("crossText puts the spec phrase inside the post reference's parentheses, after its flags", () => {
    const first = rawPostRef({ _id: "fbFirstPost000001", title: "Making Beliefs Pay Rent (in Anticipated Experiences)", af: false });
    expect(crossText(first, "next", "rationality", seqOf("Fake Beliefs")))
      .toBe('"Making Beliefs Pay Rent (in Anticipated Experiences)" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "Fake Beliefs")');
    const last = rawPostRef({ _id: "pwLastPost0000001", title: "The Last Post", af: true, unlisted: true });
    expect(crossText(last, "prev", "codex", seqOf("Predictably Wrong")))
      .toBe('"The Last Post" (post_id pwLastPost0000001, AF, reachable by link only, in the previous sequence of codex: "Predictably Wrong")');
  });

  it("crossText prints the slug and the sequence title on one line, the title cut at the 300-character cap, a missing title as empty quotes", () => {
    const post = rawPostRef({ _id: "fbFirstPost000001", title: "T", af: false });
    expect(crossText(post, "next", "ration\nality", seqOf("Fake\nBeliefs"))).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of ration ality: "Fake Beliefs")');
    expect(crossText(post, "next", "rationality", seqOf(null))).toBe('"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "")');
    const long = crossText(post, "next", "rationality", seqOf("x".repeat(400)));
    expect(long).toBe(`"T" (post_id fbFirstPost000001, LW only, in the next sequence of rationality: "${"x".repeat(299)}…")`);
  });

  it("crossText leaves a post that is not publicly visible as its plain reference, with no note and nothing of the post", () => {
    const hidden = crossText(rawPostRef({ _id: "rejectedPost00001", title: "Secret", rejected: true }), "next", "rationality", seqOf("Fake Beliefs", true));
    expect(hidden).toBe("a post that is not publicly visible");
  });

  it("crossText flags a hidden adjacent sequence after its title", () => {
    const post = rawPostRef({ _id: "HidPostFirst00001", title: "Hidden First", af: false });
    expect(crossText(post, "next", "rationality", seqOf("Off the Lists", true)))
      .toBe(`"Hidden First" (post_id HidPostFirst00001, LW only, in the next sequence of rationality: "Off the Lists", not in the site's sequence lists)`);
  });

  it("bookSequenceRow finds a sequence's row in any book of the collection, and nothing for an id no book holds a row for", () => {
    const c = collection([book("b1", [["seqOne000000000001", "One"]]), book("b2", [["seqTwo000000000002", "Two"], ["seqThree0000000003", "Three"]])]);
    expect(bookSequenceRow(c, "seqOne000000000001")?.title).toBe("One");
    expect(bookSequenceRow(c, "seqThree0000000003")).toEqual(rawSeqRef({ _id: "seqThree0000000003", title: "Three" }));
    expect(bookSequenceRow(c, "seqNone0000000000")).toBeUndefined();
  });

  it("the direction words and the unordered tail are the spec's", () => {
    expect(DIR_WORD).toEqual({ prev: "previous", next: "next" });
    expect(UNORDERED).toBe("can't be determined reliably (the forum defines no order among books that share a number or have none)");
  });
});

// ¶7 ¶3.9: the one reader of a later request and its parts (get_post, get_tag, get_sequence, get_user).
describe("loaders: a later request and its parts", () => {
  const now = () => Date.parse("2026-10-22T12:00:00.000Z");
  const op = (alias: string): GqlOp => ({ template: "t", alias, text: `${alias}: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}) { result { _id } }` });
  /** Services whose gql answers with `answer` (or throws it) and counts its calls. */
  const services = (answer: AliasResults | Error) => {
    const calls: string[] = [];
    const svc = {
      gql: async (ops: readonly GqlOp[], _ctx: CallContext, task: string) => {
        calls.push(`${task}: ${ops.map((o) => o.alias).join(" ")}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as Services;
    return { svc, calls };
  };
  const answered: AliasResults = new Map([["a", { data: { result: { _id: "x" } } }]]);

  it("send: no ops is nothing sent; checkFirst refuses once no request may start, without asking for an answer", async () => {
    const { svc, calls } = services(answered);
    expect(await send([], "task", createCallContext("get_post", { now }), svc)).toEqual({ kind: "none" });
    const capped = createCallContext("get_post", { now, maxRequests: 0 });
    expect(await send([op("a")], "task", capped, svc, true)).toEqual({ kind: "stopped", why: "request cap" });
    expect(calls).toEqual([]);
    // Without checkFirst the request goes to gql, which may serve a cached answer past the deadline or cap.
    expect(await send([op("a")], "task", capped, svc)).toEqual({ kind: "ok", results: answered });
    expect(calls).toEqual(["task: a"]);
  });

  it("send: a stop is its reason, a ToolError the whole request's failure, and anything else is thrown", async () => {
    const ctx = createCallContext("get_tag", { now });
    expect(await send([op("a")], "t", ctx, services(new CallStopped("time limit")).svc)).toEqual({ kind: "stopped", why: "time limit" });
    const error = new ToolError("forum_error", "The forum failed.");
    expect(await send([op("a")], "t", ctx, services(error).svc)).toEqual({ kind: "failed", error });
    await expect(send([op("a")], "t", ctx, services(new TypeError("bug")).svc)).rejects.toThrow("bug");
  });

  it("aliasPart: data; the forum's nothing-here is no data; another alias error is the part's Partial line; an absent alias is not read", () => {
    const results: AliasResults = new Map<string, AliasResult>([
      ["a", { data: { results: [] } }],
      ["n", { error: "not_found", message: "No such document." }],
      ["h", { error: "not_public", message: "Refused." }],
      ["f", { error: "forum_error", message: "Timed out." }],
    ]);
    expect(aliasPart(results, "a", "posts")).toEqual({ ok: true, data: { results: [] } });
    expect(aliasPart(results, "n", "posts")).toEqual({ ok: true, data: undefined });
    expect(aliasPart(results, "h", "posts")).toEqual({ ok: true, data: undefined });
    expect(aliasPart(results, "f", "posts")).toEqual({ ok: false, partial: "Partial: posts unavailable (forum_error: Timed out)." });
    expect(aliasPart(results, "x", "posts")).toEqual({ ok: false });
  });

  it("partOf: a part not asked for is never read, even from a failed request; a whole failure is each asked part's Partial line; a stop or nothing sent says nothing", () => {
    const ops = [op("a"), op("f")];
    const failed: Sent = { kind: "failed", error: new ToolError("forum_error", "Bad gateway.") };
    expect(partOf(failed, ops, "a", "reviews")).toEqual({ ok: false, partial: "Partial: reviews unavailable (forum_error: Bad gateway)." });
    expect(partOf(failed, ops, "f", "turns")).toEqual({ ok: false, partial: "Partial: turns unavailable (forum_error: Bad gateway)." });
    expect(partOf(failed, ops, "col", "neighbours")).toEqual({ ok: false });
    expect(partOf({ kind: "stopped", why: "time limit" }, ops, "a", "reviews")).toEqual({ ok: false });
    expect(partOf({ kind: "none" }, [], "a", "reviews")).toEqual({ ok: false });
    const ok: Sent = { kind: "ok", results: new Map<string, AliasResult>([["a", { data: 1 }], ["f", { error: "internal", message: "t: broke" }]]) };
    expect(partOf(ok, ops, "a", "reviews")).toEqual({ ok: true, data: 1 });
    expect(partOf(ok, ops, "f", "turns")).toEqual({ ok: false, partial: "Partial: turns unavailable (internal: t: broke)." });
  });

  it("partials, when given, also get each failed part's line, in the order the parts are read; a part read or not asked adds none", () => {
    const partials: string[] = [];
    const ops = [op("a"), op("f")];
    const failed: Sent = { kind: "failed", error: new ToolError("forum_error", "Bad gateway.") };
    expect(partOf(failed, ops, "a", "reviews", partials)).toEqual({ ok: false, partial: "Partial: reviews unavailable (forum_error: Bad gateway)." });
    expect(partOf(failed, ops, "col", "neighbours", partials)).toEqual({ ok: false });
    const results = new Map<string, AliasResult>([["a", { data: 1 }], ["f", { error: "forum_error", message: "Timed out." }]]);
    expect(aliasPart(results, "a", "stats", partials)).toEqual({ ok: true, data: 1 });
    expect(aliasPart(results, "f", "stats", partials)).toEqual({ ok: false, partial: "Partial: stats unavailable (forum_error: Timed out)." });
    expect(partOf({ kind: "ok", results }, ops, "f", "turns", partials).ok).toBe(false);
    expect(partials).toEqual([
      "Partial: reviews unavailable (forum_error: Bad gateway).", "Partial: stats unavailable (forum_error: Timed out).",
      "Partial: turns unavailable (forum_error: Timed out).",
    ]);
  });
});

// ¶4.11 step 6, ¶4.12 step 7: the one reader of revision texts (get_history, first_use).
describe("loaders: revision texts", () => {
  const DOC = "DocumentText00001";
  const want = (n: number, source?: string): WantedText => ({ id: `RevTextWanted000${n}`, source: source ?? `RevTextWanted000${n}`, docId: DOC });
  const row = (id: string, html: string | null, documentId = DOC) => ({ result: { _id: id, documentId, fieldName: "contents", version: "1.0.0", editedAt: "2024-01-01T00:00:00.000Z", wordCount: 2, html } });

  it("reads a text from its source revision of its document; nothing-here and another document's text are left out; the first problem in alias order is returned; every text read is cached by its source", async () => {
    const h = createHarness({ families: [] });
    const ctx = createCallContext("get_history", { now: h.clock.now });
    h.forum.inject({
      endpoint: "graphql", when: (b) => b.includes("revision_text"), times: 1,
      body: JSON.stringify({
        data: {
          r1: row("RevTextSource0001", "<p>Alpha text.</p>"), r2: row("RevTextWanted0002", "<p>Beta text.</p>", "AnotherDocument01"), r3: null, r4: null,
          r5: null, r6: row("RevTextWanted0006", null), r7: row("RevTextWanted0007", "<p>Omega text.</p>"),
        },
        errors: [{ message: "app.missing_document", path: ["r4"] }, { message: "First failure", path: ["r5"] }],
      }),
    });
    const wanted = [want(1, "RevTextSource0001"), want(2), want(3), want(4), want(5), want(6), want(7)];
    const got = await revisionTexts(wanted, { post: true }, "reading", ctx, h.services);
    expect(got).toEqual({ texts: new Map([["RevTextWanted0001", "Alpha text."], ["RevTextWanted0007", "Omega text."]]), error: { error: "forum_error", message: "First failure" } });
    expect(h.services.caches.get("revtext", "RevTextSource0001")).toBe("Alpha text.");
    expect(h.services.caches.get("revtext", "RevTextWanted0007")).toBe("Omega text.");
    // Cached texts cost nothing: the second read asks only for the others.
    await revisionTexts(wanted, { post: true }, "reading", ctx, h.services);
    expect(gqlTexts(h.forum)[1]).not.toMatch(/RevTextSource0001|RevTextWanted0007/);
    expect(gqlTexts(h.forum)[1].match(/r\d: revision\(/g)).toHaveLength(5);
  });

  it("a missing page is the problem when it comes first", async () => {
    const h = createHarness({ families: [] });
    const ctx = createCallContext("first_use", { now: h.clock.now });
    h.forum.inject({
      endpoint: "graphql", when: (b) => b.includes("revision_text"), times: 1,
      body: JSON.stringify({ data: { r1: row("RevTextWanted0001", null), r2: null }, errors: [{ message: "Later failure", path: ["r2"] }] }),
    });
    expect((await revisionTexts([want(1), want(2)], { post: true }, "reading", ctx, h.services)).error).toBe("no page");
  });
});
