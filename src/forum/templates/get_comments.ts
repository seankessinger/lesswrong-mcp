// Layer 4. What the subject request of `get_comments` (¶4.4 step 1) asks of each kind; the tool builds the request from
// `ids/resolve`'s ops with the bare aliases `readResolution` reads. The post with `...POST_CARD hideCommentKarma` (its header
// fields and its hidden-karma switch), the wiki page (a tag, or a lens or summary that stands for its page) with resolve's own
// fields, the comment with `...COMMENT_LIST` (its post and tag joins are the check of its discussion's subject, P1, P17), and the
// person, by id or slug. A slug resolves and checks in the same request (¶3.1.2). Pure: constants only.

/** The fields of the subject request by kind; a wiki page's are resolve's own. */
export const SUBJECT_SELECT = {
  post: "...POST_CARD hideCommentKarma",
  /** The comment with its joins, and its post's `debate` flag, which decides where a debate turn is read (#116). */
  comment: "...COMMENT_LIST post { ...POST_REF debate }",
  /**
   * The display name too, so that a message can name the person; the karma too, so that the ¶3.7 echo of this call and of every
   * later tool that finds the person in the resolution cache shows it (a namesake is visible at once).
   */
  user: "_id slug displayName karma",
} as const;
