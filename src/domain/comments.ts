// Layer 3. Normalizes comment rows into `CommentRecord`s (¶3.8.1), places a list-form comment and names its parent (P1,
// P2, P5–P7, P14), and rebuilds a discussion's reply forest with the metrics read from the tree alone (¶4.4 steps 3–5,
// ¶3.8.6). Every author is masked by `authorOf` when the record is made, so everything computed per person afterwards
// sees only attributable authors (P19). Only the fields of the COMMENT_TREE and COMMENT_LIST fragments are read: the
// stale `Comment.author`, `postVersion`, `descendentCount`, `lastSubthreadActivity` and `directChildrenCount` never are
// (Q100, Q50.18, Q50.19). Pure: it never throws and never logs.
import { CONFIG } from "../config";
import { blockText } from "../text/sanitize";
import type {
  CommentRecord, Forest, ParentRef, Person, Place, RawCommentList, RawCommentRef, RawCommentTree, Thread, TreeNode,
} from "../types";
import { commentSignals, parseReactions } from "./reactions";
import { attributable, authorOf, commentPublic, isPlaceholder, maskPostRef, maskTagRef } from "./visibility";

type UserPerson = Extract<Person, { kind: "user" }>;

/** Q50.21, ¶3.8.2: a comment is `edited` only when its last edit came more than 60 s after it was posted. */
const EDITED_AFTER_MS = 60_000;

/** A COMMENT_LIST row carries the `post`, `tag` and `parentComment` joins; a COMMENT_TREE row does not. */
function isListRow(raw: RawCommentTree | RawCommentList): raw is RawCommentList {
  return "parentComment" in raw;
}

/**
 * ¶3.8.1: the record of a comment. The root is `topLevelCommentId ?? _id`. A placeholder (P5, D8) keeps its date, place
 * and reason only: no author, text, word count, scores or reactions. Under hidden karma (the post's `hideCommentKarma`,
 * the comment's `hideKarma`, or a null `baseScore`) karma, votes, AF karma, agreement and reactions are null or empty,
 * never 0 (P18, Q105). The moderator mark is kept only on an attributable comment (C4). `body` is set only when the row
 * carries its Markdown, so a record whose text was not fetched yet has none. A list row also gets its place and parent.
 */
export function toCommentRecord(raw: RawCommentTree | RawCommentList, opts?: { hideCommentKarma?: boolean }): CommentRecord {
  const placeholder = isPlaceholder(raw);
  const author = authorOf(raw.user, { hideAuthor: raw.hideAuthor, placeholder });
  const karmaHidden = !placeholder && (opts?.hideCommentKarma === true || raw.hideKarma || raw.baseScore === null);
  const scored = !placeholder && !karmaHidden;
  const postedMs = Date.parse(raw.postedAt);
  const list = isListRow(raw) ? { place: placeOf(raw), parent: parentOf(raw) } : undefined;

  const record: CommentRecord = {
    id: raw._id,
    author,
    postedAt: raw.postedAt,
    postedMs,
    edited: raw.lastEditedAt != null && Date.parse(raw.lastEditedAt) - postedMs > EDITED_AFTER_MS,
    karma: scored ? raw.baseScore : null,
    votes: scored ? raw.voteCount : null,
    afKarma: scored ? raw.afBaseScore : null,
    karmaHidden,
    af: raw.af,
    reactions: parseReactions(scored ? raw.extendedScore : null),
    parentId: raw.parentCommentId ?? null,
    rootId: raw.topLevelCommentId ?? raw._id,
    answer: raw.answer === true,
    retracted: raw.retracted === true,
    moderatorHat: raw.moderatorHat === true && attributable({ author }),
    // A list row's container is read through its masked place, so nothing is taken from a hidden post join, nor from the
    // post join of a wiki-discussion comment, which is placed by its tag (P1, tag first).
    quickTake: raw.shortform === true || list?.place.kind === "quick take",
    pinnedOnProfile: raw.isPinnedOnProfile === true,
    debateTurn: raw.debateResponse === true,
    wordCount: placeholder ? 0 : raw.contents?.wordCount ?? 0,
  };
  if (raw.reviewingForReview) record.reviewYear = raw.reviewingForReview;
  if (placeholder) record.placeholder = { reason: raw.deletedReason };
  else if (typeof raw.contents?.markdown === "string") record.body = blockText(raw.contents.markdown);
  if (list !== undefined) {
    record.place = list.place;
    record.parent = list.parent;
  }
  return record;
}

/**
 * ¶3.8.1, P1–P3, P12, Q69: where a list-form comment is, decided by `tagId` first. A wiki-discussion comment is placed
 * through its `tag` join alone (the post join is not consulted); any other comment through its `post` join, where a
 * quick-takes container makes it a quick take. A null or hidden join names nothing.
 */
export function placeOf(raw: RawCommentList): Place {
  if (raw.tagId != null) {
    const tag = maskTagRef(raw.tag);
    return tag.hidden ? { kind: "hidden tag" } : { kind: "tag", tag };
  }
  const post = maskPostRef(raw.post);
  if (post.hidden) return { kind: "hidden post" };
  return post.shortform ? { kind: "quick take", post } : { kind: "post", post };
}

/**
 * ¶3.8.1, P2, P5–P7, P14: the parent of a list-form comment. A parent that is not public is hidden, with no id; a
 * placeholder parent is a deleted comment with its id; otherwise its id, AF status and masked author (an anonymous parent
 * keeps only its id and AF status).
 */
export function parentOf(raw: RawCommentList): ParentRef {
  if (raw.parentCommentId == null) return { kind: "none" };
  const p = raw.parentComment;
  if (!commentPublic(p)) return { kind: "hidden" };
  if (isPlaceholder(p)) return { kind: "deleted", id: p._id };
  return { kind: "comment", id: p._id, af: p.af, author: authorOf(p.user, { hideAuthor: p.hideAuthor }) };
}

export interface ForestInput {
  comments: readonly RawCommentTree[];        // the post's `postCommentsOld` (or the tag's `tagDiscussionComments`) rows
  answers: readonly RawCommentTree[];         // `answersAndReplies` rows ([] on non-question posts and on tags)
  debateTurns?: readonly RawCommentRef[];     // `debateResponses` rows, used only to label replies to turns (§8.9)
  postAf: boolean;
  hideCommentKarma: boolean;
}

/** Siblings and roots in time order, then by id. */
function byTime(a: TreeNode, b: TreeNode): number {
  return a.c.postedMs - b.c.postedMs || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0);
}

/**
 * ¶4.4 steps 3–5: the reply forest of a discussion. Rows are taken from `comments` then `answers`, the first of each id;
 * rows that are not public (rejected, privately deleted, unreviewed after the cutoff: defence in depth, P2, P5, P6) and
 * debate turns are dropped. A comment with no parent is a root (answers are the roots of `A` threads); a comment whose
 * parent is missing becomes its own thread flagged with the turn's author when that parent is a public debate turn
 * (Q110), and otherwise is flagged as an orphan and hangs under its root, or is its own thread when the root is missing
 * too (Q52). Placeholders keep their place (P5). Metrics come from the tree alone. `truncated`: a list returned exactly
 * the forum limit of rows.
 */
export function buildForest(input: ForestInput): Forest {
  const byId = new Map<string, TreeNode>();
  const seen = new Set<string>();
  for (const row of [...input.comments, ...input.answers]) {
    if (seen.has(row._id)) continue;
    seen.add(row._id);
    if (!commentPublic(row) || row.debateResponse === true) continue;
    byId.set(row._id, { c: toCommentRecord(row, { hideCommentKarma: input.hideCommentKarma }), children: [], orphan: false });
  }
  const turns = new Map<string, RawCommentRef>();
  for (const turn of input.debateTurns ?? []) if (!turns.has(turn._id)) turns.set(turn._id, turn);

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const { id, parentId, rootId } = node.c;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(parentId);
    if (parent !== undefined) {
      parent.children.push(node);
      continue;
    }
    const turn = turns.get(parentId);
    if (commentPublic(turn)) {
      node.debateReplyTo = authorOf(turn.user, { hideAuthor: turn.hideAuthor, placeholder: isPlaceholder(turn) });
      roots.push(node);
      continue;
    }
    node.orphan = true;
    const root = rootId === id ? undefined : byId.get(rootId);
    (root === undefined ? roots : root.children).push(node);
  }
  for (const node of byId.values()) node.children.sort(byTime);

  let afCount = 0;
  let hasVoteData = false;
  for (const node of byId.values()) {
    if (node.c.af) afCount++;
    if (node.c.reactions.hasVoteData) hasVoteData = true;
  }
  const limit = CONFIG.paging.forestLimit;
  return {
    threads: roots.sort(byTime).map(toThread),
    byId,
    count: byId.size,
    afCount,
    postAf: input.postAf,
    hideCommentKarma: input.hideCommentKarma,
    hasVoteData,
    truncated: input.comments.length === limit || input.answers.length === limit,
  };
}

/** The nodes under `root` in reading order: depth first, each node before its replies. */
function readingOrder(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return nodes;
}

/** ¶4.4 step 5: one thread and its metrics; participants count attributable people only (P19). */
function toThread(root: TreeNode): Thread {
  const nodes = readingOrder(root);
  const people = new Set<string>();
  let af = false;
  let newestMs = root.c.postedMs;
  let signals = 0;
  for (const node of nodes) {
    const id = uid(node);
    if (id !== null) people.add(id);
    if (node.c.af) af = true;
    if (node.c.postedMs > newestMs) newestMs = node.c.postedMs;
    signals += commentSignals(node.c).contested;
  }
  return {
    rootId: root.c.id, root, answer: root.c.answer, nodes, size: nodes.length, participants: people.size,
    rootKarma: root.c.karma, rootAfKarma: root.c.af ? root.c.afKarma : null, af, postedMs: root.c.postedMs, newestMs,
    contested: signals + exchangesUnder(root, root.c.id).length,
  };
}

/** P19: the named author of an attributable comment, else `null` (placeholder, anonymous author, deleted account). */
function userOf(node: TreeNode): UserPerson | null {
  if (!attributable(node.c)) return null;
  const author = node.c.author;
  return author.kind === "user" ? author : null;
}

function uid(node: TreeNode): string | null {
  return userOf(node)?.id ?? null;
}

export interface BackAndForth { a: UserPerson; b: UserPerson; replies: number; fromId: string; toId: string; rootId: string }

/**
 * ¶3.8.6: the back-and-forths of a thread: reply chains in which the same two attributable people (P19) alternate for at
 * least 4 consecutive comments. An unattributed comment breaks a chain; a new pair starts at the last comment of the old
 * one. Branches that share a start count once, keeping the longest (ties keep the first found), in the order the walk
 * first found each start.
 */
export function backAndForths(thread: Thread): BackAndForth[] {
  return exchangesUnder(thread.root, thread.rootId);
}

function exchangesUnder(root: TreeNode, rootId: string): BackAndForth[] {
  const longest = new Map<string, readonly TreeNode[]>();
  const keep = (chain: readonly TreeNode[]): void => {
    const start = chain[0]!.c.id;
    const kept = longest.get(start);
    if (kept === undefined || chain.length > kept.length) longest.set(start, chain);
  };
  // A depth-first walk carrying the alternating chain that ends at the parent.
  const visit = (n: TreeNode, run: readonly TreeNode[]): void => {
    const me = uid(n);
    const last = run.at(-1);
    const before = run.at(-2);
    const next = me === null ? []
      : last && uid(last) !== me && (!before || uid(before) === me) ? [...run, n]
      : last && uid(last) !== me ? [last, n]
      : [n];
    const continues = n.children.some((ch) => {
      const u = uid(ch);
      return u !== null && u !== me && (next.length < 2 || uid(next.at(-2)!) === u);
    });
    if (!continues && next.length >= 4) keep(next);
    for (const ch of n.children) visit(ch, next);
  };
  visit(root, []);
  return [...longest.values()].map((chain) => ({
    a: userOf(chain[0]!)!, b: userOf(chain[1]!)!, replies: chain.length, fromId: chain[0]!.c.id,
    toId: chain.at(-1)!.c.id, rootId,
  }));
}
