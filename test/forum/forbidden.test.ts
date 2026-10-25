import { getNamedType, isInputObjectType, type GraphQLInputObjectType, type GraphQLObjectType } from "graphql";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  DENIED_ROOTS,
  DENIED_TERMS,
  DENIED_VIEWS,
  EXCLUDED_PATHS,
  assertAllowed,
  enableTotalAllowed,
} from "../../src/forum/forbidden";
import { bool, idLit, int, list, obj, str } from "../../src/forum/literal";
import { op, type OpSpec } from "../../src/forum/templates/op";
import type { GqlOp } from "../../src/types";
import { forumSchema } from "../schema";
import { DENIED_FIELDS } from "../support/deniedFields";

const AGI = "uMQ3cqWDPHhjtiesc";
const base: OpSpec = { template: "t", alias: "a", root: "posts", view: "new", terms: {}, limit: 10, select: "{ results { _id } }" };
const build = (o: Partial<OpSpec>) => () => op({ ...base, ...o });
const custom = (root: string, args: Record<string, string>, o: Partial<OpSpec> = {}) =>
  build({ root, view: undefined, terms: undefined, limit: undefined, args, select: "{ __typename }", ...o });
const refused = (detail: string) => `Unexpected failure in t (${detail}). Please report this.`;
const raw = (text: string): GqlOp => ({ template: "t", alias: "a", text });

describe("assertAllowed (via op)", () => {
  it("Q1 Q18 R2 an explicit limit on every list root and limited custom root, 1–5000; RecentDiscussionFeed at most 20", () => {
    expect(build({ limit: undefined })).toThrow(refused("missing limit on posts"));
    expect(build({ limit: 0 })).toThrow(refused("limit 0 outside 1–5000"));
    expect(build({ limit: 5001 })).toThrow(refused("limit 5001 outside 1–5000"));
    expect(build({ limit: 5000 })).not.toThrow();
    expect(custom("TagsByCoreTagId", { coreTagId: idLit("sYm3HiWcfZvrGu3ui") }, { isolate: true })).toThrow(
      refused("missing limit on TagsByCoreTagId"),
    );
    expect(custom("RecentDiscussionFeed", { limit: int(21) }, { isolate: true })).toThrow(
      refused("limit 21 over 20 on RecentDiscussionFeed"),
    );
    expect(custom("PopularComments", { limit: int(100) })).not.toThrow();
  });

  it("Q2 R2 never a limit term inside a view", () => {
    expect(build({ terms: { limit: str("5") } })).toThrow(refused("denied term limit"));
  });

  it("Q4 offsets stay within 0–2000", () => {
    expect(build({ offset: 2001 })).toThrow(refused("offset 2001 outside 0–2000"));
    expect(build({ offset: -1 })).toThrow(refused("offset -1 outside 0–2000"));
    expect(build({ offset: 2000 })).not.toThrow();
  });

  it("Q7 R1 exactly one view key, never a view term, and a list root always names its view", () => {
    expect(() => assertAllowed(raw("a: posts(selector: {new: {}, old: {}}, limit: 5) { results { _id } }"))).toThrow(
      refused("more than one view key"),
    );
    expect(build({ terms: { view: str("top") } })).toThrow(refused("denied term view"));
    expect(build({ view: undefined, terms: undefined })).toThrow(refused("missing view on posts"));
  });

  it("Q10 R4 no variables and no mutations; a $ inside a string literal is data", () => {
    expect(() => assertAllowed(raw("a: posts(selector: {new: {after: $after}}, limit: 5) { results { _id } }"))).toThrow(
      refused("variables are not allowed"),
    );
    expect(() => assertAllowed(raw("a: posts(selector: {new: {}}, limit: 5) { results { _id mutation } }"))).toThrow(
      refused("only queries are allowed"),
    );
    expect(custom("GetUserBySlug", { slug: str("a$b mutation") }, { select: "{ _id slug }" })).not.toThrow();
  });

  it("Q17 R5 allowNull only on post, comment and sequence", () => {
    const single = (root: string, allowNull?: true) =>
      build({ root, view: undefined, terms: { _id: idLit(AGI) }, limit: undefined, allowNull, select: "{ result { _id } }" });
    expect(single("user", true)).toThrow(refused("allowNull on user"));
    expect(single("tag", true)).toThrow(refused("allowNull on tag"));
    for (const r of ["post", "comment", "sequence"]) expect(single(r, true)).not.toThrow();
    expect(single("user")).not.toThrow();
  });

  it("Q84 R6 a non-null root must be isolated", () => {
    expect(custom("TagsByCoreTagId", { coreTagId: idLit("sYm3HiWcfZvrGu3ui"), limit: int(500) })).toThrow(
      refused("non-null root TagsByCoreTagId must be isolated"),
    );
    expect(custom("TagsByCoreTagId", { coreTagId: idLit("sYm3HiWcfZvrGu3ui"), limit: int(500) }, { isolate: true })).not.toThrow();
    expect(custom("AllTagsActivityFeed", { limit: int(10) })).toThrow(refused("non-null root AllTagsActivityFeed must be isolated"));
  });

  it("R8 Q19 af is never sent to RecentDiscussionFeed", () => {
    expect(custom("RecentDiscussionFeed", { limit: int(5), af: bool(true) }, { isolate: true })).toThrow(
      refused("af on RecentDiscussionFeed"),
    );
  });

  it("R4 Q74 no sortBy on topShortform; Q8 sortedBy and sortBy only from the closed sets", () => {
    expect(build({ root: "comments", view: "topShortform", terms: { sortBy: str("top") } })).toThrow(refused("sortBy on topShortform"));
    const userPosts = (sortedBy: string) => build({ view: "userPosts", terms: { userId: idLit("nmk3nLpQE89dMRzzN"), sortedBy: str(sortedBy) } });
    expect(userPosts("relevance")).toThrow(refused('sortedBy "relevance" not allowed on posts.userPosts'));
    expect(userPosts("magic")).toThrow(refused('sortedBy "magic" not allowed on posts.userPosts'));
    for (const s of ["new", "old", "top", "recentComments"]) expect(userPosts(s)).not.toThrow();
    const required = obj({ tags: list([obj({ tagId: idLit("56yXXrcxRjrQs6z9R"), filterMode: str("Required") })]) });
    expect(build({ view: "tagRelevance", terms: { tagId: idLit("56yXXrcxRjrQs6z9R"), sortedBy: str("relevance"), filterSettings: required } })).not.toThrow();
    expect(build({ root: "comments", view: "allRecentComments", terms: { sortBy: str("magic") } })).toThrow(
      refused('sortBy "magic" not allowed on comments.allRecentComments'),
    );
  });

  it("R3 Q9 a view that takes an id refuses to be built without it; an empty id list is never sent", () => {
    expect(build({ root: "chapters", view: "SequenceChapters", terms: {}, publicSubject: "sequence" })).toThrow(
      refused("missing sequenceId on chapters.SequenceChapters"),
    );
    expect(build({ view: "default", terms: { exactPostIds: list([]) } })).toThrow(refused("empty id list exactPostIds"));
    expect(build({ root: "comments", view: "default", terms: {} })).toThrow(refused("missing commentIds on comments.default"));
    expect(build({ root: "post", view: undefined, terms: {}, limit: undefined, allowNull: true, select: "{ result { _id } }" })).toThrow(
      refused("missing _id on post"),
    );
    expect(custom("GetUserBySlug", {}, { select: "{ _id }" })).toThrow(refused("missing slug on GetUserBySlug"));
  });

  it("R7 tagRelevance carries the Required filter; revisionsOnDocument names its field; revisionsByUser takes only userId", () => {
    const tagId = idLit("56yXXrcxRjrQs6z9R");
    expect(build({ view: "tagRelevance", terms: { tagId } })).toThrow(refused("missing filterSettings on posts.tagRelevance"));
    const tagDefault = obj({ tags: list([obj({ tagId, filterMode: str("TagDefault") })]) });
    expect(build({ view: "tagRelevance", terms: { tagId, filterSettings: tagDefault } })).toThrow(
      refused("tagRelevance needs the Required tag filter"),
    );
    expect(build({ root: "revisions", view: "revisionsOnDocument", terms: { documentId: idLit(AGI) }, publicSubject: "doc" })).toThrow(
      refused("missing fieldName on revisions.revisionsOnDocument"),
    );
    expect(
      build({ root: "revisions", view: "revisionsByUser", terms: { userId: idLit("nmk3nLpQE89dMRzzN"), after: str("2024-01-01T00:00:00.000Z") } }),
    ).toThrow(refused("revisionsByUser takes only userId"));
  });

  it("P9 R8 moderation views and terms are never built; the allow-list also refuses views the deny-list does not name", () => {
    for (const [root, view] of [
      ["posts", "drafts"], ["posts", "all_drafts"], ["posts", "unlisted"], ["posts", "scheduled"], ["posts", "sunshineNewPosts"],
      ["comments", "rejected"], ["comments", "postCommentsDeleted"], ["comments", "allCommentsDeleted"], ["comments", "profileComments"],
      ["users", "LWSunshinesList"], ["users", "allUsers"], ["users", "usersMapLocations"],
    ])
      expect(build({ root, view })).toThrow(refused(`denied view ${view}`));
    expect(build({ root: "users", view: "reviewAdminUsers" })).toThrow(refused("view reviewAdminUsers is not allowed on users"));
    expect(build({ root: "comments", view: "allRecentComments", terms: { authorIsUnreviewed: bool(false) } })).toThrow(
      refused("denied term authorIsUnreviewed"),
    );
    expect(build({ root: "comments", view: "allRecentComments", terms: { includeRejected: bool(true) } })).toThrow(
      refused("denied term includeRejected"),
    );
  });

  it("R8 the denied arguments are refused", () => {
    expect(build({ args: { input: obj({}) } })).toThrow(refused("denied argument input"));
    expect(build({ args: { orderBy: obj({}) } })).toThrow(refused("denied argument orderBy"));
  });

  it("Q61 Q63 Q50.44 R8 denied roots and roots outside the allow-list are never built", () => {
    for (const r of DENIED_ROOTS) expect(custom(r, {})).toThrow(refused(`root ${r} is not allowed`));
    expect(custom("UltraFeed", { limit: int(5) })).toThrow(refused("root UltraFeed is not allowed"));
  });

  it("P10 Q57 enableTotal only on bounded selectors", () => {
    expect(build({ enableTotal: true })).toThrow(refused("enableTotal on an unbounded selector"));
    expect(build({ view: "default", terms: { exactPostIds: list([idLit(AGI)]) }, limit: 1, enableTotal: true })).toThrow(
      refused("enableTotal on an unbounded selector"),
    );
    expect(build({ view: "userPosts", terms: { userId: idLit("nmk3nLpQE89dMRzzN") }, enableTotal: true })).not.toThrow();
  });

  it.each([
    ["posts", "userPosts", { userId: '"x"' }, true],
    ["posts", "tagRelevance", { tagId: '"x"' }, true],
    ["posts", "curated", {}, true],
    ["posts", "pingbackPosts", { postId: '"x"' }, true],
    ["revisions", "revisionsOnDocument", { documentId: '"x"' }, true],
    ["revisions", "revisionsByUser", { userId: '"x"' }, true],
    ["comments", "allRecentComments", { userId: '"x"' }, true],
    ["comments", "allRecentComments", {}, false],
    ["comments", "topShortform", { userId: '"x"' }, true],
    ["comments", "topShortform", {}, false],
    ["sequences", "default", {}, true],
    ["sequences", "default", { sequenceIds: '["x"]' }, false],
    ["posts", "default", { exactPostIds: '["x"]' }, false],
    ["comments", "default", { commentIds: '["x"]' }, false],
    ["posts", "new", {}, false],
    ["posts", "magic", {}, false],
  ] as const)("P10 enableTotalAllowed(%s, %s, %j) is %s", (root, view, terms, expected) => {
    expect(enableTotalAllowed(root, view, terms)).toBe(expected);
  });

  it("P17 an excluded path needs the matching confirmed-public subject", () => {
    const shapes: Record<string, Partial<OpSpec>> = {
      "comments.postCommentsOld": { root: "comments", view: "postCommentsOld", terms: { postId: idLit(AGI) } },
      "comments.answersAndReplies": { root: "comments", view: "answersAndReplies", terms: { postId: idLit(AGI) } },
      "comments.debateResponses": { root: "comments", view: "debateResponses", terms: { postId: idLit(AGI) } },
      "comments.reviews": { root: "comments", view: "reviews", terms: { postId: idLit(AGI) } },
      "comments.tagDiscussionComments": { root: "comments", view: "tagDiscussionComments", terms: { tagId: idLit("56yXXrcxRjrQs6z9R") } },
      "revisions.revisionsOnDocument": { root: "revisions", view: "revisionsOnDocument", terms: { documentId: idLit(AGI), fieldName: str("contents") } },
      revision: { root: "revision", view: undefined, terms: { _id: idLit(AGI) }, limit: undefined, select: "{ result { _id } }" },
      "chapters.SequenceChapters": { root: "chapters", view: "SequenceChapters", terms: { sequenceId: idLit("5g5TkQTe9rmPS5vvM") } },
    };
    expect(Object.keys(shapes).sort()).toEqual(Object.keys(EXCLUDED_PATHS).sort());
    for (const [key, shape] of Object.entries(shapes)) {
      expect(build(shape)).toThrow(refused(`excluded path ${key} needs a confirmed-public subject`));
      expect(build({ ...shape, publicSubject: EXCLUDED_PATHS[key] })).not.toThrow();
    }
    expect(build({ ...shapes["comments.postCommentsOld"], publicSubject: "tag" })).toThrow(
      refused("excluded path comments.postCommentsOld needs a confirmed-public subject"),
    );
  });

  // One named test per field, ids written in the name itself.
  const deniedField = (field: string) => () => {
    expect(build({ root: "post", view: undefined, terms: { _id: idLit(AGI) }, limit: undefined, allowNull: true, select: `{ result { _id ${field} } }` })).toThrow(
      refused(`denied field ${field}`),
    );
  };
  it("Q77 Q50.17 R8 the field tableOfContents is refused by name", deniedField("tableOfContents"));
  it("Q77 R8 the field htmlBody is refused by name", deniedField("htmlBody"));
  it("Q94 R8 the field htmlHighlightStartingAtHash is refused by name", deniedField("htmlHighlightStartingAtHash"));
  it("Q123 R8 the field pageUrl is refused by name", deniedField("pageUrl"));
  it("Q123 R8 the field pageUrlRelative is refused by name", deniedField("pageUrlRelative"));
  it("Q50.24 R8 the field allVotes is refused by name", deniedField("allVotes"));
  it("Q50.24 R8 the field isBookmarked is refused by name", deniedField("isBookmarked"));
  it("Q104 Q50.34 R8 the field tagRel is refused by name", deniedField("tagRel"));
  it("P13 R8 the field username is refused by name", deniedField("username"));
  it("P13 R8 the field mapLocation is refused by name", deniedField("mapLocation"));
  it("P10 R8 the field sequenceCount is refused by name", deniedField("sequenceCount"));
  it("Q101 R8 the field prevPost is refused by name", deniedField("prevPost"));
  it("Q101 R8 the field canonicalNextPostSlug is refused by name", deniedField("canonicalNextPostSlug"));
  it("Q50.46 R8 the field usersWhoLiked is refused by name", deniedField("usersWhoLiked"));
});

describe("the lists against the forum schema (¶9.2)", () => {
  const q = forumSchema.getQueryType()!.getFields();
  const inputs = Object.values(forumSchema.getTypeMap()).filter(isInputObjectType);

  it("R8 R9 Q21 every allowed root and view, denied root, view and term, and DENIED_FIELDS pair exists in the forum schema", () => {
    for (const [root, views] of Object.entries(ALLOWED)) {
      expect(q[root], root).toBeDefined();
      if (views.length === 0) continue;
      const selector = getNamedType(q[root].args.find((a) => a.name === "selector")!.type) as GraphQLInputObjectType;
      for (const v of views) expect(Object.keys(selector.getFields()), `${root}.${v}`).toContain(v);
    }
    for (const r of DENIED_ROOTS) expect(q[r], r).toBeDefined();
    const views = new Set(inputs.filter((t) => t.name.endsWith("Selector")).flatMap((t) => Object.keys(t.getFields())));
    for (const v of DENIED_VIEWS) expect(views.has(v), v).toBe(true);
    expect([...views].some((v) => v.startsWith("sunshine"))).toBe(true);
    const terms = new Set(inputs.flatMap((t) => Object.keys(t.getFields())));
    for (const t of DENIED_TERMS) expect(terms.has(t), t).toBe(true);
    expect(DENIED_FIELDS).toHaveLength(76);
    expect(DENIED_FIELDS).toContain("Post.revisions");
    for (const pair of DENIED_FIELDS) {
      const [type, field] = pair.split(".");
      expect((forumSchema.getType(type) as GraphQLObjectType | undefined)?.getFields()[field], pair).toBeDefined();
    }
    expect(q.posts.args.map((a) => a.name)).not.toContain("input");
  });
});

describe("assertAllowed reads the op text itself", () => {
  const req = (text: string) => () => assertAllowed(raw(text));

  it("a root named like an Object.prototype member is outside the allow-list", () => {
    for (const r of ["constructor", "toString", "__proto__"]) expect(req(`a: ${r} { x }`)).toThrow(refused(`root ${r} is not allowed`));
  });

  it("text that is not `<alias>: <root>(<arguments>) <selection>` is refused rather than guessed at", () => {
    expect(req("")).toThrow(refused("unreadable operation"));
    expect(req("a:posts { x }")).toThrow(refused("unreadable operation"));
    expect(req("a: posts(selector: {new: {}}, limit: 5 { results { _id } }")).toThrow(refused("unreadable arguments"));
    expect(req("a: posts(selector: 5, limit: 5) { results { _id } }")).toThrow(refused("unreadable selector"));
    expect(req("a: posts(selector: {new: {}} x, limit: 5) { results { _id } }")).toThrow(refused("unreadable selector"));
  });

  it("brackets, commas, colons and field names inside a string literal are data, not syntax", () => {
    const user = `a: posts(selector: {userPosts: {userId: "a}, limit: {c", sortedBy: "new"}}, limit: 5) { results { _id } }`;
    expect(req(user)).not.toThrow();
    const field = `a: posts(selector: {new: {}}, limit: 5) { results { _id contents(version: "htmlBody, tagRel") { markdown } } }`;
    expect(req(field)).not.toThrow();
    expect(req(`a: GetUserBySlug(slug: "x\\" , limit: 9") { _id }`)).not.toThrow();
  });

  it("R7 a Required filter for another tag is not the tagRelevance filter, whichever way round its keys are written", () => {
    const view = (filter: string) =>
      `a: posts(selector: {tagRelevance: {tagId: "56yXXrcxRjrQs6z9R", filterSettings: {tags: [${filter}]}}}, limit: 5) { results { _id } }`;
    expect(req(view('{tagId: "aaaaaaaaaaaaaaaaa", filterMode: "Required"}'))).toThrow(refused("tagRelevance needs the Required tag filter"));
    expect(req(view('{filterMode: "Required", tagId: "56yXXrcxRjrQs6z9R"}'))).not.toThrow();
  });

  it("a sort term that is not a string literal is refused with its text", () => {
    const text = 'a: posts(selector: {userPosts: {userId: "nmk3nLpQE89dMRzzN", sortedBy: top}}, limit: 5) { results { _id } }';
    expect(req(text)).toThrow(refused('sortedBy "top" not allowed on posts.userPosts'));
  });

  it("P10 enableTotalAllowed counts a term whose value is undefined as absent, as obj() leaves it out of the text", () => {
    expect(enableTotalAllowed("comments", "allRecentComments", { userId: undefined })).toBe(false);
    expect(enableTotalAllowed("comments", "topShortform", { userId: undefined })).toBe(false);
    expect(enableTotalAllowed("sequences", "default", { sequenceIds: undefined })).toBe(true);
    expect(enableTotalAllowed("comments", "allRecentComments", { userId: undefined, other: '"x"' })).toBe(false);
  });

  it("enableTotal: false and allowNull: false ask for nothing", () => {
    expect(req("a: posts(selector: {new: {}}, limit: 5, enableTotal: false) { results { _id } }")).not.toThrow();
    expect(req('a: user(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: false) { result { _id } }')).not.toThrow();
  });
});
