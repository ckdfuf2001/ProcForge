import { useEffect, useState } from "react";
import { api } from "./api.js";
import { laneOf, type LaneKey } from "./LaneStrip.js";

// M10-4: 단계별 레인 미니 표시. 가이드 단계의 실행 세션(event-log)에서
// lane.*만 골라 4레인 상태를 복원한다. 가이드 파일의 sessionId로 묶는다.

const LANES: { key: LaneKey; label: string }[] = [
  { key: "analysis", label: "분석" },
  { key: "redraft", label: "재분석" },
  { key: "execute", label: "실행" },
  { key: "verify", label: "검증" },
];

type Mini = { active: boolean; nodeIds: string[]; seen: boolean };

const EMPTY: Mini = { active: false, nodeIds: [], seen: false };

export function StepLanes({ sessionId }: { sessionId: string }) {
  const [lanes, setLanes] = useState<Record<LaneKey, Mini>>({
    analysis: { ...EMPTY },
    redraft: { ...EMPTY },
    execute: { ...EMPTY },
    verify: { ...EMPTY },
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const log = await api.eventLog(sessionId, { limit: 200, tail: true });
        if (cancelled) return;
        const next: Record<LaneKey, Mini> = {
          analysis: { ...EMPTY },
          redraft: { ...EMPTY },
          execute: { ...EMPTY },
          verify: { ...EMPTY },
        };
        for (const e of log.events) {
          if (e.method !== "lane.started" && e.method !== "lane.finished") continue;
          const key = laneOf(e.summary);
          if (key === null) continue;
          next[key] = {
            active: e.method === "lane.started",
            nodeIds: e.method === "lane.started" ? [...e.nodeIds] : [],
            seen: true,
          };
        }
        setLanes(next);
      } catch {
        // 이력 실패는 조용히 둔다 (다음 폴링에서 복회)
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  return (
    <span className="step-lanes" aria-label="단계 레인">
      {LANES.map((l) => {
        const st = lanes[l.key];
        return (
          <span key={l.key} className={`step-lane step-lane-${l.key}${st.active ? " step-lane-active" : ""}`}>
            {l.label}:{st.seen ? (st.active ? "진행 중" : "종료됨") : "없음"}
            {st.nodeIds.length > 0 ? `(${st.nodeIds.join(",")})` : ""}
          </span>
        );
      })}
    </span>
  );
}
