import { describe, expect, it } from "vitest";
import {
  commentSignals, inReactionSet, likersOf, parseReactions, reactSummary, visibleReacts,
} from "../../src/domain/reactions";
import type { ReactEntry, Reactions } from "../../src/types";

const ALICE = "aliceUserId000001";
const BOB = "bobUserId00000001";
const CAROL = "carolUserId000001";
const DAN = "danUserId00000001";
const entry = (reactType: string, userId: string, displayName: string, quotes?: string[]) =>
  ({ userId, displayName, karma: 65540, reactType, ...(quotes ? { quotes } : {}) });

const CURRENT = {
  reacts: {
    disagree: [
      entry("created", ALICE, "Alice", ["the passage quoted here"]),
      entry("seconded", BOB, "Bob", ["the passage quoted here"]),
      entry("seconded", CAROL, "Carol"),
      entry("disagreed", DAN, "Dan"),
    ],
    crux: [entry("created", ALICE, "Alice")],
    typo: [entry("created", ALICE, "Alice"), entry("seconded", BOB, "Bob"), entry("seconded", CAROL, "Carol")],
    thanks: [entry("created", ALICE, "Alice"), entry("disagreed", BOB, "PLANTED-P11-reactor")],
    hitsTheMark: [entry("created", DAN, "Dan"), entry("disagreed", ALICE, "Alice"), entry("disagreed", BOB, "Bob")],
    changemind: [entry("created", BOB, "Bob")],
    someNewReact: [entry("created", CAROL, "Carol")],
  },
  agreement: 45, approvalVoteCount: 777, agreementVoteCount: 30,
};
const NOTHING = { reacts: [], likers: [], hasVoteData: false };

describe("parseReactions", () => {
  it("¶3.8.6 Q107 nets, reactors per kind and anchored quotes, highest net first, then name", () => {
    expect(parseReactions(CURRENT)).toEqual({
      reacts: [
        { name: "typo", net: 3, created: [{ userId: ALICE, name: "Alice" }], seconded: [{ userId: BOB, name: "Bob" }, { userId: CAROL, name: "Carol" }], disagreed: [], quotes: [] },
        { name: "disagree", net: 2, created: [{ userId: ALICE, name: "Alice" }], seconded: [{ userId: BOB, name: "Bob" }, { userId: CAROL, name: "Carol" }], disagreed: [{ userId: DAN, name: "Dan" }], quotes: ["the passage quoted here"] },
        { name: "changemind", net: 1, created: [{ userId: BOB, name: "Bob" }], seconded: [], disagreed: [], quotes: [] },
        { name: "crux", net: 1, created: [{ userId: ALICE, name: "Alice" }], seconded: [], disagreed: [], quotes: [] },
        { name: "someNewReact", net: 1, created: [{ userId: CAROL, name: "Carol" }], seconded: [], disagreed: [], quotes: [] },
      ],
      agreement: { score: 45, votes: 30 },
      likers: [],
      hasVoteData: true,
    });
  });

  it("P11 Q107 anti-reacts subtract; reactions with a net count of 0 or less are dropped with their reactors", () => {
    const parsed = parseReactions(CURRENT);
    expect(parsed.reacts.map((e) => e.name)).not.toContain("thanks");
    expect(parsed.reacts.map((e) => e.name)).not.toContain("hitsTheMark");
    expect(JSON.stringify(parsed)).not.toContain("PLANTED-P11");
    expect(parseReactions({ reacts: { thanks: [entry("created", ALICE, "Alice"), entry("disagreed", BOB, "Bob")] } }))
      .toEqual({ reacts: [], likers: [], hasVoteData: true });
  });

  it("Q76 Q50.11 Q50.22 only reaction fields are kept", () => {
    const text = JSON.stringify(parseReactions(CURRENT));
    for (const marker of ["65540", "karma", "777", "approval"]) expect(text).not.toContain(marker);
  });

  it("Q108 every extendedScore shape: null, agreement only, reacts + agreement, likes", () => {
    expect(parseReactions(null)).toEqual(NOTHING);
    expect(parseReactions(undefined)).toEqual(NOTHING);
    expect(parseReactions({ agreement: 3, agreementVoteCount: 2 })).toEqual({
      reacts: [], agreement: { score: 3, votes: 2 }, likers: [], hasVoteData: true,
    });
    expect(parseReactions({ agreement: 0, agreementVoteCount: 0 })).toEqual(NOTHING);
    expect(parseReactions({ reacts: {}, usersWhoLiked: [{ userId: ALICE, displayName: "Alice" }] })).toEqual({
      reacts: [], likers: [{ userId: ALICE, name: "Alice" }], hasVoteData: false,
    });
  });

  it.each<[string, unknown]>([
    ["a string", "x"],
    ["a number", 42],
    ["an array", []],
    ["reacts that are not an object", { reacts: "x" }],
    ["a react that is not a list", { reacts: { disagree: "x" } }],
    ["entries that are not objects or lack a known reactType", { reacts: { disagree: [null, 5, "x", { reactType: "upvoted", userId: ALICE }] } }],
    ["string-typed agreement", { agreement: "5", agreementVoteCount: "2" }],
    ["likers that are not a list", { usersWhoLiked: "x" }],
    ["non-finite agreement counts", JSON.parse('{"agreement": 1e999, "agreementVoteCount": 1e999}')],
  ])("Q108 L10 a malformed extendedScore (%s) parses to nothing without throwing", (_label, es) => {
    expect(parseReactions(es)).toEqual(NOTHING);
  });

  it("L10 an entry without a user id is counted but not named", () => {
    const parsed = parseReactions({ reacts: { crux: [{ displayName: "Ghost", reactType: "created" }, entry("created", BOB, "Bob")] } });
    expect(parsed.reacts).toEqual([
      { name: "crux", net: 2, created: [{}, { userId: BOB, name: "Bob" }], seconded: [], disagreed: [], quotes: [] },
    ]);
  });

  it("quotes are single-line, cut at 200 characters and de-duplicated", () => {
    const parsed = parseReactions({ reacts: { crux: [
      entry("created", ALICE, "Alice", ["q".repeat(250), "line one\nline two"]),
      entry("seconded", BOB, "Bob", ["line one\nline two"]),
    ] } });
    expect(parsed.reacts[0]!.quotes).toEqual(["q".repeat(199) + "…", "line one line two"]);
  });

  it("equal nets are ordered by name in code-point order, not UTF-16 order", () => {
    const one = (name: string) => [name, [entry("created", ALICE, "Alice")]] as const;
    const parsed = parseReactions({ reacts: Object.fromEntries([one("apple"), one("\u{1F600}"), one("Zebra"), one("\u{FFFD}")]) });
    expect(parsed.reacts.map((e) => e.name)).toEqual(["Zebra", "apple", "\u{FFFD}", "\u{1F600}"]);
  });

  it("a react whose stored name is blank, and a blank quote, are treated as absent: no empty name or passage is ever printed", () => {
    const parsed = parseReactions({ reacts: {
      "  \n ": [entry("created", ALICE, "Alice"), entry("seconded", BOB, "Bob")],
      crux: [entry("created", ALICE, "Alice", [" \n\t", "a real passage", ""])],
    } });
    expect(parsed.reacts).toEqual([
      { name: "crux", net: 1, created: [{ userId: ALICE, name: "Alice" }], seconded: [], disagreed: [], quotes: ["a real passage"] },
    ]);
    expect(parseReactions({ reacts: { " ": [entry("created", ALICE, "Alice")] } })).toEqual({ reacts: [], likers: [], hasVoteData: false });
  });

  it("a react name is single-line and cut at 60 characters", () => {
    const parsed = parseReactions({ reacts: { ["n".repeat(80)]: [entry("created", ALICE, "Alice")], "two\nlines": [entry("created", BOB, "Bob")] } });
    expect(parsed.reacts.map((e) => e.name)).toEqual(["n".repeat(59) + "…", "two lines"]);
  });

  it("L7 an unknown react name is kept by its stored name and counted in no set", () => {
    expect(parseReactions(CURRENT).reacts.find((e) => e.name === "someNewReact")).toMatchObject({ net: 1 });
    expect(inReactionSet("someNewReact", "disagreement")).toBe(false);
    expect(inReactionSet("someNewReact", "crux")).toBe(false);
    expect(inReactionSet("someNewReact", "mindChange")).toBe(false);
  });
});

describe("visibleReacts, reactSummary, inReactionSet", () => {
  it("P11 visibleReacts keeps net > 0, highest first, then name, and is idempotent", () => {
    const parsed = parseReactions(CURRENT);
    expect(visibleReacts(parsed).map((e) => `${e.name} ${e.net}`)).toEqual(["typo 3", "disagree 2", "changemind 1", "crux 1", "someNewReact 1"]);
    expect(visibleReacts({ ...parsed, reacts: visibleReacts(parsed) })).toEqual(visibleReacts(parsed));
  });

  it("P11 visibleReacts on a hand-built Reactions (nets of 0 and below, unsorted): those are dropped, the rest ordered by net then name, the input untouched", () => {
    const e = (name: string, net: number): ReactEntry => ({ name, net, created: [], seconded: [], disagreed: [], quotes: [] });
    const r: Reactions = { reacts: [e("typo", 1), e("insightful", -2), e("disagree", 3), e("crux", 0), e("agree", 3), e("thanks", 2)], likers: [], hasVoteData: true };
    expect(visibleReacts(r).map((x) => `${x.name} ${x.net}`)).toEqual(["agree 3", "disagree 3", "thanks 2", "typo 1"]);
    expect(r.reacts.map((x) => x.name)).toEqual(["typo", "insightful", "disagree", "crux", "agree", "thanks"]);
  });

  it("¶3.8.6 the summary prints stored names with nets, at most 6, then +N more", () => {
    const visible = visibleReacts(parseReactions(CURRENT));
    expect(reactSummary(visible)).toBe("typo 3, disagree 2, changemind 1, crux 1, someNewReact 1");
    expect(reactSummary(visible, 2)).toBe("typo 3, disagree 2 +3 more");
    expect(reactSummary([])).toBe("");
  });

  it("¶3.8.6 the reaction sets", () => {
    for (const n of ["disagree", "notacrux", "shakyPremise", "locallyInvalid", "strawman"]) {
      expect(inReactionSet(n, "disagreement")).toBe(true);
    }
    expect(inReactionSet("crux", "crux")).toBe(true);
    expect(inReactionSet("changemind", "mindChange")).toBe(true);
    for (const n of ["agree", "typo", "crux", "changemind", "Disagree"]) expect(inReactionSet(n, "disagreement")).toBe(false);
    expect(inReactionSet("disagree", "crux")).toBe(false);
  });
});

describe("likersOf", () => {
  it("L10 a page's and a lens's likers come from their own extendedScore.usersWhoLiked; unnamed entries are counted", () => {
    const page = { reacts: {}, usersWhoLiked: [{ userId: ALICE, displayName: "Alice" }, { userId: BOB, displayName: "Bob" }] };
    const lens = { reacts: {}, usersWhoLiked: [{ userId: CAROL, displayName: "Carol" }, { displayName: "Ghost" }, "x", null] };
    expect(likersOf(page)).toEqual([{ userId: ALICE, name: "Alice" }, { userId: BOB, name: "Bob" }]);
    expect(likersOf(lens)).toEqual([{ userId: CAROL, name: "Carol" }, {}, {}, {}]);
    expect(likersOf({ usersWhoLiked: [{ userId: DAN }] })).toEqual([{ userId: DAN }]);
    expect(likersOf(null)).toEqual([]);
  });
});

describe("the user id of a liker entry (L10: the live shape is {_id, displayName})", () => {
  const RUBY = "rubyUserId0000001";

  it("L10 a liker entry carrying the user id as _id (the live shape) is named", () => {
    expect(parseReactions({ usersWhoLiked: [{ _id: RUBY, displayName: "Ruby" }] }).likers).toEqual([{ userId: RUBY, name: "Ruby" }]);
    expect(likersOf({ reacts: {}, usersWhoLiked: [{ _id: RUBY, displayName: "Ruby" }, { _id: ALICE }] }))
      .toEqual([{ userId: RUBY, name: "Ruby" }, { userId: ALICE }]);
  });

  it("L10 a liker entry carrying userId (the schema's UserLikingTag shape) is still named", () => {
    expect(parseReactions({ usersWhoLiked: [{ userId: RUBY, displayName: "Ruby" }] }).likers).toEqual([{ userId: RUBY, name: "Ruby" }]);
  });

  it("L10 a liker entry carrying both keys is read by its userId; an _id stands in only when userId is not a string", () => {
    expect(likersOf({ usersWhoLiked: [{ _id: BOB, userId: RUBY, displayName: "Ruby" }] })).toEqual([{ userId: RUBY, name: "Ruby" }]);
    expect(likersOf({ usersWhoLiked: [{ _id: RUBY, userId: 5, displayName: "Ruby" }, { _id: BOB, userId: null }] }))
      .toEqual([{ userId: RUBY, name: "Ruby" }, { userId: BOB }]);
  });

  it("L10 a liker entry with neither a string userId nor a string _id is counted, not named", () => {
    expect(likersOf({ usersWhoLiked: [{ displayName: "Ghost" }, { _id: 7, userId: null, displayName: "Ghost" }, {}] })).toEqual([{}, {}, {}]);
  });

  it("L10 a react entry under reacts that carries only _id stays unnamed: reactors are read by userId alone", () => {
    const parsed = parseReactions({ reacts: { crux: [{ _id: RUBY, displayName: "Ruby", reactType: "created" }, entry("seconded", BOB, "Bob")] } });
    expect(parsed.reacts).toEqual([
      { name: "crux", net: 2, created: [{}], seconded: [{ userId: BOB, name: "Bob" }], disagreed: [], quotes: [] },
    ]);
  });
});

describe("commentSignals (¶3.8.6)", () => {
  function signals(o: { karma?: number | null; votes?: number | null; karmaHidden?: boolean; es?: unknown }) {
    return commentSignals({
      karma: o.karma === undefined ? 10 : o.karma,
      votes: o.votes === undefined ? 4 : o.votes,
      karmaHidden: o.karmaHidden ?? false,
      reactions: parseReactions(o.es ?? null),
    });
  }

  it("¶3.8.6 contested counts each unit of net disagreement reactions and names them", () => {
    const es = { reacts: {
      disagree: [entry("created", ALICE, "Alice"), entry("seconded", BOB, "Bob")],
      shakyPremise: [entry("created", CAROL, "Carol")],
      typo: [entry("created", DAN, "Dan")],
      notacrux: [entry("created", DAN, "Dan"), entry("disagreed", ALICE, "Alice")],
    } };
    expect(signals({ es })).toEqual({ contested: 3, labels: ["disagree 2", "shakyPremise 1"], crux: 0, mindChange: 0 });
  });

  it.each<[number, number, string[]]>([
    [-1, 2, ["agreement disputed"]],
    [-1, 1, []],
    [0, 5, ["agreement split"]],
    [2, 3, ["agreement split"]],
    [3, 3, []],
    [0, 2, []],
    [-8, 11, ["agreement disputed", "agreement split"]],
  ])("¶3.8.6 agreement %i with %i agreement votes → %j", (score, votes, labels) => {
    const s = signals({ es: { agreement: score, agreementVoteCount: votes } });
    expect(s.labels).toEqual(labels);
    expect(s.contested).toBe(labels.length);
  });

  it.each<[number | null, number, boolean]>([
    [2, 6, true],
    [3, 6, false],
    [2, 5, true],
    [-10, 4, false],
    [null, 9, false],
  ])("¶3.8.6 karma split: karma %s with %i votes → %s", (karma, votes, split) => {
    expect(signals({ karma, votes }).labels.includes("karma split")).toBe(split);
  });

  it("¶3.8.6 labels: disagreement reactions first, then agreement disputed, agreement split, karma split", () => {
    const s = signals({ karma: 1, votes: 8, es: { reacts: { strawman: [entry("created", ALICE, "Alice")] }, agreement: -4, agreementVoteCount: 6 } });
    expect(s).toEqual({ contested: 4, labels: ["strawman 1", "agreement disputed", "agreement split", "karma split"], crux: 0, mindChange: 0 });
  });

  it("¶3.8.6 crux and mind-change nets", () => {
    expect(signals({ es: CURRENT })).toEqual({ contested: 2, labels: ["disagree 2"], crux: 1, mindChange: 1 });
    expect(signals({ es: { reacts: { crux: [entry("created", ALICE, "Alice"), entry("disagreed", BOB, "Bob")] } } })).toMatchObject({ crux: 0 });
  });

  it("P18 Q105 no signal applies under hidden karma", () => {
    expect(signals({ karma: null, votes: null, karmaHidden: true, es: CURRENT })).toEqual({ contested: 0, labels: [], crux: 0, mindChange: 0 });
  });
});
