import type { Node } from "./schema.js";

// 의존 그래프 규칙 (core·runner 공용, M3.3-6).
// leaf → 충족. split → 모든 자손 leaf가 충족. 그 외 미충족.

export function isResolved(n: Node, byId: Map<string, Node>, seen = new Set<string>()): boolean {
  if (n.status === "leaf") return true;
  if (n.status !== "split") return false;
  if (seen.has(n.id)) return false;
  seen.add(n.id);
  if (n.children.length === 0) return false;
  return n.children.every((c) => {
    const child = byId.get(c);
    return child !== undefined && isResolved(child, byId, seen);
  });
}

/** 자손 leaf id 수집 (split 펼침용) */
export function descendantLeafs(nodeId: string, byId: Map<string, Node>, out: string[] = []): string[] {
  const n = byId.get(nodeId);
  if (!n) return out;
  if (n.status === "leaf" || (n.status !== "split" && n.children.length === 0)) {
    out.push(n.id);
    return out;
  }
  if (n.status === "split") {
    for (const c of n.children) descendantLeafs(c, byId, out);
    return out;
  }
  out.push(n.id);
  return out;
}

/** dependsOn id 펼침: split이면 자손 leaf 전체, 아니면 그대로 */
export function expandDepLeafs(depId: string, byId: Map<string, Node>): string[] {
  const n = byId.get(depId);
  if (n && n.status === "split") return descendantLeafs(depId, byId, []);
  return [depId];
}

/** 펼친 그래프 기준 순환 검출 (M3.4.3-2). 각 노드의 deps = dependsOn.flatMap(expand) */
export function hasCycle(nodes: Node[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let found = false;
  const visit = (id: string): void => {
    if (found) return;
    color.set(id, GRAY);
    const n = byId.get(id);
    if (n) {
      for (const d of n.dependsOn.flatMap((x) => expandDepLeafs(x, byId))) {
        if (!byId.has(d)) continue;
        const c = color.get(d) ?? WHITE;
        if (c === GRAY) {
          found = true;
          return;
        }
        if (c === WHITE) visit(d);
      }
    }
    color.set(id, BLACK);
  };
  for (const n of nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id);
  }
  return found;
}
