import { describe, it, expect } from "vitest";
import { resolveVar, resolveArgs, substituteItemSpecs, substituteItemVars, collectRefNodeIds } from "./resolve.js";

// M5.1-B3: 문자열 내 템플릿 치환.

describe("resolveVar 템플릿", () => {
  const outputs = new Map<string, unknown>([["1.1", { total: 5 }]]);
  it("전체 참조 (기존)", () => {
    expect(resolveVar("${params.month}", { month: "2026-10" }, outputs)).toBe("2026-10");
    expect(resolveVar("$1.1.output.total", {}, outputs)).toBe(5);
  });

  it("M5.5-1 ${item} 치환", () => {
    const item = { id: "a", v: 10 };
    expect(substituteItemVars("${item}", "item", item)).toEqual(item);
    expect(substituteItemVars("${item.v}", "item", item)).toBe(10);
    expect(substituteItemVars("x-${item.id}-y", "item", item)).toBe("x-a-y");
    expect(substituteItemVars("plain", "item", item)).toBe("plain");
    expect(substituteItemVars("${other.v}", "item", item)).toBe("${other.v}");
    expect(resolveVar("${item.v}", {}, new Map(), undefined, { name: "item", value: item })).toBe(10);
    const specs = substituteItemSpecs(
      {
        a: { kind: "var", ref: "${item.v}" } as never,
        b: { kind: "fixed", value: "out/${item.id}.txt" } as never,
        c: { kind: "fixed", value: 3 } as never,
        d: { kind: "var", ref: "$1.1.x" } as never,
      },
      "item",
      item,
    );
    // 참조가 해소되면 fixed로 전환, 남은 참조는 var 유지
    expect(specs.a).toEqual({ kind: "fixed", value: 10 });
    expect((specs.b as { value: unknown }).value).toBe("out/a.txt");
    expect((specs.c as { value: unknown }).value).toBe(3);
    expect((specs.d as { ref: unknown }).ref).toBe("$1.1.x");
  });
  it("M5.5-3 ${state.k} 해결", () => {
    const state = { lastId: "b", n: 3 };
    expect(resolveVar("${state.lastId}", {}, new Map(), undefined, undefined, undefined, state)).toBe("b");
    expect(resolveVar("since-${state.lastId}", {}, new Map(), undefined, undefined, undefined, state)).toBe("since-b");
    expect(() => resolveVar("${state.missing}", {}, new Map(), undefined, undefined, undefined, state)).toThrow(/state 키 없음/);
    expect(() => resolveVar("${state.lastId}", {}, new Map())).toThrow(/state 없음/);
  });
  it("M5.2-4 약식 $1.1.rows 해결", () => {
    const outputs = new Map<string, unknown>([["1.1", { rows: [1, 2], total: 5 }]]);
    expect(resolveVar("$1.1.rows", {}, outputs)).toEqual([1, 2]);
    expect(resolveVar("$1.1.output.total", {}, outputs)).toBe(5);
    expect(() => resolveVar("$1.1.missing", {}, outputs)).toThrow();
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

  it("M5.5-4.4-2 collectRefNodeIds는 resolveVar 문법과 일치", () => {
    // 노드 참조 → id, 나머지는 [] (resolveVar 해석 결과와 대조).
    const outs = new Map<string, unknown>([["1.1", { note: "hi" }]]);
    const cases: [string, string[]][] = [
      ["$1.1", ["1.1"]],
      ["$1.1.note", ["1.1"]],
      ["$1.1.output.note", ["1.1"]],
      ["$1", ["1"]],
      ["$self", []],
      ["${params.month}", []],
      ["sales-${params.month}.xlsx", []],
      ["${state.lastId}", []],
      ["${item}", []],
      ["${item.note}", []],
      ["plain", []],
      ["$x", []],
    ];
    for (const [ref, ids] of cases) {
      expect(collectRefNodeIds(ref)).toEqual(ids);
    }
    // 같은 배터리 resolveVar 결제 확인 (노드 참조는 해석 성공).
    expect(resolveVar("$1.1.note", {}, outs)).toBe("hi");
    expect(resolveVar("$self", {}, outs)).toBe(undefined);
    expect(resolveVar("${params.month}", { month: "2026-10" }, outs)).toBe("2026-10");
    expect(() => resolveVar("$x", {}, outs)).toThrow();
  });
});
