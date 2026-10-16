// UI API 타입 (JSON 계약. shared DTO 모양을 미러링 — ui는 local import 금지).
export type SessionRow = {
  sessionId: string;
  request: string;
  revision: number;
  createdAt: string;
  lastUsedAt: number | null;
  nodeCount: number;
  rootStatus: string;
  connectionIds: string[];
  pairings: { openCodeSessionId: string; at: string }[];
};

export type StoreInfo = {
  storeDir: string;
  projectRoot: string;
  duplicateWarning: string | null;
};

export type Pairings = {
  pairs: Record<
    string,
    { openCodeSessionId: string; pfSessionId: string; at: string }
  >;
  history: { openCodeSessionId: string; pfSessionId: string; at: string }[];
};

let token = "";

export function takeToken(): string {
  if (!token) {
    token = (location.hash.match(/t=([^&]+)/) || [])[1] || "";
    // 읽자마자 fragment 삭제 (XSS 시 토큰 유출 방지).
    history.replaceState(null, "", location.pathname);
  }
  return token;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { "x-procforge-token": takeToken() } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  sessions: () => get<{ sessions: SessionRow[] }>("/api/sessions"),
  store: () => get<StoreInfo>("/api/store"),
  pairings: () => get<Pairings>("/api/pairings"),
};
