// Layer 3. Normalizes a user row into a `UserRecord` or `UserProfile` (¶3.8.1, ¶3.5). Only the USER_CARD and USER_PROFILE
// fields the records name are read (P13, Q50.28, Q50.29, P10, Q50.27). The only group that is carried is Alignment Forum
// membership (D9). Names stay as the forum gives them; the renderer cuts them. Pure: it never throws and never logs.
import { CONFIG } from "../config";
import { blockText } from "../text/sanitize";
import type { RawUserCard, RawUserProfile, UserProfile, UserRecord } from "../types";
import { excerptOf } from "./posts";

/** "Omitted when empty": the trimmed text, or `undefined` when the value is missing or blank. */
function present(s: string | null | undefined): string | undefined {
  const text = s?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/** ¶3.5, D9: the AF karma and `AF member` (from `groups`) are the only account facts beyond the counters; no other group is read. */
export function toUserRecord(raw: RawUserCard): UserRecord {
  const record: UserRecord = {
    id: raw._id,
    slug: raw.slug,
    name: raw.displayName,
    createdAt: raw.createdAt,
    karma: raw.karma,
    afKarma: raw.afKarma,
    afMember: (raw.groups ?? []).includes(CONFIG.afGroup),
    postCount: raw.postCount,
    commentCount: raw.commentCount,
  };
  const job = present(raw.jobTitle);
  if (job !== undefined) record.job = job;
  const org = present(raw.organization);
  if (org !== undefined) record.org = org;
  const bioExcerpt = excerptOf(raw.biography?.plaintextDescription, CONFIG.render.bioCardChars);
  if (bioExcerpt !== undefined) record.bioExcerpt = bioExcerpt;
  return record;
}

/** ¶3.8.1: the profile links that are set, in the fixed order of the profile page. */
function linksOf(raw: RawUserProfile): UserProfile["links"] {
  const candidates: [label: string, value: string | null][] = [
    ["website", raw.website],
    ["X/Twitter", raw.twitterProfileURL],
    ["GitHub", raw.githubProfileURL],
    ["LinkedIn", raw.linkedinProfileURL],
    ["Bluesky", raw.blueskyProfileURL],
    ["Facebook", raw.facebookProfileURL],
  ];
  const links: UserProfile["links"] = [];
  for (const [label, value] of candidates) {
    const url = present(value);
    if (url !== undefined) links.push({ label, url });
  }
  return links;
}

/**
 * ¶3.8.1: the card plus the bio and the two help texts as block text, the links and the pinned post ids.
 */
export function toUserProfile(raw: RawUserProfile): UserProfile {
  const profile: UserProfile = {
    ...toUserRecord(raw),
    links: linksOf(raw),
    pinnedPostIds: raw.pinnedPostIds ?? [],
  };
  const bio = present(blockText(raw.biography?.markdown));
  if (bio !== undefined) profile.bio = bio;
  const helpMe = present(blockText(raw.howOthersCanHelpMe?.markdown));
  if (helpMe !== undefined) profile.helpMe = helpMe;
  const helpOthers = present(blockText(raw.howICanHelpOthers?.markdown));
  if (helpOthers !== undefined) profile.helpOthers = helpOthers;
  return profile;
}
