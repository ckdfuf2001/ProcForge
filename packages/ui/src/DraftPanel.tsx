import { useEffect, useState } from "react";
import { api, type DraftDetail } from "./api.js";

// M10-3-ui: 재분석 diff 패널. draftId 입력 → 조회 →
// op별 before/after + reason, accept(적용)/reject(폐기) 버튼.
// M10-entry: initialDraftId가 오면(재분석 요청 완료) 자동으로 불러온다.

export function DraftPanel({ initialDraftId }: { initialDraftId?: string }) {
  const [draftId, setDraftId] = useState(initialDraftId ?? "");
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (id: string) => {
    setError(null);
    setResult(null);
    void (async () => {
      try {
        const d = await api.getDraft(id.trim());
        setDraft(d);
        setChecked(d.ops.map((_, i) => i));
      } catch (e) {
        setDraft(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  useEffect(() => {
    if (initialDraftId) load(initialDraftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraftId]);

  const toggle = (i: number) => {
    setChecked((prev) =>
      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b),
    );
  };

  const apply = () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const r = await api.applyDraft(draft.draftId, checked);
        const changed = r.changedNodes.join(", ") || "없음";
        const reset = r.approvalReset.length > 0
          ? ` 다음 실행 때 승인 필요: ${r.approvalReset.join(", ")}`
          : "";
        setResult(`적용됨: ${r.applied.map((a) => `${a.nodeId}(${a.kind})`).join(", ") || "없음"} · 바뀐 노드: ${changed}.${reset}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const reject = () => {
    setDraft(null);
    setChecked([]);
    setResult("폐기됨 (서버 변경 없음)");
  };

  return (
    <section className="side-panel" aria-label="재분석 diff">
      <h4>재분석 diff</h4>
      <input
        type="text"
        value={draftId}
        onChange={(e) => setDraftId(e.target.value)}
        placeholder="draftId"
        aria-label="draftId"
      />
      <div>
        <button className="btn" type="button" onClick={() => load(draftId)}>
          초안 불러오기
        </button>
      </div>
      {error && <p role="alert">오류: {error}</p>}
      {draft && (
        <div>
          <p className="muted">
            {draft.procedure} · {draft.status} · {draft.ops.length}건
          </p>
          <p>{draft.reason}</p>
          <ul className="diff-list">
            {draft.ops.map((op, i) => (
              <li key={i}>
                <input
                  type="checkbox"
                  checked={checked.includes(i)}
                  onChange={() => toggle(i)}
                  aria-label={`op ${i} 선택`}
                />
                <code>{op.op}</code>
                <code>{op.nodeId}</code>
                <span>{String(op.reason ?? op.goal ?? "")}</span>
              </li>
            ))}
          </ul>
          <div>
            <button className="btn" type="button" onClick={apply} disabled={busy || checked.length === 0}>
              적용
            </button>{" "}
            <button className="btn btn-ghost" type="button" onClick={reject}>
              폐기
            </button>
          </div>
        </div>
      )}
      {result && <p role="status">{result}</p>}
    </section>
  );
}
