import { expect } from "vitest";
import { ToolError } from "../../src/errors";

/** Runs `f`, expects it to throw a `bad_input` ToolError, and returns its message (the text after the category). */
export function badInputMessage(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).category).toBe("bad_input");
    return (e as ToolError).message;
  }
  throw new Error("expected bad_input");
}

/** Awaits `p`, expects it to reject, and returns the rejection reason. */
export async function caught(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}
