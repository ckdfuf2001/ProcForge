import { useCallback, useEffect, useState } from "react";
import { api, subscribeEvents, ApiError, type NodeRow } from "./api.js";
import { ProgressBar } from "./ProgressBar.js";
import { LaneStrip } from "./LaneStrip.js";
import { GraphView } from "./GraphView.js";
import { RemainingList } from "./RemainingList.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { DraftPanel } from "./DraftPanel.js";
import { GuideRunner } from "./GuideRunner.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";

// M10-3-ui: M10 확인 화면 (진행률·레인·그래프·노드상세·오른쪽패널).
// 기존 rounds/tree 탭은 그대로 둔다. 데이터는 tree + 세션 events(SSE)만 쓴다.

export function GuideView({ sessionId }: { sessionId: string }) {
  const [nodes, setNodes] = useState<NodeRow[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [needsHuman, setNeedsHuman] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"open" | "closed" | "error" | "connecting">(
    "connecting",
  );

  const reload = useCallback(() => {
    void (async () => {
      try {
        const t = await api.tree(sessionId);
        setNodes(t.nodes.nodes);
        setRevision(t.nodes.revision);
        setNeedsHuman(t.blocked.needsHuman);
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    setNodes(null);
    setPicked(null);
    reload();
    return subscribeEvents(sessionId, () => reload(), setLive);
  }, [sessionId, reload]);

  if (error) return <p role="alert">오류: {error}</p>;
  if (!nodes) return <p>확인 화면 불러오는 중…</p>;

  return (
    <div className="guide-view">
      <div className="live-line">
        <span className={`live-dot live-${live}`} aria-hidden="true" />
        <span>실시간: {live}</span>
        <span className="muted">revision {revision}</span>
      </div>
      <h3>진행률</h3>
      <ProgressBar nodes={nodes} />
      <h3>에이전트 레인</h3>
      <LaneStrip sessionId={sessionId} />
      <h3>노드 그래프</h3>
      <GraphView nodes={nodes} onPick={setPicked} />
      <div className="side-panels">
        <MemoryPanel sessionId={sessionId} />
        <DraftPanel />
      </div>
      <GuideRunner />
      <RemainingList nodes={nodes} needsHuman={needsHuman} />
      {picked && (
        <div className="node-detail-wrap">
          <button className="btn btn-ghost" type="button" onClick={() => setPicked(null)}>
            ← 그래프로
          </button>
          <NodeDetailPanel
            sessionId={sessionId}
            nodeId={picked}
            revision={revision}
          />
        </div>
      )}
    </div>
  );
}
