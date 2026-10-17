import { useEffect, useState } from "react";
import { api, subscribeEvents, ApiError } from "./api.js";

// M7-ui4: 텍스트 편집(인자 JSON) + 의견 + stale 미리보기.
// 판단 if문 금지 — 표시 매핑만. 입력값은 textContent로만 렌더한다.

export function EditPanel({
  sessionId,
  nodeId,
  revision,
}: {
  sessionId: string;
  nodeId: string;
  revision: number;
}) {
  const [argsText, setArgsText] = useState("");
  const [goalText, setGoalText] = useState("");
  const [adviceText, setAdviceText] = useState("");
  const [preview, setPreview] = useState<{ wouldStale: string[]; newHash: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.nodeDetail(sessionId, nodeId);
        setArgsText(JSON.stringify(d.detail.args, null, 2));
        setGoalText(d.detail.goal);
        setPreview(null);
        setSaved(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, [sessionId, nodeId, revision]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const r = await api.post(path, {
        sessionId,
        nodeId,
        expectedRevision: revision,
        ...(body as Record<string, unknown>),
      } as Record<string, unknown>);
      setSaved(`${path} 저장됨`);
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 자동 재시도 금지 — 초안은 유지하고 최신 다시 읽기를 제안한다.
        setConflict(true);
        setError("다른 곳에서 변경됨 (409). 초안은 그대로입니다.");
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      let change: Record<string, unknown> = {};
      try {
        change = { patch: { set: JSON.parse(argsText) as Record<string, unknown> } };
      } catch (e) {
        setError(`인자 JSON 오류: ${String(e)}`);
        return;
      }
      if (goalText.trim() !== "") change = { goal: goalText };
      const r = (await api.post(`/api/sessions/${sessionId}/preview-edit`, {
        nodeId,
        expectedRevision: revision,
        change,
      })) as { wouldStale: string[]; newHash: string };
      setPreview(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h4>편집</h4>
      {conflict && (
        <div role="alert">
          <p>다른 곳에서 변경되었습니다. 초안은 유지했습니다.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
          >
            최신 다시 읽기
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p>{saved}</p>}
      <label>
        목표
        <textarea
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          rows={2}
        />
      </label>
      <label>
        인자 JSON (argSpecs)
        <textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          rows={8}
        />
      </label>
      <button type="button" disabled={busy} onClick={runPreview}>
        stale 미리보기
      </button>
      {preview && (
        <p>
          이 변경으로 다시 실행될 노드 {preview.wouldStale.length}개:{" "}
          {preview.wouldStale.join(", ") || "(없음)"}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void post(`/api/sessions/${sessionId}/edit-node`, { goal: goalText })
        }
      >
        목표 저장
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          let patch: Record<string, unknown> = {};
          try {
            patch = { set: JSON.parse(argsText) as Record<string, unknown> };
          } catch {
            setError("인자 JSON 오류");
            return;
          }
          void post(`/api/sessions/${sessionId}/edit-args`, { patch });
        }}
      >
        인자 저장
      </button>
      <h4>의견</h4>
      <label>
        사람 조언
        <textarea
          value={adviceText}
          onChange={(e) => setAdviceText(e.target.value)}
          rows={3}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          const r = (await post(`/api/sessions/${sessionId}/advise-and-signal`, {
            text: adviceText,
          })) as { signal?: { delivered: boolean; degraded?: string; copyText?: string } } | null;
          if (r && r.signal && !r.signal.delivered) {
            setError(`저장은 끝났습니다. 신호 실패: ${r.signal.degraded ?? ""}`);
          }
        }}
      >
        의견 등록 + 계속 신호
      </button>
      <small>SSE 갱신: {revision}</small>
    </section>
  );
}

export function useTreeSubscription(
  sessionId: string,
  onChange: () => void,
): "connecting" | "open" | "closed" | "error" {
  const [live, setLive] = useState<"connecting" | "open" | "closed" | "error">(
    "connecting",
  );
  useEffect(() => {
    const stop = subscribeEvents(sessionId, () => onChange(), setLive);
    return stop;
  }, [sessionId, onChange]);
  return live;
}