// Schema-aware checks over template ops (¶9.1, ¶9.2, C2). `checkOps` validates the document a request would send against the forum's
// schema and, when it is valid, runs the type-aware rules the text-only guard (src/forum/forbidden.ts) cannot: R12 (a joined document
// spreads its reference fragment), R8 (denied `Type.field` pairs) and Q99 (`changeMetrics` only on revision rows). The request lint
// (test/support/lint.ts) reuses `typeViolations`. Every message is a string; an empty array means the ops are clean.
import {
  getNamedType,
  Kind,
  KnownFragmentNamesRule,
  NoFragmentCyclesRule,
  parse,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { documentFor } from "../../src/forum/templates/op";
import type { GqlOp } from "../../src/types";
import { forumSchema } from "../schema";
import { DENIED_FIELDS } from "./deniedFields";

/** The reference fragment each joined type must spread (R12). */
const REFERENCE_FRAGMENT: Readonly<Record<string, string>> = {
  Post: "POST_REF",
  Comment: "COMMENT_REF",
  Tag: "TAG_REF",
  Sequence: "SEQ_REF",
  MultiDocument: "MDOC_REF",
};

/** Joins that need no reference fragment: the lenses and summaries a tag page lists, which the templates select field by field. */
const UNREFERENCED_JOINS: readonly string[] = [
  "Tag.lenses", "Tag.summaries", "TagPreviewWithSummaries.summaries", "MultiDocument.summaries", "MultiDocument.parentLens",
];

/** The fields a `Revision.changeMetrics` may sit directly under: a list or single answer of revisions, never a document's `contents`. */
const CHANGE_METRICS_PARENTS: readonly string[] = ["results", "result", "tagRevised", "tagRevision"];

/** The document `ops` make, validated against the schema (`C2 <template>: <message>`, returned alone), else its type violations. */
export function checkOps(ops: readonly GqlOp[]): string[] {
  const first = ops[0];
  if (first === undefined) throw new Error("checkOps needs at least one op");
  const doc = parse(documentFor(first.template, ops));
  const errors = validate(forumSchema, doc);
  if (errors.length > 0) return errors.map((e) => `C2 ${first.template}: ${e.message}`);
  return typeViolations(doc);
}

/** Only the fragment rules the inlined walk depends on: every spread names a defined fragment, and no fragment reaches itself. */
const INLINING_RULES = [KnownFragmentNamesRule, NoFragmentCyclesRule];

/**
 * The type-aware violations of a parsed document, de-duplicated: all R12 first, then R8 and Q99 in document order.
 * It works on any parsed document, valid or not. R8 and Q99 need every spread replaced by its fragment, which only terminates
 * when each spread names a defined fragment and no fragment spreads itself, directly or through others. A document that breaks
 * either rule is a C2 error (`checkOps` and the request lint report it as one, and the forum would reject it), so for it this
 * returns the R12 results alone and skips the R8 and Q99 walk. R12 is safe on such a document: it reads the spreads as written,
 * skips a spread with no definition, and follows each fragment at most once.
 */
export function typeViolations(doc: DocumentNode): string[] {
  const reference = referenceViolations(doc);
  if (validate(forumSchema, doc, INLINING_RULES).length > 0) return [...new Set(reference)];
  return [...new Set([...reference, ...deniedViolations(doc)])];
}

function fragmentDefinitions(doc: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  return fragments;
}

/** Whether `selectionSet` spreads `name`, directly, in an inline fragment or through the fragments it spreads; nested fields do not count. */
function spreads(selectionSet: SelectionSetNode, name: string, fragments: ReadonlyMap<string, FragmentDefinitionNode>, seen = new Set<string>()): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const spread = selection.name.value;
      if (spread === name) return true;
      const definition = fragments.get(spread);
      if (definition && !seen.has(spread)) {
        seen.add(spread);
        if (spreads(definition.selectionSet, name, fragments, seen)) return true;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT && spreads(selection.selectionSet, name, fragments, seen)) {
      return true;
    }
  }
  return false;
}

/** R12 on the document as written, fragment spreads intact: every operation and every fragment definition. */
function referenceViolations(doc: DocumentNode): string[] {
  const fragments = fragmentDefinitions(doc);
  const queryType = forumSchema.getQueryType();
  const typeInfo = new TypeInfo(forumSchema);
  const found: string[] = [];
  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parent = typeInfo.getParentType();
        const definition = typeInfo.getFieldDef();
        if (!parent || !definition || !node.selectionSet) return;
        const joined = getNamedType(definition.type).name;
        const required = REFERENCE_FRAGMENT[joined];
        if (required === undefined) return;
        const field = `${parent.name}.${definition.name}`;
        if (parent === queryType || /(Output|Result|Results)$/.test(parent.name) || UNREFERENCED_JOINS.includes(field)) return;
        if (!spreads(node.selectionSet, required, fragments)) found.push(`R12 ${field} (${joined}) lacks ${required}`);
      },
    }),
  );
  return found;
}

/** The operations of `doc` with every fragment spread replaced by an inline fragment of the same type condition and selections. */
function inlined(doc: DocumentNode): DocumentNode {
  const fragments = fragmentDefinitions(doc);
  return visit(doc, {
    FragmentDefinition: () => null,
    FragmentSpread(node) {
      const definition = fragments.get(node.name.value)!;
      return { kind: Kind.INLINE_FRAGMENT, typeCondition: definition.typeCondition, selectionSet: definition.selectionSet };
    },
  });
}

/** R8 (`DENIED_FIELDS`) and Q99 on the inlined operations, with the stack of enclosing field names. */
function deniedViolations(doc: DocumentNode): string[] {
  const typeInfo = new TypeInfo(forumSchema);
  const enclosing: string[] = [];
  const found: string[] = [];
  visit(
    inlined(doc),
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          const parent = typeInfo.getParentType();
          const field = `${parent?.name}.${node.name.value}`;
          if (DENIED_FIELDS.includes(field)) found.push(`R8 ${field} is denied`);
          const under = enclosing.at(-1);
          if (field === "Revision.changeMetrics" && (under === undefined || !CHANGE_METRICS_PARENTS.includes(under))) {
            found.push(`Q99 Revision.changeMetrics under ${under}`);
          }
          enclosing.push(node.name.value);
        },
        leave() {
          enclosing.pop();
        },
      },
    }),
  );
  return found;
}
