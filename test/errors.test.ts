import { describe, expect, it } from "vitest";
import {
  ToolError, CallStopped, isToolError, badInput, notFound, POST_SLUG_HINT, userSlugHint, notPublic, loginOnly,
  tooBroad, rateLimited, politenessCap, timeoutError, forumError, internalError, badCursor, utcMinute,
} from "../src/errors";

const full = (e: ToolError) => `Error (${e.category}): ${e.message}`;
const T = Date.parse("2026-10-22T12:00:00.000Z");

describe("¶3.9 error categories and wording", () => {
  it("ToolError carries its category; CallStopped its reason", () => {
    const e = new ToolError("not_found", "x");
    expect(e).toBeInstanceOf(Error);
    expect([e.category, e.message, isToolError(e)]).toEqual(["not_found", "x", true]);
    expect(isToolError(new Error("x"))).toBe(false);
    const s = new CallStopped("request cap");
    expect(s).toBeInstanceOf(Error);
    expect(s.reason).toBe("request cap");
    expect(isToolError(s)).toBe(false);
  });

  it("bad_input is '<param>: <what>. <fix>'", () => {
    expect(full(badInput("date_to", '"2024-13" is not a date', "Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC)."))).toBe(
      'Error (bad_input): date_to: "2024-13" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp (UTC).',
    );
    expect(badInput("section", "this post has 23 sections").message).toBe("section: this post has 23 sections.");
  });

  it("not_found reads the same for unknown and hidden items, with the slug hints", () => {
    expect(full(notFound("user", "slug", "Habryka", userSlugHint("Habryka")))).toBe(
      'Error (not_found): No publicly visible user has the slug "Habryka". Slugs are case-sensitive; to look up a name use find {items: [{kind: "user", query: "Habryka"}]}.',
    );
    expect(full(notFound("post", "slug", "a-critical-look-at-lean4", POST_SLUG_HINT))).toBe(
      "Error (not_found): No publicly visible post has the slug \"a-critical-look-at-lean4\". Renamed posts lose their earlier slugs; the id in a URL always works.",
    );
    expect(notFound("comment", "id", "AAAAAAAAAAAAAAAAA").message).toBe('No publicly visible comment has the id "AAAAAAAAAAAAAAAAA".');
  });

  it("not_public never states the reason; login_only", () => {
    expect(full(notPublic('"Draft title"', "post"))).toBe(
      "Error (not_public): The forum refuses to show \"Draft title\" to logged-out readers: it is a post that is not publicly visible. Its content can't be shown.",
    );
    expect(notPublic("this wiki page", "wiki page").category).toBe("not_public");
    expect(full(loginOnly())).toBe(
      "Error (login_only): This post is only visible to logged-in users; this server reads the forums logged out.",
    );
  });

  it("too_broad is '<why>. <how>.'", () => {
    expect(full(tooBroad("More than 2,000 posts match", "Narrow with date_from/date_to"))).toBe(
      "Error (too_broad): More than 2,000 posts match. Narrow with date_from/date_to.",
    );
  });

  it("rate_limited names the minute the pause ends (rounded up) and the minutes left (rounded up)", () => {
    expect(full(rateLimited(429, T + 5 * 60_000 + 30_000, T))).toBe(
      "Error (rate_limited): The forum is limiting requests (HTTP 429). This server sends nothing to it until 2026-10-22 12:06 UTC (about 6 min); try again after that.",
    );
    expect(rateLimited(503, T + 10_000, T).message).toBe(
      "The forum is limiting requests (HTTP 503). This server sends nothing to it until 2026-10-22 12:01 UTC (about 1 min); try again after that.",
    );
  });

  it("politeness_cap", () => {
    expect(full(politenessCap(1500, 312.46, "24 hours", Date.parse("2026-10-23T09:14:10.000Z")))).toBe(
      "Error (politeness_cap): This session has made 1,500 forum requests (312.5 MB) in the last 24 hours; to stay polite the server pauses until 2026-10-23 09:15 UTC.",
    );
    expect(politenessCap(150, 100, "10 minutes", T).message).toBe(
      "This session has made 150 forum requests (100 MB) in the last 10 minutes; to stay polite the server pauses until 2026-10-22 12:00 UTC.",
    );
  });

  it("timeout, forum_error, internal, bad_cursor (C1)", () => {
    expect(full(timeoutError("loading the discussion"))).toBe(
      "Error (timeout): The forum did not answer in time while loading the discussion (about 50 s per call). Large discussions can be slow; try again, or narrow the request.",
    );
    expect(full(forumError("loading the post", "HTTP 502"))).toBe(
      "Error (forum_error): The forum returned an error while loading the post (HTTP 502). Try again later.",
    );
    expect(full(internalError("get_post", "get_post_main: Cannot query field"))).toBe(
      "Error (internal): Unexpected failure in get_post (get_post_main: Cannot query field). Please report this.",
    );
    expect(full(badCursor())).toBe(
      "Error (bad_cursor): This cursor is unknown: the server restarted since it was issued, it expired, or it belongs to another tool. Repeat the original call without a cursor.",
    );
  });

  it("utcMinute prints YYYY-MM-DD HH:MM UTC, rounded up to the minute", () => {
    expect(utcMinute(T)).toBe("2026-10-22 12:00 UTC");
    expect(utcMinute(T + 1)).toBe("2026-10-22 12:01 UTC");
    expect(utcMinute(Date.parse("2026-12-31T23:59:30.000Z"))).toBe("2027-01-01 00:00 UTC");
  });
});
