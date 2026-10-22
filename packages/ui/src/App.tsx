import { useEffect, useState } from "react";
import {
  api,
  subscribeEvents,
  ApiError,
  type SessionRow,
  type StoreInfo,
  type NodeRow,
} from "./api.js";
import { TreeView } from "./TreeView.js";
import { RoundView } from "./RoundView.js";
import { RunPanel } from "./RunPanel.js";

// M7-1: 세션 목록 화면 (저장소 경로·중복 경고·연결 배지·짝 이력).
// React 기본 이스케이프만 사용 (dangerouslySetInnerHTML 금지).

function asDate(value: string | number | null): Date | null {
  if (value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTime(value: string | number | null): string {
  const d = asDate(value);
  if (!d) return "-";
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function isoTime(value: string | number | null): string | undefined {
  return asDate(value)?.toISOString();
}

export function App() {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"sessions" | "run">("sessions");
  // M8-ui3: 세션 안에서 "분해 라운드" 3단 화면과 "트리"를 고른다.
  const [view, setView] = useState<"rounds" | "tree">("rounds");
  // M7-5-4: 실행 화면 "이 노드 열기" → 세션 탭의 상세로 이동 (n 은 재진입 강제용)
  const [focus, setFocus] = useState<{
    sessionId: string;
    nodeId: string;
    n: number;
  } | null>(null);

  const openNode = (sessionId: string, nodeId: string) => {
    setTab("sessions");
    setPicked(sessionId);
    setFocus({ sessionId, nodeId, n: Date.now() });
  };

  useEffect(() => {
    (async () => {
      try {
        setStore(await api.store());
        setSessions((await api.sessions()).sessions);
      } catch (e) {
        if (e instanceof ApiError) setError(e);
        else setError(new ApiError("?", 0));
      }
    })();
  }, []);

  // M7-ui1-3: 새로고침하면 토큰이 사라진다 (fragment 제거). 401이면 안내.
  if (error?.status === 401) {
    return (
      <main className="app-shell auth-shell">
        <h1>ProcForge</h1>
        <div className="empty-state">
          <strong>인증 정보가 없습니다.</strong>
          <span>새로고침하면 토큰이 사라집니다(의도된 동작).</span>
          <span>터미널에 출력된 <code>#t=...</code> URL로 다시 열어 주세요.</span>
        </div>
      </main>
    );
  }
  if (error) {
    return (
      <main className="app-shell auth-shell">
        <h1>ProcForge</h1>
        <p role="alert">오류: {error.message}</p>
      </main>
    );
  }
  if (!store || !sessions) {
    return (
      <main className="app-shell auth-shell">
        <p className="muted">불러오는 중…</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">PF</span>
          <div>
            <h1>ProcForge</h1>
            <p className="brand-sub">절차 실행·검토 콘솔</p>
          </div>
        </div>
        <div className="store-chip" title={store.storeDir}>
          <span className="store-label">저장소</span>
          <code>{store.storeDir}</code>
        </div>
      </header>
      {store.duplicateWarning && (
        <div className="alert alert-warn" role="alert">경고: {store.duplicateWarning}</div>
      )}
      <nav className="tabs" aria-label="주요 화면">
        <button
          type="button"
          aria-pressed={tab === "sessions"}
          onClick={() => setTab("sessions")}
        >
          세션
        </button>
        <button
          type="button"
          aria-pressed={tab === "run"}
          onClick={() => setTab("run")}
        >
          실행
        </button>
      </nav>
      {tab === "run" && <RunPanel onOpenNode={openNode} />}
      {tab === "sessions" && picked && (
        <section className="panel session-detail">
          <div className="section-bar">
            <button className="btn btn-ghost" type="button" onClick={() => setPicked(null)}>
              ← 세션 목록
            </button>
            <div className="tabs tabs-inline" role="tablist" aria-label="세션 보기">
              <button
                type="button"
                role="tab"
                aria-selected={view === "rounds"}
                aria-pressed={view === "rounds"}
                onClick={() => setView("rounds")}
              >
                분해 라운드
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "tree"}
                aria-pressed={view === "tree"}
                onClick={() => setView("tree")}
              >
                트리
              </button>
            </div>
          </div>
          {view === "rounds" ? (
            <RoundView
              key={`${picked}:${focus?.sessionId === picked ? focus.n : 0}`}
              sessionId={picked}
            />
          ) : (
            <TreeView
              key={`${picked}:${focus?.sessionId === picked ? focus.n : 0}`}
              sessionId={picked}
              focusNodeId={focus?.sessionId === picked ? focus.nodeId : null}
            />
          )}
        </section>
      )}
      {tab === "sessions" && !picked && (
        <>
          <div className="section-head">
            <div>
              <h2>세션</h2>
              <p className="section-sub">최근 작업과 연결 상태를 한눈에 확인합니다.</p>
            </div>
            <span className="count-badge">{sessions.length}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="empty-state">
              <strong>아직 세션이 없습니다.</strong>
              <span>MCP에서 pf_start로 첫 세션을 만들면 여기에 표시됩니다.</span>
            </div>
          ) : (
            <div className="table-card">
              <table className="data-table sessions-table">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>요청</th>
                    <th className="col-time">생성</th>
                    <th className="col-time">마지막 변경</th>
                    <th className="col-num">rev</th>
                    <th className="col-num">노드</th>
                    <th>root</th>
                    <th className="col-num">연결</th>
                    <th>짝</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((x) => (
                    <tr key={x.sessionId}>
                      <td>
                        <button
                          className="btn-id"
                          type="button"
                          title={x.sessionId}
                          onClick={() => setPicked(x.sessionId)}
                        >
                          {x.sessionId.slice(0, 8)}
                        </button>
                      </td>
                      <td className="cell-request" title={x.request}>
                        {x.request}
                      </td>
                      <td className="cell-time">
                        <time dateTime={isoTime(x.createdAt)}>{formatTime(x.createdAt)}</time>
                      </td>
                      <td className="cell-time">
                        <time dateTime={isoTime(x.lastUsedAt)}>{formatTime(x.lastUsedAt)}</time>
                      </td>
                      <td className="col-num">{x.revision}</td>
                      <td className="col-num">{x.nodeCount}</td>
                      <td>
                        <span className={`status status-${x.rootStatus}`}>{x.rootStatus}</span>
                      </td>
                      <td className="col-num">
                        {x.connectionIds.length > 1 ? (
                          <strong className="text-warn">{x.connectionIds.length}개</strong>
                        ) : (
                          x.connectionIds.length
                        )}
                      </td>
                      <td>
                        {x.pairings.length === 0 ? (
                          <span className="muted">-</span>
                        ) : (
                          x.pairings.map((p) => (
                            <code key={p.openCodeSessionId} title={p.openCodeSessionId}>
                              {p.openCodeSessionId.slice(0, 8)}
                            </code>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}

export type { NodeRow };
