import { describe, it, expect } from "vitest";
import { auditFixedValues, recordedNumbers } from "./finalize-audit.js";
import type { Node } from "@procforge/shared/schema.js";

// M5.1-B1: 고정값 감사 단위 테스트.

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, parentId: "1", goal: "g", status: "leaf", depth: 1, dependsOn: [], children: [],
    tool: { server: "t", name: "x", schemaHash: "h" }, args: {}, sideEffect: "none",
    constraints: [], advice: [], attempts: [], retries: 0, hash: "h", locked: false,
    ...over,
  } as unknown as Node;
}

const P = { month: "2026-09" };
const noCass = new Map();

describe("auditFixedValues", () => {
  it("constraint spec의 params 부분 일치", () => {
    const ns = [
      node("1.1", {
        constraints: [
          { id: "c1", kind: "equals", spec: { path: "m", expected: "report-2026-09" }, source: "human" },
        ],
      }),
    ];
    const out = auditFixedValues({ params: P, nodes: ns, cassettes: noCass });
    expect(out.some((w) => w.includes('params "month"'))).toBe(true);
  });

  it("날짜 표현 4종", () => {
    const vals = ["2026-09", "2026년 9월", "9월 보고", "202609"];
    for (const v of vals) {
      const ns = [node("1.1", { args: { f: { kind: "fixed", value: v } } })];
      const out = auditFixedValues({ params: {}, nodes: ns, cassettes: noCass });
      expect(out.some((w) => w.includes("날짜 표현")), v).toBe(true);
    }
  });

  it("녹화 응답 수치와 일치 (4자리 이상만)", () => {
    const cas = new Map([["1.1", [{ response: { summary: "total 1320000", json: { n: 1320000 } } }]]]);
    const hit = auditFixedValues({
      params: {}, nodes: [node("1.1", { args: { f: { kind: "fixed", value: "1,320,000" } } })], cassettes: cas,
    });
    expect(hit.some((w) => w.includes("녹화 응답 수치"))).toBe(true);
    const miss = auditFixedValues({
      params: {}, nodes: [node("1.1", { args: { f: { kind: "fixed", value: "42" } } })], cassettes: cas,
    });
    expect(miss).toEqual([]);
  });

  it("깨끗한 노드는 발견 없음", () => {
    const ns = [
      node("1.1", {
        args: { f: { kind: "fixed", value: "data.pptx" }, n: { kind: "fixed", value: 3 } },
        constraints: [
          { id: "c1", kind: "file_exists", spec: { path: "fixtures/1.1/a/0-data.pptx" }, source: "auto" },
        ],
      }),
    ];
    expect(auditFixedValues({ params: P, nodes: ns, cassettes: noCass })).toEqual([]);
  });

  it("recordedNumbers 추출", () => {
    const s = recordedNumbers([{ response: { summary: "Edited 3 cells", json: { n: 1320000 } } }]);
    expect(s.has(1320000)).toBe(true);
    expect(s.has(3)).toBe(false);
  });
});
