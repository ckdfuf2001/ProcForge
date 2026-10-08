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
