// M8-1-pair: 첫 짝 찾기 (사양 docs/M8-1-spec.md b2).
// 짝이 없을 때만 OpenCode 서버의 최근 세션 메시지에서 `<prefix>_pf_start` 서버 출력의
// sessionId 를 찾는다. 모델이 보낸 값·text 파트는 근거로 쓰지 않는다.

export type DiscoveryResult =
  | { status: "found"; openCodeSessionId: string }
  | { status: "none" }
  | { status: "ambiguous"; count: number }
  | { status: "unknown"; count: number; reason?: string };

/** 후보 세션 수 (최근 갱신 순) */
export const DISCOVERY_SESSION_LIMIT = 20;
/** 요청당 상한 */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 3000;
/** 찾기 전체 상한 */
export const DISCOVERY_TOTAL_TIMEOUT_MS = 10_000;
/** 메시지 페이지 크기 (실측: ?limit=N 동작, 다음 커서는 X-Next-Cursor 헤더) */
export const DISCOVERY_PAGE_LIMIT = 50;
/** 세션 하나당 페이지 상한 (넘으면 확인 못 함) */
const MAX_PAGES_PER_SESSION = 200;

export type DiscoveryOpts = {
  baseUrl: string;
  /** 대상 ProcForge 세션 id (짝을 찾을 PF 세션) */
  pfSessionId: string;
  /** 도구 접두어 (예: "procforge" → procforge_pf_start). 정규화된 값을 넘긴다 */
  toolPrefix?: string;
  fetchImpl?: typeof fetch;
};

/** 도구 파트가 completed `pf_start` 면 그 출력의 sessionId 를 돌려준다 (text 파트는 무시) */
export function pfStartOutputSessionId(
  part: unknown,
  toolPrefix: string | undefined,
): string | undefined {
  if (part === null || typeof part !== "object") return undefined;
  const rec = part as Record<string, unknown>;
  if (rec["type"] !== "tool") return undefined;
  const tool = String(rec["tool"] ?? "").toLowerCase();
  const prefix = (toolPrefix ?? "").trim().toLowerCase();
  const nameOk = prefix
    ? tool === `${prefix}_pf_start`
    : tool === "pf_start" || tool.endsWith("_pf_start");
  if (!nameOk) return undefined;
  const state = rec["state"];
  if (state === null || typeof state !== "object") return undefined;
  const st = state as Record<string, unknown>;
  if (st["status"] !== "completed") return undefined;
  if (typeof st["output"] !== "string") return undefined;
  try {
    const parsed = JSON.parse(st["output"]) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId !== ""
      ? parsed.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

/** 찾기 결과 → 전송하지 않는 사유 (found 면 undefined) */
export function discoveryDegraded(r: DiscoveryResult): string | undefined {
  switch (r.status) {
    case "found":
      return undefined;
    case "none":
      return "짝 세션 못 찾음";
    case "ambiguous":
      return `짝 모호(${r.count}개)`;
    case "unknown":
      return r.count > 0
        ? `짝 확인 불가(${r.count}개)`
        : `짝 확인 불가(${r.reason ?? "조회 실패"})`;
  }
}

export async function discoverPairing(o: DiscoveryOpts): Promise<DiscoveryResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  const deadline = Date.now() + DISCOVERY_TOTAL_TIMEOUT_MS;

  // 요청 1건: 3초 상한, 전체 10초 안에서만. 실패·타임아웃은 undefined.
  const get = async (url: string): Promise<Response | undefined> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    try {
      const r = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(DISCOVERY_REQUEST_TIMEOUT_MS, remaining)),
      });
      return r.ok ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const json = async (r: Response | undefined): Promise<unknown> => {
    if (!r) return undefined;
    try {
      return (await r.json()) as unknown;
    } catch {
      return undefined;
    }
  };

  // 1) 최근 갱신 순 후보 20개
  const list = await json(await get(`${base}/session`));
  if (!Array.isArray(list)) {
    return { status: "unknown", count: 0, reason: "세션 목록 조회 실패" };
  }
  const candidates = list
    .filter((s): s is { id: string; time?: { updated?: unknown } } =>
      s !== null && typeof s === "object" && typeof (s as { id?: unknown }).id === "string",
    )
    .sort((a, b) => updatedOf(b) - updatedOf(a))
    .slice(0, DISCOVERY_SESSION_LIMIT)
    .map((s) => s.id);

  // 2) 세션별 메시지 페이징. 끝까지 읽은 세션만 "확인함".
  const matches: string[] = [];
  let unknown = 0;
  for (const sid of candidates) {
    const verdict = await scanSession(sid);
    if (verdict === "unknown") unknown += 1;
    else if (verdict !== undefined) matches.push(verdict);
  }

  async function scanSession(sid: string): Promise<string | undefined | "unknown"> {
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_SESSION; page++) {
      const q = `?limit=${DISCOVERY_PAGE_LIMIT}` +
        (before !== undefined ? `&before=${encodeURIComponent(before)}` : "");
      const r = await get(`${base}/session/${encodeURIComponent(sid)}/message${q}`);
      if (!r) return "unknown";
      const arr = await json(r);
      if (!Array.isArray(arr)) return "unknown";
      for (const m of arr) {
        const parts = (m as { parts?: unknown } | null)?.parts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
          if (pfStartOutputSessionId(p, o.toolPrefix) === o.pfSessionId) return sid;
        }
      }
      const next = r.headers.get("x-next-cursor");
      if (!next) return undefined;
      before = next;
    }
    return "unknown";
  }

  if (unknown > 0) return { status: "unknown", count: unknown };
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) return { status: "ambiguous", count: matches.length };
  return { status: "found", openCodeSessionId: matches[0]! };
}

function updatedOf(s: { time?: { updated?: unknown } }): number {
  const v = s.time?.updated;
  return typeof v === "number" ? v : 0;
}
