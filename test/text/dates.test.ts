import { describe, expect, it } from "vitest";
import {
  parseRange, requireWindow, toViewTerms, toSearchFilters, isoMs, day, minute, clampNote, effectiveDate,
} from "../../src/text/dates";
import { badInputMessage } from "../support/errors";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const ms = (iso: string) => Date.parse(iso);

describe("parseRange (¶3.4)", () => {
  it("partial dates name whole periods: date_from is the first instant, date_to includes the whole period", () => {
    expect(parseRange("2024", "2024", NOW)).toEqual({ start: ms("2024-01-01T00:00:00.000Z"), endExclusive: ms("2025-01-01T00:00:00.000Z") });
    expect(parseRange("2024-02", "2024-02", NOW)).toEqual({ start: ms("2024-02-01T00:00:00.000Z"), endExclusive: ms("2024-03-01T00:00:00.000Z") });
    expect(parseRange(undefined, "2024-03-05", NOW)).toEqual({ endExclusive: ms("2024-03-06T00:00:00.000Z") });
    expect(parseRange("2024-12-31", undefined, NOW)).toEqual({ start: ms("2024-12-31T00:00:00.000Z") });
    expect(parseRange(undefined, undefined, NOW)).toEqual({});
  });

  it("timestamps are UTC, other offsets converted; a date_to timestamp is inclusive to the millisecond", () => {
    expect(parseRange("2024-03-05T10:00:00+02:00", "2024-03-05T10:00:00.250Z", NOW)).toEqual({
      start: ms("2024-03-05T08:00:00.000Z"),
      endExclusive: ms("2024-03-05T10:00:00.251Z"),
    });
    expect(parseRange("2024-03-05T10:00", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.000Z") });
  });

  it("a date_to whose period runs past now is clamped to now, and says so", () => {
    const r = parseRange("2026", "2026", NOW);
    expect(r).toEqual({ start: ms("2026-01-01T00:00:00.000Z"), endExclusive: NOW, clampedTo: NOW });
    expect(clampNote(r)).toBe("date_to clamped to now (2026-10-22T12:00:00.000Z)");
    expect(clampNote(parseRange("2024", "2024", NOW))).toBeUndefined();
  });

  it("¶3.6 effectiveDate names a period's first or last instant, never clamped, so the same period compares equal later", () => {
    expect(effectiveDate("2026", "to")).toBe("2026-12-31T23:59:59.999Z");
    expect(effectiveDate("2026-12-31", "to")).toBe("2026-12-31T23:59:59.999Z");
    expect(effectiveDate("2026", "from")).toBe("2026-01-01T00:00:00.000Z");
    expect(effectiveDate("2024-03-05T10:00:00+02:00", "from")).toBe("2024-03-05T08:00:00.000Z");
    expect(effectiveDate("2024-03-05T10:00:00.250Z", "to")).toBe("2024-03-05T10:00:00.250Z");
    expect(effectiveDate(undefined, "to")).toBeUndefined();
  });

  it("refuses unparsable values, impossible dates, starts before 2000-01-01 or after now, and date_from after date_to", () => {
    expect(badInputMessage(() => parseRange(undefined, "2024-13", NOW))).toBe(
      'date_to: "2024-13" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(badInputMessage(() => parseRange("2024-02-30", undefined, NOW))).toBe(
      'date_from: "2024-02-30" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(badInputMessage(() => parseRange("yesterday\n", undefined, NOW))).toBe(
      'date_from: "yesterday\\n" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(badInputMessage(() => parseRange("1999-12-31", undefined, NOW))).toBe(
      'date_from: "1999-12-31" starts before 2000-01-01. Give a date between 2000-01-01 and now.',
    );
    expect(badInputMessage(() => parseRange(undefined, "2027", NOW))).toBe(
      'date_to: "2027" starts in the future. Give a date between 2000-01-01 and now.',
    );
    expect(badInputMessage(() => parseRange("2024-05", "2024-04", NOW))).toBe(
      'date_from: "2024-05" is after date_to "2024-04". Give date_from on or before date_to.',
    );
    expect(parseRange("2024-02-29", "2024-02-29", NOW)).toEqual({ start: ms("2024-02-29T00:00:00.000Z"), endExclusive: ms("2024-03-01T00:00:00.000Z") });
    expect(badInputMessage(() => parseRange("2023-02-29", undefined, NOW))).toBe(
      'date_from: "2023-02-29" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(badInputMessage(() => parseRange(undefined, "2024-03-05T25:00Z", NOW))).toBe(
      'date_to: "2024-03-05T25:00Z" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(parseRange("2024-03-10", "2024-03", NOW)).toEqual({ start: ms("2024-03-10T00:00:00.000Z"), endExclusive: ms("2024-04-01T00:00:00.000Z") });
  });
});

describe("parseRange details (the accepted forms and the order of the checks, ¶3.4)", () => {
  const NOT_A_DATE = "is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).";

  it("a value is quoted with JSON escapes and U+2028/U+2029 become spaces, so one message stays one line", () => {
    expect(badInputMessage(() => parseRange("a\u{2028}b\u{2029}c", undefined, NOW))).toBe(`date_from: "a b c" ${NOT_A_DATE}`);
    expect(badInputMessage(() => parseRange(undefined, 'say "hi"\\', NOW))).toBe(`date_to: "say \\"hi\\"\\\\" ${NOT_A_DATE}`);
  });

  it("fraction digits are the decimal part of the second: .5 is 500 ms, .25 is 250 ms", () => {
    expect(parseRange("2024-03-05T10:00:00.5Z", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.500Z") });
    expect(parseRange("2024-03-05T10:00:00.25", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.250Z") });
    expect(parseRange(undefined, "2024-03-05T10:00:00.5Z", NOW)).toEqual({ endExclusive: ms("2024-03-05T10:00:00.501Z") });
    expect(parseRange(undefined, "2024-03-05T10:00", NOW)).toEqual({ endExclusive: ms("2024-03-05T10:00:00.001Z") });
  });

  it("negative offsets are converted too", () => {
    expect(parseRange("2024-03-05T23:30:00-05:30", undefined, NOW)).toEqual({ start: ms("2024-03-06T05:00:00.000Z") });
  });

  it("¶3.4 a fraction of more than three digits keeps its first three (milliseconds); lowercase t and z are the same timestamp", () => {
    expect(parseRange("2024-03-05T10:00:00.123456Z", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.123Z") });
    expect(parseRange("2024-03-05T10:00:00.123456789Z", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.123Z") });
    expect(parseRange("2024-03-05t10:00:00.5z", undefined, NOW)).toEqual({ start: ms("2024-03-05T10:00:00.500Z") });
    expect(parseRange(undefined, "2024-03-05t10:00z", NOW)).toEqual({ endExclusive: ms("2024-03-05T10:00:00.001Z") });
    expect(badInputMessage(() => parseRange("2024-03-05T10:00:00.1234567890Z", undefined, NOW))).toContain(NOT_A_DATE);
  });

  it("refuses every other shape and every out-of-range component", () => {
    for (const v of [
      "24", "2024-3", "2024-03-5", "20240305", "2024-00", "2024-13", "2024-03-00", "2024-04-31", "2023-02-29", "2100-02-29",
      "2024-03-05T10", "2024-03-05 10:00", "2024-03-05T24:00Z", "2024-03-05T10:60Z", "2024-03-05T10:00:60Z",
      "2024-03-05T10:00:00.Z", "2024-03-05T10:00+24:00", "2024-03-05T10:00+05:60",
      "2024-03-05T10:00+0200", " 2024", "2024 ", "2024\n", "", "now", "٢٠٢٤",
    ]) {
      expect(badInputMessage(() => parseRange(v, undefined, NOW)), JSON.stringify(v)).toContain(NOT_A_DATE);
    }
  });

  it("accepts a leap day in a year divisible by 400, and the bounds 2000-01-01 and now themselves", () => {
    expect(parseRange("2000-02-29", "2000-02-29", NOW)).toEqual({ start: ms("2000-02-29T00:00:00.000Z"), endExclusive: ms("2000-03-01T00:00:00.000Z") });
    expect(parseRange("2000", undefined, NOW)).toEqual({ start: ms("2000-01-01T00:00:00.000Z") });
    expect(parseRange("2026-10-22T12:00:00.000Z", undefined, NOW)).toEqual({ start: NOW });
    expect(parseRange(undefined, "2026-10-22T12:00:00.000Z", NOW)).toEqual({ endExclusive: NOW, clampedTo: NOW });
    expect(badInputMessage(() => parseRange("2026-10-22T12:00:00.001Z", undefined, NOW))).toBe(
      'date_from: "2026-10-22T12:00:00.001Z" starts in the future. Give a date between 2000-01-01 and now.',
    );
  });

  it("checks date_from's form and bounds, then date_to's form and bounds, then the order", () => {
    expect(badInputMessage(() => parseRange("1999", "nope", NOW))).toMatch(/^date_from: "1999" starts before 2000-01-01\./);
    expect(badInputMessage(() => parseRange("2028", "1999", NOW))).toMatch(/^date_from: "2028" starts in the future\./);
    expect(badInputMessage(() => parseRange("2024", "nope", NOW))).toMatch(/^date_to: "nope" is not a date\./);
    expect(badInputMessage(() => parseRange("2024", "1999", NOW))).toMatch(/^date_to: "1999" starts before 2000-01-01\./);
    expect(badInputMessage(() => parseRange("2024-03-05T10:00:00.001Z", "2024-03-05T10:00:00Z", NOW))).toBe(
      'date_from: "2024-03-05T10:00:00.001Z" is after date_to "2024-03-05T10:00:00Z". Give date_from on or before date_to.',
    );
    expect(parseRange("2024-03-05T10:00:00Z", "2024-03-05T10:00:00Z", NOW)).toEqual({
      start: ms("2024-03-05T10:00:00.000Z"),
      endExclusive: ms("2024-03-05T10:00:00.001Z"),
    });
  });
});

describe("requireWindow (¶3.4 windows, ¶4.6)", () => {
  const ctx = "list_comments with sort top and no user";
  it("accepts 2024-03-01 to 2024-03-31 (31 days)", () => {
    expect(() => requireWindow(parseRange("2024-03-01", "2024-03-31", NOW), 31, ctx)).not.toThrow();
  });
  it("refuses 2024-01-15 to 2024-02-15 (32 days, both days included)", () => {
    expect(badInputMessage(() => requireWindow(parseRange("2024-01-15", "2024-02-15", NOW), 31, ctx))).toBe(
      'date_to: the window is 32 days; list_comments with sort top and no user allows at most 31. For example date_from "2024-03-01", date_to "2024-03-31" (31 days).',
    );
  });
  it("needs both bounds", () => {
    expect(badInputMessage(() => requireWindow(parseRange(undefined, "2024-03-31", NOW), 31, ctx))).toBe(
      'date_from: list_comments with sort top and no user needs both date_from and date_to, at most 31 days apart. For example date_from "2024-03-01", date_to "2024-03-31" (31 days).',
    );
    expect(badInputMessage(() => requireWindow(parseRange("2024-03-01", undefined, NOW), 31, ctx))).toBe(
      'date_to: list_comments with sort top and no user needs both date_from and date_to, at most 31 days apart. For example date_from "2024-03-01", date_to "2024-03-31" (31 days).',
    );
  });
});

describe("mapping to the forum", () => {
  const r = parseRange("2024", "2024", NOW);
  it("Q12 post and comment views: after inclusive = start, before exclusive = end + 1 ms", () => {
    expect(toViewTerms(r)).toEqual({ after: "2024-01-01T00:00:00.000Z", before: "2025-01-01T00:00:00.000Z" });
    expect(toViewTerms(parseRange(undefined, "2024-03-05", NOW))).toEqual({ before: "2024-03-06T00:00:00.000Z" });
    expect(toViewTerms({})).toEqual({});
  });
  it("Q35 Q36 search filters: two different fields, integer epoch ms, only >= and <", () => {
    expect(toSearchFilters(r)).toEqual(["publicDateMs>=1704067200000", "postedAt<1735689600000"]);
    expect(toSearchFilters(parseRange("2024", undefined, NOW))).toEqual(["publicDateMs>=1704067200000"]);
    expect(toSearchFilters({})).toEqual([]);
  });
});

describe("output formats", () => {
  it("isoMs, day, minute (UTC)", () => {
    const t = ms("2022-06-05T22:05:52.224Z");
    expect(isoMs(t)).toBe("2022-06-05T22:05:52.224Z");
    expect(day(t)).toBe("2022-06-05");
    expect(day("2022-06-05T22:05:52.224Z")).toBe("2022-06-05");
    expect(minute(t)).toBe("2022-06-05 22:05Z");
    expect(minute("2026-10-19T14:02:59.999Z")).toBe("2026-10-19 14:02Z");
  });
});
