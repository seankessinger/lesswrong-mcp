import { describe, expect, it } from "vitest";
import { toSequenceRecord } from "../../src/domain/sequences";
import { pageType, toTagRecord } from "../../src/domain/tags";
import { toUserProfile, toUserRecord } from "../../src/domain/users";
import type { Person, RawTagRef } from "../../src/types";
import { SAMPLE_PERSON, rawSeqCard, rawTagCard, rawTagList, rawTagRef, rawUserCard, rawUserProfile, rawUserRef, withExtra } from "../support/builders";

const EY_FIELDS = {
  _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky",
  createdAt: "2009-02-23T21:58:56.739Z", karma: 170469, afKarma: 4321, postCount: 967, commentCount: 7845,
  groups: ["alignmentForum"], jobTitle: null, organization: "MIRI", deleted: false,
};
const EY_CARD = rawUserCard({ ...EY_FIELDS, biography: { plaintextDescription: "x".repeat(200) } });
const EY_PROFILE = rawUserProfile({
  ...EY_FIELDS,
  website: "https://yudkowsky.net", twitterProfileURL: "ESYudkowsky", githubProfileURL: "", linkedinProfileURL: null,
  blueskyProfileURL: "https://bsky.app/profile/example", facebookProfileURL: "   ",
  pinnedPostIds: ["uMQ3cqWDPHhjtiesc", "SwYBLQvo8MddDcCwz"],
  // The test bio holds a literal U+2028 between "line2" and "line3"; the escape is the same string.
  biography: { plaintextDescription: "x".repeat(200), markdown: "line1\r\nline2\u{2028}line3", wordCount: 3, editedAt: "2020-01-01T00:00:00.000Z" },
  howOthersCanHelpMe: { markdown: "Send me counterexamples." },
  howICanHelpOthers: { markdown: "I can explain decision theory." },
});
const EY_PERSON: Person = { kind: "user", id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky" };

const ref = (o: Partial<RawTagRef>): RawTagRef =>
  rawTagRef({ core: false, wikiOnly: false, adminOnly: false, deleted: false, isPlaceholderPage: false, ...o });
const AI = ref({ _id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", core: true });
const INTERP_TEXT = "Interpretability is the ability for the decision processes and inner workings of AI and machine learning systems to be understood by humans or other outside observers.";
const INTERP_CARD = rawTagCard({
  ...ref({ _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai" }),
  postCount: 1608, parentTag: AI, description: { plaintextDescription: INTERP_TEXT },
});

describe("users (¶3.8.1, ¶3.5)", () => {
  it("Q50.26 toUserRecord maps the user card; karma is the live GraphQL value", () => {
    expect(toUserRecord(EY_CARD)).toEqual({
      id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", name: "Eliezer Yudkowsky", createdAt: "2009-02-23T21:58:56.739Z",
      karma: 170469, afKarma: 4321, afMember: true, postCount: 967, commentCount: 7845, org: "MIRI",
      bioExcerpt: "x".repeat(149) + "…",
    });
  });

  it("D9 P13 AF membership is the only group carried", () => {
    // Planted on a made-up person's card and profile, never on a real account's.
    const card = rawUserCard({ ...SAMPLE_PERSON, groups: ["alignmentForum", "PLANTED-D9-group"] });
    const profile = rawUserProfile({ ...SAMPLE_PERSON, groups: ["alignmentForum", "PLANTED-D9-group"] });
    expect(toUserRecord(card).afMember).toBe(true);
    expect(toUserRecord({ ...card, groups: null }).afMember).toBe(false);
    expect(toUserRecord({ ...card, groups: ["PLANTED-D9-group"] }).afMember).toBe(false);
    const text = JSON.stringify([toUserRecord(card), toUserProfile(profile)]);
    expect(text).not.toContain("PLANTED-D9-group");
  });

  it("the bio excerpt and job/organization are omitted when empty", () => {
    const blank = toUserRecord({ ...EY_CARD, biography: { plaintextDescription: "  " }, jobTitle: "", organization: null });
    expect(blank.bioExcerpt).toBeUndefined();
    expect(blank.job).toBeUndefined();
    expect(blank.org).toBeUndefined();
    expect(toUserRecord({ ...EY_CARD, biography: null }).bioExcerpt).toBeUndefined();
    expect(toUserRecord({ ...EY_CARD, jobTitle: "Research Fellow" }).job).toBe("Research Fellow");
    const ws = toUserRecord({ ...EY_CARD, jobTitle: "   ", organization: " \t " });
    expect(ws.job).toBeUndefined();
    expect(ws.org).toBeUndefined();
    expect(toUserRecord({ ...EY_CARD, jobTitle: "  Research Fellow  " }).job).toBe("Research Fellow");
  });

  it("P13 Q50.28 Q50.29 fields the user record does not list are never carried", () => {
    const planted = {
      username: "PLANTED-P13-login", oldSlugs: ["PLANTED-P13-oldslug"], mapLocation: { formatted_address: "PLANTED-P13-location" },
      mapLocationLatLng: { lat: 12.3456, lng: -65.4321 }, banned: "PLANTED-P13-banned", bannedUserIds: ["PLANTED-P13-ban"],
      moderationStyle: "PLANTED-P13-moderation", reviewedByUserId: "PLANTED-P13-reviewer",
      maxPostCount: 919191, maxCommentCount: 929292, profileUpdatedAt: "1970-01-01T00:00:00.000Z",
    };
    // Planted on a made-up person's card and profile, never on a real account's.
    const card = rawUserCard(SAMPLE_PERSON), profile = rawUserProfile(SAMPLE_PERSON);
    const text = JSON.stringify([toUserRecord(withExtra(card, planted)), toUserProfile(withExtra(profile, planted))]);
    for (const marker of ["PLANTED", "12.3456", "919191", "929292", "1970-01-01"]) expect(text).not.toContain(marker);
  });

  it("P10 Q50.27 post and comment counts are carried as site counters; sequenceCount is never carried", () => {
    const profile = toUserProfile(withExtra(EY_PROFILE, { sequenceCount: 313131 }));
    expect(profile).toMatchObject({ postCount: 967, commentCount: 7845 });
    expect(JSON.stringify(profile)).not.toContain("313131");
  });

  it("toUserProfile: bio from biography.markdown, the two help texts, links in fixed order, pinned post ids", () => {
    expect(toUserProfile(EY_PROFILE)).toEqual({
      ...toUserRecord(EY_CARD),
      bio: "line1\nline2\nline3",
      helpMe: "Send me counterexamples.",
      helpOthers: "I can explain decision theory.",
      links: [
        { label: "website", url: "https://yudkowsky.net" },
        { label: "X/Twitter", url: "ESYudkowsky" },
        { label: "Bluesky", url: "https://bsky.app/profile/example" },
      ],
      pinnedPostIds: ["uMQ3cqWDPHhjtiesc", "SwYBLQvo8MddDcCwz"],
    });
    const all = toUserProfile({
      ...EY_PROFILE, website: "https://a.example", twitterProfileURL: "https://x.com/a", githubProfileURL: "https://github.com/a",
      linkedinProfileURL: "https://linkedin.com/in/a", blueskyProfileURL: "https://bsky.app/profile/a", facebookProfileURL: "https://facebook.com/a",
    });
    expect(all.links.map((l) => l.label)).toEqual(["website", "X/Twitter", "GitHub", "LinkedIn", "Bluesky", "Facebook"]);
    expect(toUserProfile({ ...EY_PROFILE, website: "  https://yudkowsky.net  " }).links[0]).toEqual({ label: "website", url: "https://yudkowsky.net" });
    const bare = toUserProfile({ ...EY_PROFILE, biography: null, howOthersCanHelpMe: { markdown: "" }, howICanHelpOthers: null });
    expect(bare.bio).toBeUndefined();
    expect(bare.helpMe).toBeUndefined();
    expect(bare.helpOthers).toBeUndefined();
  });
});

describe("tags (¶3.8.1)", () => {
  it.each<[Partial<RawTagRef>, string]>([
    [{ isPlaceholderPage: true, core: true, wikiOnly: true }, "placeholder page"],
    [{ core: true, wikiOnly: true }, "core tag"],
    [{ wikiOnly: true }, "wiki-only page"],
    [{}, "tag"],
  ])("pageType %j → %s (placeholder, then core, then wiki-only)", (flags, expected) => {
    expect(pageType(ref({ _id: "pageTypeCase00001", name: "Case", slug: "case", ...flags }))).toBe(expected);
  });

  it("Q50.30 toTagRecord maps the tag card: page type, the site counter postCount, the parent, the excerpt", () => {
    expect(toTagRecord(INTERP_CARD)).toEqual({
      id: "56yXXrcxRjrQs6z9R", slug: "interpretability-ml-and-ai", name: "Interpretability (ML & AI)", pageType: "tag",
      postCount: 1608,
      parent: { hidden: false, id: "sYm3HiWcfZvrGu3ui", name: "AI", slug: "ai", wikiOnly: false },
      excerpt: INTERP_TEXT,
    });
    expect(toTagRecord({ ...INTERP_CARD, description: { plaintextDescription: "z".repeat(300) } }).excerpt).toBe("z".repeat(279) + "…");
  });

  it("toTagRecord on a catalogue row (TAG_LIST) carries coreTagId and no excerpt", () => {
    const row = rawTagList({
      ...ref({ _id: "56yXXrcxRjrQs6z9R", name: "Interpretability (ML & AI)", slug: "interpretability-ml-and-ai" }),
      postCount: 1608, coreTagId: "sYm3HiWcfZvrGu3ui", parentTag: null,
    });
    const rec = toTagRecord(row);
    expect(rec.coreTagId).toBe("sYm3HiWcfZvrGu3ui");
    expect(rec.excerpt).toBeUndefined();
    expect(rec.parent).toBeUndefined();
    expect(toTagRecord({ ...row, coreTagId: null }).coreTagId).toBeUndefined();
  });

  it("P12 a hidden parent is not shown", () => {
    for (const parentTag of [ref({ _id: "PLANTEDadminTag01", name: "PLANTED-P12", slug: "planted-p12", adminOnly: true }), ref({ _id: "PLANTEDdeletedTg1", name: "PLANTED-P12", slug: "planted-p12", deleted: true }), null]) {
      const rec = toTagRecord({ ...INTERP_CARD, parentTag });
      expect(rec.parent).toBeUndefined();
      expect(JSON.stringify(rec)).not.toMatch(/PLANTED|planted/);
    }
  });

  it("Q50.31 Q50.33 tag lastCommentedAt, recentComments, contributors and createdAt are never carried", () => {
    const rec = toTagRecord(withExtra(INTERP_CARD, {
      lastCommentedAt: "PLANTED-Q50.31-last", recentComments: [{ _id: "PLANTED-Q50.31-comment" }],
      contributors: { totalCount: 7, contributors: [{ user: { slug: "PLANTED-Q50.31-contributor" } }] },
      createdAt: "PLANTED-Q50.33-created",
    }));
    expect(JSON.stringify(rec)).not.toContain("PLANTED");
  });
});

describe("sequences (¶3.8.1)", () => {
  const PW = rawSeqCard({
    _id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", af: false, hidden: false, createdAt: "2017-07-24T09:56:20.123Z",
    canonicalCollectionSlug: "rationality", curatedOrder: null, postsCount: 21,
    user: rawUserRef({ _id: "nmk3nLpQE89dMRzzN", slug: "eliezer_yudkowsky", displayName: "Eliezer Yudkowsky" }),
    contents: { plaintextDescription: "z".repeat(260) },
  });

  it("toSequenceRecord maps the sequence line; the excerpt is at most 200 characters", () => {
    expect(toSequenceRecord(PW)).toEqual({
      id: "5g5TkQTe9rmPS5vvM", title: "Predictably Wrong", author: EY_PERSON, af: false, hiddenFromLists: false,
      createdAt: "2017-07-24T09:56:20.123Z", postsCount: 21, curatedOrder: null,
      collectionSlug: "rationality", excerpt: "z".repeat(199) + "…",
    });
  });

  it("collectionSlug: an empty string and null both mean none (§11.1)", () => {
    expect(toSequenceRecord({ ...PW, canonicalCollectionSlug: "" }).collectionSlug).toBeUndefined();
    expect(toSequenceRecord({ ...PW, canonicalCollectionSlug: null }).collectionSlug).toBeUndefined();
    expect(toSequenceRecord({ ...PW, canonicalCollectionSlug: "  rationality  " }).collectionSlug).toBe("rationality");
    expect(toSequenceRecord({ ...PW, canonicalCollectionSlug: "   " }).collectionSlug).toBeUndefined();
    expect(toSequenceRecord({ ...PW, contents: null }).excerpt).toBeUndefined();
  });

  it("P4 a hidden sequence keeps its flag; P8 a null author reads account not publicly visible", () => {
    // A made-up sequence by a made-up person.
    const own = rawSeqCard({ _id: "sampleSeqHidden01", title: "A hidden sequence", user: rawUserRef(SAMPLE_PERSON) });
    expect(toSequenceRecord({ ...own, hidden: true }).hiddenFromLists).toBe(true);
    expect(toSequenceRecord({ ...own, user: null }).author).toEqual({ kind: "none", why: "account not publicly visible" });
  });
});
