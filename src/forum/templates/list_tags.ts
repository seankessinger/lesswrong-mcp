// Layer 4. The tag catalogue of `list_tags` (¶4.16): every tag that can be applied to posts, in one request. The default tag view
// filters wiki-only, deleted and admin-only pages in SQL (§10.2) and all of them (about 1,010) come back in one call; the
// selector is site-wide, so no `enableTotal` (¶3.6, P10). The core-tag groupings `list_tags` also reads are `coreGroupingOp` of
// `shared.ts`, which `get_tag`'s preview shares. Pure: no services, caches or domain code.
import type { GqlOp } from "../../types";
import { op } from "./op";

/** The most rows the catalogue asks for; a catalogue that comes back this long may be longer still (Q130, Q68). */
export const ALL_TAGS_LIMIT = 2000;

/** The whole catalogue, alphabetically, as `TAG_LIST` rows under alias `t` (template `list_tags_all`). */
export function allTagsOp(): GqlOp {
  return op({
    template: "list_tags_all", alias: "t", root: "tags", view: "allTagsAlphabetical", terms: {}, limit: ALL_TAGS_LIMIT,
    select: "{ results { ...TAG_LIST } }",
  });
}
