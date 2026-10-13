import { describe, it, expect } from "vitest";
import { buildRefOutputs, checkProbingArgs, type RefNodeInfo } from "./ref-check.js";

// M5.8.2 후속: golden→최종pass 기준, stable 비교, map/until 제외.

function nodes(...list: RefNodeInfo[]): Map<string, RefNodeInfo> {
  return new Map(list.map((n) => [n.id, n]));
}
const files: Record<string, unknown> = {
  g1: { raw: ["a"] },
  p1: { raw: ["b"] },
};
const loadJson = (aid: string) => files[aid];

describe("ref-check", () => {
  it("golden 우선, 없으면 최종 pass, fail 본은 사용 금지", () => {
    const ns = nodes({
      id: "1.1", attempts: [{ id: "g1", verdict: "pass" }, { id: "f1", verdict: "fail" }],
    });
    const { outputs } = buildRefOutputs({
      specs: { input: { kind: "var", ref: "$1.1.raw" } },
      params: {}, nodes: ns, loadJson,
    });
    // golden 없음 → 최종 pass(g1). fail 본(f1, 파일 없음)은 사용 안 됨.
    expect(outputs).toEqual({ "1.1": { raw: ["a"] } });
    const ns2 = nodes({
      id: "1.1", goldenAttemptId: "p1", attempts: [{ id: "g1", verdict: "pass" }],
    });
    const o2 = buildRefOutputs({
      specs: { input: { kind: "var", ref: "$1.1" } },
      params: {}, nodes: ns2, loadJson,
    });
    // golden(p1) 우선.
    expect(o2.outputs).toEqual({ "1.1": { raw: ["b"] } });
  });

  it("match/mismatch/unverifiable + stable 비교", () => {
    const ns = nodes({ id: "1.1", attempts: [{ id: "g1", verdict: "pass" }] });
    const base = { specs: {}, probingArgs: {}, params: {}, nodes: ns, loadJson };
    // 키 순서 달라도 match.
    const m = checkProbingArgs({
      ...base,
      specs: { input: { kind: "var", ref: "$1.1" } },
      probingArgs: { input: { raw: ["a"] } },
    });
    expect(m).toEqual([{ key: "input", verdict: "match" }]);
    const mm = checkProbingArgs({
      ...base,
      specs: { input: { kind: "var", ref: "$1.1.raw" } },
      probingArgs: { input: "raw.json" },
    });
    expect(mm[0].verdict).toBe("mismatch");
    const uv = checkProbingArgs({
      ...base,
      specs: { input: { kind: "var", ref: "$9.x" } },
      probingArgs: { input: 1 },
    });
    expect(uv).toEqual([{ key: "input", verdict: "unverifiable" }]);
  });

  it("map/until 대상 제외 + params 해결", () => {
    const ns = nodes({ id: "1.1", kind: "until", attempts: [{ id: "g1", verdict: "pass" }] });
    const { outputs } = buildRefOutputs({
      specs: { input: { kind: "var", ref: "$1.1" } },
      params: {}, nodes: ns, loadJson,
    });
    expect(outputs).toEqual({});
    const p = checkProbingArgs({
      specs: { d: { kind: "var", ref: "${params.date}" } },
      probingArgs: { d: "2026-10-13" },
      params: { date: "2026-10-13" }, nodes: ns, loadJson,
    });
    expect(p).toEqual([{ key: "d", verdict: "match" }]);
  });
});
