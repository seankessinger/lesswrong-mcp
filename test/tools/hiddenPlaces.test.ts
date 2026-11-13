// The forum's API returns a comment's text even when a logged-out reader can't open the post or wiki page it sits on (a post moved
// back to draft, say). Every route that prints a comment is in this file, each given such a comment: none may show it. The one
// exception is a comment on an admin-only page: the site opens that page and its discussion, so the comment shows (#135).
import { describe, expect, it } from "vitest";
import { createHarness, expectClean } from "../support/harness";
import { A_COMMENTER, axelAfOnlyEntries, axelRef, forestEntries, gqlEntry, rawCommentLight, rawCommentList, rawCommentTree, rawPostRef, rawTagRef, searchEntry } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";

const ID = "hiddenPlaceCmnt01";
const TEXT = "PLANTEDHIDDENPLACE the whole text of the comment";
const POSTED = "2026-10-20T10:00:00.000Z";
const AXEL = axelRef();
const PERSON = { _id: "sampleCommenter01", slug: "sample-commenter", displayName: "Sample Commenter" };

const row = (o: Parameters<typeof rawCommentList>[0] = {}) => rawCommentList({
  _id: ID, postId: "draftPost00000001", post: null, tag: null, tagId: null, af: false, userId: A_COMMENTER._id, user: A_COMMENTER, postedAt: POSTED,
  extendedScore: null, baseScore: 3, voteCount: 2, afBaseScore: 0, contents: { markdown: `${TEXT}.`, wordCount: 9 }, ...o,
});
const light = (o: Parameters<typeof rawCommentLight>[0] = {}) => rawCommentLight({ _id: ID, af: false, postedAt: POSTED, baseScore: 3, userId: PERSON._id, ...o });
const byId = (r: ReturnType<typeof row>): FixtureEntry => gqlEntry({ root: "comment", id: ID }, { result: { ...r, afVoteCount: 0 } }, "test");
const hydrated = (r: ReturnType<typeof row>): FixtureEntry => gqlEntry({ root: "comments", view: "default", terms: { commentIds: [ID] } }, { results: [r] }, "test");
const hit = { objectID: ID, _id: ID, body: `Here zebra quokka is used. ${TEXT}`, postTitle: "PLANTED-HIDDEN-TITLE", postedAt: POSTED };

describe("a comment asked for by id", () => {
  const SHAPES: [string, Parameters<typeof row>[0]][] = [
    ["on a post the forum refuses", {}],
    ["on a rejected post", { post: { ...rawPostRef({ _id: "draftPost00000001", rejected: true }), debate: false } }],
    ["on a deleted wiki page", { postId: null, tagId: "deletedTag0000001" }],
    ["with no post and no wiki page", { postId: null }],
    ["a debate turn", { debateResponse: true }],
    ["an answer", { answer: true }],
    ["a quick take", { shortform: true }],
    ["a review", { reviewingForReview: "2023" }],
    ["anonymous", { hideAuthor: true, user: null }],
    ["by a deleted account", { user: null }],
    ["deleted, with a public reason", { deleted: true, deletedPublic: true, deletedReason: TEXT }],
  ];
  it.each(SHAPES)("%s reads like an unknown id", async (_, shape) => {
    for (const tool of ["get_comments", "get_reactions"] as const) {
      const h = createHarness({ extra: [byId(row(shape))] });
      expect((await h.call(tool, { comment: ID })).text).toBe(`Error (not_found): No publicly visible comment has the id "${ID}".`);
      expectClean(h);
    }
  });
});

describe("a comment on an admin-only wiki page, asked for by id", () => {
  // #135: the site opens an admin-only page from its URL (tagBySlug) and shows its comments on its discussion page
  // (TagDiscussionPage renders them whenever the page exists), so the comment opens here too, its page flagged.
  const ADMIN = "adminTag000000001";
  const admin = (o: Parameters<typeof rawTagRef>[0] = {}) => rawTagRef({ _id: ADMIN, name: "Admin Page", slug: "admin-page", adminOnly: true, ...o });
  const onAdmin = (o: Parameters<typeof rawTagRef>[0] = {}) =>
    row({ postId: null, tagId: ADMIN, tag: admin(o), contents: { markdown: "A comment on an admin-only page.", wordCount: 6 } });
  const forest = () => forestEntries({ tag: ADMIN }, [rawCommentTree({ _id: ID, tagId: ADMIN, postId: null, af: false, postedAt: POSTED, contents: { markdown: "A comment on an admin-only page.", wordCount: 6 } })]);
  const FLAGGED = 'on wiki page "Admin Page" (tag_slug admin-page, admin-only (left off posts and out of search))';
  it("opens in get_comments (its page's discussion) and in get_reactions, its page flagged", async () => {
    const h = createHarness({ extra: [byId(onAdmin()), ...forest()] });
    const comments = (await h.call("get_comments", { comment: ID })).text;
    expect(comments).toMatch(/^get_comments — /);
    expect(comments).toContain(`comment_id ${ID}`);
    expect(comments).toContain(FLAGGED);
    const reactions = (await h.call("get_reactions", { comment: ID })).text;
    expect(reactions).toMatch(/^get_reactions — /);
    expect(reactions).toContain(FLAGGED);
    expectClean(h);
  });
  it("one on an admin-only placeholder opens as one on any placeholder page does: its discussion page shows it", async () => {
    const h = createHarness({ extra: [byId(onAdmin({ isPlaceholderPage: true })), ...forest()] });
    const out = (await h.call("get_comments", { comment: ID })).text;
    expect(out).toContain(`comment_id ${ID}`);
    expect(out).toContain(FLAGGED);
  });
  it("a rejected comment on one still reads like an unknown id", async () => {
    const h = createHarness({ extra: [byId(row({ postId: null, tagId: ADMIN, tag: admin(), rejected: true }))] });
    expect((await h.call("get_comments", { comment: ID })).text).toBe(`Error (not_found): No publicly visible comment has the id "${ID}".`);
  });
});

describe("a route that lists comments", () => {
  const ROUTES: [string, string, Record<string, unknown>, FixtureEntry[]][] = [
    ["list_comments, site-wide", "list_comments", {}, [gqlEntry({ root: "comments", view: "allRecentComments" }, { results: [row()] }, "test")]],
    ["list_comments, by person", "list_comments", { user: PERSON.slug }, [gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: PERSON._id } }, { results: [row({ userId: PERSON._id, user: PERSON })], totalCount: 1 }, "test")]],
    ["list_comments, by person, top", "list_comments", { user: PERSON.slug, sort: "top" }, [
      gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: PERSON._id, sortBy: "new" } }, { results: [light()], totalCount: 1 }, "test"),
      hydrated(row({ userId: PERSON._id, user: PERSON }))]],
    ["list_comments, af_only", "list_comments", { af_only: true }, [
      gqlEntry({ root: "comments", view: "allRecentComments" }, { results: [light({ af: true })] }, "test"), hydrated(row({ af: true }))]],
    ["list_comments, quick takes", "list_comments", { quick_takes_only: true, user: PERSON.slug }, [
      gqlEntry({ root: "comments", view: "topShortform" }, { results: [light()], totalCount: 1 }, "test"),
      hydrated(row({ userId: PERSON._id, user: PERSON, shortform: true }))]],
    ["get_user", "get_user", { user: AXEL.slug, limit: 3 }, [gqlEntry({ root: "comments", view: "allRecentComments", terms: { userId: AXEL._id, sortBy: "new" } }, { results: [row({ userId: AXEL._id, user: AXEL })] }, "test")]],
    ["get_user, af_only", "get_user", { user: AXEL.slug, limit: 3, af_only: true }, [
      gqlEntry({ root: "comments", view: "default", terms: { commentIds: ["AxelLight00000002"] } }, { results: [row({ _id: "AxelLight00000002", af: true, afBaseScore: 4, userId: AXEL._id, user: AXEL })] }, "test"),
      ...axelAfOnlyEntries()]],
    ["get_feed, popular_comments", "get_feed", { feed: "popular_comments" }, [gqlEntry({ root: "PopularComments" }, { results: [row()] }, "test")]],
    ["get_feed, quick_takes", "get_feed", { feed: "quick_takes" }, [gqlEntry({ root: "comments", view: "shortformFrontpage" }, { results: [row({ shortform: true })] }, "test")]],
    ["search", "search", { kind: "comment", query: "zebra quokka" }, [searchEntry({ index: "comments" }, { hits: [hit], nbHits: 1 }, "test"), byId(row())]],
    ["first_use", "first_use", { forms: ["zebra quokka"], include_comments: true, limit: 5 }, [
      searchEntry({ index: "posts_oldest_first" }, { hits: [], nbHits: 0 }, "test"), searchEntry({ index: "comments_oldest_first" }, { hits: [hit], nbHits: 1 }, "test"), byId(row())]],
  ];
  it.each(ROUTES)("%s leaves out a comment on a hidden post", async (_, tool, args, extra) => {
    const h = createHarness({ extra });
    const out = await h.call(tool as never, args);
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/PLANTEDHIDDENPLACE|PLANTED-HIDDEN-TITLE|hiddenPlaceCmnt01|AxelLight00000002|draftPost00000001/);
    expect(out.text).not.toContain("on a post that is not publicly visible");
    expectClean(h);
  });
});
