// Layer 5 leaf. Every constant of the server in one deeply frozen object: transport and politeness (¶7, D12, D13),
// per-call caps, cache sizes and TTLs (¶2.3), the cursor store (C1, ¶3.6), search page sizes, paging limits (¶3.6),
// rendering budgets and caps (¶3.7), and the hard-coded ids and tables (P6 cutoff, collections, debate posts,
// front-page and core tags, abbreviations, reaction sets). Values come from the spec; the tests assert them one by one.
import type { CacheNs, CollectionSlug, HttpConfig, ToolName } from "./types";

/** The manifest and package.json version; D12 puts it in the User-Agent and a test keeps all three equal. */
const VERSION = "1.0.0";

/** The machine name: package.json and manifest.json `name`, the MCP serverInfo name and the bundle's file stem; a test keeps them equal. */
const NAME = "lesswrong-mcp";

/** The development environment variables. The installed extension sets none. */
export const ENV_VARS = {
  debug: "LESSWRONG_MCP_DEBUG",
  fetchTripwire: "LESSWRONG_MCP_FETCH_TRIPWIRE",
} as const;

/** Freezes `value` and everything reachable from it, so a stray assignment throws instead of changing a limit. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CONFIG = deepFreeze({
  name: NAME,
  version: VERSION,

  /** D12, D13, ¶7: transport. A test builds its own copy through `httpConfigWith`. */
  http: {
    graphqlUrl: "https://www.lesswrong.com/graphql",
    searchUrl: "https://www.lesswrong.com/api/search",
    userAgent: `lesswrong-mcp/${VERSION} (read-only research extension for Claude Desktop; single user; one request at a time)`,
    spacingMs: 3000,                 // minimum time between request starts
    maxSpacingMs: 30000,             // the spacing doubles after a 429, a 503 or a non-JSON 200, up to this
    halveAfterSuccesses: 10,         // and halves after this many consecutive successes
    retryDelayMs: 3000,              // base delay of an in-call retry, before jitter
    retryJitter: 0.2,
    retryAfterCapMs: 900000,         // 15 minutes
    pausesMs: [60000, 300000, 900000], // escalating process-wide pauses: 1, 5, then 15 minutes per consecutive episode
    episodeResetMs: 1800000,         // an episode is forgotten after 30 minutes
    inCallRetryMaxWaitMs: 10000,     // a 429/503 is retried within a call only if the pause ends within this
    inCallRetriesMax: 2,
    requestTimeoutMaxMs: 45000,
    maxResponseBytes: 12582912,      // 12 MB: a larger response is aborted
    sessionWindows: [                // D13 rolling windows (1 MB = 1,048,576 bytes)
      { ms: 600000, requests: 150, bytes: 104857600, label: "10 minutes" },
      { ms: 86400000, requests: 1500, bytes: 524288000, label: "24 hours" },
    ],
    responseTtlMs: 300000,           // raw-response cache (key prefix `http:`), 5 minutes
  } as const satisfies HttpConfig,

  /** ¶7: one call's deadline, byte cap and per-tool forum-request caps. */
  call: {
    deadlineMs: 50000,
    noNewRequestAfterMs: 40000,
    maxCallBytes: 20971520,          // 20 MB downloaded per call
    maxRequests: {
      find: 3, search: 5, get_post: 3, get_comments: 4, list_posts: 6, list_comments: 5, get_user: 4, get_tag: 2,
      get_sequence: 3, list_sequences: 5, get_history: 7, first_use: 7, get_links: 4, get_reactions: 3, get_feed: 2, list_tags: 2,
    } as const satisfies Record<ToolName, number>,
  },

  /** ¶2.3: one LRU shared by the raw-response cache and the named caches. */
  cache: {
    maxBytes: 67108864,              // 64 MB
    ttlMs: {
      resolve: 1800000, negative: 300000, forest: 600000, body: 1800000, rev: 600000, revuser: 600000, revtext: 21600000,
      scan: 600000, seqset: 600000, tagcat: 3600000, coregroup: 3600000, collections: 86400000, winners: 3600000,
      feed: 120000, spotlight: 1800000,
    } as const satisfies Record<CacheNs, number>,
  },

  /** C1, ¶3.6: the in-memory cursor store. */
  cursor: { maxEntries: 1000, ttlMs: 3600000 },

  /** ¶7, §5: search page sizes, the estimated size of a hit, the per-request byte budget and the depth limit. */
  search: {
    hitsPerPage: { posts: 10, comments: 20, users: 10, tags: 10, sequences: 20 },
    estBytesPerHit: { posts: 30720, comments: 3072, users: 20480, tags: 15360, sequences: 3072 },
    maxRequestBytes: 4194304,        // a search POST is built only while its estimated response stays under 4 MB
    maxDepth: 10000,                 // page × hitsPerPage + hitsPerPage
    findWikiOnlyHits: 3,             // the second `tags` query of `find` (wiki-only pages are buried, ¶4.1)
  },

  /** ¶3.6 paging limits, plus the sizes of the batched requests of ¶4.4, ¶4.10 and ¶4.11. */
  paging: {
    maxOffset: 2000,
    rawPageMax: 100,                 // raw page size = min(rawPageMax, max(2 × limit, rawPageMin))
    rawPageMin: 20,
    lightScanCap: 2000,
    scanRows: 500,                   // af_only comment scans: rows per raw page
    scanPagesMax: 3,                 // and raw pages per call
    depthGuard: 500,
    emptyPageRetries: 2,
    windowDaysMax: 31,               // site-wide comment `top` and quick-take windows
    forestLimit: 5000,               // a comment list returning exactly this many rows is marked truncated
    revisionPage: 1000,
    sequenceSetRows: 1000,
    sequenceSetPages: 3,
    bodiesPerAlias: 300,             // comment ids per bodies alias
    bodiesAllMaxBytes: 409600,       // about 400 KB: up to this estimate every body is fetched in one request
    bytesPerWord: 7,                 // a comment's body size is estimated as wordCount × 7 bytes
    maxAliases: 100,                 // R11: aliases per operation
  },

  /** ¶3.7: the page budget, the shares of the capped blocks and the caps on forum text. */
  render: {
    fill: 0.95,                      // pages are filled to at most this share of max_tokens
    shares: { outline: 0.25, signals: 0.15, replyMap: 0.25 },
    getTagTextMinShare: 0.4,
    listCommentCapTokens: 1500,
    bioCapTokens: 3000,
    excerptChars: 280,
    sequenceExcerptChars: 200,
    bioCardChars: 150,
    signalsMax: 10,
    cruxMax: 10,
    mindChangeMax: 10,
    reactsShown: 6,
    replyBackIdsMax: 5,
    caps: { name: 60, title: 300, snippet: 300, reactQuote: 200, signalQuote: 100, message: 200 },
  },

  /** P6: a comment by an unreviewed author posted at or after this instant (inclusive) is hidden; one posted before it stays visible. */
  unreviewedCutoff: "2023-04-04T18:54:35.895Z",

  /** §11.5: the collection ids; a collection is found by its slug in `CollectionSlug`. */
  collections: {
    rationality: "oneQyj4pw77ynzwAF", codex: "2izXHCrmJ684AnZ5X", hpmor: "ywQvGBSojSQZTMpLh",
    highlights: "62bf5f5dc581cd211cc67d49", bestoflesswrong: "nmk3nLpQE89dMRzzN",
  } as const satisfies Record<CollectionSlug, string>,

  /** ¶4.1: names `find` accepts for a collection (case-insensitively). */
  collectionAliases: {
    rationality: ["Rationality: A-Z", "The Sequences", "R:A-Z", "Rationality from AI to Zombies"],
    hpmor: ["HPMOR", "Harry Potter and the Methods of Rationality"],
    highlights: ["Sequence Highlights", "Highlights from the Sequences"],
    codex: ["The Codex"],
    bestoflesswrong: ["Best of LessWrong"],
  } as const satisfies Record<CollectionSlug, readonly string[]>,

  /** §6.6, Q109: the six debate posts whose comments are debate turns. */
  debatePostIds: [
    "qbcuk8WwFnTZcXTd6", "iNYdKoGsh4ffxbQ5t", "vJagsfKmQKeaW5oG3", "baKauxzSqunE6Aakm", "ipaWHTiEwEqtuvzrP", "kXiAGRWFquXFMi68Y",
  ],

  /** The seven core tags; messages name them. Core status itself is read from the resolved tag's `core` flag. */
  coreTags: [
    { slug: "rationality", name: "Rationality" }, { slug: "ai", name: "AI" }, { slug: "world-modeling", name: "World Modeling" },
    { slug: "world-optimization", name: "World Optimization" }, { slug: "practical", name: "Practical" },
    { slug: "community", name: "Community" }, { slug: "site-meta", name: "Site Meta" },
  ],

  /**
   * ¶4.15: the two tags the logged-out front page boosts as `TagDefault` entries of the `magic` view's
   * `filterSettings` (+10 to a post's score when its relevance is above 0); they filter nothing.
   */
  frontpageTags: [
    { tagId: "Ng8Gice9KNkncxqcj", tagName: "Rationality" },
    { tagId: "3uE2pXvbcnS9nnZRE", tagName: "World Modeling" },
  ],

  /** ¶4.1: abbreviations `find` expands, matched case-insensitively against the whole query, also with a trailing "s". */
  abbreviations: [
    { abbr: "LLM", long: "large language models" }, { abbr: "RLHF", long: "reinforcement learning from human feedback" },
    { abbr: "AGI", long: "artificial general intelligence" }, { abbr: "ML", long: "machine learning" },
    { abbr: "EA", long: "effective altruism" }, { abbr: "FDT", long: "functional decision theory" },
    { abbr: "UDT", long: "updateless decision theory" }, { abbr: "CEV", long: "coherent extrapolated volition" },
    { abbr: "ELK", long: "eliciting latent knowledge" }, { abbr: "SAE", long: "sparse autoencoders" },
    { abbr: "IDA", long: "iterated amplification" }, { abbr: "HPMOR", long: "Harry Potter and the Methods of Rationality" },
    { abbr: "mech interp", long: "mechanistic interpretability" },
  ],

  /** ¶3.8.6: reaction names behind the disagreement, crux and mind-change signals. */
  reactionSets: {
    disagreement: ["disagree", "notacrux", "shakyPremise", "locallyInvalid", "strawman"],
    crux: ["crux"],
    mindChange: ["changemind"],
  },

  /** The `groups` entry that marks an Alignment Forum member. */
  afGroup: "alignmentForum",
} as const);

/** A fresh, unfrozen copy of the transport settings with `over` applied (tests: `spacingMs: 0`, short windows). */
export function httpConfigWith(over: Partial<HttpConfig>): HttpConfig {
  return { ...CONFIG.http, ...over };
}
