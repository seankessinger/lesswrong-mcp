// Layer 2. The tool registry: `TOOLS`, the tool definitions in the ¶4 catalog order, and `TOOL_ORDER`, their names.
import type { ToolDef, ToolName } from "../types";
import { tool as find } from "./find";
import { tool as firstUse } from "./first_use";
import { tool as getComments } from "./get_comments";
import { tool as getFeed } from "./get_feed";
import { tool as getHistory } from "./get_history";
import { tool as getLinks } from "./get_links";
import { tool as getPost } from "./get_post";
import { tool as getReactions } from "./get_reactions";
import { tool as getSequence } from "./get_sequence";
import { tool as getTag } from "./get_tag";
import { tool as getUser } from "./get_user";
import { tool as listComments } from "./list_comments";
import { tool as listPosts } from "./list_posts";
import { tool as listSequences } from "./list_sequences";
import { tool as listTags } from "./list_tags";
import { tool as search } from "./search";

/** Every tool this server publishes, in the ¶4 catalog order. */
export const TOOLS: readonly ToolDef[] = [
  find, search, getPost, getComments, listPosts, listComments, getUser, getTag, getSequence, listSequences, getHistory, firstUse, getLinks, getReactions, getFeed, listTags,
];

/** ¶4 catalog order. */
export const TOOL_ORDER: readonly ToolName[] = TOOLS.map((t) => t.name);
