import { describe, it, expect } from "vitest";
import { stableStringify } from "../src/stable.js";

describe("stableStringify", () => {
  it("키 순서 무관 동등", () => {
    expect(stableStringify({ b: 1, a: { y: 2, x: 1 } })).toBe(stableStringify({ a: { x: 1, y: 2 }, b: 1 }));
  });
  it("배열 순서 유지", () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });
  it("원시·특수값", () => {
    expect(stableStringify("a")).toBe('"a"');
    expect(stableStringify(1)).toBe("1");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("");
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
