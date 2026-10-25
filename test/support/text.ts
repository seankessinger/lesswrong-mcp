// Text builders and matchers shared by the tests (one copy, never copied into a test file).
import { FLAG } from "../../src/render/messages";

/** k words `ab`: 3k − 1 ASCII characters with no dense run, so (3k − 1) × 20 units, about (3k − 1) / 3.3 tokens. */
export const para = (k: number): string => "ab ".repeat(k).trim();

/** Any forum-count header, whatever its number. It is built from `FLAG.forumCount`, so rewording the flag can't leave a check of its absence passing vacuously. */
export const ANY_FORUM_COUNT = new RegExp(FLAG.forumCount(7).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("7", "[\\d,]+"));
