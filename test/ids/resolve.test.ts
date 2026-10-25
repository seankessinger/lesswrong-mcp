import { describe, it, expect, vi } from "vitest";
import { resolve, resolutionOps, readResolution, cachedResolution, rememberResolution, collectionResolved, echoOf, resolvedFrom } from "../../src/ids/resolve";
import { parseRef } from "../../src/ids/parse";
import { createCallContext } from "../../src/call/context";
import { errorText } from "../../src/render/messages";
import { documentFor } from "../../src/forum/templates/op";
import { createFakeForum } from "../fakeForum";
import { loadFamilies, type FixtureEntry } from "../support/fixtures";
import { gqlEntry, rawMdocRef, rawPostCard, rawPostRef, rawTagFull, rawTagRef } from "../support/builders";
import { servicesFor } from "../support/services";
import { createClock } from "../support/clock";
import type { EntityKind, ParsedRef, ToolName } from "../../src/types";

const ref = (kind: EntityKind, form: ParsedRef["form"], value: string, given: ParsedRef["given"] = "id"): ParsedRef =>
  ({ kind, form, value, given, notes: [] });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `extra` entries are matched before the five families (the fake forum answers with the first match). */
function setup(extra: FixtureEntry[] = []) {
  const clock = createClock("2026-10-22T12:00:00.000Z");
  const forum = createFakeForum({ fixtures: [...extra, ...loadFamilies("posts", "comments", "users", "tags", "sequences")] });
  const svc = servicesFor(forum, { clock });
  const ctx = (tool: ToolName = "get_post") => createCallContext(tool, { now: clock.now });
  const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return errorText(e as never); } throw new Error("no error"); };
  return { clock, forum, svc, ctx, fail };
}

describe("resolve: posts", () => {
  it("Q82 a post id resolves in one request; the echo names title and author; P17 confirmed", async () => {
    const { forum, svc, ctx } = setup(); const c = ctx();
    const r = await resolve(ref("post", "id", "uMQ3cqWDPHhjtiesc"), "post", c, svc);
    expect(forum.requests).toHaveLength(1);
    expect(forum.requests[0].body).toContain('post(selector: {_id: \\"uMQ3cqWDPHhjtiesc\\"}, allowNull: true)');
    expect(r).toMatchObject({ kind: "post", id: "uMQ3cqWDPHhjtiesc", slug: "agi-ruin-a-list-of-lethalities", af: true });
    expect(echoOf("post", r)).toBe('post → "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc) by "Eliezer Yudkowsky"');
    expect(c.isConfirmed("post", "uMQ3cqWDPHhjtiesc")).toBe(true);
    expect(c.isConfirmed("doc", "uMQ3cqWDPHhjtiesc")).toBe(true);
  });
  it("P17 a second call is answered from the resolution cache and still confirms public", async () => {
    const { forum, svc, ctx } = setup();
    await resolve(ref("post", "id", "uMQ3cqWDPHhjtiesc"), "post", ctx(), svc);
    const c2 = ctx();
    expect((await resolve(ref("post", "id", "uMQ3cqWDPHhjtiesc"), "post", c2, svc)).id).toBe("uMQ3cqWDPHhjtiesc");
    expect(forum.requests).toHaveLength(1);
    expect(c2.isConfirmed("post", "uMQ3cqWDPHhjtiesc")).toBe(true);
    // Q88 P3: a post is cached under its input and id only; its slug is the forum's to map (two posts may share it)
    expect(cachedResolution(ref("post", "slug", "agi-ruin-a-list-of-lethalities", "slug"), ctx(), svc)).toBeUndefined();
  });
  it("a bare 17-character string is tried as id and as slug in one request; the id wins", async () => {
    const { forum, svc, ctx } = setup();
    const r = await resolve(ref("post", "idOrSlug", "uMQ3cqWDPHhjtiesc"), "post", ctx(), svc);
    expect(r.id).toBe("uMQ3cqWDPHhjtiesc");
    expect(forum.requests).toHaveLength(1);
    expect(forum.requests[0].body).toContain('slugPost: {slug: \\"uMQ3cqWDPHhjtiesc\\"}');
  });
  it("Q88 a slug held by two posts is bad_input listing both", async () => {
    const { svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("post", "slug", "duplicate-slug", "slug"), "post", ctx(), svc))).toBe(
      'Error (bad_input): post: the slug "duplicate-slug" names 2 posts: "Duplicate A" (post_id dupSlugPostA00001) and "Duplicate B" (post_id dupSlugPostB00001). Pass the post_id you mean.');
  });
  it("P2 Q88 a slug shared with a hidden post resolves to the public one in one request, with no two-posts error, and the hidden twin shows nowhere", async () => {
    const { forum, svc, ctx } = setup([
      gqlEntry({ root: "posts", view: "slugPost", terms: { slug: "twin-slug" }, limit: 2 }, { results: [
        rawPostRef({ _id: "twinRejected00001", title: "Twin (rejected)", slug: "twin-slug", rejected: true }),
        rawPostRef({ _id: "twinPublic0000001", title: "Twin", slug: "twin-slug" }),
      ] }, "§6.2"),
    ]);
    const r = await resolve(ref("post", "slug", "twin-slug", "slug"), "post", ctx(), svc);
    expect([r.id, r.name, forum.requests.length]).toEqual(["twinPublic0000001", "Twin", 1]);
    expect(JSON.stringify({ ...r, doc: undefined })).not.toContain("twinRejected00001");
  });
  it("P2 a rejected post reads exactly like an unknown id, and the response is evicted", async () => {
    const { svc, ctx, fail } = setup(); const c = ctx();
    const evict = vi.spyOn(svc, "evictResponses");
    expect(await fail(resolve(ref("post", "id", "rejectedPost00001"), "post", c, svc))).toBe(
      'Error (not_found): No publicly visible post has the id "rejectedPost00001".');
    expect(evict).toHaveBeenCalledWith(c.cacheKeys);
    expect(await fail(resolve(ref("post", "id", "AAAAAAAAAAAAAAAAA"), "post", ctx(), svc))).toBe(
      'Error (not_found): No publicly visible post has the id "AAAAAAAAAAAAAAAAA".');
    expect(await fail(resolve(ref("post", "slug", "rejected-post", "slug"), "post", ctx(), svc))).toBe(
      'Error (not_found): No publicly visible post has the slug "rejected-post". Renamed posts lose their earlier slugs; the id in a URL always works.');
  });
  it("¶8 a bare 17-character string found as neither id nor slug is not_found in the slug form with the find hint; a hidden one reads the same (D1)", async () => {
    const { svc, ctx, fail } = setup([
      gqlEntry({ root: "user", id: "NoSuchUser0000001" }, { result: null }, "§3.2"),
      gqlEntry({ root: "GetUserBySlug", args: { slug: "NoSuchUser0000001" } }, null, "§3.2"),
    ]);
    const post = (x: string) =>
      `Error (not_found): No publicly visible post has the slug "${x}". Slugs are case-sensitive; to look up a name use find {items: [{kind: "post", query: "${x}"}]}. Renamed posts lose their earlier slugs; the id in a URL always works.`;
    // the id form keeps the id wording (the caller said it was an id); checked first, since the negative cache keys by kind and value
    expect(await fail(resolve(ref("post", "id", "AAAAAAAAAAAAAAAAA"), "post", ctx(), svc))).toBe('Error (not_found): No publicly visible post has the id "AAAAAAAAAAAAAAAAA".');
    svc.caches.delete("negative", "post:AAAAAAAAAAAAAAAAA");
    expect(await fail(resolve(ref("post", "idOrSlug", "AAAAAAAAAAAAAAAAA"), "post", ctx(), svc))).toBe(post("AAAAAAAAAAAAAAAAA"));
    expect(await fail(resolve(ref("post", "idOrSlug", "rejectedPost00001"), "post", ctx(), svc))).toBe(post("rejectedPost00001"));
    expect(await fail(resolve(ref("tag", "idOrSlug", "adminOnlyTag00001"), "tag", ctx("list_posts"), svc))).toBe(
      'Error (not_found): No publicly visible wiki page has the slug "adminOnlyTag00001". Slugs are case-sensitive; to look up a name use find {items: [{kind: "tag", query: "adminOnlyTag00001"}]}.');
    expect(await fail(resolve(ref("user", "idOrSlug", "NoSuchUser0000001"), "user", ctx("get_user"), svc))).toBe(
      'Error (not_found): No publicly visible user has the slug "NoSuchUser0000001". Slugs are case-sensitive; to look up a name use find {items: [{kind: "user", query: "NoSuchUser0000001"}]}.');
  });
  it("Q82 not_public only for the forum's own refusal", async () => {
    const { svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("post", "id", "draftPost00000001"), "post", ctx(), svc))).toBe(
      'Error (not_public): The forum refuses to show the post with the id "draftPost00000001" to logged-out readers: it is a post that is not publicly visible. Its content can\'t be shown.');
  });
  it("Q92 a logged-in-only post gives login_only", async () => {
    const { svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("post", "id", "loginOnlyPost0001"), "post", ctx(), svc))).toBe(
      "Error (login_only): This post is only visible to logged-in users; this server reads the forums logged out.");
  });
  it("negative cache: not_found is remembered for 5 minutes, then asked again", async () => {
    const { forum, clock, svc, ctx } = setup();
    for (let i = 0; i < 2; i++) await resolve(ref("post", "id", "AAAAAAAAAAAAAAAAA"), "post", ctx(), svc).catch(() => 0);
    expect(forum.requests).toHaveLength(1);
    clock.advance(300_001);
    await resolve(ref("post", "id", "AAAAAAAAAAAAAAAAA"), "post", ctx(), svc).catch(() => 0);
    expect(forum.requests).toHaveLength(2);
  });
  it("P3 an unlisted post resolves by id, flagged in the echo", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("post", "id", "unlistedPost00001"), "post", ctx(), svc);
    expect(r.notes).toContain("reachable by link only");
  });
  it("P7 an anonymous post's echo names no author", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("post", "id", "anonPost000000001"), "post", ctx(), svc);
    expect(r.display).toMatch(/\(post_id anonPost000000001\) by author not publicly visible$/);
    expect(r.display).not.toMatch(/PLANTED|anon-author|anonAuthorUser001/);
  });
  it("Q90 an LW1 URL resolves through legacyIdPost with limit 1", async () => {
    const { forum, svc, ctx } = setup();
    const r = await resolve(parseRef("post", "https://www.lesswrong.com/lw/g/some_title/", ["post"]), "post", ctx(), svc);
    expect(r.id).toBe("lw1Post0000000016");
    expect(forum.requests[0].body).toContain('legacyIdPost: {legacyId: \\"g\\"}}, limit: 1)');
  });
});

describe("resolve: comments", () => {
  it("P5 P6 P2 hidden comments read like unknown ids", async () => {
    const { svc, ctx, fail } = setup();
    for (const id of ["privDeletedCmnt01", "rejectedCmnt00001", "unrevAfterCmnt001"])
      expect(await fail(resolve(ref("comment", "id", id), "comment", ctx("get_comments"), svc))).toBe(
        `Error (not_found): No publicly visible comment has the id "${id}".`);
    expect((await resolve(ref("comment", "id", "unrevBeforeCmnt01"), "comment", ctx("get_comments"), svc)).id).toBe("unrevBeforeCmnt01");
  });
  it("P1 a comment on a hidden post resolves; the post is unnamed", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("comment", "id", "onHiddenPostCmnt1"), "comment", ctx("get_comments"), svc);
    expect(r.display).toContain("on a post that is not publicly visible");
    expect(r.display).not.toContain("draftPost00000001");
  });
  it("P17 a comment's public post join confirms the post", async () => {
    const { svc, ctx } = setup(); const c = ctx("get_comments");
    const r = await resolve(ref("comment", "id", "HRDoDnHv8bvoW7oPZ"), "comment", c, svc);
    expect(r.display).toBe('comment_id HRDoDnHv8bvoW7oPZ (AF) by "paulfchristiano" (user_slug paulfchristiano) on "AGI Ruin: A List of Lethalities" (post_id uMQ3cqWDPHhjtiesc, AF)');
    expect(c.isConfirmed("post", "uMQ3cqWDPHhjtiesc")).toBe(true);
    expect(c.isConfirmed("comment", "HRDoDnHv8bvoW7oPZ")).toBe(true);
  });
  it("P1 a wiki-discussion comment is placed by tagId first", async () => {
    const { svc, ctx } = setup(); const c = ctx("get_comments");
    const r = await resolve(ref("comment", "id", "wikiDiscussCmnt01"), "comment", c, svc);
    expect(r.display).toContain('on wiki page "AI" (tag_slug ai)');
    expect(c.isConfirmed("tag", "sYm3HiWcfZvrGu3ui")).toBe(true);
  });
  it("Q90 an LW1 comment resolves through legacyIdComment on the LW host", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(parseRef("comment", "https://www.lesswrong.com/lw/g/some_title/109", ["comment"]), "comment", ctx("get_comments"), svc);
    expect(r.id).toBe("KXduPDa5T9qJfs4vL");
  });
});

describe("resolve: users", () => {
  it("Q89 the echo shows who a slug resolved to, with karma", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("user", "slug", "eliezer_yudkowsky", "slug"), "user", ctx("get_user"), svc);
    expect(echoOf("user", r)).toBe('user → "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky, user_id nmk3nLpQE89dMRzzN, karma 170,469)');
  });
  it("Q50.47 P13 no old slug is shown", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("user", "slug", "quietfen", "slug"), "user", ctx("get_user"), svc);
    expect(r.notes).toEqual([]);
    expect(echoOf("user", r)).toBe('user → "Larkmoor" (user_slug lark-moor, user_id larkMoorUser00001, karma 1,500)');
  });
  it("Q89 a wrong-case slug is not_found with the case hint", async () => {
    const { svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("user", "slug", "Eliezer_Yudkowsky", "slug"), "user", ctx("get_user"), svc))).toBe(
      'Error (not_found): No publicly visible user has the slug "Eliezer_Yudkowsky". Slugs are case-sensitive; to look up a name use find {items: [{kind: "user", query: "Eliezer_Yudkowsky"}]}.');
  });
  it("P8 a deleted account by id is not_public; user ids are looked up without allowNull", async () => {
    const { forum, svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("user", "id", "deletedUser000001"), "user", ctx("get_user"), svc))).toBe(
      'Error (not_public): The forum refuses to show the user with the id "deletedUser000001" to logged-out readers: it is a user that is not publicly visible. Its content can\'t be shown.');
    expect(forum.requests[0].body).toContain('user(selector: {_id: \\"deletedUser000001\\"}) {');
  });
});

describe("resolve: tags, lenses and summaries", () => {
  it("a tag slug is resolved with tagBySlug and TagPreview in one request", async () => {
    const { forum, svc, ctx } = setup();
    const r = await resolve(ref("tag", "slug", "interpretability-ml-and-ai", "slug"), "tag", ctx("get_tag"), svc);
    expect(forum.requests).toHaveLength(1);
    expect(forum.requests[0].body).toContain("tagBySlug");
    expect(forum.requests[0].body).toContain("TagPreview(slug: ");
    expect(echoOf("tag", r)).toBe('tag → "Interpretability (ML & AI)" (tag_slug interpretability-ml-and-ai, tag_id 56yXXrcxRjrQs6z9R)');
  });
  it("an old tag slug resolves to the page, echoed by its current slug", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("tag", "slug", "bayes_rule", "slug"), "tag", ctx("get_tag"), svc);
    expect(r.id).toBe("RkznxXmmh9b5ovdSq");
    expect(r.notes).toEqual([]);
    expect(echoOf("tag", r)).toBe('tag → "Bayes\' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq)');
  });
  it("P12 P17 a lens slug stands for its page; the echo says so; both are confirmed", async () => {
    const { svc, ctx } = setup(); const c = ctx("get_tag");
    const r = await resolve(ref("tag", "slug", "bayes-rule-guide", "slug"), "tag", c, svc);
    expect(r).toMatchObject({ kind: "lens", id: "BayesGuideLens001", pageId: "RkznxXmmh9b5ovdSq" });
    expect(r.notes).toContain('lens bayes-rule-guide → page "Bayes\' rule"');
    expect(c.isConfirmed("doc", "BayesGuideLens001")).toBe(true);
    expect(c.isConfirmed("tag", "RkznxXmmh9b5ovdSq")).toBe(true);
  });
  it("¶3.1.2 a tool that opens the lens itself echoes the lens as what was opened, not as standing for its page", async () => {
    const { svc, ctx } = setup();
    const r = await resolve(ref("tag", "slug", "bayes-rule-guide", "slug"), "tag", ctx("get_tag"), svc);
    const page = 'tag → "Bayes\' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq)';
    expect(echoOf("tag", r)).toBe(`${page} · lens bayes-rule-guide → page "Bayes' rule"`);
    expect(echoOf("tag", r, { opens: "part" })).toBe(`${page} · lens_slug bayes-rule-guide of page "Bayes' rule"`);
    expect(echoOf("tag", r, { opens: "lens" })).toBe(`${page} · lens_slug bayes-rule-guide of page "Bayes' rule"`);
    // the parse notes stay in front of it
    const withNote = { ...r, notes: ["a parse note", ...r.notes] };
    expect(echoOf("tag", withNote, { opens: "part" })).toBe(`${page} · a parse note · lens_slug bayes-rule-guide of page "Bayes' rule"`);
    // a page without a part is echoed the same whatever the tool opens
    const tag = await resolve(ref("tag", "slug", "bayes-rule", "slug"), "tag", ctx("get_tag"), svc);
    expect(echoOf("tag", tag, { opens: "part" })).toBe(echoOf("tag", tag));
  });
  it("a tag id is looked up with tag and multiDocument in one request; a lens id finds the lens", async () => {
    const { forum, svc, ctx } = setup();
    expect((await resolve(ref("tag", "id", "56yXXrcxRjrQs6z9R"), "tag", ctx("get_tag"), svc)).kind).toBe("tag");
    expect((await resolve(ref("tag", "id", "BayesGuideLens001"), "tag", ctx("get_tag"), svc)).kind).toBe("lens");
    expect(forum.requests).toHaveLength(2);
    expect(forum.requests[1].body).toContain("multiDocument(selector: ");
  });
  it("P12 hidden pages and lenses read not_found; a deleted page is not_public", async () => {
    const { svc, ctx, fail } = setup();
    expect(await fail(resolve(ref("tag", "id", "adminOnlyTag00001"), "tag", ctx("get_tag"), svc))).toBe('Error (not_found): No publicly visible wiki page has the id "adminOnlyTag00001".');
    expect(await fail(resolve(ref("tag", "slug", "admin-only-tag", "slug"), "tag", ctx("get_tag"), svc))).toBe('Error (not_found): No publicly visible wiki page has the slug "admin-only-tag".');
    expect(await fail(resolve(ref("tag", "id", "orphanLens0000001"), "tag", ctx("get_tag"), svc))).toBe('Error (not_found): No publicly visible wiki page has the id "orphanLens0000001".');
    expect(await fail(resolve(ref("tag", "id", "deletedTag0000001"), "tag", ctx("get_tag"), svc))).toBe(
      'Error (not_public): The forum refuses to show the wiki page with the id "deletedTag0000001" to logged-out readers: it is a wiki page that is not publicly visible. Its content can\'t be shown.');
  });
});

describe("resolve: sequences and collections", () => {
  it("P4 a sequence resolves; a hidden one is flagged; a deleted one is not_public", async () => {
    const { svc, ctx, fail } = setup();
    expect(echoOf("sequence", await resolve(ref("sequence", "id", "5g5TkQTe9rmPS5vvM"), "sequence", ctx("get_sequence"), svc)))
      .toBe('sequence → "Predictably Wrong" (sequence_id 5g5TkQTe9rmPS5vvM)');
    expect((await resolve(ref("sequence", "id", "hiddenSeq00000001"), "sequence", ctx("get_sequence"), svc)).notes)
      .toContain("not in the site's sequence lists");
    expect(await fail(resolve(ref("sequence", "id", "deletedSeq0000001"), "sequence", ctx("get_sequence"), svc))).toBe(
      'Error (not_public): The forum refuses to show the sequence with the id "deletedSeq0000001" to logged-out readers: it is a sequence that is not publicly visible. Its content can\'t be shown.');
  });
  it("collections resolve to their hard-coded ids with no request", async () => {
    const { forum, svc, ctx } = setup();
    expect(collectionResolved("rationality")).toMatchObject({ kind: "collection", id: "oneQyj4pw77ynzwAF", slug: "rationality", display: "collection_slug rationality" });
    expect((await resolve(ref("sequence", "collection", "bestoflesswrong", "slug"), "sequence", ctx("get_sequence"), svc)).id).toBe("nmk3nLpQE89dMRzzN");
    expect(forum.requests).toHaveLength(0);
  });
});

describe("resolutionOps and readResolution compose into other requests", () => {
  it("aliases are the prefix plus the bare resolution aliases (p, s, l, c, u, i, t, m, a, b)", () => {
    expect(resolutionOps(ref("post", "id", "uMQ3cqWDPHhjtiesc"), "", { post: "...POST_FULL" }).map((o) => o.text)).toEqual([
      'p: post(selector: {_id: "uMQ3cqWDPHhjtiesc"}, allowNull: true) { result { ...POST_FULL } }']);
    expect(resolutionOps(ref("tag", "idOrSlug", "RkznxXmmh9b5ovdSq"), "r2").map((o) => o.alias)).toEqual(["r2t", "r2m", "r2a", "r2b"]);
    expect(documentFor("resolve_tag_by_slug", resolutionOps(ref("tag", "slug", "bayes-rule", "slug"), ""))).toMatch(new RegExp("^" + escapeRe(
      'query resolve_tag_by_slug { a: tags(selector: {tagBySlug: {slug: "bayes-rule"}}, limit: 1) { results { ...TAG_CARD } } b: TagPreview(slug: "bayes-rule") { tag { ...TAG_CARD } lens { ...MDOC_REF } summaries { _id deleted tabTitle } } }')));
    expect(resolutionOps(ref("sequence", "collection", "rationality", "slug"), "")).toEqual([]);
  });
  it("readResolution reads one prefix's aliases out of a combined answer", async () => {
    const { svc, ctx } = setup(); const c = ctx("find");
    const r1 = ref("post", "id", "uMQ3cqWDPHhjtiesc"), r2 = ref("user", "slug", "eliezer_yudkowsky", "slug");
    const res = await svc.gql([...resolutionOps(r1, "r1"), ...resolutionOps(r2, "r2")], c, "resolving");
    expect(readResolution(r1, "post", "r1", res, c, svc).id).toBe("uMQ3cqWDPHhjtiesc");
    expect(readResolution(r2, "user", "r2", res, c, svc).id).toBe("nmk3nLpQE89dMRzzN");
  });
  it("rememberResolution and resolvedFrom feed the cache for later calls", () => {
    const { svc, ctx } = setup();
    const r = resolvedFrom("user", { _id: "paulfchristianoId", slug: "paulfchristiano", displayName: "paulfchristiano", karma: 30100 });
    expect(r.display).toBe('"paulfchristiano" (user_slug paulfchristiano, user_id paulfchristianoId, karma 30,100)');
    rememberResolution("user", "paulfchristiano", r, svc);
    expect(cachedResolution(ref("user", "slug", "paulfchristiano", "slug"), ctx("get_comments"), svc)?.id).toBe("paulfchristianoId");
  });
});

describe("resolution details: caches, hidden parts and error wording", () => {
  const BAYES = { _id: "RkznxXmmh9b5ovdSq", name: "Bayes' rule", slug: "bayes-rule", wikiOnly: true };
  const missing = (root: string, id: string): FixtureEntry => ({ source: "§10.2", match: { root, id }, error: { message: "app.missing_document" } });

  it("P13 the parse notes belong to the input: the cache answers the current slug and the id without them", async () => {
    const { forum, svc, ctx } = setup();
    const old = { ...ref("user", "slug", "quietfen", "slug"), notes: ["surrounding punctuation ignored"] };
    expect((await resolve(old, "user", ctx("get_user"), svc)).notes).toEqual(["surrounding punctuation ignored"]);
    expect((await resolve(ref("user", "slug", "lark-moor", "slug"), "user", ctx("get_user"), svc)).notes).toEqual([]);
    expect((await resolve(ref("user", "id", "larkMoorUser00001"), "user", ctx("get_user"), svc)).notes).toEqual([]);
    expect((await resolve(ref("user", "slug", "quietfen", "slug"), "user", ctx("get_user"), svc)).notes).toEqual([]);
    expect(forum.requests).toHaveLength(1);
  });
  it("Q82 a refused subject is remembered for 5 minutes too; a comment the forum refuses is a draft and reads like an unknown id", async () => {
    const { forum, svc, ctx, fail } = setup([{ source: "§8.3", match: { root: "comment", id: "draftCmnt00000001" }, error: { message: "app.operation_not_allowed" } }]);
    for (let i = 0; i < 2; i++) await resolve(ref("post", "id", "draftPost00000001"), "post", ctx(), svc).catch(() => 0);
    expect(forum.requests).toHaveLength(1);
    expect(await fail(resolve(ref("comment", "id", "draftCmnt00000001"), "comment", ctx("get_comments"), svc))).toBe(
      'Error (not_found): No publicly visible comment has the id "draftCmnt00000001".');
  });
  it("Q82 a later success clears the remembered not_found, whichever route found it", async () => {
    const { svc, ctx } = setup();
    const unknown = ref("post", "id", "AAAAAAAAAAAAAAAAA");
    await resolve(unknown, "post", ctx(), svc).catch(() => 0);
    const answer = new Map([["p", { data: { result: rawPostRef({ _id: "AAAAAAAAAAAAAAAAA", title: "Now Public" }) } }]]);
    readResolution(unknown, "post", "", answer, ctx(), svc);
    expect((await resolve(unknown, "post", ctx(), svc)).name).toBe("Now Public");
    const wrongCase = ref("user", "slug", "Eliezer_Yudkowsky", "slug");
    await resolve(wrongCase, "user", ctx("get_user"), svc).catch(() => 0);
    rememberResolution("user", "Eliezer_Yudkowsky", resolvedFrom("user", { _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }), svc);
    expect((await resolve(wrongCase, "user", ctx("get_user"), svc)).id).toBe("nmk3nLpQE89dMRzzN");
  });
  it("Q82 Q83 an alias error resolution can't explain keeps its ¶3.9 wording and is not remembered", async () => {
    const { forum, svc, ctx, fail } = setup([
      { source: "§4.8", match: { root: "post", id: "brokenPost0000001" }, error: { message: "Cannot return null for non-nullable field Post.title" } },
      { source: "§4.8", match: { root: "post", id: "flakyPost00000001" }, error: { message: "Something went wrong" } },
    ]);
    expect(await fail(resolve(ref("post", "id", "brokenPost0000001"), "post", ctx(), svc))).toBe(
      "Error (internal): Unexpected failure in get_post (post_by_id: Cannot return null for non-nullable field Post.title). Please report this.");
    expect(await fail(resolve(ref("post", "id", "flakyPost00000001"), "post", ctx(), svc))).toBe(
      "Error (forum_error): The forum returned an error while resolving post (Something went wrong). Try again later.");
    await resolve(ref("post", "id", "flakyPost00000001"), "post", ctx(), svc).catch(() => 0);
    expect(forum.requests).toHaveLength(3);
  });
  it("P1 P17 a comment's hidden post join confirms nothing and is cached without it: the second call costs no request and confirms the comment alone", async () => {
    const { forum, svc, ctx } = setup(); const c = ctx("get_comments");
    await resolve(ref("comment", "id", "onHiddenPostCmnt1"), "comment", c, svc);
    expect(c.isConfirmed("comment", "onHiddenPostCmnt1")).toBe(true);
    expect(c.isConfirmed("post", "draftPost00000001")).toBe(false);
    const c2 = ctx("get_comments");
    expect((await resolve(ref("comment", "id", "onHiddenPostCmnt1"), "comment", c2, svc)).id).toBe("onHiddenPostCmnt1");
    expect(forum.requests).toHaveLength(1);
    expect(c2.isConfirmed("comment", "onHiddenPostCmnt1")).toBe(true);
    expect(c2.isConfirmed("post", "draftPost00000001")).toBe(false);
  });
  it("P12 a lens that TagPreview names but these rules hide reads not_found, never as its page", async () => {
    const { svc, ctx, fail } = setup([
      gqlEntry({ root: "tags", view: "tagBySlug", terms: { slug: "deleted-lens" }, limit: 1 }, { results: [] }, "§10.2"),
      gqlEntry({ root: "TagPreview", args: { slug: "deleted-lens" } },
        { tag: rawTagFull(BAYES), lens: rawMdocRef({ _id: "deletedLens000001", slug: "deleted-lens", deleted: true }), summaries: [] }, "§10.2"),
    ]);
    expect(await fail(resolve(ref("tag", "slug", "deleted-lens", "slug"), "tag", ctx("get_tag"), svc))).toBe(
      'Error (not_found): No publicly visible wiki page has the slug "deleted-lens".');
  });
  it("P12 P17 a summary_id stands for its page; a lens's own summary also names its lens", async () => {
    const summary = rawMdocRef({
      _id: "lensSummary000001", slug: "bayes-rule-guide-summary", title: null, tabTitle: "Summary", fieldName: "summary",
      collectionName: "MultiDocuments", parentTag: null,
      parentLens: { _id: "BayesGuideLens001", slug: "bayes-rule-guide", title: "Guide", tabTitle: "Guide", fieldName: "description", deleted: false, parentTag: rawTagRef(BAYES) },
    });
    const { svc, ctx } = setup([missing("tag", "lensSummary000001"), gqlEntry({ root: "multiDocument", id: "lensSummary000001" }, { result: summary }, "§10.2")]);
    const c = ctx("get_tag");
    const r = await resolve(ref("tag", "id", "lensSummary000001"), "tag", c, svc);
    expect(r).toMatchObject({ kind: "summary", id: "lensSummary000001", pageId: "RkznxXmmh9b5ovdSq" });
    expect(r.slug).toBeUndefined();
    expect(echoOf("tag", r)).toBe('tag → "Bayes\' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq) · summary_id lensSummary000001 → page "Bayes\' rule"');
    expect(c.isConfirmed("doc", "lensSummary000001")).toBe(true);
    expect(c.isConfirmed("tag", "RkznxXmmh9b5ovdSq")).toBe(true);
    // ¶3.1.2: a tool that opens the summary itself, or the lens it summarizes, says so
    const page = 'tag → "Bayes\' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq)';
    expect(echoOf("tag", r, { opens: "part" })).toBe(`${page} · summary_id lensSummary000001 of lens "Guide" (lens_slug bayes-rule-guide) of page "Bayes' rule"`);
    expect(echoOf("tag", r, { opens: "lens" })).toBe(`${page} · summary_id lensSummary000001 → lens "Guide" (lens_slug bayes-rule-guide) of page "Bayes' rule"`);
  });
  it("¶3.1.2 a page's own summary: the part form names the page; a tool that opens the lens, having none, opens the page", async () => {
    const summary = rawMdocRef({
      _id: "pageSummary000001", slug: "bayes-rule-summary", title: null, tabTitle: "Summary", fieldName: "summary",
      collectionName: "Tags", parentTag: rawTagRef(BAYES), parentLens: null,
    });
    const { svc, ctx } = setup([missing("tag", "pageSummary000001"), gqlEntry({ root: "multiDocument", id: "pageSummary000001" }, { result: summary }, "§10.2")]);
    const r = await resolve(ref("tag", "id", "pageSummary000001"), "tag", ctx("get_tag"), svc);
    const page = 'tag → "Bayes\' rule" (tag_slug bayes-rule, tag_id RkznxXmmh9b5ovdSq)';
    expect(echoOf("tag", r)).toBe(`${page} · summary_id pageSummary000001 → page "Bayes' rule"`);
    expect(echoOf("tag", r, { opens: "part" })).toBe(`${page} · summary_id pageSummary000001 of page "Bayes' rule"`);
    expect(echoOf("tag", r, { opens: "lens" })).toBe(`${page} · summary_id pageSummary000001 → page "Bayes' rule"`);
  });
  it("Q90 an LW1 id is cached apart from a slug that spells the same", async () => {
    const { svc, ctx } = setup();
    const lw1 = parseRef("post", "https://www.lesswrong.com/lw/g/some_title/", ["post"]);
    await resolve(lw1, "post", ctx(), svc);
    expect(cachedResolution(lw1, ctx(), svc)?.id).toBe("lw1Post0000000016");
    expect(cachedResolution(ref("post", "slug", "g", "slug"), ctx(), svc)).toBeUndefined();
  });
  it("readResolution refuses an answer that holds none of the reference's aliases (a wrong prefix is a bug, not not_found)", async () => {
    const { svc, ctx, fail } = setup(); const c = ctx("find");
    const r1 = ref("post", "id", "uMQ3cqWDPHhjtiesc");
    const res = await svc.gql(resolutionOps(r1, "r1"), c, "resolving");
    expect(await fail(Promise.resolve().then(() => readResolution(r1, "post", "r9", res, c, svc)))).toBe(
      "Error (internal): Unexpected failure in find (resolve: the answer has no alias r9p). Please report this.");
  });
  it("Q88 after Duplicate A is resolved by id, the slug duplicate-slug still gives the two-posts bad_input", async () => {
    const dupA = rawPostCard({ _id: "dupSlugPostA00001", title: "Duplicate A", slug: "duplicate-slug", af: false });
    const { svc, ctx, fail } = setup([gqlEntry({ root: "post", id: "dupSlugPostA00001" }, { result: dupA }, "§3.2")]);
    expect((await resolve(ref("post", "id", "dupSlugPostA00001"), "post", ctx(), svc)).name).toBe("Duplicate A");
    expect(await fail(resolve(ref("post", "slug", "duplicate-slug", "slug"), "post", ctx(), svc))).toBe(
      'Error (bad_input): post: the slug "duplicate-slug" names 2 posts: "Duplicate A" (post_id dupSlugPostA00001) and "Duplicate B" (post_id dupSlugPostB00001). Pass the post_id you mean.');
  });
  it("P3 after unlistedPost00001 is resolved by id, the slug unlisted-post is still not_found with the post slug hint", async () => {
    const { forum, svc, ctx, fail } = setup();
    expect((await resolve(ref("post", "id", "unlistedPost00001"), "post", ctx(), svc)).slug).toBe("unlisted-post");
    expect(await fail(resolve(ref("post", "slug", "unlisted-post", "slug"), "post", ctx(), svc))).toBe(
      'Error (not_found): No publicly visible post has the slug "unlisted-post". Renamed posts lose their earlier slugs; the id in a URL always works.');
    expect(forum.requests).toHaveLength(2);
  });
  it("P3 rememberResolution keeps an unlisted post under its id only; a listable post also under its slug (find, D4)", () => {
    const { svc, ctx } = setup();
    const unlisted = resolvedFrom("post", rawPostCard({ _id: "unlistedPost00001", title: "An Unlisted Post", slug: "unlisted-post", af: false, unlisted: true }));
    rememberResolution("post", "unlisted-post", unlisted, svc);
    expect(cachedResolution(ref("post", "slug", "unlisted-post", "slug"), ctx(), svc)).toBeUndefined();
    expect(cachedResolution(ref("post", "id", "unlistedPost00001"), ctx(), svc)?.id).toBe("unlistedPost00001");
    rememberResolution("post", "agi-ruin-a-list-of-lethalities", resolvedFrom("post", rawPostCard()), svc);
    expect(cachedResolution(ref("post", "slug", "agi-ruin-a-list-of-lethalities", "slug"), ctx(), svc)?.id).toBe("uMQ3cqWDPHhjtiesc");
  });
  it("¶3.7 a tag or page name is cut at 60 like a display name; a post title only at 300", () => {
    const tag = resolvedFrom("tag", { _id: "longNameTag000001", name: "A".repeat(100), slug: "long-name" });
    expect(tag.name).toBe("A".repeat(59) + "…");
    expect(tag.display).toBe(`"${"A".repeat(59)}…" (tag_slug long-name, tag_id longNameTag000001)`);
    expect(resolvedFrom("post", { _id: "longTitlePost0001", title: "A".repeat(100) }).name).toBe("A".repeat(100));
  });
  it("comment ids and LW1 ids only: a comment slug is not resolved by a request", () => {
    expect(() => resolutionOps(ref("comment", "slug", "some-slug", "slug"), "")).toThrow(/not resolved by a request/);
  });
});
