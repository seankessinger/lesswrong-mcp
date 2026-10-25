// Layer 3. The status flags of a post (¶3.8.2), computed from the fields of the POST_CARD fragment alone. `postCategory`
// and every other field the fragments do not select are never read (Q50.6). Pure: it never throws and never logs.
import type { RawPostCard, RawPostFull, StatusFlags } from "../types";

/** Q115, ¶3.4: the five known essays dated 1 January before 2009 carry a placeholder date, not a real posting time. */
function placeholderDate(postedAt: string): boolean {
  const posted = new Date(postedAt);
  return posted.getUTCMonth() === 0 && posted.getUTCDate() === 1 && posted.getUTCFullYear() < 2009;
}

/**
 * ¶3.8.2: `curatedDate`, `bestOf` and `linkUrl` are present only when set. `bestOf.rank` is `reviewRanking + 1`.
 * A linkpost is a post with a non-blank `url` (Q117), not one whose `postCategory` says so (`postCategory` is stale, Q50.6).
 */
export function postStatus(raw: RawPostCard | RawPostFull): StatusFlags {
  return {
    ...(raw.curatedDate != null && { curatedDate: raw.curatedDate }),
    frontpage: raw.frontpageDate != null,
    pinned: raw.sticky,
    ...(raw.reviewWinner != null && {
      bestOf: { year: raw.reviewWinner.reviewYear, category: raw.reviewWinner.category, rank: raw.reviewWinner.reviewRanking + 1 },
    }),
    question: raw.question,
    ...(raw.url != null && raw.url.trim() !== "" && { linkUrl: raw.url }),
    dialogue: raw.collabEditorDialogue,
    debate: raw.debate,
    event: raw.isEvent,
    shortform: raw.shortform,
    subQuestion: raw.hiddenRelatedQuestion,
    groupPost: typeof raw.groupId === "string" && raw.groupId !== "",
    unlisted: raw.unlisted,
    placeholderDate: placeholderDate(raw.postedAt),
  };
}
