// Bundle build (¶10): esbuild turns src/index.ts and every runtime dependency into the one ESM file the extension runs,
// build/bundle/server/index.mjs. It is not minified, so stack traces in stderr stay readable, and the banner gives bundled
// CommonJS code a `require` for Node built-ins. One file means no node_modules in the bundle. Run from the repository root.
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const BUILD_OPTIONS = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false,
  outfile: "build/bundle/server/index.mjs",
  banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
};

// Start from an empty staging folder, so that the bundle packed next holds nothing an earlier build or pack left there.
rmSync("build/bundle", { recursive: true, force: true });
await esbuild.build(BUILD_OPTIONS);
console.log(`build: ${BUILD_OPTIONS.outfile}`);
