// Helpers every get_feed test file shares (a helper a second test file needs lives here, never copied).
import { createHarness } from "./harness";
import type { FixtureEntry } from "./fixtures";

export const h0 = (extra: FixtureEntry[] = []) => createHarness({ families: ["feeds"], extra });
export const feed = (h: ReturnType<typeof h0>, args: Record<string, unknown>) => h.call("get_feed", args).then((o) => o.text);
export const ids = (text: string) => [...text.matchAll(/post_id ([A-Za-z0-9]{17})/g)].map((m) => m[1]);
export const RD_SEL = "{ cutoff endOffset results { type postCommented { ...POST_CARD recentComments(commentsLimit: 3, maxAgeHours: 18) { ...COMMENT_LIST } } shortformCommented { ...POST_REF lastCommentedAt user { _id slug displayName } recentComments(commentsLimit: 3, maxAgeHours: 18) { ...COMMENT_LIST } } tagDiscussed { ...TAG_REF } tagRevised { _id documentId editedAt changeMetrics tag { ...TAG_REF } } } }";
export const WA_SEL = "{ cutoff endOffset results { type tagCreated { ...TAG_REF } tagRevision { _id documentId editedAt changeMetrics user { _id slug displayName } tag { ...TAG_REF } } tagDiscussionComment { ...COMMENT_LIST } } }";
