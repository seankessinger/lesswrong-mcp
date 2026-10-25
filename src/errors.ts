// Layer 5 leaf. The exact wording of the error categories of ¶3.9, so that forum/http.ts can raise transport errors.
// Every builder takes text that is already cut and already sanitized (¶8 message hygiene: text/sanitize.oneLine,
// 200-character cuts); nothing here escapes, trims or truncates what it is given.
import type { Category, StopReason } from "./types";

/** A failure the caller can read: the reply text is `Error (<category>): <message>`. */
export class ToolError extends Error {
  readonly category: Category;

  constructor(category: Category, message: string) {
    super(message);
    this.name = "ToolError";
    this.category = category;
  }
}

/** Thrown by CallContext.beginRequest() when the call may send no more requests; the page ends `Stopped early`. */
export class CallStopped extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason) {
    super(`stopped early (${reason})`);
    this.name = "CallStopped";
    this.reason = reason;
  }
}

export function isToolError(e: unknown): e is ToolError {
  return e instanceof ToolError;
}

/** `ms` rounded up to the whole minute, printed `YYYY-MM-DD HH:MM UTC`; rounding up never names a minute before a pause ends. */
export function utcMinute(ms: number): string {
  const iso = new Date(Math.ceil(ms / 60_000) * 60_000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `<param>: <what>. <fix>`; `fix` carries its own final period. */
export function badInput(param: string, what: string, fix?: string): ToolError {
  return new ToolError("bad_input", `${param}: ${what}.${fix ? ` ${fix}` : ""}`);
}

export const POST_SLUG_HINT =
  "Renamed posts lose their earlier slugs; the id in a URL always works.";

/** ¶8: the slug hint, pointing at `find` with the kind the failed parameter names (`value` is the caller's own string). */
export function slugHint(kind: "post" | "user" | "tag", value: string): string {
  return `Slugs are case-sensitive; to look up a name use find {items: [{kind: "${kind}", query: "${value}"}]}.`;
}

export function userSlugHint(slug: string): string {
  return slugHint("user", slug);
}

/** The same words for an unknown item and one these rules hide (D1: no existence oracle); `hint` carries its own final period. */
export function notFound(entity: string, key: "id" | "slug", value: string, hint?: string): ToolError {
  return new ToolError("not_found", `No publicly visible ${entity} has the ${key} "${value}".${hint ? ` ${hint}` : ""}`);
}

/** Only for the forum's own refusal; the reason is never stated. `what` is the subject as it should read, quotes included. */
export function notPublic(what: string, kind: "post" | "user" | "sequence" | "wiki page"): ToolError {
  return new ToolError(
    "not_public",
    `The forum refuses to show ${what} to logged-out readers: it is a ${kind} that is not publicly visible. Its content can't be shown.`,
  );
}

export function loginOnly(): ToolError {
  return new ToolError("login_only", "This post is only visible to logged-in users; this server reads the forums logged out.");
}

/** `<why>. <how>.` */
export function tooBroad(why: string, how: string): ToolError {
  return new ToolError("too_broad", `${why}. ${how}.`);
}

export function rateLimited(status: number, untilMs: number, nowMs: number): ToolError {
  const minutes = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
  return new ToolError(
    "rate_limited",
    `The forum is limiting requests (HTTP ${status}). This server sends nothing to it until ${utcMinute(untilMs)} (about ${minutes} min); try again after that.`,
  );
}

/** `megabytes` is printed to one decimal as a plain number (forum/http.ts passes it already rounded). */
export function politenessCap(requests: number, megabytes: number, window: string, untilMs: number): ToolError {
  return new ToolError(
    "politeness_cap",
    `This session has made ${requests.toLocaleString("en-US")} forum requests (${Number(megabytes.toFixed(1))} MB) in the last ${window}; to stay polite the server pauses until ${utcMinute(untilMs)}.`,
  );
}

export function timeoutError(task: string): ToolError {
  return new ToolError(
    "timeout",
    `The forum did not answer in time while ${task} (about 50 s per call). Large discussions can be slow; try again, or narrow the request.`,
  );
}

export function forumError(task: string, short: string): ToolError {
  return new ToolError("forum_error", `The forum returned an error while ${task} (${short}). Try again later.`);
}

export function internalError(tool: string, detail: string): ToolError {
  return new ToolError("internal", `Unexpected failure in ${tool} (${detail}). Please report this.`);
}

export function badCursor(): ToolError {
  return new ToolError(
    "bad_cursor",
    "This cursor is unknown: the server restarted since it was issued, it expired, or it belongs to another tool. Repeat the original call without a cursor.",
  );
}
