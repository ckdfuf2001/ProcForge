import { describe, it, expect } from "vitest";
import { resolveVar, resolveArgs } from "./resolve.js";

// M5.1-B3: 문자열 내 템플릿 치환.

describe("resolveVar 템플릿", () => {
  const outputs = new Map<string, unknown>([["1.1", { total: 5 }]]);
  it("전체 참조 (기존)", () => {
    expect(resolveVar("${params.month}", { month: "2026-10" }, outputs)).toBe("2026-10");
    expect(resolveVar("$1.1.output.total", {}, outputs)).toBe(5);
  });

  it("문자열 내 ${params.k} 치환", () => {
    expect(resolveVar("sales-${params.month}.xlsx", { month: "2026-10" }, outputs)).toBe("sales-2026-10.xlsx");
    expect(resolveVar("월간보고서 ${params.month} (최종)", { month: "2026-10" }, outputs)).toBe("월간보고서 2026-10 (최종)");
    expect(() => resolveVar("sales-${params.missing}.xlsx", { month: "2026-10" }, outputs)).toThrow(/params 참조 없음/);
  });

  it("resolveArgs var 템플릿", () => {
    const out = resolveArgs({
      specs: { f: { kind: "var", ref: "sales-${params.month}.xlsx" } as never },
      params: { month: "2026-10" },
      outputs,
      attempts: [],
      live: true,
    });
    expect(out).toEqual({ f: "sales-2026-10.xlsx" });
  });
});
