import { describe, it, expect } from "vitest";
import { isResolved, expandDepLeafs, descendantLeafs } from "../src/deps.js";
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
});
