import { describe, it, expect } from "vitest";
import { validateTree } from "../src/validator.js";
import type { Node, Session } from "@procforge/shared/schema.js";

function baseSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    request: "월간보고서",
    params: { month: "2026-09" },
    toolCatalog: [
      {
        server: "fs",
        name: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        } as unknown as Record<string, unknown>,
        schemaHash: "abc",
      },
    ],
    rootId: "1",
    limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    createdAt: new Date().toISOString(),
    revision: 0,
    ...over,
  };
}

function leaf(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    parentId: null,
    goal: `goal ${id}`,
    status: "leaf",
    depth: 0,
    dependsOn: [],
    children: [],
    tool: { server: "fs", name: "read", schemaHash: "abc" },
    args: { path: { kind: "fixed", value: "a.txt" } },
    sideEffect: "none",
    constraints: [],
    advice: [],
    attempts: [
      {
        id: "a1",
        at: new Date().toISOString(),
        tool: { server: "fs", name: "read" },
        args: { path: "a.txt" },
        resultSummary: "ok",
        artifacts: [],
        verdict: "pass",
        failedConstraints: [],
      },
    ],
    retries: 0,
    hash: "h",
    locked: false,
    ...over,
  };
}

describe("validator 10종", () => {
  it("1. leaf tool이 catalog에 없음", () => {
    const s = baseSession();
    const n = leaf("1", { tool: { server: "no", name: "tool", schemaHash: "x" } });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "unknown_tool")).toBe(true);
  });

  it("2. args가 inputSchema에 부적합", () => {
    const s = baseSession();
    const n = leaf("1", { args: { path: { kind: "fixed", value: 123 } } });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "bad_args")).toBe(true);
  });

  it("3. var 참조가 존재하지 않는 노드", () => {
    const s = baseSession();
    const n = leaf("1", { args: { path: { kind: "var", ref: "$9.output.path" } } });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "bad_ref")).toBe(true);
  });

  it("4. 참조 필드 경로 오류", () => {
    const s = baseSession();
    const n1 = leaf("1");
    const n2 = leaf("2", {
      parentId: null,
      args: { path: { kind: "var", ref: "$1.output.nonexistent.deep" } },
    });
    const errs = validateTree(s, [n1, n2], { outputs: { "1": { path: "a.txt" } } });
    expect(errs.some((e) => e.code === "bad_ref_field")).toBe(true);
  });

  it("5. 순환 의존", () => {
    const s = baseSession();
    const a = leaf("1", { dependsOn: ["2"] });
    const b = leaf("2", { dependsOn: ["1"] });
    const errs = validateTree(s, [a, b]);
    expect(errs.some((e) => e.code === "cycle")).toBe(true);
  });

  it("M5.5-1 map 범위 item 참조 + bad_map", () => {
    const s = baseSession();
    const tplArgs = { v: { kind: "var", ref: "${item.v}" } };
    const mapSpec = {
      over: "$1.items", as: "item", maxItems: 10, policy: { kind: "threshold", ratio: 0.5 },
      template: { tool: { server: "fs", name: "read" }, args: tplArgs, constraints: [] },
    };
    const map = leaf("2", {
      children: [],
      args: tplArgs,
      ...{ kind: "map", map: mapSpec },
    } as Partial<Node>);
    const src = leaf("1");
    const errs = validateTree(s, [src, map]);
    expect(errs.filter((e) => e.code === "bad_ref" || e.code === "bad_ref_field" || e.code === "bad_map")).toEqual([]);
    // as 불일치
    const badTplArgs = { v: { kind: "var", ref: "${it.v}" } };
    const badName = leaf("2", {
      children: [],
      args: badTplArgs,
      ...{ kind: "map", map: { ...mapSpec, template: { tool: { server: "fs", name: "read" }, args: badTplArgs, constraints: [] } } },
    } as Partial<Node>);
    expect(
      validateTree(s, [src, badName]).some((e) => e.code === "bad_ref" && e.message.includes("unknown item")),
    ).toBe(true);
    // map 범위 밖 item 참조
    const outside = leaf("9", { args: { v: { kind: "var", ref: "${item.v}" } } });
    expect(
      validateTree(s, [src, outside]).some((e) => e.code === "bad_ref_field"),
    ).toBe(true);
    // 자식 보유 map
    const withChild = leaf("3", {
      children: ["3.1"],
      ...{ kind: "map", map: mapSpec },
    } as Partial<Node>);
    const ch = leaf("3.1", { parentId: "3" });
    expect(
      validateTree(s, [src, withChild, ch]).some((e) => e.code === "bad_map"),
    ).toBe(true);
    // over 비어 있음
    const noOver = leaf("4", { ...{ kind: "map", map: { over: "" } } } as Partial<Node>);
    expect(
      validateTree(s, [src, noOver]).some((e) => e.code === "bad_map"),
    ).toBe(true);
  });
  it("M5.2-4 약식 $1.1.rows 허용 + 미등록 노드 거부", () => {
    const s = baseSession();
    const ok = leaf("2", {
      parentId: null,
      args: { r: { kind: "var", ref: "$1.1.rows" } },
    });
    const errs = validateTree(s, [leaf("1.1"), ok], { outputs: { "1.1": { rows: [1] } } });
    expect(errs.filter((e) => e.code === "bad_ref" || e.code === "bad_ref_field")).toEqual([]);
    const bad = leaf("2", {
      parentId: null,
      args: { r: { kind: "var", ref: "$9.9.rows" } },
    });
    expect(
      validateTree(s, [leaf("1.1"), bad]).some((e) => e.code === "bad_ref"),
    ).toBe(true);
  });
  it("M5.1-B3 템플릿 var 허용 + 미등록 키 거부 + 깨진 템플릿 거부", () => {
    const s = baseSession();
    const ok = leaf("1", { args: { path: { kind: "var", ref: "sales-${params.month}.xlsx" } } });
    expect(validateTree(s, [ok]).filter((e) => e.code === "bad_ref" || e.code === "bad_ref_field")).toEqual([]);
    const unknown = leaf("1", { args: { path: { kind: "var", ref: "sales-${params.typo}.xlsx" } } });
    expect(validateTree(s, [unknown]).some((e) => e.code === "bad_ref")).toBe(true);
    const broken = leaf("1", { args: { path: { kind: "var", ref: "sales-${month}.xlsx" } } });
    expect(validateTree(s, [broken]).some((e) => e.code === "bad_ref_field")).toBe(true);
  });

  it("6. depth 초과", () => {
    const s = baseSession();
    const n = leaf("1", { depth: 99 });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "depth_exceeded")).toBe(true);
  });

  it("7. 노드 수 초과", () => {
    const s = baseSession({ limits: { maxDepth: 3, maxRetries: 2, maxNodes: 1 } });
    const errs = validateTree(s, [leaf("1"), leaf("2")]);
    expect(errs.some((e) => e.code === "too_many_nodes")).toBe(true);
  });

  it("8. schemaHash 불일치", () => {
    const s = baseSession();
    const n = leaf("1", { tool: { server: "fs", name: "read", schemaHash: "DIFFERENT" } });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "schema_hash_mismatch")).toBe(true);
  });

  it("9. leaf 확정 조건 미달 (verdict!=pass)", () => {
    const s = baseSession();
    const n = leaf("1", {
      attempts: [
        {
          id: "a1",
          at: new Date().toISOString(),
          tool: { server: "fs", name: "read" },
          args: {},
          resultSummary: "fail",
          artifacts: [],
          verdict: "fail",
          failedConstraints: ["c1"],
        },
      ],
    });
    const errs = validateTree(s, [n]);
    expect(errs.some((e) => e.code === "leaf_not_confirmed")).toBe(true);
  });

  it("10. id/parent/children 불일치", () => {
    const s = baseSession();
    const parent: Node = {
      ...leaf("1"),
      status: "split",
      tool: undefined,
      args: undefined,
      attempts: [],
      children: ["1.1"],
    };
    const child = leaf("1.1", { parentId: "WRONG" });
    const errs = validateTree(s, [parent, child]);
    expect(errs.some((e) => e.code === "parent_link" || e.code === "children_link")).toBe(true);
  });

  it("정상 트리는 에러 없음", () => {
    const s = baseSession();
    expect(validateTree(s, [leaf("1")])).toEqual([]);
  });

  it("M3.4-5 조상/자손 의존은 dep_on_lineage", () => {
    const s = baseSession();
    const parent: Node = {
      ...leaf("1"),
      status: "split",
      tool: undefined,
      args: undefined,
      attempts: [],
      children: ["1.1"],
    };
    // 자식이 부모에 의존 → lineage
    const childDepParent = leaf("1.1", { parentId: "1", dependsOn: ["1"] });
    expect(validateTree(s, [parent, childDepParent]).some((e) => e.code === "dep_on_lineage")).toBe(true);
    // 부모가 자손에 의존 → lineage
    const parentDepChild: Node = { ...parent, dependsOn: ["1.1"] };
    const child = leaf("1.1", { parentId: "1" });
    expect(validateTree(s, [parentDepChild, child]).some((e) => e.code === "dep_on_lineage")).toBe(true);
    // 형제 의존은 정상
    const sib1 = leaf("1.1", { parentId: "1" });
    const sib2 = leaf("1.2", { parentId: "1", dependsOn: ["1.1"] });
    const parent2: Node = { ...parent, children: ["1.1", "1.2"] };
    expect(validateTree(s, [parent2, sib1, sib2]).some((e) => e.code === "dep_on_lineage")).toBe(false);
  });

  it("M3.4.3-2 펼친 순환: 3→2(split)→2.1→3", () => {
    const s = baseSession();
    const n2: Node = {
      ...leaf("2"),
      status: "split",
      tool: undefined,
      args: undefined,
      attempts: [],
      children: ["2.1"],
    };
    const n21 = leaf("2.1", { parentId: "2", dependsOn: ["3"] });
    const n3 = leaf("3", { dependsOn: ["2"] });
    const errs = validateTree(s, [n2, n21, n3]);
    expect(errs.some((e) => e.code === "cycle")).toBe(true);
  });

  it("M3.4.3-4 additionalProperties:false 낯선 키 + type 배열", () => {
    const s = baseSession({
      toolCatalog: [
        {
          server: "fs",
          name: "read",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              mode: { type: ["string", "null"] },
            },
            required: ["file_path"],
            additionalProperties: false,
          } as unknown as Record<string, unknown>,
          schemaHash: "abc",
        },
      ],
    });
    const bad = leaf("1", {
      args: {
        file_path: { kind: "fixed", value: "a" },
        filepath: { kind: "fixed", value: "a" },
        mode: { kind: "fixed", value: null },
      },
    });
    const errs = validateTree(s, [bad]);
    expect(errs.some((e) => e.code === "bad_args" && /filepath/.test(e.message))).toBe(true);
    const good = leaf("1", {
      args: {
        file_path: { kind: "fixed", value: "a" },
        mode: { kind: "fixed", value: null },
      },
    });
    expect(validateTree(s, [good])).toEqual([]);
  });
});
