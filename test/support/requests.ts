// What a fake-forum run sent and what a reply printed: the GraphQL query texts, the parsed search bodies, and the cursors a
// page printed or a hand-off call carries. Read-only helpers over `FakeForum.requests`; they never touch the network.
import type { EsQuery, ToolName } from "../../src/types";
import type { FakeForum } from "../fakeForum";

/** One GraphQL request body: a single operation, or the operations of an array batch. */
type GraphqlBody = { query: string } | { query: string }[];

/** One string per GraphQL request, in order: the `query` of each operation of its body, joined with a line break. */
export function gqlTexts(forum: FakeForum): string[] {
  return forum.requests
    .filter((r) => r.endpoint === "graphql")
    .map((r) => {
      const body = JSON.parse(r.body) as GraphqlBody;
      return (Array.isArray(body) ? body : [body]).map((operation) => operation.query).join("\n");
    });
}

/** The parsed body of every search request, in order. */
export function searchBodies(forum: FakeForum): { options: { emptyStringSearchResults: string }; queries: EsQuery[] }[] {
  return forum.requests
    .filter((r) => r.endpoint === "search")
    .map((r) => JSON.parse(r.body) as { options: { emptyStringSearchResults: string }; queries: EsQuery[] });
}

/** The first cursor a reply prints in the footer form `cursor "c_…"`. */
export function printedCursor(text: string): string | undefined {
  return /cursor "(c_[A-Za-z0-9_-]{22})"/.exec(text)?.[1];
}

/** The cursor inside the first hand-off call a reply prints, `<tool> {… cursor: "c_…"}`. */
export function handOffCursor(text: string, tool: ToolName): string | undefined {
  return new RegExp(tool + " \\{[^}]*cursor: \"(c_[A-Za-z0-9_-]{22})\"").exec(text)?.[1];
}
