import { useEffect, useState } from "react";
import {
  api,
  subscribeRunLog,
  ApiError,
  type ProcedureRow,
  type RunInfo,
  type RunLogEntry,
} from "./api.js";
import { compareNodeIds } from "./TreeView.js";
import { ApprovalPanel } from "./ApprovalPanel.js";

// M7-5-4: 실행 화면.
// - 절차서 목록 → params 입력(required/default, @today:utc 안내) → 실행.
// - 노드별 상태는 **run-state 가 준 status 문자열 그대로** 표시한다 (UI 해석 금지).
// - 실패 노드는 상세로 이동, 승인 대기는 승인 화면으로, 거부·취소 뒤 재실행 활성.

const RUNNING = new Set(["ready", "running", "suspended", "cancelling"]);
const RESULT_CLASS: Record<string, string> = {
  pass: "st-leaf",
  fail: "st-failed",
  blocked: "st-needs-human",
  unverified: "st-probing",
  suspended: "st-split",
  skipped: "st-open",
};

export function RunPanel({
  onOpenNode,
}: {
  onOpenNode: (sessionId: string, nodeId: string) => void;
}) {
  const [procedures, setProcedures] = useState<ProcedureRow[] | null>(null);
  const [procName, setProcName] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [log, setLog] = useState<RunLogEntry[]>([]);
  const [live, setLive] = useState<"open" | "closed" | "error" | "connecting">(
    "connecting",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{
    sessionId: string;
    nodeId: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.procedures();
        setProcedures(r.procedures);
        if (r.procedures.length > 0) setProcName((p) => p || r.procedures[0].name);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, []);

  const selected = procedures?.find((p) => p.name === procName) ?? null;

  // 절차서가 바뀌면 param 기본값 + 최근 실행 복원
  useEffect(() => {
    if (procName === "") return;
    const p = procedures?.find((x) => x.name === procName) ?? null;
    if (p) {
      setParamValues(Object.fromEntries(p.params.map((q) => [q.name, q.default ?? ""])));
    }
    void (async () => {
      try {
        const { runId: id } = await api.latestRun(procName);
        if (id) {
          setRunId(id);
          setInfo(await api.runInfo(id));
        } else {
          setRunId(null);
          setInfo(null);
          setLog([]);
        }
      } catch {
        // 복원 실패는 조용히 무시 (새 실행은 가능)
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procName, procedures]);

  useEffect(() => {
    if (!runId) return;
    const refresh = () => {
      void (async () => {
        try {
          setInfo(await api.runInfo(runId));
        } catch {
          // 폴링 실패는 다음 이벤트에서 만회
        }
      })();
    };
    const off = subscribeRunLog(
      runId,
      (e) => {
        setLog((l) => [...l, e].slice(-200));
        refresh();
      },
      () => {
        setLive("closed");
        refresh();
      },
      setLive,
    );
    return off;
  }, [runId]);

  const start = () => {
    void (async () => {
      if (!selected) return;
      setBusy(true);
      setError(null);
      try {
        const started = await api.runStart(selected.name, paramValues);
        setLog([]);
        setRunId(started.runId);
        setInfo(await api.runInfo(started.runId));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const cancel = () => {
    void (async () => {
      if (!runId) return;
      setBusy(true);
      try {
        await api.runCancel(runId);
        setInfo(await api.runInfo(runId));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (error && !procedures) return <p role="alert">오류: {error}</p>;
  if (!procedures) return <p>절차서 불러오는 중…</p>;

  const status = info?.status ?? "";
  const running = RUNNING.has(status);
  const finished = status === "done" || status === "failed" || status === "cancelled";
  const results = [...(info?.results ?? [])].sort((a, b) =>
    compareNodeIds(a.nodeId, b.nodeId),
  );

  return (
    <section className="panel run-panel">
      <h2>실행</h2>
      <label>
        절차서
        <select value={procName} onChange={(e) => setProcName(e.target.value)}>
          {procedures.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {procedures.length === 0 && <p>등록된 절차서가 없습니다.</p>}

      {selected && selected.params.length > 0 && (
        <fieldset>
          <legend>
            params (필수는 *, 날짜는 <code>@today:utc</code>·<code>@today:local</code> 지원)
          </legend>
          {selected.params.map((p) => (
            <label key={p.name}>
              {p.name}
              {p.required ? " *" : ""}
              <input
                value={paramValues[p.name] ?? ""}
                disabled={running}
                onChange={(e) =>
                  setParamValues((v) => ({ ...v, [p.name]: e.target.value }))
                }
              />
              <small>
                {p.description}
                {p.default !== undefined ? ` (기본 ${p.default})` : ""}
                {p.type !== "" ? ` · ${p.type}` : ""}
              </small>
            </label>
          ))}
        </fieldset>
      )}

      <div>
        <button type="button" disabled={busy || running || !selected} onClick={start}>
          실행
        </button>
        {info && running && (
          <button type="button" disabled={busy} onClick={cancel}>
            취소
          </button>
        )}
        {info && finished && (
          <button type="button" disabled={busy || !selected} onClick={start}>
            재실행
          </button>
        )}
      </div>

      {error && <p role="alert">오류: {error}</p>}

      {info && (
        <div>
          <p>
            run {info.runId.slice(0, 8)} · 절차서 {info.procedure} · 상태 {info.status} ·
            진행 {live}
          </p>
          {info.summary && (
            <p>
              pass {info.summary.pass} / fail {info.summary.fail} / unverified{" "}
              {info.summary.unverified} / skipped {info.summary.skipped} / blocked{" "}
              {info.summary.blocked} / suspended {info.summary.suspended}
              {info.summary.needsReverify !== undefined && info.summary.needsReverify > 0 && (
                <>
                  {" "}
                  / <strong>needs_reverify {info.summary.needsReverify}</strong>
                </>
              )}
            </p>
          )}

          {info.failedNodeId && (
            <div role="alert">
              <p>실패 노드 {info.failedNodeId}</p>
              <pre>{info.failedDetail ?? ""}</pre>
              <button
                type="button"
                onClick={() => onOpenNode(info.sessionId, info.failedNodeId as string)}
              >
                이 노드 열기
              </button>
            </div>
          )}

          {(info.waiting || info.suspended) && (
            <div role="status">
              <p>
                승인 대기: 노드 {info.waiting?.nodeId ?? info.suspended?.nodeId} (
                {info.waiting?.kind ?? info.suspended?.kind})
              </p>
              <button
                type="button"
                onClick={() =>
                  setApproval({
                    sessionId: info.sessionId,
                    nodeId: (info.waiting?.nodeId ?? info.suspended?.nodeId) as string,
                  })
                }
              >
                승인 화면 열기
              </button>
            </div>
          )}

          {approval && (
            <ApprovalPanel
              sessionId={approval.sessionId}
              nodeId={approval.nodeId}
              runId={runId ?? undefined}
              onClose={() => setApproval(null)}
              onDone={() => {
                setApproval(null);
                void (async () => {
                  if (runId) setInfo(await api.runInfo(runId));
                })();
              }}
            />
          )}

          <table>
            <thead>
              <tr>
                <th>노드</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.nodeId} className={RESULT_CLASS[r.status] ?? "st-other"}>
                  <td>
                    {r.status === "fail" ? (
                      <button
                        type="button"
                        onClick={() => onOpenNode(info.sessionId, r.nodeId)}
                      >
                        {r.nodeId}
                      </button>
                    ) : (
                      r.nodeId
                    )}
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>로그</h3>
          <ul>
            {log.map((e) => (
              <li key={e.seq}>
                [{e.level}] {e.nodeId ? `${e.nodeId} ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}