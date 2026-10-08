import { describe, it, expect } from "vitest";
import { NodeSchema, SessionSchema, computeNodeHash } from "../src/schema.js";

describe("schema zod", () => {
  it("Node/ Session 파싱", () => {
    const h = computeNodeHash({ goal: "g", args: {}, constraints: [], dependsOn: [] });
    const n = {
      id: "1",
      parentId: null,
      goal: "월간보고서",
      status: "open",
      depth: 0,
      dependsOn: [],
      children: [],
      sideEffect: "none",
      constraints: [],
      advice: [],
      attempts: [],
      retries: 0,
      hash: h,
      locked: false,
    };
    expect(NodeSchema.safeParse(n).success).toBe(true);
    expect(NodeSchema.safeParse({ ...n, id: "bad" }).success).toBe(false);
    const s = {
      id: "s1",
      request: "r",
      params: {},
      toolCatalog: [],
      rootId: "1",
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
      createdAt: new Date().toISOString(),
    };
    expect(SessionSchema.safeParse(s).success).toBe(true);
  });

  it("hash는 키 순서와 무관하고 내용 변경에 민감", () => {
    const a = computeNodeHash({ goal: "g", args: { b: { kind: "fixed", value: 1 }, a: { kind: "fixed", value: 2 } }, constraints: [], dependsOn: ["2", "1"] });
    const b = computeNodeHash({ goal: "g", args: { a: { kind: "fixed", value: 2 }, b: { kind: "fixed", value: 1 } }, constraints: [], dependsOn: ["1", "2"] });
    expect(a).toBe(b);
    const c = computeNodeHash({ goal: "g2", args: {}, constraints: [], dependsOn: [] });
    expect(c).not.toBe(a);
  });
});
