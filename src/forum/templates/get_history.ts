// Layer 4. Request 1 of `get_history` (¶4.11 step 1): the document whose history is read, through the resolution aliases of
// ¶3.1.2 with exactly the fields the check and the header need; it is also the visibility check (P17), so the revision list
// (request 2) and the texts are built only from the ids it confirms (`revisionListOp`, `revisionTextOp`). The aliases are the
// bare ones `ids/resolve` reads. A post: `p` for an id, `s` for a slug, both for a bare 17-character string, `l` for an LW1 id,
// each with `postedAt`, `hideAuthor` and the current `contents` version. A tag: `t` (a page, its `description` version) and `m` (a
// lens or summary, its `contents` version, with the page joined) for an id, `b` (`TagPreview`: a lens slug's lens, else the page)
// for a slug, all three for a bare 17-character string. Every op is named `get_history_req1`. Pure: built from the shared builders.
import { internalError } from "../../errors";
import type { GqlOp, ParsedRef } from "../../types";
import {
  multiDocumentByIdOp, postByIdOp, postByLegacyIdOp, postsBySlugOp, tagByIdOp, tagPreviewOp,
} from "./shared";

const TEMPLATE = "get_history_req1";
/** #65: `collabEditorDialogue` says whether a version's text names its speakers, as get_post's does; `debate`, whether it is the body of an old-style debate. */
const POST_FIELDS = "...POST_REF postedAt hideAuthor collabEditorDialogue debate contents { version editedAt }";
const TAG_FIELDS = "...TAG_REF description { version editedAt }";
const MDOC_FIELDS = "...MDOC_REF contents { version editedAt }";
/** A page reached by slug carries its own current version as well (#257), as it does by id. */
const PREVIEW_INNER = `tag { ${TAG_FIELDS} } lens { ${MDOC_FIELDS} }`;

/** Request 1 for `ref`, read as a `kind` parameter: the aliases of its form, every op named `get_history_req1`. */
export function historyDocOps(ref: ParsedRef, kind: "post" | "tag"): GqlOp[] {
  const { form, value } = ref;
  const named = (ops: GqlOp[]): GqlOp[] => ops.map((o) => ({ ...o, template: TEMPLATE }));
  const post = (): GqlOp => postByIdOp("p", value, POST_FIELDS);
  const postSlug = (): GqlOp => postsBySlugOp("s", value, POST_FIELDS);
  const tag = (): GqlOp[] => [tagByIdOp("t", value, TAG_FIELDS), multiDocumentByIdOp("m", value, MDOC_FIELDS)];
  const preview = (): GqlOp => tagPreviewOp("b", value, PREVIEW_INNER);
  switch (kind) {
    case "post":
      if (form === "id") return named([post()]);
      if (form === "slug") return named([postSlug()]);
      if (form === "idOrSlug") return named([post(), postSlug()]);
      if (form === "legacy") return named([postByLegacyIdOp("l", value, POST_FIELDS)]);
      break;
    case "tag":
      if (form === "id") return named(tag());
      if (form === "slug") return named([preview()]);
      if (form === "idOrSlug") return named([...tag(), preview()]);
      break;
  }
  throw internalError(TEMPLATE, `a ${kind} given as ${form}`);
}
