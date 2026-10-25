import { describe, expect, it } from "vitest";
import { excerptOf, toPostRecord } from "../../src/domain/posts";
import { postStatus } from "../../src/domain/status";
import { postUrl, sequenceUrl, tagUrl, userUrl } from "../../src/domain/urls";
import type { Person, RawTagRef } from "../../src/types";
import { SAMPLE_PERSON, rawPostCard, rawPostFull, rawTagRef, rawUserRef, seedId, withExtra } from "../support/builders";

const EY = rawUserRef({ _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" });
const AXEL = rawUserRef({ _id: "EE3myGHTpvb8h9hb5", slug: "axel-hojmark", displayName: "Axel Højmark" });
const MILO = rawUserRef({ _id: "zYJkmzdHTxeXQFjHT", slug: "milo-moses", displayName: "Milo Moses" });
const EY_PERSON: Person = { kind: "user", id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky" };

const tag = (id: string, name: string, slug: string, o: Partial<RawTagRef> = {}): RawTagRef =>
  rawTagRef({ _id: id, name, slug, core: false, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false, ...o });
const T_AI = tag("sYm3HiWcfZvrGu3ui", "AI", "ai", { core: true });
const T_RISK = tag(seedId(101), "AI Risk", "ai-risk");
const T_THREAT = tag(seedId(102), "Threat Models", "threat-models");
const T_FUZZIES = tag(seedId(103), "Fuzzies", "fuzzies");
const T_MEETUPS = tag(seedId(104), "Meetups (specific examples)", "meetups-specific-examples");
const T_ADMIN = tag("PLANTEDadminTag01", "PLANTED-P12-tag", "planted-p12-tag", { adminOnly: true });

const EXCERPT_TEXT = "Preamble: (If you're already familiar with all basics and don't want any preamble, skip ahead to Section B for technical difficulties of alignment proper.)";

const AGI = rawPostCard({
  _id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities", slug: "agi-ruin-a-list-of-lethalities",
  af: true, question: false, rejected: false, unlisted: false, shortform: false, hideAuthor: false, isEvent: false,
  hiddenRelatedQuestion: false, groupId: null,
  postedAt: "2022-06-05T22:05:52.224Z", baseScore: 1055, voteCount: 612, afBaseScore: 156,
  commentCount: 717, afCommentCount: 145, url: null, debate: false, collabEditorDialogue: false,
  curatedDate: "2022-06-07T17:00:00.000Z", frontpageDate: "2022-06-06T00:00:00.000Z", sticky: false, legacy: false,
  lastCommentedAt: "2026-10-19T14:02:00.000Z", userId: "nmk3nLpQE89dMRzzN", user: EY, coauthors: [],
  tags: [T_THREAT, T_FUZZIES, T_RISK, T_MEETUPS, T_AI],
  tagRelevance: { [seedId(101)]: 25, [seedId(102)]: 12, sYm3HiWcfZvrGu3ui: 9, [seedId(103)]: 1, [seedId(104)]: 1 },
  reviewWinner: { reviewYear: 2022, category: "ai safety", reviewRanking: 0 },
  contents: { plaintextDescription: EXCERPT_TEXT },
});
/** A made-up post by a made-up person, with AGI's other fields and also an admin-only tag: the subject of the hidden-state tests. */
const SAMPLE = rawPostCard({
  ...AGI, _id: "samplePost0000001", title: "A sample post", slug: "a-sample-post", userId: SAMPLE_PERSON._id, user: rawUserRef(SAMPLE_PERSON),
  tags: [...AGI.tags, T_ADMIN], tagRelevance: { ...AGI.tagRelevance, PLANTEDadminTag01: 30 },
});
const COAUTHOR = rawUserRef({ _id: "sampleCoauthor001", slug: "sample-coauthor", displayName: "Sample Coauthor" });
const GLM = rawPostCard({
  ...AGI, _id: "R5g8YT25G9DXJJ48n", title: "GLM-5.3 Sometimes Considers How Train-Time Actions Shape Future Behavior",
  slug: "glm-5-3-sometimes-considers-how-train-time-actions-shape", af: false, afBaseScore: 34, reviewWinner: null,
});

const tagOut = (id: string, name: string, slug: string, relevance: number) =>
  ({ tag: { hidden: false, id, name, slug, wikiOnly: false }, relevance });
const EXPECTED_TAGS = [
  tagOut(seedId(101), "AI Risk", "ai-risk", 25),
  tagOut(seedId(102), "Threat Models", "threat-models", 12),
  tagOut("sYm3HiWcfZvrGu3ui", "AI", "ai", 9),
  tagOut(seedId(103), "Fuzzies", "fuzzies", 1),
  tagOut(seedId(104), "Meetups (specific examples)", "meetups-specific-examples", 1),
];

describe("toPostRecord", () => {
  it("¶3.8.1 maps every field of the post list form", () => {
    expect(toPostRecord(AGI)).toEqual({
      id: "uMQ3cqWDPHhjtiesc", title: "AGI Ruin: A List of Lethalities",
      url: "https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities",
      authors: [EY_PERSON],
      postedAt: "2022-06-05T22:05:52.224Z", postedMs: 1654466752224,
      karma: 1055, votes: 612, af: true, afKarma: 156, commentCount: 717, afCommentCount: 145,
      status: {
        curatedDate: "2022-06-07T17:00:00.000Z", frontpage: true, pinned: false,
        bestOf: { year: 2022, category: "ai safety", rank: 1 },
        question: false, dialogue: false, debate: false, event: false, shortform: false,
        subQuestion: false, groupPost: false, unlisted: false, placeholderDate: false,
      },
      lastCommentedAt: "2026-10-19T14:02:00.000Z",
      tags: EXPECTED_TAGS,
    });
  });

  it("¶3.5 ¶3.1.3 a non-AF post links to lesswrong.com and has no AF karma (GLM: afBaseScore 34)", () => {
    expect(toPostRecord(GLM)).toMatchObject({
      url: "https://www.lesswrong.com/posts/R5g8YT25G9DXJJ48n/glm-5-3-sometimes-considers-how-train-time-actions-shape",
      af: false, afKarma: null,
    });
  });

  it("authors: the owner first, then coauthors; a null owner is account not publicly visible", () => {
    const co = toPostRecord({ ...AGI, coauthors: [AXEL, MILO] });
    expect(co.authors).toEqual([
      EY_PERSON,
      { kind: "user", id: "EE3myGHTpvb8h9hb5", slug: "axel-hojmark", name: "Axel Højmark" },
      { kind: "user", id: "zYJkmzdHTxeXQFjHT", slug: "milo-moses", name: "Milo Moses" },
    ]);
    const orphan = toPostRecord({ ...AGI, user: null, coauthors: null });
    expect(orphan.authors).toEqual([{ kind: "none", why: "account not publicly visible" }]);
  });

  it("P7 Q116 a hideAuthor post names nobody", () => {
    const anonymous = toPostRecord({ ...SAMPLE, hideAuthor: true, coauthors: [COAUTHOR] });
    expect(anonymous.authors).toEqual([{ kind: "none", why: "author not publicly visible" }]);
    expect(JSON.stringify(anonymous)).not.toMatch(/samplePerson00001|sample[- ]person|sampleCoauthor001|sample[- ]coauthor/i);
  });

  it("Q50.10 P12 tags are the visible tags by relevance, high first, with their number; one-vote stray tags sort last", () => {
    const rec = toPostRecord(SAMPLE);
    expect(rec.tags).toEqual(EXPECTED_TAGS);
    expect(JSON.stringify(rec)).not.toMatch(/PLANTED|planted/);
    const noRelevance = toPostRecord({ ...SAMPLE, tagRelevance: null });
    expect(noRelevance.tags.map((t) => [t.tag.slug, t.relevance])).toEqual([
      ["threat-models", 0], ["fuzzies", 0], ["ai-risk", 0], ["meetups-specific-examples", 0], ["ai", 0],
    ]);
  });

  it("Q50.25 the excerpt comes from plaintextDescription only when asked, at most 280 characters", () => {
    expect(toPostRecord(AGI).excerpt).toBeUndefined();
    expect(toPostRecord(AGI, { excerpt: true }).excerpt).toBe(EXCERPT_TEXT);
    expect(toPostRecord({ ...AGI, contents: { plaintextDescription: "x".repeat(400) } }, { excerpt: true }).excerpt)
      .toBe("x".repeat(279) + "…");
    expect(toPostRecord({ ...AGI, contents: null }, { excerpt: true }).excerpt).toBeUndefined();
  });

  it("Q50.1 Q50.4 Q50.6 Q50.16 score, maxBaseScore, topLevelCommentCount and other stale fields are never carried", () => {
    const raw = withExtra(SAMPLE, {
      score: 909090.5, maxBaseScore: 808080, topLevelCommentCount: 707070, totalDialogueResponseCount: 606060,
      afLastCommentedAt: "PLANTED-Q50.6-afLastCommentedAt", modifiedAt: "PLANTED-Q50.6-modifiedAt",
      author: "PLANTED-Q50.6-author", postCategory: "PLANTED-Q50.6-category", afDate: "PLANTED-Q50.6-afDate",
      reviewedByUserId: "PLANTED-Q50.6-reviewer", mostRecentPublishedDialogueResponseDate: "PLANTED-Q50.16-date",
      recentComments: [{ _id: "PLANTED-Q50.16-comment" }],
    });
    const text = JSON.stringify(toPostRecord(raw, { excerpt: true }));
    for (const marker of ["909090", "808080", "707070", "606060", "PLANTED"]) expect(text).not.toContain(marker);
  });
});

describe("toPostRecord, further cases", () => {
  it("P12 hidden tags are dropped; wiki-only and placeholder pages stay, wiki-only ones flagged", () => {
    const wiki = tag(seedId(201), "A wiki page", "a-wiki-page", { wikiOnly: true });
    const placeholder = tag(seedId(202), "A placeholder", "a-placeholder", { isPlaceholderPage: true });
    const deleted = tag("PLANTEDdeletedTag1", "PLANTED-P12-deleted", "planted-p12-deleted", { deleted: true });
    const rec = toPostRecord({ ...SAMPLE, tags: [deleted, wiki, T_ADMIN, placeholder], tagRelevance: null });
    expect(rec.tags).toEqual([
      { tag: { hidden: false, id: seedId(201), name: "A wiki page", slug: "a-wiki-page", wikiOnly: true }, relevance: 0 },
      { tag: { hidden: false, id: seedId(202), name: "A placeholder", slug: "a-placeholder", wikiOnly: false }, relevance: 0 },
    ]);
    expect(JSON.stringify(rec)).not.toMatch(/PLANTED|planted/);
  });

  it("Q50.25 a POST_FULL row has no plaintextDescription key, so it gets no excerpt even when one is asked for", () => {
    const full = rawPostFull({ contents: { version: "1.0.0", editedAt: "2022-06-05T22:05:52.224Z", markdown: "A long body.", originalContents: null } });
    const rec = toPostRecord(full, { excerpt: true });
    expect(rec.excerpt).toBeUndefined();
    expect("excerpt" in rec).toBe(false);
    expect(rec.id).toBe(full._id);
  });

  it("¶3.8.1 lastCommentedAt is present only when the forum gave one; a blank excerpt is left out", () => {
    const rec = toPostRecord({ ...AGI, lastCommentedAt: null, contents: { plaintextDescription: "  \n " } }, { excerpt: true });
    expect("lastCommentedAt" in rec).toBe(false);
    expect("excerpt" in rec).toBe(false);
  });
});

describe("excerptOf", () => {
  it("Q50.25 at most 280 characters, ending … when cut; single line; none for empty text", () => {
    expect(excerptOf(null)).toBeUndefined();
    expect(excerptOf(undefined)).toBeUndefined();
    expect(excerptOf("")).toBeUndefined();
    expect(excerptOf("   ")).toBeUndefined();
    expect(excerptOf("x".repeat(280))).toBe("x".repeat(280));
    expect(excerptOf("x".repeat(281))).toBe("x".repeat(279) + "…");
    expect(excerptOf("line one\nline two")).toBe("line one line two");
    expect(excerptOf("y".repeat(200), 150)).toBe("y".repeat(149) + "…");
  });
});

describe("postStatus (¶3.8.2)", () => {
  it("Q50.48 Q50.9 Q112 pinned, frontpage, curated and Best of", () => {
    expect(postStatus({ ...AGI, sticky: true }).pinned).toBe(true);
    expect(postStatus({ ...AGI, frontpageDate: null }).frontpage).toBe(false);
    expect(postStatus(AGI).frontpage).toBe(true);
    expect(postStatus({ ...AGI, curatedDate: null }).curatedDate).toBeUndefined();
    expect(postStatus({ ...AGI, reviewWinner: { reviewYear: 2019, category: "rationality", reviewRanking: 4 } }).bestOf)
      .toEqual({ year: 2019, category: "rationality", rank: 5 });
    expect(postStatus({ ...AGI, reviewWinner: null }).bestOf).toBeUndefined();
  });

  it("Q50.49 kinds of post: question, dialogue, debate, event, container, sub-question, group post, unlisted", () => {
    expect(postStatus({ ...AGI, question: true }).question).toBe(true);
    expect(postStatus({ ...AGI, collabEditorDialogue: true }).dialogue).toBe(true);
    expect(postStatus({ ...AGI, debate: true }).debate).toBe(true);
    expect(postStatus({ ...AGI, isEvent: true }).event).toBe(true);
    expect(postStatus({ ...AGI, shortform: true }).shortform).toBe(true);
    expect(postStatus({ ...AGI, hiddenRelatedQuestion: true }).subQuestion).toBe(true);
    expect(postStatus({ ...AGI, groupId: "groupId0000000001" }).groupPost).toBe(true);
    expect(postStatus({ ...AGI, unlisted: true }).unlisted).toBe(true);
  });

  it("Q117 Q50.6 a linkpost needs a non-empty url; postCategory is never read", () => {
    const withCategory = (url: string | null) => withExtra({ ...AGI, url }, { postCategory: "linkpost" });
    expect(postStatus(withCategory("")).linkUrl).toBeUndefined();
    expect(postStatus(withCategory("   ")).linkUrl).toBeUndefined();
    expect(postStatus(withCategory(null)).linkUrl).toBeUndefined();
    expect(postStatus(withCategory("https://example.com/paper.pdf")).linkUrl).toBe("https://example.com/paper.pdf");
    expect(postStatus(withExtra(AGI, { postCategory: "question" })).question).toBe(false);
  });

  it.each<[string, boolean]>([
    ["2001-01-01T00:00:00.000Z", true],
    ["2008-01-01T08:00:00.000Z", true],
    ["2009-01-01T00:00:00.000Z", false],
    ["2007-01-02T00:00:00.000Z", false],
    ["2006-12-31T23:59:59.999Z", false],
    ["2022-01-01T00:00:00.000Z", false],
  ])("Q115 Q50.8 postedAt %s → placeholder date %s", (postedAt, flag) => {
    expect(postStatus({ ...AGI, postedAt }).placeholderDate).toBe(flag);
  });
});

describe("postStatus, further cases", () => {
  it("¶3.8.2 curatedDate, bestOf and linkUrl are absent keys when unset, not undefined values", () => {
    const flags = postStatus({ ...AGI, curatedDate: null, reviewWinner: null, url: null });
    for (const key of ["curatedDate", "bestOf", "linkUrl"]) expect(flags).not.toHaveProperty(key);
    expect(Object.keys(postStatus({ ...AGI, url: "https://example.com/" }))).toEqual([
      "curatedDate", "frontpage", "pinned", "bestOf", "question", "linkUrl", "dialogue", "debate", "event", "shortform",
      "subQuestion", "groupPost", "unlisted", "placeholderDate",
    ]);
  });

  it("Q50.49 an empty groupId is not a group post", () => {
    expect(postStatus({ ...AGI, groupId: "" }).groupPost).toBe(false);
    expect(postStatus({ ...AGI, groupId: null }).groupPost).toBe(false);
  });
});

describe("urls (¶3.1.3)", () => {
  it("Q50.7 post URLs: the AF host for AF posts, LessWrong otherwise; the slug appears only inside the URL", () => {
    expect(postUrl({ _id: "uMQ3cqWDPHhjtiesc", slug: "agi-ruin-a-list-of-lethalities", af: true }))
      .toBe("https://www.alignmentforum.org/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities");
    expect(postUrl({ _id: "zHhGa3iQBQcdSifFL", slug: "a-critical-look-at-lean4-1", af: false }))
      .toBe("https://www.lesswrong.com/posts/zHhGa3iQBQcdSifFL/a-critical-look-at-lean4-1");
  });

  it("user, tag and sequence URLs", () => {
    expect(userUrl("eliezer_yudkowsky")).toBe("https://www.lesswrong.com/users/eliezer_yudkowsky");
    expect(tagUrl("interpretability-ml-and-ai")).toBe("https://www.lesswrong.com/w/interpretability-ml-and-ai");
    expect(sequenceUrl("5g5TkQTe9rmPS5vvM", false)).toBe("https://www.lesswrong.com/s/5g5TkQTe9rmPS5vvM");
    expect(sequenceUrl("5g5TkQTe9rmPS5vvM", true)).toBe("https://www.alignmentforum.org/s/5g5TkQTe9rmPS5vvM");
  });

  it("id and slug path segments are percent-encoded", () => {
    expect(postUrl({ _id: "x", slug: "a b", af: false })).toBe("https://www.lesswrong.com/posts/x/a%20b");
    expect(userUrl("a/b")).toBe("https://www.lesswrong.com/users/a%2Fb");
    expect(tagUrl("a b")).toBe("https://www.lesswrong.com/w/a%20b");
    expect(sequenceUrl("a/b", true)).toBe("https://www.alignmentforum.org/s/a%2Fb");
  });
});
