import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

// M10-3-ui: 노드 상세 "왜" 읽기 + 수정 (POST why, 1~500자 규칙은 서버).
// 409(expectedRevision 충돌)는 다시 읽기로 안내한다.

export function WhyPanel({
  sessionId,
  nodeId,
  revision,
}: {
  sessionId: string;
  nodeId: string;
  revision: number;
}) {
  const [why, setWhy] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(false);
    setConflict(false);
    setError(null);
    void (async () => {
      try {
        const r = await api.nodeDetail(sessionId, nodeId);
        if (cancelled) return;
        setWhy(r.detail.why);
        setText(r.detail.why ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, nodeId, revision]);

  if (error) return <p role="alert">오류: {error}</p>;

  const save = () => {
    setBusy(true);
    setSaved(false);
    setConflict(false);
    setError(null);
    void (async () => {
      try {
        await api.postWhy(sessionId, nodeId, { why: text, expectedRevision: revision });
        setWhy(text);
        setSaved(true);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConflict(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section aria-label="왜">
      <h4>왜</h4>
      <p>{why ?? "(없음)"}</p>
      <label htmlFor={`why-${nodeId}`}>왜 수정</label>
      <textarea
        id={`why-${nodeId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={500}
      />
      <div>
        <button className="btn" type="button" onClick={save} disabled={busy}>
          왜 저장
        </button>
        {saved && <span role="status"> 저장됨</span>}
        {conflict && (
          <span role="alert"> 충돌: 다른 변경이 먼저 들어왔다. 트리를 다시 읽어라.</span>
        )}
      </div>
    </section>
  );
}
