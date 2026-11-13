// What is sent for a phrase has to be able to reach the words a writer used. These tests run `classify` and `buildText` against
// test/support/forumSearchModel.ts, so they fail when a phrase is sent in a form the forum's index can't match, whatever the
// query string looks like.
import { describe, expect, it } from "vitest";
import { buildText } from "../../src/forum/search";
import { classify } from "../../src/text/phrases";
import type { SearchSort } from "../../src/types";
import { reaches } from "../support/forumSearchModel";

const sent = (phrase: string, sort: SearchSort): string =>
  buildText({ index: "posts", sort, page: 0, phrases: [classify(phrase, "phrases")] }).text;

describe("the model agrees with what was measured against the forum", () => {
  it.each([
    ['"Chesterton fence"', "Remember Chesterton's fence."],
    ['"Chesterton\'s fence"', "Remember Chesterton's fence."],
    ['"Chesterton s fence"', "Remember Chesterton's fence."],
    ['"Goodhart"', "By Goodhart's law it fails."],
    ["GPT 4 5", "GPT-4.5 was released."],
    ["Node js", "It runs on Node.js here."],
    ["and or", "Apples and/or pears."],
    ['"e g"', "Some cases, e.g. this one."],
    ['"x.com"', "Posted on x.com today."],
    ['"cousin it"', "As cousin_it said."],
    ["Node.js -zzqqzz", "It runs on Node.js here."],
    ["user:foo bar", "The user:foo bar case."],
    ["Title:'Goodhart's Law", "Title:'Goodhart's Law'."],
    ["it's", "It's raining here."],
    ["that's it", "So that's it for now."],
  ])("%s does not reach %s", (query, text) => {
    expect(reaches(query, text)).toBe(false);
  });

  it.each([
    ['"Bayes theorem"', "By Bayes' theorem we get this."],
    ['"R D"', "Spending on R&D rose."],
    ['"and or"', "Apples and/or pears."],
    ['"P doom"', "My P(doom) is low."],
    ['"7 00"', "We meet at 7:00 sharp."],
    ["Chesterton's fence", "Remember Chesterton's fence."],
    ["Node.js", "It runs on Node.js here."],
    ["GPT 4.5", "GPT-4.5 was released."],
    ["e.g.", "Some cases, e.g. this one."],
    ["x.com", "Posted on x.com today."],
    ["cousin_it", "As cousin_it said."],
    ["1,000", "About 1,000 people came."],
    ["User:foo bar", "The user:foo bar case."],
    ["Re:Zero", "I watched Re:Zero again."],
  ])("%s reaches %s", (query, text) => {
    expect(reaches(query, text)).toBe(true);
  });

  it("three of four words are needed, a repeated word counted each time", () => {
    expect(reaches("psychiatry resident zzqqaa zzqqbb", "A psychiatry resident wrote this.")).toBe(false);
    expect(reaches("psychiatry resident negative zzqqaa", "A negative psychiatry resident wrote this.")).toBe(true);
    expect(reaches("Chesterton fence Chesterton fence", "A fence by the sea.")).toBe(false);
  });
});

describe("what a phrase sends reaches the text that uses it", () => {
  const USES: readonly [string, string][] = [
    ["Goodhart's law", "By Goodhart's law it fails."],
    ["Chesterton’s fence", "Remember Chesterton’s fence."],
    ["the map isn't the territory", "Note that the map isn't the territory."],
    ["Flannery O'Connor", "I read Flannery O'Connor."],
    ["Node.js", "It runs on Node.js here."],
    ["GPT-4.5", "GPT-4.5 was released."],
    ["U.S.", "The U.S. economy grew."],
    ["e.g.", "Some cases, e.g. this one."],
    ["x.com", "Posted on x.com today."],
    ["arxiv.org", "See arxiv.org for it."],
    ["1,000", "About 1,000 people came."],
    ["3.14", "Pi is near 3.14 here."],
    ["cousin_it", "As cousin_it said."],
    ["Re:Zero", "I watched Re:Zero again."],
    ["__init__ method", "Call the __init__ method here."],
    ["user:foo's bar", "The user:foo's bar case."],
    ["Title:'Goodhart's Law'", "Under Title:'Goodhart's Law' we see."],
    ["R&D", "Spending on R&D rose."],
    ["and/or", "Apples and/or pears."],
    ["P(doom)", "My P(doom) is low."],
    ["10:30", "We meet at 10:30 sharp."],
    ["self-sacrifice", "An act of self-sacrifice."],
    ["Bayes' theorem", "By Bayes' theorem we get this."],
    ["mesa optimizer", "A mesa optimizer appears."],
  ];

  it.each(USES)("%s, sorted by relevance", (phrase, text) => {
    expect(reaches(sent(phrase, "relevance"), text)).toBe(true);
  });

  it.each(USES)("%s, oldest first", (phrase, text) => {
    expect(reaches(sent(phrase, "old"), text)).toBe(true);
  });
});

describe("a phrase with punctuation that splits words stays exact", () => {
  it.each([
    ["R&D", "The D team and the R team."],
    ["and/or", "Or apples and pears."],
    ["P(doom)", "Doom is P here."],
    ["10:30", "From 30 to 10."],
  ])("%s does not reach %s, which holds its words out of order", (phrase, text) => {
    expect(reaches(sent(phrase, "relevance"), text)).toBe(false);
  });
});

describe("under a date or karma sort a loose phrase of up to three words asks for all of them", () => {
  it.each(["old", "new", "top"] as const)("sort %s: a text with only some of the words is not reached", (sort) => {
    expect(reaches(sent("Chesterton's fence", sort), "A fence by the sea.")).toBe(false);
    expect(reaches(sent("GPT-4.5", sort), "GPT models are large.")).toBe(false);
    expect(reaches(sent("the map isn't the territory", sort), "The map of the territory.")).toBe(false);
  });

  it("a phrase of four or more words needs three in four", () => {
    expect(reaches(sent("alpha beta gamma delta's", "old"), "Alpha beta gamma only here.")).toBe(true);
    expect(reaches(sent("alpha beta gamma delta's", "old"), "Alpha beta only here.")).toBe(false);
  });

  it("under relevance one of two words is enough, because the phrase ranks first", () => {
    expect(reaches(sent("Chesterton's fence", "relevance"), "A fence by the sea.")).toBe(true);
  });
});
