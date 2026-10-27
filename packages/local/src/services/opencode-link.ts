// M7-1: UI→OpenCode 연결 (B/A/C).
// 상태 변경은 pf_advise(App)로만 하고, 여기는 "계속하라" 신호 전달이다 (R1~R4).

export type LinkMode = "b" | "a" | "c";

export type LinkResult =
  // M8-1: copyText 는 B(전송 문구)와 같은 문자열 — 성공 시에도 함께 돌려준다
  // (전송·복사 문구가 언제나 같다는 계약을 확인하게 한다).
  // M8-1 a: warning = 신호 이후 첫 pf_* 호출이 pf_start 면 새 세션 시작이다.
  | { delivered: true; mode: "b" | "a"; copyText?: string; warning?: string }
  | { delivered: false; degraded: string; copyText: string };

/** 메시지 1건 (신호 user 메시지 확인용. role 없으면 판정에서 제외) */
export type SignalMessage = { role?: string; texts: string[] };

/**
 * M8-1-close2 b: delivered 뒤 백그라운드 감시 결과.
 * warn = 기존 규칙 경고문, ok = 정상 첫 호출, no-response = watchMs 안에 없음.
 */
export type SignalWatchOutcome = {
  openCodeSessionId: string;
  kind: "warn" | "ok" | "no-response";
  /** warn이면 경고문, no-response면 "모델 무응답/plan 모드 의심" */
  text?: string;
};

export type LinkDeps = {
  fetchImpl?: typeof fetch;
  /** 세션 part 목록 (신호 전 기준점·신호 후 새 호출 감지용) */
  listParts: (openCodeSessionId: string) => Promise<unknown[]>;
  /** 세션 메시지 목록 (신호 user 메시지 보임 확인용. 없으면 pf_*만 본다) */
  listMessages?: (openCodeSessionId: string) => Promise<SignalMessage[]>;
  /** 짝짓기 갱신 (주입. savePairing) */
  onPairing?: (openCodeSessionId: string, pfSessionId: string) => void;
  /** delivered 뒤 백그라운드 감시 결과 (주입. signals 기록·SSE 배지) */
  onSignalWatch?: (outcome: SignalWatchOutcome) => void;
  /** 실측 버전 목록 (미지정 시 M7-0 실측 1.18.18만 허용) */
  knownVersions?: string[];
};

/** M8-1: C(복사 문구)는 B(전송 문구)와 **같은 문자열**이다 — 덧붙이지 않는다. */

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
  init?: { signal?: AbortSignal },
): Promise<{ ok: boolean; status?: number; json: unknown }> {
  let r: Response;
  try {
    r = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  } catch {
    // 네트워크 오류·abort·타임아웃: 응답 없음 (보임 판정으로 넘긴다).
    return { ok: false, json: undefined };
  }
  if (!r.ok) return { ok: false, status: r.status, json: undefined };
  try {
    return { ok: true, status: r.status, json: (await r.json()) as unknown };
  } catch {
    return { ok: true, status: r.status, json: undefined };
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
): Pick<LinkDeps, "listParts" | "listMessages"> {
  const doFetch = fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  const getJson = async (sid: string): Promise<unknown> => {
    const r = await doFetch(
      `${base}/session/${encodeURIComponent(sid)}/message`,
      { headers: { accept: "application/json" } },
    );
    if (!r.ok) return undefined;
    try {
      return (await r.json()) as unknown;
    } catch {
      return undefined;
    }
  };
  return {
    listParts: async (sid) => extractParts(await getJson(sid)),
    listMessages: async (sid) => extractMessages(await getJson(sid)),
  };
}

/**
 * M8-1-close a: 메시지 목록에서 role·텍스트만 뽑는다.
 * 실서버 `[{info:{role}, parts}]`, 구형 `{data: parts[]}`(role 없음).
 */
export function extractMessages(payload: unknown): SignalMessage[] {
  const msgs: SignalMessage[] = [];
  const push = (role: unknown, parts: unknown): void => {
    const texts: string[] = [];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (
          p !== null &&
          typeof p === "object" &&
          (p as Record<string, unknown>)["type"] === "text" &&
          typeof (p as Record<string, unknown>)["text"] === "string"
        ) {
          texts.push((p as Record<string, unknown>)["text"] as string);
        }
      }
    }
    msgs.push({
      ...(typeof role === "string" ? { role } : {}),
      texts,
    });
  };
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item === null || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const info = rec["info"];
      push(
        info !== null && typeof info === "object"
          ? (info as Record<string, unknown>)["role"]
          : undefined,
        rec["parts"],
      );
    }
    return msgs;
  }
  if (payload !== null && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    const arr = rec["data"];
    if (Array.isArray(arr)) {
      for (const p of arr) push(undefined, [p]);
      return msgs;
    }
    if (Array.isArray(rec["parts"])) {
      push(undefined, rec["parts"]);
      return msgs;
    }
  }
  return msgs;
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

/** M8-1 a: pf_ tool part 의 도구 이름 */
export function pfToolName(p: unknown): string | undefined {
  if (!isPfToolPart(p)) return undefined;
  return String((p as Record<string, unknown>)["tool"] ?? "");
}

/**
 * M8-1 a: 기준점 이후의 **첫** 새 pf_* 호출 부분을 돌려준다(분류용).
 */
export function firstNewPfPart(
  parts: unknown[],
  before: Set<string>,
): unknown | undefined {
  for (const p of parts) {
    if (!isPfToolPart(p)) continue;
    if (before.has(JSON.stringify(p))) continue;
    return p;
  }
  return undefined;
}

/**
 * M8-1 a2: pf_* tool part 의 **입력** sessionId (모델이 어느 PF 세션으로
 * 부르고 있는지 — state.input.sessionId. 없으면 분류 불가).
 */
export function pfInputSessionId(p: unknown): string | undefined {
  const state = (p as Record<string, unknown> | undefined)?.state;
  if (state === null || typeof state !== "object") return undefined;
  const input = (state as Record<string, unknown>)["input"];
  if (input === null || typeof input !== "object") return undefined;
  const sid = (input as Record<string, unknown>)["sessionId"];
  return typeof sid === "string" && sid !== "" ? sid : undefined;
}

/**
 * M8-1 a+a2: 신호 이후 첫 pf_* 호출 분류.
 * pf_start → "새 세션을 시작함". pf_next/pf_report 의 입력 sessionId 가
 * 원래 sid 와 다르면 "다른 세션을 이어감(<id>)". 분류 불가(undefined)는 정상.
 */
export function classifyNewPfCall(
  part: unknown,
  pfSessionId: string | undefined,
): string | undefined {
  if (part === undefined) return undefined;
  const tool = (pfToolName(part) ?? "").toLowerCase();
  if (tool.includes("pf_start"))
    return "모델이 새 세션을 시작함(pf_start)";
  if (/pf_(next|report)/.test(tool) && pfSessionId !== undefined) {
    const inSid = pfInputSessionId(part);
    if (inSid !== undefined && inSid !== pfSessionId)
      return `모델이 다른 세션을 이어감(${inSid})`;
  }
  return undefined;
}

/** 최신 pf_start 기준 sessionId (latest-wins. 재연결 시 새 세션이 이긴다) */
export function readLatestPfSessionId(parts: unknown[]): string | undefined {
  return extractPfSessionId([...parts].reverse());
}

/**
 * M8-1 a: SSE 1순위 감지. GET /event에서 message.part.updated를 읽어
 * 기준점 이후의 **첫** 새 pf_* part 를 돌려준다(분류용).
 * 스트림 종료·에러·기한 초과는 undefined (폴링 폴백으로 넘긴다).
 */
async function sseNewPfCall(o: {
  baseUrl: string;
  sid: string;
  before: Set<string>;
  until: number;
  fetchImpl: typeof fetch;
}): Promise<unknown | undefined> {
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
    if (!r.ok || !r.body) return undefined;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      if (Date.now() >= o.until) return undefined;
      const { done, value } = await reader.read();
      if (done) return undefined;
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
          return part;
        } catch {
          // 다음 블록
        }
      }
    }
  } catch {
    return undefined;
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
/** M8-1-close a: 전송 판정 상한 (30초 이하). 모델 완료를 기다리지 않는다. */
export const SIGNAL_DECISION_CAP_MS = 30_000;
/** M8-1-close a: POST 대기 상한. 턴이 길면 끊고 보임으로 판정한다. */
export const SIGNAL_POST_TIMEOUT_MS = 10_000;

export async function sendContinue(opts: {
  baseUrl: string;
  openCodeSessionId?: string;
  text: string;
  mode: LinkMode;
  timeoutMs?: number;
  pollMs?: number;
  /** 연결의 OpenCode 버전 (연결의 clientInfo에서 호출자가 넣어라. 없으면 미확인→C) */
  serverVersion?: string;
  /** M8-1 a2: 신호 대상 PF 세션 id — pf_next/pf_report 입력 sessionId 비교용 */
  pfSessionId?: string;
  /** M8-1-close a: 전송 판정 상한 (기본 30초, timeoutMs보다 클 수 없다) */
  decisionMs?: number;
  /** M8-1-close a: POST 대기 상한 (기본 10초, decisionMs보다 클 수 없다) */
  postTimeoutMs?: number;
  deps: LinkDeps;
}): Promise<LinkResult> {
  const sid = opts.openCodeSessionId;
  const fail = (degraded: string): LinkResult => ({
    delivered: false,
    degraded,
    // M8-1: C = B (같은 문자열).
    copyText: opts.text,
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
  // M8-1-close a: 전송 판정은 30초 이하로 끝낸다 (모델 완료 대기 금지).
  // timeoutMs는 판정 뒤 백그라운드 감시 기한으로만 쓴다.
  const watchMs = clampTimeoutMs(opts.timeoutMs);
  const decisionMs = Math.min(
    opts.decisionMs ?? SIGNAL_DECISION_CAP_MS,
    SIGNAL_DECISION_CAP_MS,
    watchMs,
  );
  const decisionDeadline = Date.now() + decisionMs;
  const postTimeoutMs = Math.min(
    opts.postTimeoutMs ?? SIGNAL_POST_TIMEOUT_MS,
    decisionMs,
  );
  const pollMs = opts.pollMs ?? 1000;
  // M8-1-close a: 신호 user 메시지가 목록에 보이는지 (POST 응답과 무관하게).
  const seenSignalText = async (): Promise<boolean> => {
    if (!opts.deps.listMessages) return false;
    try {
      const msgs = await opts.deps.listMessages(ocSid);
      return msgs.some(
        (m) => m.role === "user" && m.texts.some((t) => t.includes(opts.text)),
      );
    } catch {
      return false;
    }
  };
  const seenPf = async (): Promise<unknown | undefined> => {
    try {
      return firstNewPfPart(await opts.deps.listParts(ocSid), before);
    } catch {
      return undefined;
    }
  };
  // M8-1-close2 b: 판정 뒤에도 pf_* 감시는 백그라운드로 계속한다.
  // 첫 호출은 기존 규칙으로 분류하고 onSignalWatch로 알린다 (반환값은 그대로).
  // watchMs 안에 없으면 "모델 무응답/plan 모드 의심".
  const watchInBackground = (): void => {
    const watch = async (): Promise<void> => {
      const until = Date.now() + Math.max(watchMs - decisionMs, 0);
      const first = await sseNewPfCall({
        baseUrl: base,
        sid: ocSid,
        before,
        until,
        fetchImpl: doFetch,
      });
      const part =
        first ??
        (await (async () => {
          for (;;) {
            const np = await seenPf();
            if (np !== undefined) return np;
            if (Date.now() >= until) return undefined;
            await new Promise((r) => setTimeout(r, pollMs));
          }
        })());
      if (part === undefined) {
        opts.deps.onSignalWatch?.({
          openCodeSessionId: ocSid,
          kind: "no-response",
          text: "모델 무응답/plan 모드 의심",
        });
        return;
      }
      try {
        const parts = await opts.deps.listParts(ocSid);
        const pfSid = readLatestPfSessionId(parts);
        if (pfSid) opts.deps.onPairing?.(ocSid, pfSid);
      } catch {
        // 무시
      }
      const warning = classifyNewPfCall(part, opts.pfSessionId);
      opts.deps.onSignalWatch?.({
        openCodeSessionId: ocSid,
        ...(warning !== undefined ? { kind: "warn", text: warning } : { kind: "ok" }),
      });
    };
    void watch().catch(() => {});
  };
  if (sigMode === "b") {
    // M7-1.1 실서버 확인 (1.18.18): POST /session/:id/message + {parts} → 200.
    // {"prompt":{...}} 래퍼는 이 경로에서 400 (래퍼는 /api/session/:id/prompt용).
    // M8-1-close a: POST는 턴이 끝날 때까지 물고 있어 짧게 끊는다.
    // (/api/session/:id/prompt는 즉시 200+steer지만 serve에서 모델이 안 움직인다.)
    // M8-1-close2 b: POST가 4xx/5xx로 즉시 실패하면 바로 전송 실패.
    // abort/타임아웃(응답 없음)만 보임 판정으로 넘긴다.
    // POST는 판정과 겹쳐서 둔다 (턴이 길면 abort만 하고 서버는 계속한다).
    let postOk = false;
    let postAnswered = false;
    let postDone = false;
    void (async () => {
      try {
        const r = await postJson(
          doFetch,
          `${base}/session/${ocSid}/message`,
          { parts: [{ type: "text", text: opts.text }] },
          { signal: AbortSignal.timeout(postTimeoutMs) },
        );
        postOk = r.ok;
        postAnswered = r.status !== undefined;
      } catch {
        postOk = false;
      } finally {
        postDone = true;
      }
    })();
    for (;;) {
      // 4xx/5xx 응답이 오면 즉시 실패 (보임 판정으로 넘기지 않는다).
      if (postDone && !postOk && postAnswered) return fail("전송 실패");
      const np = await seenPf();
      if (np !== undefined) return paired(np);
      if (await seenSignalText()) {
        watchInBackground();
        return { delivered: true, mode: sigMode, copyText: opts.text };
      }
      if (Date.now() >= decisionDeadline) {
        return fail(postOk ? "모델 무응답/plan 모드 의심" : "전송 미확인");
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  const ap = await postJson(doFetch, `${base}/tui/append-prompt`, {
    text: opts.text,
  });
  if (!ap.ok || ap.json !== true) return fail("append 실패");
  const sp = await postJson(doFetch, `${base}/tui/submit-prompt`, {});
  if (!sp.ok || sp.json !== true) return fail("submit 실패");
  const deadline = Date.now() + watchMs;
  // M7-ui1.1-6: SSE 1순위, messages 폴링은 폴백 (대용량 세션 빈 페이지 오탐 회피).
  // 신호 직후엔 이미 호출이 반영돼 있을 수 있어 1회 즉시 확인한다 (지연 최소화).
  try {
    const part = firstNewPfPart(await opts.deps.listParts(ocSid), before);
    if (part !== undefined) return paired(part);
  } catch {
    // 무시
  }
  const part = await sseNewPfCall({
    baseUrl: base,
    sid: ocSid,
    before,
    until: deadline,
    fetchImpl: doFetch,
  });
  if (part !== undefined) return paired(part);
  for (;;) {
    try {
      const np = firstNewPfPart(await opts.deps.listParts(ocSid), before);
      if (np !== undefined) return paired(np);
    } catch {
      // 폴링 실패 무시
    }
    if (Date.now() >= deadline) {
      return fail("모델 무응답/plan 모드 의심");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  /**
   * M8-1 a+a2: 신호 이후 첫 pf_* 호출을 분류한다.
   * pf_start → "새 세션을 시작함". pf_next/pf_report 의 입력 sessionId 가
   * 원래 PF 세션과 다르면 "다른 세션을 이어감(<id>)". 분류 불가는 정상.
   */
  async function paired(part: unknown): Promise<LinkResult> {
    // 짝짓기 갱신 (best-effort).
    try {
      const parts = await opts.deps.listParts(ocSid);
      const pfSid = readLatestPfSessionId(parts);
      if (pfSid) opts.deps.onPairing?.(ocSid, pfSid);
    } catch {
      // 무시
    }
    const warning = classifyNewPfCall(part, opts.pfSessionId);
    // M8-1-close2 b: 판정 시점에 본 첫 호출도 signals 기록에 남긴다.
    opts.deps.onSignalWatch?.({
      openCodeSessionId: ocSid,
      ...(warning !== undefined ? { kind: "warn", text: warning } : { kind: "ok" }),
    });
    return {
      delivered: true,
      mode: sigMode,
      copyText: opts.text,
      ...(warning !== undefined ? { warning } : {}),
    };
  }
}
