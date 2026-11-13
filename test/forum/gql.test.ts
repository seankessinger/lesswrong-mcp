import { describe, expect, it } from "vitest";
import { createCallContext } from "../../src/call/context";
import { categoryOf, createGql } from "../../src/forum/gql";
import { commentForestOps, coreGroupingOp, postByIdOp, postsByIdsOp, tagRefsByIdOps, userByIdOp, userBySlugOp } from "../../src/forum/templates/shared";
import type { GqlOp, Http, HttpRequest } from "../../src/types";
import { gqlEntry, rawPostRef, rawTagRef, seedId } from "../support/builders";
import { loadFamilies } from "../support/fixtures";
import { forumStack } from "../support/forumStack";

const AGI = "uMQ3cqWDPHhjtiesc";
const bad: GqlOp = {
  template: "bad_template",
  alias: "x",
  text: 'x: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { _id noSuchField } }',
};
const ctx = (tool: "get_post" | "get_comments" = "get_post") => createCallContext(tool, { now: () => 0, maxRequests: 10 });
function stubHttp(answer: (body: string) => { status: number; text: string }) {
  const reqs: HttpRequest[] = [];
  const evicted: string[][] = [];
  const http: Http = {
    fetch: async (r) => {
      reqs.push(r);
      const a = answer(r.body);
      return { ...a, ms: 0, bytes: a.text.length, cached: false, cacheKey: "http:k" };
    },
    evict: (keys) => void evicted.push([...keys]),
  };
  return { http, reqs, evicted };
}
const sentOperationNames = (body: string) => (JSON.parse(body) as { operationName: string }[]).map((o) => o.operationName);

describe("createGql against the fake forum", () => {
  it("S7 R9 Q27 a 400 array batch keeps the other operation's data; the failed operation's aliases are internal, naming their template", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport"), lint: false });
    const out = await createGql(s.http)([postByIdOp("p", AGI, "...POST_REF"), { ...bad, isolate: true }], s.ctx(), "loading the post");
    expect(out.get("p")).toEqual({ data: { result: rawPostRef() } });
    expect(out.get("x")).toEqual({ error: "internal", message: 'bad_template: Cannot query field "noSuchField" on type "Post".' });
    expect(sentOperationNames(s.forum.requests[0].body)).toEqual(["post_by_id", "bad_template"]);
  });

  it("Q83 a validation error loses every alias of its operation", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport"), lint: false });
    const out = await createGql(s.http)([postByIdOp("p", AGI, "...POST_REF"), bad], s.ctx(), "loading the post");
    expect(Object.fromEntries(out)).toEqual({
      p: { error: "internal", message: 'post_by_id: Cannot query field "noSuchField" on type "Post".' },
      x: { error: "internal", message: 'bad_template: Cannot query field "noSuchField" on type "Post".' },
    });
  });

  it("Q84 R6 a non-null root goes in its own operation; its data: null takes only that operation", async () => {
    const s = forumStack({ fixtures: loadFamilies("transport") });
    const out = await createGql(s.http)([coreGroupingOp("g", "AAAAAAAAAAAAAAAAA"), postByIdOp("p", AGI, "...POST_REF")], s.ctx(), "loading the core tag");
    expect(out.get("g")).toEqual({ error: "not_found", message: "Tag not found" });
    expect(out.get("p")).toEqual({ data: { result: rawPostRef() } });
    expect(sentOperationNames(s.forum.requests[0].body)).toEqual(["post_by_id", "core_grouping"]);
    expect(s.forum.lintErrors).toEqual([]);
  });

  it("Q85 S8 aliases map to errors by path; a null alias without an error is data null", async () => {
    const s = forumStack({ fixtures: [gqlEntry({ root: "GetUserBySlug", args: { slug: "nobody" } }, null, "§9.1"), ...loadFamilies("transport")] });
    const out = await createGql(s.http)(
      [postByIdOp("a", "BBBBBBBBBBBBBBBBB", "_id"), postByIdOp("b", "AAAAAAAAAAAAAAAAA", "_id"), userByIdOp("c", "AAAAAAAAAAAAAAAAA", "_id"), userBySlugOp("d", "nobody", "_id slug")],
      s.ctx(),
      "resolving",
    );
    expect(Object.fromEntries(out)).toEqual({
      a: { error: "not_public", message: "app.operation_not_allowed" },
      b: { data: { result: null } },
      c: { error: "not_found", message: "app.missing_document" },
      d: { data: null },
    });
  });

  it("Q75 stack traces, locations and server paths never leave gql; messages are cut to 200 characters", async () => {
    const s = forumStack({ fixtures: [{ source: "§4.8", match: { root: "post", id: AGI }, error: { message: "x".repeat(300) } }] });
    const out = await createGql(s.http)([postByIdOp("p", AGI, "_id")], s.ctx(), "loading the post");
    const r = out.get("p") as { error: string; message: string };
    expect(r.error).toBe("forum_error");
    expect(r.message.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(Object.fromEntries(out))).not.toMatch(/var\/task|stacktrace|locations/);
  });

  it("nested errors: a non-null alias keeps its data; an error that nulled the alias is the alias error", async () => {
    const s = forumStack({
      lint: false,
      fixtures: [
        {
          source: "§4.8",
          match: { root: "post", id: AGI },
          result: { result: { _id: AGI, contents: null } },
          error: { message: "Cannot return null for non-nullable field Revision.changeMetrics.", path: ["p", "result", "contents", "changeMetrics"] },
        },
        { source: "§4.8", match: { root: "posts", view: "default" }, error: { message: "app.operation_not_allowed", path: ["l", "results", 0, "user"] } },
      ],
    });
    const nested: GqlOp = { template: "nested", alias: "p", text: `p: post(selector: {_id: "${AGI}"}, allowNull: true) { result { _id contents { changeMetrics } } }` };
    const out = await createGql(s.http)([nested, postsByIdsOp("l", [AGI], "_id")!], s.ctx(), "loading the post");
    expect(out.get("p")).toEqual({ data: { result: { _id: AGI, contents: null } } });
    expect(out.get("l")).toEqual({ error: "not_public", message: "app.operation_not_allowed" });
  });

  it("Q16 R11 at most 100 aliases per operation: 250 aliases are three operations of one array batch, one request", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => seedId(i + 1));
    const s = forumStack({ fixtures: [gqlEntry({ root: "tag" }, { result: rawTagRef() }, "§10.2")] });
    const out = await createGql(s.http)(tagRefsByIdOps("ar", ids), s.ctx(), "resolving tags");
    expect(out.size).toBe(250);
    expect(s.forum.requests).toHaveLength(1);
    const sent = JSON.parse(s.forum.requests[0].body) as { query: string }[];
    expect(sent.map((o) => (o.query.match(/\bar\d+:/g) ?? []).length)).toEqual([100, 100, 50]);
    expect(s.forum.lintErrors).toEqual([]);
  });
});

describe("createGql request building and bookkeeping", () => {
  it("one operation: operationName is the first op's template; the request TTL is the smallest ttlMs", async () => {
    const { http, reqs } = stubHttp(() => ({ status: 200, text: JSON.stringify({ data: { a: { result: null }, b: { result: null } } }) }));
    await createGql(http)([{ ...postByIdOp("a", AGI, "_id"), ttlMs: 120_000 }, { ...postByIdOp("b", AGI, "_id"), ttlMs: 1_800_000 }], ctx(), "loading the feed");
    expect(reqs[0]).toMatchObject({ endpoint: "graphql", ttlMs: 120_000, task: "loading the feed", label: "post_by_id" });
    const body = JSON.parse(reqs[0].body) as { query: string; operationName: string };
    expect(body.operationName).toBe("post_by_id");
    expect(body.query.startsWith('query post_by_id { a: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { _id } } b: post(')).toBe(true);
  });

  it("duplicate aliases are an internal error; an empty op list sends nothing", async () => {
    const { http, reqs } = stubHttp(() => ({ status: 200, text: "{}" }));
    await expect(createGql(http)([postByIdOp("p", AGI, "_id"), postByIdOp("p", AGI, "_id")], ctx(), "t")).rejects.toMatchObject({
      category: "internal",
      message: "Unexpected failure in get_post (post_by_id: duplicate alias p). Please report this.",
    });
    expect(await createGql(http)([], ctx(), "t")).toEqual(new Map());
    expect(reqs).toHaveLength(0);
  });

  it("¶2.3 an alias error other than not_found or not_public evicts the raw response; not_found keeps it", async () => {
    const skip = stubHttp(() => ({ status: 200, text: JSON.stringify({ data: { a: null }, errors: [{ message: "Exceeded maximum value for skip", path: ["a"] }] }) }));
    expect((await createGql(skip.http)([postByIdOp("a", AGI, "_id")], ctx(), "t")).get("a")).toEqual({ error: "internal", message: "post_by_id: Exceeded maximum value for skip" });
    expect(skip.evicted).toEqual([["http:k"]]);
    const nf = stubHttp(() => ({ status: 200, text: JSON.stringify({ data: { a: null }, errors: [{ message: "app.missing_document", path: ["a"] }] }) }));
    await createGql(nf.http)([postByIdOp("a", AGI, "_id")], ctx(), "t");
    expect(nf.evicted).toEqual([]);
  });

  it("a body that is not JSON is forum_error", async () => {
    const { http } = stubHttp(() => ({ status: 200, text: "<html>" }));
    await expect(createGql(http)([postByIdOp("a", AGI, "_id")], ctx(), "loading the post")).rejects.toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the post (unexpected non-JSON response (possibly bot protection)). Try again later.",
    });
  });

  it("P17 runtime guard: an excluded-path op whose subject this call has not confirmed is never sent", async () => {
    const elsewhere = createCallContext("get_comments", { now: () => 0 });
    const ops = commentForestOps(elsewhere.confirmPublic("post", AGI), false);
    const { http, reqs } = stubHttp(() => ({ status: 200, text: JSON.stringify({ data: { c: { results: [] }, a: { results: [] } } }) }));
    await expect(createGql(http)(ops, ctx("get_comments"), "loading the discussion")).rejects.toMatchObject({
      category: "internal",
      message: "Unexpected failure in get_comments (comment_forest: excluded path for a subject not confirmed public in this call). Please report this.",
    });
    expect(reqs).toHaveLength(0);
    const here = ctx("get_comments");
    here.confirmPublic("post", AGI);
    await createGql(http)(ops, here, "loading the discussion");
    expect(reqs).toHaveLength(1);
  });

  it("R6 a request holding an isolated operation is a JSON array even when it is the only operation; any other lone operation is a bare object", async () => {
    const { http, reqs } = stubHttp((body) => ({
      status: 200,
      text: JSON.stringify(Array.isArray(JSON.parse(body)) ? [{ data: { g: { tags: [], totalCount: 0 } } }] : { data: { p: { result: null } } }),
    }));
    const gql = createGql(http);
    const out = await gql([coreGroupingOp("g", "sYm3HiWcfZvrGu3ui")], ctx(), "loading the core tag");
    const sent = JSON.parse(reqs[0].body) as { query: string; operationName: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0].operationName).toBe("core_grouping");
    expect(sent[0].query.startsWith('query core_grouping { g: TagsByCoreTagId(coreTagId: "sYm3HiWcfZvrGu3ui", limit: 500) { tags { ...TAG_LIST } totalCount } }')).toBe(true);
    expect(out.get("g")).toEqual({ data: { tags: [], totalCount: 0 } });
    await gql([postByIdOp("p", AGI, "_id")], ctx(), "loading the post");
    expect(JSON.parse(reqs[1].body)).toMatchObject({ operationName: "post_by_id" });
    expect(Array.isArray(JSON.parse(reqs[1].body))).toBe(false);
  });

  it("R11 R6 the shared ops are chunked in order, then each isolated op alone; the label joins the operation names; results keep op order", async () => {
    const answers = [
      { data: { t1: { result: null }, t2: { result: null } } },
      { data: { t3: { result: null }, p: { result: null } } },
      { data: { g: { tags: [], totalCount: 0 } } },
    ];
    const { http, reqs } = stubHttp(() => ({ status: 200, text: JSON.stringify(answers) }));
    const ops = [coreGroupingOp("g", "sYm3HiWcfZvrGu3ui"), ...tagRefsByIdOps("t", [seedId(1), seedId(2), seedId(3)]), postByIdOp("p", AGI, "_id")];
    const out = await createGql(http, { maxAliases: 2 })(ops, ctx(), "resolving tags");
    expect(reqs[0].label).toBe("tag_refs_by_id+tag_refs_by_id+core_grouping");
    expect(reqs[0]).not.toHaveProperty("ttlMs");
    expect(sentOperationNames(reqs[0].body)).toEqual(["tag_refs_by_id", "tag_refs_by_id", "core_grouping"]);
    expect([...out.keys()]).toEqual(["g", "t1", "t2", "t3", "p"]);
  });

  it("Q84 a whole-operation data: null with an internal message names each alias's template, and evicts", async () => {
    const { http, evicted } = stubHttp(() => ({
      status: 200,
      text: JSON.stringify([{ data: null, errors: [{ message: "Cannot read properties of undefined (reading 'tags')", path: ["g"] }] }]),
    }));
    const out = await createGql(http)([coreGroupingOp("g", "sYm3HiWcfZvrGu3ui")], ctx(), "loading the core tag");
    expect(out.get("g")).toEqual({ error: "internal", message: "core_grouping: Cannot read properties of undefined (reading 'tags')" });
    expect(evicted).toEqual([["http:k"]]);
  });

  it("an alias the answer lacks is forum_error, inherited object keys included, and evicts", async () => {
    const { http, evicted } = stubHttp(() => ({ status: 200, text: JSON.stringify({ data: { a: { result: null } } }) }));
    const out = await createGql(http)([postByIdOp("a", AGI, "_id"), postByIdOp("constructor", AGI, "_id")], ctx(), "loading the post");
    expect(Object.fromEntries(out)).toEqual({
      a: { data: { result: null } },
      constructor: { error: "forum_error", message: "the forum's answer lacked this part" },
    });
    expect(evicted).toEqual([["http:k"]]);
  });

  it("¶2.3 an answer that is not JSON, or not one result per operation, is forum_error and is evicted", async () => {
    const garbled = stubHttp(() => ({ status: 200, text: "{garbled" }));
    await expect(createGql(garbled.http)([postByIdOp("a", AGI, "_id")], ctx(), "loading the post")).rejects.toMatchObject({ category: "forum_error" });
    expect(garbled.evicted).toEqual([["http:k"]]);
    const short = stubHttp(() => ({ status: 200, text: JSON.stringify([{ data: { p: { result: null } } }]) }));
    await expect(createGql(short.http)([postByIdOp("p", AGI, "_id"), coreGroupingOp("g", "sYm3HiWcfZvrGu3ui")], ctx(), "loading the core tag")).rejects.toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the core tag (malformed response). Try again later.",
    });
    expect(short.evicted).toEqual([["http:k"]]);
    const notBatch = stubHttp(() => ({ status: 400, text: JSON.stringify({ errors: [{ message: "Bad batch" }] }) }));
    await expect(createGql(notBatch.http)([coreGroupingOp("g", "sYm3HiWcfZvrGu3ui")], ctx(), "loading the core tag")).rejects.toMatchObject({
      category: "forum_error",
      message: "The forum returned an error while loading the core tag (malformed response). Try again later.",
    });
  });
});

describe("categoryOf: the ¶8 message table", () => {
  it.each([
    ["app.missing_document", "not_found"],
    ["app.operation_not_allowed", "not_public"],
    ["This post is only visible to logged-in users.", "login_only"],
    ["Tag not found", "not_found"],
    ["Exceeded maximum value for skip", "internal"],
    ["OFFSET must not be negative", "internal"],
    ["app.conflicting_term_and_resolver_arg_keys", "internal"],
    ["Invalid view argument: legacyId must be base36, was !!", "internal"],
    ["Invalid postCommentsNew view: postId is required", "internal"],
    ["Missing view argument: legacyId", "internal"],
    ["Invalid time field: title", "internal"],
    ["Invalid value for timeField", "internal"],
    ["Cannot read properties of undefined (reading 'graphql')", "internal"],
    ['invalid input syntax for type timestamp with time zone: "0NaN-NaN-…"', "internal"],
    ["Cannot return null for non-nullable field Revision.changeMetrics.", "internal"],
    ["Cannot resolve field name: af", "internal"],
    ["You must be logged in to see actively discussed posts.", "internal"],
    ["Must be logged in or have a client ID to use the feed.", "internal"],
    ["You must be an admin to search comments by embedding", "internal"],
    ["Only admins can search for accounts to merge", "internal"],
    ["This feature is only available to admins", "internal"],
    ["Something nobody has seen before", "forum_error"],
  ])("¶8 Q82 categoryOf(%j) → %s", (message, category) => {
    expect(categoryOf(message)).toBe(category);
  });
});
