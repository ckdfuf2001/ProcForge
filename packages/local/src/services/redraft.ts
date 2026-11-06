import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pfError } from "@proof/shared/errors.js";

// M10-2: 재분석 초안 생성 (App 메서드 경유, MCP 표면 불변).
// 입력 절차서를 .procforge/drafts/<draftId>/에 복사하고,
// OpenCode 세션에 prompt_async(도구 비활성)로 diff 초안을 요청한다.
// JSON ops만 받는다 (edit_goal/edit_arg). 노드 추가·삭제나 스키마 불일치는
// rejected (사유: "새 분해 필요" 또는 검증 오류 원문). 재시도 없음.
// session.error나 대기 시간 초과는 즉시 failed. 권한 응답은 보내지 않는다
// (불변 규칙: Proof는 always로 응답하지 않는다).

/** idle 대기 상한 (M10-2, 상수). 넘기면 failed. */
export const REDRAFT_IDLE_TIMEOUT_MS = 120000;

export type DraftOp =
  | { op: "edit_goal"; nodeId: string; goal: string }
  | { op: "edit_arg"; nodeId: string; arg: string; value: unknown };

export type DraftStatus = "ready" | "rejected" | "failed";

export type DraftDiffEntry = {
  nodeId: string;
  kind: "goal" | "arg";
  before: string;
  after: string;
};

export type RedraftResult = {
  draftId: string;
  dir: string;
  procedure: string;
  request: string;
  sourceHash: string;
  openCodeSessionId: string | null;
  status: DraftStatus;
  ops: DraftOp[];
  diff: DraftDiffEntry[];
  reason?: string;
  at: string;
};

type DocNode = {
  id?: unknown;
  goal?: unknown;
  args?: Record<string, unknown>;
};

function fail(
  base: Omit<RedraftResult, "status" | "ops" | "diff" | "reason"> & { openCodeSessionId: string | null },
  reason: string,
): RedraftResult {
  return { ...base, status: "failed", ops: [], diff: [], reason };
}

function reject(
  base: Omit<RedraftResult, "status" | "ops" | "diff" | "reason"> & { openCodeSessionId: string | null },
  ops: DraftOp[],
  reason: string,
): RedraftResult {
  return { ...base, status: "rejected", ops, diff: [], reason };
}

/** ops 배열 검증. 통과분만 반환하고, 실패 사유를 함께 준다. */
function validateOps(
  raw: unknown,
  nodes: Map<string, DocNode>,
): { ops: DraftOp[]; diff: DraftDiffEntry[] } | { error: string } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ops?: unknown }).ops)) {
    return { error: "응답에 ops 배열이 없음" };
  }
  const ops: DraftOp[] = [];
  const diff: DraftDiffEntry[] = [];
  for (const o of (raw as { ops: unknown[] }).ops) {
    if (!o || typeof o !== "object") return { error: `op 형식 오류: ${JSON.stringify(o)?.slice(0, 120)}` };
    const oo = o as Record<string, unknown>;
    if (oo.op !== "edit_goal" && oo.op !== "edit_arg") {
      return { error: `새 분해 필요: 지원하지 않는 op (${String(oo.op)})` };
    }
    if (typeof oo.nodeId !== "string" || oo.nodeId.length === 0) {
      return { error: `op에 nodeId 없음: ${JSON.stringify(o).slice(0, 120)}` };
    }
    const node = nodes.get(oo.nodeId);
    if (!node) return { error: `없는 노드: ${oo.nodeId}` };
    if (oo.op === "edit_goal") {
      if (typeof oo.goal !== "string" || oo.goal.length === 0) {
        return { error: `edit_goal에 goal 없음: ${oo.nodeId}` };
      }
      ops.push({ op: "edit_goal", nodeId: oo.nodeId, goal: oo.goal });
      diff.push({
        nodeId: oo.nodeId,
        kind: "goal",
        before: typeof node.goal === "string" ? node.goal : "",
        after: oo.goal,
      });
    } else {
      if (typeof oo.arg !== "string" || oo.arg.length === 0) {
        return { error: `edit_arg에 arg 없음: ${oo.nodeId}` };
      }
      if (!("value" in oo)) return { error: `edit_arg에 value 없음: ${oo.nodeId}` };
      ops.push({ op: "edit_arg", nodeId: oo.nodeId, arg: oo.arg, value: oo.value });
      diff.push({
        nodeId: oo.nodeId,
        kind: "arg",
        before: JSON.stringify((node.args ?? {})[oo.arg] ?? null),
        after: JSON.stringify(oo.value),
      });
    }
  }
  return { ops, diff };
}

type SseEvent = { t: string; p: Record<string, unknown> };

async function readSse(
  baseUrl: string,
  headers: Record<string, string>,
  onEvent: (e: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const r = await fetch(`${baseUrl}/event`, { headers: { accept: "text/event-stream", ...headers }, signal });
  if (!r.ok || !r.body) throw new Error(`SSE 연결 실패: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let cur: { type?: string; data?: string } = {};
  const flush = (): void => {
    if (cur.data !== undefined) {
      try {
        const j = JSON.parse(cur.data) as { type?: unknown; properties?: unknown };
        if (j && typeof j.type === "string") {
          onEvent({
            t: j.type,
            p: (j.properties ?? {}) as Record<string, unknown>,
          });
          cur = {};
          return;
        }
      } catch {
        // JSON 아님 — 무시
      }
      onEvent({ t: cur.type ?? "message", p: { raw: cur.data } });
    }
    cur = {};
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") flush();
      else if (line.startsWith("type:")) cur.type = line.slice(5).trim();
      else if (line.startsWith("data:")) cur.data = (cur.data ?? "") + line.slice(5).trim();
    }
  }
}

function authHeaders(password?: string): Record<string, string> {
  if (!password) return {};
  return {
    // M10-0 실측: 사용자명 기본값 "opencode".
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };
}

/** Basic auth 헤더 (app.createRedraft의 모델 조회와 공용). */
export function openCodeAuthHeaders(password?: string): Record<string, string> {
  return authHeaders(password);
}

async function api(
  baseUrl: string,
  headers: Record<string, string>,
  path: string,
  init?: { method?: string; body?: string },
): Promise<{ status: number; json: unknown; text: string }> {
  const r = await fetch(baseUrl + path, {
    ...init,
    headers: { "content-type": "application/json", ...headers },
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML 등은 원문 유지
  }
  return { status: r.status, json, text };
}

export async function runRedraft(input: {
  procforgeDir: string;
  procedure: string;
  request: string;
  openCode: { baseUrl: string; password?: string; model: { providerID: string; modelID: string } };
  idleTimeoutMs?: number;
}): Promise<RedraftResult> {
  const baseUrl = input.openCode.baseUrl.replace(/\/$/, "");
  if (!baseUrl) throw pfError("bad_request", "OpenCode 서버 주소 없음 (PROOF_OPENCODE_URL)");
  const dir = join(input.procforgeDir, "procedures", input.procedure);
  const srcFile = join(dir, "procedure.json");
  if (!existsSync(srcFile)) throw pfError("not_found", `절차서 없음: ${input.procedure}`);
  const raw = readFileSync(srcFile, "utf8");
  let doc: { nodes?: DocNode[] };
  try {
    doc = JSON.parse(raw) as { nodes?: DocNode[] };
  } catch {
    throw pfError("bad_request", `procedure.json 파싱 실패: ${input.procedure}`);
  }
  const nodes = new Map<string, DocNode>();
  for (const n of doc.nodes ?? []) {
    if (n && typeof n.id === "string") nodes.set(n.id, n);
  }
  const draftId = randomUUID();
  const draftDir = join(input.procforgeDir, "drafts", draftId);
  mkdirSync(draftDir, { recursive: true });
  // 원본 복사 (바이트 동일 — 무손상 증명용).
  copyFileSync(srcFile, join(draftDir, "procedure.json"));
  const sourceHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const base = {
    draftId,
    dir: draftDir,
    procedure: input.procedure,
    request: input.request,
    sourceHash,
    at: new Date().toISOString(),
  };
  const save = (r: RedraftResult): RedraftResult => {
    writeFileSync(join(draftDir, "draft.json"), JSON.stringify(r, null, 2));
    return r;
  };
  const headers = authHeaders(input.openCode.password);
  const timeoutMs = input.idleTimeoutMs ?? REDRAFT_IDLE_TIMEOUT_MS;
  // 1. 세션 생성.
  let sessionId: string;
  try {
    const c = await api(baseUrl, headers, "/session", {
      method: "POST",
      body: JSON.stringify({ title: `redraft:${input.procedure}` }),
    });
    const id = (c.json as { id?: unknown } | null)?.id;
    if (c.status !== 200 || typeof id !== "string") {
      return save({ ...base, openCodeSessionId: null, status: "failed", ops: [], diff: [], reason: `세션 생성 실패: ${c.status}` });
    }
    sessionId = id;
  } catch (e) {
    return save({ ...base, openCodeSessionId: null, status: "failed", ops: [], diff: [], reason: `세션 생성 실패: ${e instanceof Error ? e.message : String(e)}` });
  }
  const base2 = { ...base, openCodeSessionId: sessionId };
  // 2. prompt_async (도구 비활성 — M10-0 §3 실측 형식).
  const events: SseEvent[] = [];
  const ctl = new AbortController();
  const sub = readSse(baseUrl, headers, (e) => events.push(e), ctl.signal).catch(() => undefined);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const p = await api(baseUrl, headers, `/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model: input.openCode.model,
        tools: { edit: false, write: false, apply_patch: false, bash: false },
        parts: [
          {
            type: "text",
            text:
              `다음 요청을 반영한 절차서 변경분을 JSON ops로만 답해라 (설명 금지).\n` +
              `요청: ${input.request}\n` +
              `허용 op: {"op":"edit_goal","nodeId":"...","goal":"..."}, {"op":"edit_arg","nodeId":"...","arg":"...","value":...}.\n` +
              `형식: {"ops":[...]}`,
          },
        ],
      }),
    });
    if (p.status !== 204) {
      return save({ ...base2, status: "failed", ops: [], diff: [], reason: `prompt_async 실패: ${p.status}` });
    }
    // 3. idle 대기 (session.error 즉시 실패 — 재시도 없음).
    const t0 = Date.now();
    for (;;) {
      const err = events.find((e) => e.t === "session.error" && (e.p.sessionID === sessionId || e.p.info === undefined));
      const errMsg = err
        ? ((err.p.error as { message?: unknown } | undefined)?.message ?? JSON.stringify(err.p.error ?? err.p).slice(0, 200))
        : null;
      if (err && typeof errMsg === "string") {
        return save({ ...base2, status: "failed", ops: [], diff: [], reason: `session.error: ${String(errMsg).slice(0, 200)}` });
      }
      if (events.some((e) => e.t === "session.idle" && e.p.sessionID === sessionId)) break;
      if (Date.now() - t0 > timeoutMs) {
        return save({ ...base2, status: "failed", ops: [], diff: [], reason: `idle 대기 초과(${timeoutMs}ms)` });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // 4. 응답 조회 → JSON ops 파싱.
    const m = await api(baseUrl, headers, `/session/${sessionId}/message`);
    const list = (Array.isArray(m.json) ? m.json : []) as {
      info?: { role?: string };
      parts?: { type?: string; text?: string }[];
    }[];
    const texts = list
      .filter((x) => x.info?.role === "assistant")
      .flatMap((x) => x.parts ?? [])
      .filter((x) => x.type === "text" && typeof x.text === "string" && x.text.length > 0)
      .map((x) => (x as { text: string }).text);
    if (texts.length === 0) {
      return save({ ...base2, status: "rejected", ops: [], diff: [], reason: "assistant 텍스트 없음" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(texts[texts.length - 1]);
    } catch {
      return save({ ...base2, status: "rejected", ops: [], diff: [], reason: "응답이 JSON 아님" });
    }
    const v = validateOps(parsed, nodes);
    if ("error" in v) {
      return save({ ...base2, status: "rejected", ops: [], diff: [], reason: v.error });
    }
    return save({ ...base2, status: "ready", ops: v.ops, diff: v.diff });
  } finally {
    ctl.abort();
    try {
      await sub;
    } catch {
      // 무시
    }
  }
}
