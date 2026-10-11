import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compareNodeIds } from "@procforge/shared/ids.js";
import { effectiveDeps, expandDepLeafs, rawDepSources } from "@procforge/shared/deps.js";
import type { Node } from "@procforge/shared/schema.js";
import { FileStore } from "../filestore.js";
import { evaluateAll } from "../checker.js";
import { logger } from "../logger.js";
import { writeAtomicFile } from "../fsutil.js";
import { normalizeArgSpecs, fixtureFileExists, isEscapeRel, readManifest } from "../artifacts.js";
import { ConnectionPool } from "./connections.js";
import { findRecording, loadCassette, recordKey, saveRecording, toToolResponse, compareToolResponses } from "./recordings.js";
import { getByDot, resolveArgs, resolveVar, substituteItemSpecs, substituteParams } from "./resolve.js";
import { loadProcedureState, procedureStatePath, saveProcedureState } from "../services/procedure-state.js";
import { approvalPins, checkApproval, loadApprovals, toHashableMap } from "../services/approvals.js";
import { runScript } from "./script-run.js";
import { inferPathRole, rewritePaths, type InferredRole, type PathRole } from "./paths.js";
import { setupRunFs } from "./workdir.js";
import { writeRunState } from "../services/run-state.js";
import type { NodeResult, RunMode, RunOptions, RunReport, ToolResponse } from "./types.js";

function orderNodes(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inScope = new Set(nodes.map((n) => n.id));
  // 의존 간선 = 실효 의존 (M3.4.4-1). split id는 자손 leaf로 펼침.
  const edges = (n: Node): string[] => effectiveDeps(n, byId).filter((d) => inScope.has(d));
  const done = new Set<string>();
  const out: Node[] = [];
  const pending = [...nodes].sort((a, b) => compareNodeIds(a.id, b.id));
  let guard = pending.length * pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const i = pending.findIndex((n) => edges(n).every((d) => done.has(d)));
    if (i === -1) throw new Error(`의존 해소 불가(순환?): ${pending.map((n) => n.id).join(",")}`);
    const [n] = pending.splice(i, 1);
    done.add(n.id);
    out.push(n);
  }
  if (pending.length > 0) throw new Error("의존 정렬 실패");
  return out;
}

function subtree(nodes: Node[], rootId: string): Node[] {
  const keep = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) {
        keep.add(n.id);
        grew = true;
      }
    }
  }
  return nodes.filter((n) => keep.has(n.id));
}

function latestReportPath(procforgeDir: string, sessionId: string): string {
  return join(procforgeDir, "runs", "by-session", sessionId, "latest.json");
}

function readLastPass(procforgeDir: string, sessionId: string): { exists: boolean; hashes: Record<string, string> } {
  const p = latestReportPath(procforgeDir, sessionId);
  if (!existsSync(p)) return { exists: false, hashes: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { lastPassHash?: Record<string, string> };
    return { exists: true, hashes: parsed.lastPassHash ?? {} };
  } catch {
    return { exists: true, hashes: {} };
  }
}

export function toJUnit(report: RunReport): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cases = report.results
    .map((r) => {
      if (r.status === "fail") {
        return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"><failure message="${esc(r.detail ?? "failed")}">${esc(r.failedConstraints.join(","))}</failure></testcase>`;
      }
      if (r.status === "unverified" || r.status === "skipped" || r.status === "blocked" || r.status === "suspended") {
        return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"><skipped message="${esc(r.detail ?? r.status)}"/></testcase>`;
      }
      return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"/>`;
    })
    .join("\n");
  const failures = report.results.filter((r) => r.status === "fail").length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="procforge" tests="${report.results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

// M5.5-4.1-4: 무인 실행 전 generated 미공급 노드 수집 (leaf·map/until 템플릿).
// supplied로 덮인 키는 제외. 반환: ["노드:키,..."].
export function missingGeneratedArgNodes(
  nodes: Node[],
  supplied?: Record<string, Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const kind = (n as { kind?: string }).kind;
    let specs: Record<string, { kind?: string }>;
    if (kind === "map") {
      specs = ((n as { map?: { template?: { args?: Record<string, { kind?: string }> } } }).map?.template?.args ?? {}) as Record<string, { kind?: string }>;
    } else if (kind === "until") {
      specs = ((n as { until?: { template?: { args?: Record<string, { kind?: string }> } } }).until?.template?.args ?? {}) as Record<string, { kind?: string }>;
    } else if (n.tool) {
      specs = ((n.args ?? {}) as Record<string, { kind?: string }>);
    } else {
      continue;
    }
    const sup = supplied?.[n.id] ?? {};
    const missing = Object.entries(specs)
      .filter(([k, s]) => s?.kind === "generated" && !Object.prototype.hasOwnProperty.call(sup, k))
      .map(([k]) => k);
    if (missing.length > 0) out.push(`${n.id}:${missing.join(",")}`);
  }
  return out;
}

// M5.5-4.2-5: run 보유 잠금 하트비트 (세션 + 절차서). 20s 주기, best-effort.
export function startRunHeartbeat(store: FileStore, sessionId: string, procLockPath?: string): () => void {
  const beat = setInterval(() => {
    try {
      store.refreshLock(sessionId);
      if (procLockPath) store.refreshFileLock(procLockPath);
    } catch {
      // 무시
    }
  }, 20000);
  return () => clearInterval(beat);
}

export async function runSession(opts: RunOptions): Promise<RunReport> {
  const mode: RunMode = opts.mode ?? "replay";
  if (mode === "replay" && opts.updateGolden) {
    throw Object.assign(new Error("--update-golden은 record/passthrough에서만 허용 (replay 불가)"), { code: "bad_request" });
  }
  const store = new FileStore(opts.procforgeDir);
  const session = store.getSession(opts.sessionId);
  if (!session) throw Object.assign(new Error(`세션 없음: ${opts.sessionId}`), { code: "session_not_found" });
  // M5.5-4.1-4: 무인 실행은 generated 값을 공급받을 수 없으므로 실행 전 거부.
  if (opts.unattended) {
    const lacking = missingGeneratedArgNodes([...store.getNodes(opts.sessionId).values()], opts.supplied);
    if (lacking.length > 0) {
      throw Object.assign(
        new Error(`무인 실행 불가: generated 인자 미공급 (${lacking.join("; ")}). generated 없는 절차서로 설계하라.`),
        { code: "bad_request" },
      );
    }
  }
  // M5.5-3: 실행 간 상태 로드 (절차서 run + state 사용 시만).
  // state 미사용 절차서는 기존 동작 그대로 (로드 없음).
  const procedureDir = opts.procedureDir ??
    (opts.procedure ? join(opts.procforgeDir, "procedures", opts.procedure) : undefined);
  if (procedureDir) {
    const preNodes = [...store.getNodes(opts.sessionId).values()];
    const needsState = preNodes.some((x) => {
      const sw = (x as { stateWrites?: unknown }).stateWrites;
      if (Array.isArray(sw) && sw.length > 0) return true;
      return JSON.stringify({ a: x.args, c: x.constraints }).includes("${state.");
    });
    if (needsState) {
      opts.state = loadProcedureState(
        procedureStatePath(procedureDir),
        session.params as Record<string, string>,
      );
    }
    // M5.5-4: 무인 실행 사전 승인 로드 (없으면 빈 목록 = external 전부 거부).
    if (opts.unattended && opts.approvals === undefined) {
      opts.approvals = loadApprovals(procedureDir);
    }
  }
  const runId = opts.runId ?? randomUUID();
  const { runDir, fsDir } = setupRunFs(opts.procforgeDir, opts.sessionId, runId, {
    projectRoot: opts.projectRoot,
    params: session.params as Record<string, string>,
  });
  const release = store.acquireLock(opts.sessionId, 60000);
  // M5.5-4.1-5: 절차서 단위 run 잠금 (겹친 스케줄 실행 방지). 세션 락과 함께 보유.
  // M5.5-4.2-5: 절차서 잠금 실패 시 세션 잠금도 해제 (누수 금지).
  const procLockPath = procedureDir ? join(procedureDir, ".run.lock") : undefined;
  let releaseProcLock: (() => void) | undefined;
  try {
    releaseProcLock = procLockPath
      ? store.acquireFileLock(procLockPath, `procedure run locked: ${basename(procedureDir as string)}`, 60000)
      : undefined;
  } catch (e) {
    release();
    throw e;
  }
  // M5.1-A1: 장기 보유 중 하트비트 (20s 주기, startRunHeartbeat).
  const stopBeat = startRunHeartbeat(store, opts.sessionId, procLockPath);
  const pool = new ConnectionPool(opts.projectRoot, fsDir, opts.allowBash ?? false);
  const t0 = Date.now();
  try {
    let all = [...store.getNodes(opts.sessionId).values()];
    if (opts.nodeId) {
      if (!all.some((n) => n.id === opts.nodeId)) throw Object.assign(new Error(`노드 없음: ${opts.nodeId}`), { code: "not_found" });
      all = subtree(all, opts.nodeId);
    }
    // --changed: lastPassHash 불일치 또는 없음 + 하류만 (M3.3-5, M3.4.4-1 실효 하류)
    let targets = new Set(all.map((n) => n.id));
    if (opts.changed) {
      const prev = readLastPass(opts.procforgeDir, opts.sessionId);
      if (prev.exists) {
        const allById = new Map(all.map((x) => [x.id, x]));
        const changedIds = new Set(
          all.filter((n) => prev.hashes[n.id] === undefined || prev.hashes[n.id] !== n.hash).map((n) => n.id),
        );
        const queue = [...changedIds];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const n of all) {
            if (!changedIds.has(n.id) && effectiveDeps(n, allById).includes(cur)) {
              changedIds.add(n.id);
              queue.push(n.id);
            }
          }
        }
        targets = changedIds;
      }
    }
    const ordered = orderNodes(all);
    const byIdAll = new Map(all.map((x) => [x.id, x]));
    // M5: 이미 완료분은 재실행 제외 (golden 출력으로 의존 공급)
    const doneSet = new Set(opts.skipNodeIds ?? []);
    for (const id of doneSet) targets.delete(id);
    const outputs = new Map<string, unknown>();
    // 범위 밖 의존 출력만 golden에서 공급 (M3.1-4: 범위 내 선주입 금지)
    for (const n of all) {
      if (!targets.has(n.id) && n.golden && !outputs.has(n.id)) {
        try {
          outputs.set(n.id, JSON.parse(n.golden.output));
        } catch {
          outputs.set(n.id, n.golden.output);
        }
      }
    }

    const results: NodeResult[] = [];
    const resultOf = new Map<string, NodeResult>();
    for (const n of ordered) {
      const start = Date.now();
      if (doneSet.has(n.id)) {
        const r: NodeResult = { nodeId: n.id, status: "skipped", failedConstraints: [], detail: "already done (run state)", durationMs: 0 };
        results.push(r);
        resultOf.set(n.id, r);
        continue;
      }
      if (!targets.has(n.id)) {
        const r: NodeResult = { nodeId: n.id, status: "skipped", failedConstraints: [], detail: "scope/changes 제외", durationMs: 0 };
        results.push(r);
        resultOf.set(n.id, r);
        continue;
      }
      if (n.status !== "leaf" || !n.tool) {
        const r: NodeResult = { nodeId: n.id, status: "skipped", failedConstraints: [], detail: `leaf 아님(${n.status})`, durationMs: 0 };
        results.push(r);
        resultOf.set(n.id, r);
        continue;
      }
      // 실패 전파 (M3.1-4/M3.3-6/M3.4.1-5/M3.4.4-1): 원시 의존별 펼침 검사.
      // 펼침 빈손(자손 leaf 0개·자식 id 부재) → blocked. 범위 내 leaf가
      // fail/blocked이거나 출력이 없으면 blocked
      let blockedBy: string | undefined;
      for (const dep of rawDepSources(n, byIdAll)) {
        const leaves = expandDepLeafs(dep, byIdAll);
        if (leaves.length === 0) {
          blockedBy = dep;
          break;
        }
        const bad = leaves.find((d) => {
          if (!targets.has(d)) return false; // 범위 밖은 golden 선주입됨
          const dr = resultOf.get(d);
          if (!dr) return true;
          return dr.status === "fail" || dr.status === "blocked" || !outputs.has(d);
        });
        if (bad) {
          blockedBy = bad;
          break;
        }
      }
      if (blockedBy) {
        const r: NodeResult = { nodeId: n.id, status: "blocked", failedConstraints: [], detail: `blocked by ${blockedBy}`, durationMs: Date.now() - start };
        results.push(r);
        resultOf.set(n.id, r);
        continue;
      }
      try {
        const r = await execNode(opts, session.params, outputs, pool, fsDir, n, mode, new Map(all.map((x) => [x.id, x])), runId);
        results.push(r);
        resultOf.set(n.id, r);
        if (r.status === "suspended") {
          // M5: 첫 suspend에서 중단. 나머지는 대기 표시.
          const seen = new Set(results.map((x) => x.nodeId));
          for (const m of ordered) {
            if (seen.has(m.id)) continue;
            const s: NodeResult = doneSet.has(m.id)
              ? { nodeId: m.id, status: "skipped", failedConstraints: [], detail: "already done (run state)", durationMs: 0 }
              : { nodeId: m.id, status: "skipped", failedConstraints: [], detail: `suspended: ${r.detail ?? ""}`, durationMs: 0 };
            results.push(s);
            resultOf.set(m.id, s);
          }
          break;
        }
      } catch (e) {
        const r: NodeResult = {
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          detail: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        };
        results.push(r);
        resultOf.set(n.id, r);
      }
    }

    const summary = {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      unverified: results.filter((r) => r.status === "unverified").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      blocked: results.filter((r) => r.status === "blocked").length,
      suspended: results.filter((r) => r.status === "suspended").length,
    };
    const report: RunReport = {
      runId,
      sessionId: opts.sessionId,
      mode,
      at: new Date().toISOString(),
      results,
      summary,
      nodeHashes: Object.fromEntries([...store.getNodes(opts.sessionId).values()].map((n) => [n.id, n.hash])),
    };
    mkdirSync(runDir, { recursive: true });
    writeAtomicFile(join(runDir, "report.json"), JSON.stringify(report, null, 2));
    // M5: suspend 시 run state 저장 (재개용)
    const suspended = results.find((r) => r.status === "suspended");
    if (suspended) {
      const doneIds = [...doneSet, ...results.filter((r) => r.status === "pass").map((r) => r.nodeId)];
      const pending = ordered.map((n) => n.id).filter((id) => !doneIds.includes(id));
      const m = /^need_generated:(.*)$/.exec(suspended.detail ?? "");
      writeRunState(opts.procforgeDir, {
        version: 1,
        runId,
        sessionId: opts.sessionId,
        procedure: opts.procedure ?? "",
        params: session.params,
        pending,
        done: doneIds,
        supplied: opts.supplied ?? {},
        approved: opts.approvedNodeIds ?? [],
        suspended: {
          nodeId: suspended.nodeId,
          kind: m ? "need_generated" : "need_approval",
          ...(m ? { missing: m[1].split(",").filter((s) => s.length > 0) } : {}),
        },
        status: "suspended",
        updatedAt: new Date().toISOString(),
      });
    }
    // lastPassHash 병합 저장 (M3.3-5): pass만 갱신, 미실행 유지, fail/blocked 삭제
    const prevPass = readLastPass(opts.procforgeDir, opts.sessionId).hashes;
    const merged: Record<string, string> = { ...prevPass };
    const hashOf = new Map([...store.getNodes(opts.sessionId).values()].map((n) => [n.id, n.hash]));
    for (const r of results) {
      if (r.status === "pass") merged[r.nodeId] = hashOf.get(r.nodeId) ?? "";
      else if (r.status === "fail" || r.status === "blocked") delete merged[r.nodeId];
    }
    const latestPath = latestReportPath(opts.procforgeDir, opts.sessionId);
    writeAtomicFile(latestPath, JSON.stringify({ runId, at: report.at, nodeHashes: report.nodeHashes, lastPassHash: merged }));
    // M5.5-3: 성공 종료 시에만 state 저장 (원자). 실패·중단은 불변.
    // M5.7-2: 무인 실행 기본 on — unverified>0이면 저장 안 함.
    const fou = opts.unattended === true && opts.failOnUnverified !== false;
    if (procedureDir && summary.fail === 0 && summary.suspended === 0 && (summary.unverified === 0 || !fou)) {
      const writers = [...store.getNodes(opts.sessionId).values()].filter(
        (x) => Array.isArray((x as { stateWrites?: unknown }).stateWrites) && ((x as { stateWrites?: unknown[] }).stateWrites as unknown[]).length > 0,
      );
      if (writers.length > 0) {
        const outMap: Record<string, unknown> = {};
        for (const [k, v] of outputs) outMap[k] = v;
        const nextState: Record<string, unknown> = { ...(opts.state ?? {}) };
        for (const w of writers) {
          for (const e of (w as unknown as { stateWrites: { key: string; from: string }[] }).stateWrites) {
            try {
              nextState[e.key] = resolveVar(e.from, session.params as Record<string, string>, outputs);
            } catch (err) {
              logger.warn("stateWrite skip", { nodeId: w.id, key: e.key, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        saveProcedureState(procedureStatePath(procedureDir), nextState);
      }
    }
    logger.info("run complete", { runId, ...summary, durationMs: Date.now() - t0 });
    return report;
  } finally {
    stopBeat();
    release();
    if (releaseProcLock) releaseProcLock();
    await pool.close();
  }
}

// M5.6-f: 일시 네트워크 오류 판별 (재시도 대상. 검증·입력 오류는 제외).
// M5.6.1-2: 숫자·코드는 \b 경계 (15020 오탐 방지). 10013은 기본 제외 (설정으로만).
const TRANSIENT_RES = [
  /timed? ?out/i,
  /\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEPIPE\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/i,
  /fetch failed/i,
  /connection (closed|reset|refused|aborted)/i,
  /\b429\b|\b502\b|\b503\b|\b504\b/,
  /\b10054\b|\b10060\b/,
  /temporar/i,
];

export function isTransientToolError(e: unknown, extraRes: RegExp[] = []): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/bad_request|bad_args|not_found|validation|invalid arg/i.test(msg)) return false;
  return TRANSIENT_RES.some((re) => re.test(msg)) || extraRes.some((re) => re.test(msg));
}

// M5.7-3: 스크립트 타임아웃 판별 (runScript code "timeout").
export function isScriptTimeout(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "timeout";
}

// M5.6.1-2: Retry-After(초) 파싱. 없으면 undefined.
export function parseRetryAfterMs(msg: string): number | undefined {
  const m = /retry-after:\s*(\d+)/i.exec(msg);
  if (!m) return undefined;
  return Number(m[1]) * 1000;
}

// M5.6.1-2: 대기 계산 (순수). 지수 백오프 + baseMs 비례 jitter, 1회 30s 상한.
// Retry-After가 있으면 그만큼은 보장 (상한 내).
export function retryDelayMs(baseMs: number, attempt: number, retryAfterMs?: number): number {
  const grown = baseMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.max(0, baseMs));
  const want = Math.max(grown, retryAfterMs ?? 0) + jitter;
  return Math.min(30000, Math.max(0, want));
}

export type ToolCaller = {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResponse>;
};

// M5.6.1-1: ok:false 일시 상태 응답 (fetch형 {ok, status}). throw 경로와 동일 취급.
export function isTransientResult(resp: ToolResponse): boolean {
  const j = resp.resultJson;
  if (typeof j !== "object" || j === null || Array.isArray(j)) return false;
  const o = j as Record<string, unknown>;
  if (o.ok !== false) return false;
  const st = o.status;
  return typeof st === "number" && (st === 429 || st === 502 || st === 503 || st === 504);
}

/**
 * M5.6-f: 도구 호출 (readOnly + sideEffect none만 재시도, 지수 백오프).
 * external·쓰기 노드는 재시도 금지 (중복 부작용 방지). 호출자가 retry 여부 결정.
 */
export async function callWithRetry(
  pool: ToolCaller,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { retry: boolean; attempts?: number; baseMs?: number; extraTransient?: string[] },
): Promise<{ resp: ToolResponse; attempts: number }> {
  // M5.6.1-2: attempts 상한 10. extraTransient는 추가 정규식 (예: ["\\b10013\\b"]).
  const attempts = Math.min(10, Math.max(1, Math.floor(opts.attempts ?? 3)));
  const baseMs = Math.max(0, opts.baseMs ?? 500);
  const extraRes = (opts.extraTransient ?? []).map((s) => new RegExp(s, "i"));
  const transient = (e: unknown): boolean => isTransientToolError(e, extraRes);
  const sleepFor = (msg: string, i: number): Promise<void> =>
    new Promise((r) => setTimeout(r, retryDelayMs(baseMs, i, parseRetryAfterMs(msg))));
  let pendingError: unknown;
  let pendingResp: ToolResponse | undefined;
  for (let i = 0; i < attempts; i++) {
    let resp: ToolResponse;
    try {
      resp = await pool.call(server, tool, args);
    } catch (e) {
      if (!opts.retry || i + 1 >= attempts || !transient(e)) throw e;
      pendingError = e;
      await sleepFor(e instanceof Error ? e.message : String(e), i);
      continue;
    }
    // M5.6.1-1: ok:false 일시 상태 응답도 재시도 (isError 텍스트와 동일 판별).
    if (opts.retry && isTransientResult(resp)) {
      pendingResp = resp;
      if (i + 1 >= attempts) break;
      await sleepFor(resp.resultText, i);
      continue;
    }
    return { resp, attempts: i + 1 };
  }
  if (pendingError !== undefined) throw pendingError;
  throw new Error(
    `일시 오류 응답 지속(${attempts}회): ${(pendingResp?.resultText ?? "").slice(0, 200)}`,
  );
}

async function execNode(
  opts: RunOptions,
  params: Record<string, string>,
  outputs: Map<string, unknown>,
  pool: ConnectionPool,
  fsDir: string,
  n: Node,
  mode: RunMode,
  byId: Map<string, Node>,
  runId: string,
  /** M5.5-2 until 전달값 ($self 해결용) */
  selfCarry?: { present: boolean; value: unknown },
): Promise<NodeResult> {
  const start = Date.now();
  // M5.5-1: map 노드는 항목별 실행으로 분기
  if ((n as { kind?: string }).kind === "map") {
    return execMap(opts, params, outputs, pool, fsDir, n, mode, byId, runId, start);
  }
  // M5.5-2: until 노드는 본문 반복으로 분기
  if ((n as { kind?: string }).kind === "until") {
    return execUntil(opts, params, outputs, pool, fsDir, n, mode, byId, runId, start);
  }
  // 구 세션 마이그레이션: 절대경로 fixed → 상대경로 (M3.2-2)
  const normSpecs = normalizeArgSpecs(n.args ?? {}, {
    sandboxDir: join(opts.procforgeDir, "sandbox", opts.sessionId),
    projectRoot: opts.projectRoot,
  });
  if (normSpecs.warnings.length > 0) logger.warn("absolute path kept", { nodeId: n.id, warnings: normSpecs.warnings });
  const specs = normSpecs.specs;
  // M5: live에서 generated 미공급이면 suspended (runner가 만들지 않음)
  if (mode === "live") {
    const supplied = opts.supplied?.[n.id] ?? {};
    const missing = Object.entries(specs)
      .filter(([k, s]) => (s as { kind?: string }).kind === "generated" && !Object.prototype.hasOwnProperty.call(supplied, k))
      .map(([k]) => k);
    if (missing.length > 0) {
      return { nodeId: n.id, status: "suspended", failedConstraints: [], detail: `need_generated:${missing.join(",")}`, durationMs: Date.now() - start };
    }
  }
  const inputSchema = catalogInputSchema(opts, n);
  const readOnly = catalogReadOnly(opts, n);
  // M5.2-2: script-kind 항목은 도구 인자 파이프라인(resolve·rewrite·recordKey)에서
  // 제외. 파일 위치는 원본 spec에서 직접 읽는다.
  const scriptEntry = Object.entries(specs).find(([, s]) => (s as { kind?: string }).kind === "script");
  const toolSpecs: typeof specs = scriptEntry
    ? Object.fromEntries(Object.entries(specs).filter(([k]) => k !== scriptEntry[0]))
    : specs;
  const roles: Record<string, PathRole | InferredRole | undefined> = {};
  for (const [k, spec] of Object.entries(toolSpecs)) {
    const explicit = (spec as { path?: PathRole }).path;
    if (explicit) {
      roles[k] = explicit;
      continue;
    }
    // 내장 고정 매핑 (M3.2-3): write.path=out, edit.path=inout
    if (n.tool?.server === "opencode" && n.tool?.name === "write" && k === "path") {
      roles[k] = "out";
      continue;
    }
    if (n.tool?.server === "opencode" && n.tool?.name === "edit" && k === "path") {
      roles[k] = "inout";
      continue;
    }
    // M3.4-1: readOnly는 확정 아님. infer 결과 그대로 (weakIn 포함).
    roles[k] = inferPathRole(k, inputSchema);
  }
  // M5.5-4.2-1: 승인 매칭은 논리 경로 기준 (rewritePaths 전).
  const logicalArgs = resolveArgs({
    specs: toolSpecs,
    params,
    outputs,
    attempts: n.attempts,
    goldenAttemptId: n.golden?.attemptId,
    live: mode === "live",
    supplied: opts.supplied?.[n.id],
    selfCarry,
    state: opts.state,
    topo: {
      isSplit: (id) => byId.get(id)?.status === "split",
      childrenOf: (id) => byId.get(id)?.children ?? [],
    },
  });
  const args = rewritePaths(
    logicalArgs,
    roles,
    { fsDir, projectRoot: opts.projectRoot, allowProjectRead: opts.allowProjectRead ?? false, toolReadOnly: readOnly },
  );
  const server = n.tool!.server;
  const tool = n.tool!.name;
  const key = recordKey(fsDir, opts.projectRoot, server, tool, args);
  let resp: ToolResponse;
  let mocked = false;

  // M5.2-2: 스크립트 leaf는 MCP 대신 호스트 스크립트 실행 (전 모드).
  if (scriptEntry) {
    const spec = scriptEntry[1] as unknown as { file: string; runtime?: string; timeoutMs?: number };
    const rel = String(spec.file ?? "").split("\\").join("/");
    if (!rel.startsWith("scripts/") || rel.includes("..")) {
      throw Object.assign(new Error(`스크립트 경로 볼 수 없음: ${n.id}.${scriptEntry[0]}=${spec.file}`), {
        code: "bad_request",
      });
    }
    const scriptAbs = join(opts.procforgeDir, "runs", runId, rel);
    // M5.7-3: script 재시도는 노드 retry:{attempts} 명시(멱등 opt-in)시에만.
    // 기본 미재시도. M5.6-f 판별·상한 재사용 (fs 밖 변경 등 확정 실패는 제외).
    const scriptAttempts = (() => {
      const a = (n as { retry?: { attempts?: unknown } }).retry?.attempts;
      if (!Number.isInteger(a)) return 1;
      return Math.min(10, Math.max(1, a as number));
    })();
    let scriptTries = 0;
    for (;;) {
      scriptTries += 1;
      try {
        const o = runScript({
          runtime: spec.runtime ?? "python",
          scriptAbs,
          args,
          cwd: fsDir,
          timeoutMs: spec.timeoutMs,
          projectRoot: opts.projectRoot,
        });
        resp = { resultText: o.summary, resultJson: o.json };
        break;
      } catch (e) {
        const transient = isTransientToolError(e) || isScriptTimeout(e);
        if (scriptTries >= scriptAttempts || !transient) throw e;
        await new Promise((r) => setTimeout(r, retryDelayMs(500, scriptTries - 1)));
      }
    }
  } else if (n.sideEffect === "external" && mode !== "live") {
    // record/replay/passthrough에서 실제 호출 금지 (M3)
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (rec) {
      resp = toToolResponse(rec, fsDir);
    } else {
      mocked = true;
      resp = { resultText: "[mock external]", resultJson: { mock: true } };
    }
  } else if (mode === "live" && n.sideEffect === "external" && !(opts.approvedNodeIds ?? []).includes(n.id)) {
    // M5: live에서도 사람 승인 없이는 실행 금지. M5.5-4: 무인 실행은
    // approvals.json 일치 시 실행, 불일치 시 중단 대신 fail ["approval"].
    // M5.5-4.1-3: node pin(id+hash) 판정. 해시 불일치(stale)는 갱신 안내.
    if (opts.unattended) {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const readScript = (rel: string): string | undefined => {
        try {
          return readFileSync(join(opts.procforgeDir, "sessions", opts.sessionId, rel), "utf8");
        } catch {
          return undefined;
        }
      };
      const verdict = checkApproval(
        opts.approvals ?? [],
        approvalPins(
          n,
          parent ? { id: parent.id, hash: parent.hash, kind: (parent as { kind?: string }).kind } : undefined,
          toHashableMap(byId),
          readScript,
        ),
        server, tool, logicalArgs as Record<string, unknown>,
      );
      if (verdict === "stale") {
        return { nodeId: n.id, status: "fail", failedConstraints: ["approval"], detail: `approval: 승인 갱신 필요 (노드 ${n.id} 해시 변경). procforge approve <procedure> --node ${n.id}로 갱신`, durationMs: Date.now() - start };
      }
      if (verdict !== "ok") {
        return { nodeId: n.id, status: "fail", failedConstraints: ["approval"], detail: `approval: 무인 실행 미승인 external (${server}/${tool}). procedures/<name>/approvals.json에 tool·인자 등록 필요`, durationMs: Date.now() - start };
      }
      // 승인 일치 → 아래 실제 호출로 진행하지 않고 여기서 직접 호출 (live는 녹화 없음).
      resp = await pool.call(server, tool, args);
    } else {
      return { nodeId: n.id, status: "suspended", failedConstraints: [], detail: "need_approval", durationMs: Date.now() - start };
    }
  } else if (mode === "replay") {
    // M3.1-1: replay는 녹화 적중 + constraints만. golden 비교 없음.
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (!rec) throw new Error(`녹화 없음: ${server}/${tool} (키 ${key}). record 모드로 먼저 녹화하라.`);
    resp = toToolResponse(rec, fsDir);
  } else {
    // record / passthrough: 실제 호출.
    // M5.6-f: readOnly + sideEffect none만 재시도 (external·쓰기는 중복 부작용 방지).
    const retried = await callWithRetry(pool, server, tool, args, {
      retry: readOnly && n.sideEffect === "none",
      attempts: opts.toolRetry?.attempts,
      baseMs: opts.toolRetry?.baseMs,
    });
    resp = retried.resp;
    if (retried.attempts > 1) {
      logger.info("tool retry success", { nodeId: n.id, server, tool, attempts: retried.attempts });
    }
    if (mode === "record") {
      saveRecording(opts.procforgeDir, opts.sessionId, n.id, {
        key,
        server,
        tool,
        args,
        response: { summary: resp.resultText, json: resp.resultJson },
        at: new Date().toISOString(),
        params,
      }, fsDir, runId);
    }
  }

  outputs.set(n.id, resp.resultJson ?? resp.resultText);

  // drift 검출 (M3.5.1-2): passthrough에서 녹화 응답과 정규화 비교.
  // 호스트 resultSummary(golden)는 비교하지 않는다. 녹화 없으면 기준 없음 → 통과.
  if (mode === "passthrough") {
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (rec) {
      const base = toToolResponse(rec, fsDir);
      const d = compareToolResponses(
        { summary: base.resultText, json: base.resultJson },
        { summary: resp.resultText, json: resp.resultJson },
        { ignore: n.golden?.ignore ?? [], fsDir, params, expectedParams: rec.params },
      );
      if (!d.equal) {
        if (opts.updateGolden) {
          updateNodeGolden(opts, n, resp);
          saveRecording(opts.procforgeDir, opts.sessionId, n.id, {
            key, server, tool, args,
            response: { summary: resp.resultText, json: resp.resultJson },
            at: new Date().toISOString(),
            params,
          }, fsDir, opts.runId);
        } else {
          return {
            nodeId: n.id,
            status: "fail",
            failedConstraints: [],
            detail: `response drift @${d.path}. expected=${d.expectedExcerpt} actual=${d.actualExcerpt}`,
            durationMs: Date.now() - start,
          };
        }
      }
    }
  }
  if (opts.updateGolden && mode === "record") {
    updateNodeGolden(opts, n, resp);
  }

  // 판정 (checker 재사용, llm_rubric·deferred는 별도 집계)
  // M3.6-3: fixture 존재 검사는 바이너리 존재+크기>0 (sha256 비교 금지)
  // M3.5.1-1: 논리 경로(source rel)는 manifest 역조회로 판정 (구 fixture 키도 허용)
  // M5.3.1-1: 논리 경로는 run fs를 먼저 본다 (실행 입력·산출 검사)
  const fileExists = makeFileExists(opts.procforgeDir, opts.sessionId, fsDir, params);
  const nodeOutputs: Record<string, unknown> = {};
  for (const [k, v] of outputs) nodeOutputs[k] = v;
  const r = evaluateAll(n.constraints, {
    resultSummary: resp.resultText,
    resultJson: resp.resultJson,
    artifacts: {},
    fileExists,
    nodeOutputs,
    params,
    fsDir,
  });
  const durationMs = Date.now() - start;
  if (r.failedConstraints.length > 0) {
    return { nodeId: n.id, status: "fail", failedConstraints: r.failedConstraints, unverified: r.unverified, durationMs };
  }
  if (mocked || r.unverified.length > 0) {
    return { nodeId: n.id, status: "unverified", failedConstraints: [], unverified: r.unverified, detail: mocked ? "mock external" : undefined, durationMs };
  }
  return { nodeId: n.id, status: "pass", failedConstraints: [], durationMs };
}

function catalogInputSchema(_opts: RunOptions, _n: Node): Record<string, unknown> | undefined {
  return catalogEntry(_opts, _n)?.inputSchema as Record<string, unknown> | undefined;
}

function catalogReadOnly(_opts: RunOptions, _n: Node): boolean {
  return catalogEntry(_opts, _n)?.annotations?.readOnlyHint === true;
}

function catalogEntry(_opts: RunOptions, _n: Node) {
  // 세션 카탈로그에서 해당 tool 항목 조회 (추론 보조)
  try {
    const store = new FileStore(_opts.procforgeDir);
    const s = store.getSession(_opts.sessionId);
    return s?.toolCatalog.find((t) => t.server === _n.tool?.server && t.name === _n.tool?.name);
  } catch {
    return undefined;
  }
}

/**
 * file_exists 판정 함수 (M5.3.1-1 + M5.5-1 execNode/execMap 공용).
 * 논리 경로는 run fs를 먼저 보고, 세션 저장소로 폴백한다.
 */
export function makeFileExists(
  procforgeDir: string,
  sessionId: string,
  fsDir: string,
  params: Record<string, string>,
): (p: string) => boolean {
  const manifest = readManifest(procforgeDir, sessionId);
  const sessDir = join(procforgeDir, "sessions", sessionId);
  return (p: string) => {
    const rel = substituteParams(p, params).split("\\").join("/");
    if (!isEscapeRel(rel, "/") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel)) {
      try {
        if (existsSync(join(fsDir, rel))) return true;
      } catch {
        // 무시하고 세션 저장소로 폴백
      }
    }
    if (fixtureFileExists(join(sessDir, p))) return true;
    for (const [fx, src] of Object.entries(manifest)) {
      if (src === p && fixtureFileExists(join(sessDir, fx))) return true;
    }
    return false;
  };
}

/**
 * M5.5-1: map 노드 실행. over를 항목 배열로 해석해 템플릿 자식(children[0])을
 * 항목별로 실행한다. 각 인스턴스는 ephemeral 노드(`${mapId}.${i+1}`)로 기존
 * execNode를 재사용하므로 record/replay/script/external 처리가 그대로 적용된다.
 * 인스턴스 출력은 실행 후 outputs에서 회수하고, map 출력 배열만 남긴다.
 * 정책: all(기본, 전체 통과) | any(1개 이상) | threshold(통과율 ≥ ratio).
 * 항목 0개면 빈 배열로 pass (비어 있음 검사는 count 제약이 담당).
 */
async function execMap(
  opts: RunOptions,
  params: Record<string, string>,
  outputs: Map<string, unknown>,
  pool: ConnectionPool,
  fsDir: string,
  n: Node,
  mode: RunMode,
  byId: Map<string, Node>,
  runId: string,
  start: number,
): Promise<NodeResult> {
  const done = (r: Omit<NodeResult, "durationMs">): NodeResult => ({ ...r, durationMs: Date.now() - start });
  const spec = (n as unknown as { map?: { over?: unknown; as?: unknown; maxItems?: unknown; policy?: unknown } }).map;
  if (!spec || typeof spec.over !== "string" || spec.over.length === 0) {
    throw Object.assign(new Error(`map spec 없음: ${n.id}`), { code: "bad_request" });
  }
  const as = typeof spec.as === "string" && spec.as.length > 0 ? spec.as : "item";
  const topo = {
    isSplit: (id: string) => byId.get(id)?.status === "split",
    childrenOf: (id: string) => byId.get(id)?.children ?? [],
  };
  let rawItems: unknown;
  try {
    rawItems = resolveVar(spec.over, params, outputs, topo);
  } catch (e) {
    throw Object.assign(new Error(`map over 해석 실패: ${n.id} (${e instanceof Error ? e.message : String(e)})`), {
      code: "bad_request",
    });
  }
  if (!Array.isArray(rawItems)) {
    throw Object.assign(new Error(`map over가 배열 아님: ${n.id}`), { code: "bad_request" });
  }
  const maxItems = typeof spec.maxItems === "number" && spec.maxItems > 0 ? Math.floor(spec.maxItems) : 100;
  const items = (rawItems as unknown[]).slice(0, maxItems);
  const template = (spec as { template?: { tool?: { server?: unknown; name?: unknown }; args?: unknown; constraints?: unknown } }).template;
  if (!template || typeof template.tool?.server !== "string" || typeof template.tool?.name !== "string") {
    throw Object.assign(new Error(`map 템플릿 도구 없음: ${n.id}`), { code: "bad_request" });
  }
  const templateArgs = (template.args ?? {}) as Record<string, import("@procforge/shared/schema.js").ArgSpec>;
  const templateConstraints = (Array.isArray(template.constraints) ? template.constraints : []) as import("@procforge/shared/schema.js").Constraint[];
  // live generated 게이트: 템플릿 generated는 map 단위 supplied로 해결 (항목별 공급 미지원)
  if (mode === "live") {
    const supplied = opts.supplied?.[n.id] ?? {};
    const missing = Object.entries(templateArgs)
      .filter(([k, s]) => (s as { kind?: string }).kind === "generated" && !Object.prototype.hasOwnProperty.call(supplied, k))
      .map(([k]) => k);
    if (missing.length > 0) {
      return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: `need_generated:${missing.join(",")}` });
    }
  }
  const itemOutputs: unknown[] = [];
  const failedItems: number[] = [];
  const failedDetails: string[] = [];
  // M5.5-4: 무인 실행 승인 거부 항목 추적 (map 실패 시 ["approval"] 전파·exit 3).
  let approvalDenied = false;
  // live external 게이트: map 단위 중단 (인스턴스는 map sideEffect 상속).
  // M5.5-4: 무인 실행은 중단하지 않고 항목별로 execNode 승인 검사에 맡긴다.
  if (mode === "live" && n.sideEffect === "external" && !(opts.approvedNodeIds ?? []).includes(n.id) && !opts.unattended) {
    return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: "need_approval" });
  }
  const supplied: Record<string, unknown> = (opts.supplied?.[n.id] ?? {}) as Record<string, unknown>;
  for (let i = 0; i < items.length; i++) {
    const instanceId = `${n.id}.${i + 1}`;
    let inst: Node;
    try {      const normed = normalizeArgSpecs(templateArgs, {
        sandboxDir: join(opts.procforgeDir, "sandbox", opts.sessionId),
        projectRoot: opts.projectRoot,
      }).specs;
      // generated는 map 단위 supplied로 고정 (항목별 공급 미지원)
      const fixedGen: Record<string, import("@procforge/shared/schema.js").ArgSpec> = {};
      for (const [k, s] of Object.entries(normed)) {
        if ((s as { kind?: string }).kind === "generated") {
          if (!Object.prototype.hasOwnProperty.call(supplied, k)) {
            throw new Error(`generated 인자 미공급: ${k} (map ${n.id}에 supply)`);
          }
          fixedGen[k] = { kind: "fixed", value: supplied[k] } as never;
        }
      }
      const base = { ...normed, ...fixedGen };
      const specs = substituteItemSpecs(base, as, items[i]);
      inst = {
        id: instanceId,
        parentId: n.id,
        goal: `${n.goal} [${i}]`,
        status: "leaf",
        depth: n.depth + 1,
        dependsOn: [],
        children: [],
        tool: {
          server: template.tool.server,
          name: template.tool.name,
          schemaHash: n.tool?.schemaHash ?? "map",
        },
        args: specs,
        sideEffect: n.sideEffect,
        constraints: templateConstraints,
        advice: [],
        attempts: [],
        retries: 0,
        hash: `${n.hash}#${i}`,
        locked: false,
      } as Node;
    } catch (e) {
      failedItems.push(i);
      failedDetails.push(`${i}:${e instanceof Error ? e.message : String(e)}`);
      itemOutputs.push({ error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    let r: NodeResult;
    try {
      r = await execNode(opts, params, outputs, pool, fsDir, inst, mode, byId, runId);
    } catch (e) {
      r = {
        nodeId: instanceId,
        status: "fail",
        failedConstraints: [],
        detail: e instanceof Error ? e.message : String(e),
        durationMs: 0,
      };
    }
    if (r.status === "suspended") {
      for (let j = 0; j < items.length; j++) outputs.delete(`${n.id}.${j + 1}`);
      return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: r.detail });
    }
    if (r.status === "pass") {
      const v = outputs.get(instanceId);
      outputs.delete(instanceId);
      itemOutputs.push(v ?? null);
    } else {
      outputs.delete(instanceId);
      if (r.failedConstraints.includes("approval")) approvalDenied = true;
      failedItems.push(i);
      failedDetails.push(`${i}:${r.detail ?? r.failedConstraints.join(",")}`);
      itemOutputs.push({ error: r.detail ?? r.failedConstraints.join(",") });
    }
  }
  outputs.set(n.id, itemOutputs);
  const total = items.length;
  const passed = total - failedItems.length;
  const policy = (spec.policy ?? {}) as { kind?: string; ratio?: number };
  const kind = policy.kind ?? "all";
  let ok: boolean;
  if (total === 0) {
    ok = true;
  } else if (kind === "all") {
    ok = failedItems.length === 0;
  } else if (kind === "any") {
    ok = passed >= 1;
  } else {
    const ratio = typeof policy.ratio === "number" ? policy.ratio : 1;
    ok = passed / total >= ratio;
  }
  // map 자체 제약 (count 등 집계 검사)은 출력 배열에 대해 판정
  const summary = `map ${passed}/${total} (${kind})`;
  const cr = evaluateAll(n.constraints, {
    resultSummary: summary,
    resultJson: itemOutputs,
    artifacts: {},
    fileExists: makeFileExists(opts.procforgeDir, opts.sessionId, fsDir, params),
    nodeOutputs: Object.fromEntries(outputs),
    params,
    fsDir,
  });
  if (!ok) {
    return done({
      nodeId: n.id,
      status: "fail",
      failedConstraints: [...(approvalDenied ? ["approval"] : []), "policy", ...cr.failedConstraints],
      failedItems,
      detail: `map policy ${kind} 실패: ${failedDetails.slice(0, 5).join("; ")}`,
    });
  }
  if (cr.failedConstraints.length > 0) {
    return done({
      nodeId: n.id,
      status: "fail",
      failedConstraints: cr.failedConstraints,
      failedItems,
      detail: `map 집계 제약 실패: ${cr.failedConstraints.join(",")}`,
    });
  }
  if (cr.unverified.length > 0) {
    return done({ nodeId: n.id, status: "unverified", failedConstraints: [], failedItems, detail: summary });
  }
  return done({ nodeId: n.id, status: "pass", failedConstraints: [], failedItems, detail: summary });
}

/**
 * M5.5-2: until 노드 실행. 본문 자식(1개)을 반복 실행한다.
 * - $self: 이전 반복의 본문 출력에서 carry 경로 값을 전달 (없으면 undefined=첫 페이지).
 * - until 제약이 결과에 맞으면 중단·성공, 아니면 carry 후 다음 반복.
 * - maxIterations 도달해도 끝나지 않으면 fail (조용한 절단 금지).
 * - 반복 출력은 배열로 모아 until 노드 출력으로 둔다. 본문 자식 출력(마지막)은 유지.
 */
async function execUntil(
  opts: RunOptions,
  params: Record<string, string>,
  outputs: Map<string, unknown>,
  pool: ConnectionPool,
  fsDir: string,
  n: Node,
  mode: RunMode,
  byId: Map<string, Node>,
  runId: string,
  start: number,
): Promise<NodeResult> {
  const done = (r: Omit<NodeResult, "durationMs">): NodeResult => ({ ...r, durationMs: Date.now() - start });
  const spec = (n as unknown as { until?: { until?: unknown; maxIterations?: unknown; carry?: unknown } }).until;
  if (!spec || typeof spec.maxIterations !== "number" || spec.maxIterations <= 0) {
    throw Object.assign(new Error(`until spec 없음: ${n.id}`), { code: "bad_request" });
  }
  const maxIterations = Math.floor(spec.maxIterations);
  const template = (spec as { template?: { tool?: { server?: unknown; name?: unknown }; args?: unknown; constraints?: unknown } }).template;
  if (!template || typeof template.tool?.server !== "string" || typeof template.tool?.name !== "string") {
    throw Object.assign(new Error(`until 템플릿 도구 없음: ${n.id}`), { code: "bad_request" });
  }
  const templateArgs = (template.args ?? {}) as Record<string, import("@procforge/shared/schema.js").ArgSpec>;
  const templateConstraints = (Array.isArray(template.constraints) ? template.constraints : []) as import("@procforge/shared/schema.js").Constraint[];
  const carryPath = typeof spec.carry === "string" && spec.carry.startsWith("$self.")
    ? spec.carry.slice("$self.".length)
    : null;
  const untilConstraint = spec.until as import("@procforge/shared/schema.js").Constraint | undefined;
  const supplied: Record<string, unknown> = (opts.supplied?.[n.id] ?? {}) as Record<string, unknown>;
  // live generated 게이트: 템플릿 generated는 until 단위 supplied로 해결
  if (mode === "live") {
    const missing = Object.entries(templateArgs)
      .filter(([k, s]) => (s as { kind?: string }).kind === "generated" && !Object.prototype.hasOwnProperty.call(supplied, k))
      .map(([k]) => k);
    if (missing.length > 0) {
      return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: `need_generated:${missing.join(",")}` });
    }
  }
  // live external 게이트: until 단위 중단 (인스턴스는 until sideEffect 상속).
  // M5.5-4: 무인 실행은 중단하지 않고 반복별로 execNode 승인 검사에 맡긴다
  // (거부는 execNode fail ["approval"] → 아래 r.failedConstraints 그대로 전파).
  if (mode === "live" && n.sideEffect === "external" && !(opts.approvedNodeIds ?? []).includes(n.id) && !opts.unattended) {
    return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: "need_approval" });
  }
  const pages: unknown[] = [];
  let carry: { present: boolean; value: unknown } | undefined;
  for (let i = 0; i < maxIterations; i++) {
    const instanceId = `${n.id}.${i + 1}`;
    let inst: Node;
    try {
      const normed = normalizeArgSpecs(templateArgs, {
        sandboxDir: join(opts.procforgeDir, "sandbox", opts.sessionId),
        projectRoot: opts.projectRoot,
      }).specs;
      const fixedGen: Record<string, import("@procforge/shared/schema.js").ArgSpec> = {};
      for (const [k, s] of Object.entries(normed)) {
        if ((s as { kind?: string }).kind === "generated") {
          if (!Object.prototype.hasOwnProperty.call(supplied, k)) {
            throw new Error(`generated 인자 미공급: ${k} (until ${n.id}에 supply)`);
          }
          fixedGen[k] = { kind: "fixed", value: supplied[k] } as never;
        }
      }
      inst = {
        id: instanceId,
        parentId: n.id,
        goal: `${n.goal} [${i}]`,
        status: "leaf",
        depth: n.depth + 1,
        dependsOn: [],
        children: [],
        tool: {
          server: template.tool.server,
          name: template.tool.name,
          schemaHash: n.tool?.schemaHash ?? "until",
        },
        args: { ...normed, ...fixedGen },
        sideEffect: n.sideEffect,
        constraints: templateConstraints,
        advice: [],
        attempts: [],
        retries: 0,
        hash: `${n.hash}#${i}`,
        locked: false,
      } as Node;
    } catch (e) {
      return done({
        nodeId: n.id,
        status: "fail",
        failedConstraints: [],
        failedItems: [i],
        detail: `until 반복 ${i} 준비 실패: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    let r: NodeResult;
    try {
      r = await execNode(opts, params, outputs, pool, fsDir, inst, mode, byId, runId, carry);
    } catch (e) {
      return done({
        nodeId: n.id,
        status: "fail",
        failedConstraints: [],
        failedItems: [i],
        detail: `until 반복 ${i} 실패: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (r.status === "suspended") {
      for (let j = 0; j <= i; j++) outputs.delete(`${n.id}.${j + 1}`);
      return done({ nodeId: n.id, status: "suspended", failedConstraints: [], detail: r.detail });
    }
    const out = outputs.get(instanceId);
    outputs.delete(instanceId);
    if (r.status !== "pass") {
      return done({
        nodeId: n.id,
        status: "fail",
        failedConstraints: r.failedConstraints,
        failedItems: [i],
        detail: `until 반복 ${i} 실패: ${r.detail ?? r.failedConstraints.join(",")}`,
      });
    }
    pages.push(out ?? null);
    // 종료 조건 판정 (제약 충족 = 중단·성공)
    if (untilConstraint) {
      const cr = evaluateAll([untilConstraint], {
        resultSummary: `until 반복 ${i}`,
        resultJson: out,
        artifacts: {},
        fileExists: makeFileExists(opts.procforgeDir, opts.sessionId, fsDir, params),
        nodeOutputs: Object.fromEntries(outputs),
        params,
        fsDir,
      });
      const failed = cr.failedConstraints.length > 0;
      const undecided = cr.unverified.length > 0;
      if (!failed && !undecided) break;
      if (undecided) {
        return done({
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          failedItems: [i],
          detail: `until 판정 불가: ${cr.unverified.join(",")}`,
        });
      }
    }
    if (i + 1 >= maxIterations) {
      return done({
        nodeId: n.id,
        status: "fail",
        failedConstraints: ["maxIterations"],
        failedItems: [],
        detail: `until 미수렴: ${maxIterations}회 반복에도 종료 조건 불충족`,
      });
    }
    if (carryPath !== null) {
      try {
        const v = getByDot(out, carryPath);
        carry = { present: true, value: v };
      } catch {
        return done({
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          failedItems: [i],
          detail: `until carry 없음: ${spec.carry}`,
        });
      }
    }
  }
  outputs.set(n.id, pages);
  const summary = `until ${pages.length}회`;
  const cr = evaluateAll(n.constraints, {
    resultSummary: summary,
    resultJson: pages,
    artifacts: {},
    fileExists: makeFileExists(opts.procforgeDir, opts.sessionId, fsDir, params),
    nodeOutputs: Object.fromEntries(outputs),
    params,
    fsDir,
  });
  if (cr.failedConstraints.length > 0) {
    return done({
      nodeId: n.id,
      status: "fail",
      failedConstraints: cr.failedConstraints,
      failedItems: [],
      detail: `until 집계 제약 실패: ${cr.failedConstraints.join(",")}`,
    });
  }
  if (cr.unverified.length > 0) {
    return done({ nodeId: n.id, status: "unverified", failedConstraints: [], failedItems: [], detail: summary });
  }
  return done({ nodeId: n.id, status: "pass", failedConstraints: [], failedItems: [], detail: summary });
}

function updateNodeGolden(opts: RunOptions, n: Node, resp: ToolResponse): void {  const store = new FileStore(opts.procforgeDir);
  const cur = store.getNode(opts.sessionId, n.id);
  if (!cur) return;
  // updateGolden은 golden.output만 갱신 (fixtures는 pf_report 소유). (DECISIONS M3)
  // M5.3.1-4: 갱신 시에도 녹화 원문 그대로 (템플릿 치환 금지, replay 전용)
  const next: Node = { ...cur, golden: { fixtures: [...(cur.golden?.fixtures ?? [])], output: resp.resultText, attemptId: cur.golden?.attemptId, ignore: cur.golden?.ignore ?? [] } };
  store.saveNode(opts.sessionId, next);
}
