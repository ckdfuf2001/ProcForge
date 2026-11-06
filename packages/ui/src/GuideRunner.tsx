import { useEffect, useState } from "react";
import { api, ApiError, type GuideDetail, type ProcedureRow } from "./api.js";
import { StepLanes } from "./StepLanes.js";

// M10-4: 순차 자동 실행 가이드 조작부.
// 사람이 단계를 쌓고 "확인 후 실행"을 누르면 다음 단계가 uiRun 계열로 돈다.
// guides/<id>.json이 진실이므로 새로고침해도 이어간다.

export function GuideRunner() {
  const [procedures, setProcedures] = useState<ProcedureRow[] | null>(null);
  const [procName, setProcName] = useState("");
  const [steps, setSteps] = useState<{ procedure: string; params: Record<string, string> }[]>([]);
  const [guide, setGuide] = useState<GuideDetail | null>(null);
  const [guideIdInput, setGuideIdInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.procedures();
        setProcedures(r.procedures);
        if (r.procedures.length > 0) setProcName((p) => p || r.procedures[0].name);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const refresh = async (id: string) => {
    const g = await api.guideStatus(id);
    setGuide(g);
  };

  const start = async () => {
    if (steps.length === 0) {
      setError("단계를 1개 이상 쌓아라");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const g = await api.startGuide(steps);
      setGuide(g);
      setSteps([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    const id = guideIdInput.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await refresh(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const advance = async (stepIndex?: number) => {
    if (!guide) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.advanceGuide(guide.guideId, {
        ...(stepIndex !== undefined ? { stepIndex } : {}),
      });
      await refresh(r.guideId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        await refresh(guide.guideId);
      } catch {
        // 상태 재조회 실패는 무시 (위 오류가 우선)
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (stepIndex?: number) => {
    if (!guide) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.cancelGuideStep(guide.guideId, {
        ...(stepIndex !== undefined ? { stepIndex } : {}),
      });
      await refresh(r.guideId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const nextPending = guide
    ? guide.state.findIndex((s) => s.status !== "done")
    : -1;

  return (
    <section className="side-panel" aria-label="순차 자동 실행">
      <h4>순차 자동 실행</h4>
      {error && <p role="alert">오류: {error}</p>}
      {!guide && (
        <div>
          <label>
            절차서
            <select value={procName} onChange={(e) => setProcName(e.target.value)}>
              {(procedures ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                if (procName) setSteps((s) => [...s, { procedure: procName, params: {} }]);
              }}
            >
              단계 추가
            </button>
          </div>
          {steps.length > 0 && (
            <ol>
              {steps.map((s, i) => (
                <li key={i}>
                  {i + 1}. {s.procedure}{" "}
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                  >
                    빼기
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div>
            <button className="btn" type="button" onClick={() => void start()} disabled={busy}>
              가이드 시작
            </button>
          </div>
          <div>
            <label>
              가이드 id로 열기
              <input
                type="text"
                value={guideIdInput}
                onChange={(e) => setGuideIdInput(e.target.value)}
                placeholder="guideId"
              />
            </label>
            <button className="btn btn-ghost" type="button" onClick={() => void open()} disabled={busy}>
              열기
            </button>
          </div>
        </div>
      )}
      {guide && (
        <div>
          <p className="muted">id: {guide.guideId}</p>
          <ol>
            {guide.steps.map((s, i) => {
              const st = guide.state[i];
              return (
              <li key={i}>
                {i + 1}. {s.procedure} · {st.status}
                {st.runId ? ` · run ${st.runId.slice(0, 8)}` : ""}
                {st.sessionId ? <StepLanes sessionId={st.sessionId} /> : null}
                  {i === nextPending && (st.status === "pending" || st.status === "waiting" || st.status === "failed" || st.status === "cancelled") && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void advance(i)}
                      disabled={busy}
                    >
                      확인 후 실행
                    </button>
                  )}
                  {(st.status === "running" || st.status === "waiting") && st.runId && (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => void cancel(i)}
                      disabled={busy}
                    >
                      취소
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setGuide(null);
              setGuideIdInput("");
            }}
          >
            닫기
          </button>
        </div>
      )}
    </section>
  );
}
