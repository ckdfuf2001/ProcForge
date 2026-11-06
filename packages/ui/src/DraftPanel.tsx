import { useState } from "react";
import { api, type DraftDetail } from "./api.js";

// M10-3-ui: 재분석 diff 패널. draftId 입력 → 조회 →
// op별 before/after + reason, accept(적용)/reject(폐기) 버튼.
// 적용은 선택한 op 인덱스 배열로 POST한다. 폐기는 화면에서만 지운다.

export function DraftPanel() {
  const [draftId, setDraftId] = useState("");
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    setResult(null);
    void (async () => {
      try {
        const d = await api.getDraft(draftId.trim());
        setDraft(d);
        setChecked(d.ops.map((_, i) => i));
      } catch (e) {
        setDraft(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

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
        setResult(`적용됨: ${r.applied.map((a) => `${a.nodeId}(${a.kind})`).join(", ") || "없음"}`);
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
        <button className="btn" type="button" onClick={load}>
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
