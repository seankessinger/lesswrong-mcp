// The forum's schema (¶9.1, C2), loaded once. `assumeValid` is required: the schema's
// EmptyViewInput has no fields, which graphql-js schema validation (run by validate()
// unless assumeValid is set) rejects.
import { readFileSync } from "node:fs";
import { buildSchema, type GraphQLSchema } from "graphql";

const SCHEMA_PATH = "docs/reference/forum-schema-2026-10-21.graphql";

export const forumSchema: GraphQLSchema = buildSchema(
  readFileSync(new URL("../" + SCHEMA_PATH, import.meta.url), "utf8"),
  { assumeValid: true },
);
