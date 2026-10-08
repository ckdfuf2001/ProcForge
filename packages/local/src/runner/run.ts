import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareNormalized } from "@procforge/shared/normalize.js";
import { compareNodeIds } from "@procforge/shared/ids.js";
import type { Node } from "@procforge/shared/schema.js";
import { FileStore } from "../filestore.js";
import { evaluateAll } from "../checker.js";
import { logger } from "../logger.js";
import { normalizeArgSpecs } from "../artifacts.js";
import { ConnectionPool } from "./connections.js";
import { findRecording, loadCassette, recordKey, saveRecording, toToolResponse } from "./recordings.js";
import { resolveArgs } from "./resolve.js";
import { inferPathRole, rewritePaths, type PathRole } from "./paths.js";
import { setupRunFs } from "./workdir.js";
import type { NodeResult, RunMode, RunOptions, RunReport, ToolResponse } from "./types.js";

function orderNodes(nodes: Node[]): Node[] {
  const inScope = new Set(nodes.map((n) => n.id));
  const done = new Set<string>();
  const out: Node[] = [];
  const pending = [...nodes].sort((a, b) => compareNodeIds(a.id, b.id));
  let guard = pending.length * pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const i = pending.findIndex((n) => n.dependsOn.filter((d) => inScope.has(d)).every((d) => done.has(d)));
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
      if (r.status === "fail") {
        return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"><failure message="${esc(r.detail ?? "failed")}">${esc(r.failedConstraints.join(","))}</failure></testcase>`;
      }
      if (r.status === "unverified" || r.status === "skipped" || r.status === "blocked") {
        return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"><skipped message="${esc(r.detail ?? r.status)}"/></testcase>`;
      }
      return `    <testcase classname="procforge" name="${esc(r.nodeId)}" time="${(r.durationMs / 1000).toFixed(3)}"/>`;
    })
    .join("\n");
  const failures = report.results.filter((r) => r.status === "fail").length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="procforge" tests="${report.results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

export async function runSession(opts: RunOptions): Promise<RunReport> {
  const mode: RunMode = opts.mode ?? "replay";
  if (mode === "live") {
    throw Object.assign(new Error("live 모드(generated 재생성)는 M5에서 구현"), { code: "unimplemented" });
  }
  if (mode === "replay" && opts.updateGolden) {
    throw Object.assign(new Error("--update-golden은 record/passthrough에서만 허용 (replay 불가)"), { code: "bad_request" });
  }
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
      // 실패 전파 (M3.1-4): 범위 내 의존이 fail/blocked이거나 출력이 없으면 blocked
      const badDep = n.dependsOn.find((d) => {
        if (!targets.has(d)) return false; // 범위 밖은 golden 선주입됨
        const dr = resultOf.get(d);
        if (!dr) return true;
        return dr.status === "fail" || dr.status === "blocked" || !outputs.has(d);
      });
      if (badDep) {
        const r: NodeResult = { nodeId: n.id, status: "blocked", failedConstraints: [], detail: `blocked by ${badDep}`, durationMs: Date.now() - start };
        results.push(r);
        resultOf.set(n.id, r);
        continue;
      }
      try {
        const r = await execNode(opts, session.params, outputs, pool, fsDir, n, mode);
        results.push(r);
        resultOf.set(n.id, r);
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
  // 구 세션 마이그레이션: 절대경로 fixed → 상대경로 (M3.2-2)
  const normSpecs = normalizeArgSpecs(n.args ?? {}, {
    sandboxDir: join(opts.procforgeDir, "sandbox", opts.sessionId),
    projectRoot: opts.projectRoot,
  });
  if (normSpecs.warnings.length > 0) logger.warn("absolute path kept", { nodeId: n.id, warnings: normSpecs.warnings });
  const specs = normSpecs.specs;
  const inputSchema = catalogInputSchema(opts, n);
  const readOnly = catalogReadOnly(opts, n);
  const roles: Record<string, PathRole | undefined> = {};
  for (const [k, spec] of Object.entries(specs)) {
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
    if (readOnly) {
      roles[k] = "in";
      continue;
    }
    roles[k] = inferPathRole(k, inputSchema) as PathRole | undefined;
  }
  const args = rewritePaths(
    resolveArgs({
      specs,
      params,
      outputs,
      attempts: n.attempts,
      goldenAttemptId: n.golden?.attemptId,
      live: mode === "live",
    }),
    roles,
    { fsDir, projectRoot: opts.projectRoot, allowProjectRead: opts.allowProjectRead ?? false, toolReadOnly: readOnly },
  );
  const server = n.tool!.server;
  const tool = n.tool!.name;
  const key = recordKey(fsDir, opts.projectRoot, server, tool, args);
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
    // M3.1-1: replay는 녹화 적중 + constraints만. golden 비교 없음.
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

  // drift 검출: passthrough에서만 golden 정규화 비교 (M3.1-1/2)
  if (mode === "passthrough" && n.golden) {
    const d = compareNormalized(n.golden.output, resp.resultText, n.golden.ignore ?? [], fsDir);
    if (!d.equal) {
      if (opts.updateGolden) {
        updateNodeGolden(opts, n, resp);
      } else {
        return {
          nodeId: n.id,
          status: "fail",
          failedConstraints: [],
          detail: `golden drift @${d.path}. expected=${d.expectedExcerpt} actual=${d.actualExcerpt}`,
          durationMs: Date.now() - start,
        };
      }
    }
  }
  if (opts.updateGolden && mode === "record") {
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

function updateNodeGolden(opts: RunOptions, n: Node, resp: ToolResponse): void {
  const store = new FileStore(opts.procforgeDir);
  const cur = store.getNode(opts.sessionId, n.id);
  if (!cur) return;
  // updateGolden은 golden.output만 갱신 (fixtures는 pf_report 소유). (DECISIONS M3)
  const next: Node = { ...cur, golden: { fixtures: [...(cur.golden?.fixtures ?? [])], output: resp.resultText, attemptId: cur.golden?.attemptId, ignore: cur.golden?.ignore ?? [] } };
  store.saveNode(opts.sessionId, next);
}
