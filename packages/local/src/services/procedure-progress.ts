// M11-1: 절차서별 실행 결과 기반 진행률 (읽기 전용 집계).
// - 대상: procedures/<name>/procedure.json 의 leaf 노드 전체 (children.length === 0).
// - 완료: 최신 live run runs/<runId>/report.json 의 results[] 에서 pass 인 leaf.
// - 미완료: 그 밖의 leaf(fail, skip, 미도달) + 현재 승인 hash 무효 노드.
// - live run 0회면 progress null ("실행 기록 없음", 0%로 표시 금지).
// - latest.json 은 live 외 mode 에서도 갱신되므로 쓰지 않는다 (runner/run.ts).
// - 읽기 전용: 파일 쓰기 0건, 잠금 없음. report.json 파손 시 warn 1줄 후 null.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROCEDURE_NAME_RE, type ProcedureDoc } from "@proof/shared/procedure.js";
import { logger } from "../logger.js";
import { eventsLogPath } from "./events-log.js";
import { loadProcedureDoc } from "../runner/procedure-run.js";
import type { RunReport } from "../runner/types.js";
import {
  approvalPins,
  loadApprovals,
  toHashable,
  isApprovalCurrent,
} from "./approvals.js";
import { computeNodeHash, type ArgSpec, type Constraint } from "@proof/shared/schema.js";
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

// 승인 hash 무효 leaf (판정은 approvals.isApprovalCurrent 공용 함수 — App과 동일).
// 기록 자체가 없으면 무효가 아니라 미판정으로 유효 취급한다 (실행 중 승인 등 runs 기록에만 남는 승인).
function staleApprovalLeaves(procDir: string, doc: ProcedureDoc): string[] {
  let approvals: ReturnType<typeof loadApprovals>;
  try {
    approvals = loadApprovals(procDir);
  } catch {
    approvals = [];
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
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
  // buildApprovalEntry와 같은 내용 해시 (doc에는 세션 hash가 없다).
  const contentHash = (x: { goal?: unknown; args?: unknown; constraints?: unknown }): string =>
    computeNodeHash({
      goal: typeof x.goal === "string" ? x.goal : "",
      args: (x.args ?? {}) as Record<string, ArgSpec>,
      constraints: (x.constraints ?? []) as Constraint[],
      dependsOn: [],
    });
  const out: string[] = [];
  for (const n of doc.nodes) {
    if ((n.children ?? []).length > 0) continue;
    const args = (n.args ?? {}) as Record<string, unknown>;
    const isExternal = n.sideEffect === "external";
    const hasScript = Object.values(args).some(
      (a) => typeof a === "object" && a !== null && (a as { kind?: unknown }).kind === "script",
    );
    if (!n.tool || (!isExternal && !hasScript)) continue;
    const mine = approvals.filter((e) => e.node.id === n.id);
    if (mine.length === 0) continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const pins = approvalPins(
      { id: n.id, hash: contentHash(n), parentId: n.parentId },
      parent && (parent.kind === "map" || parent.kind === "until")
        ? { id: parent.id, hash: contentHash(parent), kind: parent.kind }
        : undefined,
      hashable,
      readScript,
      accumulate,
    );
    if (!isApprovalCurrent(mine, pins)) out.push(n.id);
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
    let doc: ProcedureDoc;
    try {
      doc = loadProcedureDoc(procforgeDir, name).doc;
    } catch {
      continue;
    }
    const procDir = join(procforgeDir, "procedures", name);
    const leafIds = doc.nodes
      .filter((n) => (n.children ?? []).length === 0)
      .map((n) => n.id);
    const invalid = new Set(staleApprovalLeaves(procDir, doc));
    // 최신 live run 확정: events에서 유효 report를 찾으면 스캔은 생략한다.
    let report: RunReport | undefined;
    let liveRunId: string | null = null;
    let warned = false;
    const tried = new Set<string>();
    const noteBad = (id: string) => {
      if (!warned) {
        warned = true;
        logger.warn(`progress: live report 사용 불가 (${name}/${id}) — 다음 후보 확인`);
      }
    };
    for (const id of liveRunIdsFromEvents(procforgeDir, name)) {
      tried.add(id);
      const r = readLiveReport(procforgeDir, id);
      if (r) {
        report = r;
        liveRunId = id;
        break;
      }
      noteBad(id);
    }
    if (!report) {
      for (const id of liveRunIdsFromScan(procforgeDir, name)) {
        if (tried.has(id)) continue;
        tried.add(id);
        const r = readLiveReport(procforgeDir, id);
        if (r) {
          report = r;
          liveRunId = id;
          break;
        }
        noteBad(id);
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
