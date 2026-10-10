import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedBoundInputs } from "./workdir.js";
import type { Node } from "@procforge/shared/schema.js";

// M5.2-1: 입력 바인딩 시딩 단위 테스트.

let root: string;
let fsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-bind-"));
  fsDir = join(root, "fs");
  mkdirSync(fsDir, { recursive: true });
  writeFileSync(join(root, "sales-2026-10.xlsx"), "XLSX-10");
});

afterEach(() => {});

function node(id: string, args: Node["args"]): Node {
  return {
    id, parentId: "1", goal: "g", status: "leaf", depth: 1, dependsOn: [], children: [],
    tool: { server: "t", name: "x", schemaHash: "h" }, args, sideEffect: "none",
    constraints: [], advice: [], attempts: [], retries: 0, hash: "h", locked: false,
  } as unknown as Node;
}

describe("seedBoundInputs", () => {
  it("템플릿 in 경로를 projectRoot에서 복사", () => {
    const ns = [
      node("1.1", { f: { kind: "var", ref: "sales-${params.month}.xlsx", path: "in" } as never }),
    ];
    const out = seedBoundInputs(ns, root, { month: "2026-10" }, fsDir);
    expect(out).toEqual([{ nodeId: "1.1", arg: "f", rel: "sales-2026-10.xlsx" }]);
    expect(readFileSync(join(fsDir, "sales-2026-10.xlsx"), "utf8")).toBe("XLSX-10");
  });

  it("파일 부재·미등록 키·탈출은 bad_request", () => {
    const missing = [node("1.1", { f: { kind: "var", ref: "sales-${params.month}.xlsx", path: "in" } as never })];
    expect(() => seedBoundInputs(missing, root, { month: "2026-11" }, fsDir)).toThrowError(/파일 없음/);
    const unknownKey = [node("1.1", { f: { kind: "var", ref: "sales-${params.typo}.xlsx", path: "in" } as never })];
    expect(() => seedBoundInputs(unknownKey, root, { month: "2026-10" }, fsDir)).toThrowError(/bad_request|입력 바인딩 실패/);
    const escape = [node("1.1", { f: { kind: "var", ref: "../${params.month}.xlsx", path: "in" } as never })];
    try {
      seedBoundInputs(escape, root, { month: "x" }, fsDir);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code ?? (e as Error).message).toMatch(/bad_request|탈출/);
    }
  });

  it("fixed 리터럴·$노드 참조·out 역할은 제외", () => {
    const ns = [
      node("1.1", {
        a: { kind: "fixed", value: "sales-2026-10.xlsx", path: "in" },
        b: { kind: "var", ref: "$1.1.output.path", path: "in" } as never,
        c: { kind: "var", ref: "sales-${params.month}.xlsx", path: "out" } as never,
      }),
    ];
    expect(seedBoundInputs(ns, root, { month: "2026-10" }, fsDir)).toEqual([]);
  });
});
