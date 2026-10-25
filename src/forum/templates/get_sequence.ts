// Layer 4. The requests of `get_sequence` (¶4.9), composed from the shared builders. A collection is one request, the collection
// with its books and their `SEQ_CARD` sequences. A sequence takes up to three. Request 1 reads the sequence, and with it the post
// given as `post` and that post's canonical sequence, through the aliases of the post's form (`p` for an id, `ps` for a slug, both
// for a bare 17-character string, `pl` for an LW1 id); it is also the visibility check (P17). Request 2, for the confirmed
// sequence only, reads its chapters in the view's order (never `Sequence.chapters`, whose order is arbitrary, §11.2) with
// `POST_CARD` posts (P14), the site's word count and reading time, and, when a post was given and the collections listing is
// not cached, that listing. Request 3 (the chapters of a neighbouring sequence) is built in the tool from `sequenceChaptersOp`.
// Pure: built from the shared builders.
import { internalError } from "../../errors";
import type { GqlOp, ParsedRef, PublicSequenceId } from "../../types";
import { idLit } from "../literal";
import { op } from "./op";
import {
  collectionByIdOp, collectionsListingOp, postByIdOp, postByLegacyIdOp, postsBySlugOp, sequenceByIdOp, sequenceChaptersOp,
} from "./shared";

const POST_FIELDS = "...POST_REF canonicalSequence { ...SEQ_REF }";

/** The collection with its books, each with its `sequenceIds` (to order the sequences, P14) and its `SEQ_CARD` sequences. */
export function collectionOp(id: string): GqlOp {
  const fields = "_id title slug contents { markdown } books { _id title number postedAt sequenceIds sequences { ...SEQ_CARD } }";
  return { ...collectionByIdOp("c", id, fields), template: "get_sequence_collection" };
}

/** Request 1: `s`, and for a post the aliases of its form: id → `p`, slug → `ps`, a bare 17-character string → both, LW1 id → `pl`. */
export function getSequenceRequest1Ops(sequenceId: string, post?: ParsedRef): GqlOp[] {
  const ops = [sequenceByIdOp("s", sequenceId, "...SEQ_CARD contents { markdown }")];
  if (post !== undefined) {
    switch (post.form) {
      case "id":
        ops.push(postByIdOp("p", post.value, POST_FIELDS));
        break;
      case "slug":
        ops.push(postsBySlugOp("ps", post.value, POST_FIELDS));
        break;
      case "idOrSlug":
        ops.push(postByIdOp("p", post.value, POST_FIELDS), postsBySlugOp("ps", post.value, POST_FIELDS));
        break;
      case "legacy":
        ops.push(postByLegacyIdOp("pl", post.value, POST_FIELDS));
        break;
      default:
        throw internalError("get_sequence_req1", `a post given as ${post.form}`);
    }
  }
  return ops.map((o) => ({ ...o, template: "get_sequence_req1" }));
}

/** Request 2 for the confirmed sequence: `ch`, `st`, and `col` only when `listing`. */
export function getSequenceRequest2Ops(p: { sequenceId: PublicSequenceId; listing: boolean }): GqlOp[] {
  const chapters = sequenceChaptersOp("ch", p.sequenceId, "_id title number posts { ...POST_CARD }");
  const stats = op({
    template: "get_sequence_req2", alias: "st", root: "getSequenceStats", args: { sequenceId: idLit(p.sequenceId) },
    select: "{ totalWordCount totalReadTime }",
  });
  const ops = [chapters, stats, ...(p.listing ? [collectionsListingOp("col")] : [])];
  return ops.map((o) => ({ ...o, template: "get_sequence_req2" }));
}
