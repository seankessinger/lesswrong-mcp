// Packing (¶10): stages manifest.json, icon.png, README.md and LICENSE next to the bundle built by scripts/build.mjs, validates the
// manifest, packs build/bundle into build/<name>-<version>.mcpb and reads the result back to confirm that it is
// unsigned. The bundle is never passed to the signing command of mcpb: Claude Desktop shows the extension as unsigned, and the
// README says so. Run from the repository root.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";

const STAGED_FILES = ["manifest.json", "icon.png", "README.md", "LICENSE"];

/** What `mcpb info` prints for a bundle that carries no signature. */
const UNSIGNED_RE = /not signed|unsigned/i;

/** The three mcpb invocations, as argument lists: validate the staged manifest, pack the staging folder, describe the result. */
function packCommands(name, version) {
  const bundle = `build/${name}-${version}.mcpb`;
  return [
    ["validate", "build/bundle/manifest.json"],
    ["pack", "build/bundle", bundle],
    ["info", bundle],
  ];
}

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

if (!existsSync("build/bundle/server/index.mjs")) fail("build/bundle/server/index.mjs is missing; run npm run build first");
const { name, version } = JSON.parse(readFileSync("manifest.json", "utf8"));
for (const file of STAGED_FILES) copyFileSync(file, `build/bundle/${file}`);
for (const args of packCommands(name, version)) {
  let output;
  try {
    output = execFileSync("node_modules/.bin/mcpb", args, { encoding: "utf8" });
  } catch (e) {
    process.stdout.write(e.stdout ?? "");
    fail(`mcpb ${args[0]} failed: ${e.message}`);
  }
  process.stdout.write(output);
  if (args[0] === "info" && !UNSIGNED_RE.test(output)) fail("mcpb info does not say that the bundle is unsigned");
}
