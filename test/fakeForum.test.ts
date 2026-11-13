import { describe, expect, it } from "vitest";
import { documentFor } from "../src/forum/templates/op";
import { commentByIdOp } from "../src/forum/templates/shared";
import { ID_RE } from "../src/ids/parse";
import { createFakeForum, type FakeForum } from "./fakeForum";
import {
  SAMPLE_AUTHOR, gqlEntry, rawCommentLight, rawCommentList, rawMdocRef, rawPostFull, rawPostLight, rawPostRef, rawRevRow,
  rawSeqCard, rawSeqLight, rawTagFull, rawTagList, rawUserProfile, seedId,
} from "./support/builders";
import { ALL_FAMILIES, checkFixtureFields, loadFamilies, parseFamily } from "./support/fixtures";

const GQL = "https://www.lesswrong.com/graphql";
const SEARCH = "https://www.lesswrong.com/api/search";
const send = (forum: FakeForum, body: unknown, url = GQL) =>
  forum.fetchImpl(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const read = async (res: Response): Promise<any> => res.json();
const one = (query: string, operationName = "t") => ({ query, operationName });
const P = 'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true)';

describe("fixtures (¶9.1, D14)", () => {
  it("D14 every entry of all eleven fixture families names its § source", () => {
    for (const e of loadFamilies(...ALL_FAMILIES)) expect(e.source, JSON.stringify(e.match)).toMatch(/^§\d/);
  });

  it("C2 D14 every field of every GraphQL fixture document exists on its type in the forum schema", () => {
    expect(checkFixtureFields(loadFamilies(...ALL_FAMILIES))).toEqual([]);
  });

  it("L10 every usersWhoLiked entry in the hand fixtures has the live shape, {_id, displayName}, never userId", () => {
    const entries: unknown[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (Array.isArray(o.usersWhoLiked)) entries.push(...o.usersWhoLiked);
        Object.values(o).forEach(walk);
      }
    };
    for (const e of loadFamilies(...ALL_FAMILIES)) walk(e.result);
    // The live check of 2026-10-24 saw every liker of a page or a lens as {_id, displayName}, the _id being the user id (the
    // {userId} shape is unit-tested in domain/reactions); an entry without either is the deliberate Q108 case (counted, never named).
    const withId = entries.filter((e) => typeof (e as Record<string, unknown>)._id === "string");
    expect(withId.length).toBeGreaterThan(0);
    for (const entry of withId) expect(Object.keys(entry as object).sort(), JSON.stringify(entry)).toEqual(["_id", "displayName"]);
    for (const entry of entries) expect(entry, JSON.stringify(entry)).not.toHaveProperty("userId");
  });

  it("a malformed family file names itself: the error starts with the file's path", () => {
    expect(() => parseFamily("tags", "[{ \"source\": \"§1\", }")).toThrow(/^test\/fixtures\/hand\/tags\.json: .+/);
    expect(parseFamily("tags", "[]")).toEqual([]);
  });

  it("checkFixtureFields names a field the schema lacks, an unknown view and an unknown root", () => {
    expect(
      checkFixtureFields([
        gqlEntry({ root: "post", id: "uMQ3cqWDPHhjtiesc" }, { result: { _id: "uMQ3cqWDPHhjtiesc", nonexistentField: 1 } }, "§6.3"),
        gqlEntry({ root: "posts", view: "noSuchView" }, { results: [] }, "§6.2"),
        gqlEntry({ root: "noSuchRoot" }, {}, "§4.2"),
      ]),
    ).toEqual([
      "§6.3 post: Post.nonexistentField does not exist",
      "§6.2 posts: view noSuchView does not exist",
      "§4.2 noSuchRoot: root does not exist",
    ]);
  });

  it("builders make deterministic seed ids and complete public documents that pass the schema check", () => {
    expect(seedId(1)).toBe("seed0000000000001");
    expect(ID_RE.test(seedId(42))).toBe(true);
    expect(rawPostRef()).toEqual({
      _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities", af: true,
      question: false, rejected: false, unlisted: false, shortform: false, hideAuthor: false, isEvent: false,
      hiddenRelatedQuestion: false, groupId: null,
    });
    expect(rawPostFull({ title: "X" }).title).toBe("X");
    expect(rawPostFull()).not.toBe(rawPostFull());
    expect(
      checkFixtureFields([
        gqlEntry({ root: "post", id: "uMQ3cqWDPHhjtiesc" }, { result: rawPostFull() }, "§6.3"),
        gqlEntry({ root: "comments", view: "postCommentsOld" }, { results: [rawCommentList()] }, "§8.5"),
        gqlEntry({ root: "user", id: "nmk3nLpQE89dMRzzN" }, { result: rawUserProfile() }, "§9.2"),
        gqlEntry({ root: "tag", id: "56yXXrcxRjrQs6z9R" }, { result: rawTagFull() }, "§10.3"),
        gqlEntry({ root: "sequence", id: "5g5TkQTe9rmPS5vvM" }, { result: rawSeqCard() }, "§11.1"),
        gqlEntry({ root: "multiDocument", id: seedId(101) }, { result: rawMdocRef() }, "§10.2"),
        gqlEntry({ root: "revisions", view: "revisionsOnDocument" }, { results: [rawRevRow()] }, "§7.4"),
        gqlEntry({ root: "tags", view: "allTagsAlphabetical" }, { results: [rawTagList()] }, "§10.2"),
        gqlEntry({ root: "comments", view: "allRecentComments" }, { results: [rawCommentLight()] }, "§9.4"),
        gqlEntry({ root: "posts", view: "userPosts" }, { results: [rawPostLight()] }, "§9.3"),
        gqlEntry({ root: "sequences", view: "default" }, { results: [rawSeqLight()] }, "§11.1"),
      ]),
    ).toEqual([]);
  });
});

describe("GraphQL answers (¶9.2)", () => {
  it("answers one operation, projecting the fixture document onto the selection set", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport"), now: () => 1234 });
    const res = await send(forum, one(`query t { ${P} { result { _id title af } } }`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await read(res)).toEqual({ data: { p: { result: { _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", af: true } } } });
    expect(forum.requests).toHaveLength(1);
    expect(forum.requests[0]).toMatchObject({ endpoint: "graphql", at: 1234 });
    expect(forum.warnings).toEqual([]);
    expect(forum.unmatched).toEqual([]);
  });

  it("a selected field missing from the fixture projects as null and is reported", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    const json = await read(await send(forum, one(`query t { ${P} { result { _id postedAt } } }`)));
    expect(json).toEqual({ data: { p: { result: { _id: "uMQ3cqWDPHhjtiesc", postedAt: null } } } });
    expect(forum.warnings).toEqual(["Post.postedAt missing in fixture (§4.3)"]);
  });

  it("fragments, nested aliases and repeated fields are projected and merged as the forum would", async () => {
    const forum = createFakeForum({ fixtures: [gqlEntry({ root: "comment", id: "HRDoDnHv8bvoW7oPZ" }, { result: rawCommentList() }, "§8.5")] });
    const op = commentByIdOp("c", "HRDoDnHv8bvoW7oPZ", "...COMMENT_TREE contents { markdown } post { ...POST_REF } who: user { slug }");
    const json = await read(await send(forum, one(documentFor("t", [op]))));
    expect(json.data.c.result.contents).toEqual({ wordCount: 2, markdown: "A comment." });
    expect(json.data.c.result.post).toEqual(rawPostRef());
    expect(json.data.c.result.who).toEqual({ slug: SAMPLE_AUTHOR.slug });
    expect(json.data.c.result).not.toHaveProperty("tag");
  });

  it("Q83 Q27 an operation that fails validation gets HTTP 400 and loses its aliases; the other operation of the batch keeps its data", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport"), lint: false });
    const res = await send(forum, [
      one(`query a { ${P} { result { _id } } }`, "a"),
      one(`query b { x: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { _id noSuchField } } }`, "b"),
      one("query c { x: post(", "c"),
    ]);
    expect(res.status).toBe(400);
    const [ok, invalid, unparsable] = await read(res);
    expect(ok).toEqual({ data: { p: { result: { _id: "uMQ3cqWDPHhjtiesc" } } } });
    expect(invalid).not.toHaveProperty("data");
    expect(invalid.errors).toMatchObject([{ message: 'Cannot query field "noSuchField" on type "Post".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }]);
    expect(unparsable.errors[0].extensions.code).toBe("GRAPHQL_PARSE_FAILED");
    expect(unparsable.errors[0].message).toMatch(/^Syntax Error/);
  });

  it("Q84 an error in a non-null root nulls the whole operation's data", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    const res = await send(forum, one('query g { g: TagsByCoreTagId(coreTagId: "AAAAAAAAAAAAAAAAA", limit: 500) { totalCount } }', "g"));
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ data: null, errors: [{ message: "Tag not found", path: ["g"] }] });
  });

  it("Q75 Q85 resolver errors are per alias, with path, locations and a stack trace", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    const res = await send(
      forum,
      one(
        'query t { a: post(selector: {_id: "BBBBBBBBBBBBBBBBB"}, allowNull: true) { result { _id } } b: post(selector: {_id: "AAAAAAAAAAAAAAAAA"}, allowNull: true) { result { _id } } c: user(selector: {_id: "AAAAAAAAAAAAAAAAA"}) { result { _id } } }',
      ),
    );
    expect(res.status).toBe(200);
    const json = await read(res);
    expect(json.data).toEqual({ a: null, b: { result: null }, c: null });
    expect(json.errors).toMatchObject([
      { message: "app.operation_not_allowed", path: ["a"], locations: [{ line: 1, column: 1 }], extensions: { code: "INTERNAL_SERVER_ERROR" } },
      { message: "app.missing_document", path: ["c"] },
    ]);
    expect(json.errors[0].extensions.stacktrace[1]).toContain("/var/task/");
  });

  it("a nested error keeps the alias's data; an error without data nulls the alias", async () => {
    const forum = createFakeForum({
      lint: false,
      fixtures: [
        {
          source: "§4.8",
          match: { root: "post", id: "uMQ3cqWDPHhjtiesc" },
          result: { result: { ...rawPostRef(), contents: null } },
          error: { message: "Cannot return null for non-nullable field Revision.changeMetrics.", path: ["p", "result", "contents", "changeMetrics"] },
        },
        { source: "§4.8", match: { root: "posts", view: "default" }, error: { message: "app.operation_not_allowed", path: ["l", "results", 0, "user"] } },
      ],
    });
    const json = await read(
      await send(
        forum,
        one(`query t { ${P} { result { _id contents { changeMetrics } } } l: posts(selector: {default: {exactPostIds: ["uMQ3cqWDPHhjtiesc"]}}, limit: 1) { results { _id } } }`),
      ),
    );
    expect(json.data).toEqual({ p: { result: { _id: "uMQ3cqWDPHhjtiesc", contents: null } }, l: null });
    expect(json.errors.map((e: { path: unknown }) => e.path)).toEqual([["p", "result", "contents", "changeMetrics"], ["l", "results", 0, "user"]]);
  });

  it("an unmatched alias is recorded with its request and answered as an error", async () => {
    const forum = createFakeForum({ fixtures: [] });
    const json = await read(await send(forum, one('query t { x: post(selector: {_id: "ZZZZZZZZZZZZZZZZZ"}, allowNull: true) { result { _id } } }')));
    expect(forum.unmatched).toEqual(['x: post {"id":"ZZZZZZZZZZZZZZZZZ"}']);
    expect(json).toMatchObject({ data: { x: null }, errors: [{ message: 'fake forum: no fixture for x: post {"id":"ZZZZZZZZZZZZZZZZZ"}', path: ["x"] }] });
  });

  it("matching: first match wins; terms are a subset; limit, offset and enableTotal only when the entry gives them", async () => {
    const forum = createFakeForum({
      lint: false,
      fixtures: [
        gqlEntry({ root: "comments", view: "postCommentsOld", terms: { postId: "uMQ3cqWDPHhjtiesc" }, offset: 100 }, { results: [{ _id: "second" }] }, "§8.2"),
        // The same root, view and terms, told apart by the limit or by enableTotal alone: each is chosen only by a request that gives it.
        gqlEntry({ root: "comments", view: "postCommentsOld", terms: { postId: "uMQ3cqWDPHhjtiesc" }, limit: 100 }, { results: [{ _id: "limited" }] }, "§8.2"),
        gqlEntry({ root: "comments", view: "postCommentsOld", terms: { postId: "uMQ3cqWDPHhjtiesc" }, enableTotal: true }, { results: [{ _id: "totalled" }], totalCount: 1 }, "§8.2"),
        gqlEntry({ root: "comments", view: "postCommentsOld", terms: { postId: "uMQ3cqWDPHhjtiesc" } }, { results: [{ _id: "first" }] }, "§8.2"),
        gqlEntry({ root: "comments", view: "postCommentsOld" }, { results: [{ _id: "any" }] }, "§8.2"),
      ],
    });
    const q = (postId: string, extra = "", limit = 5000) =>
      one(`query t { c: comments(selector: {postCommentsOld: {postId: "${postId}"}}, limit: ${limit}${extra}) { results { _id } } }`);
    const ids = async (body: unknown) => (await read(await send(forum, body))).data.c.results;
    expect(await ids(q("uMQ3cqWDPHhjtiesc"))).toEqual([{ _id: "first" }]);
    expect(await ids(q("uMQ3cqWDPHhjtiesc", ", offset: 100"))).toEqual([{ _id: "second" }]);
    expect(await ids(q("uMQ3cqWDPHhjtiesc", "", 100))).toEqual([{ _id: "limited" }]);
    expect(await ids(q("uMQ3cqWDPHhjtiesc", ", enableTotal: true"))).toEqual([{ _id: "totalled" }]);
    expect(await ids(q("uMQ3cqWDPHhjtiesc", ", enableTotal: false"))).toEqual([{ _id: "first" }]);
    expect(await ids(q("R5g8YT25G9DXJJ48n"))).toEqual([{ _id: "any" }]);
  });
});

describe("search answers (¶9.2, §5.1)", () => {
  const q = (query: string, page: number) => ({ indexName: "posts", params: { query, hitsPerPage: 10, page, highlightPreTag: "**", highlightPostTag: "**" } });

  it("Q27 search bodies are answered from search fixtures as text/plain JSON, one result per query", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    const res = await send(forum, { options: { emptyStringSearchResults: "empty" }, queries: [q('"inner alignment"', 0)] }, SEARCH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    const [r] = JSON.parse(await res.text());
    expect(r).toMatchObject({ nbHits: 569, page: 0, nbPages: 57, hitsPerPage: 10, index: "posts", hits: [{ objectID: "uMQ3cqWDPHhjtiesc" }] });
    expect(forum.requests[0].endpoint).toBe("search");
  });

  it("Q23 one failing query fails the whole body: HTTP 400 with its text message", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport"), lint: false });
    const res = await send(forum, { options: { emptyStringSearchResults: "empty" }, queries: [q('"inner alignment"', 0), q('"inner alignment"', 1000)] }, SEARCH);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("search_phase_execution_exception … Result window is too large, from + size must be less than or equal to: [10000]");
  });

  it("an unmatched search query is recorded and answered with no hits", async () => {
    const forum = createFakeForum({ fixtures: [] });
    const [r] = JSON.parse(await (await send(forum, { options: { emptyStringSearchResults: "empty" }, queries: [q("nothing", 0)] }, SEARCH)).text());
    expect(r).toMatchObject({ hits: [], nbHits: 0, index: "posts" });
    expect(forum.unmatched).toEqual(['search posts {"query":"nothing","page":0,"hitsPerPage":10}']);
  });
});

describe("injections and counting", () => {
  it("statuses with headers, delays and malformed bodies, by endpoint and body, a number of times", async () => {
    const slept: number[] = [];
    const forum = createFakeForum({ fixtures: loadFamilies("transport"), sleep: async (ms) => void slept.push(ms) });
    forum.inject({ status: 429, headers: { "retry-after": "120" }, times: 2 });
    forum.inject({ endpoint: "search", status: 500 });
    forum.inject({ when: (b) => b.includes("query slow"), delayMs: 5000 });
    forum.inject({ when: (b) => b.includes("html-please"), status: 200, body: "<html>challenge</html>" });
    const post = one(`query t { ${P} { result { _id } } }`);
    expect((await send(forum, post)).status).toBe(429);
    const second = await send(forum, post);
    expect([second.status, second.headers.get("retry-after")]).toEqual([429, "120"]);
    expect((await send(forum, post)).status).toBe(200);
    expect((await send(forum, { queries: [] }, SEARCH)).status).toBe(500);
    const slow = await send(forum, one(`query slow { ${P} { result { _id } } }`, "slow"));
    expect([slow.status, slept]).toEqual([200, [5000]]);
    const html = await send(forum, { query: "html-please" });
    expect([html.status, await html.text()]).toEqual([200, "<html>challenge</html>"]);
    expect(forum.requests).toHaveLength(6);
  });

  it("an injected body without a status answers HTTP 200 with that body", async () => {
    const forum = createFakeForum({ fixtures: [] });
    forum.inject({ endpoint: "graphql", body: "not json" });
    const res = await send(forum, one(`query t { ${P} { result { _id } } }`));
    expect([res.status, await res.text()]).toEqual([200, "not json"]);
    expect(forum.unmatched).toEqual([]);
  });

  it("without opts.sleep an injected delay waits on a real timer, then answers normally", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    forum.inject({ delayMs: 1 });
    const json = await read(await send(forum, one(`query t { ${P} { result { _id } } }`)));
    expect(json).toEqual({ data: { p: { result: { _id: "uMQ3cqWDPHhjtiesc" } } } });
  });
});

describe("other GraphQL shapes", () => {
  it("an operationName the document does not define fails the operation with HTTP 400", async () => {
    const forum = createFakeForum({ fixtures: loadFamilies("transport") });
    const res = await send(forum, one(`query t { ${P} { result { _id } } }`, "other"));
    expect(res.status).toBe(400);
    expect(await read(res)).toEqual({ errors: [{ message: 'Unknown operation named "other".', extensions: { code: "OPERATION_RESOLUTION_FAILURE" } }] });
  });
});
