import { describe, it, expect } from "vitest";
import { parseErrorText } from "./errors.js";

// M5.3-0-3: 에러 텍스트 파서 단위 테스트.

describe("parseErrorText", () => {
  it("두 줄 형식", () => {
    expect(parseErrorText("bad_request: 검증 오류 2건\nhint: 입력을 고쳐라")).toEqual({
      code: "bad_request",
      message: "검증 오류 2건",
      hint: "입력을 고쳐라",
    });
  });

  it("한 줄 형식 (hint 없음)", () => {
    expect(parseErrorText("conflict: 잠김")).toEqual({ code: "conflict", message: "잠김" });
  });

  it("외부 형식은 null", () => {
    expect(parseErrorText("MCP error -32602: Input validation error")).toBe(null);
    expect(parseErrorText("plain text")).toBe(null);
    expect(parseErrorText("")).toBe(null);
    expect(parseErrorText("a: b\nc")).toBe(null);
  });
});
