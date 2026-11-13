// #135: an admin-only wiki page opens on the site from its URL (tagBySlug lets admin-only rows through; the access check refuses only
// deleted pages), with its discussion and history; the site leaves it off posts' tags and out of search and recent discussion. These
// are the routes not covered by each tool's own tests: a slug guess in find, and the page's discussion in get_comments.
import { describe, expect, it } from "vitest";
import { createHarness, expectClean } from "../support/harness";
import { forestEntries, rawCommentTree, searchEntry } from "../support/builders";

const FLAG = "admin-only (left off posts and out of search)";
const ADMIN = "adminOnlyTag00001";

describe("#135 an admin-only page on the routes that open it", () => {
  it("find: a name that search does not know is found by its slug, flagged (the site's search leaves it out, its URL opens it)", async () => {
    const h = createHarness({ families: ["posts", "users", "tags", "sequences", "search", "comments"], extra: [
      searchEntry({ index: "tags", query: "Admin Only Tag", page: 0, hitsPerPage: 10, facetFilters: [] }, { hits: [], nbHits: 0 }, "§3.4, #135"),
      searchEntry({ index: "tags", query: "Admin Only Tag", page: 0, hitsPerPage: 3, facetFilters: [["wikiOnly:true"]] }, { hits: [], nbHits: 0 }, "§3.4"),
    ] });
    const out = (await h.call("find", { items: [{ kind: "tag", query: "Admin Only Tag" }] })).text;
    expect(out).toContain(`"Admin Only Tag" · tag_slug admin-only-tag · tag_id ${ADMIN}`);
    expect(out).toContain(FLAG);
    expectClean(h);
  });

  it("get_comments: the page's discussion opens, the page flagged (TagDiscussionPage)", async () => {
    const h = createHarness({ extra: forestEntries({ tag: ADMIN }, [
      rawCommentTree({ _id: "adminDiscuss00001", tagId: ADMIN, postId: null, af: false, contents: { markdown: "A comment on the admin-only page.", wordCount: 6 } }),
    ]) });
    const out = (await h.call("get_comments", { tag: "admin-only-tag" })).text;
    expect(out).toMatch(/^get_comments — /);
    expect(out).toContain("comment_id adminDiscuss00001");
    expect(out).toContain(FLAG);
    expectClean(h);
  });
});
