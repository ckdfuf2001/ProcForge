// M7-1: UI→OpenCode 연결 (B/A/C).
// 상태 변경은 pf_advise(App)로만 하고, 여기는 "계속하라" 신호 전달이다 (R1~R4).

export type LinkMode = "b" | "a" | "c";

export type LinkResult =
  | { delivered: true; mode: "b" | "a" }
  | { delivered: false; degraded: string; copyText: string };

export type LinkDeps = {
  fetchImpl?: typeof fetch;
  /** 세션 part 목록 (신호 전 기준점·신호 후 새 호출 감지용) */
  listParts: (openCodeSessionId: string) => Promise<unknown[]>;
  /** 짝짓기 갱신 (주입. savePairing) */
  onPairing?: (openCodeSessionId: string, pfSessionId: string) => void;
  /** 실측 버전 목록 (미지정 시 M7-0 실측 1.18.18만 허용) */
  knownVersions?: string[];
};

const CONTINUE_COPY_FALLBACK = "OpenCode에서 '계속'이라고 입력하세요.";

/** M7-ui4-i: 신호 timeout 상한 (2분). 더 오래 기다려도 사람은 기다리지 않는다. */
export const SIGNAL_TIMEOUT_CAP_MS = 120_000;

export function clampTimeoutMs(ms: number | undefined): number {
  const v = ms ?? 60_000;
  return Math.min(Math.max(v, 1_000), SIGNAL_TIMEOUT_CAP_MS);
}

/**
 * M7-ui4-i: OpenCode 서버가 밝히는 버전. **클라이언트가 정하지 않는다**
 * (MCP 도구·UI 본문 값은 무시/거절). 서버 설정이 없으면 여기서 조회하고,
 * 조회 실패면 undefined → sendContinue가 default-deny로 C에 머문다.
 */
export async function fetchServerVersion(
  baseUrl: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | undefined> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(deps.timeoutMs ?? 3000, 5000));
  try {
    // /global/health is the only endpoint that survives the web UI fallback
    // (in 1.18.18 /version may serve index.html, /config has no version).
    for (const path of ["/global/health", "/version", "/config", "/app"]) {
      try {
        const r = await doFetch(`${base}${path}`, {
          signal: ac.signal,
          headers: { accept: "application/json" },
        });
        if (!r.ok) continue;
        const body = (await r.json()) as Record<string, unknown> | string;
        const v =
          typeof body === "string"
            ? body
            : [body.version, (body.info as { version?: unknown } | undefined)?.version]
                .filter((x): x is string => typeof x === "string")
                .find((x) => /^\d+\.\d+\.\d+/.test(x));
        if (v) return v.trim();
      } catch {
        // 다음 후보 경로를 시도한다 (조회 실패는 미확인으로 간주)
      }
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ ok: boolean; json: unknown }> {
  let r: Response;
  try {
    r = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, json: undefined };
  }
  if (!r.ok) return { ok: false, json: undefined };
  try {
    return { ok: true, json: (await r.json()) as unknown };
  } catch {
    return { ok: true, json: undefined };
  }
}

/**
 * pf_start tool part에서 ProcForge sessionId 추출.
 * 실측 형태: {type:"tool", tool:"ProcForge_pf_start"|"procforge_pf_start",
 * state:{status, output:"{\"sessionId\":\"...\",...}"}}.
 */
export function extractPfSessionId(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) {
    if (p === null || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    if (rec["type"] !== "tool") continue;
    const tool = String(rec["tool"] ?? "");
    if (!tool.toLowerCase().includes("pf_start")) continue;
    const state = rec["state"];
    if (state === null || typeof state !== "object") continue;
    const output = (state as Record<string, unknown>)["output"];
    if (typeof output !== "string") continue;
    try {
      const parsed = JSON.parse(output) as { sessionId?: unknown };
      if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
        return parsed.sessionId;
      }
    } catch {
      // 다음 후보
    }
  }
  return undefined;
}

/**
 * M7-0 실측형 읽기. 응답 형태가 버전/엔드포인트에 따라 다르다:
 * - 구형/목업: {data: parts[]}
 * - 1.18.18 실서버: [{info, parts: Part[]}, ...]
 * 대용량 세션은 빈 페이지를 돌려줄 수 있어 (M7-0 §3) 폴백일 뿐이다.
 * 1순위는 SSE message.part.updated (아래 sseNewPfCall).
 */
function extractParts(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      if (item !== null && typeof item === "object") {
        const parts = (item as Record<string, unknown>)["parts"];
        if (Array.isArray(parts)) return parts;
      }
      return [item];
    });
  }
  if (payload !== null && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec["data"])) return extractParts(rec["data"]);
    if (Array.isArray(rec["parts"])) return rec["parts"];
  }
  return [];
}

export function httpLinkDeps(
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Pick<LinkDeps, "listParts"> {
  const doFetch = fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  return {
    listParts: async (sid) => {
      const r = await doFetch(
        `${base}/session/${encodeURIComponent(sid)}/message`,
        { headers: { accept: "application/json" } },
      );
      if (!r.ok) return [];
      return extractParts((await r.json()) as unknown);
    },
  };
}

/** pf_ tool part 판정 */
export function isPfToolPart(p: unknown): boolean {
  return (
    p !== null &&
    typeof p === "object" &&
    (p as Record<string, unknown>)["type"] === "tool" &&
    String((p as Record<string, unknown>)["tool"] ?? "").includes("pf_")
  );
}

/** 최신 pf_start 기준 sessionId (latest-wins. 재연결 시 새 세션이 이긴다) */
export function readLatestPfSessionId(parts: unknown[]): string | undefined {
  return extractPfSessionId([...parts].reverse());
}

/**
 * SSE 1순위 감지. GET /event에서 message.part.updated를 읽어
 * 기준점 이후의 새 pf_ 호출이면 true. 스트림 종료·에러·기한 초과는
 * false (폴링 폴백으로 넘긴다).
 */
async function sseNewPfCall(o: {
  baseUrl: string;
  sid: string;
  before: Set<string>;
  until: number;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    Math.max(0, o.until - Date.now()),
  );
  try {
    const r = await o.fetchImpl(`${o.baseUrl}/event`, {
      headers: { accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) return false;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      if (Date.now() >= o.until) return false;
      const { done, value } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        const m = /^event: ([^\n]+)\ndata: ([\s\S]*)$/.exec(b.trim());
        if (!m || m[1] !== "message.part.updated") continue;
        try {
          const ev = JSON.parse(m[2]) as {
            properties?: { sessionID?: unknown; part?: unknown };
          };
          const props = ev.properties;
          if (props?.sessionID !== o.sid) continue;
          const part = props?.part;
          if (!isPfToolPart(part)) continue;
          if (o.before.has(JSON.stringify(part))) continue;
          return true;
        } catch {
          // 다음 블록
        }
      }
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "계속" 신호 전송. B(session/:id/message + {"prompt":{text,parts}}, 기본) >
 * A(tui append+submit, attach된 TUI 있을 때만) > C(문구만).
 * 미확인 버전이면 전송 없이 C. 신호 후 timeoutMs 안에 pf_* 출현이
 * 없으면 degraded("모델 무응답/plan 모드 의심")+C 문구.
 */
export async function sendContinue(opts: {
  baseUrl: string;
  openCodeSessionId?: string;
  text: string;
  mode: LinkMode;
  timeoutMs?: number;
  pollMs?: number;
  /** 연결의 OpenCode 버전 (연결의 clientInfo에서 호출자가 넣어라. 없으면 미확인→C) */
  serverVersion?: string;
  deps: LinkDeps;
}): Promise<LinkResult> {
  const sid = opts.openCodeSessionId;
  const fail = (degraded: string): LinkResult => ({
    delivered: false,
    degraded,
    copyText: `${opts.text}\n${CONTINUE_COPY_FALLBACK}`,
  });
  if (!sid || opts.mode === "c") return fail("연결 없음");
  // 클로저 안 narrowing 소멸 방지 (빌드 tsc).
  const ocSid: string = sid;
  const sigMode: "b" | "a" = opts.mode === "b" ? "b" : "a";
  // M7-1.1: default-deny. 버전을 모르면 가장 위험하니 전송하지 않는다.
  // 호출자(UI/CLI)가 연결의 clientInfo 버전(server.ts getClientVersion)을 넣는다.
  if (opts.serverVersion === undefined) return fail("버전 미확인. 전송하지 않음");
  const known = opts.deps.knownVersions ?? ["1.18.18"];
  if (!known.some((v) => opts.serverVersion === v)) {
    return fail(`미확인 버전(${opts.serverVersion}). 전송하지 않음`);
  }
  const doFetch = opts.deps.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  // M7-1.1-1: 신호 전 기준점. 이미 있는 pf_start 때문에 항상 통과하던
  // 문제를 막는다. 이후에 생긴 pf_*만 새 호출로 센다.
  let before = new Set<string>();
  try {
    const parts = await opts.deps.listParts(ocSid);
    before = new Set(parts.filter(isPfToolPart).map((p) => JSON.stringify(p)));
  } catch {
    before = new Set();
  }
  if (sigMode === "b") {
    // M7-1.1 실서버 확인 (1.18.18): POST /session/:id/message + {parts} → 200.
    // {"prompt":{...}} 래퍼는 이 경로에서 400 (래퍼는 /api/session/:id/prompt용).
    const r = await postJson(doFetch, `${base}/session/${ocSid}/message`, {
      parts: [{ type: "text", text: opts.text }],
    });
    if (!r.ok) return fail("전송 실패");
  } else {
    const ap = await postJson(doFetch, `${base}/tui/append-prompt`, {
      text: opts.text,
    });
    if (!ap.ok || ap.json !== true) return fail("append 실패");
    const sp = await postJson(doFetch, `${base}/tui/submit-prompt`, {});
    if (!sp.ok || sp.json !== true) return fail("submit 실패");
  }
  const timeoutMs = clampTimeoutMs(opts.timeoutMs);
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  const isNewPfCall = (parts: unknown[]): boolean =>
    parts.some((p) => isPfToolPart(p) && !before.has(JSON.stringify(p)));
  // M7-ui1.1-6: SSE 1순위, messages 폴링은 폴백 (대용량 세션 빈 페이지 오탐 회피).
  // 신호 직후엔 이미 호출이 반영돼 있을 수 있어 1회 즉시 확인한다 (지연 최소화).
  try {
    if (isNewPfCall(await opts.deps.listParts(ocSid))) return paired();
  } catch {
    // 무시
  }
  if (
    await sseNewPfCall({
      baseUrl: base,
      sid: ocSid,
      before,
      until: deadline,
      fetchImpl: doFetch,
    })
  ) {
    return paired();
  }
  for (;;) {
    try {
      if (isNewPfCall(await opts.deps.listParts(ocSid))) return paired();
    } catch {
      // 폴링 실패 무시
    }
    if (Date.now() >= deadline) {
      return fail("모델 무응답/plan 모드 의심");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  async function paired(): Promise<LinkResult> {
    // 짝짓기 갱신 (best-effort).
    try {
      const parts = await opts.deps.listParts(ocSid);
      const pfSid = readLatestPfSessionId(parts);
      if (pfSid) opts.deps.onPairing?.(ocSid, pfSid);
    } catch {
      // 무시
    }
    return { delivered: true, mode: sigMode };
  }
}
