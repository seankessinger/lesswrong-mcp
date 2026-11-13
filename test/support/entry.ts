// The entry-module check of scripts/smoke.ts: it runs its session only when node (or tsx) was started with it as the script, so
// that the tests can import its functions. The same rule as src/index.ts's own check, which src/ cannot import from here.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the process was started with the module at `moduleUrl` (its `import.meta.url`) as its script. Both sides are compared
 * as real paths: node runs a script reached through a symbolic link from its real path, while `process.argv[1]` keeps the path as given.
 */
export function isEntryModule(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  if (moduleUrl === pathToFileURL(script).href) return true;
  try {
    return moduleUrl === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}
