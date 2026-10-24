import { useEffect, useMemo, useState } from "react";
import {
  api,
  subscribeEvents,
  ApiError,
  type DecompositionRound,
  type HistoryNode,
  type TreeAtResponse,
} from "./api.js";
import { RoundTimeline } from "./RoundTimeline.js";
import { ReasonPanel } from "./ReasonPanel.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";

// M8-ui3: 3단 화면 — 라운드 타임라인 | 그 시점 트리 | 사유·의견.
// 판단 if문 금지 — core 가 준 값만 그대로 찍는다.
// 노드 상세·의견 폼은 **기존 NodeDetailPanel 을 그대로** 쓴다 (로직 재구현 금지).

const STATUS_CLASS: Record<string, string> = {
  open: "st-open",
  probing: "st-probing",
  /** M8-1-0: 확정 후 hash 변경 → 재검증 대기 */
  needs_reverify: "st-needs-reverify",
  leaf: "st-leaf",
  split: "st-split",
  needs_human: "st-needs-human",
  failed: "st-failed",
};

/** M8-1-0: 재검증 대기의 한국어 라벨 */
const STATUS_LABEL: Record<string, string> = {
  needs_reverify: "needs_reverify · 재검증 대기",
};

/** 숫자 정렬 (core compareNodeIds 와 같은 규칙) */
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

export function RoundView({ sessionId }: { sessionId: string }) {
  // 선택된 revision (null = 최신)
  const [revision, setRevision] = useState<number | null>(null);
  const [live, setLive] = useState<"open" | "closed" | "error" | "connecting">(
    "connecting",
  );
  const [tree, setTree] = useState<TreeAtResponse | null>(null);
  const [rounds, setRounds] = useState<DecompositionRound[]>([]);
  const [liveRevision, setLiveRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [r, live] = await Promise.all([
        api.decompositionHistory(sessionId),
        api.tree(sessionId),
      ]);
      setRounds(r);
      setLiveRevision(live.nodes.revision);
      // "최신"도 같은 경로로 읽는다 (트리 모양이 한 벌로 같아야 한다).
      const target = revision === null ? live.nodes.revision : revision;
      setTree(await api.treeAt(sessionId, target));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  useEffect(() => {
    void reload();
    return subscribeEvents(sessionId, () => void reload(), setLive);
  }, [sessionId, revision]);

  const selected = useMemo<DecompositionRound | null>(() => {
    if (revision === null) return null;
    return rounds.find((r) => r.revision === revision) ?? null;
  }, [rounds, revision]);

  const nodes = tree?.nodes ?? [];
  const shownRevision = revision === null ? liveRevision : revision;

  return (
    <div className="round-view">
      <div className="live-line">
        <span className={`live-dot live-${live}`} aria-hidden="true" />
        <span>실시간: {live}</span>
        <span className="muted">
          {revision === null ? `최신 (rev${liveRevision})` : `rev${revision}`}
        </span>
        {tree?.structureOnly && (
          <span className="status status-needs_human">
            구조만 (상태 미상 구간 있음)
          </span>
        )}
      </div>
      {error && <p role="alert">오류: {error}</p>}
      <div className="round-panes">
        <aside className="pane pane-rounds" aria-label="분해 라운드">
          <h3>분해 라운드</h3>
          <RoundTimeline
            sessionId={sessionId}
            selectedRevision={revision}
            onSelect={setRevision}
          />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={revision === null}
            onClick={() => setRevision(null)}
          >
            최신으로
          </button>
        </aside>
        <section className="pane pane-tree" aria-label="시점 트리">
          <h3>트리 {revision === null ? "(최신)" : `(rev${revision})`}</h3>
          {picked && (
            <div className="node-detail-wrap">
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setPicked(null)}
              >
                ← 트리로
              </button>
              <NodeDetailPanel
                sessionId={sessionId}
                nodeId={picked}
                revision={shownRevision}
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
                  <th>자식</th>
                  <th>의존</th>
                </tr>
              </thead>
              <tbody>
                {[...nodes]
                  .sort((a, b) => compareNodeIds(a.id, b.id))
                  .map((n: HistoryNode) => (
                    <tr
                      key={n.id}
                      className={STATUS_CLASS[n.status ?? ""] ?? "st-other"}
                    >
                      <td>
                        <button
                          className="btn-id"
                          type="button"
                          onClick={() => setPicked(n.id)}
                        >
                          {n.id}
                        </button>
                      </td>
                      <td className="cell-goal">{n.goal ?? "(미상)"}</td>
                      <td>
                        {n.status === null ? (
                          <span className="muted">미상</span>
                        ) : (
                          <span
                            className={`status status-${n.status}`}
                            title={STATUS_LABEL[n.status] ?? n.status}
                          >
                            {STATUS_LABEL[n.status] ?? n.status}
                          </span>
                        )}
                      </td>
                      <td>{n.children.join(", ") || "-"}</td>
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
        </section>
        <aside className="pane pane-reason" aria-label="분해 사유">
          <ReasonPanel
            sessionId={sessionId}
            round={selected}
            onOpenNode={setPicked}
          />
        </aside>
      </div>
    </div>
  );
}
