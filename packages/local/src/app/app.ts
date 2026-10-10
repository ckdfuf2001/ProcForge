import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CoreClient } from "@procforge/shared/core-client.js";
import type { Actor } from "@procforge/shared/dto.js";
import { pfError } from "@procforge/shared/errors.js";
import { collectCatalog } from "../catalog.js";
import { constraintSummary, nodeSummary } from "../views.js";
import type { OUTPUT_SCHEMAS } from "../views.js";
import type {
  AdviseInput,
  ApproveInput,
  AskHumanInput,
  ConfirmLeafInput,
  EditArgsInput,
  EditNodeInput,
  FinalizeInput,
  GetNodeInput,
  LockInput,
  NextInput,
  RefreshCatalogInput,
  ReopenInput,
  ReportInput,
  RetryInput,
  SplitInput,
  StartInput,
  TestInput,
  TreeInput,
} from "@procforge/shared/dto.js";

type OutputOf<K extends keyof typeof OUTPUT_SCHEMAS> = import("zod").infer<(typeof OUTPUT_SCHEMAS)[K]>;
import { seedSandbox } from "../services/workspace.js";
import { logger } from "../logger.js";
import { diffSnapshot, readCaptureRecord, readPreSnapshot, takeSandboxSnapshot, toBaseRel, writePreCopies, writePreSnapshot } from "../services/snapshot.js";
import { appendCaptureRecord, classifyReportPaths, collectExistingPaths, collectResultFiles, ingestOriginalFixture, ingestReportJobs, readFixtureContents, resolveOriginal, roleForCapture } from "../services/artifacts.js";
import { ingestArtifacts, normalizeArgSpecs, readManifest } from "../artifacts.js";
import { runSession } from "../runner/index.js";
import { runProcedureTest } from "../runner/procedure-run.js";
import { writeJUnitFile, resolveJUnitPath } from "../services/runner.js";
import { writeProcedure } from "../services/procedureWriter.js";

// ProcForge 유스케이스층 (M4.2-1). 사용자 행동 1개 = 메서드 1개.
// 어댑터(server/cli/ui)는 입력 검증·호출·응답 포맷만 하고 정책·파일 작업은 여기에 위임한다.
// 세션 잠금은 core change()가 맡는다 (M4.2-2.5-2). 세션·노드 읽기는 core 경유.

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
  procforgeDir: string;
  projectRoot: string;
  /** 표시용 세션 TTL (판정은 core 소유) */
  sessionTtlMs?: number;
  strictSandbox?: boolean;
  maxArtifactBytes?: number;
};

export class ProcForgeApp {
  private core: CoreClient;
  private procforgeDir: string;
  private projectRoot: string;
  private sessionTtlMs: number | undefined;
  private strictSandbox: boolean;
  private maxArtifactBytes: number;

  constructor(deps: AppDeps) {
    this.core = deps.core;
    this.procforgeDir = deps.procforgeDir;
    this.projectRoot = deps.projectRoot;
    this.sessionTtlMs = deps.sessionTtlMs;
    this.strictSandbox = deps.strictSandbox ?? true;
    this.maxArtifactBytes = deps.maxArtifactBytes ?? 5 * 1024 * 1024;
  }

  async start(a: StartInput): Promise<OutputOf<"pf_start">> {    const collected = a.toolCatalog
      ? undefined
      : await collectCatalog(this.projectRoot, { cacheDir: join(this.procforgeDir, "cache") });
    const catalog = a.toolCatalog ?? collected!.entries;
    const warnings = collected?.warnings ?? [];
    const out = await this.core.pfStart({ request: a.request as string, params: a.params as Record<string, string> | undefined, toolCatalog: catalog as never, limits: a.limits as never, opencodeVersion: collected?.opencodeVersion });
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

  async next(a: NextInput): Promise<OutputOf<"pf_next">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfNext({
      sessionId: sid,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    if (out.done) return { done: true, revision: out.revision, changedNodeIds: out.changedNodeIds };
    // M4.2-2.5.1-3: 처음 probing 진입 때만 사전 스냅샷 기록. 실패는 경고로 반환.
    // M4.1.1-1: strict 모드면 pf_next 시점 사본도 저장 (inout 원본 탐색용).
    const nextWarnings: string[] = [];
    if (out.enteredProbing) {
      try {
        writePreSnapshot(
          this.procforgeDir, sid, out.node.id,
          takeSandboxSnapshot(join(this.procforgeDir, "sandbox", sid)),
        );
        if (this.strictSandbox) {
          writePreCopies(this.procforgeDir, sid, out.node.id, join(this.procforgeDir, "sandbox", sid));
        }
      } catch (e) {
        nextWarnings.push(`스냅샷 기록 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      done: false,
      node: nodeSummary(out.node, s.limits),
      ...(out.blocked ? { blocked: out.blocked } : {}),
      instruction: out.instruction,
      enteredProbing: out.enteredProbing,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
      ...(nextWarnings.length > 0 ? { warnings: nextWarnings } : {}),
    };
  }

  async report(a: ReportInput): Promise<OutputOf<"pf_report">> {
    const sid = a.sessionId as string;
    const sess = await this.core.getSession(sid);
    const nid = a.nodeId as string;
    const attemptId = randomUUID();
    const toolRef = a.tool as { server: string; name: string };
    const args = (a.args ?? {}) as Record<string, unknown>;
    const baseDir = this.strictSandbox ? join(this.procforgeDir, "sandbox", sid) : this.projectRoot;
    const cat = sess.toolCatalog.find((t) => t.server === toolRef.server && t.name === toolRef.name);
    // M4.1-7 스냅샷 판정: 새로 생긴 파일 → out, 바뀐 파일 → inout (M4.1.1-1),
    // 그 외 자동분 → in. 호스트 제출분은 명시 입력(in) 유지.
    // 스냅샷 없으면 원본 대비 변경을 직접 비교해 inout 판정 (폴백).
    const reportWarnings: string[] = [];
    const createdRels = new Set<string>();
    const modifiedRels = new Set<string>();
    let snapshotMiss = false;
    if (this.strictSandbox) {
      const pre = readPreSnapshot(this.procforgeDir, sid, nid);
      if (!pre) {
        snapshotMiss = true;
        reportWarnings.push(`스냅샷 없음(${nid}): 기존 존재 기반 캡처로 폴백 (pf_next 경유 권장)`);
      } else {
        const d = diffSnapshot(pre, baseDir);
        for (const r of d.created) createdRels.add(r);
        for (const r of d.modified) modifiedRels.add(r);
      }
    }
    const relOfReport = (p: string) => toBaseRel(baseDir, p);
    let treeCache: import("@procforge/shared/schema.js").Node[] | undefined;
    const getTreeNodes = async () => treeCache ??= (await this.core.pfTree(sid)).nodes;
    const manifestNow = readManifest(this.procforgeDir, sid);
    const resolveHere = (rel: string) => resolveOriginal({
      procforgeDir: this.procforgeDir, sessionId: sid, nodeId: nid, rel,
      nodes: treeCache ?? [], manifest: manifestNow,
    });
    if (snapshotMiss) {
      // 폴백: in/inout 후보·응답 파일 중 원본과 다르면 inout
      const cands = new Set<string>([
        ...collectExistingPaths({ baseDir, tool: toolRef, args, catalogEntry: cat, roles: ["in", "inout"] }),
        ...collectResultFiles({ baseDir, resultJson: a.resultJson }),
      ]);
      if (cands.size > 0) await getTreeNodes();
      for (const p of cands) {
        const rel = relOfReport(p);
        const orig = resolveHere(rel);
        if (!orig) continue;
        try {
          const cur = readFileSync(resolve(baseDir, p));
          if (!orig.buf.equals(cur)) modifiedRels.add(rel);
        } catch {
          // 읽기 실패 무시
        }
      }
    }
    const jobs = classifyReportPaths({
      baseDir, tool: toolRef, args, catalogEntry: cat,
      resultJson: a.resultJson, hostPaths: (a.artifacts ?? []) as string[],
      createdRels, modifiedRels,
    });
    if (jobs.some((j) => j.kind === "inout")) await getTreeNodes();
    const { stored, contents } = await ingestReportJobs({
      procforgeDir: this.procforgeDir, sessionId: sid, nodeId: nid,
      attemptId, baseDir, jobs, maxBytes: this.maxArtifactBytes,
      resolveOriginal: resolveHere,
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
      // M4.2-2.5.1-4: 생략 시 읽은 revision 전달 (도중 변경은 conflict)
      expectedRevision: a.expectedRevision ?? sess.revision,
      actor: a.actor ?? "host",
    });
    return { ...(out as unknown as Record<string, unknown>), warnings: reportWarnings };
  }

  async confirmLeaf(a: ConfirmLeafInput): Promise<OutputOf<"pf_confirm_leaf">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    if (!a.argSpecs) throw pfError("bad_request", "argSpecs가 없다.", "마지막 실행 인자 키를 모두 분류해 pf_confirm_leaf 재호출.");
    const norm = normalizeArgSpecs(a.argSpecs as Record<string, import("@procforge/shared/schema.js").ArgSpec>, {
      sandboxDir: join(this.procforgeDir, "sandbox", sid),
      projectRoot: this.projectRoot,
    });
    // M3.6-2 확정 시 추캡처: 명시 in/inout fixed 경로 중 미수집분.
    // M4.2-2.5-4: 결과물 수정과 leaf 확정을 core 변경 1회로 통합 (artifacts 전달)
    const nodeId = a.nodeId as string;
    const cur = await this.core.getNode(sid, nodeId);
    const last = cur?.attempts[cur.attempts.length - 1];
    let merged = last?.artifacts ?? [];
    if (cur && last) {
      // M4.1-7: 보고 시 out 판정분은 attempt에서 제외 (golden 입력 순수 유지, 증거 파일은 보존)
      const sidecar = readCaptureRecord(this.procforgeDir, sid, nodeId, last.id);
      // M4.1.1-1: 미해결 inout·소실된 원본이 있으면 확정 거부
      const unresolved = sidecar?.unresolvedInouts ?? [];
      if (unresolved.length > 0) {
        throw pfError("bad_request", `inout 원본 없음: ${unresolved.join(", ")}`, "pf_next 경유 실행·seed 확인 후 다시 pf_report.");
      }
      for (const fx of sidecar?.inouts ?? []) {
        if (!existsSync(join(this.procforgeDir, "sessions", sid, fx))) {
          throw pfError("bad_request", `inout fixture 없음: ${fx}`, "다시 pf_report.");
        }
      }
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
      // M4.1.1-1: fresh 중 수정분은 inout → 원본 해결 (없으면 bad_request)
      let treeCacheC: import("@procforge/shared/schema.js").Node[] | undefined;
      const getTreeC = async () => treeCacheC ??= (await this.core.pfTree(sid)).nodes;
      const resolveC = (rel: string) => resolveOriginal({
        procforgeDir: this.procforgeDir, sessionId: sid, nodeId, rel,
        nodes: treeCacheC ?? [], manifest,
      });
      let snapshotModified: Set<string> | undefined;
      if (this.strictSandbox) {
        const pre = readPreSnapshot(this.procforgeDir, sid, nodeId);
        if (pre) snapshotModified = new Set(diffSnapshot(pre, baseDir).modified);
      }
      const freshIn: string[] = [];
      const freshInout: string[] = [];
      for (const p of fresh) {
        const rel = relOf(p);
        let isInout = snapshotModified?.has(rel) ?? false;
        if (!isInout && !snapshotModified) {
          await getTreeC();
          const orig = resolveC(rel);
          if (orig) {
            try {
              if (!orig.buf.equals(readFileSync(resolve(baseDir, p)))) isInout = true;
            } catch {
              // 읽기 실패 무시
            }
          }
        }
        (isInout ? freshInout : freshIn).push(p);
      }
      if (freshInout.length > 0) await getTreeC();
      merged = [...kept];
      const addIns: string[] = [];
      const addOuts: string[] = [];
      const addInouts: string[] = [];
      let nextIdx = last.artifacts.length;
      if (freshIn.length > 0) {
        const ing = ingestArtifacts({
          procforgeDir: this.procforgeDir, sessionId: sid, nodeId, attemptId: last.id,
          baseDir, paths: freshIn, maxBytes: this.maxArtifactBytes, startIndex: nextIdx,
        });
        nextIdx += freshIn.length;
        merged.push(...ing.stored);
        addIns.push(...ing.stored);
      }
      if (freshInout.length > 0) {
        // 증거(수정본) 먼저, 원본은 마지막
        const ev = ingestArtifacts({
          procforgeDir: this.procforgeDir, sessionId: sid, nodeId, attemptId: last.id,
          baseDir, paths: freshInout, maxBytes: this.maxArtifactBytes, startIndex: nextIdx,
        });
        nextIdx += freshInout.length;
        merged.push(...ev.stored);
        addOuts.push(...ev.stored);
        for (const p of freshInout) {
          const rel = relOf(p);
          const orig = resolveC(rel);
          if (!orig) {
            throw pfError("bad_request", `inout 원본 없음: ${rel}`, "pf_next 경유 실행·seed 확인 후 다시 pf_report.");
          }
          const o = ingestOriginalFixture({
            procforgeDir: this.procforgeDir, sessionId: sid, nodeId, attemptId: last.id,
            rel, buf: orig.buf, index: nextIdx++, maxBytes: this.maxArtifactBytes,
          });
          merged.push(o.stored);
          addIns.push(o.stored);
          addInouts.push(o.stored);
        }
      }
      if (addIns.length > 0 || addOuts.length > 0 || addInouts.length > 0) {
        appendCaptureRecord(this.procforgeDir, sid, nodeId, last.id, {
          ins: addIns, outs: addOuts, inouts: addInouts,
        });
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
      artifacts: merged,
      // M4.2-2.5.1-4: 생략 시 읽은 revision 전달 (도중 변경은 conflict)
      expectedRevision: a.expectedRevision ?? s.revision,
      actor: a.actor ?? "host",
    });
    return {
      node: nodeSummary(out.node, s.limits),
      instruction: out.instruction,
      warnings: norm.warnings,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  async retry(a: RetryInput): Promise<OutputOf<"pf_retry">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    logger.info("pf_retry", { sessionId: sid, nodeId: a.nodeId, reason: a.reason });
    const out = await this.core.pfResolve({
      sessionId: sid,
      nodeId: a.nodeId as string,
      decision: "retry",
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    // M4.2-2.5.1-3: 재시도 성공 시에도 사전 스냅샷 기록. 실패는 경고로 반환.
    // M4.1.1-1: strict 모드면 pf_next 시점 사본도 저장 (inout 원본 탐색용).
    const retryWarnings: string[] = [];
    try {
      writePreSnapshot(
        this.procforgeDir, sid, a.nodeId as string,
        takeSandboxSnapshot(join(this.procforgeDir, "sandbox", sid)),
      );
      if (this.strictSandbox) {
        writePreCopies(this.procforgeDir, sid, a.nodeId as string, join(this.procforgeDir, "sandbox", sid));
      }
    } catch (e) {
      retryWarnings.push(`스냅샷 기록 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      node: nodeSummary(out.node, s.limits),
      instruction: out.instruction,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
      ...(retryWarnings.length > 0 ? { warnings: retryWarnings } : {}),
    };
  }

  async split(a: SplitInput): Promise<OutputOf<"pf_split">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const kids = a.children as { goal: string; dependsOn?: string[]; sideEffect?: "none" | "local_write" | "external" }[] | undefined;
    if (!kids || kids.length === 0) throw pfError("bad_request", "children이 비었다.", "최소 1개의 {goal}을 넣어 pf_split 재호출.");
      const out = await this.core.pfResolve({
        sessionId: sid,
        nodeId: a.nodeId as string,
        decision: "split",
        children: kids,
        expectedRevision: a.expectedRevision as number | undefined,
        actor: (a.actor as Actor | undefined) ?? "host",
      });
      return {
        node: nodeSummary(out.node, s.limits),
        created: (out.created ?? []).map((c) => nodeSummary(c, s.limits)),
        instruction: out.instruction,
        revision: out.revision,
        changedNodeIds: out.changedNodeIds,
      };
  }

  async askHuman(a: AskHumanInput): Promise<OutputOf<"pf_ask_human">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
      logger.info("pf_ask_human", { sessionId: sid, nodeId: a.nodeId, question: a.question });
      const out = await this.core.pfResolve({
        sessionId: sid,
        nodeId: a.nodeId as string,
        decision: "ask_human",
        plan: a.plan as { tool: { server: string; name: string }; args: Record<string, unknown> } | undefined,
        note: a.question as string,
        expectedRevision: a.expectedRevision as number | undefined,
        actor: (a.actor as Actor | undefined) ?? "host",
      });
      return { node: nodeSummary(out.node, s.limits), instruction: out.instruction, revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async approve(a: ApproveInput): Promise<OutputOf<"pf_approve">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfApprove({
      sessionId: sid,
      nodeId: a.nodeId as string,
      approved: a.approved as boolean,
      note: a.note as string | undefined,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return { node: nodeSummary(out.node, s.limits), revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async advise(a: AdviseInput): Promise<OutputOf<"pf_advise">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const nid = a.nodeId as string;
    // 최신 attempt의 fixture 내용을 읽어 core 평가에 전달 (M4)
    const cur = await this.core.getNode(sid, nid);
    const fixtureContents = readFixtureContents({
      procforgeDir: this.procforgeDir, sessionId: sid,
      artifacts: cur.attempts[cur.attempts.length - 1]?.artifacts ?? [],
    });
      const out = await this.core.pfAdvise({
        sessionId: sid,
        nodeId: nid,
        text: a.text as string,
        proposedConstraints: a.proposedConstraints as unknown[] | undefined,
        fixtureContents,
        // M4.2-2.5.1-4: 생략 시 읽은 revision 전달 (도중 변경은 conflict)
        expectedRevision: a.expectedRevision ?? s.revision,
        actor: a.actor ?? "host",
      });
      return {
        constraints: out.constraints.map((c) => ({ id: c.id, kind: c.kind, summary: constraintSummary(c) })),
        rejected: out.rejected,
        ...(out.note ? { note: out.note } : {}),
        node: nodeSummary(out.node, s.limits),
        revision: out.revision,
        changedNodeIds: out.changedNodeIds,
      };
  }

  async tree(a: TreeInput): Promise<OutputOf<"pf_tree">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const { nodes } = await this.core.pfTree(sid);
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

  async getNode(a: GetNodeInput): Promise<OutputOf<"pf_get_node">> {
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const { nodes } = await this.core.pfTree(sid);
    const n = nodes.find((x) => x.id === (a.nodeId as string));
    if (!n) throw pfError("not_found", `노드 없음: ${a.nodeId}`, "pf_tree로 id를 확인하라.");
    return { node: n };
  }

  async lock(a: LockInput): Promise<OutputOf<"pf_lock">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfLock({
      sessionId: sid,
      nodeId: a.nodeId as string,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return { node: nodeSummary(out.node, s.limits), revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async reopen(a: ReopenInput): Promise<OutputOf<"pf_reopen">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfReopen({
      sessionId: sid,
      nodeId: a.nodeId as string,
      reason: a.reason as string,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return { node: nodeSummary(out.node, s.limits), revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async editArgs(a: EditArgsInput): Promise<OutputOf<"pf_edit_args">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfEditArgs({
      sessionId: sid,
      nodeId: a.nodeId as string,
      patch: {
        set: a.patch?.set as Record<string, import("@procforge/shared/schema.js").ArgSpec> | undefined,
        remove: a.patch?.remove as string[] | undefined,
      },
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return { node: nodeSummary(out.node, s.limits), instruction: out.instruction, revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async editNode(a: EditNodeInput): Promise<OutputOf<"pf_edit_node">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfEditNode({
      sessionId: sid,
      nodeId: a.nodeId as string,
      goal: a.goal as string | undefined,
      addConstraints: a.addConstraints as import("@procforge/shared/schema.js").Constraint[] | undefined,
      removeConstraintIds: a.removeConstraintIds as string[] | undefined,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return { node: nodeSummary(out.node, s.limits), instruction: out.instruction, revision: out.revision, changedNodeIds: out.changedNodeIds };
  }

  async refreshCatalog(_a: RefreshCatalogInput): Promise<OutputOf<"pf_refresh_catalog">> {
    const c = await collectCatalog(this.projectRoot, { cacheDir: join(this.procforgeDir, "cache"), refresh: true });
    return {
      entries: c.entries.map((e) => ({ server: e.server, name: e.name, schemaHash: e.schemaHash })),
      warnings: c.warnings,
      cached: c.cached,
    };
  }

  async test(a: TestInput): Promise<OutputOf<"pf_test">> {
    if (a.procedure) {
      const { report, sessionId: imported } = await runProcedureTest(this.procforgeDir, this.projectRoot, a.procedure as string, {
        procforgeDir: this.procforgeDir,
        projectRoot: this.projectRoot,
        mode: (a.mode as "record" | "replay" | "passthrough" | "live" | undefined) ?? "replay",
        params: (a.params as Record<string, string> | undefined) ?? {},
        updateGolden: (a.updateGolden as boolean | undefined) ?? false,
        allowProjectRead: (a.allowProjectRead as boolean | undefined) ?? false,
      });
      const junitPathProc = resolveJUnitPath(this.projectRoot, this.procforgeDir, a.junitPath as string | undefined, report.runId);
      writeJUnitFile(junitPathProc, report);
      return {
        runId: report.runId,
        mode: report.mode,
        passed: report.summary.pass,
        failed: report.summary.fail,
        unverified: report.summary.unverified,
        skipped: report.summary.skipped,
        blocked: report.summary.blocked,
        reportPath: join(this.procforgeDir, "runs", report.runId, "report.json"),
        junitPath: junitPathProc,
        sessionId: imported,
      };
    }
    if (!a.sessionId) throw pfError("bad_request", "sessionId 또는 procedure 중 하나가 필요하다.");
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const report = await runSession({
      procforgeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      sessionId: sid,
      nodeId: a.nodeId as string | undefined,
      mode: (a.mode as "record" | "replay" | "passthrough" | "live" | undefined) ?? "replay",
      updateGolden: (a.updateGolden as boolean | undefined) ?? false,
      allowProjectRead: (a.allowProjectRead as boolean | undefined) ?? false,
    });
    const reportPath = join(this.procforgeDir, "runs", report.runId, "report.json");
    const junitPath = resolveJUnitPath(this.projectRoot, this.procforgeDir, a.junitPath as string | undefined, report.runId);
    writeJUnitFile(junitPath, report);
    return {
      runId: report.runId,
      mode: report.mode,
      passed: report.summary.pass,
      failed: report.summary.fail,
      unverified: report.summary.unverified,
      skipped: report.summary.skipped,
      blocked: report.summary.blocked,
      reportPath,
      junitPath,
    };
  }

  async finalize(a: FinalizeInput): Promise<OutputOf<"pf_finalize">> {
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const { doc, warnings } = await this.core.pfBuildProcedure(sid, a.name as string);
    const written = writeProcedure({
      procforgeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      sessionId: sid,
      doc,
      force: (a.force as boolean | undefined) ?? false,
    });
    return { name: doc.name, dir: written.dir, warnings, files: written.files, commandFile: written.commandFile };
  }
}
