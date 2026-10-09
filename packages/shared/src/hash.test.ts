import { describe, it, expect } from "vitest";
import { sha256hex, combineHashes } from "../src/hash.js";

describe("hash", () => {
  it("M4.2-0.5 sha256hex/combineHashes", () => {
    expect(sha256hex("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(combineHashes(["b", "a"])).toBe(combineHashes(["a", "b"]));
    expect(combineHashes(["a"])).not.toBe(combineHashes(["a", "b"]));
  });
});
