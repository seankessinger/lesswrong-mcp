// The fetch tripwire (¶9): tests never reach the network. Every test file runs after
// test/setup.ts has replaced the global fetch with tripwireFetch, so any network attempt
// throws and fails the test; tests reach the forum only through the fake forum.

export function tripwireFetch(url: unknown): never {
  throw new Error("network access attempted in tests: " + String(url));
}

export function installTripwire(): void {
  globalThis.fetch = tripwireFetch as typeof fetch;
}
