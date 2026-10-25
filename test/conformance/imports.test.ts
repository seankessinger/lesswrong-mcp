import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkImports, layerOf } from "../support/importGraph";

function srcFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of readdirSync("src", { recursive: true }) as string[]) {
    if (rel.endsWith(".ts")) files.set(`src/${rel.split("\\").join("/")}`, readFileSync(`src/${rel}`, "utf8"));
  }
  return files;
}

describe("¶2.1 import graph", () => {
  it("assigns every module its layer", () => {
    expect(layerOf("src/index.ts")).toBe(1);
    expect(layerOf("src/server.ts")).toBe(1);
    expect(layerOf("src/services.ts")).toBe(1);
    expect(layerOf("src/tools/get_post.ts")).toBe(2);
    expect(layerOf("src/domain/visibility.ts")).toBe(3);
    expect(layerOf("src/render/budget.ts")).toBe(3);
    expect(layerOf("src/paging/pager.ts")).toBe(3);
    expect(layerOf("src/ids/resolve.ts")).toBe(3);
    expect(layerOf("src/forum/gql.ts")).toBe(4);
    expect(layerOf("src/forum/templates/shared.ts")).toBe(4);
    expect(layerOf("src/forum/http.ts")).toBe(4.5);
    for (const p of ["src/text/dates.ts", "src/ids/parse.ts", "src/params/vocabulary.ts", "src/call/context.ts", "src/errors.ts", "src/config.ts", "src/cache.ts", "src/log.ts", "src/types.ts"]) {
      expect(layerOf(p)).toBe(5);
    }
    expect(() => layerOf("src/misc/odd.ts")).toThrow("src/misc/odd.ts");
  });

  it("reports every kind of violation, one string per bad import", () => {
    const files = new Map<string, string>([
      ["src/text/dates.ts", 'import { postPublic } from "../domain/visibility";\n'],
      ["src/domain/visibility.ts", 'import { CONFIG } from "../config";\n'],
      ["src/config.ts", ""],
      ["src/render/layout.ts", 'import type { CursorStore } from "../types";\nimport { issue } from "../paging/cursor";\n'],
      ["src/paging/cursor.ts", 'import { randomBytes } from "node:crypto";\n'],
      ["src/types.ts", 'import type { ZodObject } from "zod";\n'],
      ["src/forum/http.ts", 'import { str } from "./literal";\nexport const f = (d: any) => d.fetchImpl("u", {});\n'],
      ["src/forum/literal.ts", ""],
      ["src/forum/gql.ts", 'import { createHttp } from "./http";\nconst x = deps.fetchImpl("u");\n'],
      ["src/domain/a.ts", 'import { b } from "./b";\n'],
      ["src/domain/b.ts", 'import { a } from "./a";\n'],
      ["src/tools/find.ts", 'import { Server } from "@modelcontextprotocol/server";\nimport { z } from "zod";\n'],
      ["src/domain/posts.ts", 'import { z } from "zod";\nimport TurndownService from "turndown";\n'],
      ["src/text/x.ts", 'import { diffWords } from "diff";\nimport _ from "lodash";\nexport {\n  y,\n} from "../ids/resolve";\n'],
      ["src/ids/resolve.ts", ""],
      ["src/services.ts", "const f = globalThis.fetch;\n"],
      ["src/index.ts", 'import { main } from "./server";\nconst f = globalThis.fetch;\n'],
      ["src/server.ts", 'import { Server } from "@modelcontextprotocol/server";\nimport { z } from "zod";\nimport { nope } from "./nope";\n'],
      ["src/misc/odd.ts", ""],
    ]);
    expect(checkImports(files).sort()).toEqual(
      [
        "src/text/dates.ts: upward import of src/domain/visibility.ts (layer 5 → 3)",
        "src/render/layout.ts: render/* imports paging/* (src/paging/cursor.ts)",
        "src/forum/http.ts: forum/http.ts imports another forum module (src/forum/literal.ts)",
        "src/forum/gql.ts: calls fetchImpl( outside src/forum/http.ts",
        "src/domain/a.ts: import cycle src/domain/a.ts → src/domain/b.ts → src/domain/a.ts",
        "src/tools/find.ts: imports @modelcontextprotocol/server outside src/server.ts",
        "src/domain/posts.ts: imports zod outside params/*, tools/*, src/server.ts",
        "src/domain/posts.ts: imports turndown outside src/domain/markdown.ts",
        "src/text/x.ts: imports diff outside src/domain/revisions.ts",
        "src/text/x.ts: imports unknown package lodash",
        "src/text/x.ts: upward import of src/ids/resolve.ts (layer 5 → 3)",
        "src/services.ts: uses globalThis.fetch outside src/index.ts",
        "src/misc/odd.ts: not in any layer of ¶2.1",
        "src/server.ts: unresolved import ./nope",
      ].sort(),
    );
  });

  it("allows zod in src/types.ts only as import type", () => {
    expect(checkImports(new Map([["src/types.ts", 'import { z } from "zod";\n']]))).toEqual([
      "src/types.ts: imports zod without import type",
    ]);
  });

  it("reads side-effect imports, dynamic imports, star re-exports and type re-exports too", () => {
    const files = new Map<string, string>([
      ["src/text/a.ts", 'import "lodash";\nconst d = await import("diff");\nexport * from "../ids/resolve";\nexport type { V } from "../domain/visibility";\n'],
      ["src/ids/resolve.ts", ""],
      ["src/domain/visibility.ts", ""],
    ]);
    expect(checkImports(files).sort()).toEqual([
      "src/text/a.ts: imports diff outside src/domain/revisions.ts",
      "src/text/a.ts: imports unknown package lodash",
      "src/text/a.ts: upward import of src/domain/visibility.ts (layer 5 → 3)",
      "src/text/a.ts: upward import of src/ids/resolve.ts (layer 5 → 3)",
    ]);
  });

  it("¶7 S1 denies the network, process and thread builtins in every src/ file; the other node: builtins stay allowed", () => {
    const files = new Map<string, string>([
      ["src/forum/http.ts", 'import { request } from "node:https";\nimport { createHash } from "node:crypto";\n'],
      ["src/tools/find.ts", 'import { execFile } from "node:child_process";\nimport { Worker } from "node:worker_threads";\n'],
      [
        "src/index.ts",
        [
          'import { createServer } from "node:http";',
          'import { connect } from "node:net";',
          'import { connect as tls } from "node:tls";',
          'import { createSocket } from "node:dgram";',
          'import { connect as h2 } from "node:http2";',
          'import { readFileSync } from "node:fs";',
          'import { join } from "node:path";',
        ].join("\n") + "\n",
      ],
    ]);
    const denied = (file: string, spec: string) => `${file}: imports ${spec} (network, process and thread builtins are not allowed in src/)`;
    expect(checkImports(files).sort()).toEqual(
      [
        denied("src/forum/http.ts", "node:https"),
        denied("src/tools/find.ts", "node:child_process"),
        denied("src/tools/find.ts", "node:worker_threads"),
        denied("src/index.ts", "node:http"),
        denied("src/index.ts", "node:net"),
        denied("src/index.ts", "node:tls"),
        denied("src/index.ts", "node:dgram"),
        denied("src/index.ts", "node:http2"),
      ].sort(),
    );
  });

  it("reads an import whose braces hold a comment with a quote or a semicolon, and never takes a string for an import (parsed, not pattern-matched)", () => {
    const files = new Map<string, string>([
      [
        "src/text/a.ts",
        [
          "import {",
          "  postPublic, // the post's own rule; P2",
          '  tagPublic, /* "pages"; and lenses */',
          '} from "../domain/visibility";',
          'const sample = \'import { issue } from "../paging/cursor";\';',
          "const text = `export * from \"../ids/resolve\"`;",
          "export const s = sample + text;",
        ].join("\n") + "\n",
      ],
      ["src/domain/visibility.ts", ""],
    ]);
    expect(checkImports(files)).toEqual(["src/text/a.ts: upward import of src/domain/visibility.ts (layer 5 → 3)"]);
  });

  it("keeps forum/templates/* pure op builders: no cache, Services, tools, domain, render, paging or ids/resolve, type imports included", () => {
    const files = new Map<string, string>([
      [
        "src/forum/templates/find.ts",
        [
          'import type { GqlOp } from "../../types";',
          'import { str } from "../literal";',
          'import { op } from "./op";',
          'import { ToolError } from "../../errors";',
          'import { parseRef } from "../../ids/parse";',
          'import type { GqlOp as G, Services } from "../../types";',
          'import { Lru } from "../../cache";',
          'import { postPublic } from "../../domain/visibility";',
          'import type { Budget } from "../../render/budget";',
          'import { issueCursor } from "../../paging/cursor";',
          'import { resolve } from "../../ids/resolve";',
          'import { tool } from "../../tools/find";',
        ].join("\n") + "\n",
      ],
      ["src/types.ts", ""],
      ["src/forum/literal.ts", ""],
      ["src/forum/templates/op.ts", ""],
      ["src/errors.ts", ""],
      ["src/ids/parse.ts", ""],
      ["src/cache.ts", ""],
      ["src/domain/visibility.ts", ""],
      ["src/render/budget.ts", ""],
      ["src/paging/cursor.ts", ""],
      ["src/ids/resolve.ts", ""],
      ["src/tools/find.ts", ""],
    ]);
    expect(checkImports(files).sort()).toEqual(
      [
        "src/forum/templates/find.ts: forum/templates/* imports the Services type (src/types.ts)",
        "src/forum/templates/find.ts: forum/templates/* imports src/cache.ts",
        "src/forum/templates/find.ts: forum/templates/* imports src/domain/visibility.ts",
        "src/forum/templates/find.ts: forum/templates/* imports src/render/budget.ts",
        "src/forum/templates/find.ts: forum/templates/* imports src/paging/cursor.ts",
        "src/forum/templates/find.ts: forum/templates/* imports src/ids/resolve.ts",
        "src/forum/templates/find.ts: forum/templates/* imports src/tools/find.ts",
      ].sort(),
    );
  });

  it("holds for every file in src/", () => {
    expect(checkImports(srcFiles())).toEqual([]);
  });
});
