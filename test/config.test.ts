import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG, httpConfigWith } from "../src/config";

describe("config constants (¶7, ¶2.3, ¶3.6, ¶3.7, D12, D13)", () => {
  it("D12 User-Agent names the project and its version, which equals package.json's", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(CONFIG.version).toBe("1.0.0");
    expect(CONFIG.version).toBe(pkg.version);
    expect(CONFIG.http.userAgent).toBe(
      "lesswrong-mcp/1.0.0 (read-only research extension for Claude Desktop; single user; one request at a time)",
    );
  });

  it("D13 and ¶7 transport values", () => {
    expect(CONFIG.http).toEqual({
      graphqlUrl: "https://www.lesswrong.com/graphql",
      searchUrl: "https://www.lesswrong.com/api/search",
      userAgent: "lesswrong-mcp/1.0.0 (read-only research extension for Claude Desktop; single user; one request at a time)",
      spacingMs: 3000,
      maxSpacingMs: 30000,
      halveAfterSuccesses: 10,
      retryDelayMs: 3000,
      retryJitter: 0.2,
      retryAfterCapMs: 900000,
      pausesMs: [60000, 300000, 900000],
      episodeResetMs: 1800000,
      inCallRetryMaxWaitMs: 10000,
      inCallRetriesMax: 2,
      requestTimeoutMaxMs: 45000,
      maxResponseBytes: 12582912,
      sessionWindows: [
        { ms: 600000, requests: 150, bytes: 104857600, label: "10 minutes" },
        { ms: 86400000, requests: 1500, bytes: 524288000, label: "24 hours" },
      ],
      responseTtlMs: 300000,
    });
  });

  it("¶7 per-call deadline, byte cap and request caps", () => {
    expect(CONFIG.call).toEqual({
      deadlineMs: 50000,
      noNewRequestAfterMs: 40000,
      maxCallBytes: 20971520,
      maxRequests: {
        find: 3, search: 5, get_post: 3, get_comments: 4, list_posts: 6, list_comments: 5, get_user: 4, get_tag: 2,
        get_sequence: 3, list_sequences: 5, get_history: 7, first_use: 7, get_links: 4, get_reactions: 3, get_feed: 2, list_tags: 2,
      },
    });
  });

  it("¶2.3 cache cap and TTLs; C1 cursor store", () => {
    expect(CONFIG.cache).toEqual({
      maxBytes: 67108864,
      ttlMs: {
        resolve: 1800000, negative: 300000, forest: 600000, body: 1800000, rev: 600000, revuser: 600000, revtext: 21600000,
        scan: 600000, seqset: 600000, tagcat: 3600000, coregroup: 3600000, collections: 86400000, winners: 3600000,
        feed: 120000, spotlight: 1800000,
      },
    });
    expect(CONFIG.cursor).toEqual({ maxEntries: 1000, ttlMs: 3600000 });
  });

  it("¶7 search page sizes and byte budget; ¶3.6 paging limits", () => {
    expect(CONFIG.search).toEqual({
      hitsPerPage: { posts: 10, comments: 20, users: 10, tags: 10, sequences: 20 },
      estBytesPerHit: { posts: 30720, comments: 3072, users: 20480, tags: 15360, sequences: 3072 },
      maxRequestBytes: 4194304,
      maxDepth: 10000,
      findWikiOnlyHits: 3,
    });
    expect(CONFIG.paging).toEqual({
      maxOffset: 2000, rawPageMax: 100, rawPageMin: 20, lightScanCap: 2000, scanRows: 500, scanPagesMax: 3, depthGuard: 500,
      emptyPageRetries: 2, windowDaysMax: 31, forestLimit: 5000, revisionPage: 1000, sequenceSetRows: 1000, sequenceSetPages: 3,
      bodiesPerAlias: 300, bodiesAllMaxBytes: 409600, bytesPerWord: 7, maxAliases: 100,
    });
  });

  it("¶3.7 budget, shares and caps", () => {
    expect(CONFIG.render).toEqual({
      fill: 0.95, shares: { outline: 0.25, signals: 0.15, replyMap: 0.25 }, getTagTextMinShare: 0.4,
      listCommentCapTokens: 1500, bioCapTokens: 3000, excerptChars: 280, sequenceExcerptChars: 200, bioCardChars: 150,
      signalsMax: 10, cruxMax: 10, mindChangeMax: 10, reactsShown: 6, replyBackIdsMax: 5,
      caps: { name: 60, title: 300, snippet: 300, reactQuote: 200, signalQuote: 100, message: 200 },
    });
  });

  it("P6 cutoff, §11.5 collections, Q109 the 6 debate posts, ¶4.15 front-page tags, the 7 core tags, AF group", () => {
    expect(CONFIG.unreviewedCutoff).toBe("2023-04-04T18:54:35.895Z");
    expect(CONFIG.collections).toEqual({
      rationality: "oneQyj4pw77ynzwAF", codex: "2izXHCrmJ684AnZ5X", hpmor: "ywQvGBSojSQZTMpLh",
      highlights: "62bf5f5dc581cd211cc67d49", bestoflesswrong: "nmk3nLpQE89dMRzzN",
    });
    expect(CONFIG.debatePostIds).toEqual([
      "qbcuk8WwFnTZcXTd6", "iNYdKoGsh4ffxbQ5t", "vJagsfKmQKeaW5oG3", "baKauxzSqunE6Aakm", "ipaWHTiEwEqtuvzrP", "kXiAGRWFquXFMi68Y",
    ]);
    expect(CONFIG.frontpageTags).toEqual([
      { tagId: "Ng8Gice9KNkncxqcj", tagName: "Rationality" },
      { tagId: "3uE2pXvbcnS9nnZRE", tagName: "World Modeling" },
    ]);
    expect(CONFIG.coreTags).toEqual([
      { slug: "rationality", name: "Rationality" }, { slug: "ai", name: "AI" }, { slug: "world-modeling", name: "World Modeling" },
      { slug: "world-optimization", name: "World Optimization" }, { slug: "practical", name: "Practical" },
      { slug: "community", name: "Community" }, { slug: "site-meta", name: "Site Meta" },
    ]);
    expect(CONFIG.afGroup).toBe("alignmentForum");
  });

  it("¶4.1 abbreviation and collection alias tables; ¶3.8.6 reaction sets", () => {
    expect(CONFIG.abbreviations).toEqual([
      { abbr: "LLM", long: "large language models" }, { abbr: "RLHF", long: "reinforcement learning from human feedback" },
      { abbr: "AGI", long: "artificial general intelligence" }, { abbr: "ML", long: "machine learning" },
      { abbr: "EA", long: "effective altruism" }, { abbr: "FDT", long: "functional decision theory" },
      { abbr: "UDT", long: "updateless decision theory" }, { abbr: "CEV", long: "coherent extrapolated volition" },
      { abbr: "ELK", long: "eliciting latent knowledge" }, { abbr: "SAE", long: "sparse autoencoders" },
      { abbr: "IDA", long: "iterated amplification" }, { abbr: "HPMOR", long: "Harry Potter and the Methods of Rationality" },
      { abbr: "mech interp", long: "mechanistic interpretability" },
    ]);
    expect(CONFIG.collectionAliases).toEqual({
      rationality: ["Rationality: A-Z", "The Sequences", "R:A-Z", "Rationality from AI to Zombies"],
      hpmor: ["HPMOR", "Harry Potter and the Methods of Rationality"],
      highlights: ["Sequence Highlights", "Highlights from the Sequences"],
      codex: ["The Codex"],
      bestoflesswrong: ["Best of LessWrong"],
    });
    expect(CONFIG.reactionSets).toEqual({
      disagreement: ["disagree", "notacrux", "shakyPremise", "locallyInvalid", "strawman"],
      crux: ["crux"],
      mindChange: ["changemind"],
    });
  });

  it("is deeply frozen; httpConfigWith returns an overridden copy", () => {
    expect(Object.isFrozen(CONFIG)).toBe(true);
    expect(Object.isFrozen(CONFIG.http.sessionWindows[0])).toBe(true);
    expect(Object.isFrozen(CONFIG.abbreviations[12])).toBe(true);
    expect(() => {
      (CONFIG.http as { spacingMs: number }).spacingMs = 0;
    }).toThrow(TypeError);
    const h = httpConfigWith({ spacingMs: 0 });
    expect(h.spacingMs).toBe(0);
    expect({ ...h, spacingMs: 3000 }).toEqual(CONFIG.http);
    expect(CONFIG.http.spacingMs).toBe(3000);
  });
});
