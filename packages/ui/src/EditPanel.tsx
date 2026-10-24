import { useEffect, useState } from "react";
import { api, subscribeEvents, ApiError } from "./api.js";
import { JsonEditor, type ServerError } from "./JsonEditor.js";

// M7-ui4: 텍스트 편집(인자 JSON) + 의견 + stale 미리보기.
// 판단 if문 금지 — 표시 매핑만. 입력값은 textContent로만 렌더한다.

/**
 * M7-5-3: 서버 검증 메시지에 인자 이름이 있으면 그 줄에, 없으면 첫 줄에 진단을 단다.
 * (스키마 재구현이 아니라 **메시지 → 위치** 매핑일 뿐이다.)
 */
function serverErrorLines(argsText: string, message: string): ServerError[] {
  let keys: string[] = [];
  try {
    const obj = JSON.parse(argsText) as unknown;
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      keys = Object.keys(obj);
    }
  } catch {
    // 문법 오류는 CM6 jsonParseLinter 가 따로 표시한다
  }
  const lines = argsText.split("\n");
  for (const k of keys) {
    if (!message.includes(k)) continue;
    const line = lines.findIndex((l) => l.includes(`"${k}"`));
    if (line >= 0) return [{ message, from: line, to: line }];
  }
  return [{ message, from: 0, to: 0 }];
}

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
  // M7-5-3: 서버가 돌려준 오류만 CM6 에 매핑한다 (스키마 검증은 서버 몫)
  const [argErrors, setArgErrors] = useState<ServerError[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // M7-5-6-c: 초안 보존. 외부(MCP) 변경이 와도 dirty 인 동안에는 덮어쓰지 않고,
  // 저장 시 baseRevision 으로 409 를 받아 사용자가 다시 읽도록 한다 (데이터 유실 0).
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [baseGoal, setBaseGoal] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  // M7-5-6-d: 신호 실패 시 OpenCode 에 붙여넣을 문구(C 모드)
  const [signalCopy, setSignalCopy] = useState<string | null>(null);
  // M7-close-c: "최신 다시 읽기" 전에 초안을 보관/복사한다 (409로 유실 방지).
  const [preserved, setPreserved] = useState<string | null>(null);

  const preserveDraft = () => {
    const snapshot = `목표:\n${goalText}\n\n인자 JSON:\n${argsText}`;
    setPreserved(snapshot);
    try {
      void navigator.clipboard?.writeText(snapshot);
    } catch {
      // 클립보드 불가 환경: <pre> 로 보여주는 것으로 충분하다
    }
  };

  useEffect(() => {
    if (dirty) return; // 초안 유지
    let cancelled = false;
    void (async () => {
      try {
        const d = await api.nodeDetail(sessionId, nodeId);
        if (cancelled) return;
        setArgsText(JSON.stringify(d.detail.args, null, 2));
        setGoalText(d.detail.goal);
        setBaseGoal(d.detail.goal);
        setBaseRevision(d.detail.revision);
        setPreview(null);
        setArgErrors([]);
        setExternalChange(false);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, nodeId, revision, dirty]);

  useEffect(() => {
    if (dirty && revision !== baseRevision) setExternalChange(true);
  }, [dirty, revision, baseRevision]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    setConflict(false);
    setSaved(null);
    try {
      const r = await api.post(path, {
        sessionId,
        nodeId,
        expectedRevision: baseRevision,
        ...(body as Record<string, unknown>),
      } as Record<string, unknown>);
      setSaved(`${path} 저장됨`);
      setDirty(false);
      setExternalChange(false);
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
    setArgErrors([]);
    try {
      const change: Record<string, unknown> = {};
      try {
        change.patch = { set: JSON.parse(argsText) as Record<string, unknown> };
      } catch (e) {
        setError(`인자 JSON 오류: ${String(e)}`);
        return;
      }
      if (baseGoal !== null && goalText !== baseGoal) change.goal = goalText;
      const r = (await api.post(`/api/sessions/${sessionId}/preview-edit`, {
        nodeId,
        expectedRevision: baseRevision,
        change,
      })) as { wouldStale: string[]; newHash: string; errors?: ServerError[] };
      setPreview(r);
      // 서버가 준 오류만 위치에 매핑한다 (문법 오류는 CM6 jsonParseLinter 가 본다)
      setArgErrors(r.errors ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        // 서버가 준 검증 메시지를 CM6 진단으로 옮긴다 (스키마는 다시 구현하지 않는다)
        setArgErrors(serverErrorLines(argsText, e.message));
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
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
          <button type="button" onClick={preserveDraft}>
            초안 복사
          </button>
          <button
            type="button"
            onClick={() => {
              // 다시 읽기 전에 초안을 붙잡아 둔다 (유실 0)
              preserveDraft();
              setConflict(false);
              setError(null);
              setDirty(false);
              setExternalChange(false);
            }}
          >
            최신 다시 읽기
          </button>
        </div>
      )}
      {preserved && (
        <div>
          <p>초안(클립보드에 복사했습니다. 직접 복사하려면 아래를 쓰세요):</p>
          <pre aria-label="초안">{preserved}</pre>
        </div>
      )}
      {externalChange && !conflict && (
        <p role="alert">
          다른 곳에서 이 노드가 변경되었습니다. 저장하면 409가 납니다 (초안 유지).
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p>{saved}</p>}
      <label>
        목표
        <textarea
          value={goalText}
          onChange={(e) => {
            setGoalText(e.target.value);
            setDirty(true);
          }}
          rows={2}
        />
      </label>
      <label>
        인자 JSON (argSpecs)
        <JsonEditor
          value={argsText}
          onChange={(t) => {
            setArgsText(t);
            setDirty(true);
          }}
          serverErrors={argErrors}
          ariaLabel="인자 JSON"
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
          setSignalCopy(null);
          // M8-1 c: 의견 저장 전 미리보기 — 재검증으로 이어지고 확정 절차서에 들어 있으면 확인
          const pv = (await api.post(`/api/sessions/${sessionId}/preview-edit`, {
            nodeId,
            expectedRevision: baseRevision,
            change: { advice: adviceText },
          })) as { selfReverify?: boolean; procedure?: string } | null;
          if (pv?.selfReverify && pv.procedure) {
            const ok = window.confirm(
              `이 노드는 절차서 ${pv.procedure}에 포함됩니다. 재확정 전까지 무인 실행이 exit 1로 멈춥니다.`,
            );
            if (!ok) return;
          }
          const r = (await post(`/api/sessions/${sessionId}/advise-and-signal`, {
            text: adviceText,
          })) as { signal?: { delivered: boolean; degraded?: string; copyText?: string } } | null;
          if (r && r.signal && !r.signal.delivered) {
            setError(`저장은 끝났습니다. 신호 실패: ${r.signal.degraded ?? ""}`);
            setSignalCopy(r.signal.copyText ?? null);
          }
        }}
      >
        의견 등록 + 계속 신호
      </button>
      {signalCopy && (
        <div>
          <p>신호 대신 이 문구를 OpenCode에 붙여넣으세요.</p>
          <pre>{signalCopy}</pre>
        </div>
      )}
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