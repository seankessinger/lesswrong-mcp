import { describe, expect, it } from "vitest";
import { ID_RE, isEntityId, parseRef, slugify, parseLink } from "../../src/ids/parse";
import { badInputMessage } from "../support/errors";

const P = "uMQ3cqWDPHhjtiesc";
const C = "HRDoDnHv8bvoW7oPZ";
const S = "5g5TkQTe9rmPS5vvM";
const NOTE = "commentId ignored; pass it as comment to target the comment";

describe("ids (§3.1)", () => {
  it("ID_RE accepts 17 alphanumerics and 24-hex legacy ids only", () => {
    expect(ID_RE.source).toBe("^[A-Za-z0-9]{17}$|^[0-9a-f]{24}$");
    expect([isEntityId(P), isEntityId("5f5c37ee1b5cdee568cfb0e9"), isEntityId("5F5C37EE1B5CDEE568CFB0E9"), isEntityId(P + "x"), isEntityId("uMQ3cqWDPHhjties!")]).toEqual([
      true, true, false, false, false,
    ]);
  });
});

describe("parseRef: bare identifiers (¶3.1.2)", () => {
  it("a bare 17-character string is tried as id and slug for posts, users and tags; an id only for comments and sequences", () => {
    expect(parseRef("post", ` ${P} `, ["post"])).toEqual({ kind: "post", form: "idOrSlug", value: P, given: "id", notes: [] });
    expect(parseRef("user", "nmk3nLpQE89dMRzzN", ["user"])).toMatchObject({ kind: "user", form: "idOrSlug" });
    expect(parseRef("comment", C, ["comment"])).toEqual({ kind: "comment", form: "id", value: C, given: "id", notes: [] });
    expect(parseRef("sequence", S, ["sequence"])).toEqual({ kind: "sequence", form: "id", value: S, given: "id", notes: [] });
    expect(parseRef("tag", "5f5c37ee1b5cdee568cfb0e9", ["tag"])).toEqual({ kind: "tag", form: "id", value: "5f5c37ee1b5cdee568cfb0e9", given: "id", notes: [] });
  });

  it("strings with - or _ (and other slug-shaped strings) are slugs, case kept", () => {
    expect(parseRef("post", "agi-ruin-a-list-of-lethalities", ["post"])).toEqual({ kind: "post", form: "slug", value: "agi-ruin-a-list-of-lethalities", given: "slug", notes: [] });
    expect(parseRef("user", "eliezer_yudkowsky", ["user"])).toMatchObject({ form: "slug", value: "eliezer_yudkowsky" });
    expect(parseRef("user", "Habryka", ["user"])).toMatchObject({ form: "slug", value: "Habryka" });
    expect(parseRef("tag", "bayes_rule", ["tag"])).toMatchObject({ form: "slug", value: "bayes_rule" });
    expect(parseRef("tag", "1lz", ["tag"])).toMatchObject({ form: "slug", value: "1lz" });
    expect(parseRef("tag", "bayes-rule-guide", ["tag"])).toMatchObject({ form: "slug", value: "bayes-rule-guide" });
  });

  it("the five collection slugs are sequence identifiers; sequences have no other slugs", () => {
    expect(parseRef("sequence", "rationality", ["sequence"])).toEqual({ kind: "sequence", form: "collection", value: "rationality", given: "slug", notes: [] });
    expect(parseRef("sequence", "HPMOR", ["sequence"])).toMatchObject({ form: "collection", value: "hpmor" });
    expect(badInputMessage(() => parseRef("sequence", "rationalty", ["sequence"]))).toBe(
      'sequence: "rationalty" is not a sequence id, URL or collection slug (rationality, codex, hpmor, highlights, bestoflesswrong). To look up a sequence by title, use find {items: [{kind: "sequence", query: "rationalty"}]}.',
    );
  });

  it("titles, names and injection attempts are refused with a hint to find", () => {
    expect(badInputMessage(() => parseRef("post", "AGI Ruin: A List of Lethalities", ["post"]))).toBe(
      'post: "AGI Ruin: A List of Lethalities" is not an id, URL or slug. To turn a title into an id, use find {items: [{kind: "post", query: "AGI Ruin: A List of Lethalities"}]}.',
    );
    expect(badInputMessage(() => parseRef("user", "Paul Christiano", ["user"]))).toBe(
      'user: "Paul Christiano" is not an id, URL or slug. To look up a person by name, use find {items: [{kind: "user", query: "Paul Christiano"}]}.',
    );
    expect(badInputMessage(() => parseRef("tag", "AI safety", ["tag"]))).toBe(
      'tag: "AI safety" is not an id, URL or slug. To look up a topic or wiki page by name, use find {items: [{kind: "tag", query: "AI safety"}]}.',
    );
    expect(badInputMessage(() => parseRef("post", 'x") { posts { _id } }', ["post"]))).toBe(
      'post: "x\\") { posts { _id } }" is not an id, URL or slug. To turn a title into an id, use find {items: [{kind: "post", query: "x\\") { posts { _id } }"}]}.',
    );
    expect(badInputMessage(() => parseRef("comment", "some-comment", ["comment"]))).toBe(
      'comment: "some-comment" is not a comment id or link. Comments have no names or slugs: give the comment_id, or a link with ?commentId=.',
    );
    expect(badInputMessage(() => parseRef("post", "abc\ndef", ["post"]))).toContain('post: "abc def" is not an id, URL or slug.');
  });

  it("identifiers copied from Markdown or prose: enclosing <>, quotes or backticks and trailing .,;:) are ignored, with a note", () => {
    const STRAY = "surrounding punctuation ignored";
    expect(parseRef("post", `<https://www.lesswrong.com/posts/${P}>`, ["post"])).toMatchObject({ kind: "post", form: "id", value: P, given: "url", notes: [STRAY] });
    expect(parseRef("post", '"agi-ruin-a-list-of-lethalities"', ["post"])).toEqual({ kind: "post", form: "slug", value: "agi-ruin-a-list-of-lethalities", given: "slug", notes: [STRAY] });
    expect(parseRef("post", `https://www.lesswrong.com/posts/${P}).`, ["post"])).toMatchObject({ form: "id", value: P, given: "url", notes: [STRAY] });
    expect(parseRef("post", "`" + P + "`", ["post"])).toEqual({ kind: "post", form: "idOrSlug", value: P, given: "id", notes: [STRAY] });
    expect(parseRef("post", `https://www.lesswrong.com/posts/${P}/x?commentId=${C}.`, ["post"]).notes).toEqual([STRAY, NOTE]);
    expect(badInputMessage(() => parseRef("post", '"AGI Ruin"', ["post"]))).toBe(
      'post: "AGI Ruin" is not an id, URL or slug. To turn a title into an id, use find {items: [{kind: "post", query: "AGI Ruin"}]}.',
    );
  });
});

describe("parseRef: URL forms on every recognised host (¶3.1.2, §3.3)", () => {
  const hosts = ["https://www.lesswrong.com", "http://lesswrong.com", "https://lesserwrong.com", "https://www.lessestwrong.com", "https://baserates.org", "https://www.alignmentforum.org", "https://alignment-forum.com", "https://www.greaterwrong.com", "lesswrong.com", "WWW.LESSWRONG.COM", "HTTPS://WWW.LESSWRONG.COM"];
  it("/posts/<id>/<slug> on every host", () => {
    for (const h of hosts) {
      expect(parseRef("post", `${h}/posts/${P}/agi-ruin-a-list-of-lethalities`, ["post"])).toMatchObject({ kind: "post", form: "id", value: P, given: "url", notes: [] });
    }
  });

  it("Q87 /posts/slug/<slug> is matched before /posts/<id>/<slug>", () => {
    expect(parseRef("post", "https://www.lesswrong.com/posts/slug/agi-ruin-a-list-of-lethalities", ["post"])).toEqual({
      kind: "post", form: "slug", value: "agi-ruin-a-list-of-lethalities", given: "url", notes: [],
    });
  });

  it("comment permalinks: the comment for a comment parameter; the post, with a note, for a post parameter", () => {
    for (const u of [
      `https://www.lesswrong.com/posts/${P}/agi-ruin?commentId=${C}`,
      `https://www.lesswrong.com/posts/${P}/agi-ruin/comment/${C}`,
      `https://www.lesswrong.com/posts/${P}/agi-ruin/${C}`,
    ]) {
      expect(parseRef("comment", u, ["comment"])).toMatchObject({ kind: "comment", form: "id", value: C, given: "url", notes: [] });
      expect(parseRef("post", u, ["post"])).toMatchObject({ kind: "post", form: "id", value: P, given: "url", notes: [NOTE] });
    }
    expect(parseRef("comment", `https://www.lesswrong.com/w/bayes-rule/discussion?commentId=${C}`, ["comment"])).toMatchObject({ kind: "comment", value: C });
    expect(parseRef("tag", `https://www.lesswrong.com/w/bayes-rule/discussion?commentId=${C}`, ["tag"])).toMatchObject({ kind: "tag", form: "slug", value: "bayes-rule", notes: [NOTE] });
    expect(parseRef("post", `https://www.lesswrong.com/posts/${P}/x?commentId=notanid#section`, ["post"])).toMatchObject({ value: P, notes: [] });
  });

  it("every other post form", () => {
    const forms: [string, Partial<ReturnType<typeof parseRef>>][] = [
      [`/s/${S}/p/${P}`, { form: "id", value: P }],
      [`/events/${P}/meetup-slug`, { form: "id", value: P }],
      [`/g/abcdefghijklmnopq/p/${P}`, { form: "id", value: P }],
      [`/revisions/post/${P}/agi-ruin`, { form: "id", value: P }],
      [`/compare/post/${P}/agi-ruin`, { form: "id", value: P }],
      [`/api/post/${P}`, { form: "id", value: P }],
      ["/lw/1x9/some_old_post", { form: "legacy", value: "1x9" }],
      ["/lw/g", { form: "legacy", value: "g" }],
      ["/r/discussion/lw/1x9/some_old_post/", { form: "legacy", value: "1x9" }],
      ["/r/all/lw/1x9/some_old_post", { form: "legacy", value: "1x9" }],
      ["/r/lesswrong/lw/1x9", { form: "legacy", value: "1x9" }],
      ["/rationality/the-simple-truth", { form: "slug", value: "the-simple-truth" }],
      ["/hpmor/chapter-1-a-day-of-very-low-probability", { form: "slug", value: "chapter-1-a-day-of-very-low-probability" }],
    ];
    for (const [path, want] of forms) {
      expect(parseRef("post", `https://www.lesswrong.com${path}`, ["post"])).toMatchObject({ kind: "post", given: "url", ...want });
    }
    expect(parseRef("post", "https://www.lesswrong.com/lw/1x9/some_old_post/2b1c", ["post"])).toMatchObject({ form: "legacy", value: "1x9", notes: [NOTE] });
    expect(parseRef("comment", "https://www.lesswrong.com/lw/1x9/some_old_post/2b1c", ["comment"])).toMatchObject({ kind: "comment", form: "legacy", value: "2b1c" });
  });

  it("Q90 LW1 ids are base 36 in lower case only", () => {
    expect(badInputMessage(() => parseRef("post", "https://www.lesswrong.com/lw/109-x/foo", ["post"]))).toBe(
      'post: "https://www.lesswrong.com/lw/109-x/foo" is not a forum page this server reads. Give a post id, a post URL, or the exact current slug.',
    );
  });

  it("users, tags, sequences and collections", () => {
    for (const path of ["/users/eliezer_yudkowsky", "/u/eliezer_yudkowsky", "/user/eliezer_yudkowsky/posts", "/users/eliezer_yudkowsky/replies"]) {
      expect(parseRef("user", `https://www.lesswrong.com${path}`, ["user"])).toMatchObject({ kind: "user", form: "slug", value: "eliezer_yudkowsky", given: "url" });
    }
    for (const u of ["https://www.lesswrong.com/w/bayes-rule", "https://www.lesswrong.com/tag/bayes-rule", "https://www.lesswrong.com/p/bayes-rule", "https://www.lesswrong.com/w/bayes-rule/discussion", "https://www.lesswrong.com/w/bayes-rule/history"]) {
      expect(parseRef("tag", u, ["tag"])).toMatchObject({ kind: "tag", form: "slug", value: "bayes-rule", given: "url" });
    }
    expect(parseRef("tag", "https://arbital.com/p/bayes_rule/", ["tag"])).toEqual({ kind: "tag", form: "slug", value: "bayes_rule", given: "url", notes: [] });
    expect(parseRef("sequence", `https://www.lesswrong.com/s/${S}`, ["sequence"])).toMatchObject({ kind: "sequence", form: "id", value: S });
    expect(parseRef("sequence", `https://www.lesswrong.com/sequences/${S}`, ["sequence"])).toMatchObject({ form: "id", value: S });
    expect(parseRef("sequence", `https://www.lesswrong.com/s/${S}/p/${P}`, ["sequence"])).toMatchObject({ form: "id", value: S, postPart: P, notes: [] });
    expect(parseRef("sequence", "https://www.lesswrong.com/highlights", ["sequence"])).toMatchObject({ form: "collection", value: "highlights" });
    expect(parseRef("sequence", "https://www.lesswrong.com/books", ["sequence"])).toMatchObject({ form: "collection", value: "bestoflesswrong" });
    expect(parseRef("sequence", "https://www.lesswrong.com/collections/2izXHCrmJ684AnZ5X", ["sequence"])).toMatchObject({ form: "collection", value: "codex" });
  });

  it("refuses kind mismatches, unknown paths, other hosts and Agent Foundations links", () => {
    expect(badInputMessage(() => parseRef("post", "https://www.lesswrong.com/users/eliezer_yudkowsky", ["post"]))).toBe(
      "post: that URL is a user profile; this parameter takes a post.",
    );
    expect(badInputMessage(() => parseRef("comment", `https://www.lesswrong.com/posts/${P}/agi-ruin`, ["comment"]))).toBe(
      "comment: that URL is a post; this parameter takes a comment.",
    );
    expect(badInputMessage(() => parseRef("tag", `https://www.lesswrong.com/s/${S}`, ["tag"]))).toBe(
      "tag: that URL is a sequence; this parameter takes a tag or wiki page.",
    );
    expect(badInputMessage(() => parseRef("post", "https://www.lesswrong.com/allPosts", ["post"]))).toBe(
      'post: "https://www.lesswrong.com/allPosts" is not a forum page this server reads. Give a post id, a post URL, or the exact current slug.',
    );
    expect(badInputMessage(() => parseRef("user", "https://example.com/users/x", ["user"]))).toBe(
      'user: "https://example.com/users/x" is not a LessWrong or Alignment Forum URL. Give a user id, a profile URL, or the exact slug.',
    );
    expect(badInputMessage(() => parseRef("post", "https://www.alignmentforum.org/item?id=123", ["post"]))).toBe(
      "post: Agent Foundations links (/item?id=…) can't be looked up: the forum has no query for their ids. Look the post up by its title with find.",
    );
    expect(badInputMessage(() => parseRef("sequence", "https://www.lesswrong.com/collections/abcdefghijklmnopq", ["sequence"]))).toBe(
      'sequence: "https://www.lesswrong.com/collections/abcdefghijklmnopq" is not one of the five collections. Give a sequence id, a sequence URL, or a collection slug (rationality, codex, hpmor, highlights, bestoflesswrong).',
    );
  });
});

describe("parseRef: revision words and item:N", () => {
  const words = { words: ["original", "current"] as const };
  it("revision ids and the words original, current (previous only for compare_to)", () => {
    expect(parseRef("revision", "Original", ["revision"], words)).toEqual({ kind: "revision", form: "word", value: "original", given: "word", notes: [] });
    expect(parseRef("revision", "5f5c37ee1b5cdee568cfb0e9", ["revision"], words)).toEqual({ kind: "revision", form: "id", value: "5f5c37ee1b5cdee568cfb0e9", given: "id", notes: [] });
    expect(parseRef("compare_to", "previous", ["revision"], { words: ["original", "previous", "current"] })).toMatchObject({ form: "word", value: "previous" });
    expect(badInputMessage(() => parseRef("revision", "previous", ["revision"], words))).toBe(
      "revision: \"previous\" is not a revision id. Use a revision_id from get_history's version list, or original or current.",
    );
  });
  it("Q91 synthetic revision ids and version strings are refused", () => {
    expect(badInputMessage(() => parseRef("revision", "u3MgyyP3TDijmGhec_contents", ["revision"], words))).toBe(
      "revision: \"u3MgyyP3TDijmGhec_contents\" is a document's stored-text id, not a revision id. Use a revision_id from get_history's version list, or original or current.",
    );
    expect(badInputMessage(() => parseRef("compare_to", "1.2.0", ["revision"], { words: ["original", "previous", "current"] }))).toBe(
      "compare_to: \"1.2.0\" is a version number, and version numbers repeat. Use a revision_id from get_history's version list, or original, previous or current.",
    );
  });
  // find parses commented_on's item:N itself (find.ts ITEM_RE, checkItems); for parseRef it is no identifier.
  it("item:N is not an id, URL or slug", () => {
    expect(badInputMessage(() => parseRef("post", "item:1", ["post"]))).toContain('post: "item:1" is not an id, URL or slug.');
  });
});

describe("slugify (§3.2, ¶4.1 step 3)", () => {
  it("follows the forum's slug rules", () => {
    expect(slugify("AGI Ruin: A List of Lethalities")).toBe("agi-ruin-a-list-of-lethalities");
    expect(slugify("Don’t trust Lean4 alone")).toBe("don-t-trust-lean4-alone");
    expect(slugify("R&D at MIRI")).toBe("r-and-d-at-miri");
    expect(slugify("GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior")).toBe(
      "glm-5-3-sometimes-considers-how-train-time-actions-shape",
    );
    expect(slugify("What's up with LLMs representing XORs of arbitrary features?")).toBe(
      "what-s-up-with-llms-representing-xors-of-arbitrary-features",
    );
  });
});

describe("parseLink (¶4.13)", () => {
  it("classifies onsite and offsite links", () => {
    expect(parseLink(`https://www.lesswrong.com/posts/${P}/agi-ruin`)).toEqual({
      onsite: true, url: `https://www.lesswrong.com/posts/${P}/agi-ruin`, ref: { kind: "post", form: "id", value: P, given: "url", notes: [] },
    });
    expect(parseLink(`https://www.alignmentforum.org/posts/${P}/x?commentId=${C}`)).toMatchObject({ onsite: true, ref: { kind: "comment", value: C } });
    expect(parseLink(`https://www.lesswrong.com/s/${S}/p/${P}`)).toMatchObject({ onsite: true, ref: { kind: "post", value: P } });
    expect(parseLink("/w/bayes-rule")).toMatchObject({ onsite: true, ref: { kind: "tag", value: "bayes-rule" } });
    expect(parseLink("https://arbital.com/p/bayes_rule")).toMatchObject({ onsite: true, ref: { kind: "tag", value: "bayes_rule" } });
    expect(parseLink("https://www.lesswrong.com/allPosts")).toEqual({ onsite: true, url: "https://www.lesswrong.com/allPosts" });
    expect(parseLink("https://www.arxiv.org/abs/2101.00001")).toEqual({ onsite: false, domain: "arxiv.org", url: "https://www.arxiv.org/abs/2101.00001" });
    expect(parseLink("mailto:someone@example.com")).toEqual({ onsite: false, domain: "mailto", url: "mailto:someone@example.com" });
    expect(parseLink("not a url")).toEqual({ onsite: false, domain: "", url: "not a url" });
  });
});

describe("parseRef: refusals and edges the path table implies", () => {
  const NOT_FORUM = "is not a forum page this server reads. Give a post id, a post URL, or the exact current slug.";

  it("a recognised host must be the URL's own host, not a prefix, a user name or a query value", () => {
    const WHY = "is not a LessWrong or Alignment Forum URL. Give a post id, a post URL, or the exact current slug.";
    for (const u of [`https://lesswrong.com@evil.com/posts/${P}`, `https://lesswrong.com.evil.com/posts/${P}`, `https://evil.com/?next=lesswrong.com/posts/${P}`]) {
      expect(badInputMessage(() => parseRef("post", u, ["post"]))).toBe(`post: ${JSON.stringify(u)} ${WHY}`);
    }
    expect(badInputMessage(() => parseRef("post", `lesswrong.com.evil.com/posts/${P}`, ["post"]))).toContain("is not an id, URL or slug");
  });

  it("a slug read from a URL path passes the same shape check as a bare slug", () => {
    for (const path of ["/users/x%22y", "/users/a{b}", "/users/a%20b"]) {
      expect(badInputMessage(() => parseRef("user", `https://www.lesswrong.com${path}`, ["user"]))).toContain("is not a forum page this server reads");
    }
    expect(badInputMessage(() => parseRef("tag", "https://www.lesswrong.com/w/a{b}", ["tag"]))).toContain("is not a forum page this server reads");
  });

  it("a path that matches no row of the table is refused, whatever its prefix", () => {
    for (const path of ["/posts/slug", `/posts/${P}/x/y/z`, "/bestoflesswrong/x", "/lw/1x9/some_old_post/2b1c/extra", "/events", ""]) {
      expect(badInputMessage(() => parseRef("post", `https://www.lesswrong.com${path}`, ["post"]))).toContain(NOT_FORUM);
    }
    expect(badInputMessage(() => parseRef("post", "lesswrong.com", ["post"]))).toContain(NOT_FORUM);
    expect(badInputMessage(() => parseRef("user", "https://www.lesswrong.com/users/x/posts", ["user"]))).toContain("is not a forum page this server reads");
    expect(badInputMessage(() => parseRef("tag", "https://www.lesswrong.com/tag/x/y", ["tag"]))).toContain("is not a forum page this server reads");
    expect(badInputMessage(() => parseRef("tag", "https://arbital.com/w/x", ["tag"]))).toContain("is not a forum page this server reads");
    expect(badInputMessage(() => parseRef("tag", "https://arbital.com/p/", ["tag"]))).toContain("is not a forum page this server reads");
  });

  it("the first of kinds that the URL names wins", () => {
    expect(parseRef("link", `https://www.lesswrong.com/s/${S}/p/${P}`, ["sequence", "post"])).toMatchObject({ kind: "sequence", value: S, postPart: P });
    expect(parseRef("link", `https://www.lesswrong.com/s/${S}/p/${P}`, ["post", "sequence"])).toMatchObject({ kind: "post", value: P, notes: [] });
    expect(parseRef("link", `https://www.lesswrong.com/posts/${P}/x?commentId=5f5c37ee1b5cdee568cfb0e9`, ["comment", "post"])).toMatchObject({ kind: "comment", value: "5f5c37ee1b5cdee568cfb0e9", notes: [] });
  });

  it("a collection URL is a collection for every other parameter; an unknown collection id is refused whatever the parameter", () => {
    expect(badInputMessage(() => parseRef("post", "https://www.lesswrong.com/collections/2izXHCrmJ684AnZ5X", ["post"]))).toBe(
      "post: that URL is a collection; this parameter takes a post.",
    );
    expect(badInputMessage(() => parseRef("tag", "https://www.lesswrong.com/highlights", ["tag"]))).toBe(
      "tag: that URL is a collection; this parameter takes a tag or wiki page.",
    );
    expect(badInputMessage(() => parseRef("post", "https://www.lesswrong.com/collections/abcdefghijklmnopq", ["post"]))).toContain("is not one of the five collections");
  });

  it("a URL is never a revision; the fix names only the words the parameter takes", () => {
    expect(badInputMessage(() => parseRef("revision", `https://www.lesswrong.com/posts/${P}`, ["revision"], { words: ["original", "current"] }))).toBe(
      "revision: a URL is not a revision. Use a revision_id from get_history's version list, or original or current.",
    );
    expect(badInputMessage(() => parseRef("revision", "zzz", ["revision"], { words: ["current"] }))).toBe(
      "revision: \"zzz\" is not a revision id. Use a revision_id from get_history's version list, or current.",
    );
    expect(badInputMessage(() => parseRef("revision", "zzz", ["revision"]))).toBe("revision: \"zzz\" is not a revision id. Use a revision_id from get_history's version list.");
  });

  it("empty and punctuation-only input is refused; a message prints the input on one line, cut at 100 characters", () => {
    expect(badInputMessage(() => parseRef("post", "", ["post"]))).toContain('post: "" is not an id, URL or slug.');
    expect(badInputMessage(() => parseRef("post", "...", ["post"]))).toContain('post: "" is not an id, URL or slug.');
    expect(badInputMessage(() => parseRef("post", `a\u{2028}b\tc`, ["post"]))).toContain('post: "a b c" is not an id, URL or slug.');
    expect(badInputMessage(() => parseRef("post", "word ".repeat(100), ["post"]))).toContain(`${JSON.stringify("word ".repeat(19) + "word…")} is not an id, URL or slug.`);
  });

  it("an 18-character alphanumeric string is a slug; a 17-character string with other characters is refused", () => {
    expect(parseRef("post", P + "x", ["post"])).toMatchObject({ form: "slug", value: P + "x" });
    expect(badInputMessage(() => parseRef("post", "uMQ3cqWDPHhjties!", ["post"]))).toContain('post: "uMQ3cqWDPHhjties!" is not an id, URL or slug.');
  });

  it("names that are not own properties of the collection table are not collections", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(badInputMessage(() => parseRef("sequence", name, ["sequence"]))).toContain(`sequence: "${name}" is not a sequence id, URL or collection slug`);
    }
  });
});

describe("parseLink: edges", () => {
  it("a protocol-relative link is read as https; other relative and scheme-less forms are offsite with no domain", () => {
    expect(parseLink("//example.com/x")).toEqual({ onsite: false, domain: "example.com", url: "//example.com/x" });
    expect(parseLink("//www.lesswrong.com/w/bayes-rule")).toMatchObject({ onsite: true, ref: { kind: "tag", value: "bayes-rule" } });
    expect(parseLink("w/bayes-rule")).toEqual({ onsite: false, domain: "", url: "w/bayes-rule" });
    expect(parseLink("#section")).toEqual({ onsite: false, domain: "", url: "#section" });
    expect(parseLink("")).toEqual({ onsite: false, domain: "", url: "" });
  });

  it("schemes other than http(s) are their own domain; a spoofed host is offsite", () => {
    expect(parseLink("ftp://files.example.org/a")).toEqual({ onsite: false, domain: "ftp", url: "ftp://files.example.org/a" });
    expect(parseLink("javascript:alert(1)")).toEqual({ onsite: false, domain: "javascript", url: "javascript:alert(1)" });
    expect(parseLink("https://lesswrong.com@evil.org/w/x")).toEqual({ onsite: false, domain: "evil.org", url: "https://lesswrong.com@evil.org/w/x" });
  });

  it("an onsite link that names nothing the server reads has no ref; url is the input as given", () => {
    expect(parseLink("https://www.alignmentforum.org/item?id=1")).toEqual({ onsite: true, url: "https://www.alignmentforum.org/item?id=1" });
    expect(parseLink("https://www.lesswrong.com/collections/abcdefghijklmnopq")).toEqual({ onsite: true, url: "https://www.lesswrong.com/collections/abcdefghijklmnopq" });
    expect(parseLink("  https://www.lesswrong.com/w/x  ")).toMatchObject({ onsite: true, url: "  https://www.lesswrong.com/w/x  ", ref: { kind: "tag", value: "x" } });
  });
});

describe("slugify: cuts and edges", () => {
  it("cuts a long slug to 60 characters, back to the last dash unless the 61st character is a dash", () => {
    // speakingurl cuts back to the last dash, and with none in the first 60 characters its slice(0, -1) drops one more.
    expect(slugify("a".repeat(70))).toBe("a".repeat(59));
    expect(slugify("a".repeat(60) + " b")).toBe("a".repeat(60));
    expect(slugify("a".repeat(60))).toBe("a".repeat(60));
    expect(slugify("aaaaaaaaaa ".repeat(6) + "bb")).toBe("aaaaaaaaaa-".repeat(4) + "aaaaaaaaaa");
  });

  it("follows the forum's slugify (speakingurl with its defaults): symbols as words, _ kept, Latin letters folded, edit as edit-1", () => {
    expect(slugify("  --Hello,,, World!!  ")).toBe("hello-world");
    expect(slugify("Q&A with X")).toBe("q-and-a-with-x");
    expect(slugify("A & B")).toBe("a-and-b");
    expect(slugify("A | B")).toBe("a-or-b");
    expect(slugify("x<y")).toBe("x-less-than-y");
    expect(slugify("cousin_it on agency")).toBe("cousin_it-on-agency");
    expect(slugify("_ozymandias")).toBe("_ozymandias");
    expect(slugify("Café Münster")).toBe("cafe-muenster");
    expect(slugify("Axel Højmark")).toBe("axel-hojmark");
    expect(slugify("Gödel, Escher, Bach")).toBe("goedel-escher-bach");
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("Edit")).toBe("edit-1");
    // The forum names a slug with nothing left "unicode"; that is no guess at a title, so it stays empty here.
    expect(slugify("???")).toBe("");
  });
});

describe("parseRef: link forms as the site reads them", () => {
  const HASH = "#anchor ignored; if it names a comment, pass the URL as comment to target it";

  it("a profile URL's slug is read in lower case, as the site's slugify and its /user/<slug>/overview redirect read it; a bare slug keeps its case", () => {
    for (const [path, slug] of [
      ["/users/Eliezer_Yudkowsky", "eliezer_yudkowsky"], ["/user/Eliezer_Yudkowsky", "eliezer_yudkowsky"], ["/u/Eliezer_Yudkowsky", "eliezer_yudkowsky"],
      ["/user/Yvain/overview/", "yvain"], ["/users/Yvain/replies", "yvain"], ["/user/Eugine_Nier", "eugine_nier"],
    ] as const) {
      expect(parseRef("user", `https://www.lesswrong.com${path}`, ["user"]), path).toMatchObject({ kind: "user", form: "slug", value: slug, given: "url" });
    }
    expect(parseRef("user", "Yvain", ["user"])).toMatchObject({ form: "slug", value: "Yvain", given: "slug" });
    // The rest of the site's slugify for these characters: runs of "-" as one, none at the ends, edit as edit-1, nothing as unicode.
    for (const [path, slug] of [["/users/-Foo-", "foo"], ["/users/foo--bar", "foo-bar"], ["/u/Edit", "edit-1"], ["/user/---", "unicode"]] as const) {
      expect(parseRef("user", `https://www.lesswrong.com${path}`, ["user"]), path).toMatchObject({ form: "slug", value: slug });
    }
  });

  it("a #<id> on a post URL may name a comment, as the site's post page reads it: a comment for a comment parameter, the post with a note otherwise", () => {
    const u = `https://www.lesswrong.com/posts/${P}/agi-ruin#${C}`;
    expect(parseRef("comment", u, ["comment"])).toEqual({ kind: "comment", form: "id", value: C, given: "url", notes: [], anchorOf: P });
    expect(parseRef("post", u, ["post"])).toEqual({ kind: "post", form: "id", value: P, given: "url", notes: [HASH] });
    expect(parseRef("comment", `https://www.lesswrong.com/posts/${P}#${C}`, ["comment"])).toMatchObject({ value: C, anchorOf: P });
    // ?commentId= wins over the hash, as on the site; a heading anchor is no comment.
    const S2 = "Q7CbRuCtSBodKi3Ns";
    expect(parseRef("comment", `https://www.lesswrong.com/posts/${P}/x?commentId=${S2}#${C}`, ["comment"])).toEqual({ kind: "comment", form: "id", value: S2, given: "url", notes: [] });
    expect(parseRef("post", `https://www.lesswrong.com/posts/${P}/agi-ruin#Section_1__Intro`, ["post"])).toEqual({ kind: "post", form: "id", value: P, given: "url", notes: [] });
    expect(badInputMessage(() => parseRef("comment", `https://www.lesswrong.com/posts/${P}/agi-ruin#Section_1__Intro`, ["comment"]))).toBe(
      "comment: that URL is a post; this parameter takes a comment.",
    );
  });

  it("GreaterWrong's #comment-<id> names a comment", () => {
    const u = `https://www.greaterwrong.com/posts/${P}/agi-ruin#comment-${C}`;
    expect(parseRef("comment", u, ["comment"])).toEqual({ kind: "comment", form: "id", value: C, given: "url", notes: [] });
    expect(parseRef("post", u, ["post"])).toEqual({ kind: "post", form: "id", value: P, given: "url", notes: [NOTE] });
  });

  it("?lens= or ?l= on a wiki page URL picks a tab of that page: the page is read, and a note names the lens to pass instead", () => {
    const LENS = (lens: string) => `lens "${lens}" ignored; pass it as tag to read that lens`;
    for (const u of [
      "https://www.lesswrong.com/w/bayes-rule?lens=bayes-rule-odds", "https://www.lesswrong.com/w/bayes-rule?l=bayes-rule-odds",
      "https://www.lesswrong.com/tag/bayes-rule?lens=bayes-rule-odds", "https://www.lesswrong.com/p/bayes-rule?l=bayes-rule-odds",
      "https://www.lesswrong.com/w/bayes-rule?lens=bayes-rule-odds&l=other",
    ]) {
      expect(parseRef("tag", u, ["tag"]), u).toEqual({ kind: "tag", form: "slug", value: "bayes-rule", given: "url", notes: [LENS("bayes-rule-odds")] });
    }
    expect(parseRef("tag", "https://arbital.com/p/bayes_rule/?l=1zq", ["tag"])).toEqual({ kind: "tag", form: "slug", value: "bayes_rule", given: "url", notes: [LENS("1zq")] });
    expect(parseRef("tag", "https://www.lesswrong.com/w/bayes-rule?lens=main", ["tag"])).toEqual({ kind: "tag", form: "slug", value: "bayes-rule", given: "url", notes: [] });
    expect(parseRef("tag", "https://www.lesswrong.com/w/bayes-rule?lens=not%20a%20slug", ["tag"])).toMatchObject({ value: "bayes-rule", notes: [] });
    expect(parseLink("https://www.lesswrong.com/w/bayes-rule?lens=bayes-rule-odds")).toMatchObject({ onsite: true, ref: { kind: "tag", value: "bayes-rule" } });
  });

  it("/books is the bestoflesswrong collection; /bestoflesswrong is the review winners page, which get_feed lists", () => {
    expect(parseRef("sequence", "https://www.lesswrong.com/books", ["sequence"])).toEqual({ kind: "sequence", form: "collection", value: "bestoflesswrong", given: "url", notes: [] });
    expect(badInputMessage(() => parseRef("sequence", "https://www.lesswrong.com/bestoflesswrong/2023", ["sequence"]))).toContain("is not a forum page this server reads");
    for (const u of ["https://www.lesswrong.com/bestoflesswrong", "https://www.lesswrong.com/bestoflesswrong/2023/ai", "https://www.lesswrong.com/leastwrong"]) {
      expect(badInputMessage(() => parseRef("sequence", u, ["sequence"])), u).toBe(
        `sequence: "${u}" is the Best of LessWrong page of Annual Review winners, not a sequence; the bestoflesswrong collection's page is /books. `
        + 'For the winners, use get_feed {feed: "best_of"}; for the collection, give bestoflesswrong.',
      );
    }
  });

  it("a slug may start with an underscore or a hyphen, as some real slugs do", () => {
    expect(parseRef("user", "_ozymandias", ["user"])).toMatchObject({ kind: "user", form: "slug", value: "_ozymandias", given: "slug" });
    expect(parseRef("tag", "_a", ["tag"])).toMatchObject({ kind: "tag", form: "slug", value: "_a" });
    expect(parseRef("user", "https://www.lesswrong.com/users/_ozymandias", ["user"])).toMatchObject({ form: "slug", value: "_ozymandias" });
    expect(parseRef("tag", "https://www.lesswrong.com/w/_a", ["tag"])).toMatchObject({ form: "slug", value: "_a" });
    expect(parseLink("https://www.lesswrong.com/w/_a")).toMatchObject({ onsite: true, ref: { kind: "tag", value: "_a" } });
  });

  it("an old wiki URL is refused as what it is, with the page's name for find", () => {
    expect(badInputMessage(() => parseRef("tag", "http://wiki.lesswrong.com/wiki/Paperclip_maximizer", ["tag"]))).toBe(
      'tag: "http://wiki.lesswrong.com/wiki/Paperclip_maximizer" is a page of the old LessWrong wiki, which this server doesn\'t read; its pages were imported into this site\'s wiki. '
      + 'To look up a topic or wiki page by name, use find {items: [{kind: "tag", query: "Paperclip maximizer"}]}.',
    );
    expect(badInputMessage(() => parseRef("tag", "https://wiki.lesswrong.com/wiki/Bayes%27_theorem", ["tag"]))).toContain('query: "Bayes\' theorem"');
    expect(badInputMessage(() => parseRef("tag", "wiki.lesswrong.com/wiki/Paperclip_maximizer", ["tag"]))).toContain('is a page of the old LessWrong wiki');
    expect(badInputMessage(() => parseRef("tag", "wiki.lesswrong.com/wiki/Paperclip_maximizer", ["tag"]))).toContain('query: "Paperclip maximizer"');
    expect(badInputMessage(() => parseRef("tag", "http://wiki.lesswrong.com/", ["tag"]))).toBe(
      'tag: "http://wiki.lesswrong.com/" is a page of the old LessWrong wiki, which this server doesn\'t read; its pages were imported into this site\'s wiki. '
      + "Give a tag id, a wiki page URL, or the exact slug.",
    );
    // The site's own list of its hosts leaves the old wiki out, so a link to it stays an external one.
    expect(parseLink("http://wiki.lesswrong.com/wiki/Paperclip_maximizer")).toEqual({ onsite: false, domain: "wiki.lesswrong.com", url: "http://wiki.lesswrong.com/wiki/Paperclip_maximizer" });
  });
});
