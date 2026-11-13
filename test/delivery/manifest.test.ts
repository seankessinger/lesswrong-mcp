import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS, TOOL_ORDER } from "../../src/tools/registry";
import { createServer, listTools } from "../../src/server";
import { CONFIG } from "../../src/config";
import { connectInMemory } from "../support/mcpClient";
import type { Services } from "../../src/types";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const readme = readFileSync("README.md", "utf8");

describe("manifest (¶10, D5, D16)", () => {
  it("its tools are the registry's, in order; display_name has no '/'; D16 author and licence", () => {
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual([...TOOL_ORDER]);
    expect(manifest.display_name).not.toContain("/");
    expect(manifest.author).toEqual({ name: "Sean Kessinger" });
    expect(manifest.license).toBe("MIT");
    expect(manifest).not.toHaveProperty("user_config");
  });
  it("D12 the manifest version is CONFIG.version and the one in the User-Agent", () => {
    expect(manifest.version).toBe(CONFIG.version);
    expect(CONFIG.http.userAgent).toBe(`lesswrong-mcp/${manifest.version} (read-only research extension for Claude Desktop; single user; one request at a time)`);
  });
  it("one machine name: package.json, package-lock.json, manifest.json, CONFIG.name and the serverInfo of the initialize result", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    expect(manifest.name).toBe("lesswrong-mcp");
    expect([pkg.name, lock.name, lock.packages[""].name, CONFIG.name]).toEqual(Array(4).fill(manifest.name));
    expect([pkg.version, lock.version, lock.packages[""].version]).toEqual(Array(3).fill(manifest.version));
    const conn = await connectInMemory(createServer({ tools: [], services: {} as Services, now: Date.now }));
    expect(conn.client.getServerVersion()).toEqual({ name: manifest.name, version: manifest.version });
    await conn.close();
  });
});

describe("pack and icon (¶10)", () => {
  it("pack stages the bundle files", () => {
    const pack = readFileSync("scripts/pack.mjs", "utf8");
    for (const file of ['"manifest.json"', '"icon.png"', '"README.md"', '"LICENSE"']) expect(pack, file).toContain(file);
  });
  it("pack never signs the bundle", () => {
    expect(readFileSync("scripts/pack.mjs", "utf8")).not.toMatch(/["']sign["']/);
  });
  it("icon.png is the generic 512×512 PNG", () => {
    const png = readFileSync("icon.png");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });
});

describe("README (¶10)", () => {
  it("its title is the manifest display_name", () => {
    expect(readme.split("\n")[0]).toBe(`# ${manifest.display_name}`);
  });
  it("names only the bundle file of this name and version", () => {
    const named = [...new Set(readme.match(/[a-z0-9-]+-\d+\.\d+\.\d+\.mcpb/g) ?? [])];
    expect(named).toEqual([`${CONFIG.name}-${CONFIG.version}.mcpb`]);
  });
  it("describes every tool with every parameter", () => {
    for (const l of listTools(TOOLS)) {
      const part = readme.split(`### ${l.name}\n`)[1]?.split("\n### ")[0] ?? "";
      expect(part, l.name).not.toBe("");
      const props = Object.keys((l.inputSchema as { properties: object }).properties);
      for (const p of [...props, ...(l.name === "find" ? ["kind", "query", "commented_on"] : [])]) expect(part, `${l.name}: ${p}`).toContain(p);
    }
  });
  it("lists find's abbreviation table", () => {
    for (const { abbr, long } of CONFIG.abbreviations) expect(readme).toContain(`| ${abbr} | ${long} |`);
  });
  it("states the facts the owner asked for", () => {
    for (const s of [
      "It has no affiliation with the operators of LessWrong or the Alignment Forum.",
      "Claude Desktop shows this extension as unsigned; that is expected.",
      "Node.js 20 or later",
      CONFIG.http.userAgent,
      "No cookies are sent and nothing logs in.",
      "Claude Desktop keeps the server's one-line request logs",
      "Cursors expire after an hour and when the server restarts.",
      "Forum text can try to make Claude send your conversation data to the forum as a search query.",
      "It shows only what a logged-out visitor sees on the site.",
      "Event and meetup posts are left out of lists but can appear in search.",
      "MIT", "Sean Kessinger", "Forum content belongs to its authors.",
    ]) expect(readme, s).toContain(s);
  });
  it("the politeness figures of the README are CONFIG's: every tool's request cap, the spacing, the session windows, the deadline, the byte cap and the depth guard", () => {
    const mb = (bytes: number) => `${bytes / 1_048_576} MB`;
    for (const [t, n] of Object.entries(CONFIG.call.maxRequests)) expect(readme, t).toContain(`${t} ${n}`);
    expect(readme).toContain(`a cap on forum requests (${Object.entries(CONFIG.call.maxRequests).map(([t, n]) => `${t} ${n}`).join(", ")})`);
    expect(readme).toContain(`at least ${CONFIG.http.spacingMs / 1000} s between the starts of two requests`);
    for (const w of CONFIG.http.sessionWindows) expect(readme, w.label).toContain(`${w.requests.toLocaleString("en-US")} requests and ${mb(w.bytes)} per ${w.label}`);
    expect(readme).toContain(`a deadline of ${CONFIG.call.deadlineMs / 1000} s per call (no new request starts after ${CONFIG.call.noNewRequestAfterMs / 1000} s;`);
    expect(readme).toContain(`a download cap of ${mb(CONFIG.call.maxCallBytes)}`);
    expect(readme).toContain(`stop after ${CONFIG.paging.depthGuard} items`);
  });
});
