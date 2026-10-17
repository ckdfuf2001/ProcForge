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

export type NodeRow = {
  id: string;
  goal: string;
  status: string;
  depth: number;
  dependsOn: string[];
  attempts: number;
  retriesLeft: number;
  locked: boolean;
  sideEffect: string;
  staleSince?: { revision: number; causeNodeId: string };
};

export type NodeDetail = {
  sessionId: string;
  nodeId: string;
  revision: number;
  goal: string;
  status: string;
  locked: boolean;
  sideEffect: string;
  staleSince: { revision: number; causeNodeId: string } | null;
  hash: string;
  tool: { server: string; name: string } | null;
  args: Record<string, unknown>;
  dependsOn: string[];
  constraints: { id: string; source: string; kind: string }[];
  advice: { at: string; text: string }[];
  golden: { fixtures: string[]; output: string; ignore: string[] } | null;
  retriesLeft: number;
  attempts: {
    id: string;
    at: string;
    tool: { server: string; name: string };
    verdict: string | null;
    failedConstraints: string[];
    rubricReasons: Record<string, string>;
    resultSummary: string;
    artifactPreviews: {
      rel: string;
      sha256: string;
      size: number;
      mime: string;
      text: string | null;
      truncated: boolean;
    }[];
  }[];
  lastVerdict: string | null;
  lastFailedConstraints: string[];
};

export type NodeEvent = {
  revision: number;
  at: string;
  actor: string;
  method: string;
  nodeIds: string[];
  summary: string;
};

export type NodeDetailResponse = {
  detail: NodeDetail;
  events: NodeEvent[];
};

export type TreeResponse = {
  nodes: { nodes: NodeRow[]; revision: number };
  blocked: {
    blocked: { nodeId: string; waitingOn: string[]; reason: string }[];
    needsHuman: string[];
    revision: number;
  };
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { "x-procforge-token": takeToken() } });
  if (!r.ok) throw new ApiError(path, r.status);
  return (await r.json()) as T;
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`${path} ${status}`);
  }
}

export const api = {
  sessions: () => get<{ sessions: SessionRow[] }>("/api/sessions"),
  store: () => get<StoreInfo>("/api/store"),
  pairings: () => get<Pairings>("/api/pairings"),
  tree: (sid: string) => get<TreeResponse>(`/api/sessions/${encodeURIComponent(sid)}/tree`),
  nodeDetail: (sid: string, nid: string) =>
    get<NodeDetailResponse>(
      `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}`,
    ),
  artifactUrl: (sid: string, nid: string, rel: string) =>
    `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}/artifacts/${rel
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
};

/**
 * M7-ui2: SSE 구독. EventSource는 토큰 헤더를 못 붙이므로 fetch 스트리밍으로
 * 직접 파싱한다 (M7-ui2 결정).
 */
export function subscribeEvents(
  sid: string,
  onChange: (e: {
    revision: number;
    nodeIds: string[];
    method: string;
    actor: string;
  }) => void,
  onStatus?: (s: "open" | "closed" | "error") => void,
): () => void {
  const ctrl = new AbortController();
  const lastEventId = { v: 0 };
  void (async () => {
    try {
      const r = await fetch(
        `/api/sessions/${encodeURIComponent(sid)}/events`,
        {
          headers: {
            "x-procforge-token": takeToken(),
            accept: "text/event-stream",
            ...(lastEventId.v > 0 ? { "last-event-id": String(lastEventId.v) } : {}),
          },
          signal: ctrl.signal,
        },
      );
      if (!r.ok || !r.body) {
        onStatus?.(r.status === 401 ? "closed" : "error");
        return;
      }
      onStatus?.("open");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const b of blocks) {
          if (b.startsWith(":")) continue; // heartbeat
          const idm = /^id: (\d+)$/m.exec(b);
          const dm = /^data: (.*)$/m.exec(b);
          if (!dm) continue;
          if (idm) lastEventId.v = Number(idm[1]);
          onChange(JSON.parse(dm[1]));
        }
      }
      onStatus?.("closed");
    } catch {
      if (!ctrl.signal.aborted) onStatus?.("error");
    }
  })();
  return () => ctrl.abort();
}
