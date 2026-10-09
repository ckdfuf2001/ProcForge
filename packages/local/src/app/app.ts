import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CoreClient } from "@procforge/shared/core-client.js";
import type { Session } from "@procforge/shared/schema.js";
import { pfError } from "@procforge/shared/errors.js";
import type { FileStore } from "../filestore.js";
import { collectCatalog } from "../catalog.js";
import { nodeSummary } from "../views.js";
import { seedSandbox } from "../services/workspace.js";
import { logger } from "../logger.js";
import { diffSnapshot, readCaptureRecord, readPreSnapshot, takeSandboxSnapshot, toBaseRel, writePreSnapshot } from "../services/snapshot.js";
import { classifyReportPaths, collectExistingPaths, ingestReportJobs } from "../services/artifacts.js";
import { ingestArtifacts, normalizeArgSpecs, readManifest } from "../artifacts.js";

// ProcForge 유스케이스층 (M4.2-1). 사용자 행동 1개 = 메서드 1개.
// 어댑터(server/cli/ui)는 입력 검증·호출·응답 포맷만 하고 정책·파일 작업은 여기에 위임한다.

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/** 분해 루프 안내 (prompt + pf_start 첫 응답 공유, 정책 세부 없음) */
export const PROMPT_TEXT = [
  "ProcForge 분해 루프:",
  "1. pf_next로 노드 1개를 받는다. done=true면 끝.",
  "2. 노드가 도구 1회로 가능하면 sandbox 사본에서 실행 후 pf_report(selfVerdict/selfReason 필수).",
  "3. 너무 크면 pf_split로 나눈다.",
  "4. pass여도 자동 확정 없음. pf_confirm_leaf(tool, argSpecs)로 확정한다.",
  "5. 외부에 영향을 주는 실행은 직접 하지 말고 pf_ask_human으로 승인 요청.",
  "6. needs_human이면 사람 조언을 pf_advise로 등록한 뒤 계속한다.",
].join("\n");

export type AppDeps = {
  core: CoreClient;
  store: FileStore;
  procforgeDir: string;
  projectRoot: string;
  sessionTtlMs?: number;
  strictSandbox?: boolean;
  maxArtifactBytes?: number;
};

export class ProcForgeApp {
  private core: CoreClient;
  private store: FileStore;
  private procforgeDir: string;
  private projectRoot: string;
  private sessionTtlMs: number | undefined;
  private strictSandbox: boolean;
  private maxArtifactBytes: number;

  constructor(deps: AppDeps) {
    this.core = deps.core;
    this.store = deps.store;
    this.procforgeDir = deps.procforgeDir;
    this.projectRoot = deps.projectRoot;
    this.sessionTtlMs = deps.sessionTtlMs;
    this.strictSandbox = deps.strictSandbox ?? true;
    this.maxArtifactBytes = deps.maxArtifactBytes ?? 5 * 1024 * 1024;
  }

  /** 세션 신선도 확인 (server requireFresh 이동). 없으면 touch 후 반환 */
  private fresh(sessionId: string): Session {
    const s = this.store.getSession(sessionId);
    if (!s) throw pfError("session_not_found", `세션 없음: ${sessionId}`);
    const ttl = this.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const last = this.store.getLastUsed(sessionId);
    if (last === undefined) {
      this.store.touch(sessionId);
      return s;
    }
    if (Date.now() - last > ttl) throw pfError("session_not_found", `세션 만료: ${sessionId}`);
    return s;
  }

  /** 변경계 유스케이스용 세션 락 (server W() 이동) */
  private async locked<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
    const release = this.store.acquireLock(sessionId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async start(a: any): Promise<Record<string, unknown>> {    const collected = a.toolCatalog
      ? undefined
      : await collectCatalog(this.projectRoot, { cacheDir: join(this.procforgeDir, "cache") });
    const catalog = a.toolCatalog ?? collected!.entries;
    const warnings = collected?.warnings ?? [];
    const out = await this.core.pfStart({ request: a.request as string, params: a.params as Record<string, string> | undefined, toolCatalog: catalog as never, limits: a.limits as never, opencodeVersion: collected?.opencodeVersion });
    this.store.touch(out.session.id);
    const sandboxNote = seedSandbox({
      procforgeDir: this.procforgeDir,
      sessionId: out.session.id,
      projectRoot: this.projectRoot,
      seedFiles: a.seedFiles as string[] | undefined,
    });
    return {
      sessionId: out.session.id,
      node: nodeSummary(out.node, out.session.limits),
      instruction: `${PROMPT_TEXT}\n\n${out.instruction}${sandboxNote}`,
      warnings,
      sessionExpiresInDays: Math.round((this.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 86400000),
      opencodeVersion: out.session.opencodeVersion ?? "unknown",
    };
  }

  async next(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    const s = this.fresh(sid);
    const out = await this.core.pfNext(sid);
    this.store.touch(sid);
    if (out.done) return { done: true };
    // M4.1-7: 노드 분기 직전 sandbox 스냅샷 (pf_report 입출력 판정용)
    try {
      writePreSnapshot(
        this.procforgeDir, sid, out.node.id,
        takeSandboxSnapshot(join(this.procforgeDir, "sandbox", sid)),
      );
    } catch {
      // 추적 실패 무시
    }
    return {
      done: false,
      node: nodeSummary(out.node, s.limits),
      ...(out.blocked ? { blocked: out.blocked } : {}),
      instruction: out.instruction,
    };
  }

  async report(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const sess = this.fresh(sid);
      const nid = a.nodeId as string;
      const attemptId = randomUUID();
      const toolRef = a.tool as { server: string; name: string };
      const args = (a.args ?? {}) as Record<string, unknown>;
      const baseDir = this.strictSandbox ? join(this.procforgeDir, "sandbox", sid) : this.projectRoot;
      const cat = sess.toolCatalog.find((t) => t.server === toolRef.server && t.name === toolRef.name);
      // M4.1-7 스냅샷 판정: 새로 생기거나 바뀐 파일 → out, 그 외 자동분 → in.
      // 호스트 제출분은 명시 입력(in) 유지. 스냅샷 없으면 기존 로직 폴백 + 경고.
      const reportWarnings: string[] = [];
      let outRels: Set<string> | undefined;
      if (this.strictSandbox) {
        const pre = readPreSnapshot(this.procforgeDir, sid, nid);
        if (!pre) {
          reportWarnings.push(`스냅샷 없음(${nid}): 기존 존재 기반 캡처로 폴백 (pf_next 경유 권장)`);
        } else {
          const d = diffSnapshot(pre, baseDir);
          outRels = new Set([...d.created, ...d.modified]);
        }
      }
      const jobs = classifyReportPaths({
        baseDir, tool: toolRef, args, catalogEntry: cat,
        resultJson: a.resultJson, hostPaths: (a.artifacts ?? []) as string[], outRels,
      });
      const { stored, contents } = ingestReportJobs({
        procforgeDir: this.procforgeDir, sessionId: sid, nodeId: nid,
        attemptId, baseDir, jobs, maxBytes: this.maxArtifactBytes,
      });
      const out = await this.core.pfReport({
        sessionId: sid,
        nodeId: nid,
        tool: toolRef,
        args,
        resultSummary: a.resultSummary as string,
        resultJson: a.resultJson,
        artifacts: stored,
        artifactContents: contents,
        selfVerdict: a.selfVerdict as "pass" | "fail",
        selfReason: a.selfReason as string,
        rubricReasons: a.rubricReasons as Record<string, string> | undefined,
        attemptId,
      });
      this.store.touch(sid);
      return { ...(out as unknown as Record<string, unknown>), warnings: reportWarnings };
    });
  }

  async confirmLeaf(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      if (!a.argSpecs) throw pfError("bad_request", "argSpecs가 없다.", "마지막 실행 인자 키를 모두 분류해 pf_confirm_leaf 재호출.");
      const norm = normalizeArgSpecs(a.argSpecs as Record<string, import("@procforge/shared/schema.js").ArgSpec>, {
        sandboxDir: join(this.procforgeDir, "sandbox", sid),
        projectRoot: this.projectRoot,
      });
      // M3.6-2 확정 시 추캡처: 명시 in/inout fixed 경로 중 미수집분
      const nodeId = a.nodeId as string;
      const cur = this.store.getNode(sid, nodeId);
      const last = cur?.attempts[cur.attempts.length - 1];
      if (cur && last) {
        // M4.1-7: 보고 시 out 판정분은 attempt에서 제외 (golden 입력 순수 유지, 증거 파일은 보존)
        const sidecar = readCaptureRecord(this.procforgeDir, sid, nodeId, last.id);
        const outSet = new Set(sidecar?.outs ?? []);
        const kept = last.artifacts.filter((fx) => !outSet.has(fx));
        const fixedArgs: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(norm.specs)) {
          if (spec.kind === "fixed") fixedArgs[k] = (spec as { value: unknown }).value;
        }
        const baseDir = this.strictSandbox ? join(this.procforgeDir, "sandbox", sid) : this.projectRoot;
        const manifest = readManifest(this.procforgeDir, sid);
        const covered = new Set(
          last.artifacts.map((fx) => manifest[fx]).filter((v): v is string => typeof v === "string"),
        );
        const toolRef = a.tool as { server: string; name: string };
        const cat = s.toolCatalog.find((t) => t.server === toolRef.server && t.name === toolRef.name);
        const relOf = (p: string) => toBaseRel(baseDir, p);
        const fresh = collectExistingPaths({
          baseDir, tool: toolRef, args: fixedArgs, specs: norm.specs, catalogEntry: cat, roles: ["in", "inout"],
        }).filter((p) => !covered.has(relOf(p)));
        const merged = [...kept];
        if (fresh.length > 0) {
          const ing = ingestArtifacts({
            procforgeDir: this.procforgeDir, sessionId: sid, nodeId, attemptId: last.id,
            baseDir, paths: fresh, maxBytes: this.maxArtifactBytes, startIndex: last.artifacts.length,
          });
          merged.push(...ing.stored);
        }
        if (merged.length !== last.artifacts.length) {
          await this.core.amendAttemptArtifacts({ sessionId: sid, nodeId, attemptId: last.id, artifacts: merged });
        }
      }
      const out = await this.core.pfResolve({
        sessionId: sid,
        nodeId: a.nodeId as string,
        decision: "leaf",
        tool: a.tool as { server: string; name: string },
        argSpecs: norm.specs as never,
        sideEffect: a.sideEffect as "none" | "local_write" | "external" | undefined,
        goldenIgnore: a.ignore as string[] | undefined,
      });
      this.store.touch(sid);
      return { node: nodeSummary(out.node, s.limits), instruction: out.instruction, warnings: norm.warnings };
    });
  }

  async retry(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      logger.info("pf_retry", { sessionId: sid, nodeId: a.nodeId, reason: a.reason });
      const out = await this.core.pfResolve({ sessionId: sid, nodeId: a.nodeId as string, decision: "retry" });
      this.store.touch(sid);
      return { node: nodeSummary(out.node, s.limits), instruction: out.instruction };
    });
  }

  async split(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      const kids = a.children as { goal: string; dependsOn?: string[]; sideEffect?: "none" | "local_write" | "external" }[] | undefined;
      if (!kids || kids.length === 0) throw pfError("bad_request", "children이 비었다.", "최소 1개의 {goal}을 넣어 pf_split 재호출.");
      const out = await this.core.pfResolve({ sessionId: sid, nodeId: a.nodeId as string, decision: "split", children: kids });
      this.store.touch(sid);
      return {
        node: nodeSummary(out.node, s.limits),
        created: (out.created ?? []).map((c) => nodeSummary(c, s.limits)),
        instruction: out.instruction,
      };
    });
  }

  async askHuman(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      logger.info("pf_ask_human", { sessionId: sid, nodeId: a.nodeId, question: a.question });
      const out = await this.core.pfResolve({
        sessionId: sid,
        nodeId: a.nodeId as string,
        decision: "ask_human",
        plan: a.plan as { tool: { server: string; name: string }; args: Record<string, unknown> } | undefined,
        note: a.question as string,
      });
      this.store.touch(sid);
      return { node: nodeSummary(out.node, s.limits), instruction: out.instruction };
    });
  }

  async approve(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      const n = await this.core.pfApprove(sid, a.nodeId as string, a.approved as boolean, a.note as string | undefined);
      this.store.touch(sid);
      return { node: nodeSummary(n, s.limits) };
    });
  }

  async tree(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    const s = this.fresh(sid);
    const { nodes } = await this.core.pfTree(sid);
    this.store.touch(sid);
    const detail = (a.detail as string | undefined) ?? "summary";
    const limit = (a.limit as number | undefined) ?? 50;
    const cursor = (a.cursor as number | undefined) ?? 0;
    const root = a.nodeId as string | undefined;
    let set = nodes;
    if (root) {
      const keep = new Set<string>([root]);
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
      set = nodes.filter((n) => keep.has(n.id));
    }
    const counts: Record<string, number> = {};
    for (const n of set) counts[n.status] = (counts[n.status] ?? 0) + 1;
    const page = set.slice(cursor, cursor + limit);
    return {
      entries: page.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        goal: detail === "full" ? n.goal : n.goal.slice(0, 80),
        status: n.status,
        ...(detail === "full" ? { node: n } : {}),
      })),
      counts,
      hasMore: cursor + limit < set.length,
      nextCursor: cursor + limit < set.length ? cursor + limit : null,
    };
  }

  async getNode(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    this.fresh(sid);
    const { nodes } = await this.core.pfTree(sid);
    this.store.touch(sid);
    const n = nodes.find((x) => x.id === (a.nodeId as string));
    if (!n) throw pfError("not_found", `노드 없음: ${a.nodeId}`, "pf_tree로 id를 확인하라.");
    return { node: n };
  }

  async lock(a: any): Promise<Record<string, unknown>> {
    const sid = a.sessionId as string;
    return this.locked(sid, async () => {
      const s = this.fresh(sid);
      const n = await this.core.pfLock(sid, a.nodeId as string);
      this.store.touch(sid);
      return { node: nodeSummary(n, s.limits) };
    });
  }
}
