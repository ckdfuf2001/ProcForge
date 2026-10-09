import { describe, it, expect } from "vitest";
import { evaluateConstraint, evaluateAll } from "../src/checker.js";
import type { Constraint } from "@procforge/shared/schema.js";

describe("checker kinds", () => {
  it("file_exists pass/fail", () => {
    const c: Constraint = { id: "c1", kind: "file_exists", spec: { path: "out/report.md" }, source: "auto" };
    expect(evaluateConstraint(c, { artifacts: { "out/report.md": "x" } }).pass).toBe(true);
    expect(evaluateConstraint(c, { fileExists: (p) => p === "out/report.md" }).pass).toBe(true);
    expect(evaluateConstraint(c, { fileExists: () => false }).pass).toBe(false);
  });

  it("json_path_exists via jsonPointer / jsonPath / path", () => {
    const doc = { a: [{ b: 1 }] };
    expect(
      evaluateConstraint(
        { id: "c", kind: "json_path_exists", spec: { path: "x", jsonPointer: "/a/0/b" }, source: "auto" },
        { resultJson: doc },
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "json_path_exists", spec: { path: "x", jsonPointer: "/a/9" }, source: "auto" },
        { resultJson: doc },
      ).pass,
    ).toBe(false);
    expect(
      evaluateConstraint(
        { id: "c", kind: "json_path_exists", spec: { path: "x", jsonPath: "a.0.b" }, source: "auto" },
        { resultJson: doc },
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "json_path_exists", spec: { path: "a.0.b" }, source: "auto" },
        { resultJson: doc },
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "json_path_exists", spec: { path: "missing" }, source: "auto" },
        { resultJson: doc },
      ).pass,
    ).toBe(false);
  });

  it("equals pass/fail", () => {
    expect(
      evaluateConstraint(
        { id: "c", kind: "equals", spec: { expected: 1, actual: 1 }, source: "auto" },
        {},
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "equals", spec: { expected: 1, actual: 2 }, source: "auto" },
        {},
      ).pass,
    ).toBe(false);
    expect(
      evaluateConstraint(
        { id: "c", kind: "equals", spec: { path: "month", expected: "2026-09" }, source: "auto" },
        { resultJson: { month: "2026-09" } },
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "equals", spec: { path: "month", expected: "2026-09" }, source: "auto" },
        { resultJson: { month: "2026-10" } },
      ).pass,
    ).toBe(false);
  });

  it("regex pass/fail", () => {
    const c: Constraint = {
      id: "c",
      kind: "regex",
      spec: { value: "매출 100만원", pattern: "매출\\s*\\d+" },
      source: "auto",
    };
    expect(evaluateConstraint(c, {}).pass).toBe(true);
    const c2: Constraint = {
      id: "c",
      kind: "regex",
      spec: { path: "title", pattern: "^월간보고서" },
      source: "auto",
    };
    expect(evaluateConstraint(c2, { resultJson: { title: "월간보고서 9월" } }).pass).toBe(true);
    expect(evaluateConstraint(c2, { resultJson: { title: "주간보고서" } }).pass).toBe(false);
  });

  it("count pass/fail", () => {
    const ctx = { resultJson: { slides: [1, 2, 3] } };
    expect(
      evaluateConstraint({ id: "c", kind: "count", spec: { path: "slides", exact: 3 }, source: "auto" }, ctx).pass,
    ).toBe(true);
    expect(
      evaluateConstraint({ id: "c", kind: "count", spec: { path: "slides", min: 4 }, source: "auto" }, ctx).pass,
    ).toBe(false);
    expect(
      evaluateConstraint({ id: "c", kind: "count", spec: { path: "slides", min: 2, max: 5 }, source: "auto" }, ctx).pass,
    ).toBe(true);
  });

  it("numeric_match tolerance/range (부가세 제외 케이스)", () => {
    expect(
      evaluateConstraint(
        { id: "c", kind: "numeric_match", spec: { value: 100, expected: 100, tolerance: 0.01 }, source: "human" },
        {},
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "numeric_match", spec: { path: "total", min: 90, max: 110 }, source: "human" },
        { resultJson: { total: 100 } },
      ).pass,
    ).toBe(true);
    expect(
      evaluateConstraint(
        { id: "c", kind: "numeric_match", spec: { path: "total", min: 90, max: 110 }, source: "human" },
        { resultJson: { total: 200 } },
      ).pass,
    ).toBe(false);
  });

  it("schema pass/fail", () => {
    const c: Constraint = {
      id: "c",
      kind: "schema",
      spec: { jsonSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } },
      source: "auto",
    };
    expect(evaluateConstraint(c, { resultJson: { title: "a" } }).pass).toBe(true);
    expect(evaluateConstraint(c, { resultJson: { no: 1 } }).pass).toBe(false);
  });

  it("numeric_match expectedRef (M4)", () => {
    const c = {
      id: "n",
      kind: "numeric_match",
      spec: { path: "total", expectedRef: "$1.output.gross", tolerance: 0.01 },
      source: "human",
    } as never;
    // nodeOutputs 없음 → deferred (core는 unverified 처리)
    const d = evaluateConstraint(c as never, { resultJson: { total: 100 } });
    expect(d.pass).toBe(false);
    expect(d.deferred).toBe(true);
    // runner: outputs로 판정
    const p = evaluateConstraint(c as never, {
      resultJson: { total: 100 },
      nodeOutputs: { "1": { gross: 100 } },
    });
    expect(p.pass).toBe(true);
    const f = evaluateConstraint(c as never, {
      resultJson: { total: 200 },
      nodeOutputs: { "1": { gross: 100 } },
    });
    expect(f.pass).toBe(false);
    expect(f.deferred).toBeFalsy();
    // ref 대상이 숫자가 아니면 fail (지연 아님)
    const t = evaluateConstraint(c as never, {
      resultJson: { total: 100 },
      nodeOutputs: { "1": { gross: "x" } },
    });
    expect(t.pass).toBe(false);
    // evaluateAll에서는 deferred가 unverified로 집계 (verdict는 pass 유지)
    const all = evaluateAll([c] as never, { resultJson: { total: 100 } });
    expect(all.verdict).toBe("pass");
    expect(all.unverified).toEqual(["n"]);
    expect(all.failedConstraints).toEqual([]);
  });
  it("llm_rubric is unverifiable", () => {
    const c: Constraint = { id: "c", kind: "llm_rubric", spec: { rubric: "자연스러운 문체" }, source: "human" };
    const r = evaluateConstraint(c, {});
    expect(r.pass).toBe(false);
    expect(r.needsHuman).toBe(true);
    const all = evaluateAll([c], {});
    expect(all.verdict).toBe("unverifiable");
    expect(all.unverified).toEqual(["c"]);
  });

  it("evaluateAll mixes deterministic + rubric", () => {
    const all = evaluateAll(
      [
        { id: "a", kind: "equals", spec: { expected: 1, actual: 1 }, source: "auto" },
        { id: "b", kind: "llm_rubric", spec: { rubric: "x" }, source: "human" },
      ],
      {},
    );
    expect(all.verdict).toBe("pass");
    expect(all.unverified).toEqual(["b"]);
  });
});
