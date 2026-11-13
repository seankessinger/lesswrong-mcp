// The import-graph rule of ¶2.1 and ¶9, as a pure function over { repo-relative path -> source text }.
// A larger layer number is a lower layer; an import may go to a larger number or stay in its own layer, never to a smaller one.
// Each source is parsed with the TypeScript compiler, so a comment inside an import's braces never hides it and a string that
// quotes an import is never taken for one.
import { posix } from "node:path";
import ts from "typescript";

type Layer = 1 | 2 | 3 | 4 | 4.5 | 5;

const LAYER_1 = new Set(["src/index.ts", "src/server.ts", "src/services.ts"]);
const LAYER_3_PREFIXES = ["src/domain/", "src/render/", "src/paging/"];
const LAYER_5_PREFIXES = ["src/text/", "src/params/", "src/call/"];
const LAYER_5_FILES = new Set(["src/ids/parse.ts", "src/errors.ts", "src/config.ts", "src/cache.ts", "src/log.ts", "src/types.ts"]);

function layerIfAny(path: string): Layer | undefined {
  if (LAYER_1.has(path)) return 1;
  if (path.startsWith("src/tools/")) return 2;
  if (LAYER_3_PREFIXES.some((p) => path.startsWith(p)) || path === "src/ids/resolve.ts") return 3;
  if (path === "src/forum/http.ts") return 4.5;
  if (path.startsWith("src/forum/")) return 4;
  if (LAYER_5_PREFIXES.some((p) => path.startsWith(p)) || LAYER_5_FILES.has(path)) return 5;
  return undefined;
}

export function layerOf(path: string): Layer {
  const layer = layerIfAny(path);
  if (layer === undefined) throw new Error(`${path} is not in any layer of ¶2.1`);
  return layer;
}

interface Import {
  spec: string;
  typeOnly: boolean;
  clause: string; // the names imported or re-exported, as the module names them (`*` for a star re-export); empty for `import "x"` and `import("x")`
}

/** The names an import or export clause takes from the module: `{ a as b }` is `a`, `* as ns` and `export *` are `*`, a default import is `default`. */
function namesOf(clause: ts.ImportClause | ts.NamedExportBindings | undefined): string[] {
  if (clause === undefined) return [];
  if (ts.isImportClause(clause)) {
    const names = clause.name === undefined ? [] : ["default"];
    const bindings = clause.namedBindings;
    if (bindings === undefined) return names;
    if (ts.isNamespaceImport(bindings)) return [...names, "*"];
    return [...names, ...bindings.elements.map((e) => (e.propertyName ?? e.name).text)];
  }
  if (ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements.map((e) => (e.propertyName ?? e.name).text);
}

/**
 * Every import of a source, in order: `import … from "x"`, `import type … from "x"`, `export … from "x"`, `import "x"` and
 * `import("x")` anywhere in the file. The source is parsed, so comments and strings never make or hide one.
 */
function importsOf(source: string): Import[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false);
  const found: Import[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      found.push({ spec: node.moduleSpecifier.text, typeOnly: clause?.isTypeOnly === true, clause: namesOf(clause).join(", ") });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, clause: namesOf(node.exportClause ?? undefined).join(", ") || "*" });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) found.push({ spec: arg.text, typeOnly: false, clause: "" });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** `lodash`, `zod/v4` -> `zod`; `@scope/pkg/sub` -> `@scope/pkg`. */
function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// ¶7, S1: only `src/forum/http.ts` reaches the network, through the injected `fetch`; no module in src/ opens a socket, a
// process or a thread by any other route. The other builtins (crypto, fs, path, url) stay allowed.
const DENIED_BUILTINS = new Set(["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:child_process", "node:worker_threads"]);

function packageViolation(file: string, spec: string, typeOnly: boolean): string | undefined {
  if (spec.startsWith("node:")) {
    return DENIED_BUILTINS.has(spec) ? `${file}: imports ${spec} (network, process and thread builtins are not allowed in src/)` : undefined;
  }
  const pkg = packageOf(spec);
  if (pkg.startsWith("@modelcontextprotocol/")) {
    return file === "src/server.ts" ? undefined : `${file}: imports ${pkg} outside src/server.ts`;
  }
  if (pkg === "zod") {
    if (file === "src/types.ts") return typeOnly ? undefined : `${file}: imports zod without import type`;
    const allowed = file.startsWith("src/params/") || file.startsWith("src/tools/") || file === "src/server.ts";
    return allowed ? undefined : `${file}: imports zod outside params/*, tools/*, src/server.ts`;
  }
  if (pkg === "turndown") {
    return file === "src/domain/markdown.ts" ? undefined : `${file}: imports turndown outside src/domain/markdown.ts`;
  }
  if (pkg === "diff") {
    return file === "src/domain/revisions.ts" ? undefined : `${file}: imports diff outside src/domain/revisions.ts`;
  }
  return `${file}: imports unknown package ${pkg}`;
}

// Templates export only pure op builders (Global Constraints, Layers): no cache, no Services, nothing above them, type imports included.
const TEMPLATE_FORBIDDEN_PREFIXES = ["src/tools/", "src/domain/", "src/render/", "src/paging/"];

function templateViolation(file: string, target: string, clause: string): string | undefined {
  if (!file.startsWith("src/forum/templates/")) return undefined;
  if (target === "src/types.ts") {
    return /\bServices\b/.test(clause) ? `${file}: forum/templates/* imports the Services type (src/types.ts)` : undefined;
  }
  const forbidden =
    target === "src/cache.ts" || target === "src/ids/resolve.ts" || TEMPLATE_FORBIDDEN_PREFIXES.some((p) => target.startsWith(p));
  return forbidden ? `${file}: forum/templates/* imports ${target}` : undefined;
}

function relativeViolation(file: string, target: string, clause: string): string | undefined {
  if (file.startsWith("src/render/") && target.startsWith("src/paging/")) {
    return `${file}: render/* imports paging/* (${target})`;
  }
  if (file === "src/forum/http.ts" && target.startsWith("src/forum/")) {
    return `${file}: forum/http.ts imports another forum module (${target})`;
  }
  const template = templateViolation(file, target, clause);
  if (template) return template;
  const from = layerIfAny(file);
  const to = layerIfAny(target);
  if (from !== undefined && to !== undefined && to < from) {
    return `${file}: upward import of ${target} (layer ${from} → ${to})`;
  }
  return undefined;
}

/** One cycle per back edge of a depth-first search (so every cyclic component is reported), each rotated to start and end at its smallest file. */
function cycleViolations(edges: ReadonlyMap<string, readonly string[]>): string[] {
  const onStack = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const found = new Set<string>();
  const visit = (file: string): void => {
    onStack.add(file);
    path.push(file);
    for (const next of edges.get(file) ?? []) {
      if (onStack.has(next)) {
        const loop = path.slice(path.indexOf(next));
        const start = loop.indexOf([...loop].sort()[0]);
        const rotated = [...loop.slice(start), ...loop.slice(0, start)];
        found.add(`${rotated[0]}: import cycle ${[...rotated, rotated[0]].join(" → ")}`);
      } else if (!done.has(next)) {
        visit(next);
      }
    }
    path.pop();
    onStack.delete(file);
    done.add(file);
  };
  for (const file of [...edges.keys()].sort()) if (!done.has(file)) visit(file);
  return [...found];
}

/** Every rule of ¶2.1 and ¶9 over `files` (repo-relative path -> source); one string per violation, [] when the graph is clean. */
export function checkImports(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  const edges = new Map<string, string[]>();
  for (const file of [...files.keys()].sort()) {
    const source = files.get(file)!;
    if (layerIfAny(file) === undefined) violations.push(`${file}: not in any layer of ¶2.1`);
    if (file !== "src/forum/http.ts" && source.includes("fetchImpl(")) {
      violations.push(`${file}: calls fetchImpl( outside src/forum/http.ts`);
    }
    if (file !== "src/index.ts" && source.includes("globalThis.fetch")) {
      violations.push(`${file}: uses globalThis.fetch outside src/index.ts`);
    }
    const targets = new Set<string>();
    for (const { spec, typeOnly, clause } of importsOf(source)) {
      if (!spec.startsWith(".")) {
        const bad = packageViolation(file, spec, typeOnly);
        if (bad) violations.push(bad);
        continue;
      }
      const target = `${posix.join(posix.dirname(file), spec)}.ts`;
      if (!files.has(target)) {
        violations.push(`${file}: unresolved import ${spec}`);
        continue;
      }
      targets.add(target);
      const bad = relativeViolation(file, target, clause);
      if (bad) violations.push(bad);
    }
    edges.set(file, [...targets].sort());
  }
  return [...violations, ...cycleViolations(edges)];
}
