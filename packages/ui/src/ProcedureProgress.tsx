import { useEffect, useState } from "react";
import { api, ApiError, type ProcedureProgress } from "./api.js";

// M11-1: 절차서별 실행 결과 기반 진행률 (읽기 전용).
// 기존 RemainingList는 바꾸지 않는다 (현재 세션 트리 표시 그대로).

export function ProcedureProgressList() {
  const [rows, setRows] = useState<ProcedureProgress[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows(await api.procedureProgress());
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, []);

  if (error) return <p role="alert">오류: {error}</p>;
  if (!rows) return <p>진행률 불러오는 중…</p>;
  if (rows.length === 0) return <p className="muted">등록된 절차서가 없습니다.</p>;

  return (
    <section className="panel" aria-label="절차서별 진행률">
      <h4>절차서별 진행률</h4>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            <code>{r.name}</code>{" "}
            {r.progress === null ? (
              <span className="muted">실행 기록 없음</span>
            ) : (
              <span>
                {r.done}/{r.leaves} ({Math.round(r.progress * 100)}%)
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}