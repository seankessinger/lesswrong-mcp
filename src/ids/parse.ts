// Layer 5. Pure parsing of ids, URLs and slugs into typed references (¶3.1.1, ¶3.1.2), the forum's slug rule
// (§3.2), and the onsite/offsite classification of links (¶4.13). Nothing reaches a forum query unless it passed
// this module's shape checks: ids are `ID_RE`, slugs `SLUG_RE`, LW1 ids base 36 in lower case (Q90), and every
// message that echoes the caller's text prints it single-line, cut and JSON-quoted. Every refusal is `bad_input`.
import { CONFIG } from "../config";
import { badInput, ToolError } from "../errors";
import { oneLine } from "../text/sanitize";
import type { CollectionSlug, EntityKind, ParsedRef } from "../types";

/** ¶3.1.2: a 17-character alphanumeric id, or a 24-hex legacy id. Lenient on purpose: only the shape is checked. */
export const ID_RE = /^[A-Za-z0-9]{17}$|^[0-9a-f]{24}$/;
/** A slug as the forum writes them (§3.2); case kept, because user slugs are case-sensitive. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** LW1 ids are base 36 in lower case only (Q90). */
const B36_RE = /^[0-9a-z]+$/;

export function isEntityId(s: string): boolean {
  return ID_RE.test(s);
}

type Host = "lw" | "af" | "gw" | "arbital";
type ContentKind = Exclude<EntityKind, "revision">;
type Word = "original" | "current" | "previous";
type Form = ParsedRef["form"];

interface ParseOptions {
  /** `item:N` is accepted (only `commented_on` in a `find` user item, ¶3.1.2). */
  allowItem?: boolean;
  /** The revision words this parameter takes: `original` and `current`, and `previous` for `compare_to`. */
  words?: readonly Word[];
}

/** One entity a URL names, before the caller's `kinds` choose among them. */
interface Candidate {
  kind: ContentKind;
  form: Form;
  value: string;
  postPart?: string;
}

// ---------- hosts

/** Lower-cased hosts without a leading `www.`; `www.greaterwrong.com` ids are unverified (§3.3) but read alike. */
const HOSTS: ReadonlyMap<string, Host> = new Map<string, Host>([
  ["lesswrong.com", "lw"], ["lesserwrong.com", "lw"], ["lessestwrong.com", "lw"], ["baserates.org", "lw"],
  ["alignmentforum.org", "af"], ["alignment-forum.com", "af"],
  ["greaterwrong.com", "gw"], ["arbital.com", "arbital"],
]);

function hostOf(hostname: string): Host | undefined {
  return HOSTS.get(hostname.toLowerCase().replace(/^www\./, ""));
}

const URL_START = /^https?:\/\//i;
/** A recognised host, optionally with `www.`, directly followed by `/`, `?`, `#` or the end; any letter case. */
const BARE_HOST = new RegExp(`^(?:www\\.)?(?:${[...HOSTS.keys()].map((h) => h.replace(/\./g, "\\.")).join("|")})(?:[/?#]|$)`, "i");

// ---------- message texts

const COLLECTION_LIST = Object.keys(CONFIG.collections).join(", ");

const FIX: Readonly<Record<ContentKind, string>> = {
  post: "Give a post id, a post URL, or the exact current slug.",
  comment: "Give a comment id or a comment link (with ?commentId=).",
  user: "Give a user id, a profile URL, or the exact slug.",
  tag: "Give a tag id, a wiki page URL, or the exact slug.",
  sequence: `Give a sequence id, a sequence URL, or a collection slug (${COLLECTION_LIST}).`,
};
const URL_IS: Readonly<Record<ContentKind, string>> = {
  post: "a post", comment: "a comment link", user: "a user profile", tag: "a wiki page", sequence: "a sequence",
};
const TAKES: Readonly<Record<EntityKind, string>> = {
  post: "a post", comment: "a comment", user: "a user", tag: "a tag or wiki page", sequence: "a sequence or collection", revision: "a revision",
};
const FIND_LEAD: Readonly<Record<Exclude<ContentKind, "comment">, string>> = {
  post: "To turn a title into an id",
  user: "To look up a person by name",
  tag: "To look up a topic or wiki page by name",
  sequence: "To look up a sequence by title",
};

/** `a`, `a or b`, `a, b or c`. */
function joinWords(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function revisionFix(words: readonly Word[]): string {
  return `Use a revision_id from get_history's version list${words.length > 0 ? `, or ${joinWords(words)}` : ""}.`;
}

const STRAY_NOTE = "surrounding punctuation ignored";
const COMMENT_NOTE = "commentId ignored; pass it as comment to target the comment";

// ---------- parseRef

/** Trailing sentence punctuation; forum ids, slugs and URLs never end with it. */
const TRAILING = /[.,;:)]+$/;
const ENCLOSING: readonly (readonly [string, string])[] = [
  ["<", ">"], ['"', '"'], ["'", "'"], ["`", "`"], ["\u201C", "\u201D"], ["\u2018", "\u2019"],
];

/** Identifiers copied from Markdown or prose: trailing `.,;:)`, one enclosing pair, trailing punctuation again. */
function stripProse(input: string): { text: string; notes: string[] } {
  const trimmed = input.trim();
  let text = trimmed.replace(TRAILING, "");
  const pair = text.length >= 2 ? ENCLOSING.find(([open, close]) => text.startsWith(open) && text.endsWith(close)) : undefined;
  if (pair !== undefined) text = text.slice(1, -1);
  text = text.replace(TRAILING, "");
  return { text, notes: text === trimmed ? [] : [STRAY_NOTE] };
}

/**
 * Parses one identifier parameter into a typed reference. `param` names the parameter in messages. `kinds` are the
 * entity kinds the parameter takes, in order of preference: when a URL names several entities (a comment permalink
 * names a comment and a post), the first kind in `kinds` that it names wins, and `kinds[0]` words every refusal.
 * Throws `bad_input` for anything that is not an id, an accepted URL, a slug or an allowed word.
 */
export function parseRef(param: string, input: string, kinds: readonly EntityKind[], opts: ParseOptions = {}): ParsedRef {
  const k0 = kinds[0];
  if (k0 === undefined) throw new Error("parseRef needs at least one entity kind");
  const { text, notes } = stripProse(input);
  const x = JSON.stringify(oneLine(text, 100));
  const fix = k0 === "revision" ? revisionFix(opts.words ?? []) : FIX[k0];

  if (URL_START.test(text) || BARE_HOST.test(text)) {
    if (k0 === "revision") throw badInput(param, "a URL is not a revision", fix);
    return refFromUrl(param, text, x, notes, kinds, k0, fix);
  }

  if (opts.allowItem) {
    const item = /^item:(\d+)$/.exec(text);
    if (item !== null) {
      const n = (item[1] ?? "").replace(/^0+(?=\d)/, "");
      if (n === "0") throw badInput(param, `${x} names no item`, "Items are numbered from 1.");
      return { kind: k0, form: "item", value: n, given: "word", notes };
    }
  }

  if (k0 === "revision") {
    const lower = text.toLowerCase();
    const word = (opts.words ?? []).find((w) => w === lower);
    if (word !== undefined) return { kind: k0, form: "word", value: word, given: "word", notes };
    if (ID_RE.test(text)) return { kind: k0, form: "id", value: text, given: "id", notes };
    if (/^[A-Za-z0-9]{17}_[A-Za-z]+$/.test(text)) throw badInput(param, `${x} is a document's stored-text id, not a revision id`, fix);
    if (/^\d+\.\d+\.\d+$/.test(text)) throw badInput(param, `${x} is a version number, and version numbers repeat`, fix);
    throw badInput(param, `${x} is not a revision id`, fix);
  }

  if (ID_RE.test(text)) {
    const bare17 = text.length === 17 && (k0 === "post" || k0 === "user" || k0 === "tag");
    return { kind: k0, form: bare17 ? "idOrSlug" : "id", value: text, given: "id", notes };
  }

  if (k0 === "sequence") {
    const lower = text.toLowerCase();
    if (isCollectionSlug(lower)) return { kind: k0, form: "collection", value: lower, given: "slug", notes };
    throw badInput(
      param,
      `${x} is not a sequence id, URL or collection slug (${COLLECTION_LIST})`,
      `${FIND_LEAD.sequence}, use find {items: [{kind: "sequence", query: ${x}}]}.`,
    );
  }

  if (k0 === "comment") {
    throw badInput(param, `${x} is not a comment id or link`, "Comments have no names or slugs: give the comment_id, or a link with ?commentId=.");
  }

  if (SLUG_RE.test(text)) return { kind: k0, form: "slug", value: text, given: "slug", notes };

  throw badInput(param, `${x} is not an id, URL or slug`, `${FIND_LEAD[k0]}, use find {items: [{kind: "${k0}", query: ${x}}]}.`);
}

function isCollectionSlug(s: string): s is CollectionSlug {
  return Object.hasOwn(CONFIG.collections, s);
}

// ---------- URLs

function refFromUrl(
  param: string, text: string, x: string, notes: readonly string[], kinds: readonly EntityKind[], k0: ContentKind, fix: string,
): ParsedRef {
  let url: URL | undefined;
  try {
    url = new URL(URL_START.test(text) ? text : `https://${text}`);
  } catch {
    url = undefined;
  }
  const host = url === undefined ? undefined : hostOf(url.hostname);
  if (url === undefined || host === undefined) throw badInput(param, `${x} is not a LessWrong or Alignment Forum URL`, fix);

  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length === 1 && segments[0] === "item" && url.searchParams.has("id")) {
    throw badInput(
      param,
      "Agent Foundations links (/item?id=…) can't be looked up: the forum has no query for their ids",
      "Look the post up by its title with find.",
    );
  }

  const commentId = url.searchParams.get("commentId");
  const candidates = pathCandidates(host, segments, commentId !== null && ID_RE.test(commentId) ? commentId : undefined, () =>
    badInput(param, `${x} is not one of the five collections`, FIX.sequence),
  );
  const first = candidates[0];
  if (first === undefined) throw badInput(param, `${x} is not a forum page this server reads`, fix);

  for (const kind of kinds) {
    const c = candidates.find((candidate) => candidate.kind === kind);
    if (c === undefined) continue;
    const ref: ParsedRef = { kind: c.kind, form: c.form, value: c.value, given: "url", notes: [...notes] };
    if (c.postPart !== undefined) ref.postPart = c.postPart;
    if (c.kind !== "comment" && candidates.some((other) => other.kind === "comment")) ref.notes.push(COMMENT_NOTE);
    return ref;
  }
  const is = first.form === "collection" ? "a collection" : URL_IS[first.kind];
  throw badInput(param, `that URL is ${is}; this parameter takes ${TAKES[k0]}`);
}

const id = (kind: ContentKind, value: string, postPart?: string): Candidate =>
  postPart === undefined ? { kind, form: "id", value } : { kind, form: "id", value, postPart };
const slug = (kind: ContentKind, value: string): Candidate => ({ kind, form: "slug", value });
const legacy = (kind: ContentKind, value: string): Candidate => ({ kind, form: "legacy", value });
const collection = (value: CollectionSlug): Candidate => ({ kind: "sequence", form: "collection", value });

const isId = (s: string | undefined): s is string => s !== undefined && ID_RE.test(s);
const isSlug = (s: string | undefined): s is string => s !== undefined && SLUG_RE.test(s);
const isB36 = (s: string | undefined): s is string => s !== undefined && B36_RE.test(s);

/**
 * The path table of ¶3.1.2: the entities a URL path names, in the URL's own order (empty when no row matches).
 * `commentId` is the already validated `commentId` query parameter. A `/collections/<x>` path whose `x` is none of
 * the five collection ids throws `badCollection()`.
 */
function pathCandidates(host: Host, parts: readonly string[], commentId: string | undefined, badCollection: () => ToolError): Candidate[] {
  // `/r/(all|discussion|lesswrong)/lw/…` is the LW1 path under a subreddit prefix.
  const segs = parts[0] === "r" && ["all", "discussion", "lesswrong"].includes(parts[1] ?? "") && parts[2] === "lw" ? parts.slice(2) : parts;
  const [a, b, c, d, e] = segs;
  const n = segs.length;
  const comment: Candidate[] = commentId === undefined ? [] : [id("comment", commentId)];

  if (host === "arbital") return a === "p" && n >= 2 && isSlug(b) ? [slug("tag", b)] : [];

  switch (a) {
    case "posts":
      if (b === "slug") return n === 3 && isSlug(c) ? [slug("post", c)] : []; // Q87: before `/posts/<id>/<slug>`
      if (!isId(b)) return [];
      if (n === 2 || n === 3) return [...comment, id("post", b)];
      if (n === 4 && isId(d)) return [id("comment", d), id("post", b)];
      if (n === 5 && d === "comment" && isId(e)) return [id("comment", e), id("post", b)];
      return [];
    case "s":
      if (n === 2 && isId(b)) return [id("sequence", b)];
      if (n === 4 && isId(b) && c === "p" && isId(d)) return [id("sequence", b, d), id("post", d)];
      return [];
    case "sequences":
      return n === 2 && isId(b) ? [id("sequence", b)] : [];
    case "collections": {
      if (n !== 2 || b === undefined) return [];
      const found = (Object.keys(CONFIG.collections) as CollectionSlug[]).find((k) => CONFIG.collections[k] === b);
      if (found === undefined) throw badCollection();
      return [collection(found)];
    }
    case "rationality":
    case "codex":
    case "hpmor":
    case "highlights":
      if (n === 1) return [collection(a)];
      return n === 2 && isSlug(b) ? [slug("post", b)] : [];
    case "bestoflesswrong":
      return n === 1 ? [collection(a)] : [];
    case "events":
      return n >= 2 && isId(b) ? [id("post", b)] : [];
    case "g":
      return n >= 4 && c === "p" && isId(d) ? [id("post", d)] : [];
    case "revisions":
    case "compare":
      return n >= 3 && b === "post" && isId(c) ? [id("post", c)] : [];
    case "api":
      return n === 3 && b === "post" && isId(c) ? [id("post", c)] : [];
    case "lw":
      if ((n === 2 || n === 3) && isB36(b)) return [legacy("post", b)];
      return n === 4 && isB36(b) && isB36(d) ? [legacy("comment", d), legacy("post", b)] : [];
    case "users":
      return isSlug(b) && (n === 2 || (n === 3 && c === "replies")) ? [slug("user", b)] : [];
    case "u":
      return n === 2 && isSlug(b) ? [slug("user", b)] : [];
    case "user":
      return n >= 2 && isSlug(b) ? [slug("user", b)] : [];
    case "w":
      if (!isSlug(b)) return [];
      if (n === 2 || (n === 3 && c === "history")) return [slug("tag", b)];
      return n === 3 && c === "discussion" ? [...comment, slug("tag", b)] : [];
    case "tag":
    case "p":
      return n === 2 && isSlug(b) ? [slug("tag", b)] : [];
    default:
      return [];
  }
}

// ---------- slugify

const SLUG_MAX = 60;

/**
 * The forum's slug of a title (§3.2, ¶4.1 step 3): lower case, `&` → `and`, every run of other characters outside
 * `[a-z0-9]` (`'`, `’` and `.` among them) → `-`, ends trimmed; a slug over 60 characters is cut to 60 and then back
 * to the last `-` (unless the 61st character is `-`), so the cut falls on a word boundary.
 */
export function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  let cut = slug.slice(0, SLUG_MAX);
  if (slug[SLUG_MAX] !== "-") {
    const dash = cut.lastIndexOf("-");
    if (dash !== -1) cut = cut.slice(0, dash);
  }
  return cut.replace(/-+$/, "");
}

// ---------- parseLink

export type LinkTarget = { onsite: true; ref?: ParsedRef; url: string } | { onsite: false; domain: string; url: string };

const LINK_KINDS: readonly EntityKind[] = ["comment", "post", "user", "tag", "sequence"];

/**
 * Classifies a link found in forum text (¶4.13). A relative `/…` link reads as a link on `www.lesswrong.com` (and a
 * protocol-relative `//host/…` link as https). An onsite link carries the entity it names, when it names one the
 * server reads; an offsite link carries its domain (its scheme, for `mailto:` and the like; empty when unparsable).
 * `url` is always the input as given.
 */
export function parseLink(url: string): LinkTarget {
  const trimmed = url.trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed.startsWith("/") ? `https://www.lesswrong.com${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return { onsite: false, domain: "", url };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { onsite: false, domain: parsed.protocol.slice(0, -1), url };
  if (hostOf(parsed.hostname) === undefined) return { onsite: false, domain: parsed.hostname.replace(/^www\./, ""), url };
  try {
    return { onsite: true, url, ref: parseRef("link", absolute, LINK_KINDS) };
  } catch (e) {
    if (e instanceof ToolError) return { onsite: true, url };
    throw e;
  }
}
