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

/** 자손 id 전체 (children 링크 추적, corrupt 순환 가드) */
export function descendantIds(nodeId: string, byId: Map<string, Node>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [...(byId.get(nodeId)?.children ?? [])];
  while (queue.length > 0) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    const cn = byId.get(c);
    if (cn) queue.push(...cn.children);
    if (out.length > 100000) break;
  }
  return out;
}

/** 자손 leaf id 수집 (split 펼침용, corrupt children 순환 가드) */
export function descendantLeafs(
  nodeId: string,
  byId: Map<string, Node>,
  out: string[] = [],
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(nodeId)) return out;
  seen.add(nodeId);
  const n = byId.get(nodeId);
  if (!n) return out;
  if (n.status === "leaf" || (n.status !== "split" && n.children.length === 0)) {
    out.push(n.id);
    return out;
  }
  if (n.status === "split") {
    for (const c of n.children) descendantLeafs(c, byId, out, seen);
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

const VAR_REF_RE = /^\$(\d+(?:\.\d+)*)(.*)$/;

/** var ref가 가리키는 노드 id (ArgSpec {kind:"var",ref} 형태만, 고정값 오탐 방지) */
export function varRefNodeIds(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (r["kind"] === "var" && typeof r["ref"] === "string") {
        const m = VAR_REF_RE.exec(r["ref"] as string);
        if (m) out.push(m[1]);
      }
      for (const x of Object.values(r)) walk(x);
    }
  };
  walk(args);
  return [...new Set(out)];
}

/** 펼침 전 원시 의존 소스: own dependsOn + 조상 dependsOn + var ref 노드 (M3.4.4-1) */
export function rawDepSources(node: Node, byId: Map<string, Node>): string[] {
  const out: string[] = [...node.dependsOn];
  let cur: Node | undefined = node;
  let guard = 0;
  while (cur?.parentId && guard++ < 1000) {
    const p = byId.get(cur.parentId);
    if (!p) break;
    out.push(...p.dependsOn);
    cur = p;
  }
  out.push(...varRefNodeIds(node.args as Record<string, unknown> | undefined));
  return [...new Set(out)];
}

/**
 * 실효 의존 (M3.4.4-1): own + 조상 dependsOn + var ref 노드를 펼친 leaf 집합.
 * 자기 자신·자기 자손은 제외.
 */
export function effectiveDeps(node: Node, byId: Map<string, Node>): string[] {
  const selfAndDown = new Set<string>([node.id, ...descendantIds(node.id, byId)]);
  const acc = new Set<string>();
  for (const d of rawDepSources(node, byId)) {
    for (const leaf of expandDepLeafs(d, byId)) {
      if (!selfAndDown.has(leaf)) acc.add(leaf);
    }
  }
  return [...acc];
}

/** 원시 의존이 자기 혈통(자신·조상·자손)을 가리키는지 (M3.4.3-2 split 거부용) */
export function hasLineageDep(node: Node, byId: Map<string, Node>): boolean {
  const fam = new Set<string>([node.id, ...descendantIds(node.id, byId)]);
  let cur: Node | undefined = node;
  let guard = 0;
  while (cur?.parentId && guard++ < 1000) {
    fam.add(cur.parentId);
    const p = byId.get(cur.parentId);
    if (!p) break;
    cur = p;
  }
  return rawDepSources(node, byId).some((d) => fam.has(d));
}

/** 펼친 그래프 기준 순환 검출 (M3.4.3-2, M3.4.4-1 실효 의존). 각 노드의 deps = effectiveDeps */
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
      for (const d of effectiveDeps(n, byId)) {
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
