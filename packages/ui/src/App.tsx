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

// M7-1: 세션 목록 화면 (저장소 경로·중복 경고·연결 배지·짝 이력).
// React 기본 이스케이프만 사용 (dangerouslySetInnerHTML 금지).

export function App() {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

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
      <main>
        <h1>ProcForge</h1>
        <p role="alert">
          인증 정보가 없습니다. 새로고침하면 토큰이 사라집니다(의도된 동작).
          터미널에 출력된 <code>#t=...</code> URL로 다시 열어 주세요.
        </p>
      </main>
    );
  }
  if (error) return <main><h1>ProcForge</h1><p role="alert">오류: {error.message}</p></main>;
  if (!store || !sessions) return <main><p>불러오는 중…</p></main>;

  return (
    <main>
      <h1>ProcForge</h1>
      <p>저장소: {store.storeDir}</p>
      {store.duplicateWarning && <p role="alert">경고: {store.duplicateWarning}</p>}
      {picked && (
        <section>
          <button type="button" onClick={() => setPicked(null)}>
            ← 세션 목록
          </button>
          <TreeView sessionId={picked} />
        </section>
      )}
      {!picked && (
        <>
          <h2>세션</h2>
          {sessions.length === 0 ? (
            <p>세션 없음</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>요청</th>
                  <th>rev</th>
                  <th>노드</th>
                  <th>root</th>
                  <th>연결</th>
                  <th>짝</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((x) => (
                  <tr key={x.sessionId}>
                    <td>
                      <button type="button" onClick={() => setPicked(x.sessionId)}>
                        {x.sessionId.slice(0, 8)}
                      </button>
                    </td>
                    <td>{x.request.slice(0, 60)}</td>
                    <td>{x.revision}</td>
                    <td>{x.nodeCount}</td>
                    <td>{x.rootStatus}</td>
                    <td>
                      {x.connectionIds.length > 1 ? (
                        <strong>경고:{x.connectionIds.length}개</strong>
                      ) : (
                        x.connectionIds.length
                      )}
                    </td>
                    <td>
                      {x.pairings.map((p) => p.openCodeSessionId.slice(0, 8)).join(",")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}

export type { NodeRow };
