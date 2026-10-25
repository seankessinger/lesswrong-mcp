import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tripwireFetch } from "./support/tripwire";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string; version: string; private: boolean; type: string; license: string; engines: Record<string, string>;
  scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>;
};

describe("¶9 offline harness", () => {
  it("the global fetch is the tripwire: any network attempt fails the test", () => {
    expect(globalThis.fetch).toBe(tripwireFetch);
    expect(() => fetch("https://www.lesswrong.com/graphql")).toThrow(
      "network access attempted in tests: https://www.lesswrong.com/graphql",
    );
  });
});

describe("¶10 repository", () => {
  it("package.json: name, version, module type, licence, Node floor and scripts", () => {
    expect(pkg).toMatchObject({ name: "lesswrong-mcp", version: "1.0.0", private: true, type: "module", license: "MIT", engines: { node: ">=20" } });
    expect(pkg.scripts).toEqual({
      typecheck: "tsc --noEmit",
      test: "vitest run",
      build: "node scripts/build.mjs",
      pack: "npm run build && node scripts/pack.mjs",
      smoke: "tsx scripts/smoke.ts",
    });
  });

  it(".gitignore keeps installed packages and builds out of git", () => {
    const lines = readFileSync(".gitignore", "utf8").split("\n");
    expect(lines).toEqual(expect.arrayContaining(["node_modules/", "build/"]));
  });

  it("D16 LICENSE is MIT, Sean Kessinger, 2026", () => {
    const text = readFileSync("LICENSE", "utf8");
    expect(text.startsWith("MIT License\n")).toBe(true);
    expect(text).toContain("Copyright (c) 2026 Sean Kessinger");
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});

describe("Global Constraints: pinned dependencies", () => {
  it("C5 exactly the allowed packages, each pinned to an exact version", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["zod", "turndown", "diff", "@modelcontextprotocol/server"].sort());
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(
      ["typescript", "@types/node", "@types/turndown", "esbuild", "vitest", "fast-check", "tsx", "graphql", "@anthropic-ai/mcpb", "@modelcontextprotocol/client"].sort(),
    );
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
