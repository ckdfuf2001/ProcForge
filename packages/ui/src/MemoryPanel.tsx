import { useState } from "react";
import { api, type SimilarProcedure } from "./api.js";

// M10-3-ui: 불러온 메모리 패널. similarProcedures 상위 N건
// (이름·최종 실행 상태·metrics 요약). 클릭하면 해당 절차서를 불러와
// 목표 목록을 보여준다. sessionId가 있으면 memory.loaded 알림이 남는다.
// M10-entry: 고른 절차서 + 요청문으로 재분석을 요청한다 (202 즉시 반환,
// 대기 → 준비됨/실패 표시, 준비되면 diff 패널로 넘긴다).

export function MemoryPanel({
  sessionId,
  onDraftReady,
}: {
  sessionId: string;
  onDraftReady: (draftId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SimilarProcedure[] | null>(null);
  const [picked, setPicked] = useState<SimilarProcedure | null>(null);
  const [requestText, setRequestText] = useState("");
  const [redraftState, setRedraftState] = useState<
    | { kind: "idle" }
    | { kind: "waiting"; draftId: string }
    | { kind: "ready"; draftId: string }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
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
        setRedraftState({ kind: "idle" });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const requestRedraft = () => {
    if (!picked) return;
    const req = requestText.trim();
    if (req.length === 0) {
      setError("재분석 요청문을 입력하라");
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // M10-entry-fix: sessionId를 함께 보내 draft.ready 알림이 남게 한다.
        const r = await api.requestRedraft(picked.name, req, sessionId);
        setRedraftState({ kind: "waiting", draftId: r.draftId });
        // 준비될 때까지 폴링 (대기 → 준비됨/실패).
        for (let i = 0; i < 150; i++) {
          await new Promise((rr) => setTimeout(rr, 2000));
          const d = await api.getDraft(r.draftId);
          if (d.status === "ready") {
            setRedraftState({ kind: "ready", draftId: r.draftId });
            onDraftReady(r.draftId);
            break;
          }
          if (d.status === "failed" || d.status === "rejected") {
            setRedraftState({
              kind: "failed",
              message: `실패: ${d.reason || d.status}`,
            });
            break;
          }
        }
      } catch (e) {
        setRedraftState({
          kind: "failed",
          message: e instanceof Error ? e.message : String(e),
        });
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
          <label>
            재분석 요청문
            <textarea
              value={requestText}
              onChange={(e) => setRequestText(e.target.value)}
              rows={2}
              aria-label="재분석 요청문"
            />
          </label>
          <div>
            <button className="btn" type="button" onClick={requestRedraft} disabled={busy}>
              재분석 요청
            </button>
          </div>
          {redraftState.kind === "waiting" && (
            <p role="status">초안 대기 중: {redraftState.draftId}</p>
          )}
          {redraftState.kind === "ready" && (
            <p role="status">초안 준비됨: {redraftState.draftId} (diff 패널에 표시됨)</p>
          )}
          {redraftState.kind === "failed" && (
            <p role="alert">{redraftState.message}</p>
          )}
        </div>
      )}
      {rows === null && !error && (
        <p className="muted">메모리 로드 전 (버튼을 눌러 불러온다).</p>
      )}
    </section>
  );
}
