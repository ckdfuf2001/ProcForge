import { describe, it, expect } from "vitest";
import { ProcForgeError, pfError, errorCodeOf, ERROR_CODE_LIST } from "../src/errors.js";

describe("errors", () => {
  it("M4.2-0 코드 목록", () => {
    for (const c of ["bad_request", "bad_args", "conflict", "not_found", "session_not_found", "unimplemented", "internal"]) {
      expect(ERROR_CODE_LIST).toContain(c);
    }
  });

  it("ProcForgeError 필드", () => {
    const e = pfError("bad_request", "msg", "hint");
    expect(e).toBeInstanceOf(ProcForgeError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("bad_request");
    expect(e.message).toBe("msg");
    expect(e.hint).toBe("hint");
    expect(pfError("conflict", "m").hint).toBeUndefined();
  });

  it("errorCodeOf 추출/폴백", () => {
    expect(errorCodeOf(pfError("conflict", "x"))).toBe("conflict");
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "bad_args" }))).toBe("bad_args");
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "typo" }))).toBe("internal");
    expect(errorCodeOf(new Error("x"))).toBe("internal");
    expect(errorCodeOf(null)).toBe("internal");
    expect(errorCodeOf("bad_request")).toBe("internal");
  });
});
