// The `Type.field` pairs no template may select (R8): test data, because only the schema says which type a selected field
// belongs to. test/support/schemaCheck.ts refuses them in every template and request the tests build, and
// test/forum/forbidden.test.ts checks that each exists in the forum's schema. The text-only guard (src/forum/forbidden.ts)
// refuses the subset that is denied on every type by name alone.
/** `Type.field` pairs that are never selected: R8's fields, the fields of §4.9 and the never-used fields of ¶B. */
export const DENIED_FIELDS: readonly string[] = Object.freeze([
  "Post.tableOfContents", "Post.tableOfContentsRevision", "Tag.tableOfContents", "MultiDocument.tableOfContents",
  "Tag.htmlWithContributorAnnotations", "MultiDocument.htmlWithContributorAnnotations", "Post.htmlBody", "Comment.htmlBody",
  "Revision.htmlHighlightStartingAtHash", "User.username", "User.oldSlugs", "User.sequenceCount", "User.mapLocation",
  "User.mapLocationLatLng", "Comment.allVotes", "Comment.isBookmarked", "Post.isBookmarked", "Comment.pageUrl",
  "Comment.pageUrlRelative", "Tag.usersWhoLiked", "Post.revisions", "Post.tagRel", "User.posts", "Post.sequence", "Post.prevPost",
  "Post.nextPost", "Post.canonicalNextPostSlug", "Post.canonicalPrevPostSlug", "Post.createdAt", "Post.draft", "Post.viewCount",
  "Post.clickCount", "Post.currentUserVote", "Post.suggestForCuratedUserIds", "Post.hideFromPopularComments", "Post.autoFrontpage",
  "Post.rejectedReason", "Comment.createdAt", "Comment.userIP", "Comment.currentUserVote", "Comment.userAgent", "Comment.referrer",
  "Comment.rejectedReason", "Comment.automatedContentEvaluations", "User.email", "User.emails", "User.previousDisplayName",
  "User.voteCount", "User.voteReceivedCount", "User.lastNotificationsCheck", "User.reviewedAt", "User.isReviewed",
  "User.recentKarmaInfo", "User.karmaChanges", "User.location", "User.googleLocation", "User.postingDisabled", "User.banned",
  "User.bannedUserIds", "Tag.autoTagModel", "Tag.autoTagPrompt", "Post.score", "Comment.score", "Post.maxBaseScore",
  "Post.topLevelCommentCount", "Post.afLastCommentedAt", "Post.modifiedAt", "Post.postCategory", "Post.afDate", "Post.pingbacks",
  "Comment.descendentCount", "Comment.lastSubthreadActivity", "Comment.directChildrenCount", "Comment.postVersion", "Comment.author",
  "User.profileUpdatedAt",
]);
