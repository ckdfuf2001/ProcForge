import { describe, it, expect } from "vitest";
import {
  WireMethods, PROTOCOL_VERSION, checkProtocolVersion,
  toWireError, throwWireError,
} from "../src/wire.js";
import { pfError } from "../src/errors.js";

// M6-1 wire 계약.

describe("wire", () => {
  it("17 메서드 1:1 매핑", () => {
    expect(Object.keys(WireMethods)).toHaveLength(17);
    for (const [name, m] of Object.entries(WireMethods)) {
      expect(m.path).toBe(`/v1/${name}`);
    }
  });

  it("입력 스키마: 필수 누락 거부", () => {
    expect(WireMethods.pfNext.input.safeParse({}).success).toBe(false);
    expect(WireMethods.pfNext.input.safeParse({ sessionId: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(true);
    expect(WireMethods.pfResolve.input.safeParse({
      sessionId: "123e4567-e89b-42d3-a456-426614174000", nodeId: "1", decision: "nope",
    }).success).toBe(false);
  });

  it("버전 검사: 불일치면 conflict + 업그레이드 힌트", () => {
    expect(() => checkProtocolVersion(String(PROTOCOL_VERSION))).not.toThrow();
    try {
      checkProtocolVersion("999");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("conflict");
      expect((e as { hint?: string }).hint).toMatch(/업그레이드/);
    }
    try {
      checkProtocolVersion(undefined);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("conflict");
    }
  });

  it("에러 봉투: 코드 유지·스택 비노출", () => {
    const known = toWireError(pfError("bad_request", "입력 오류", "고쳐라"));
    expect(known).toEqual({ code: "bad_request", message: "입력 오류", hint: "고쳐라" });
    const err = new Error("boom\n    at secret (/x/y.ts:1:1)\npassword=abc");
    const inter = toWireError(err);
    expect(inter.code).toBe("internal");
    expect(inter.message).toBe("내부 오류가 발생했다.");
    expect(JSON.stringify(inter)).not.toMatch(/secret|password|at /);
    try {
      throwWireError(known);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_request");
      expect(String((e as Error).message)).toMatch(/^bad_request: /);
    }
  });
});
