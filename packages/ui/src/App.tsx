import { useEffect, useState } from "react";
import { api, type SessionRow, type StoreInfo } from "./api.js";

// M7-1: 세션 목록 화면 (저장소 경로·중복 경고·연결 배지·짝 이력).
// React 기본 이스케이프만 사용 (dangerouslySetInnerHTML 금지).

export function App() {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setStore(await api.store());
        setSessions((await api.sessions()).sessions);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (error) return <p>오류: {error} (URL #t=토큰 확인)</p>;
  if (!store || !sessions) return <p>불러오는 중…</p>;

  return (
    <main>
      <h1>ProcForge</h1>
      <p>저장소: {store.storeDir}</p>
      {store.duplicateWarning && <p role="alert">경고: {store.duplicateWarning}</p>}
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
                <td>{x.sessionId.slice(0, 8)}</td>
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
    </main>
  );
}
