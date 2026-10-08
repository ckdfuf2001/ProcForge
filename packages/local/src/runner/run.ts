import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Node } from "@procforge/shared/schema.js";
import { FileStore } from "../filestore.js";
import { evaluateAll } from "../checker.js";
import { logger } from "../logger.js";
import { ConnectionPool } from "./connections.js";
import { findRecording, loadCassette, recordKey, saveRecording, toToolResponse } from "./recordings.js";
import { resolveArgs, rewritePaths } from "./resolve.js";
import { setupRunFs } from "./workdir.js";
import type { NodeResult, RunMode, RunOptions, RunReport, ToolResponse } from "./types.js";

/** 노드 id 세그먼트 숫자 비교 (core compareNodeIds와 동일, local 자족용 복제) */
function compareNodeIds(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function orderNodes(nodes: Node[]): Node[] {
  // dependsOn 위상 정렬 + id 순서
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inScope = new Set(nodes.map((n) => n.id));
  const done = new Set<string>();
  const out: Node[] = [];
  const pending = [...nodes].sort((a, b) => compareNodeIds(a.id, b.id));
  let guard = pending.length * pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const i = pending.findIndex((n) => n.dependsOn.filter((d) => inScope.has(d)).every((d) => done.has(d)));
    if (i === -1) throw new Error(`의존 해소 불가(순환?): ${pending.map((n) => n.id).join(",")}`);
    const [n] = pending.splice(i, 1);
    void byId;
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

function readLatestHashes(procforgeDir: string, sessionId: string): Record<string, string> | undefined {
  const p = latestReportPath(procforgeDir, sessionId);
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { nodeHashes: Record<string, string> }).nodeHashes;
  } catch {
    return undefined;
  }
}

export function toJUnit(report: RunReport): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cases = report.results
    .map((r) => {
      const fail = r.status === "fail" ? `<failure message="${esc(r.detail ?? "failed")}">${esc(r.failedConstraints.join(","))}</failure>` : "";
      return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}">${fail}</testcase>`;
    })
    .join("\n");
  const failures = report.results.filter((r) => r.status === "fail").length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="procforge" tests="${report.results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

export async function runSession(opts: RunOptions): Promise<RunReport> {
  const mode: RunMode = opts.mode ?? "replay";
  const store = new FileStore(opts.procforgeDir);
  const session = store.getSession(opts.sessionId);
  if (!session) throw Object.assign(new Error(`세션 없음: ${opts.sessionId}`), { code: "session_not_found" });
  const runId = opts.runId ?? randomUUID();
  const { runDir, fsDir } = setupRunFs(opts.procforgeDir, opts.sessionId, runId);
  const release = store.acquireLock(opts.sessionId, 60000);
  const pool = new ConnectionPool(opts.projectRoot, fsDir, opts.allowBash ?? false);
  const t0 = Date.now();
  try {
    let all = [...store.getNodes(opts.sessionId).values()];
    if (opts.nodeId) {
      if (!all.some((n) => n.id === opts.nodeId)) throw Object.assign(new Error(`노드 없음: ${opts.nodeId}`), { code: "not_found" });
      all = subtree(all, opts.nodeId);
    }
    // --changed: hash 변경 + 하류만
    let targets = new Set(all.map((n) => n.id));
    if (opts.changed) {
      const prev = readLatestHashes(opts.procforgeDir, opts.sessionId);
      if (prev) {
        const changedIds = new Set(all.filter((n) => prev[n.id] !== n.hash).map((n) => n.id));
        const queue = [...changedIds];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const n of all) {
            if (n.dependsOn.includes(cur) && !changedIds.has(n.id)) {
              changedIds.add(n.id);
              queue.push(n.id);
            }
          }
        }
        targets = changedIds;
      }
    }
    const ordered = orderNodes(all);
    const outputs = new Map<string, unknown>();
    // 범위 밖 의존 출력은 golden에서 공급
    for (const n of all) {
      if (n.golden && !outputs.has(n.id)) {
        try {
          outputs.set(n.id, JSON.parse(n.golden.output));
        } catch {
          outputs.set(n.id, n.golden.output);
        }
      }
    }

    const results: NodeResult[] = [];
    for (const n of ordered) {
      const start = Date.now();
      if (!targets.has(n.id)) {
        results.push({ nodeId: n.id, status: "skipped", failedConstraints: [], detail: "scope/changes 제외", durationMs: 0 });
        continue;
      }
      if (n.status !== "leaf" || !n.tool) {
        results.push({ nodeId: n.id, status: "skipped", failedConstraints: [], detail: `leaf 아님(${n.status})`, durationMs: 0 });
        continue;
      }
      try {
        results.push(await execNode(opts, session.params, outputs, pool, fsDir, n, mode));
      } catch (e) {
        results.push({
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          detail: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
      }
    }

    const summary = {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      unverified: results.filter((r) => r.status === "unverified").length,
      skipped: results.filter((r) => r.status === "skipped").length,
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
    writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
    const latestPath = latestReportPath(opts.procforgeDir, opts.sessionId);
    mkdirSync(dirname(latestPath), { recursive: true });
    writeFileSync(latestPath, JSON.stringify({ runId, at: report.at, nodeHashes: report.nodeHashes }));
    logger.info("run complete", { runId, ...summary, durationMs: Date.now() - t0 });
    return report;
  } finally {
    release();
    await pool.close();
  }
}

async function execNode(
  opts: RunOptions,
  params: Record<string, string>,
  outputs: Map<string, unknown>,
  pool: ConnectionPool,
  fsDir: string,
  n: Node,
  mode: RunMode,
): Promise<NodeResult> {
  const start = Date.now();
  const last = n.attempts[n.attempts.length - 1];
  const args = rewritePaths(
    resolveArgs({
      specs: n.args ?? {},
      params,
      outputs,
      lastAttemptArgs: last?.args ?? {},
      live: mode === "passthrough",
    }),
    fsDir,
  );
  const server = n.tool!.server;
  const tool = n.tool!.name;
  const key = recordKey(fsDir, server, tool, args);
  let resp: ToolResponse;
  let mocked = false;

  if (n.sideEffect === "external") {
    // 모든 모드에서 실제 호출 금지 (M3)
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (rec) {
      resp = toToolResponse(rec);
    } else {
      mocked = true;
      resp = { resultText: "[mock external]", resultJson: { mock: true } };
    }
  } else if (mode === "replay") {
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (!rec) throw new Error(`녹화 없음: ${server}/${tool} (키 ${key}). record 모드로 먼저 녹화하라.`);
    resp = toToolResponse(rec);
  } else {
    // record / passthrough: 실제 호출
    resp = await pool.call(server, tool, args);
    if (mode === "record") {
      saveRecording(opts.procforgeDir, opts.sessionId, n.id, {
        key,
        server,
        tool,
        args,
        response: { summary: resp.resultText, json: resp.resultJson },
        at: new Date().toISOString(),
      });
    }
  }

  outputs.set(n.id, resp.resultJson ?? resp.resultText);

  // golden 비교 (replay만). updateGolden이면 비교 대신 갱신.
  if (mode === "replay" && n.golden) {
    if (resp.resultText !== n.golden.output) {
      if (opts.updateGolden) {
        updateNodeGolden(opts, n, resp);
      } else {
        return {
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          detail: `golden 불일치. expected=${JSON.stringify(n.golden.output).slice(0, 200)} actual=${JSON.stringify(resp.resultText).slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }
    }
  }
  if (opts.updateGolden && mode !== "replay") {
    updateNodeGolden(opts, n, resp);
  }

  // 판정 (checker 재사용, llm_rubric은 별도 집계)
  const fileExists = (p: string) => existsSync(join(opts.procforgeDir, "sessions", opts.sessionId, p));
  const r = evaluateAll(n.constraints, {
    resultSummary: resp.resultText,
    resultJson: resp.resultJson,
    artifacts: {},
    fileExists,
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

function updateNodeGolden(opts: RunOptions, n: Node, resp: ToolResponse): void {
  const store = new FileStore(opts.procforgeDir);
  const cur = store.getNode(opts.sessionId, n.id);
  if (!cur) return;
  // updateGolden은 golden.output만 갱신 (fixtures는 pf_report 확정 경로가 소유).
  // 파일 산출물 갱신이 필요하면 호스트가 pf_report로 다시 확정한다. (DECISIONS M3)
  const next: Node = { ...cur, golden: { fixtures: [...(cur.golden?.fixtures ?? [])], output: resp.resultText } };
  store.saveNode(opts.sessionId, next);
}
