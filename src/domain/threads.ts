// Layer 3. What `get_comments` derives from a discussion's reply forest (`domain/comments.buildForest`): the thread
// ranking of ¶3.3 and ¶4.4 steps 6–7 with the `user` and `af_only` filters (steps 8 and 10), the T/A labels of ¶3.8.1,
// the signals block of ¶4.4 step 13 with the no-data lines of ¶3.8.6, the reply map and the most active commenters
// (step 8), and the choice of bodies to fetch (step 12). Everything per person counts attributable comments only (P19):
// the authors were masked by `domain/visibility.authorOf` when the records were made. Every metric comes from the tree,
// never from the forum's drifting counters (Q50.18). Pure: it never throws, never logs and caches nothing.
import { CONFIG } from "../config";
import { oneLine } from "../text/sanitize";
import type { CommentRecord, Forest, Person, RankedThread, Thread, TreeNode } from "../types";
import { commentSignals, inReactionSet, visibleReacts, type CommentSignals } from "./reactions";
import { attributable } from "./visibility";

type UserPerson = Extract<Person, { kind: "user" }>;

export type CommentSort = "top" | "af_top" | "new" | "old" | "largest" | "contested" | "active";

/** ¶3.8.6, exact text: no comment of the discussion carries reactions or agreement votes. */
export const NO_VOTE_DATA_LINE =
  "No reactions or agreement votes are recorded on this discussion (older discussions predate them); contested uses split karma votes and back-and-forth replies only.";
/** ¶3.8.6, exact text: added to `NO_VOTE_DATA_LINE` when, in addition, every thread scores 0. */
export const NO_SIGNALS_LINE =
  "No disagreement signals were found, so threads are ranked by size, then karma. That does not show that nobody disagreed: read the threads.";

/** P19: the named author of an attributable comment, else `null` (deleted placeholder, anonymous author, deleted account). */
function personOf(c: CommentRecord): UserPerson | null {
  const author = c.author;
  return attributable(c) && author.kind === "user" ? author : null;
}

const byPerson = (userId: string) => (n: TreeNode): boolean => personOf(n.c)?.id === userId;

/** Higher first; a `null` (hidden) value after every number. */
function numberDesc(a: number | null, b: number | null): number {
  const x = a ?? -Infinity;
  const y = b ?? -Infinity;
  return x > y ? -1 : x < y ? 1 : 0;
}

function idDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

type ThreadOrder = (a: Thread, b: Thread) => number;

/** ¶3.3: the tie-break of every locally sorted set: newer first, then `_id` descending. */
const newerFirst: ThreadOrder = (a, b) => b.postedMs - a.postedMs || idDesc(a.rootId, b.rootId);

/** `af_top`: the AF group is the threads whose root is on AF with a visible AF karma. */
const inAfGroup = (t: Thread): boolean => t.root.c.af && t.rootAfKarma !== null;

/** ¶3.3 the main keys of each sort, before the tie-break. */
const MAIN_KEYS: Readonly<Record<CommentSort, ThreadOrder>> = {
  top: (a, b) => numberDesc(a.rootKarma, b.rootKarma),
  af_top: (a, b) => {
    const afA = inAfGroup(a);
    const afB = inAfGroup(b);
    if (afA !== afB) return afA ? -1 : 1;
    return afA ? numberDesc(a.rootAfKarma, b.rootAfKarma) : numberDesc(a.rootKarma, b.rootKarma);
  },
  new: (a, b) => b.postedMs - a.postedMs,
  old: (a, b) => a.postedMs - b.postedMs,
  largest: (a, b) => b.size - a.size,
  // ¶3.8.6: contested ties by largest, then top.
  contested: (a, b) => b.contested - a.contested || b.size - a.size || numberDesc(a.rootKarma, b.rootKarma),
  active: (a, b) => b.newestMs - a.newestMs,
};

/** P18, ¶4.4 step 6: the sorts under which threads whose root karma is hidden rank after the others, newer first. */
const HIDDEN_KARMA_LAST: ReadonlySet<CommentSort> = new Set<CommentSort>(["top", "af_top", "contested"]);

function sortThreads(threads: readonly Thread[], sort: CommentSort): Thread[] {
  const main = MAIN_KEYS[sort];
  const order: ThreadOrder = (a, b) => main(a, b) || newerFirst(a, b);
  if (!HIDDEN_KARMA_LAST.has(sort)) return [...threads].sort(order);
  const visible = threads.filter((t) => t.rootKarma !== null).sort(order);
  const hidden = threads.filter((t) => t.rootKarma === null).sort(newerFirst);
  return [...visible, ...hidden];
}

/**
 * ¶3.3, ¶4.4 steps 6–8 and 10: the threads ranked by `sort`, answer threads first (labelled `A1…`, each group ranked by
 * the same sort), then the others (`T1…`). `userId` keeps the threads holding an attributable comment by that person
 * (P19); `afOnly` keeps the threads holding at least one AF comment, whole and in the same order (D2). `rank` is the
 * 1-based position among the threads that remain.
 */
export function rankThreads(forest: Forest, sort: CommentSort, opts?: { userId?: string; afOnly?: boolean }): RankedThread[] {
  const userId = opts?.userId;
  const kept = forest.threads.filter((t) =>
    (userId === undefined || t.nodes.some(byPerson(userId))) && (opts?.afOnly !== true || t.af));
  const answers = sortThreads(kept.filter((t) => t.answer), sort);
  const others = sortThreads(kept.filter((t) => !t.answer), sort);
  return [
    ...answers.map((thread, i) => ({ thread, label: `A${i + 1}` })),
    ...others.map((thread, i) => ({ thread, label: `T${i + 1}` })),
  ].map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * ¶3.8.1: the label of every comment of the ranked threads: the root takes the thread's label, and the `i`-th reply
 * (1-based, in time order) of a comment labelled `L` is `L.i`. Entries are in ranked order, then reading order.
 */
export function labelsOf(ranked: readonly RankedThread[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const rt of ranked) {
    const stack: [TreeNode, string][] = [[rt.thread.root, rt.label]];
    while (stack.length > 0) {
      const [node, label] = stack.pop()!;
      labels.set(node.c.id, label);
      for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i]!, `${label}.${i + 1}`]);
    }
  }
  return labels;
}

/** The tie-break of the signal and mark lists: newer first, then id descending. */
function newerNodeFirst(a: TreeNode, b: TreeNode): number {
  return b.c.postedMs - a.c.postedMs || idDesc(a.c.id, b.c.id);
}

export interface SignalLine { node: TreeNode; label: string; signals: CommentSignals; quote?: string }

/**
 * ¶4.4 step 13: the signals block's comments: those with a label (the threads left after filters) and `contested ≥ 1`,
 * by `contested`, then agreement votes, then newer first, then id; at most `max`. `quote` is the first quoted passage of
 * the first visible disagreement reaction that has one, cut to 100 characters.
 */
export function signalComments(forest: Forest, labels: ReadonlyMap<string, string>, max: number = CONFIG.render.signalsMax): SignalLine[] {
  const lines: SignalLine[] = [];
  for (const [id, label] of labels) {
    const node = forest.byId.get(id);
    if (node === undefined) continue;
    const signals = commentSignals(node.c);
    if (signals.contested < 1) continue;
    const line: SignalLine = { node, label, signals };
    const quoted = visibleReacts(node.c.reactions).find((e) => inReactionSet(e.name, "disagreement") && e.quotes.length > 0);
    if (quoted !== undefined) line.quote = oneLine(quoted.quotes[0], CONFIG.render.caps.signalQuote);
    lines.push(line);
  }
  const votes = (l: SignalLine): number => l.node.c.reactions.agreement?.votes ?? 0;
  return lines
    .sort((a, b) => b.signals.contested - a.signals.contested || votes(b) - votes(a) || newerNodeFirst(a.node, b.node))
    .slice(0, max);
}

/**
 * ¶4.4 step 13: "Marked as crux" and "Changed someone's mind": every comment of the forest whose visible reactions of
 * that set net above 0, by that net, then newer first, then id; at most `max`. A caller that shows only the threads left
 * after filters keeps the ones with a label.
 */
export function markedComments(
  forest: Forest, set: "crux" | "mindChange", max: number = set === "crux" ? CONFIG.render.cruxMax : CONFIG.render.mindChangeMax,
): TreeNode[] {
  const marked: { n: number; node: TreeNode }[] = [];
  for (const node of forest.byId.values()) {
    const n = commentSignals(node.c)[set];
    if (n > 0) marked.push({ n, node });
  }
  return marked.sort((a, b) => b.n - a.n || newerNodeFirst(a.node, b.node)).slice(0, max).map((m) => m.node);
}

/**
 * ¶3.8.6: the no-data lines, when no comment of the discussion carries reactions or agreement votes. Not under the post's
 * `hideCommentKarma` (P18): the forum then nulls every score, each comment says `karma not publicly visible`, and the discussion's age is not
 * the reason.
 */
export function noDataLines(forest: Forest, ranked: readonly RankedThread[]): string[] {
  if (forest.hasVoteData || forest.hideCommentKarma) return [];
  return ranked.every((r) => r.thread.contested === 0) ? [NO_VOTE_DATA_LINE, NO_SIGNALS_LINE] : [NO_VOTE_DATA_LINE];
}

export interface ReplyMapEntry {
  node: TreeNode;
  label: string;
  replies: { node: TreeNode; label: string; repliedBack: string[]; more: number }[];
}

/** The person's attributable comments under `reply` (itself excluded), in reading order: the first `max` ids and the rest's count. */
function repliedBackUnder(reply: TreeNode, userId: string, max: number): { repliedBack: string[]; more: number } {
  const repliedBack: string[] = [];
  let more = 0;
  const stack = [...reply.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (personOf(node.c)?.id === userId) {
      if (repliedBack.length < max) repliedBack.push(node.c.id);
      else more++;
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return { repliedBack, more };
}

/**
 * ¶4.4 step 8, P19: the reply map of a person, in label order: for each of their attributable comments with a label
 * (with `rootId`, only those among the nodes of the thread whose `rootId` it is, which for a root-less orphan or a reply
 * to a debate turn differs from the comments' own `rootId`), every direct reply with its label and the ids of the
 * person's attributable comments further down that reply's subtree (at most 5, then how many more). Unattributed
 * replies are listed like the others; the renderer prints their reason, never a name. `labels` must come from `labelsOf`,
 * which labels whole threads, so every reply of a labelled comment has a label.
 */
export function replyMap(forest: Forest, labels: ReadonlyMap<string, string>, userId: string, rootId?: string): ReplyMapEntry[] {
  const inScope = rootId === undefined ? undefined : new Set(forest.threads.find((t) => t.rootId === rootId)?.nodes.map((n) => n.c.id));
  const mine = byPerson(userId);
  const entries: ReplyMapEntry[] = [];
  for (const [id, label] of labels) {
    const node = forest.byId.get(id);
    if (node === undefined || !mine(node) || (inScope !== undefined && !inScope.has(id))) continue;
    entries.push({
      node,
      label,
      replies: node.children.map((reply) => ({
        node: reply,
        label: labels.get(reply.c.id)!,
        ...repliedBackUnder(reply, userId, CONFIG.render.replyBackIdsMax),
      })),
    });
  }
  return entries;
}

/**
 * ¶4.4 errors (the empty `user` template), P19: the people with the most attributable comments in the discussion, by
 * count, then display name, then id; at most `max`.
 */
export function mostActive(forest: Forest, max: number): { person: UserPerson; count: number }[] {
  const counts = new Map<string, { person: UserPerson; count: number }>();
  for (const node of forest.byId.values()) {
    const person = personOf(node.c);
    if (person === null) continue;
    const seen = counts.get(person.id);
    if (seen === undefined) counts.set(person.id, { person, count: 1 });
    else seen.count++;
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name)
      || (a.person.id < b.person.id ? -1 : a.person.id > b.person.id ? 1 : 0))
    .slice(0, max);
}

/**
 * ¶4.4 step 12 (S12): which bodies phase B fetches. A body is estimated at `wordCount × 7` bytes; when the forest's total
 * is at most 409,600 bytes, or with `match`, every body is fetched (thread order, then reading order), otherwise only
 * the page's (`pageIds`, in their order). Placeholders (which have no body), unknown ids and bodies already present are
 * never requested.
 */
export function selectBodies(forest: Forest, opts: { match: boolean; pageIds: readonly string[] }): { all: boolean; ids: string[] } {
  let estimate = 0;
  for (const node of forest.byId.values()) estimate += node.c.wordCount * CONFIG.paging.bytesPerWord;
  const all = opts.match || estimate <= CONFIG.paging.bodiesAllMaxBytes;
  const wanted = all ? forest.threads.flatMap((t) => t.nodes.map((n) => n.c.id)) : opts.pageIds;
  const ids = wanted.filter((id) => {
    const c = forest.byId.get(id)?.c;
    return c !== undefined && c.placeholder === undefined && c.body === undefined;
  });
  return { all, ids };
}

/** The thread whose nodes hold the comment (an orphan is in the thread it hangs under), or `undefined`. */
export function threadOf(forest: Forest, commentId: string): Thread | undefined {
  if (!forest.byId.has(commentId)) return undefined;
  return forest.threads.find((t) => t.nodes.some((n) => n.c.id === commentId));
}
