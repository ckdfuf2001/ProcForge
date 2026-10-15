// M7-1: UI→OpenCode 연결 (B/A/C).
// 상태 변경은 pf_advise(App)로만 하고, 여기는 "계속하라" 신호 전달이다 (R1~R4).

export type LinkMode = "b" | "a" | "c";

export type LinkResult =
  | { delivered: true; mode: "b" | "a" }
  | { delivered: false; degraded: string; copyText: string };

export type LinkDeps = {
  fetchImpl?: typeof fetch;
  /** 해당 OpenCode 세션에 pf_* 호출이 관측되는지 (폴링 주입) */
  hasPfCall: (openCodeSessionId: string) => Promise<boolean>;
  /** 최신 ProcForge sessionId 추출 (주입. messages/export 훑기) */
  readPfSessionId: (openCodeSessionId: string) => Promise<string | undefined>;
  /** 짝짓기 갱신 (주입. savePairing) */
  onPairing?: (openCodeSessionId: string, pfSessionId: string) => void;
};

const CONTINUE_COPY_FALLBACK = "OpenCode에서 '계속'이라고 입력하세요.";

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
 * "계속" 신호 전송. B(session/:id/message, 기본) > A(tui append+submit,
 * attach된 TUI 있을 때만) > C(문구만). 신호 후 timeoutMs 안에 pf_* 출현이
 * 없으면 degraded("모델 무응답/plan 모드 의심")+C 문구.
 */
export async function sendContinue(opts: {
  baseUrl: string;
  openCodeSessionId?: string;
  text: string;
  mode: LinkMode;
  timeoutMs?: number;
  pollMs?: number;
  deps: LinkDeps;
}): Promise<LinkResult> {
  const sid = opts.openCodeSessionId;
  const fail = (degraded: string): LinkResult => ({
    delivered: false,
    degraded,
    copyText: `${opts.text}\n${CONTINUE_COPY_FALLBACK}`,
  });
  if (!sid || opts.mode === "c") return fail("연결 없음");
  const doFetch = opts.deps.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  if (opts.mode === "b") {
    const r = await postJson(doFetch, `${base}/session/${sid}/message`, {
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
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await opts.deps.hasPfCall(sid)) break;
    } catch {
      // 폴링 실패 무시
    }
    if (Date.now() >= deadline) {
      return fail("모델 무응답/plan 모드 의심");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // 짝짓기 갱신 (best-effort).
  try {
    const pfSid = await opts.deps.readPfSessionId(sid);
    if (pfSid) opts.deps.onPairing?.(sid, pfSid);
  } catch {
    // 무시
  }
  return { delivered: true, mode: opts.mode };
}
