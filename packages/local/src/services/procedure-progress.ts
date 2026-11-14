// M11-1: 절차서별 실행 결과 기반 진행률 (읽기 전용 집계).
// - 대상: procedures/<name>/procedure.json 의 leaf 노드 전체 (children.length === 0).
// - 완료: 최신 live run runs/<runId>/report.json 의 results[] 에서 pass 인 leaf.
// - 미완료: 그 밖의 leaf(fail, skip, 미도달) + 현재 승인 hash 무효 노드.
// - live run 0회면 progress null ("실행 기록 없음", 0%로 표시 금지).
// - latest.json 은 live 외 mode 에서도 갱신되므로 쓰지 않는다 (runner/run.ts).
// - 읽기 전용: 파일 쓰기 0건, 잠금 없음. report.json 파손 시 warn 1줄 후 null.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROCEDURE_NAME_RE } from "@proof/shared/procedure.js";
import { logger } from "../logger.js";
import { eventsLogPath } from "./events-log.js";
import { loadProcedureDoc } from "../runner/procedure-run.js";
import type { RunReport } from "../runner/types.js";
import {
  approvalPins,
  loadApprovals,
  toHashable,
} from "./approvals.js";
import { loadAccumulateFromProcedure } from "./accumulate.js";
import { readSandboxed } from "./approval-scripts.js";

export type ProcedureProgress = {
  name: string;
  leaves: number;
  done: number;
  remaining: string[];
  needsReapproval: string[];
  progress: number | null;
  runId: string | null;
};

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// events.ndjson 의 run_end(mode:live) runId (파일 순서 = 오래된 순, 뒤집어 최신순).
function liveRunIdsFromEvents(procforgeDir: string, procedure: string): string[] {
  let text: string;
  try {
    text = readFileSync(eventsLogPath(procforgeDir, procedure), "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const ev = JSON.parse(line) as { kind?: unknown; mode?: unknown; runId?: unknown };
      if (
        ev.kind === "run_end" &&
        ev.mode === "live" &&
        typeof ev.runId === "string" &&
        ev.runId.length > 0
      ) {
        ids.push(ev.runId);
      }
    } catch {
      // 손상 줄 건너뜀 (집계는 멈추지 않는다).
    }
  }
  return ids.reverse();
}

function readLiveReport(procforgeDir: string, runId: string): RunReport | undefined {
  const parsed = readJson(join(procforgeDir, "runs", runId, "report.json")) as Partial<RunReport> | undefined;
  if (!parsed || typeof parsed !== "object") return undefined;
  if (parsed.mode !== "live") return undefined;
  if (parsed.runId !== runId || !Array.isArray(parsed.results)) return undefined;
  return parsed as RunReport;
}

// runs/ 스캔 fallback (events 기록이 유실된 경우).
// state.json procedure 일치 + report.json mode live, at 최신순.
function liveRunIdsFromScan(procforgeDir: string, procedure: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(procforgeDir, "runs"));
  } catch {
    return [];
  }
  const cands: { runId: string; at: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "by-procedure" || name === "by-session") continue;
    const st = readJson(join(procforgeDir, "runs", name, "state.json")) as
      | { procedure?: unknown }
      | undefined;
    if (!st || st.procedure !== procedure) continue;
    const rep = readLiveReport(procforgeDir, name);
    if (!rep) continue;
    cands.push({ runId: name, at: typeof rep.at === "string" ? rep.at : "" });
  }
  cands.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return cands.map((c) => c.runId);
}

// 승인 hash 무효 leaf (approvalHash 일치 기준 — App.hasCurrentApproval 과 같은 판정).
function staleApprovalLeaves(procDir: string, doc: { nodes: { id: string; parentId: string | null; goal: string; tool?: { server: string; name: string }; args?: Record<string, unknown>; constraints?: unknown[]; sideEffect?: unknown; map?: unknown; until?: unknown; kind?: string; children: string[] }[] }): string[] {
  let approvals: ReturnType<typeof loadApprovals>;
  try {
    approvals = loadApprovals(procDir);
  } catch {
    approvals = [];
  }
  const hashable = new Map(doc.nodes.map((n) => [n.id, toHashable(n)] as const));
  let accumulate: ReturnType<typeof loadAccumulateFromProcedure> | undefined;
  try {
    accumulate = loadAccumulateFromProcedure(procDir);
  } catch {
    accumulate = undefined;
  }
  const readScript = (rel: string): string | undefined => {
    try {
      return readSandboxed(procDir, rel);
    } catch {
      return undefined;
    }
  };
  const out: string[] = [];
  for (const n of doc.nodes) {
    if ((n.children ?? []).length > 0) continue;
    // 승인 불필요 노드(external·script 아님)는 유효로 취급 (checkGuideApproval 과 같은 기준).
    const args = (n.args ?? {}) as Record<string, unknown>;
    const isExternal = n.sideEffect === "external";
    const hasScript = Object.values(args).some(
      (a) => typeof a === "object" && a !== null && (a as { kind?: unknown }).kind === "script",
    );
    if (!n.tool || (!isExternal && !hasScript)) continue;
    const byId = new Map(doc.nodes.map((x) => [x.id, x]));
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const pins = approvalPins(
      { id: n.id, parentId: n.parentId },
      parent && (parent.kind === "map" || parent.kind === "until")
        ? { id: parent.id, hash: "", kind: parent.kind }
        : undefined,
      hashable,
      readScript,
      accumulate,
    );
    const ok = approvals.some((e) =>
      pins.some(
        (p) =>
          p.id === e.node.id &&
          typeof e.approvalHash === "string" &&
          e.approvalHash.length > 0 &&
          e.approvalHash === p.approvalHash,
      ),
    );
    if (!ok) out.push(n.id);
  }
  return out;
}

export function listProcedureProgress(procforgeDir: string): ProcedureProgress[] {
  let names: string[];
  try {
    names = readdirSync(join(procforgeDir, "procedures"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: ProcedureProgress[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    if (!PROCEDURE_NAME_RE.test(name)) continue;
    let doc: { nodes: { id: string; parentId: string | null; goal: string; tool?: { server: string; name: string }; args?: Record<string, unknown>; constraints?: unknown[]; sideEffect?: unknown; map?: unknown; until?: unknown; kind?: string; children: string[] }[] };
    try {
      doc = loadProcedureDoc(procforgeDir, name).doc as typeof doc;
    } catch {
      continue;
    }
    const procDir = join(procforgeDir, "procedures", name);
    const leafIds = doc.nodes
      .filter((n) => (n.children ?? []).length === 0)
      .map((n) => n.id);
    const invalid = new Set(staleApprovalLeaves(procDir, doc));
    // 최신 live run 확정 (events 우선, runs 스캔 보조, report.json 으로 검증).
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const id of [...liveRunIdsFromEvents(procforgeDir, name), ...liveRunIdsFromScan(procforgeDir, name)]) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(id);
    }
    let report: RunReport | undefined;
    let liveRunId: string | null = null;
    let warned = false;
    for (const id of candidates) {
      const r = readLiveReport(procforgeDir, id);
      if (r) {
        report = r;
        liveRunId = id;
        break;
      }
      if (!warned) {
        warned = true;
        logger.warn(`progress: live report 읽기 실패 (${name}/${id}) — progress null`);
      }
    }
    const statusOf = new Map((report?.results ?? []).map((r) => [r.nodeId, r.status]));
    let done = 0;
    const remaining: string[] = [];
    for (const id of leafIds) {
      if (statusOf.get(id) === "pass" && !invalid.has(id)) done++;
      else remaining.push(id);
    }
    out.push({
      name,
      leaves: leafIds.length,
      done,
      remaining,
      needsReapproval: leafIds.filter((id) => invalid.has(id)),
      progress: liveRunId === null || leafIds.length === 0 ? null : done / leafIds.length,
      runId: liveRunId,
    });
  }
  return out;
}