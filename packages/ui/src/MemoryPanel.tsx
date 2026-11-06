import { useState } from "react";
import { api, type SimilarProcedure } from "./api.js";

// M10-3-ui: 불러온 메모리 패널. similarProcedures 상위 N건
// (이름·최종 실행 상태·metrics 요약). 클릭하면 해당 절차서를 불러와
// 목표 목록을 보여준다. sessionId가 있으면 memory.loaded 알림이 남는다.

export function MemoryPanel({ sessionId }: { sessionId: string }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SimilarProcedure[] | null>(null);
  const [picked, setPicked] = useState<SimilarProcedure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const r = await api.similar(query, 10, sessionId);
        setRows(r.procedures);
        setPicked(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section className="side-panel" aria-label="불러온 메모리">
      <h4>불러온 메모리</h4>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="분석 검색"
        aria-label="분석 검색"
      />
      <div>
        <button className="btn" type="button" onClick={search} disabled={busy}>
          메모리 불러오기
        </button>
      </div>
      {error && <p role="alert">오류: {error}</p>}
      {rows && rows.length === 0 && <p className="muted">일치하는 분석 없음.</p>}
      {rows && rows.length > 0 && (
        <ul>
          {rows.map((p) => (
            <li key={p.name}>
              <button className="btn-id" type="button" onClick={() => setPicked(p)}>
                {p.name}
              </button>{" "}
              <span className="muted">
                {p.latest ? `${p.latest.status} ${p.latest.runId.slice(0, 8)}` : "실행 없음"}
                {p.metrics ? ` · 파일 ${p.metrics.files} · 행 ${p.metrics.rows}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <div>
          <h5>{picked.name} 목표</h5>
          <ul>
            {picked.goals.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
      {rows === null && !error && (
        <p className="muted">메모리 로드 전 (버튼을 눌러 불러온다).</p>
      )}
    </section>
  );
}
