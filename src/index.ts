// Layer 1. The process entry (¶2.1 layer 1, ¶10 runtime): logs `process.version` to stderr once (stdout carries MCP),
// injects the real I/O into the services (the global fetch, the wall clock, an abortable sleep, Math.random and the stderr
// log; no override of `CONFIG.http`, so production runs with its spacing and caps), builds the server with every tool and
// serves it over stdio. `LESSWRONG_MCP_DEBUG=1` writes the debug log lines; `LESSWRONG_MCP_FETCH_TRIPWIRE=1` refuses every forum request
// (the offline smoke test of the bundle sets it). This is the one module of src/ that names the global fetch.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ENV_VARS } from "./config";
import { createLog } from "./log";
import { connectStdio, createServer } from "./server";
import { createServices } from "./services";
import { cutMessage } from "./text/sanitize";
import { TOOLS } from "./tools/registry";
import type { HttpDeps, Log } from "./types";

/**
 * The network implementation for `env`: one that refuses every request when `LESSWRONG_MCP_FETCH_TRIPWIRE` is "1"; else the
 * global fetch.
 */
export function fetchFor(env: Readonly<Record<string, string | undefined>>): HttpDeps["fetchImpl"] {
  if (env[ENV_VARS.fetchTripwire] === "1") {
    return () => Promise.reject(new Error(`network access is disabled (${ENV_VARS.fetchTripwire}=1)`));
  }
  return globalThis.fetch;
}

/**
 * The real `HttpDeps.sleep`: resolves after `ms`; rejects with `signal.reason` at once when the signal is already aborted,
 * and on a later abort clears its timer and rejects with the reason; the timer firing removes the abort listener.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stderrLog(debug: boolean): Log {
  return createLog({ write: (line) => process.stderr.write(line + "\n"), debug });
}

async function main(): Promise<void> {
  const log = stderrLog(process.env[ENV_VARS.debug] === "1");
  log.info(`node ${process.version}`);
  const services = createServices({ fetchImpl: fetchFor(process.env), now: Date.now, sleep: abortableSleep, random: Math.random, log });
  await connectStdio(createServer({ tools: TOOLS, services, now: Date.now }));
}

/**
 * True when node was started with this module as its script. Both sides are compared as real paths: node runs a script
 * reached through a symbolic link from its real path, while `process.argv[1]` keeps the path as given.
 */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  if (import.meta.url === pathToFileURL(script).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e: unknown) => {
    stderrLog(false).error(`fatal: ${cutMessage(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });
}
