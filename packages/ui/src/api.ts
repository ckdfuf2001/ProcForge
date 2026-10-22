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
      /** core가 정한 상대 경로 (표시 전용. 내려받기는 attemptId+idx) */
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

/** M8-ui2: 분해 라운드 1건 — core가 정한 값만 그대로 (판단 없음) */
export type DecompositionRound = {
  revision: number;
  at: string;
  actor: string;
  depth: number;
  depthSource: "snapshot" | "id";
  parentId: string;
  childIds: string[];
  reason: string | null;
  alternatives: string[];
  causeAdviseIds: string[];
};

/** M8-ui2: 특정 revision 시점 트리 노드 (status null = 그 시점 상태 미상) */
export type HistoryNode = {
  id: string;
  parentId: string | null;
  goal: string | null;
  status: string | null;
  depth: number;
  children: string[];
  dependsOn: string[];
  locked: boolean;
  sideEffect: string | null;
  staleSince?: { revision: number; causeNodeId: string };
  hash: string | null;
};

/** M8-ui2: 시점 트리 응답 (structureOnly = 상태 미상 구간이 있음) */
export type TreeAtResponse = {
  nodes: HistoryNode[];
  structureOnly: boolean;
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

/** M7-5-4: 실행 화면 — 절차서와 param 스키마(required/default). */
export type ProcedureParam = {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description: string;
};
export type ProcedureRow = { name: string; params: ProcedureParam[] };

/** 노드별 결과 — status 는 runner 가 준 문자열 그대로 (UI 해석 금지) */
export type RunNodeResult = { nodeId: string; status: string };

export type RunInfo = {
  runId: string;
  status: string;
  procedure: string;
  sessionId: string;
  params: Record<string, string>;
  results: RunNodeResult[];
  summary?: {
    pass: number;
    fail: number;
    unverified: number;
    skipped: number;
    blocked: number;
    suspended: number;
  };
  failedNodeId?: string;
  failedDetail?: string;
  waiting: { nodeId: string; kind: string; at: string } | null;
  suspended: { nodeId: string; kind: string; missing?: string[] } | null;
};

export type RunLogEntry = {
  seq: number;
  at: string;
  level: string;
  nodeId?: string;
  message: string;
};

export type ApprovalInfo = {
  sessionId: string;
  nodeId: string;
  approvalHash: string;
  script: { rel: string; sha256: string; content: string } | null;
  diff: string | null;
  approved: boolean;
  needsReapproval: boolean;
  /** var/generated 인자 — 명시 선택해야 승인된다 (CLI --allow-wildcard 와 동일) */
  wildcardKeys: string[];
};

async function fail(path: string, r: Response): Promise<ApiError> {
  let message = `${path} ${r.status}`;
  let code: string | undefined;
  try {
    const body = (await r.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body?.error?.message === "string" && body.error.message !== "") {
      message = body.error.message;
    }
    if (typeof body?.error?.code === "string") code = body.error.code;
  } catch {
    // 본문이 없거나 JSON 이 아니면 상태 코드만 남긴다
  }
  return new ApiError(path, r.status, message, code);
}

/** 쓰기: POST + JSON만 (M7-ui4) */
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-procforge-token": takeToken(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await fail(path, r);
  return (await r.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { "x-procforge-token": takeToken() } });
  if (!r.ok) throw await fail(path, r);
  return (await r.json()) as T;
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    message?: string,
    readonly code?: string,
  ) {
    super(message ?? `${path} ${status}`);
  }
}

export const api = {
  post,
  sessions: () => get<{ sessions: SessionRow[] }>("/api/sessions"),
  store: () => get<StoreInfo>("/api/store"),
  pairings: () => get<Pairings>("/api/pairings"),
  tree: (sid: string) => get<TreeResponse>(`/api/sessions/${encodeURIComponent(sid)}/tree`),
  // M8-ui2: 분해 라운드 이력 (읽기 전용)
  decompositionHistory: (sid: string) =>
    get<DecompositionRound[]>(
      `/api/sessions/${encodeURIComponent(sid)}/decomposition-history`,
    ),
  // M8-ui2: 특정 revision 시점 트리 (읽기 전용)
  treeAt: (sid: string, revision: number) =>
    get<TreeAtResponse>(
      `/api/sessions/${encodeURIComponent(sid)}/tree-at?revision=${revision}`,
    ),
  nodeDetail: (sid: string, nid: string) =>
    get<NodeDetailResponse>(
      `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}`,
    ),
  artifactUrl: (
    sid: string,
    nid: string,
    attemptId: string,
    index: number,
  ) =>
    `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}/artifacts/${encodeURIComponent(attemptId)}/${index}`,
  // M7-5-4: 실행 화면
  procedures: () => get<{ procedures: ProcedureRow[] }>("/api/procedures"),
  runStart: (procedure: string, params: Record<string, string>) =>
    post<{ runId: string; sessionId: string; procedure: string; params: Record<string, string> }>(
      "/api/runs",
      { procedure, params },
    ),
  runInfo: (runId: string) => get<RunInfo>(`/api/runs/${encodeURIComponent(runId)}`),
  latestRun: (procedure: string) =>
    get<{ runId: string | null }>(`/api/latest-run?procedure=${encodeURIComponent(procedure)}`),
  runCancel: (runId: string) =>
    post<{ runId: string; cancelled: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      {},
    ),
  // M7-close-a: 실행 external 승인 (CLI runApprove 와 같은 경로)
  runApprove: (
    runId: string,
    body: {
      nodeId: string;
      approvalHash: string;
      approved: boolean;
      expectedRevision: number;
      note?: string;
      allowWildcard?: string[];
    },
  ) =>
    post<{ runId: string; nodeId: string; approved: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/approve`,
      body,
    ),
  approvalInfo: (sid: string, nid: string) =>
    get<ApprovalInfo>(
      `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}/approval`,
    ),
  approve: (
    sid: string,
    nid: string,
    body: {
      approvalHash: string;
      approved: boolean;
      expectedRevision: number;
      note?: string;
      allowWildcard?: string[];
    },
  ) =>
    post<{ nodeId: string; approvalHash: string; approved: boolean }>(
      `/api/sessions/${encodeURIComponent(sid)}/nodes/${encodeURIComponent(nid)}/approve`,
      body,
    ),
};

/** SSE 공통 파서 (EventSource 금지 — 토큰 헤더를 못 붙인다). */
function subscribeSse(
  path: string,
  handlers: {
    onData: (data: string) => void;
    onEvent?: (event: string, data: string) => void;
    onStatus?: (s: "open" | "closed" | "error") => void;
  },
  lastEventId?: { v: number },
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const r = await fetch(path, {
        headers: {
          "x-procforge-token": takeToken(),
          accept: "text/event-stream",
          ...(lastEventId && lastEventId.v > 0
            ? { "last-event-id": String(lastEventId.v) }
            : {}),
        },
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        handlers.onStatus?.(r.status === 401 ? "closed" : "error");
        return;
      }
      handlers.onStatus?.("open");
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
          if (idm) {
            if (lastEventId) lastEventId.v = Number(idm[1]);
          }
          const evm = /^event: (.+)$/m.exec(b);
          const dm = /^data: (.*)$/m.exec(b);
          if (evm && handlers.onEvent) {
            handlers.onEvent(evm[1], dm ? dm[1] : "");
            continue;
          }
          if (!dm) continue;
          handlers.onData(dm[1]);
        }
      }
      handlers.onStatus?.("closed");
    } catch {
      if (!ctrl.signal.aborted) handlers.onStatus?.("error");
    }
  })();
  return () => ctrl.abort();
}

/**
 * M7-ui2: 세션 이벤트 SSE 구독.
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
  return subscribeSse(
    `/api/sessions/${encodeURIComponent(sid)}/events`,
    {
      onData: (d) => onChange(JSON.parse(d)),
      ...(onStatus ? { onStatus } : {}),
    },
    { v: 0 },
  );
}

/** M7-5-4: 실행 로그 SSE. `end` 이벤트로 종료를 알린다. */
export function subscribeRunLog(
  runId: string,
  onEntry: (e: RunLogEntry) => void,
  onEnd?: (status: string) => void,
  onStatus?: (s: "open" | "closed" | "error") => void,
): () => void {
  return subscribeSse(
    `/api/runs/${encodeURIComponent(runId)}/stream`,
    {
      onData: (d) => onEntry(JSON.parse(d) as RunLogEntry),
      onEvent: (ev, d) => {
        if (ev === "end") {
          const parsed = d ? (JSON.parse(d) as { status?: string }) : {};
          onEnd?.(parsed.status ?? "");
        }
      },
      ...(onStatus ? { onStatus } : {}),
    },
    { v: 0 },
  );
}
