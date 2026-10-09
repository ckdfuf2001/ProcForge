import { describe, it, expect } from "vitest";
import { isResolved, expandDepLeafs, descendantLeafs, effectiveDeps, rawDepSources } from "../src/deps.js";
import type { Node } from "../src/schema.js";

const n = (id: string, status: Node["status"], children: string[] = []): Node =>
  ({
    id,
    parentId: null,
    goal: id,
    status,
    depth: 0,
    dependsOn: [],
    children,
    sideEffect: "none",
    constraints: [],
    advice: [],
    attempts: [],
    retries: 0,
    hash: "h",
    locked: false,
  }) as Node;

const withParent = (base: Node, parentId: string | null, dependsOn: string[] = [], args?: Node["args"]): Node =>
  ({ ...base, parentId, dependsOn, args }) as Node;

describe("deps", () => {
  it("isResolved: leaf 또는 전체-leaf split", () => {
    const byId = new Map([
      ["s", n("s", "split", ["s.1", "s.2"])],
      ["s.1", n("s.1", "leaf")],
      ["s.2", n("s.2", "leaf")],
    ]);
    expect(isResolved(byId.get("s")!, byId)).toBe(true);
    byId.set("s.2", n("s.2", "open"));
    expect(isResolved(byId.get("s")!, byId)).toBe(false);
  });

  it("expandDepLeafs: split은 자손 leaf로", () => {
    const byId = new Map([
      ["2", n("2", "split", ["2.1", "2.2"])],
      ["2.1", n("2.1", "leaf")],
      ["2.2", n("2.2", "split", ["2.2.1"])],
      ["2.2.1", n("2.2.1", "leaf")],
    ]);
    expect(expandDepLeafs("2", byId).sort()).toEqual(["2.1", "2.2.1"]);
    expect(expandDepLeafs("2.1", byId)).toEqual(["2.1"]);
    expect(descendantLeafs("2", byId, []).sort()).toEqual(["2.1", "2.2.1"]);
  });

  it("M3.4.4-1 effectiveDeps: own + 조상 + var, 펼침, 자기/자손 제외", () => {
    // 1(split,[1.1,1.2,1.3]) / 1.2(split,[1.2.1,1.2.2]) / 1.3(dep 1.2, split,[1.3.1,1.3.2])
    const n1 = withParent(n("1", "split", ["1.1", "1.2", "1.3"]), null);
    const n11 = withParent(n("1.1", "leaf"), "1");
    const n12 = withParent(n("1.2", "split", ["1.2.1", "1.2.2"]), "1");
    const n121 = withParent(n("1.2.1", "leaf"), "1.2");
    const n122 = withParent(n("1.2.2", "leaf"), "1.2");
    const n13 = withParent(n("1.3", "split", ["1.3.1", "1.3.2"]), "1", ["1.2"]);
    const n131 = withParent(n("1.3.1", "leaf"), "1.3");
    const n132 = withParent(n("1.3.2", "leaf"), "1.3");
    const byId = new Map([n1, n11, n12, n121, n122, n13, n131, n132].map((x) => [x.id, x]));
    // 자식은 조상 의존 상속
    expect(effectiveDeps(n132, byId).sort()).toEqual(["1.2.1", "1.2.2"]);
    expect(effectiveDeps(n131, byId).sort()).toEqual(["1.2.1", "1.2.2"]);
    // var ref 포함
    const withVar = withParent(n("9", "leaf"), null, [], {
      x: { kind: "var", ref: "$1.1" },
    });
    byId.set("9", withVar);
    expect(effectiveDeps(withVar, byId)).toEqual(["1.1"]);
    // ${params.*}는 제외
    const withParam = withParent(n("8", "leaf"), null, [], {
      x: { kind: "var", ref: "${params.month}" },
    });
    expect(effectiveDeps(withParam, byId)).toEqual([]);
    // raw sources는 펼침 전
    expect(rawDepSources(n132, byId)).toEqual(["1.2"]);
  });
});
