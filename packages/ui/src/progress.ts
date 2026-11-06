// M10-3-ui: 상단 진행률 바 계산 (순수 함수, 판단 없음).
// leaf = 다른 노드의 접두사(id + ".")가 아닌 노드.
// 분자 = 상태가 leaf(확정)인 leaf. needs_reverify는 leaf이지만 분자에서 빠진다.
// 분모에 따로 더하지 않는다 (spec §1: needs_reverify도 leaf이므로).

export type ProgressInput = { id: string; status: string };

export function isLeafId(id: string, all: string[]): boolean {
  const prefix = `${id}.`;
  for (const other of all) {
    if (other !== id && other.startsWith(prefix)) return false;
  }
  return true;
}

export function progressOf(nodes: ProgressInput[]): {
  done: number;
  total: number;
  percent: number;
} {
  const ids = nodes.map((n) => n.id);
  const leaves = nodes.filter((n) => isLeafId(n.id, ids));
  const done = leaves.filter((n) => n.status === "leaf").length;
  const total = leaves.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}
