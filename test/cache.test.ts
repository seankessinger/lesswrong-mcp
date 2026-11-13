import { describe, expect, it } from "vitest";
import { Lru, createCaches } from "../src/cache";
import { CONFIG } from "../src/config";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("Lru (¶2.3, C1)", () => {
  it("returns a value until its TTL has passed, counted from insert", () => {
    const c = clock();
    const lru = new Lru<string>({ maxEntries: 10, now: c.now });
    lru.set("a", "x", 1000);
    c.advance(999);
    expect(lru.get("a")).toBe("x");
    c.advance(1);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it("entry cap: evicts the least recently used; get refreshes recency", () => {
    const c = clock();
    const lru = new Lru<number>({ maxEntries: 2, now: c.now });
    lru.set("a", 1, 60_000);
    lru.set("b", 2, 60_000);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3, 60_000);
    expect(lru.get("b")).toBeUndefined();
    expect([lru.get("a"), lru.get("c"), lru.size]).toEqual([1, 3, 2]);
  });

  it("byte cap: an entry's size is the length of its JSON at insert", () => {
    const c = clock();
    const lru = new Lru<unknown>({ maxBytes: 30, now: c.now });
    lru.set("a", { x: "abc" }, 60_000); // {"x":"abc"} = 11
    expect(lru.bytes).toBe(11);
    lru.set("b", { x: "def" }, 60_000);
    lru.get("a");
    lru.set("c", { x: "ghi" }, 60_000); // 33 > 30: evict b
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toEqual({ x: "abc" });
    expect(lru.bytes).toBe(22);
  });

  it("does not store a value larger than the byte cap, and replacing a key replaces its size", () => {
    const c = clock();
    const lru = new Lru<string>({ maxBytes: 10, now: c.now });
    lru.set("k", "ab", 60_000); // "ab" = 4
    lru.set("k", "x".repeat(20), 60_000);
    expect(lru.get("k")).toBeUndefined();
    expect([lru.size, lru.bytes]).toEqual([0, 0]);
    lru.set("k", "abcd", 60_000);
    lru.set("k", "a", 60_000);
    expect([lru.get("k"), lru.bytes]).toEqual(["a", 3]);
    lru.delete("k");
    expect([lru.size, lru.bytes]).toEqual([0, 0]);
  });
});

describe("createCaches (¶2.3)", () => {
  it("namespaces keys and applies each namespace's default TTL", () => {
    const c = clock();
    const lru = new Lru<unknown>({ maxBytes: 1_000_000, now: c.now });
    const caches = createCaches(lru);
    caches.set("forest", "post:uMQ3cqWDPHhjtiesc", { n: 1 });
    caches.set("feed", "post:uMQ3cqWDPHhjtiesc", { n: 2 });
    expect(lru.get("forest:post:uMQ3cqWDPHhjtiesc")).toEqual({ n: 1 });
    c.advance(119_999);
    expect(caches.get("feed", "post:uMQ3cqWDPHhjtiesc")).toEqual({ n: 2 });
    c.advance(1);
    expect(caches.get("feed", "post:uMQ3cqWDPHhjtiesc")).toBeUndefined();
    c.advance(480_000 - 1);
    expect(caches.get("forest", "post:uMQ3cqWDPHhjtiesc")).toEqual({ n: 1 });
    c.advance(1);
    expect(caches.get("forest", "post:uMQ3cqWDPHhjtiesc")).toBeUndefined();
  });

  it("an explicit TTL wins; a TTL table can be injected; delete", () => {
    const c = clock();
    const lru = new Lru<unknown>({ maxBytes: 1_000_000, now: c.now });
    const caches = createCaches(lru);
    caches.set("negative", "post:slug:x", "not_found", 10);
    c.advance(10);
    expect(caches.get("negative", "post:slug:x")).toBeUndefined();
    caches.set("resolve", "user:habryka4", "id1");
    caches.delete("resolve", "user:habryka4");
    expect(caches.get("resolve", "user:habryka4")).toBeUndefined();
    const short = createCaches(lru, { ...CONFIG.cache.ttlMs, collections: 5 });
    short.set("collections", "all", 1);
    c.advance(5);
    expect(short.get("collections", "all")).toBeUndefined();
  });
});
