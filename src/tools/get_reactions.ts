// Layer 2. The `get_reactions` tool (¶4.14): the votes, agreement, likes and reactions of one post, comment, wiki page or lens, with
// the people behind them. A slug (or an LW1 id) costs one resolve request (`ids/resolve`); the item request then reads the item
// by id with `REACTION_FIELDS`, which is also its visibility check (P12, P17), so its outcomes and error wording are
// `readResolution`'s. A lens stands for itself (its own score and likers) and a summary for its page, which a second item
// request reads (C3). A bare 17-character string is tried as an id and as a slug in the one item request (¶3.1.2). The people of
// the reactions and likes shown are named by one `usersByUserIds` request, only when there are any: a name is the snapshot name
// the vote carries, with the `user_slug` of the batch; an id the batch drops is `account not publicly visible` (P8), an entry without an
// id is counted, not named (L10), and the author of an anonymous item is never named (P7). Reactions with a net of zero or
// less are dropped by `parseReactions` (P11), of `extendedScore`, only reactions, agreement and likers are read (Q76), a
// page's likers are its own `extendedScore.usersWhoLiked` (L10), and hidden comment karma shows no score and asks for no names
// (P18). The whole item is one text, so a heavily reacted item is sliced by the layout (rule 3) and continues with a `slice`
// cursor that reads it again.
import { z } from "zod";
import { CONFIG } from "../config";
import { likersOf, parseReactions } from "../domain/reactions";
import { isPlaceholder } from "../domain/visibility";
import { badInput, internalError, notFound, ToolError } from "../errors";
import { REACTION_FIELDS, reactionItemOp, reactorIdsOp } from "../forum/templates/get_reactions";
import { parseRef } from "../ids/parse";
import { echoOf, negativeKey, readResolution, resolutionOps, resolve, type ResolveSelect } from "../ids/resolve";
import { sliceAfter } from "../paging/pager";
import { CONVENTIONS_LINE, P } from "../params/vocabulary";
import { CAVEAT, FLAG, fmtInt } from "../render/messages";
import { agreementText, personText } from "../render/records";
import { oneLine } from "../text/sanitize";
import type {
  CallContext, Category, Consumed, CursorEntry, Footer, GqlOp, PageItem, ParsedRef, ReactEntry, Reactions, Reactor, Resolved,
  ResolvedKind, Services, StreamState, ToolDef, ToolOutput,
} from "../types";
import { checkContinuation, isRecord, mint, openContinuation, reply } from "./common";
import { aliasData } from "./loaders";

type GetReactionsParams = { post?: string; comment?: string; tag?: string; cursor?: string; max_tokens: number };

type Param = "post" | "comment" | "tag";
type SliceState = Extract<StreamState, { kind: "slice" }>;

const TITLE = "How was this post, comment or wiki page received, and who reacted how?";
/** ¶4.14, verbatim. */
const DESCRIPTION_QUOTE =
  "Votes, agreement, likes and reactions on one post, comment or wiki page, in detail (exactly one of post, comment, tag; a lens slug gives that lens's own votes). Returns karma (LessWrong) and the number of votes, both including the author's automatic self-vote (1 vote usually means nobody else voted); AF karma and AF votes for AF items; the agreement score and number of agreement votes (comments only; posts have no agreement voting); for wiki pages and lenses, the page's own score, its votes and who liked it (likes on the page itself, not on its posts); and every reader reaction the site shows, with its name, net count, who added it, who seconded it, who disputed it, and the exact passage it is attached to when it is anchored to a quote. Reactor and liker names are as of the item's last vote. If a comment's karma is not publicly visible, its scores and reactions are unavailable (\"karma not publicly visible\"). An item the forum refuses to logged-out readers gives not_public; other items that are not publicly visible read as not found.";

const PARAMS: readonly Param[] = ["post", "comment", "tag"];
const ITEM_TASK = "reading the item's votes and reactions";
const NAMES_TASK = "naming reactors and likers";
/** The noun of ¶3.9 for each parameter. */
const ENTITY: Readonly<Record<Param, string>> = { post: "post", comment: "comment", tag: "wiki page" };
const NAME = CONFIG.render.caps.name;

const HIDDEN_KARMA = "This comment's karma is not publicly visible, so scores and reactions are unavailable.";
const NO_VOTES = "No votes from others and no reactions recorded.";
const NO_REACTIONS = "Reactions: none.";
const REACTIONS_HEAD = "Reactions:";

/** The selections of an item request that carries a slug half (`ids/resolve` writes the aliases). */
const SELECT: ResolveSelect = { post: REACTION_FIELDS.post, comment: REACTION_FIELDS.comment, tag: REACTION_FIELDS.tag, mdoc: REACTION_FIELDS.mdoc };

/** A finite number, else undefined (the forum's `null` and a missing field alike). */
const numberOf = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
/** `1 vote`, `2 votes`. */
const counted = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

// the item

/** The fields of an item document the page reads; every one is read defensively. */
interface ItemDoc {
  af?: boolean; hideKarma?: boolean; deleted?: boolean; deletedPublic?: boolean;
  baseScore?: number | null; voteCount?: number; afBaseScore?: number | null; afVoteCount?: number | null;
  extendedScore?: unknown; title?: string | null; tabTitle?: string;
  hideAuthor?: boolean; userId?: string | null; user?: { _id?: string } | null;
}

/** What was asked and found: the resolution the request echo shows, and the item with the raw document of the alias that answered. */
interface Found {
  param: Param;
  echo: Resolved;
  /** A post, a comment, a wiki page (`tag`) or a lens, never a summary. */
  item: Resolved;
}

/** The same reference read by its id. */
const idRef = (ref: ParsedRef, id: string): ParsedRef => ({ kind: ref.kind, form: "id", value: id, given: ref.given, notes: [] });

/** ¶4.14 Behaviour: a tag id is asked as a page and as a lens; a bare 17-character string also as a slug, in the same request. */
function itemOps(ref: ParsedRef, param: Param): GqlOp[] {
  if (ref.form === "idOrSlug") return resolutionOps(ref, "", SELECT);
  if (param === "tag") return [reactionItemOp("tag", ref.value), reactionItemOp("lens", ref.value)];
  return [reactionItemOp(param, ref.value)];
}

/** One item request for `ref` (an id or a bare 17-character string); the resolution is read from its answer. */
async function requestItem(ref: ParsedRef, param: Param, ctx: CallContext, svc: Services): Promise<Resolved> {
  const negative = svc.caches.get<{ category: Category; message: string }>("negative", negativeKey(ref));
  if (negative !== undefined) throw new ToolError(negative.category, negative.message);
  const results = await svc.gql(itemOps(ref, param), ctx, ITEM_TASK);
  return readResolution(ref, param, "", results, ctx, svc);
}

/** The id the item request reads for what the caller named: a lens its own id, a summary its page. */
function itemIdOf(r: Resolved): string {
  if (r.kind !== "summary") return r.id;
  if (r.pageId === undefined) throw internalError("get_reactions", "a summary without a page");
  return r.pageId;
}

/**
 * Steps 1–3 of ¶4.14: the identifier as resolved (a slug or an LW1 id first costs one resolve request), then the item by id. A
 * summary found by id is read again as its page, keeping the summary's resolution for the echo.
 */
async function readItem(ref: ParsedRef, param: Param, ctx: CallContext, svc: Services): Promise<Found> {
  const direct = ref.form === "id" || ref.form === "idOrSlug";
  const resolved = direct ? undefined : await resolve(ref, param, ctx, svc);
  let item = await requestItem(resolved === undefined ? ref : idRef(ref, itemIdOf(resolved)), param, ctx, svc);
  const echo = resolved ?? item;
  if (item.kind === "summary") item = await requestItem(idRef(ref, itemIdOf(item)), param, ctx, svc);
  if (item.kind !== "post" && item.kind !== "comment" && item.kind !== "tag" && item.kind !== "lens") {
    throw internalError("get_reactions", `the item is a ${item.kind}`);
  }
  return { param, echo, item };
}

// the people

/** A user the reactor request returned. */
interface UserRow { slug: string | null; name: string | null }

/** Who the page can name: the users the reactor request returned, under the anonymity rule (P7). */
interface Names { users: ReadonlyMap<string, UserRow>; anonymous: string | undefined }

/** The distinct user ids in first-appearance order: the likers, then each shown reaction's added, seconded and disputed; never `except`. */
function reactorIds(likers: readonly Reactor[], reacts: readonly ReactEntry[], except: string | undefined): string[] {
  const ids = new Set<string>();
  const add = (people: readonly Reactor[]): void => {
    for (const person of people) if (person.userId !== undefined && person.userId !== except) ids.add(person.userId);
  };
  add(likers);
  for (const e of reacts) { add(e.created); add(e.seconded); add(e.disagreed); }
  return [...ids];
}

/** The people behind `ids` in one request, none when there are none; the batch drops the ones it does not know (§9.8). */
async function nameReactors(ids: readonly string[], ctx: CallContext, svc: Services): Promise<ReadonlyMap<string, UserRow>> {
  const names = new Map<string, UserRow>();
  const op = reactorIdsOp(ids);
  if (op === undefined) return names;
  const data = aliasData(await svc.gql([op], ctx, NAMES_TASK), op.alias, NAMES_TASK, ctx);
  const rows = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row._id !== "string") continue;
    names.set(row._id, {
      slug: typeof row.slug === "string" ? row.slug : null,
      name: typeof row.displayName === "string" ? row.displayName : null,
    });
  }
  return names;
}

/**
 * P7, P8, L10: a person as `"<snapshot name>" (user_slug …)`, `account not publicly visible` when the batch dropped the id,
 * `author not publicly visible` where the anonymity rule applies; undefined without an id.
 */
function personOf(r: Reactor, names: Names): string | undefined {
  if (r.userId === undefined) return undefined;
  if (r.userId === names.anonymous) return FLAG.ANONYMOUS;
  const user = names.users.get(r.userId);
  if (user === undefined) return FLAG.DELETED_ACCOUNT;
  return personText({ kind: "user", id: r.userId, slug: user.slug, name: r.name ?? user.name ?? user.slug ?? r.userId });
}

/** The people of one list, named ones first in their order, then `<k> unnamed` for the entries without an id. */
function peopleText(people: readonly Reactor[], names: Names): string {
  const named: string[] = [];
  let unnamed = 0;
  for (const person of people) {
    const text = personOf(person, names);
    if (text === undefined) unnamed += 1;
    else named.push(text);
  }
  if (unnamed > 0) named.push(`${fmtInt(unnamed)} unnamed`);
  return named.join(", ");
}

// the text

/** `  <name> <net> — added by …; seconded by …; disputed by … · on: "<quote>"` (Q76: no karma, no ids besides the `user_slug`). */
function reactionLine(e: ReactEntry, names: Names): string {
  const parts = ([["added by", e.created], ["seconded by", e.seconded], ["disputed by", e.disagreed]] as const)
    .filter(([, people]) => people.length > 0)
    .map(([label, people]) => `${label} ${peopleText(people, names)}`);
  return `  ${e.name} ${fmtInt(e.net)} — ${parts.join("; ")}${e.quotes.map((q) => ` · on: "${q}"`).join("")}`;
}

/** The AF part of a score line: `AF karma 87 (40 AF votes)`, bare `AF` when the forum has no AF score, `LW only` otherwise. */
function afPart(doc: ItemDoc): string {
  if (doc.af !== true) return FLAG.LW_ONLY;
  const score = numberOf(doc.afBaseScore);
  return score === undefined ? FLAG.AF : `${FLAG.afKarma(score)} (${counted(numberOf(doc.afVoteCount) ?? 0, "AF vote", "AF votes")})`;
}

/** Everything the page says about an item, read once. */
interface Facts { doc: ItemDoc; reactions: Reactions; likers: Reactor[]; hidden: boolean }

/** The first line: ¶4.14 Output layout. Hidden comment karma prints no number at all (P18). */
function scoreLine(kind: ResolvedKind, f: Facts, names: Names): string {
  const { doc } = f;
  if (f.hidden) return `${FLAG.KARMA_HIDDEN} · ${doc.af === true ? FLAG.AF : FLAG.LW_ONLY}`;
  const score = fmtInt(numberOf(doc.baseScore) ?? 0);
  const votes = counted(numberOf(doc.voteCount) ?? 0, "vote", "votes");
  if (kind === "tag" || kind === "lens") {
    const likes = `likes ${fmtInt(f.likers.length)}${f.likers.length > 0 ? `: ${peopleText(f.likers, names)}` : ""}`;
    return `${kind === "tag" ? "page score" : "lens score"} ${score} (${votes}) · ${likes}`;
  }
  const agreement = kind === "comment" && f.reactions.agreement !== undefined ? ` · ${agreementText(f.reactions.agreement)}` : "";
  return `karma ${score} (${votes}) · ${afPart(doc)}${agreement}`;
}

/** The lines of the item: its score, then why there is nothing more to say, or the reactions. */
function itemLines(kind: ResolvedKind, f: Facts, names: Names): string[] {
  const lines = [scoreLine(kind, f, names)];
  if (f.hidden) lines.push(HIDDEN_KARMA);
  else if (f.doc.extendedScore == null && (numberOf(f.doc.voteCount) ?? 0) <= 1) lines.push(NO_VOTES);
  else if (f.reactions.reacts.length === 0) lines.push(NO_REACTIONS);
  else lines.push(REACTIONS_HEAD, ...f.reactions.reacts.map((e) => reactionLine(e, names)));
  return lines;
}

/** The page title's subject: `post "…"`, `comment <id>`, `wiki page "…"` or `lens "…" of "…"`. */
function subjectOf(it: Resolved, doc: ItemDoc): string {
  switch (it.kind) {
    case "post": return `post "${it.name}"`;
    case "comment": return `comment ${it.id}`;
    case "lens": return `lens "${oneLine(doc.title, NAME) || oneLine(doc.tabTitle, NAME)}" of "${it.name}"`;
    default: return `wiki page "${it.name}"`;
  }
}

/** What a page prints: the title subject, the item's whole text and the notes. */
interface View { subject: string; text: string; notes: string[] }

/** Steps 4–6: the checks of a comment, the reactions, and the one request that names their people. */
async function viewOf(found: Found, ctx: CallContext, svc: Services): Promise<View> {
  const { item } = found;
  const doc = item.doc as ItemDoc;
  if (item.kind === "comment" && isPlaceholder({ deleted: doc.deleted === true, deletedPublic: doc.deletedPublic === true })) {
    throw badInput("comment", "this comment has no public reactions");
  }
  const hidden = item.kind === "comment" && (doc.hideKarma === true || numberOf(doc.baseScore) === undefined);
  const reactions = hidden ? parseReactions(null) : parseReactions(doc.extendedScore);
  const likers = !hidden && (item.kind === "tag" || item.kind === "lens") ? likersOf(doc.extendedScore) : [];
  // P7: the author of an anonymous post or comment is never named.
  const anonymous = doc.hideAuthor === true ? doc.user?._id ?? doc.userId ?? undefined : undefined;
  const names: Names = { users: await nameReactors(reactorIds(likers, reactions.reacts, anonymous), ctx, svc), anonymous };
  const text = itemLines(item.kind, { doc, reactions, likers, hidden }, names).join("\n");
  const shown = reactions.reacts.length > 0 || likers.length > 0;
  return { subject: subjectOf(item, doc), text, notes: shown ? [CAVEAT["C-REACT-SNAPSHOT"]] : [] };
}

// the page

/** What the cursor holds for the call: the arguments for the echo and every parameter's effective value (¶3.6). */
interface Stored { args: Record<string, unknown>; effective: Record<string, unknown> }

/**
 * One page: the item's text from `start` (the first page when undefined). Position and `next:` are percentages of the text
 * (a function of `Consumed` and of values captured here once); the cursor holds the offset the page reached.
 */
function reactionsPage(found: Found, view: View, start: SliceState | undefined, stored: Stored, maxTokens: number, svc: Services): ToolOutput {
  const { text } = view;
  const percent = (offset: number): number => Math.round((100 * offset) / text.length);
  const from = Math.min(start?.offset ?? 0, text.length);
  const first = percent(from);
  const item: PageItem = { text, ...(from > 0 && { from }), header: `Reactions of ${view.subject} (continued)` };
  const footerFor = (c: Consumed): Footer => {
    const next = sliceAfter(c, start, 1);
    if (next === undefined) return { kind: "end" };
    const cursor = mint(svc, "get_reactions", stored.args, stored.effective, { streams: [next], current: 0 });
    return { kind: "more", tool: "get_reactions", cursor, next: `reactions from ${percent(next.offset)} %` };
  };
  // ¶3.1.2's exception: a lens opens itself (its own votes and likes, with its lens_slug); a summary still stands for its page.
  const request = [echoOf(found.param, found.echo, { opens: found.item.kind === "lens" ? "part" : "page" })];
  return reply(
    {
      tool: "get_reactions", subject: view.subject, request,
      position: (c) => `reactions ${first}–${percent(c.sliceTo ?? text.length)} %`, notes: view.notes, head: [], items: [item],
    },
    maxTokens, svc, footerFor,
  );
}

// the tool

/** ¶3.6: every parameter but `cursor` and `max_tokens`, the identifier given as the id of the item it opened. */
function effectiveOf(param: Param, id: string): Record<string, unknown> {
  return { post: undefined, comment: undefined, tag: undefined, [param]: id };
}

/** The parameter and the identifier of a first call: `callTool` has checked that exactly one of them is given. */
function firstTarget(p: GetReactionsParams): { param: Param; value: string } {
  const given = PARAMS.filter((k) => p[k] !== undefined);
  const param = given[0];
  const value = param === undefined ? undefined : p[param];
  if (given.length !== 1 || param === undefined || value === undefined) throw internalError("get_reactions", "not exactly one of post, comment, tag");
  return { param, value };
}

/** The parameter and the identifier a continuation reads: the one the cursor holds, given again or taken from the first call. */
function continuationTarget(entry: CursorEntry, p: GetReactionsParams, ctx: CallContext): { param: Param; value: string } {
  const param = PARAMS.find((k) => typeof entry.effective[k] === "string");
  if (param === undefined) throw internalError("get_reactions", "a cursor without an item");
  // Another identifier is a different item (¶3.6): refused before anything is sent.
  for (const other of PARAMS) if (other !== param && p[other] !== undefined) checkContinuation(entry, { [other]: p[other] }, ctx);
  const value = p[param] ?? entry.args[param];
  if (typeof value !== "string") throw internalError("get_reactions", "a cursor without its identifier");
  return { param, value };
}

/** Where a continuation resumes: its stream is a `slice` over the item's text. */
function sliceOf(entry: CursorEntry): SliceState {
  const state = entry.state.streams[entry.state.current];
  if (state === undefined || state.kind !== "slice") throw internalError("get_reactions", "a cursor without a slice state");
  return state;
}

async function run(p: GetReactionsParams, ctx: CallContext, svc: Services): Promise<ToolOutput> {
  const entry = openContinuation("get_reactions", p.cursor, svc);
  const { param, value } = entry === undefined ? firstTarget(p) : continuationTarget(entry, p, ctx);
  const start = entry === undefined ? undefined : sliceOf(entry);
  const found = await readItem(parseRef(param, value, [param]), param, ctx, svc);
  const id = found.item.id;
  if (entry !== undefined) {
    checkContinuation(entry, { [param]: id }, ctx);
    // The caller's string now opens another item: the one this cursor read is no longer found by it.
    if (id !== entry.effective[param]) throw notFound(ENTITY[param], "id", String(entry.effective[param]));
  }
  const view = await viewOf(found, ctx, svc);
  const stored: Stored = entry === undefined
    ? { args: { [param]: value }, effective: effectiveOf(param, id) }
    : { args: { ...entry.args }, effective: { ...entry.effective } };
  return reactionsPage(found, view, start, stored, p.max_tokens, svc);
}

const schema = z.strictObject({
  post: P.post().optional(),
  comment: P.comment().optional(),
  tag: P.tag().optional(),
  cursor: P.cursor().optional(),
  max_tokens: P.maxTokens(),
});

export const tool: ToolDef<GetReactionsParams> = {
  name: "get_reactions",
  title: TITLE,
  description: `${DESCRIPTION_QUOTE}\n\n${CONVENTIONS_LINE}`,
  schema,
  oneOf: [["post", "comment", "tag"]],
  run,
};
