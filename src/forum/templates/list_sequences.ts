// Layer 4. The sequences light set of `list_sequences` (¶4.10): every public sequence as `SEQ_LIGHT` rows, read through the
// `default` view (§11.1) in raw pages of 1,000 at offsets 0, 1,000 and 2,000. The view is a bounded selector (¶3.6),
// so every page asks for the total, which the tool reads internally and never shows (P10). The page shown is hydrated
// with `sequencesByIdsOp` of `shared.ts`. Pure: no services, caches or domain code.
import { CONFIG } from "../../config";
import { internalError } from "../../errors";
import type { GqlOp } from "../../types";
import { op } from "./op";

/** The raw offsets the set is read at: the multiples of the raw page size, one per page `lightScan` may read. */
const OFFSETS: readonly number[] = Array.from({ length: CONFIG.paging.sequenceSetPages }, (_, page) => page * CONFIG.paging.sequenceSetRows);

/**
 * One raw page of the whole set (template `list_sequences`, alias `l`): `SEQ_LIGHT` rows from `offset`, with `totalCount`.
 * Any offset but 0, 1,000 or 2,000 is a bug of the caller.
 */
export function sequenceSetOp(offset: number): GqlOp {
  if (!OFFSETS.includes(offset)) throw internalError("list_sequences", `offset must be ${OFFSETS.slice(0, -1).join(", ")} or ${OFFSETS.at(-1)}`);
  return op({
    template: "list_sequences", alias: "l", root: "sequences", view: "default", terms: {}, limit: CONFIG.paging.sequenceSetRows, offset,
    enableTotal: true, select: "{ results { ...SEQ_LIGHT } totalCount }",
  });
}
