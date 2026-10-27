// M8-1-pair: 첫 짝 찾기 (사양 docs/M8-1-spec.md b2).
// 짝이 없을 때만 OpenCode 서버의 최근 세션 메시지에서 `<prefix>_pf_start` 서버 출력의
// sessionId 를 찾는다. 모델이 보낸 값·text 파트는 근거로 쓰지 않는다.

export type DiscoveryResult =
  | { status: "found"; openCodeSessionId: string }
  | { status: "none" }
  | { status: "ambiguous"; count: number }
  /** 대상 PF 세션이 이 대화에 있었지만 지금 최신 pf_start 는 다른 PF 세션이다 */
  | { status: "busy"; count: number }
  | { status: "unknown"; count: number; reason?: string };

/** 후보 세션 수 (최근 갱신 순, PF 생성 이후 갱신분만) */
export const DISCOVERY_SESSION_LIMIT = 20;
/** 요청당 상한 */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 3000;
/** 찾기 전체 상한 */
export const DISCOVERY_TOTAL_TIMEOUT_MS = 10_000;
/**
 * 메시지 페이지 크기. 실측(5552, 2026-10-27): `?limit=N` 은 **최신** N개를 준다.
 * 페이지 안은 오래된 순이다. 다음(더 오래된) 쪽은 `before=<X-Next-Cursor 헤더>`.
 * `cursor=` 는 무시된다.
 */
export const DISCOVERY_PAGE_LIMIT = 50;
/** 세션 하나당 페이지 상한 (넘으면 확인 못 함) */
const MAX_PAGES_PER_SESSION = 200;
/**
 * PF 생성 시각보다 이만큼 앞선 메시지에서 읽기를 멈춘다. 메시지는 pf_start 를
 * 실행하기 **전에** 시작됐을 수 있다(모델이 생각하는 시간).
 */
export const DISCOVERY_CUTOFF_SKEW_MS = 10 * 60_000;

export type DiscoveryOpts = {
  baseUrl: string;
  /** 대상 ProcForge 세션 id (짝을 찾을 PF 세션) */
  pfSessionId: string;
  /** 도구 접두어 (예: "procforge" → procforge_pf_start). 정규화된 값을 넘긴다 */
  toolPrefix?: string;
  /** PF 세션 생성 시각 (epoch ms). 있으면 그 이전에 갱신된 OpenCode 세션은 건너뛴다 */
  pfCreatedAt?: number;
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
    case "busy":
      return "짝 대화가 다른 PF 세션 진행 중";
    case "unknown":
      return r.count > 0
        ? `짝 확인 불가(${r.count}개)`
        : `짝 확인 불가(${r.reason ?? "조회 실패"})`;
  }
}

type SessionVerdict = "match" | "busy" | "none" | "unknown";

export async function discoverPairing(o: DiscoveryOpts): Promise<DiscoveryResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  const deadline = Date.now() + DISCOVERY_TOTAL_TIMEOUT_MS;
  const cutoff =
    o.pfCreatedAt !== undefined ? o.pfCreatedAt - DISCOVERY_CUTOFF_SKEW_MS : undefined;

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

  // 1) 후보: PF 생성 이후 갱신된 세션(시각 없음은 후보 유지), 최근 갱신 순 20개
  const list = await json(await get(`${base}/session`));
  if (!Array.isArray(list)) {
    return { status: "unknown", count: 0, reason: "세션 목록 조회 실패" };
  }
  const candidates = list
    .filter((s): s is { id: string; time?: { updated?: unknown } } =>
      s !== null && typeof s === "object" && typeof (s as { id?: unknown }).id === "string",
    )
    .filter((s) => {
      const u = updatedOf(s);
      return cutoff === undefined || u === undefined || u >= cutoff;
    })
    .sort((a, b) => (updatedOf(b) ?? 0) - (updatedOf(a) ?? 0))
    .slice(0, DISCOVERY_SESSION_LIMIT)
    .map((s) => s.id);

  // 2) 세션별: 최신부터 훑어 **가장 마지막 completed pf_start** 가 대상인지 본다.
  const verdicts: SessionVerdict[] = [];
  for (const sid of candidates) verdicts.push(await scanSession(sid));

  const matches = verdicts.filter((v) => v === "match").length;
  const busy = verdicts.filter((v) => v === "busy").length;
  const unknown = verdicts.filter((v) => v === "unknown").length;
  if (unknown > 0) return { status: "unknown", count: unknown };
  if (busy > 0) return { status: "busy", count: busy };
  if (matches === 0) return { status: "none" };
  if (matches > 1) return { status: "ambiguous", count: matches };
  return { status: "found", openCodeSessionId: candidates[verdicts.indexOf("match")]! };

  async function scanSession(sid: string): Promise<SessionVerdict> {
    let before: string | undefined;
    let latest: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES_PER_SESSION; page++) {
      const q =
        `?limit=${DISCOVERY_PAGE_LIMIT}` +
        (before !== undefined ? `&before=${encodeURIComponent(before)}` : "");
      const r = await get(`${base}/session/${encodeURIComponent(sid)}/message${q}`);
      if (!r) return "unknown";
      const arr = await json(r);
      if (!Array.isArray(arr)) return "unknown";
      // 페이지는 오래된 순 → 뒤에서부터(최신 → 과거) 본다
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i] as { info?: { time?: { created?: unknown } }; parts?: unknown } | null;
        const created = m?.info?.time?.created;
        if (cutoff !== undefined && typeof created === "number" && created < cutoff) {
          return "none"; // PF 생성보다 충분히 오래된 메시지: 여기서 멈춘다
        }
        if (!Array.isArray(m?.parts)) continue;
        for (let j = m.parts.length - 1; j >= 0; j--) {
          const out = pfStartOutputSessionId(m.parts[j], o.toolPrefix);
          if (out === undefined) continue;
          if (latest === undefined) latest = out; // 처음 만난 것이 가장 최신
          if (out === o.pfSessionId) return latest === o.pfSessionId ? "match" : "busy";
        }
      }
      const next = r.headers.get("x-next-cursor");
      if (!next) return "none";
      if (seenCursors.has(next)) return "unknown"; // 같은 커서 반복 = 진행 없음
      seenCursors.add(next);
      before = next;
    }
    return "unknown";
  }
}

function updatedOf(s: { time?: { updated?: unknown } }): number | undefined {
  const v = s.time?.updated;
  return typeof v === "number" ? v : undefined;
}
