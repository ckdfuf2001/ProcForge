import { useEffect, useState } from "react";
import { api, subscribeEvents } from "./api.js";

// M10-3-ui: 에이전트 레인 4개 (가로 swimlane).
// lane.started/finished 세션 이벤트로 구동한다. summary에서 레인 키를 찾고
// (analysis/redraft/execute/verify 또는 한국어 라벨), nodeIds를 칩으로 올린다.
// M10-4에서 실측정 송출을 연결하기 전에는 전부 idle + 안내 문구를 둔다.

const LANES = [
  { key: "analysis", label: "분석" },
  { key: "redraft", label: "재분석" },
  { key: "execute", label: "실행" },
  { key: "verify", label: "검증" },
] as const;

type LaneKey = (typeof LANES)[number]["key"];

export type { LaneKey };

type LaneState = {
  active: boolean;
  nodeIds: string[];
};

const EMPTY: LaneState = { active: false, nodeIds: [] };

/** summary → 레인 키 (영문 키 또는 한국어 라벨, 없으면 null) */
export function laneOf(summary: string): LaneKey | null {
  const s = summary.toLowerCase();
  if (s.includes("redraft") || s.includes("재분석")) return "redraft";
  if (s.includes("execute") || s.includes("실행")) return "execute";
  if (s.includes("verify") || s.includes("검증")) return "verify";
  if (s.includes("analysis") || s.includes("분석")) return "analysis";
  return null;
}

type LaneEvent = { method: string; summary: string; nodeIds: string[] };

/** lane.started/finished 1건을 상태에 반영한다 (이력·실시간 공통). */
function applyLaneEvent(
  prev: Record<LaneKey, LaneState>,
  e: LaneEvent,
): { next: Record<LaneKey, LaneState>; touched: boolean } {
  if (e.method !== "lane.started" && e.method !== "lane.finished") {
    return { next: prev, touched: false };
  }
  const starting = e.method === "lane.started";
  const key = laneOf(e.summary);
  const next: Record<LaneKey, LaneState> = {
    analysis: { ...prev.analysis },
    redraft: { ...prev.redraft },
    execute: { ...prev.execute },
    verify: { ...prev.verify },
  };
  if (key !== null) {
    next[key] = starting ? { active: true, nodeIds: [...e.nodeIds] } : { ...EMPTY };
  } else {
    // 키 불명: 칩이 겹치는 레인을 시작/종료한다.
    for (const k of Object.keys(next) as LaneKey[]) {
      const overlap =
        e.nodeIds.length === 0 ||
        next[k].nodeIds.some((id) => e.nodeIds.includes(id));
      if (overlap) {
        next[k] = starting ? { active: true, nodeIds: [...e.nodeIds] } : { ...EMPTY };
      }
    }
  }
  return { next, touched: true };
}

export function LaneStrip({ sessionId }: { sessionId: string }) {
  const [lanes, setLanes] = useState<Record<LaneKey, LaneState>>({
    analysis: { ...EMPTY },
    redraft: { ...EMPTY },
    execute: { ...EMPTY },
    verify: { ...EMPTY },
  });
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    setSeen(false);
    setLanes({
      analysis: { ...EMPTY },
      redraft: { ...EMPTY },
      execute: { ...EMPTY },
      verify: { ...EMPTY },
    });
    let cancelled = false;
    // 과거 lane 이벤트로 초기 상태를 복원한다 (새로고침 대응).
    void (async () => {
      try {
        const log = await api.eventLog(sessionId, { limit: 200, tail: true });
        if (cancelled) return;
        setLanes((prev) => {
          let next = prev;
          let touched = false;
          for (const e of log.events) {
            const r = applyLaneEvent(next, e);
            next = r.next;
            touched = touched || r.touched;
          }
          if (touched) setSeen(true);
          return next;
        });
      } catch {
        // 이력 실패는 실시간 구독으로 메운다 (화면을 막지 않는다).
      }
    })();
    const stop = subscribeEvents(sessionId, (e) => {
      setLanes((prev) => {
        const r = applyLaneEvent(prev, e);
        if (r.touched) setSeen(true);
        return r.next;
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [sessionId]);

  return (
    <section className="lane-strip" aria-label="에이전트 레인">
      {LANES.map((l) => {
        const st = lanes[l.key];
        return (
          <div
            key={l.key}
            className={`lane lane-${l.key}${st.active ? " lane-active" : ""}`}
          >
            <div className="lane-head">
              <strong>{l.label}</strong>
              <span className="muted">{st.active ? "진행 중" : "대기"}</span>
            </div>
            {st.nodeIds.length > 0 ? (
              <ul className="lane-chips">
                {st.nodeIds.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {seen ? "종료됨" : "레인 이벤트 없음 (M10-4에서 실측정 송출)"}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
