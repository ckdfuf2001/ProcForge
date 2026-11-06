import { compareNodeIds } from "./TreeView.js";
import { isLeafId } from "./progress.js";
import type { NodeRow } from "./api.js";

// M10-3-ui: 남은 작업 목록. 미완료 leaf + needs_reverify + suspended(승인 대기).
// suspended는 실행 대기가 아니라 승인 대기(needs_human)다 — 서버 blocked 그대로.

export function RemainingList({
  nodes,
  needsHuman,
}: {
  nodes: NodeRow[];
  needsHuman: string[];
}) {
  const ids = nodes.map((n) => n.id);
  const undone = nodes
    .filter((n) => isLeafId(n.id, ids) && n.status !== "leaf")
    .map((n) => n.id);
  const reverify = nodes.filter((n) => n.status === "needs_reverify").map((n) => n.id);
  const all = [...new Set([...undone, ...reverify, ...needsHuman])].sort(compareNodeIds);
  if (all.length === 0) return <p className="muted">남은 작업 없음.</p>;
  return (
    <section aria-label="남은 작업">
      <h4>남은 작업 ({all.length})</h4>
      <ul>
        {all.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
