import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskParamsValues } from "@procforge/shared/normalize.js";
import { compareNodeIds } from "@procforge/shared/ids.js";
import { effectiveDeps, expandDepLeafs, rawDepSources } from "@procforge/shared/deps.js";
import type { Node } from "@procforge/shared/schema.js";
import { FileStore } from "../filestore.js";
import { evaluateAll } from "../checker.js";
import { logger } from "../logger.js";
import { writeAtomicFile } from "../fsutil.js";
import { normalizeArgSpecs, fixtureFileExists, readManifest } from "../artifacts.js";
import { ConnectionPool } from "./connections.js";
import { findRecording, loadCassette, recordKey, saveRecording, toToolResponse, compareToolResponses } from "./recordings.js";
import { resolveArgs } from "./resolve.js";
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

export async function runSession(opts: RunOptions): Promise<RunReport> {
  const mode: RunMode = opts.mode ?? "replay";
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
  byId: Map<string, Node>,
  runId: string,
): Promise<NodeResult> {
  const start = Date.now();
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
  const roles: Record<string, PathRole | InferredRole | undefined> = {};
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
    // M3.4-1: readOnly는 확정 아님. infer 결과 그대로 (weakIn 포함).
    roles[k] = inferPathRole(k, inputSchema);
  }
  const args = rewritePaths(
    resolveArgs({
      specs,
      params,
      outputs,
      attempts: n.attempts,
      goldenAttemptId: n.golden?.attemptId,
      live: mode === "live",
      supplied: opts.supplied?.[n.id],
      topo: {
        isSplit: (id) => byId.get(id)?.status === "split",
        childrenOf: (id) => byId.get(id)?.children ?? [],
      },
    }),
    roles,
    { fsDir, projectRoot: opts.projectRoot, allowProjectRead: opts.allowProjectRead ?? false, toolReadOnly: readOnly },
  );
  const server = n.tool!.server;
  const tool = n.tool!.name;
  const key = recordKey(fsDir, opts.projectRoot, server, tool, args);
  let resp: ToolResponse;
  let mocked = false;

  if (n.sideEffect === "external" && mode !== "live") {
    // record/replay/passthrough에서 실제 호출 금지 (M3)
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (rec) {
      resp = toToolResponse(rec, fsDir);
    } else {
      mocked = true;
      resp = { resultText: "[mock external]", resultJson: { mock: true } };
    }
  } else if (mode === "live" && n.sideEffect === "external" && !(opts.approvedNodeIds ?? []).includes(n.id)) {
    // M5: live에서도 사람 승인 없이는 실행 금지
    return { nodeId: n.id, status: "suspended", failedConstraints: [], detail: "need_approval", durationMs: Date.now() - start };
  } else if (mode === "replay") {
    // M3.1-1: replay는 녹화 적중 + constraints만. golden 비교 없음.
    const rec = findRecording(loadCassette(opts.procforgeDir, opts.sessionId, n.id), key);
    if (!rec) throw new Error(`녹화 없음: ${server}/${tool} (키 ${key}). record 모드로 먼저 녹화하라.`);
    resp = toToolResponse(rec, fsDir);
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
  const manifest = readManifest(opts.procforgeDir, opts.sessionId);
  const sessDir = join(opts.procforgeDir, "sessions", opts.sessionId);
  const fileExists = (p: string) => {
    if (fixtureFileExists(join(sessDir, p))) return true;
    for (const [fx, src] of Object.entries(manifest)) {
      if (src === p && fixtureFileExists(join(sessDir, fx))) return true;
    }
    return false;
  };
  const nodeOutputs: Record<string, unknown> = {};
  for (const [k, v] of outputs) nodeOutputs[k] = v;
  const r = evaluateAll(n.constraints, {
    resultSummary: resp.resultText,
    resultJson: resp.resultJson,
    artifacts: {},
    fileExists,
    nodeOutputs,
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
  // M3.6-4: 갱신 시에도 params 자리표시자로 저장
  const params = store.getSession(opts.sessionId)?.params ?? {};
  const next: Node = { ...cur, golden: { fixtures: [...(cur.golden?.fixtures ?? [])], output: maskParamsValues(resp.resultText, params), attemptId: cur.golden?.attemptId, ignore: cur.golden?.ignore ?? [] } };
  store.saveNode(opts.sessionId, next);
}
