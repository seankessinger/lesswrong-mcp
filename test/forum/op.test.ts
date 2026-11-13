import { parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { bool, dateLit, idLit, int, list, obj, str } from "../../src/forum/literal";
import { FRAGMENTS } from "../../src/forum/templates/fragments";
import { documentFor, op } from "../../src/forum/templates/op";
import { forumSchema } from "../schema";

describe("op", () => {
  it("renders a single root with its selector and allowNull exactly as the post-by-id resolution template", () => {
    expect(
      op({ template: "post_by_id", alias: "p", root: "post", terms: { _id: idLit("uMQ3cqWDPHhjtiesc") }, allowNull: true, select: "{ result { ...POST_FULL } }" }),
    ).toEqual({
      template: "post_by_id",
      alias: "p",
      text: 'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_FULL } }',
    });
  });

  it("renders a list root as selector, limit, offset, enableTotal (a userPosts list)", () => {
    const required = obj({ tags: list([obj({ tagId: idLit("56yXXrcxRjrQs6z9R"), filterMode: str("Required") })]) });
    const o = op({
      template: "list_posts", alias: "l", root: "posts", view: "userPosts",
      terms: {
        userId: idLit("nmk3nLpQE89dMRzzN"), sortedBy: str("top"), after: str("2024-01-01T00:00:00.000Z"), before: str("2025-01-01T00:00:00.000Z"),
        excludeEvents: bool(true), af: bool(true), question: bool(true), karmaThreshold: int(10), filter: str("curated"), filterSettings: required,
      },
      limit: 40, offset: 0, enableTotal: true, select: "{ results { ...POST_CARD_EXCERPT } totalCount }",
    });
    expect(o.text).toBe(
      'l: posts(selector: {userPosts: {userId: "nmk3nLpQE89dMRzzN", sortedBy: "top", after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z", excludeEvents: true, af: true, question: true, karmaThreshold: 10, filter: "curated", filterSettings: {tags: [{tagId: "56yXXrcxRjrQs6z9R", filterMode: "Required"}]}}}, limit: 40, offset: 0, enableTotal: true) { results { ...POST_CARD_EXCERPT } totalCount }',
    );
  });

  it("renders custom-root arguments in insertion order and keeps isolate, publicSubject and ttlMs", () => {
    expect(
      op({ template: "core_grouping", alias: "g", root: "TagsByCoreTagId", args: { coreTagId: idLit("sYm3HiWcfZvrGu3ui"), limit: int(500) }, isolate: true, select: "{ tags { ...TAG_LIST } totalCount }" }),
    ).toEqual({
      template: "core_grouping",
      alias: "g",
      text: 'g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui", limit: 500) { tags { ...TAG_LIST } totalCount }',
      isolate: true,
    });
    const f = op({
      template: "feed_recent_discussion", alias: "f", root: "RecentDiscussionFeed",
      args: { limit: int(20), cutoff: dateLit(Date.UTC(2026, 9, 22)), offset: int(0) }, isolate: true, ttlMs: 120_000, select: "{ cutoff endOffset }",
    });
    expect(f.text).toBe('f: RecentDiscussionFeed(limit: 20, cutoff: "2026-10-22T00:00:00.000Z", offset: 0) { cutoff endOffset }');
    expect([f.isolate, f.ttlMs]).toEqual([true, 120_000]);
    const r = op({ template: "revision_text", alias: "r1", root: "revision", terms: { _id: idLit("aaaaaaaaaaaaaaaaa") }, publicSubject: "revision", select: "{ result { _id } }" });
    expect(r.publicSubject).toBe("revision");
  });

  it("renders a root without arguments without parentheses", () => {
    expect(op({ template: "spotlight", alias: "f", root: "currentSpotlight", select: "{ documentType customTitle }" }).text).toBe(
      "f: currentSpotlight { documentType customTitle }",
    );
  });

  it("refuses an alias that is not a GraphQL name", () => {
    expect(() => op({ template: "t", alias: "p-1", root: "post", terms: { _id: idLit("uMQ3cqWDPHhjtiesc") }, select: "{ result { _id } }" })).toThrow(
      "Unexpected failure in t (alias p-1 is not a GraphQL name). Please report this.",
    );
  });

  it("C2 documentFor builds one query named after its template, followed by the fragments used, and it validates", () => {
    const t = op({ template: "tag_by_id", alias: "t", root: "tag", terms: { _id: idLit("RkznxXmmh9b5ovdSq") }, select: "{ result { ...TAG_CARD } }" });
    const m = op({ template: "multi_document_by_id", alias: "m", root: "multiDocument", terms: { _id: idLit("RkznxXmmh9b5ovdSq") }, select: "{ result { ...MDOC_REF } }" });
    const doc = documentFor("tag_by_id", [t, m]);
    expect(doc).toBe(`query tag_by_id { ${t.text} ${m.text} }\n${FRAGMENTS.TAG_REF}\n${FRAGMENTS.TAG_CARD}\n${FRAGMENTS.MDOC_REF}`);
    expect(validate(forumSchema, parse(doc))).toEqual([]);
    const plain = op({ template: "spotlight", alias: "f", root: "currentSpotlight", select: "{ documentType }" });
    expect(documentFor("spotlight", [plain])).toBe("query spotlight { f: currentSpotlight { documentType } }");
  });

  it("refuses an operation name that is not a GraphQL name, naming it as the failing template", () => {
    expect(() => documentFor("get-post", [])).toThrow("Unexpected failure in get-post (operation name is not a GraphQL name). Please report this.");
  });

  it("leaves out a custom-root argument whose literal is undefined and keeps the others in order", () => {
    const o = op({ template: "t", alias: "f", root: "PopularComments", args: { limit: int(5), offset: undefined, cutoff: dateLit(Date.UTC(2026, 9, 22)) }, select: "{ __typename }" });
    expect(o.text).toBe('f: PopularComments(limit: 5, cutoff: "2026-10-22T00:00:00.000Z") { __typename }');
  });

  it("hands every op to the guard: a refused op is never built", () => {
    expect(() => op({ template: "t", alias: "a", root: "votes", select: "{ __typename }" })).toThrow("Unexpected failure in t (root votes is not allowed). Please report this.");
  });
});
