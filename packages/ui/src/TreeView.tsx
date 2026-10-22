import { useEffect, useState } from "react";
import { api, subscribeEvents, ApiError, type NodeRow } from "./api.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";

// M7-ui2: 세션 트리 + 실시간 갱신.
// 판단 if문 금지 — 상태·staleSince 등 표시는 core가 준 값만 그대로 찍는다.

const STATUS_CLASS: Record<string, string> = {
  open: "st-open",
  probing: "st-probing",
  leaf: "st-leaf",
  split: "st-split",
  needs_human: "st-needs-human",
  failed: "st-failed",
};

/** 숫자 정렬 (1, 1.2, 1.10 순 — core compareNodeIds와 같은 규칙) */
export function compareNodeIds(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function TreeView({
  sessionId,
  focusNodeId,
}: {
  sessionId: string;
  /** M7-5-4: 실행 화면에서 "이 노드 열기" 로 들어올 때 상세를 바로 연다 */
  focusNodeId?: string | null;
}) {
  const [nodes, setNodes] = useState<NodeRow[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [picked, setPicked] = useState<string | null>(focusNodeId ?? null);
  const [needsHuman, setNeedsHuman] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [live, setLive] = useState<"open" | "closed" | "error" | "connecting">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void (async () => {
      try {
        const t = await api.tree(sessionId);
        setNodes(t.nodes.nodes);
        setRevision(t.nodes.revision);
        setNeedsHuman(t.blocked.needsHuman);
        setBlocked(
          t.blocked.blocked.map((b) => `${b.nodeId}(${b.reason})`),
        );
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  };

  useEffect(() => {
    if (focusNodeId) setPicked(focusNodeId);
  }, [focusNodeId]);

  useEffect(() => {
    reload();
    return subscribeEvents(
      sessionId,
      () => reload(),
      setLive,
    );
  }, [sessionId]);

  if (error) return <p role="alert">오류: {error}</p>;
  if (!nodes) return <p>트리 불러오는 중…</p>;
  const sorted = [...nodes].sort((a, b) => compareNodeIds(a.id, b.id));

  return (
    <div className="tree-view">
      <div className="live-line">
        <span className={`live-dot live-${live}`} aria-hidden="true" />
        <span>실시간: {live}</span>
        <span className="muted">revision {revision}</span>
        <span className="muted">{nodes.length}개 노드</span>
      </div>
      {needsHuman.length > 0 && (
        <p role="status">사람 확인 필요: {needsHuman.join(", ")}</p>
      )}
      {blocked.length > 0 && <p>막힘: {blocked.join(", ")}</p>}
      {picked && (
        <div className="node-detail-wrap">
          <button className="btn btn-ghost" type="button" onClick={() => setPicked(null)}>
            ← 트리로
          </button>
          <NodeDetailPanel
            sessionId={sessionId}
            nodeId={picked}
            revision={revision}
          />
        </div>
      )}
      <div className="table-card">
        <table className="data-table tree-table">
          <thead>
            <tr>
              <th>id</th>
              <th>목표</th>
              <th>상태</th>
              <th className="col-num">반복</th>
              <th className="col-num">남은</th>
              <th>자물쇠</th>
              <th>부작용</th>
              <th>stale</th>
              <th>의존</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((n) => (
              <tr key={n.id} className={STATUS_CLASS[n.status] ?? "st-other"}>
                <td>
                  <button className="btn-id" type="button" onClick={() => setPicked(n.id)}>
                    {n.id}
                  </button>
                </td>
                <td className="cell-goal">{n.goal}</td>
                <td>
                  <span className={`status status-${n.status}`}>{n.status}</span>
                </td>
                <td className="col-num">{n.attempts}</td>
                <td className="col-num">{n.retriesLeft}</td>
                <td>{n.locked ? <span className="status status-probing">잠김</span> : ""}</td>
                <td>
                  {n.sideEffect === "external" ? (
                    <span className="status status-split">외부</span>
                  ) : (
                    ""
                  )}
                </td>
                <td>
                  {n.staleSince ? (
                    <span className="status status-needs_human">
                      stale rev{n.staleSince.revision} · {n.staleSince.causeNodeId}
                    </span>
                  ) : (
                    ""
                  )}
                </td>
                <td>
                  {n.dependsOn.length === 0 ? (
                    <span className="muted">-</span>
                  ) : (
                    n.dependsOn.map((id) => <code key={id}>{id}</code>)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}