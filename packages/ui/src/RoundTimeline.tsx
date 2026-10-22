import { useEffect, useState } from "react";
import { api, type DecompositionRound } from "./api.js";

// M8-ui3: 분해 라운드 타임라인 (왼쪽 칸).
// 표시만 한다 — 판단 if문 금지. 라운드 선택은 부모(RoundView)가 관리한다.

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function RoundTimeline({
  sessionId,
  selectedRevision,
  onSelect,
}: {
  sessionId: string;
  /** 선택된 revision (null = 최신) */
  selectedRevision: number | null;
  onSelect: (revision: number | null) => void;
}) {
  const [rounds, setRounds] = useState<DecompositionRound[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.decompositionHistory(sessionId);
        if (alive) setRounds(r);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (error) return <p role="alert">오류: {error}</p>;
  if (!rounds) return <p className="muted">분해 이력 불러오는 중…</p>;

  return (
    <div className="round-timeline">
      <ol className="round-list">
        {rounds.map((r) => {
          const picked = selectedRevision === r.revision;
          return (
            <li key={`${r.revision}-${r.parentId}`}>
              <button
                type="button"
                className={`round-item${picked ? " is-picked" : ""}`}
                aria-pressed={picked}
                onClick={() => onSelect(picked ? null : r.revision)}
                title={`rev${r.revision} · ${r.actor} · ${formatTime(r.at)}`}
              >
                <span className="round-rev">rev{r.revision}</span>
                <span className="round-depth">깊이 {r.depth}</span>
                <span className="round-parent">{r.parentId}</span>
                <span className="round-reason">
                  {r.reason ?? "(사유 기록 없음 — 구 세션)"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {rounds.length === 0 && (
        <p className="muted">아직 분해 이력이 없습니다.</p>
      )}
    </div>
  );
}
