// Layer 4. The op builder: every template renders its operation through `op()`, which writes the `<alias>: <root>(<args>)
// <selection>` text from already-rendered literals (forum/literal.ts) and refuses, through `assertAllowed`, anything
// forum/forbidden.ts does not allow. `documentFor` joins ops into the one query a request sends, with the fragments they
// spread. Pure; the guard is imported here and never the other way round.
import { internalError } from "../../errors";
import type { GqlOp, PublicKind } from "../../types";
import { assertAllowed } from "../forbidden";
import { int, obj } from "../literal";
import { fragmentClosure, fragmentDefinitions } from "./fragments";

export interface OpSpec {
  template: string;                                          // snake_case template name; operationName when first in a request
  alias: string;                                             // unique within one gql() call; a GraphQL name
  root: string;
  view?: string;                                             // selector view key of a list root
  terms?: Readonly<Record<string, string | undefined>>;     // rendered literals; without `view`, a single root's selector such as {_id}
  limit?: number;
  offset?: number;
  enableTotal?: true;
  allowNull?: true;
  args?: Readonly<Record<string, string | undefined>>;      // a custom root's arguments as rendered literals, in insertion order
  select: string;                                            // the selection, braces included, with fragment spreads
  isolate?: true;                                            // non-null root: its own operation of an array batch (R6)
  publicSubject?: PublicKind;                                // excluded path (P17)
  ttlMs?: number;                                            // raw-response cache TTL override (feeds)
}

const GRAPHQL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Renders `spec` as a `GqlOp`; arguments come in the order selector, limit, offset, enableTotal, allowNull, then `args`. */
export function op(spec: OpSpec): GqlOp {
  const { template, alias, root, view, terms } = spec;
  if (!GRAPHQL_NAME_RE.test(alias)) throw internalError(template, `alias ${alias} is not a GraphQL name`);
  const parts: string[] = [];
  if (view !== undefined) parts.push(`selector: {${view}: ${obj(terms ?? {})}}`);
  else if (terms !== undefined) parts.push(`selector: ${obj(terms)}`);
  if (spec.limit !== undefined) parts.push(`limit: ${int(spec.limit)}`);
  if (spec.offset !== undefined) parts.push(`offset: ${int(spec.offset)}`);
  if (spec.enableTotal) parts.push("enableTotal: true");
  if (spec.allowNull) parts.push("allowNull: true");
  for (const [name, value] of Object.entries(spec.args ?? {})) {
    if (value !== undefined) parts.push(`${name}: ${value}`);
  }
  const text = `${alias}: ${root}${parts.length ? `(${parts.join(", ")})` : ""} ${spec.select}`;
  const built: GqlOp = {
    template,
    alias,
    text,
    ...(spec.isolate && { isolate: spec.isolate }),
    ...(spec.publicSubject !== undefined && { publicSubject: spec.publicSubject }),
    ...(spec.ttlMs !== undefined && { ttlMs: spec.ttlMs }),
  };
  assertAllowed(built);
  return built;
}

/** One query named `operationName` over `ops`, followed by the definitions of every fragment they spread, one per line. */
export function documentFor(operationName: string, ops: readonly GqlOp[]): string {
  if (!GRAPHQL_NAME_RE.test(operationName)) throw internalError(operationName, "operation name is not a GraphQL name");
  const texts = ops.map((o) => o.text);
  const query = `query ${operationName} { ${texts.join(" ")} }`;
  const used = fragmentClosure(texts.join(" "));
  return used.length > 0 ? `${query}\n${fragmentDefinitions(used)}` : query;
}
