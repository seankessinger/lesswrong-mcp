// Layer 3. Normalizes a tag row into a `TagRecord` (¶3.8.1). It takes a row that has already passed `tagPublic` or
// `tagListable` and reads only the fields of the TAG_CARD and TAG_LIST fragments, so `lastCommentedAt`, recent
// comments, contributors and `createdAt` are never carried (Q50.31, Q50.33). `postCount` is the forum's site counter
// (P10: rendered as `~N`). Names stay as the forum gives them; the renderer cuts them. Pure: it never throws and
// never logs.
import type { RawTagCard, RawTagList, RawTagRef, TagRecord } from "../types";
import { excerptOf } from "./posts";
import { maskTagRef, tagPublic } from "./visibility";

/** ¶3.8.1: what kind of page a tag row is; the first match wins (placeholder, then core, then wiki-only). */
export function pageType(t: RawTagRef): TagRecord["pageType"] {
  if (t.isPlaceholderPage) return "placeholder page";
  if (t.core) return "core tag";
  if (t.wikiOnly) return "wiki-only page";
  return "tag";
}

/**
 * ¶3.8.1, P12: the record of a tag. A parent that is not public is omitted. A catalogue row
 * (TAG_LIST) carries `coreTagId` and no description; a tag card (TAG_CARD) carries an excerpt of its description.
 */
export function toTagRecord(raw: RawTagCard | RawTagList): TagRecord {
  const record: TagRecord = {
    id: raw._id,
    slug: raw.slug,
    name: raw.name,
    pageType: pageType(raw),
    postCount: raw.postCount,
  };
  if (tagPublic(raw.parentTag)) {
    const parent = maskTagRef(raw.parentTag);
    if (!parent.hidden) record.parent = parent;
  }
  if ("coreTagId" in raw && raw.coreTagId != null) record.coreTagId = raw.coreTagId;
  if ("description" in raw) {
    const excerpt = excerptOf(raw.description?.plaintextDescription);
    if (excerpt !== undefined) record.excerpt = excerpt;
  }
  return record;
}
