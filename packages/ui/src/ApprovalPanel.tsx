import { useEffect, useState } from "react";
import { api, ApiError, type ApprovalInfo } from "./api.js";
import { ReadOnlyCode } from "./JsonEditor.js";

// M7-5-2 / M7-5-4: 승인 화면.
// - 스크립트는 **읽기 전용** 뷰어로 (CM6: readOnly + editable(false)).
// - diff 는 CM6 merge 확장이 아니라 **서버 unified diff 문자열**을 <pre> 로만 보여준다
//   (React 기본 이스케이프 = textContent. 파싱·색칠 없음).
// - var/generated 인자는 키를 **명시 선택**해야 승인된다 (CLI --allow-wildcard 와 동일).

export function ApprovalPanel({
  sessionId,
  nodeId,
  onClose,
  onDone,
}: {
  sessionId: string;
  nodeId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [info, setInfo] = useState<ApprovalInfo | null>(null);
  const [revision, setRevision] = useState(0);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void (async () => {
      try {
        const [i, t] = await Promise.all([
          api.approvalInfo(sessionId, nodeId),
          api.tree(sessionId),
        ]);
        setInfo(i);
        setRevision(t.nodes.revision);
        setChecked(Object.fromEntries(i.wildcardKeys.map((k) => [k, false])));
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  };

  useEffect(load, [sessionId, nodeId]);

  const allChecked = info ? info.wildcardKeys.every((k) => checked[k]) : false;

  const submit = (approved: boolean) => {
    void (async () => {
      if (!info) return;
      setBusy(true);
      setError(null);
      try {
        await api.approve(sessionId, nodeId, {
          approvalHash: info.approvalHash,
          approved,
          expectedRevision: revision,
          ...(note.trim() !== "" ? { note } : {}),
          ...(approved && info.wildcardKeys.length > 0
            ? { allowWildcard: Object.keys(checked).filter((k) => checked[k]) }
            : {}),
        });
        onDone?.();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setError(`${e.message} — 다시 읽고 승인하세요.`);
          load();
        } else {
          setError(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  if (!info) {
    return (
      <section>
        <h4>승인 — 노드 {nodeId}</h4>
        <button type="button" onClick={onClose}>
          ← 닫기
        </button>
        {error ? <p role="alert">오류: {error}</p> : <p>승인 정보 불러오는 중…</p>}
      </section>
    );
  }

  return (
    <section>
      <h4>승인 — 노드 {nodeId}</h4>
      <button type="button" onClick={onClose}>
        ← 닫기
      </button>
      <p>
        approvalHash <code>{info.approvalHash.slice(0, 16)}…</code>
      </p>
      {info.approved && <p role="status">승인됨 (현재 값과 일치)</p>}
      {info.needsReapproval && (
        <p role="alert">값이 바뀌었습니다 — 승인 갱신 필요</p>
      )}
      {info.script && (
        <div>
          <p>
            스크립트 {info.script.rel} · sha256 {info.script.sha256.slice(0, 16)}…
          </p>
          <ReadOnlyCode text={info.script.content} ariaLabel="스크립트(읽기 전용)" />
        </div>
      )}
      {info.diff && (
        <div>
          <p>승인본 대비 변경 (서버 unified diff)</p>
          <pre>{info.diff}</pre>
        </div>
      )}
      {info.wildcardKeys.length > 0 && (
        <fieldset>
          <legend>와일드카드 키 선택 (명시해야 승인됩니다)</legend>
          {info.wildcardKeys.map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={checked[k] === true}
                disabled={busy || info.approved}
                onChange={(e) =>
                  setChecked((c) => ({ ...c, [k]: e.target.checked }))
                }
              />
              {k}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        메모
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <p role="alert">오류: {error}</p>}
      <button
        type="button"
        disabled={busy || info.approved || (info.wildcardKeys.length > 0 && !allChecked)}
        onClick={() => submit(true)}
      >
        승인
      </button>
      <button type="button" disabled={busy} onClick={() => submit(false)}>
        거부
      </button>
    </section>
  );
}