import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "@procforge/shared/schema.js";
import { EventEntrySchema, type EventEntry } from "@procforge/shared/dto.js";
import { FileStore } from "./filestore.js";

// pf_* 호출 기록 + 세션 추적 (M3.5 dogfood 측정 지원).

export type TraceEvent = {
  at: string;
  tool: string;
  sessionId: string;
  nodeId?: string;
  ok: boolean;
};

export function eventsFile(procforgeDir: string, sessionId: string): string {
  return join(procforgeDir, "sessions", sessionId, "events.jsonl");
}

/** 호출 기록 파일 (M4.2-0.5-3, R7: events.jsonl은 상태 이벤트 전용) */
export function callsFile(procforgeDir: string, sessionId: string): string {
  return join(procforgeDir, "sessions", sessionId, "calls.jsonl");
}

/**
 * 구 혼합 events.jsonl 1회 분리 마이그레이션 (M4.2-0.5-3).
 * TraceEvent형 줄은 calls.jsonl로 옮기고 events.jsonl에는 나머지만 둔다.
 * 멱등 (이미 분리됐으면 쓰기 없음).
 */
export function migrateCallLog(procforgeDir: string, sessionId: string): void {
  const ep = eventsFile(procforgeDir, sessionId);
  if (!existsSync(ep)) return;
  const keep: string[] = [];
  const move: string[] = [];
  for (const line of readFileSync(ep, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { tool?: unknown };
      if (parsed && typeof parsed.tool === "string") move.push(t);
      else keep.push(t);
    } catch {
      keep.push(t);
    }
  }
  if (move.length === 0) return;
  const cp = callsFile(procforgeDir, sessionId);
  mkdirSync(dirname(cp), { recursive: true });
  appendFileSync(cp, move.join("\n") + "\n");
  writeFileSync(ep, keep.length > 0 ? keep.join("\n") + "\n" : "");
}

export function logEvent(procforgeDir: string, e: TraceEvent): void {
  try {
    migrateCallLog(procforgeDir, e.sessionId);
    const p = callsFile(procforgeDir, e.sessionId);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(e) + "\n");
  } catch {
    // 추적 실패는 본 동작에 영향 없음
  }
}

export function readEvents(procforgeDir: string, sessionId: string): TraceEvent[] {
  migrateCallLog(procforgeDir, sessionId);
  const p = callsFile(procforgeDir, sessionId);
  if (!existsSync(p)) return [];
  const out: TraceEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as TraceEvent;
      // M4.2-0: 상태 이벤트(R7)와 공존 — tool 호출 기록만 집계
      if (typeof parsed.tool !== "string") continue;
      out.push(parsed);
    } catch {
      // 손상 줄 무시
    }
  }
  return out;
}

/**
 * 상태 변경 이벤트 append (M4.2-0.5, R7). seq == revision (호출자가 전달).
 * 호출 추적(TraceEvent)과 같은 events.jsonl에 공존한다.
 * R7: 기록 실패를 삼키지 않는다.
 */
export function appendStateEvent(
  procforgeDir: string,
  sessionId: string,
  entry: Omit<EventEntry, "seq" | "at"> & { at?: string },
): EventEntry {
  const full = EventEntrySchema.parse({ ...entry, seq: entry.revision, at: entry.at ?? new Date().toISOString() });
  migrateCallLog(procforgeDir, sessionId);
  const p = eventsFile(procforgeDir, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(full) + "\n");
  return full;
}

/** R7 상태 이벤트만 읽기 */
export function readStateEvents(procforgeDir: string, sessionId: string): EventEntry[] {
  migrateCallLog(procforgeDir, sessionId);
  const p = eventsFile(procforgeDir, sessionId);
  if (!existsSync(p)) return [];
  const out: EventEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = EventEntrySchema.safeParse(JSON.parse(t));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // 손상 줄 무시
    }
  }
  return out;
}

export type TraceReport = {
  sessionId: string;
  request: string;
  params: Record<string, string>;
  createdAt: string;
  done: boolean;
  callsTotal: number;
  callsByTool: Record<string, number>;
  nodesTotal: number;
  maxDepth: number;
  statusCounts: Record<string, number>;
  needsHumanNodes: string[];
  nodes: {
    id: string;
    goal: string;
    status: string;
    attempts: { at: string; tool: string; verdict?: string; failedConstraints: string[] }[];
    advice: { at: string; text: string }[];
    constraints: { id: string; kind: string; source: string }[];
    golden: boolean;
    firstAt?: string;
    lastAt?: string;
  }[];
  firstAt?: string;
  lastAt?: string;
};

export function buildTrace(procforgeDir: string, sessionId: string): TraceReport {
  const store = new FileStore(procforgeDir);
  const session = store.getSession(sessionId);
  if (!session) throw Object.assign(new Error(`세션 없음: ${sessionId}`), { code: "session_not_found" });
  const nodes = [...store.getNodes(sessionId).values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const events = readEvents(procforgeDir, sessionId);
  const callsByTool: Record<string, number> = {};
  for (const e of events) callsByTool[e.tool] = (callsByTool[e.tool] ?? 0) + 1;
  // events 누락 시 노드 기록에서 복원
  const fallbackCalls = nodes.reduce((n, x) => n + x.attempts.length + x.advice.length, 0);
  const statusCounts: Record<string, number> = {};
  let maxDepth = 0;
  const details = nodes.map((n) => {
    statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1;
    if (n.depth > maxDepth) maxDepth = n.depth;
    const times = [...n.attempts.map((a) => a.at), ...n.advice.map((a) => a.at)].sort();
    return {
      id: n.id,
      goal: n.goal,
      status: n.status,
      attempts: n.attempts.map((a) => ({
        at: a.at,
        tool: `${a.tool.server}/${a.tool.name}`,
        verdict: a.verdict,
        failedConstraints: a.failedConstraints,
      })),
      advice: n.advice,
      constraints: n.constraints.map((c) => ({ id: c.id, kind: c.kind, source: c.source })),
      golden: !!n.golden,
      firstAt: times[0],
      lastAt: times[times.length - 1],
    };
  });
  const allTimes = details.flatMap((d) => [d.firstAt, d.lastAt].filter(Boolean) as string[]).sort();
  const needsHumanNodes = nodes.filter((n) => n.advice.length > 0).map((n) => n.id);
  const openNodes = nodes.filter((n) => n.status === "open" || n.status === "probing" || n.status === "needs_human");
  return {
    sessionId,
    request: (session as Session).request,
    params: (session as Session).params,
    createdAt: (session as Session).createdAt,
    done: openNodes.length === 0,
    callsTotal: events.length > 0 ? events.length : fallbackCalls,
    callsByTool,
    nodesTotal: nodes.length,
    maxDepth,
    statusCounts,
    needsHumanNodes,
    nodes: details as TraceReport["nodes"],
    firstAt: allTimes[0],
    lastAt: allTimes[allTimes.length - 1],
  };
}

export function formatTraceMarkdown(r: TraceReport): string {
  const L: string[] = [];
  L.push(`# trace ${r.sessionId}`, ``);
  L.push(`- request: ${r.request}`);
  L.push(`- params: ${JSON.stringify(r.params)}`);
  L.push(`- createdAt: ${r.createdAt}`);
  L.push(`- done: ${r.done}`);
  L.push(`- pf_* 호출 수: ${r.callsTotal} ${JSON.stringify(r.callsByTool)}`);
  L.push(`- 노드 수: ${r.nodesTotal}, 최대 깊이: ${r.maxDepth}, 상태: ${JSON.stringify(r.statusCounts)}`);
  L.push(`- 사람 개입 노드: ${r.needsHumanNodes.join(", ") || "없음"}`);
  L.push(`- 기간: ${r.firstAt ?? "-"} → ${r.lastAt ?? "-"}`);
  L.push(``, `## 노드`);
  for (const n of r.nodes) {
    L.push(`- ${n.id} [${n.status}] ${n.goal}`);
    for (const a of n.attempts) {
      L.push(`  - 시도 ${a.at} ${a.tool} verdict=${a.verdict ?? "-"} failed=[${a.failedConstraints.join(",")}]`);
    }
    for (const ad of n.advice) L.push(`  - 조언 ${ad.at}: ${ad.text}`);
    if (n.constraints.length > 0) L.push(`  - 조건: ${n.constraints.map((c) => `${c.id}/${c.kind}/${c.source}`).join(", ")}`);
    if (n.golden) L.push(`  - golden 있음`);
  }
  L.push(``, `## M3.5 측정행`);
  L.push(`| 완주 | 호출 수 | 노드/깊이 | needs_human | 소요 |`);
  L.push(`|---|---|---|---|---|`);
  L.push(`| ${r.done ? "Y" : "N"} | ${r.callsTotal} | ${r.nodesTotal}/${r.maxDepth} | ${r.needsHumanNodes.join(", ") || "-"} | ${r.firstAt ?? "-"}→${r.lastAt ?? "-"} |`);
  L.push(`| 지시불이행(수동) | argSpecs정확도(수동) | 토큰(수동) | 압축후행동(수동) |`);
  L.push(`| TODO | TODO | TODO | TODO |`);
  return L.join("\n") + "\n";
}
