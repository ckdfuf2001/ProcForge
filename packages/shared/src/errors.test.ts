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

  it("외부 형식·미등록 code는 null", () => {
    expect(parseErrorText("MCP error -32602: Input validation error")).toBe(null);
    expect(parseErrorText("plain text")).toBe(null);
    expect(parseErrorText("")).toBe(null);
    expect(parseErrorText("a: b\nc")).toBe(null);
    expect(parseErrorText("weird_code: something")).toBe(null);
  });

  it("다중 키 누락 메시지 파싱 성공", () => {
    expect(parseErrorText("bad_request: argSpecs missing required: command, path\nhint: 고쳐라")).toEqual({
      code: "bad_request",
      message: "argSpecs missing required: command, path",
      hint: "고쳐라",
    });
  });
});
