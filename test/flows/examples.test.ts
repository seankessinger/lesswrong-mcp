import { describe, it, expect } from "vitest";
import { createHarness, expectClean } from "../support/harness";
import { gqlTexts, handOffCursor } from "../support/requests";
import { agiRuinForest, AGI_FOREST, paulCommentsOnAgiRuin, forestEntries, bodiesEntry, smallAgiRuinForest, commentRow } from "../support/builders";
import type { FixtureEntry } from "../support/fixtures";
import type { RawCommentTree } from "../../src/types";

/** One harness per example: its calls share the caches, as in one conversation. */
function flow(extra: FixtureEntry[] = []) {
  const h = createHarness({ extra });
  let mark = 0;
  return {
    h,
    async call(tool: Parameters<typeof h.call>[0], args: Record<string, unknown>) {
      const out = await h.call(tool, args);
      const used = h.forum.requests.length - mark; mark = h.forum.requests.length;
      return { ...out, used };
    },
  };
}
const rowsOf = (entries: FixtureEntry[]) => entries.flatMap((e) => ((e.result as { results?: { _id: string; contents?: unknown }[] } | undefined)?.results ?? []));

/**
 * `paulCommentsOnAgiRuin` with direct replies to two of Paul's comments (new ids): "User 1" answers paulCmnt000000001 and Paul
 * replies back to it; "User 2" answers paulCmnt000000002 and he does not. The replies join the same `postCommentsOld` entry, so
 * no match key is repeated and the builder that `find`'s tests assert on stays as it is.
 */
function paulCommentsWithReplies(): FixtureEntry[] {
  const [comments, ...rest] = paulCommentsOnAgiRuin();
  const reply = (id: string, user: number, postedAt: string, parent: string, root: string, o: Partial<RawCommentTree> = {}) =>
    commentRow(id, user, postedAt, { parentCommentId: parent, topLevelCommentId: root, ...o });
  const replies = [
    reply("replyToPaul000001", 1, "2022-06-07T10:00:00.000Z", "paulCmnt000000001", "paulCmnt000000001"),
    reply("paulAnswersBack01", 1, "2022-06-07T12:00:00.000Z", "replyToPaul000001", "paulCmnt000000001", { userId: AGI_FOREST.paul._id, user: AGI_FOREST.paul }),
    reply("replyToPaul000002", 2, "2022-06-08T10:00:00.000Z", "paulCmnt000000002", "paulCmnt000000002"),
  ];
  return [{ ...comments, result: { results: [...rowsOf([comments]), ...replies] } }, ...rest];
}

describe("¶5b the example requests, end to end (example 4, one first_use call, is in first_use.test.ts)", () => {
  it("example 1: find the post, then get_comments sort contested (2 + 2 requests)", async () => {
    const f = flow((() => { const forest = agiRuinForest(); return forestEntries({ post: AGI_FOREST.postId }, forest.comments, forest.answers); })());
    const a = await f.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }] });
    expect(a.text).toContain('  1. ★ best match (exact title) — "AGI Ruin: A List of Lethalities" — "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky)');
    expect(a.text).toContain("post_id uMQ3cqWDPHhjtiesc");
    expect(a.used).toBe(2);
    const b = await f.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", sort: "contested", max_tokens: 40000 });
    expect(b.isError).toBe(false);
    expect(b.text.split("\n")[0]).toBe('get_comments — discussion of "AGI Ruin: A List of Lethalities"');
    expect(b.text).toContain("Counted: 731 publicly visible comments in 158 threads, 214 people (site counter ~717)");
    expect(b.text).toContain("Disagreement signals:");
    expect(b.text).toContain('back-and-forth: "paulfchristiano" (user_slug paulfchristiano) and "Eliezer Yudkowsky" (user_slug eliezer_yudkowsky), 6 replies in T1');
    expect(b.text).toContain('## T1 · root by "paulfchristiano" (user_slug paulfchristiano) · comment_id HRDoDnHv8bvoW7oPZ · karma 299 · AF karma 87 · 18 comments · 7 people · contested 6 · newest 2022-06-20');
    expect(b.used).toBe(2);
    expect(gqlTexts(f.h.forum).at(-1)).toContain("commentIds");
    expectClean(f.h);
  });

  it("example 2: find the post and the commenter in one call, then the reply map (3 + 1 requests)", async () => {
    const forest = paulCommentsWithReplies();
    const f = flow([...forest, bodiesEntry(rowsOf(forest), "§8.2")]);
    const a = await f.call("find", { items: [{ kind: "post", query: "AGI Ruin: A List of Lethalities" }, { kind: "user", query: "Paul Christiano", commented_on: "item:1" }] });
    expect(a.text).toMatch(/Item 2 · user "Paul Christiano" \(commenters of post_id uMQ3cqWDPHhjtiesc first\)\n  1\. ★ best match \(commented on this post \d+ times\) — "paulfchristiano" · user_slug paulfchristiano/);
    expect(a.used).toBe(3);
    const b = await f.call("get_comments", { post: "uMQ3cqWDPHhjtiesc", user: "paulfchristiano" });
    expect(b.text).toContain('Reply map for "paulfchristiano" (user_slug paulfchristiano)');
    expect(b.text).toMatch(/replied back: (yes \(comment_id [A-Za-z0-9]{17}|no)/);
    expect(b.text).toContain("comment_id replyToPaul000001 · not on AF · replied back: yes (comment_id paulAnswersBack01)");
    expect(b.text).toContain("comment_id replyToPaul000002 · not on AF · replied back: no");
    expect(b.text).toContain("★");
    expect(b.text).not.toMatch(/★ comment_id agiPlaceholder001|★ comment_id agiAnon0000000001/);
    expect(b.text).not.toContain("agiPlaceholder001");
    expect(b.text).not.toContain("agiAnon0000000001");
    expect(b.used).toBe(1);
    expectClean(f.h);
  });

  it("example 3: find the author and the topic, then list_posts with the 2024 window and the untagged section (2 + 3 requests)", async () => {
    const f = flow();
    const a = await f.call("find", { items: [{ kind: "user", query: "Eliezer Yudkowsky" }, { kind: "tag", query: "interpretability" }] });
    expect(a.text).toContain('★ best match (exact name) — "Eliezer Yudkowsky" · user_slug eliezer_yudkowsky');
    expect(a.text).toContain('"Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R');
    expect(a.text.split("Item 2")[1]).not.toContain("★");
    expect(a.used).toBe(2);
    const b = await f.call("list_posts", { user: "eliezer_yudkowsky", tag: "interpretability-ml-and-ai", date_from: "2024", date_to: "2024", sort: "top", limit: 20, query: "interpretability" });
    expect(gqlTexts(f.h.forum).find((t) => t.includes("userPosts"))).toContain('after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z"');
    expect([...b.text.matchAll(/post_id ([A-Za-z0-9]{17})/g)].map((m) => m[1])).toEqual(["ey2024Post0000001", "ey2024Coauthor001", "ey2024SubQues0001", "ey2024Group000001", "eyUntagged0000001", "eySubQuestion0001"]);
    expect(b.text).toContain('Also matching "interpretability", not tagged "Interpretability (ML & AI)"');
    expect(b.used).toBe(3);
    expectClean(f.h);
  });

  it("example 5: find Axel Højmark, then get_user, then the list_comments hand-off (2 + ≤2 + 1 requests)", async () => {
    const f = flow();
    const a = await f.call("find", { items: [{ kind: "user", query: "Axel Højmark" }] });
    expect(a.text).toContain('  1. ★ best match (exact name) — "Axel Højmark" · user_slug axel-hojmark · user_id EE3myGHTpvb8h9hb5 · karma 120');
    expect(a.used).toBe(2);
    const b = await f.call("get_user", { user: "axel-hojmark", limit: 3 });
    expect(b.text.split("\n")[0]).toBe('get_user — "Axel Højmark"');
    expect(b.text).toContain("Latest comments:");
    expect(b.used).toBeLessThanOrEqual(2);
    const cursor = handOffCursor(b.text, "list_comments")!;
    expect(cursor).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
    const shown = new Set([...b.text.split("Latest comments:")[1].matchAll(/comment_id ([A-Za-z0-9]{17})/g)].map((m) => m[1]));
    const c = await f.call("list_comments", { user: "axel-hojmark", cursor });
    expect(c.isError).toBe(false);
    const next = [...c.text.matchAll(/^▶ .*comment_id ([A-Za-z0-9]{17})$/gm)].map((m) => m[1]);
    expect(next.length).toBeGreaterThan(0);
    expect(next.filter((id) => shown.has(id))).toEqual([]);
    expect(c.used).toBe(1);
    expectClean(f.h);
  });

  it("example 6: find the topic, then get_tag with the forum count and the list_posts hand-off (2 + 2 requests)", async () => {
    const f = flow();
    const a = await f.call("find", { items: [{ kind: "tag", query: "interpretability" }] });
    expect(a.text).toContain('"Interpretability (ML & AI)" · tag_slug interpretability-ml-and-ai · tag_id 56yXXrcxRjrQs6z9R');
    expect(a.text).toContain("page type: wiki-only page");
    expect(a.text).not.toContain("★");
    expect(a.used).toBe(2);
    const b = await f.call("get_tag", { tag: "interpretability-ml-and-ai" });
    expect(b.text.split("\n")[0]).toBe('get_tag — "Interpretability (ML & AI)"');
    expect(b.text).toContain("about 1,137 posts (the forum's count)");
    expect(b.text).toContain("Top tagged posts (by karma):");
    expect(b.text).toMatch(/More posts: list_posts \{tag: "interpretability-ml-and-ai", sort: "top", .*cursor: "c_[A-Za-z0-9_-]{22}"\}/);
    expect(b.used).toBeLessThanOrEqual(2);
    expectClean(f.h);
  });
});

describe("several calls at once (D13, ¶7)", () => {
  it("D13 ¶7 two calls at once share the one-in-flight queue: both answer, every request start at least 3,000 ms after the previous one", async () => {
    const h = createHarness({ http: { spacingMs: 3000 }, extra: smallAgiRuinForest() });
    const [u, c] = await Promise.all([h.call("get_user", { user: "axel-hojmark", limit: 3 }), h.call("get_comments", { post: "uMQ3cqWDPHhjtiesc" })]);
    expect([u.isError, c.isError]).toEqual([false, false]);
    const starts = h.forum.requests.map((r) => r.at);
    expect(starts.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(3000);
    expectClean(h);
  });
});
