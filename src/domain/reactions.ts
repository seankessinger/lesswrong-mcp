// Layer 3. Reads a vote document (`extendedScore`) into `Reactions` and derives the per-comment disagreement signals of
// ¶3.8.6. `extendedScore` is a JSON scalar the forum fills in several shapes (null; agreement only; reacts and
// agreement; `usersWhoLiked` on pages and lenses; §13.3), so every read is defensive and a value of the wrong shape is
// treated as absent (Q108, L10). Only reactions, agreement and likers are read (Q76, Q50.11, Q50.22).
// P11 is applied at the source: only reactions with a net above 0 are kept, sorted by net and then by name, so
// `visibleReacts` is idempotent on `parseReactions` output. Pure: it never throws and never logs.
import { CONFIG } from "../config";
import { oneLine } from "../text/sanitize";
import type { CommentRecord, ReactEntry, Reactions, Reactor } from "../types";

type ReactionSet = keyof typeof CONFIG.reactionSets;

/** The three kinds of reactor lists of a react entry; an entry of any other `reactType` is ignored. */
const KINDS = ["created", "seconded", "disagreed"] as const;
type Kind = (typeof KINDS)[number];

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Code-point order, which differs from `<` on UTF-16 units only when an astral character meets U+E000 to U+FFFF. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** The person `userId` of an entry, with the entry's display name when that is a string. */
function personOf(x: Record<string, unknown>, userId: string): Reactor {
  const reactor: Reactor = { userId };
  if (typeof x["displayName"] === "string") reactor.name = x["displayName"];
  return reactor;
}

/** Q76, L10: a react entry's user id is its `userId` when that is a string. An entry without one is `{}`: counted, never named. */
function reactorOf(x: unknown): Reactor {
  return isRecord(x) && typeof x["userId"] === "string" ? personOf(x, x["userId"]) : {};
}

/**
 * L10: a `usersWhoLiked` entry's user id is its `userId` when that is a string, else its `_id` when that is a string. The live
 * check of 2026-10-24 saw all 139 liker entries of pages and lenses as `{_id, displayName}`, the `_id` being the liker's user id
 * (the same id as that user's own record); `{userId, displayName}` is the schema's `UserLikingTag`, the shape of
 * `Tag.usersWhoLiked`, which is never selected. An entry with neither is `{}`: counted, never named. React entries keep
 * `reactorOf`: nothing shows that they carry `_id`.
 */
function likerOf(x: unknown): Reactor {
  if (!isRecord(x)) return {};
  const userId = [x["userId"], x["_id"]].find((id): id is string => typeof id === "string");
  return userId === undefined ? {} : personOf(x, userId);
}

/** P11: highest net first, then stored name in code-point order. */
const byNetThenName = (a: ReactEntry, b: ReactEntry): number => b.net - a.net || byCodePoint(a.name, b.name);

/**
 * ¶3.8.6, Q107, Q108: the reactions, agreement and likers of an `extendedScore`. Net = created + seconded − disagreed;
 * only net > 0 is kept (P11). Agreement is present only with at least one agreement vote, so no
 * `agreement +0 (0 agreement votes)` is ever printed. `hasVoteData` is computed before the net > 0 drop: a discussion
 * whose reactions all cancelled out was still voted on.
 */
export function parseReactions(extendedScore: unknown): Reactions {
  const reacts: ReactEntry[] = [];
  let counted = 0;
  const raw = isRecord(extendedScore) ? extendedScore : {};

  if (isRecord(raw["reacts"])) {
    for (const [key, value] of Object.entries(raw["reacts"])) {
      if (!Array.isArray(value)) continue;
      // A react whose stored name is blank once on one line is of no shape this server can print: absent, like a malformed entry.
      const name = oneLine(key, CONFIG.render.caps.name);
      if (name === "") continue;
      const lists: Record<Kind, Reactor[]> = { created: [], seconded: [], disagreed: [] };
      const quotes: string[] = [];
      for (const item of value) {
        if (!isRecord(item)) continue;
        const kind = KINDS.find((k) => k === item["reactType"]);
        if (kind === undefined) continue;
        lists[kind].push(reactorOf(item));
        counted++;
        if (Array.isArray(item["quotes"])) {
          for (const q of item["quotes"]) {
            if (typeof q !== "string") continue;
            const quote = oneLine(q, CONFIG.render.caps.reactQuote);
            if (quote !== "" && !quotes.includes(quote)) quotes.push(quote);   // a blank quote anchors nothing
          }
        }
      }
      const net = lists.created.length + lists.seconded.length - lists.disagreed.length;
      if (net > 0) reacts.push({ name, net, ...lists, quotes });
    }
  }
  reacts.sort(byNetThenName);

  const votes = raw["agreementVoteCount"];
  const agreement = isCount(votes) && votes >= 1
    ? { score: isCount(raw["agreement"]) ? raw["agreement"] : 0, votes }
    : undefined;

  const likers = Array.isArray(raw["usersWhoLiked"]) ? raw["usersWhoLiked"].map(likerOf) : [];

  return {
    reacts,
    ...(agreement === undefined ? {} : { agreement }),
    likers,
    hasVoteData: counted > 0 || agreement !== undefined,
  };
}

/** P11: the reactions with a net above 0, highest net first, then by name; a new array. */
export function visibleReacts(r: Reactions): ReactEntry[] {
  return r.reacts.filter((e) => e.net > 0).sort(byNetThenName);
}

/** ¶3.8.6: `name net` by stored name, at most `max` of them, then ` +N more`; the empty string for no entries. */
export function reactSummary(entries: readonly ReactEntry[], max: number = CONFIG.render.reactsShown): string {
  const shown = entries.slice(0, max).map((e) => `${e.name} ${e.net}`).join(", ");
  const rest = entries.length - max;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** L7: exact membership of a stored react name in one of the sets of `CONFIG.reactionSets`; an unknown name is in none. */
export function inReactionSet(name: string, set: ReactionSet): boolean {
  return (CONFIG.reactionSets[set] as readonly string[]).includes(name);
}

export interface CommentSignals { contested: number; labels: string[]; crux: number; mindChange: number }

/**
 * ¶3.8.6: what makes one comment contested, from public aggregates only. `contested` adds 1 for each unit of net
 * disagreement reactions and 1 for each of `agreement disputed`, `agreement split` and `karma split`; `labels` names the
 * ones that applied, in that order. `crux` and `mindChange` are the nets of the visible reactions of those sets. Under
 * hidden karma none of it applies (P18).
 */
export function commentSignals(c: Pick<CommentRecord, "karma" | "votes" | "karmaHidden" | "reactions">): CommentSignals {
  const none: CommentSignals = { contested: 0, labels: [], crux: 0, mindChange: 0 };
  if (c.karmaHidden) return none;

  const visible = visibleReacts(c.reactions);
  const labels: string[] = [];
  let contested = 0;
  for (const e of visible) {
    if (!inReactionSet(e.name, "disagreement")) continue;
    contested += e.net;
    labels.push(`${e.name} ${e.net}`);
  }

  const agreement = c.reactions.agreement;
  if (agreement !== undefined) {
    if (agreement.score < 0 && agreement.votes >= 2) { contested++; labels.push("agreement disputed"); }
    if (agreement.votes >= 3 && Math.abs(agreement.score) < agreement.votes) { contested++; labels.push("agreement split"); }
  }
  if (c.votes != null && c.karma != null && c.votes >= 5 && c.karma < c.votes / 2) { contested++; labels.push("karma split"); }

  const netOf = (set: ReactionSet): number =>
    visible.reduce((sum, e) => (inReactionSet(e.name, set) ? sum + e.net : sum), 0);
  return { contested, labels, crux: netOf("crux"), mindChange: netOf("mindChange") };
}

/**
 * L10: the people who liked a page or a lens, from its own `extendedScore.usersWhoLiked`, each by its `userId` or `_id` (`likerOf`);
 * unnamed entries are counted as `{}`.
 */
export function likersOf(extendedScore: unknown): Reactor[] {
  return parseReactions(extendedScore).likers;
}
