import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CoreClient } from "@procforge/shared/core-client.js";
import type { Actor } from "@procforge/shared/dto.js";
import { pfError } from "@procforge/shared/errors.js";
import { collectCatalog } from "../catalog.js";
import { FileStore } from "../filestore.js";
import { constraintSummary, nodeSummary, retriesLeft } from "../views.js";
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

type OutputOf<K extends keyof typeof OUTPUT_SCHEMAS> = import("zod").infer<
  (typeof OUTPUT_SCHEMAS)[K]
>;
import { seedSandbox } from "../services/workspace.js";
import {
  sendContinue,
  httpLinkDeps,
  fetchServerVersion,
  clampTimeoutMs,
  type LinkMode,
  type LinkResult,
} from "../services/opencode-link.js";
import { savePairing, getPairing, loadPairings, type Pairings } from "../services/pairings.js";
import { enrichSessions, type SessionRow } from "../services/session-meta.js";
import {
  previewArtifact,
  readArtifact,
  type ArtifactPreview,
} from "../services/artifact-view.js";
import { detectDuplicateStores } from "./store-dir.js";
import { logger } from "../logger.js";
import {
  diffSnapshot,
  readCaptureRecord,
  readPreSnapshot,
  takeSandboxSnapshot,
  toBaseRel,
  writePreCopies,
  writePreSnapshot,
} from "../services/snapshot.js";
import {
  appendCaptureRecord,
  absolutizePathArgs,
  classifyReportPaths,
  collectExistingPaths,
  collectResultFiles,
  ingestOriginalFixture,
  ingestReportJobs,
  readFixtureContents,
  resolveOriginal,
  roleForCapture,
} from "../services/artifacts.js";
import {
  ingestArtifacts,
  normalizeArgSpecs,
  readManifest,
} from "../artifacts.js";
import { runSession } from "../runner/index.js";
import { loadCassette, recordKey } from "../runner/index.js";
import { runProcedureTest } from "../runner/procedure-run.js";
import { loadProcedureDoc } from "../runner/procedure-run.js";
import {
  appendRunLog,
  cancelRun,
  readRunLog,
  readCancelFlag,
  clearCancelFlag,
  registerChild,
  unregisterChild,
} from "./run-control.js";
import { unifiedDiff } from "../services/diff.js";
import {
  readSandboxed,
  saveApprovedSnapshot,
  readApprovedSnapshot,
} from "../services/approval-scripts.js";
import {
  buildApprovalEntry,
  loadApprovals,
  approvalPins,
  checkApproval,
  toHashableMap,
  saveApproval,
  scopeWarnings,
  toHashable,
} from "../services/approvals.js";
import { copyImportFiles } from "../procedure.js";
import { resolveDateParams } from "../services/date-params.js";
import { runnableTools } from "../services/runnable-tools.js";
import {
  buildRefOutputs,
  checkProbingArgs,
  type RefNodeInfo,
  type RefVerdict,
} from "../services/ref-check.js";
import { varRefNodeIds } from "@procforge/shared/deps.js";
import { varRefNodeId } from "@procforge/shared/args-schema.js";
import { resolveRefValue } from "@procforge/shared/validator.js";
import {
  readRunState,
  readRunStateBySession,
  writeRunState,
  type RunState,
} from "../services/run-state.js";
import {
  writeJUnitFile,
  resolveJUnitPath,
  copyRunFsToOut,
} from "../services/runner.js";
import { repairDiscard } from "../services/repair.js";
import {
  auditFixedValues,
  auditRubricConstraints,
  auditStateWrites,
  findDateSample,
} from "../services/finalize-audit.js";
import {
  auditContentTexts,
  collectAuditContent,
} from "../services/audit-content.js";
import { buildTrace, formatTraceMarkdown, recordCall } from "../trace.js";
import { exportSession } from "../export.js";
import { assertProjectPath } from "../artifacts.js";
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
  "7. 입력 파일 경로·표지 문구처럼 기간이 들어간 값은 var로 분류한다.",
  '   예: "sales-${params.month}.xlsx", "월간보고서 ${params.month} (최종)".',
  "8. 앞 노드 출력과 같은 값은 fixed로 박지 말고 ref로 받아온다.",
  '   예: 표 셀은 "$1.1.rows", 합계는 "$1.1.total".',
].join("\n");

/** M7-1: 세션 목록 1행 (core 요약 + 로컬 부가. 판단 없음. UI가 배지를 붙인다) */
export type SessionSummary = SessionRow;

/** M7-ui3-d: 노드 이력 최신 N건 (UI 서버가 상한 상수를 알지 않도록 App이 정한다) */
export const NODE_HISTORY_MAX = 200;

/** M7-ui2: 세션 트리 1행 (노드 요약 + stale 표시. 판단 없음) */
export type SessionNodeRow = {
  id: string;
  goal: string;
  status: string;
  depth: number;
  dependsOn: string[];
  attempts: number;
  retriesLeft: number;
  locked: boolean;
  sideEffect: string;
  staleSince?: { revision: number; causeNodeId: string };
};

/** M7-ui3: 노드 상세 (표시 매핑은 UI. 여기선 판단 없음) */
export type NodeDetail = {
  sessionId: string;
  nodeId: string;
  revision: number;
  goal: string;
  status: string;
  locked: boolean;
  sideEffect: string;
  staleSince: { revision: number; causeNodeId: string } | null;
  hash: string;
  tool: { server: string; name: string } | null;
  args: Record<string, unknown>;
  map: unknown;
  until: unknown;
  dependsOn: string[];
  constraints: import("@procforge/shared/schema.js").Constraint[];
  advice: { at: string; text: string }[];
  golden: { fixtures: string[]; output: string; attemptId?: string; ignore: string[] } | null;
  approval: { at: string; note?: string } | null;
  retriesLeft: number;
  attempts: {
    id: string;
    at: string;
    tool: { server: string; name: string };
    verdict: string | null;
    failedConstraints: string[];
    rubricReasons: Record<string, string>;
    resultSummary: string;
    resultJsonMeta: { sha256: string; size: number; preview: string } | null;
    artifactPreviews: import("../services/artifact-view.js").ArtifactPreview[];
  }[];
  resultJsonMeta: { sha256: string; size: number; preview: string } | null;
  lastVerdict: string | null;
  lastFailedConstraints: string[];
};

export type AppDeps = {  core: CoreClient;
  procforgeDir: string;
  projectRoot: string;
  /** 표시용 세션 TTL (판정은 core 소유) */
  sessionTtlMs?: number;
  strictSandbox?: boolean;
  maxArtifactBytes?: number;
  /** 카탈로그 수집 타임아웃 (M3.5.1-4) */
  catalogTimeoutMs?: number;
  /** M7-1.1-5: 신호 전송용 fetch (R5. 테스트 주입은 생성자로만. 입력은 JSON) */
  linkFetchImpl?: typeof fetch;
  /**
   * M7-ui4-b: **서버 설정** 신호 대상. 클라이언트(MCP 도구·UI 본문)는
   * baseUrl·mode를 정하지 않는다 — 지정하려 하면 400이다.
   * 미지정 시 환경변수(PROCFORGE_OPENCODE_URL / _MODE)로 본다.
   */
  signal?: Partial<SignalTarget>;
};

/** M7-ui4-b/c: 신호 대상 (서버 설정에서만 온다) */
export type SignalTarget = {
  baseUrl: string;
  mode: LinkMode;
  text?: string;
  timeoutMs?: number;
  serverVersion?: string;
};

export class ProcForgeApp {
  private core: CoreClient;
  private procforgeDir: string;
  private projectRoot: string;
  private sessionTtlMs: number | undefined;
  private strictSandbox: boolean;
  private maxArtifactBytes: number;
  private catalogTimeoutMs: number | undefined;
  private linkFetchImpl: typeof fetch | undefined;
  /** M7-ui4: UI 연결 id (호출 귀속 기록용. 연결마다 1개) */
  private readonly uiConnectionId = `ui-${randomUUID()}`;
  private readonly signal: SignalTarget;
  /** M7 5-1: 실행 중 절차서 → runId (동시 1개 강제). 취소되면 반납. */
  private activeRuns = new Map<string, string>();
  /** M7-5-c: 결정 대기(승인·생성값) 중 잠금 유지 중인 run */
  private waitingRuns = new Set<string>();

  /**
   * M7-5-b: **디스크**에 기록된 대기 실행 (재시작 후에도 잠금이 살아 있어야 한다).
   * 취소/거부로 잠금이 풀리면 state 에 waiting 이 사라지므로 자동으로 제외된다.
   */
  private waitingRunFor(procedure: string): string | undefined {
    const runsDir = join(this.procforgeDir, "runs");
    let names: string[];
    try {
      names = readdirSync(runsDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      const st = readRunState(this.procforgeDir, name) as
        | (RunState & { waiting?: { nodeId: string; at: string } })
        | undefined;
      if (!st?.waiting) continue;
      if (st.procedure !== procedure) continue;
      if (st.status === "done" || st.status === "failed" || st.status === "cancelled") {
        continue;
      }
      if (readCancelFlag(this.procforgeDir, st.runId)) continue;
      return st.runId;
    }
    return undefined;
  }

  constructor(deps: AppDeps) {
    this.core = deps.core;
    this.procforgeDir = deps.procforgeDir;
    this.projectRoot = deps.projectRoot;
    this.sessionTtlMs = deps.sessionTtlMs;
    this.strictSandbox = deps.strictSandbox ?? true;
    this.maxArtifactBytes = deps.maxArtifactBytes ?? 5 * 1024 * 1024;
    this.catalogTimeoutMs = deps.catalogTimeoutMs;
    this.linkFetchImpl = deps.linkFetchImpl;
    // M7-ui4-b: 신호 대상은 여기서 한 번만 정한다.
    this.signal = {
      baseUrl: deps.signal?.baseUrl ?? process.env.PROCFORGE_OPENCODE_URL ?? "",
      mode: (deps.signal?.mode ??
        (process.env.PROCFORGE_OPENCODE_MODE as LinkMode | undefined) ??
        "b") as LinkMode,
      text: deps.signal?.text,
      timeoutMs: deps.signal?.timeoutMs,
      serverVersion: deps.signal?.serverVersion,
    };
  }

  async start(a: StartInput): Promise<OutputOf<"pf_start">> {
    // M5.8.1-6: MCP client가 opencode면 그 버전을 쓴다 (detectOpencodeVersion 대신).
    const clientName = (a as { clientName?: unknown }).clientName;
    const clientVersion = (a as { clientVersion?: unknown }).clientVersion;
    const clientOpencodeVersion =
      typeof clientName === "string" &&
      /opencode/i.test(clientName) &&
      typeof clientVersion === "string"
        ? clientVersion
        : undefined;
    const collected = a.toolCatalog
      ? undefined
      : await collectCatalog(this.projectRoot, {
          cacheDir: join(this.procforgeDir, "cache"),
          ...(this.catalogTimeoutMs !== undefined
            ? { timeoutMs: this.catalogTimeoutMs }
            : {}),
          ...(clientOpencodeVersion !== undefined
            ? { opencodeVersion: clientOpencodeVersion }
            : {}),
        });
    const catalog = a.toolCatalog ?? collected!.entries;
    const warnings = collected?.warnings ?? [];
    const out = await this.core.pfStart({
      request: a.request as string,
      params: a.params as Record<string, string> | undefined,
      toolCatalog: catalog as never,
      limits: a.limits as never,
      opencodeVersion: collected?.opencodeVersion,
    });
    // M5.8.1-6: 세션 메타에 호출 주체 기록 (서버가 기입한 clientInfo 전달).
    if (typeof clientName === "string" || typeof clientVersion === "string") {
      new FileStore(this.procforgeDir).touchSession(out.session.id, {
        ...(typeof clientName === "string" ? { clientName } : {}),
        ...(typeof clientVersion === "string" ? { clientVersion } : {}),
      });
    }
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
      sessionExpiresInDays: Math.round(
        (this.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 86400000,
      ),
      opencodeVersion: out.session.opencodeVersion ?? "unknown",
      // M7-1-6: 실제 저장소 경로 (어느 저장소에 생겼는지 호출자가 확인).
      storeDir: this.procforgeDir,
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
    if (out.done)
      return {
        done: true,
        revision: out.revision,
        changedNodeIds: out.changedNodeIds,
      };
    // M5.8.2-2: ref 해석 인자 내려주기. suggestedArgs/args의 var를 상류
    // resultJson 파일(golden→최종pass)로 해석해 probing에 그대로 쓰게 한다.
    // 해석 불가면 생략.
    let resolvedInputs: Record<string, unknown> | undefined;
    {
      const specs = ((out.node as unknown as { suggestedArgs?: unknown })
        .suggestedArgs ?? (out.node as unknown as { args?: unknown }).args) as
        Record<string, { kind?: string; ref?: unknown }> | undefined;
      if (
        specs !== null &&
        typeof specs === "object" &&
        !Array.isArray(specs)
      ) {
        const store = new FileStore(this.procforgeDir);
        const ids = varRefNodeIds(specs as never);
        const nodes = new Map<string, RefNodeInfo>();
        for (const id of ids) {
          try {
            const un = await this.core.getNode(sid, id);
            nodes.set(id, {
              id,
              kind: (un as { kind?: string }).kind,
              goldenAttemptId: (un as { golden?: { attemptId?: string } })
                .golden?.attemptId,
              attempts: (un.attempts ?? []).map((x) => ({
                id: x.id,
                verdict: x.verdict,
              })),
            });
          } catch {
            nodes.set(id, { id, attempts: [] });
          }
        }
        if (ids.length > 0) {
          const { outputs } = buildRefOutputs({
            specs: specs as Record<string, unknown>,
            params: (s.params ?? {}) as Record<string, string>,
            nodes,
            loadJson: (aid: string) => store.readResultJson(sid, aid),
          });
          const ri: Record<string, unknown> = {};
          for (const [k, spec] of Object.entries(specs)) {
            const ref = (spec as { ref?: unknown } | null)?.ref;
            if (
              (spec as { kind?: string } | null)?.kind !== "var" ||
              typeof ref !== "string"
            )
              continue;
            const r = resolveRefValue(
              ref,
              (s.params ?? {}) as Record<string, string>,
              outputs,
            );
            if (r.ok) ri[k] = r.value;
          }
          if (Object.keys(ri).length > 0) resolvedInputs = ri;
        }
      }
    }
    // M4.2-2.5.1-3: 처음 probing 진입 때만 사전 스냅샷 기록. 실패는 경고로 반환.
    // M4.1.1-1: strict 모드면 pf_next 시점 사본도 저장 (inout 원본 탐색용).
    const nextWarnings: string[] = [];
    if (out.enteredProbing) {
      try {
        writePreSnapshot(
          this.procforgeDir,
          sid,
          out.node.id,
          takeSandboxSnapshot(join(this.procforgeDir, "sandbox", sid)),
        );
        if (this.strictSandbox) {
          writePreCopies(
            this.procforgeDir,
            sid,
            out.node.id,
            join(this.procforgeDir, "sandbox", sid),
          );
        }
      } catch (e) {
        nextWarnings.push(
          `스냅샷 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
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
      ...(resolvedInputs ? { resolvedInputs } : {}),
    };
  }

  async report(a: ReportInput): Promise<OutputOf<"pf_report">> {
    const sid = a.sessionId as string;
    const sess = await this.core.getSession(sid);
    const nid = a.nodeId as string;
    const attemptId = randomUUID();
    const toolRef = a.tool as { server: string; name: string };
    const args = (a.args ?? {}) as Record<string, unknown>;
    const baseDir = this.strictSandbox
      ? join(this.procforgeDir, "sandbox", sid)
      : this.projectRoot;
    const cat = sess.toolCatalog.find(
      (t) => t.server === toolRef.server && t.name === toolRef.name,
    );
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
        reportWarnings.push(
          `스냅샷 없음(${nid}): 기존 존재 기반 캡처로 폴백 (pf_next 경유 권장)`,
        );
      } else {
        const d = diffSnapshot(pre, baseDir);
        for (const r of d.created) createdRels.add(r);
        for (const r of d.modified) modifiedRels.add(r);
      }
    }
    const relOfReport = (p: string) => toBaseRel(baseDir, p);
    let treeCache: import("@procforge/shared/schema.js").Node[] | undefined;
    const getTreeNodes = async () =>
      (treeCache ??= (await this.core.pfTree(sid)).nodes);
    const manifestNow = readManifest(this.procforgeDir, sid);
    const resolveHere = (rel: string) =>
      resolveOriginal({
        procforgeDir: this.procforgeDir,
        sessionId: sid,
        nodeId: nid,
        rel,
        nodes: treeCache ?? [],
        manifest: manifestNow,
      });
    if (snapshotMiss) {
      // 폴백: in/inout 후보·응답 파일 중 원본과 다르면 inout
      const cands = new Set<string>([
        ...collectExistingPaths({
          baseDir,
          tool: toolRef,
          args,
          catalogEntry: cat,
          roles: ["in", "inout"],
        }),
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
      baseDir,
      tool: toolRef,
      args,
      catalogEntry: cat,
      resultJson: a.resultJson,
      hostPaths: (a.artifacts ?? []) as string[],
      createdRels,
      modifiedRels,
    });
    if (jobs.some((j) => j.kind === "inout")) await getTreeNodes();
    // M3.5.1-3: resultJson 키를 녹화된 도구 응답과 대조. 미확인 키는 경고,
    // auto json 제약은 확인된 키에서만 생성.
    let verifiedJsonKeys: string[] | undefined;
    if (
      a.resultJson !== undefined &&
      a.resultJson !== null &&
      typeof a.resultJson === "object" &&
      !Array.isArray(a.resultJson)
    ) {
      let cassette: ReturnType<typeof loadCassette> = [];
      try {
        cassette = loadCassette(this.procforgeDir, sid, nid);
      } catch {
        // 손상 카세트는 대조 생략 (record 경로에서 처리)
      }
      if (cassette.length > 0) {
        const liveKey = recordKey(
          baseDir,
          this.projectRoot,
          toolRef.server,
          toolRef.name,
          absolutizePathArgs(baseDir, args),
        );
        const entry = cassette.find(
          (e) => e.server === toolRef.server && e.key === liveKey,
        );
        const recorded = entry?.response.json;
        if (
          recorded !== undefined &&
          recorded !== null &&
          typeof recorded === "object" &&
          !Array.isArray(recorded)
        ) {
          const recordedKeys = new Set(
            Object.keys(recorded as Record<string, unknown>),
          );
          const reportedKeys = Object.keys(
            a.resultJson as Record<string, unknown>,
          );
          const unconfirmed = reportedKeys.filter((k) => !recordedKeys.has(k));
          if (unconfirmed.length > 0) {
            reportWarnings.push(
              `resultJson 미확인 키: ${unconfirmed.join(", ")} (녹화 응답과 불일치)`,
            );
          }
          verifiedJsonKeys = reportedKeys.filter((k) => recordedKeys.has(k));
        }
      }
    }
    const { stored, contents } = await ingestReportJobs({
      procforgeDir: this.procforgeDir,
      sessionId: sid,
      nodeId: nid,
      attemptId,
      baseDir,
      jobs,
      maxBytes: this.maxArtifactBytes,
      resolveOriginal: resolveHere,
    });
    // M3.5.1-1: fixture → 논리 경로 매핑 전달 + 논리 경로 alias (auto file_exists 판정용)
    const manifestAfter = readManifest(this.procforgeDir, sid);
    const sources: Record<string, string> = {};
    for (const fx of stored) {
      const src = manifestAfter[fx];
      if (!src) continue;
      sources[fx] = src;
      if (contents[fx] !== undefined && contents[src] === undefined)
        contents[src] = contents[fx];
    }
    const out = await this.core.pfReport({
      sessionId: sid,
      nodeId: nid,
      tool: toolRef,
      args,
      resultSummary: a.resultSummary as string,
      resultJson: a.resultJson,
      artifacts: stored,
      artifactContents: contents,
      artifactSources: sources,
      verifiedJsonKeys,
      selfVerdict: a.selfVerdict as "pass" | "fail",
      selfReason: a.selfReason as string,
      rubricReasons: a.rubricReasons as Record<string, string> | undefined,
      attemptId,
      // M4.2-2.5.1-4: 생략 시 읽은 revision 전달 (도중 변경은 conflict)
      expectedRevision: a.expectedRevision ?? sess.revision,
      actor: a.actor ?? "host",
    });
    // M5.8.2 후속: resultJson 파일 저장 (ref 해석용. core는 메타만 가짐).
    if (a.resultJson !== undefined) {
      try {
        new FileStore(this.procforgeDir).writeResultJson(
          sid,
          attemptId,
          a.resultJson,
        );
      } catch {
        reportWarnings.push("resultJson 기록 실패: ref 검증 불가");
      }
    }
    return {
      ...(out as unknown as Record<string, unknown>),
      warnings: reportWarnings,
    };
  }

  /**
   * M5.8.2 후속: probing 대조용 ref 판정 계산 (R2: 계산만, 판정은 core).
   * golden attempt resultJson → 없으면 마지막 pass attempt 파일 기준.
   */
  private async buildRefCheck(
    sid: string,
    s: { params?: Record<string, string> },
    specs: Record<string, unknown>,
    probingArgs: Record<string, unknown>,
  ): Promise<RefVerdict[]> {
    const store = new FileStore(this.procforgeDir);
    const ids = varRefNodeIds(specs as never);
    const nodes = new Map<string, RefNodeInfo>();
    for (const id of ids) {
      try {
        const un = await this.core.getNode(sid, id);
        nodes.set(id, {
          id,
          kind: (un as { kind?: string }).kind,
          goldenAttemptId: (un as { golden?: { attemptId?: string } }).golden
            ?.attemptId,
          attempts: (un.attempts ?? []).map((x) => ({
            id: x.id,
            verdict: x.verdict,
          })),
        });
      } catch {
        // 상류 없음 → 해당 ref 검증 불가 (checkProbingArgs가 판정)
        nodes.set(id, { id, attempts: [] });
      }
    }
    return checkProbingArgs({
      specs,
      probingArgs,
      params: (s.params ?? {}) as Record<string, string>,
      nodes,
      loadJson: (aid: string) => store.readResultJson(sid, aid),
    });
  }

  async confirmLeaf(a: ConfirmLeafInput): Promise<OutputOf<"pf_confirm_leaf">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    if (!a.argSpecs)
      throw pfError(
        "bad_request",
        "argSpecs가 없다.",
        "마지막 실행 인자 키를 모두 분류해 pf_confirm_leaf 재호출.",
      );
    const norm = normalizeArgSpecs(
      a.argSpecs as Record<
        string,
        import("@procforge/shared/schema.js").ArgSpec
      >,
      {
        sandboxDir: join(this.procforgeDir, "sandbox", sid),
        projectRoot: this.projectRoot,
      },
    );
    // M3.6-2 확정 시 추캡처: 명시 in/inout fixed 경로 중 미수집분.
    // M4.2-2.5-4: 결과물 수정과 leaf 확정을 core 변경 1회로 통합 (artifacts 전달)
    const nodeId = a.nodeId as string;
    const cur = await this.core.getNode(sid, nodeId);
    const last = cur?.attempts[cur.attempts.length - 1];
    let merged = last?.artifacts ?? [];
    if (cur && last) {
      // M4.1-7: 보고 시 out 판정분은 attempt에서 제외 (golden 입력 순수 유지, 증거 파일은 보존)
      const sidecar = readCaptureRecord(
        this.procforgeDir,
        sid,
        nodeId,
        last.id,
      );
      // M4.1.1-1: 미해결 inout·소실된 원본이 있으면 확정 거부
      const unresolved = sidecar?.unresolvedInouts ?? [];
      if (unresolved.length > 0) {
        throw pfError(
          "bad_request",
          `inout 원본 없음: ${unresolved.join(", ")}`,
          "pf_next 경유 실행·seed 확인 후 다시 pf_report.",
        );
      }
      for (const fx of sidecar?.inouts ?? []) {
        if (!existsSync(join(this.procforgeDir, "sessions", sid, fx))) {
          throw pfError(
            "bad_request",
            `inout fixture 없음: ${fx}`,
            "다시 pf_report.",
          );
        }
      }
      const outSet = new Set(sidecar?.outs ?? []);
      const kept = last.artifacts.filter((fx) => !outSet.has(fx));
      const fixedArgs: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(norm.specs)) {
        if (spec.kind === "fixed")
          fixedArgs[k] = (spec as { value: unknown }).value;
      }
      const baseDir = this.strictSandbox
        ? join(this.procforgeDir, "sandbox", sid)
        : this.projectRoot;
      const manifest = readManifest(this.procforgeDir, sid);
      const covered = new Set(
        last.artifacts
          .map((fx) => manifest[fx])
          .filter((v): v is string => typeof v === "string"),
      );
      const toolRef = a.tool as { server: string; name: string };
      const cat = s.toolCatalog.find(
        (t) => t.server === toolRef.server && t.name === toolRef.name,
      );
      const relOf = (p: string) => toBaseRel(baseDir, p);
      const fresh = collectExistingPaths({
        baseDir,
        tool: toolRef,
        args: fixedArgs,
        specs: norm.specs,
        catalogEntry: cat,
        roles: ["in", "inout"],
      }).filter((p) => !covered.has(relOf(p)));
      // M4.1.1-1: fresh 중 수정분은 inout → 원본 해결 (없으면 bad_request)
      let treeCacheC: import("@procforge/shared/schema.js").Node[] | undefined;
      const getTreeC = async () =>
        (treeCacheC ??= (await this.core.pfTree(sid)).nodes);
      const resolveC = (rel: string) =>
        resolveOriginal({
          procforgeDir: this.procforgeDir,
          sessionId: sid,
          nodeId,
          rel,
          nodes: treeCacheC ?? [],
          manifest,
        });
      let snapshotModified: Set<string> | undefined;
      if (this.strictSandbox) {
        const pre = readPreSnapshot(this.procforgeDir, sid, nodeId);
        if (pre)
          snapshotModified = new Set(diffSnapshot(pre, baseDir).modified);
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
              if (!orig.buf.equals(readFileSync(resolve(baseDir, p))))
                isInout = true;
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
          procforgeDir: this.procforgeDir,
          sessionId: sid,
          nodeId,
          attemptId: last.id,
          baseDir,
          paths: freshIn,
          maxBytes: this.maxArtifactBytes,
          startIndex: nextIdx,
        });
        nextIdx += freshIn.length;
        merged.push(...ing.stored);
        addIns.push(...ing.stored);
      }
      if (freshInout.length > 0) {
        // 증거(수정본) 먼저, 원본은 마지막
        const ev = ingestArtifacts({
          procforgeDir: this.procforgeDir,
          sessionId: sid,
          nodeId,
          attemptId: last.id,
          baseDir,
          paths: freshInout,
          maxBytes: this.maxArtifactBytes,
          startIndex: nextIdx,
        });
        nextIdx += freshInout.length;
        merged.push(...ev.stored);
        addOuts.push(...ev.stored);
        for (const p of freshInout) {
          const rel = relOf(p);
          const orig = resolveC(rel);
          if (!orig) {
            throw pfError(
              "bad_request",
              `inout 원본 없음: ${rel}`,
              "pf_next 경유 실행·seed 확인 후 다시 pf_report.",
            );
          }
          const o = ingestOriginalFixture({
            procforgeDir: this.procforgeDir,
            sessionId: sid,
            nodeId,
            attemptId: last.id,
            rel,
            buf: orig.buf,
            index: nextIdx++,
            maxBytes: this.maxArtifactBytes,
          });
          merged.push(o.stored);
          addIns.push(o.stored);
          addInouts.push(o.stored);
        }
      }
      if (addIns.length > 0 || addOuts.length > 0 || addInouts.length > 0) {
        appendCaptureRecord(this.procforgeDir, sid, nodeId, last.id, {
          ins: addIns,
          outs: addOuts,
          inouts: addInouts,
        });
      }
    }
    const out = await this.core.pfResolve({
      sessionId: sid,
      nodeId: a.nodeId as string,
      decision: "leaf",
      tool: a.tool as { server: string; name: string },
      argSpecs: norm.specs as never,
      sideEffect: a.sideEffect as
        "none" | "local_write" | "external" | undefined,
      goldenIgnore: a.ignore as string[] | undefined,
      artifacts: merged,
      // M5.8.1-1: runner 실행 가능 집합을 core에 전달 (계산만, 판단은 core).
      // allowBash 미선언이면 기본 거부.
      runnableTools: runnableTools(
        (s.toolCatalog ?? []) as { server: string; name: string }[],
        { allowBash: (a as { allowBash?: unknown }).allowBash === true },
      ),
      // M5.8.2 후속: probing 대조는 LocalServices가 수행, 판정은 core.
      // golden→최종pass 순서 resultJson 파일 기준.
      refCheck: await this.buildRefCheck(
        sid,
        s,
        norm.specs as Record<string, unknown>,
        (last?.args ?? {}) as Record<string, unknown>,
      ),
      strict: (a as { strict?: unknown }).strict === true,
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
    logger.info("pf_retry", {
      sessionId: sid,
      nodeId: a.nodeId,
      reason: a.reason,
    });
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
        this.procforgeDir,
        sid,
        a.nodeId as string,
        takeSandboxSnapshot(join(this.procforgeDir, "sandbox", sid)),
      );
      if (this.strictSandbox) {
        writePreCopies(
          this.procforgeDir,
          sid,
          a.nodeId as string,
          join(this.procforgeDir, "sandbox", sid),
        );
      }
    } catch (e) {
      retryWarnings.push(
        `스냅샷 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
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
    const kids = a.children as
      | {
          goal: string;
          dependsOn?: string[];
          sideEffect?: "none" | "local_write" | "external";
        }[]
      | undefined;
    if (!kids || kids.length === 0)
      throw pfError(
        "bad_request",
        "children이 비었다.",
        "최소 1개의 {goal}을 넣어 pf_split 재호출.",
      );
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
    logger.info("pf_ask_human", {
      sessionId: sid,
      nodeId: a.nodeId,
      question: a.question,
    });
    const out = await this.core.pfResolve({
      sessionId: sid,
      nodeId: a.nodeId as string,
      decision: "ask_human",
      plan: a.plan as
        | {
            tool: { server: string; name: string };
            args: Record<string, unknown>;
          }
        | undefined,
      note: a.question as string,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return {
      node: nodeSummary(out.node, s.limits),
      instruction: out.instruction,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
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
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  async advise(a: AdviseInput): Promise<OutputOf<"pf_advise">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const nid = a.nodeId as string;
    // 최신 attempt의 fixture 내용을 읽어 core 평가에 전달 (M4)
    const cur = await this.core.getNode(sid, nid);
    const fixtureContents = readFixtureContents({
      procforgeDir: this.procforgeDir,
      sessionId: sid,
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
      constraints: out.constraints.map((c) => ({
        id: c.id,
        kind: c.kind,
        summary: constraintSummary(c),
      })),
      rejected: out.rejected,
      ...(out.note ? { note: out.note } : {}),
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  /**
   * M7-1: 세션 목록 (원천은 core.getSessions — 원격 모드에서 서버 저장소.
   * App은 core 요약 + 로컬 부가(pairings·connectionIds) 합성만).
   * connectionIds 2개 이상이면 UI가 경고 배지를 붙인다.
   */
  async listSessions(): Promise<{ sessions: SessionSummary[] }> {
    const { sessions } = await this.core.getSessions();
    return { sessions: enrichSessions(this.procforgeDir, sessions) };
  }

  /** M7-ui1: 짝짓기 원본 (어댑터는 App 메서드로만) */
  async listPairings(): Promise<Pairings> {
    return loadPairings(this.procforgeDir);
  }

  /** M7-ui2: 이벤트 페이지 (core에서만 읽는다) */
  async getEventsPage(input: {
    sessionId: string;
    afterRevision?: number;
    limit?: number;
    nodeId?: string;
    /** M7-ui4-g: true면 **최신** limit건 (노드 이력). false면 오래된 것부터 (SSE 증분) */
    tail?: boolean;
  }): Promise<{ events: import("@procforge/shared/dto.js").EventEntry[]; lastRevision: number }> {
    return this.core.getEventsPage(input);
  }

  /** 읽기 전용 세션 조회 (M7-ui3 내부·테스트용. touch 없음) */
  async readSession(sessionId: string): Promise<{ revision: number }> {
    return this.core.getSession(sessionId);
  }

  /** 읽기 전용 노드 조회 (M7-ui3 내부·테스트용. touch 없음) */
  async readNode(sessionId: string, nodeId: string) {
    return this.core.getNode(sessionId, nodeId);
  }

  /**
   * M7-ui3: 노드 상세. 메타·판정·hash는 core(getNode), 산출물 미리보기는
   * 로컬에서만 읽는다 (R8: 원문은 로컬 밖으로 나가지 않는다).
   * 판단 없음 — 표시 매핑은 UI가 한다.
   */
  async nodeDetail(input: {
    sessionId: string;
    nodeId: string;
  }): Promise<NodeDetail> {
    const sessionId = input.sessionId;
    const node = await this.core.getNode(sessionId, input.nodeId);
    const s = await this.core.getSession(sessionId);
    // 산출물은 세션 디렉터리(fixtures/...)에 저장된다. 그 밖은 거부.
    const sandboxRoot = join(this.procforgeDir, "sessions", sessionId);
    const last = node.attempts[node.attempts.length - 1];
    const attempts = await Promise.all(
      node.attempts.map(async (a) => {
        const preview = (
          await Promise.all(
            a.artifacts.map((rel) => previewArtifact(sandboxRoot, rel)),
          )
        ).filter((x): x is ArtifactPreview => x !== null);
        return {
          id: a.id,
          at: a.at,
          tool: a.tool,
          verdict: a.verdict ?? null,
          failedConstraints: a.failedConstraints,
          rubricReasons: a.rubricReasons ?? {},
          resultSummary: a.resultSummary,
          resultJsonMeta: a.resultJsonMeta ?? null,
          artifactPreviews: preview,
        };
      }),
    );
    return {
      sessionId,
      nodeId: node.id,
      revision: s.revision,
      goal: node.goal,
      status: node.status,
      locked: node.locked,
      sideEffect: node.sideEffect,
      staleSince: node.staleSince ?? null,
      hash: node.hash,
      tool: node.tool ?? null,
      args: node.args ?? {},
      map: node.map ?? null,
      until: node.until ?? null,
      dependsOn: node.dependsOn,
      constraints: node.constraints,
      advice: node.advice,
      golden: node.golden ?? null,
      approval: node.approval ?? null,
      retriesLeft: retriesLeft(node, s.limits),
      attempts,
      resultJsonMeta: last?.resultJsonMeta ?? null,
      lastVerdict: last?.verdict ?? null,
      lastFailedConstraints: last?.failedConstraints ?? [],
    };
  }

  /**
   * M7-ui3-a: attempt 산출물 1건 전문 (로컬 전용).
   * rel은 **core.getNode의 attempt.artifacts[idx]** 로만 결정한다 —
   * 클라이언트가 경로 문자열을 보내지 않는다. 세션·노드·attempt·인덱스를
   * core에서 먼저 검증하고, 그 뒤 realpath 기준으로 세션 디렉터리 안인지 본다.
   */
  async artifactContent(input: {
    sessionId: string;
    nodeId: string;
    attemptId: string;
    index: number;
  }): Promise<{ bytes: Buffer; mime: string; downloadName: string }> {
    // 1) core 검증 (세션 존재·노드·attempt·인덱스). 실패하면 경로에 손도 안 댄다.
    const node = await this.core.getNode(input.sessionId, input.nodeId);
    const attempt = node.attempts.find((a) => a.id === input.attemptId);
    if (!attempt) throw pfError("not_found", "attempt 없음");
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw pfError("bad_request", "bad artifact index");
    }
    const rel = attempt.artifacts[input.index];
    if (rel === undefined) throw pfError("not_found", "산출물 없음");
    // 2) 로컬 realpath 검사 (심링크 탈출 포함).
    const sessionRoot = join(this.procforgeDir, "sessions", input.sessionId);
    return readArtifact(sessionRoot, rel);
  }

  /** M7-ui2: 세션 트리 (노드 요약 + stale 표시. 상태 변경 0) */
  async sessionTree(input: {
    sessionId: string;
    limit?: number;
  }): Promise<{ nodes: SessionNodeRow[]; revision: number }> {
    const s = await this.core.getSession(input.sessionId);
    const out = await this.tree({
      sessionId: input.sessionId,
      detail: "full",
      limit: input.limit ?? 200,
    });
    return {
      nodes: out.entries.map((e: (typeof out.entries)[number]) => ({
        id: e.id,
        goal: e.goal,
        status: e.status,
        depth: e.node?.depth ?? 0,
        dependsOn: e.node?.dependsOn ?? [],
        attempts: e.node?.attempts.length ?? 0,
        retriesLeft: e.node ? retriesLeft(e.node, s.limits) : 0,
        locked: e.node?.locked ?? false,
        sideEffect: e.node?.sideEffect ?? "none",
        ...(e.node?.staleSince ? { staleSince: e.node.staleSince } : {}),
      })),
      revision: s.revision,
    };
  }

  private limitsCache = new Map<string, { maxRetries: number; maxDepth: number; maxNodes: number }>();

  private limitsOf(sessionId: string): {
    maxRetries: number;
    maxDepth: number;
    maxNodes: number;
  } {
    const cached = this.limitsCache.get(sessionId);
    if (cached) return cached;
    return { maxRetries: 2, maxDepth: 5, maxNodes: 50 };
  }

  /** M7-ui2: blocked·needs_human (읽기 전용) */
  async getBlocked(input: { sessionId: string }): Promise<{
    blocked: import("@procforge/shared/core-client.js").BlockedEntry[];
    needsHuman: string[];
    revision: number;
  }> {
    return this.core.getBlocked(input);
  }

  /** M7-ui1: 저장소 정보 + 중복 경고 (어댑터는 App 메서드로만) */
  async storeInfo(): Promise<{
    storeDir: string;
    projectRoot: string;
    duplicateWarning: string | null;
  }> {
    return {
      storeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      duplicateWarning: detectDuplicateStores(this.projectRoot, this.procforgeDir),
    };
  }

  /**
   * M7-ui4-c: **신호만** 보낸다 (advise를 하지 않는다).
   * M7-ui4-i: baseUrl·mode·timeoutMs·serverVersion은 모두 서버 설정/조회값이다.
   * M7-ui4-j: 짝도 없으면 **전송하지 않는다** — 어디로 보낼지 모르는 신호는
   *   아무것도 바꾸지 않는 쪽이 낫다(가짜 서버 요청 0건).
   */
  async signalOnly(input: {
    sessionId: string;
    /** 미지정 시 이 세션의 최신 짝짓기를 쓴다 (UI는 클라이언트가 못 고른다) */
    openCodeSessionId?: string;
    text?: string;
  }): Promise<LinkResult> {
    const sid = input.sessionId;
    const cfg = this.signal;
    const openSid = input.openCodeSessionId ?? this.latestPairingSessionId(sid);
    const copy = `${input.text ?? cfg.text ?? "계속"}\nOpenCode에서 '계속'이라고 입력하세요.`;
    // M7-ui4-j: 문구 우선순위를 한 곳에 — 1 미설정 → 2 짝 없음 → 3 다른 세션 → 4 전송
    const notSent = (reason: string): LinkResult => ({
      delivered: false,
      degraded: `${reason}. 전송하지 않음`,
      copyText: copy,
    });
    if (!cfg.baseUrl) return notSent("OpenCode 주소 미설정");
    if (!openSid) return notSent("OpenCode 세션 짝이 없음");
    const pair = getPairing(this.procforgeDir, openSid);
    if (pair && pair.pfSessionId !== sid) {
      return notSent(`다른 세션과 짝(${pair.pfSessionId})`);
    }
    // M7-ui4-i: 버전은 서버 설정 또는 OpenCode 서버 조회값만 (default-deny 유지)
    const serverVersion =
      cfg.serverVersion ??
      (await fetchServerVersion(cfg.baseUrl, { fetchImpl: this.linkFetchImpl }));
    const http = httpLinkDeps(cfg.baseUrl, this.linkFetchImpl);
    return sendContinue({
      baseUrl: cfg.baseUrl,
      openCodeSessionId: openSid,
      text: input.text ?? cfg.text ?? "계속",
      mode: cfg.mode,
      timeoutMs: clampTimeoutMs(cfg.timeoutMs),
      serverVersion,
      deps: {
        fetchImpl: this.linkFetchImpl,
        ...http,
        onPairing: (osid, pfSid) => {
          savePairing(this.procforgeDir, osid, pfSid);
        },
      },
    });
  }

  /** 이 세션에 짝지어진 OpenCode 세션 중 가장 최근 것 */
  private latestPairingSessionId(sessionId: string): string | undefined {
    const pairs = Object.values(loadPairings(this.procforgeDir).pairs)
      .filter((p) => p.pfSessionId === sessionId)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return pairs[0]?.openCodeSessionId;
  }

  /**
   * M7-1: 사람 조언 등록 + OpenCode에 "계속" 신호.
   * advise는 **한 번만** 한다 (M7-ui4-c). advise가 실패하면 신호를 보내지 않는다.
   * M7-ui4-b: link.baseUrl·mode는 서버 설정과 다르면 400 (클라이언트가 정하지 않는다).
   */
  async adviseAndSignal(
    a: AdviseInput & { link?: Partial<SignalTarget> & { openCodeSessionId?: string } },
  ): Promise<{ advise: OutputOf<"pf_advise">; signal: LinkResult }> {
    const link = a.link ?? {};
    if (link.baseUrl && link.baseUrl !== this.signal.baseUrl) {
      throw pfError(
        "bad_request",
        "link.baseUrl은 서버 설정에서만 결정됩니다 (M7-ui4-b).",
      );
    }
    if (link.mode && link.mode !== this.signal.mode) {
      throw pfError(
        "bad_request",
        "link.mode는 서버 설정에서만 결정됩니다 (M7-ui4-b).",
      );
    }
    // M7-ui4-i: 버전·타임아웃도 서버 설정/조회값만 (클라이언트가 정하면 거절).
    if (link.serverVersion !== undefined || link.timeoutMs !== undefined) {
      throw pfError(
        "bad_request",
        "link.serverVersion·timeoutMs는 서버 설정에서만 결정됩니다 (M7-ui4-i).",
      );
    }
    const advised = await this.advise(a);
    // M7-ui4-i: 버전·타임아웃은 위에서 400 처리했으므로 여기서 넘기지 않는다.
    const signal = await this.signalOnly({
      sessionId: a.sessionId as string,
      openCodeSessionId: link.openCodeSessionId,
      text: link.text,
    });
    return { advise: advised, signal };
  }

  async tree(a: TreeInput): Promise<OutputOf<"pf_tree">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    this.limitsCache.set(sid, s.limits);
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
    if (!n)
      throw pfError(
        "not_found",
        `노드 없음: ${a.nodeId}`,
        "pf_tree로 id를 확인하라.",
      );
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
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
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
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  /** M7-ui4: 편집 미리보기 (읽기 전용 — core에 위임. UI는 표시만) */
  async previewEdit(input: {
    sessionId: string;
    nodeId: string;
    change: {
      patch?: { set?: Record<string, unknown>; remove?: string[] };
      goal?: string;
      dependsOn?: string[];
      addConstraints?: unknown[];
      removeConstraintIds?: string[];
    };
  }): Promise<{ wouldStale: string[]; newHash: string; revision: number }> {
    return this.core.previewEdit(input as never);
  }

  /**
   * M7-ui4: UI 편집 저장. actor는 항상 "ui"(M7-0.1 귀속 규칙).
   * expectedRevision이 없으면 거부한다 — 자동 재시도로 충돌을 덮지 않는다.
   */
  async uiEditArgs(input: {
    sessionId: string;
    nodeId: string;
    patch: { set?: Record<string, unknown>; remove?: string[] };
    expectedRevision: number;
  }): Promise<{ node: ReturnType<typeof nodeSummary>; revision: number; changedNodeIds: string[] }> {
    if (!Number.isInteger(input.expectedRevision)) {
      throw pfError("bad_request", "expectedRevision 필수");
    }
    const sid = input.sessionId;
    const s = await this.core.getSession(sid);
    // M7-ui4-d: core 호출 뒤, 실제 결과로 기록한다.
    const out = await this.core
      .pfEditArgs({
        sessionId: sid,
        nodeId: input.nodeId,
        patch: input.patch as never,
        expectedRevision: input.expectedRevision,
        actor: "ui",
      })
      .catch((e: unknown) => {
        this.recordUiCall(sid, "pf_edit_args", input.nodeId, e);
        throw e;
      });
    this.recordUiCall(sid, "pf_edit_args", input.nodeId);
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  /**
   * M7-ui4: UI 의견 + "계속" 신호 (M7-0.2 B>A>C).
   * advise가 먼저 저장되고, 신호 실패·degraded여도 **저장분은 그대로**다
   * (신호는 상태 변경이 아니다).
   * M7-ui4-b: baseUrl·mode·openCodeSessionId는 **입력으로 받지 않는다** —
   * 서버 설정과 저장된 짝짓기로 정한다.
   */
  async uiAdviseAndSignal(input: {
    sessionId: string;
    nodeId: string;
    text: string;
    expectedRevision: number;
    /** false면 저장만 (신호 시도 안 함) */
    signal?: boolean;
  }): Promise<{
    advise: OutputOf<"pf_advise">;
    signal: LinkResult | null;
  }> {
    if (!Number.isInteger(input.expectedRevision)) {
      throw pfError("bad_request", "expectedRevision 필수");
    }
    const sid = input.sessionId;
    // M7-ui4-d: 기록은 core 호출 **뒤**, 실제 결과로 남긴다.
    const advised = await this.advise({
      sessionId: sid,
      nodeId: input.nodeId,
      text: input.text,
      expectedRevision: input.expectedRevision,
      actor: "ui",
    } as never).catch((e: unknown) => {
      this.recordUiCall(sid, "pf_advise", input.nodeId, e);
      throw e;
    });
    this.recordUiCall(sid, "pf_advise", input.nodeId);
    if (input.signal === false) return { advise: advised, signal: null };
    // advise는 **이미 저장됐다.** 여기서 신호만 보낸다 (advise 2회 금지 —
    // 같은 expectedRevision으로 두 번째가 conflict 난다).
    const signal = await this.signalOnly({ sessionId: sid });
    return { advise: advised, signal };
  }

  /**
   * M7-ui4-d: UI 호출 기록. core 호출 **이후**에만 남기고, 결과(ok/오류코드)를
   * 그대로 적는다 — 실패한 쓰기가 성공처럼 기록되면 안 된다.
   */
  private recordUiCall(
    sessionId: string,
    tool: string,
    nodeId: string,
    err?: unknown,
  ): void {
    const code = (err as { code?: unknown } | undefined)?.code;
    recordCall(this.procforgeDir, {
      sessionId,
      tool,
      nodeId,
      clientName: "procforge-ui",
      actor: "ui",
      connectionId: this.uiConnectionId,
      ok: err === undefined,
      ...(typeof code === "string" ? { errorCode: code } : {}),
    });
  }

  /** M7-ui4: UI 노드 편집(목표·조건) — actor "ui" */
  async uiEditNode(input: {
    sessionId: string;
    nodeId: string;
    goal?: string;
    addConstraints?: unknown[];
    removeConstraintIds?: string[];
    dependsOn?: string[];
    expectedRevision: number;
  }): Promise<{ node: ReturnType<typeof nodeSummary>; revision: number; changedNodeIds: string[] }> {
    if (!Number.isInteger(input.expectedRevision)) {
      throw pfError("bad_request", "expectedRevision 필수");
    }
    const sid = input.sessionId;
    const s = await this.core.getSession(sid);
    // M7-ui4-d: core 호출 뒤, 실제 결과로 기록한다.
    const out = await this.core
      .pfEditNode({
        sessionId: sid,
        nodeId: input.nodeId,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.addConstraints !== undefined
          ? { addConstraints: input.addConstraints as never }
          : {}),
        ...(input.removeConstraintIds !== undefined
          ? { removeConstraintIds: input.removeConstraintIds }
          : {}),
        ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
        expectedRevision: input.expectedRevision,
        actor: "ui",
      })
      .catch((e: unknown) => {
        this.recordUiCall(sid, "pf_edit_node", input.nodeId, e);
        throw e;
      });
    this.recordUiCall(sid, "pf_edit_node", input.nodeId);
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  async editArgs(a: EditArgsInput): Promise<OutputOf<"pf_edit_args">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfEditArgs({
      sessionId: sid,
      nodeId: a.nodeId as string,
      patch: {
        set: a.patch?.set as
          | Record<string, import("@procforge/shared/schema.js").ArgSpec>
          | undefined,
        remove: a.patch?.remove as string[] | undefined,
      },
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return {
      node: nodeSummary(out.node, s.limits),
      instruction: out.instruction,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  async editNode(a: EditNodeInput): Promise<OutputOf<"pf_edit_node">> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfEditNode({
      sessionId: sid,
      nodeId: a.nodeId as string,
      goal: a.goal as string | undefined,
      addConstraints: a.addConstraints as
        import("@procforge/shared/schema.js").Constraint[] | undefined,
      removeConstraintIds: a.removeConstraintIds as string[] | undefined,
      dependsOn: a.dependsOn as string[] | undefined,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: (a.actor as Actor | undefined) ?? "host",
    });
    return {
      node: nodeSummary(out.node, s.limits),
      instruction: out.instruction,
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  async refreshCatalog(
    _a: RefreshCatalogInput,
  ): Promise<OutputOf<"pf_refresh_catalog">> {
    const c = await collectCatalog(this.projectRoot, {
      cacheDir: join(this.procforgeDir, "cache"),
      refresh: true,
      ...(this.catalogTimeoutMs !== undefined
        ? { timeoutMs: this.catalogTimeoutMs }
        : {}),
    });
    return {
      entries: c.entries.map((e) => ({
        server: e.server,
        name: e.name,
        schemaHash: e.schemaHash,
      })),
      warnings: c.warnings,
      cached: c.cached,
    };
  }

  async test(a: TestInput): Promise<OutputOf<"pf_test">> {
    if (a.procedure) {
      const { report, sessionId: imported } = await runProcedureTest(
        this.procforgeDir,
        this.projectRoot,
        a.procedure as string,
        {
          procforgeDir: this.procforgeDir,
          projectRoot: this.projectRoot,
          mode:
            (a.mode as
              "record" | "replay" | "passthrough" | "live" | undefined) ??
            "replay",
          params: (a.params as Record<string, string> | undefined) ?? {},
          updateGolden: (a.updateGolden as boolean | undefined) ?? false,
          allowProjectRead:
            (a.allowProjectRead as boolean | undefined) ?? false,
        },
      );
      const junitPathProc = resolveJUnitPath(
        this.projectRoot,
        this.procforgeDir,
        a.junitPath as string | undefined,
        report.runId,
      );
      writeJUnitFile(junitPathProc, report);
      return {
        runId: report.runId,
        mode: report.mode,
        passed: report.summary.pass,
        failed: report.summary.fail,
        unverified: report.summary.unverified,
        skipped: report.summary.skipped,
        blocked: report.summary.blocked,
        reportPath: join(
          this.procforgeDir,
          "runs",
          report.runId,
          "report.json",
        ),
        junitPath: junitPathProc,
        sessionId: imported,
      };
    }
    if (!a.sessionId)
      throw pfError(
        "bad_request",
        "sessionId 또는 procedure 중 하나가 필요하다.",
      );
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const report = await runSession({
      procforgeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      sessionId: sid,
      nodeId: a.nodeId as string | undefined,
      mode:
        (a.mode as "record" | "replay" | "passthrough" | "live" | undefined) ??
        "replay",
      updateGolden: (a.updateGolden as boolean | undefined) ?? false,
      allowProjectRead: (a.allowProjectRead as boolean | undefined) ?? false,
      changed: (a.changed as boolean | undefined) ?? false,
      // M6.1-2: 원격 core면 하이드레이트 후 실행 (inprocess는 동일 상태라 무해).
      core: this.core,
    });
    const reportPath = join(
      this.procforgeDir,
      "runs",
      report.runId,
      "report.json",
    );
    const junitPath = resolveJUnitPath(
      this.projectRoot,
      this.procforgeDir,
      a.junitPath as string | undefined,
      report.runId,
    );
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

  /**
   * 손상 rev 해제 (M4.2-4-0-1, CLI 전용. MCP 도구 없음).
   * .corrupt-<rev>-* + pending-<rev>.json 제거 후 human 이벤트 기록.
   */
  async repair(a: {
    sessionId: unknown;
    discardRev: unknown;
  }): Promise<{ removed: string[] }> {
    const sid = a.sessionId as string;
    const rev =
      typeof a.discardRev === "number" ? a.discardRev : Number(a.discardRev);
    if (!Number.isInteger(rev) || rev < 0)
      throw pfError("bad_request", `bad revision: ${String(a.discardRev)}`);
    return repairDiscard(this.procforgeDir, sid, rev);
  }

  /** 호출 추적 마크다운 (M4.2-4-1, CLI trace용) */
  async traceMarkdown(a: {
    sessionId: unknown;
  }): Promise<{ markdown: string }> {
    const sid = a.sessionId as string;
    return {
      markdown: formatTraceMarkdown(buildTrace(this.procforgeDir, sid)),
    };
  }

  /** 세션 export (M4.2-4-1, CLI export용). outPath 지정 시 프로젝트 안만 허용. */
  async exportSession(a: {
    sessionId: unknown;
    outPath?: unknown;
    redact?: unknown;
    includeOriginals?: unknown;
  }): Promise<{ outPath: string; files: number; redacted: boolean }> {
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const outPath =
      typeof a.outPath === "string" && a.outPath !== ""
        ? assertProjectPath(this.projectRoot, a.outPath)
        : join(this.procforgeDir, "exports", `${sid}.zip`);
    return exportSession({
      procforgeDir: this.procforgeDir,
      sessionId: sid,
      outPath,
      redact: a.redact === true,
      includeOriginals: a.includeOriginals === true,
    });
  }

  async finalize(a: FinalizeInput): Promise<OutputOf<"pf_finalize">> {
    const sid = a.sessionId as string;
    await this.core.getSession(sid);
    const { doc, warnings } = await this.core.pfBuildProcedure(
      sid,
      a.name as string,
    );
    // M5.3.1-3: 기간성 params(감사가 날짜로 판정한 default 값)는 default 금지 → required.
    for (const [k, entry] of Object.entries(doc.params)) {
      const e = entry as { default?: string; required?: boolean };
      if (e.default !== undefined && findDateSample(e.default) !== null) {
        delete e.default;
        e.required = true;
      }
    }
    // M5.1-B1: 고정값 감사 (params·날짜·녹화 수치). strict면 실패 시 거부.
    const sess = await this.core.getSession(sid);
    const { nodes } = await this.core.pfTree(sid);
    const cassettes = new Map<
      string,
      { response: { summary: string; json?: unknown } }[]
    >();
    for (const n of nodes) {
      try {
        cassettes.set(n.id, loadCassette(this.procforgeDir, sid, n.id));
      } catch {
        // 손상 카세트는 감사 제외 (record 경로에서 처리)
      }
    }
    const audit = auditFixedValues({ params: sess.params, nodes, cassettes });
    // M5.3-1: 파일 내용 감사 (스크립트 + 비바인딩 템플릿). strict면 실패 시 거부.
    const contentItems = collectAuditContent({
      projectRoot: this.projectRoot,
      nodes,
    });
    const contentAudit = auditContentTexts({
      params: sess.params,
      items: contentItems,
      cassettes,
    });
    const allAudit = [...audit, ...contentAudit];
    // M5.3.1-2: manifest source 문자열도 감사 (바인딩 해석분 제외).
    // fixtures/ 형태 file_exists는 시스템 경로라 건너뛰므로, 대응 source rel의
    // 날짜·params 리터럴이 strict를 빠져나가는 구멍을 여기서 막는다.
    {
      const boundSrcs = new Set<string>();
      for (const n of nodes) {
        const lastArgs = (n.attempts[n.attempts.length - 1]?.args ??
          {}) as Record<string, unknown>;
        for (const [k, spec] of Object.entries(n.args ?? {})) {
          const s = spec as { kind?: string; ref?: unknown };
          if (
            s.kind === "var" &&
            typeof s.ref === "string" &&
            s.ref.includes("${params.") &&
            typeof lastArgs[k] === "string"
          ) {
            boundSrcs.add(lastArgs[k] as string);
          }
        }
      }
      const manifestMap = readManifest(this.procforgeDir, sid);
      const srcItems: { nodeId: string; where: string; text: string }[] = [];
      for (const [fx, src] of Object.entries(manifestMap)) {
        if (boundSrcs.has(src)) continue;
        const m = /^fixtures\/([^/]+)\//.exec(fx);
        if (!m) continue;
        srcItems.push({
          nodeId: m[1],
          where: `template:${src} (fixture)`,
          text: src,
        });
      }
      const srcAudit = auditContentTexts({
        params: sess.params,
        items: srcItems,
        cassettes,
      });
      allAudit.push(...srcAudit);
    }
    // M5.6-g: 누적(stateWrites) 노드는 출력 단언 constraint 필수. 없으면 경고,
    // strict면 위에서 거부. 빈 누적 결과가 그대로 통과하는 것을 막는다.
    // M6.1-2: pfTree가 전체 노드를 주므로 getNode 팬아웃 불필요
    // (원격 burst EACCES 완화 + 왕복 절감).
    const fullNodes = nodes;
    allAudit.push(
      ...auditStateWrites(
        fullNodes as {
          id: string;
          constraints?: { kind?: string; source?: string }[];
          stateWrites?: { key: string; from: string }[];
        }[],
      ),
    );
    // M5.7.1: llm_rubric 잔존 경고 (무인 실행 unverified → exit 1). strict면 아래에서 거부.
    allAudit.push(
      ...auditRubricConstraints(
        fullNodes as {
          id: string;
          constraints?: { id?: string; kind?: string }[];
        }[],
      ),
    );
    // M5.8.2 후속: var ref 필드 사전검사 (core에는 resultJson 실데이터가 없음).
    // golden→최종pass 파일 기준. 출력은 있는데 필드가 없으면 bad_ref_field.
    {
      const store = new FileStore(this.procforgeDir);
      const infos = new Map<string, RefNodeInfo>();
      for (const x of fullNodes as {
        id: string;
        kind?: string;
        golden?: { attemptId?: string };
        attempts?: { id: string; verdict?: string }[];
      }[]) {
        infos.set(x.id, {
          id: x.id,
          kind: x.kind,
          goldenAttemptId: x.golden?.attemptId,
          attempts: (x.attempts ?? []).map((a) => ({
            id: a.id,
            verdict: a.verdict,
          })),
        });
      }
      const { outputs } = buildRefOutputs({
        specs: Object.assign(
          {},
          ...fullNodes.map(
            (x) =>
              ((x as { args?: unknown }).args ?? {}) as Record<string, unknown>,
          ),
        ),
        params: (sess.params ?? {}) as Record<string, string>,
        nodes: infos,
        loadJson: (aid: string) => store.readResultJson(sid, aid),
      });
      for (const x of fullNodes as {
        id: string;
        args?: Record<string, { kind?: string; ref?: unknown }>;
      }[]) {
        for (const [k, spec] of Object.entries(x.args ?? {})) {
          if (spec?.kind !== "var" || typeof spec.ref !== "string") continue;
          const tid = varRefNodeId(spec.ref);
          if (
            tid === undefined ||
            !Object.prototype.hasOwnProperty.call(outputs, tid)
          )
            continue;
          const r = resolveRefValue(
            spec.ref,
            (sess.params ?? {}) as Record<string, string>,
            outputs,
          );
          if (!r.ok) {
            throw pfError(
              "bad_ref_field",
              `arg ${x.id}.${k}: field 없음 (상류 ${tid} 출력에 없음): ${spec.ref}`,
            );
          }
        }
      }
    }
    // M5.8.1-1: bash leaf 포함 시 run에 --allow-bash 필요 경고 (기본 거부·opt-in은 DECISIONS).
    {
      const bashLeaves = (
        fullNodes as { id: string; tool?: { server?: string; name?: string } }[]
      )
        .filter((x) => x.tool?.server === "opencode" && x.tool?.name === "bash")
        .map((x) => x.id);
      if (bashLeaves.length > 0) {
        allAudit.push(
          `bash leaf 포함(${bashLeaves.join(",")}): run에 --allow-bash 필요 (기본 거부, DECISIONS M5.8.1-1)`,
        );
      }
    }
    if ((a.strict as boolean | undefined) === true && allAudit.length > 0) {
      throw pfError(
        "bad_request",
        `고정값 감사 실패(${allAudit.length}건): ${allAudit.slice(0, 3).join("; ")}`,
      );
    }
    const written = writeProcedure({
      procforgeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      sessionId: sid,
      doc,
      force: (a.force as boolean | undefined) ?? false,
      auditFindings: allAudit,
    });
    return {
      name: doc.name,
      dir: written.dir,
      warnings: [...warnings, ...allAudit],
      files: written.files,
      commandFile: written.commandFile,
    };
  }

/**
 * M7 5-2: 승인 화면에 필요한 것만 — 스크립트 경로·sha256·현재 내용·diff·
 * 지금의 approvalHash. 판단(승인/거부)은 pf_approve가 한다.
 */
async uiApprovalInfo(input: { sessionId: string; nodeId: string }): Promise<{
  sessionId: string;
  nodeId: string;
  approvalHash: string;
  script: { rel: string; sha256: string; content: string } | null;
  diff: string | null;
  approved: boolean;
  needsReapproval: boolean;
}> {
  const sid = input.sessionId;
  const nid = input.nodeId;
  const n = await this.core.getNode(sid, nid);
  const tree = await this.core.pfTree(sid);
  const byId = new Map(tree.nodes.map((x) => [x.id, x]));
  // M7-5-g: realpath sandbox + 5MB 상한 (rel 은 모델이 적은 값이라 ../ 가 들어온다)
  const readScript = (rel: string): string | undefined => {
    try {
      return readSandboxed(join(this.procforgeDir, "sessions", sid), rel);
    } catch {
      return undefined;
    }
  };
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  const pins = approvalPins(
    n,
    parent ? { id: parent.id, hash: parent.hash, kind: (parent as { kind?: string }).kind } : undefined,
    toHashableMap(byId),
    readScript,
  );
  const approvalHash = pins[0]?.approvalHash ?? "";
  // script-kind 인자만 화면에 노출 (읽기 전용)
  const spec = (n.args as Record<string, { kind?: string; file?: string }> | undefined)?.script;
  const rel = spec?.file;
  let script: { rel: string; sha256: string; content: string } | null = null;
  let diff: string | null = null;
  if (rel) {
    const content = readScript(rel) ?? "";
    script = {
      rel,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      content,
    };
    // M7-5-e: diff 는 **승인 스냅샷**과 비교한다. (이력의 파일 경로를 다시 읽으면 그 파일이
    // 이미 현재본이라 항상 같아져 diff 가 늘 null 이 된다)
    const st = readRunStateBySession(this.procforgeDir, sid);
    if (st?.procedureDir) {
      const prevScript = readApprovedSnapshot(st.procedureDir, nid);

      if (prevScript !== undefined && prevScript !== content) {
        diff = unifiedDiff(prevScript, content, "approved", rel);
      }
    }
  }
  const approved = pins.length > 0 && this.hasCurrentApproval(sid, nid, pins);
  return {
    sessionId: sid,
    nodeId: nid,
    approvalHash,
    script,
    diff,
    approved,
    // 승인 이력이 있는데 지금 핀과 다르면 재승인 필요
    needsReapproval: !approved && this.hasAnyApproval(sid, nid),
  };
}

/** M7 5-2: 승인 — approvalHash가 지금 값과 다르면 409 (무음 승인 금지) */
async uiApprove(input: {
  sessionId: string;
  nodeId: string;
  approvalHash: string;
  approved: boolean;
  note?: string;
  expectedRevision: number;
}): Promise<{ nodeId: string; approvalHash: string; approved: boolean }> {
  if (!Number.isInteger(input.expectedRevision)) {
    throw pfError("bad_request", "expectedRevision 필수");
  }
  if (!input.approvalHash) {
    throw pfError("bad_request", "approvalHash 필수 (M7-5-2)");
  }
  // M7-5-i: 승인은 **명시**해야 한다. 빠지면 승인으로 간주하면 안 된다
  // (요청을 조용히 승인으로 만들어 버리는 구멍).
  if (typeof input.approved !== "boolean") {
    throw pfError("bad_request", "approved 는 boolean 으로 명시해야 합니다 (M7-5-i).");
  }
  const info = await this.uiApprovalInfo({
    sessionId: input.sessionId,
    nodeId: input.nodeId,
  });
  if (info.approvalHash !== input.approvalHash) {
    throw pfError(
      "conflict",
      `approvalHash 불일치 (화면 ${input.approvalHash.slice(0, 8)} ≠ 현재 ${info.approvalHash.slice(0, 8)}). 다시 읽으세요.`,
    );
  }
  const out = await this.core.pfApprove({
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    approved: input.approved,
    ...(input.note !== undefined ? { note: input.note } : {}),
    expectedRevision: input.expectedRevision,
    actor: "ui",
  });
  const st = readRunStateBySession(this.procforgeDir, input.sessionId);
  if (st?.procedureDir) {
    const entry = buildApprovalEntry(
      out.node as never,
      [],
      new Map(),
      (rel: string) => {
        try {
          return readFileSync(join(this.procforgeDir, "sessions", input.sessionId, rel), "utf8");
        } catch {
          return undefined;
        }
      },
    );
    // M7-5-e: 승인 시 스크립트 **내용 스냅샷**을 남긴다. 나중에 diff 를 그릴 유일한 기준.
    let snapshotArg: { file?: string; snapshot?: string } | undefined;
    const scriptSpec = info.script;

    if (scriptSpec && st.procedureDir) {
      const snap = saveApprovedSnapshot(st.procedureDir, input.nodeId, scriptSpec.content);
      snapshotArg = { file: scriptSpec.rel, snapshot: snap.snapshotRel };
    }
    const mergedArgs = snapshotArg
      ? { ...(entry.args ?? {}), script: snapshotArg }
      : entry.args;
    saveApproval(st.procedureDir, { ...entry, args: mergedArgs, approvalHash: info.approvalHash });
  }
  this.recordUiCall(input.sessionId, "pf_approve", input.nodeId);
  // M7-5-c: 승인 대기로 멈췄던 실행을 **이어간다** (이게 없으면 대기에 영박으로 남는다)
  // M7-5-c: 승인은 진행을 재개하고, **거부는 끝낸다**.
  // 거부만 해놓고 대기 상태로 두면 그 절차서가 409 고착이다.
  const waitingRun = this.waitingRunBySession(input.sessionId);
  if (waitingRun) {
    if (input.approved) {
      this.resumeRunIfWaiting(waitingRun.runId, waitingRun.procedure);
    } else {
      this.finishRun(waitingRun.runId, waitingRun.procedure, "info", "거부됨 — 실행 종료", input.nodeId);
      writeRunState(this.procforgeDir, {
        ...(readRunState(this.procforgeDir, waitingRun.runId) as RunState),
        status: "cancelled",
        waiting: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { nodeId: input.nodeId, approvalHash: info.approvalHash, approved: input.approved };
}

/** M7-5-b: 이 세션에서 결정을 기다리는 실행 (디스크 기준) */
private waitingRunBySession(
  sessionId: string,
): { runId: string; procedure: string } | undefined {
  const runsDir = join(this.procforgeDir, "runs");
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const st = readRunState(this.procforgeDir, name) as
      | (RunState & { waiting?: { nodeId: string } })
      | undefined;
    if (!st?.waiting) continue;
    if (st.sessionId !== sessionId) continue;
    if (st.status === "done" || st.status === "failed" || st.status === "cancelled") continue;
    if (readCancelFlag(this.procforgeDir, st.runId)) continue;
    return { runId: st.runId, procedure: st.procedure };
  }
  return undefined;
}

private hasAnyApproval(sessionId: string, nodeId: string): boolean {
  const st = readRunStateBySession(this.procforgeDir, sessionId);
  if (!st?.procedureDir) return false;
  return loadApprovals(st.procedureDir).some((e) => e.node.id === nodeId);
}

private hasCurrentApproval(
  sessionId: string,
  nodeId: string,
  pins: { id: string; hash: string; approvalHash: string }[],
): boolean {
  const st = readRunStateBySession(this.procforgeDir, sessionId);
  if (!st?.procedureDir) return false;
  const list = loadApprovals(st.procedureDir);
  // 화면 판단은 **approvalHash 일치**만 본다 (node.hash는 실행 시 runner가 판정한다 —
  // 승인 직후 노드 hash는 바뀌므로 화면에서 재확인하면 거짓말이 된다).
  return list.some((e) =>
    pins.some(
      (p) =>
        p.id === e.node.id &&
        // M7-5-f: 해시 없는 이력(v1)은 **미승인**으로 본다. 예외를 두면
        // "스크립트가 바뀌면 무효" 원칙에 구멍이 된다.
        typeof e.approvalHash === "string" &&
        e.approvalHash.length > 0 &&
        e.approvalHash === p.approvalHash,
    ),
  );
}

  /**
   * M7 5-1: UI 실행. **즉시** `{runId}`를 돌려주고, 로그는 SSE로 흘린다.
   * - 등록된 절차서만 / - 선언된 param만 / - 절차서당 동시 1개(409)
   */
  async uiRun(input: {
    procedure: string;
    params?: Record<string, string>;
  }): Promise<{
    runId: string;
    sessionId: string;
    procedure: string;
    params: Record<string, string>;
  }> {
    // M7-5-d: **화이트리스트**. denylist 는 키가 늘 때마다 구멍이 된다.
    const allowed = new Set(["procedure", "params"]);
    const extra = Object.keys(input).filter((k) => !allowed.has(k));
    if (extra.length > 0) {
      throw pfError("bad_request", `지정할 수 없는 키: ${extra.join(",")} (M7-5-d).`);
    }
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (typeof v !== "string") {
        throw pfError("bad_request", `param ${k}는 문자열이어야 합니다 (M7-5-d).`);
      }
    }
    const ref = String(input.procedure ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ref)) {
      throw pfError("bad_request", "procedure 이름이 올바르지 않습니다.");
    }
    // 등록 여부 + 선언 param 확인 (loadProcedureDoc이 없는 이름을 throw)
    let doc: { name: string; params?: Record<string, unknown> };
    let dir: string;
    try {
      const loaded = loadProcedureDoc(this.procforgeDir, ref);
      doc = loaded.doc as { name: string; params?: Record<string, unknown> };
      dir = loaded.dir;
    } catch (e) {
      throw pfError("bad_request", `등록되지 않은 절차서입니다: ${ref}`);
    }
    const params = input.params ?? {};
    const declared = new Set(Object.keys(doc.params ?? {}));
    const unknownParams = Object.keys(params).filter((k) => !declared.has(k));
    if (unknownParams.length > 0) {
      throw pfError(
        "bad_request",
        `선언되지 않은 param: ${unknownParams.join(",")} (선언됨: ${[...declared].join(",") || "없음"})`,
      );
    }
    const running = this.activeRuns.get(doc.name);
    if (running) {
      throw pfError("conflict", `이미 실행 중입니다 (run ${running}).`);
    }
    // M7-5-b: **재시작 후에도** 대기 중인 실행이 잠금을 쥔다.
    // (메모리 맵만 보면 서버를 다시 켤 때 조용히 사라져 같은 절차서가 두 번 돈다)
    const persisted = this.waitingRunFor(doc.name);
    if (persisted) {
      throw pfError("conflict", `이미 실행 중입니다 (run ${persisted}).`);
    }
    const started = await this.runStart({ procedure: ref, params });
    this.activeRuns.set(doc.name, started.runId);
    appendRunLog(this.procforgeDir, started.runId, {
      level: "info",
      message: `실행 시작: ${started.procedure}`,
    });
    // M7-5-d: 실행 요청도 calls.jsonl 에 남긴다 (누가 무엇을 띄웠는지)
    this.recordUiCall(started.sessionId, "pf_run_start", "");
    // 백그라운드 진행 — UI는 기다리지 않는다(로그·결과는 SSE).
    void this.driveRun(started.runId, doc.name).catch(() => {
      // 오류는 로그로 남는다 (흘러나오면 UI가 조용히 멈춘 것처럼 보인다)
      appendRunLog(this.procforgeDir, started.runId, {
        level: "error",
        message: "실행 진행 중 오류",
      });
    });
    return started;
  }

  /** M7 5-1: 취소 — 플래그 + 자식 프로세스 트리 종료 */
  async uiRunCancel(input: { runId: string }): Promise<{
    runId: string;
    cancelled: boolean;
    killed: number[];
    failed: number[];
  }> {
    const runId = String(input.runId ?? "");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    // M7-5-c: 이미 끝난 실행은 취소해도 상태가 바뀌지 않는다 (한 번 "cancelling" 으로 굳으면
    // 사용자가 언제 끝난 건지 알 수 없게 된다).
    if (st.status === "done" || st.status === "failed") {
      this.recordUiCall(st.sessionId, "pf_run_cancel", "", new Error("이미 끝난 실행"));
      return { runId, cancelled: false, killed: [], failed: [] };
    }
    this.recordUiCall(st.sessionId, "pf_run_cancel", "", undefined);
    const r = await cancelRun(this.procforgeDir, runId, "UI 실행 화면에서 취소");
    // M7-5-b: **대기 중** 취소는 driveRun 이 이미 빠져나갔으므로 그���을 읽을 주체가 없다.
    // 여기서 바로 잠금을 푼다 (안 하면 그 절차서는 409 고착).
    if (this.waitingRuns.has(runId)) {
      const wst = readRunState(this.procforgeDir, runId) as RunState | undefined;
      if (wst?.procedure) this.finishRun(runId, wst.procedure, "info", "대기 중 취소됨");
      if (wst) {
        writeRunState(this.procforgeDir, {
          ...wst,
          status: "cancelled",
          waiting: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    appendRunLog(this.procforgeDir, runId, {
      level: "info",
      message: `취소 요청 (자식 ${r.children.length}개 종료 시도)`,
    });
    return { runId, cancelled: true, killed: r.killed, failed: r.failed };
  }

  /** M7 5-1: 실행 로그 (SSE 증분용) */
  async uiRunLog(input: { runId: string; afterSeq?: number }): Promise<{
    runId: string;
    status: string;
    entries: ReturnType<typeof readRunLog>;
    sessionId: string;
    procedure: string;
  }> {
    const runId = String(input.runId ?? "");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    return {
      runId,
      status: readCancelFlag(this.procforgeDir, runId) ? "cancelling" : st.status,
      entries: readRunLog(this.procforgeDir, runId, input.afterSeq ?? 0),
      sessionId: st.sessionId,
      procedure: st.procedure,
    };
  }

  /** M7 5-1: 백그라운드 진행 루프 (결정점까지 자동) */
  /**
   * M7-5-c: 백그라운드 진행 루프.
   * - `activeRuns` 는 **try/finally** 로 항상 해제한다 (예외로 409 고착 금지).
   * - 승인·생성값 대기는 **잠금을 유지**한다: 같은 절차서를 다시 띄우면
   *   서로 다른 두 실행이 한 절차서를 동시에 굴리게 된다. 승인은 uiApprove 가
   *   이 루프를 재개시킨다.
   * - 취소 플래그는 단계 사이 + 스크립트 실행 **중**에도 본다.
   */
  private async driveRun(runId: string, procedure: string): Promise<void> {
    try {
      for (let i = 0; i < 500; i++) {
        if (readCancelFlag(this.procforgeDir, runId)) {
          this.finishRun(runId, procedure, "info", "취소됨");
          return;
        }
        const step = await this.runStep(runId, { unattended: true });
        if (readCancelFlag(this.procforgeDir, runId)) {
          this.finishRun(runId, procedure, "info", "취소됨");
          return;
        }
        if (step.kind === "done") {
          this.finishRun(
            runId,
            procedure,
            "result",
            `완료: pass ${step.pass} / fail ${step.fail} / blocked ${step.blocked}`,
          );
          return;
        }
        if (step.kind === "failed") {
          this.finishRun(runId, procedure, "error", `실패: ${step.detail}`, step.nodeId);
          return;
        }
        // need_generated / need_approval 은 사람이 결정해야 한다 → 멈추되
        // **잠금은 유지**한다 (같은 절차서 중복 실행 방지).
        appendRunLog(this.procforgeDir, runId, {
          level: "info",
          nodeId: step.nodeId,
          message:
            step.kind === "need_approval"
              ? "승인 대기 — 결정을 기다립니다"
              : "생성값 대기 — 값을 기다립니다",
        });
        this.waitingRuns.add(runId);
        return;
      }
      appendRunLog(this.procforgeDir, runId, {
        level: "error",
        message: "단계 상한 초과로 중단",
      });
    } catch (e) {
      // 예외가 나도 잠금은 풀어야 한다 (아니면 그 절차서는 재시작 불가)
      appendRunLog(this.procforgeDir, runId, {
        level: "error",
        message: `실행 오류: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      if (!this.waitingRuns.has(runId)) this.activeRuns.delete(procedure);
    }
  }

  /** 실행 종료 처리 (로그 + 잠금 해제) */
  private finishRun(
    runId: string,
    procedure: string,
    level: "info" | "error" | "result",
    message: string,
    nodeId?: string,
  ): void {
    appendRunLog(this.procforgeDir, runId, {
      level,
      message,
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
    this.activeRuns.delete(procedure);
    this.waitingRuns.delete(runId);
  }

  /**
   * M7-5-c: 결정(승인·생성값) 뒤 실행 재개.
   * uiApprove / 생성값 제공이 이 경로를 탄다 (이게 없으면 대기에 영박으로 남는다).
   */
  private resumeRunIfWaiting(runId: string, procedure: string): void {
    // M7-5-b: 재개 가능 여부는 **디스크 상태**로 판정한다.
    // (메모리 세트만 보면 재시작 후 승인을 받아도 조용히 실패한다)
    const st = readRunState(this.procforgeDir, runId) as RunState | undefined;
    if (!st) return;
    if (st.status === "done" || st.status === "failed" || st.status === "cancelled") return;
    this.waitingRuns.delete(runId);
    if (readCancelFlag(this.procforgeDir, runId)) {
      this.finishRun(runId, procedure, "info", "취소됨");
      return;
    }
    // 대기 표식을 먼저 지운다 (다시 멈추면 driveRun 이 다시 심는다)
    writeRunState(this.procforgeDir, {
      ...st,
      status: "running",
      waiting: undefined,
      updatedAt: new Date().toISOString(),
    });
    this.activeRuns.set(procedure, runId);
    appendRunLog(this.procforgeDir, runId, {
      level: "info",
      message: "결정 반영 — 실행을 이어갑니다",
    });
    void this.driveRun(runId, procedure).catch(() => {
      /* driveRun 이 스스로 로그/해제를 처리한다 */
    });
  }
  async runStart(a: { procedure: unknown; params?: unknown }): Promise<{
    runId: string;
    sessionId: string;
    procedure: string;
    params: Record<string, string>;
  }> {
    const ref = a.procedure as string;
    if (!ref) throw pfError("bad_request", "procedure가 필요하다.");
    const params = (a.params ?? {}) as Record<string, string>;
    // M6-0: @날짜 param 1회 해석 (run 기록에는 해석값 저장).
    const liveParams = resolveDateParams(params).params;
    const { doc, dir } = loadProcedureDoc(this.procforgeDir, ref);
    // M6.1-2: import도 core 경로 (inprocess 포함 단일 경로).
    // 파일 복사(fixtures·cassettes·scripts)는 로컬 runner용으로 병행.
    const { sessionId } = await this.core.pfImportProcedure({
      doc: doc as never,
      params: liveParams,
    });
    copyImportFiles(this.procforgeDir, doc.name, sessionId);
    const runId = randomUUID();
    writeRunState(this.procforgeDir, {
      version: 1,
      runId,
      sessionId,
      procedure: doc.name,
      procedureDir: dir,
      params: liveParams,
      pending: [],
      done: [],
      supplied: {},
      approved: [],
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
    return { runId, sessionId, procedure: doc.name, params: liveParams };
  }

  /** run 1스텝 진행 (M5, pf_run_next/supply 공용). 결정적 구간 자동 진행. */
  async runStep(runId: string, opts?: { unattended?: boolean }): Promise<
    | {
        kind: "need_generated";
        runId: string;
        sessionId: string;
        nodeId: string;
        instruction: string;
        inputs: Record<string, unknown>;
      }
    | {
        kind: "need_approval";
        runId: string;
        sessionId: string;
        nodeId: string;
        instruction: string;
        approvalHint: string;
      }
    | {
        kind: "done";
        runId: string;
        sessionId: string;
        pass: number;
        fail: number;
        unverified: number;
        skipped: number;
        blocked: number;
        suspended: number;
      }
    | {
        kind: "failed";
        runId: string;
        sessionId: string;
        nodeId: string;
        detail: string;
        hint: string;
      }
  > {
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    if (st.status === "done") {
      return {
        kind: "done",
        runId,
        sessionId: st.sessionId,
        ...(st.summary ?? {
          pass: 0,
          fail: 0,
          unverified: 0,
          skipped: 0,
          blocked: 0,
          suspended: 0,
        }),
      };
    }
    if (st.status === "failed") {
      return {
        kind: "failed",
        runId,
        sessionId: st.sessionId,
        nodeId: st.failedNodeId ?? "",
        detail: st.failedDetail ?? "",
        hint: this.repairHint(st.failedNodeId ?? ""),
      };
    }
    const report = await runSession({
      procforgeDir: this.procforgeDir,
      projectRoot: this.projectRoot,
      sessionId: st.sessionId,
      mode: "live",
      runId,
      procedure: st.procedure,
      procedureDir: (st as { procedureDir?: string }).procedureDir,
      skipNodeIds: st.done,
      supplied: st.supplied,
      approvedNodeIds: st.approved,
      // M6.1-2: 원격 core면 하이드레이트 후 실행.
      core: this.core,
      // M7-5-a: 실제 실행 중인 자식 pid 를 이 run 에 등록한다. 취소는 이 목록의
      // 트리를 죽인다 — 등록이 없으면 취소해도 프로세스가 산다.
      onScriptChild: (pid: number) => {
        registerChild(this.procforgeDir, runId, pid);
      },
      onScriptChildEnd: (pid: number) => {
        unregisterChild(this.procforgeDir, runId, pid);
      },
      // M7-5-a: 실행 **중**에도 취소가 닿는다 (spawnSync 옛에는 불가능)
      isRunCancelled: () => readCancelFlag(this.procforgeDir, runId) !== undefined,
    });
    const doneNow = report.results
      .filter((r) => r.status === "pass")
      .map((r) => r.nodeId);
    const done = [...new Set([...st.done, ...doneNow])];
    const susp = report.results.find((r) => r.status === "suspended");
    const failed = report.results.find((r) => r.status === "fail");
    if (susp) {
      const m = /^need_generated:(.*)$/.exec(susp.detail ?? "");
      const kind = m ? ("need_generated" as const) : ("need_approval" as const);
      const missing = m ? m[1].split(",").filter((s) => s.length > 0) : [];
      const pending = report.results
        .filter(
          (r) =>
            r.status === "suspended" ||
            (r.status === "skipped" && !done.includes(r.nodeId)),
        )
        .map((r) => r.nodeId);
      writeRunState(this.procforgeDir, {
        ...st,
        pending,
        done,
        status: "suspended",
        // M7-5-b: 대기 표식은 **무인 구동**(uiRun)일 때만 남긴다.
        // (runNext 로 한 걸음씩 조종하는 쪽은 호출자가 다음 걸음을 고르기 때문에
        //  여기에 남기면 승인 시 driveRun 과 세션이 서로 잠글 것이다)
        ...(opts?.unattended
          ? { waiting: { nodeId: susp.nodeId, kind, at: new Date().toISOString() } }
          : {}),
        suspended: {
          nodeId: susp.nodeId,
          kind,
          ...(missing.length > 0 ? { missing } : {}),
        },
      });
      const node = await this.core.getNode(st.sessionId, susp.nodeId);
      if (kind === "need_generated") {
        const inputs: Record<string, unknown> = {};
        for (const k of missing) {
          const spec = (node.args ?? {})[k] as
            | { instruction?: string; inputs?: unknown; constraints?: unknown }
            | undefined;
          inputs[k] = {
            ...(spec?.instruction !== undefined
              ? { instruction: spec.instruction }
              : {}),
          };
        }
        return {
          kind,
          runId,
          sessionId: st.sessionId,
          nodeId: susp.nodeId,
          instruction: `노드 ${susp.nodeId}에 생성값이 필요하다 (${missing.join(", ")}). pf_run_supply(runId, nodeId, value)로 제공하라.`,
          inputs,
        };
      }
      return {
        kind,
        runId,
        sessionId: st.sessionId,
        nodeId: susp.nodeId,
        instruction: `노드 ${susp.nodeId}는 external 부작용이라 승인이 필요하다.`,
        approvalHint: `procforge approve ${runId} ${susp.nodeId} 또는 pf_run_supply(runId, nodeId, true) 후 pf_run_next(runId).`,
      };
    }
    if (failed) {
      const pending = report.results
        .filter((r) => r.status !== "pass" && !done.includes(r.nodeId))
        .map((r) => r.nodeId);
      writeRunState(this.procforgeDir, {
        ...st,
        pending,
        done,
        status: "failed",
        failedNodeId: failed.nodeId,
        failedDetail: failed.detail ?? "",
        summary: report.summary,
      });
      return {
        kind: "failed",
        runId,
        sessionId: st.sessionId,
        nodeId: failed.nodeId,
        detail: failed.detail ?? "",
        hint: this.repairHint(failed.nodeId),
      };
    }
    writeRunState(this.procforgeDir, {
      ...st,
      pending: [],
      done,
      status: "done",
      summary: report.summary,
    });
    return { kind: "done", runId, sessionId: st.sessionId, ...report.summary };
  }

  private repairHint(nodeId: string): string {
    return `노드 ${nodeId} 수정: pf_tree 확인 후 pf_reopen → pf_edit_args 등으로 수정 → pf_confirm_leaf로 재확정.`;
  }

  /** run 다음 단계 (M5, MCP pf_run_next) */
  async runNext(a: {
    runId: unknown;
  }): Promise<Awaited<ReturnType<ProcForgeApp["runStep"]>>> {
    const runId = a.runId as string;
    if (!runId) throw pfError("bad_request", "runId가 필요하다.");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    if (st.status === "suspended" && st.suspended) {
      // 대기 중이면 재실행 없이 현재 대기 반환
      const node = await this.core.getNode(st.sessionId, st.suspended.nodeId);
      if (st.suspended.kind === "need_generated") {
        const missing = st.suspended.missing ?? [];
        const inputs: Record<string, unknown> = {};
        for (const k of missing) {
          const spec = (node.args ?? {})[k] as
            { instruction?: string } | undefined;
          inputs[k] = {
            ...(spec?.instruction !== undefined
              ? { instruction: spec.instruction }
              : {}),
          };
        }
        return {
          kind: "need_generated",
          runId,
          sessionId: st.sessionId,
          nodeId: st.suspended.nodeId,
          instruction: `노드 ${st.suspended.nodeId}에 생성값이 필요하다 (${missing.join(", ")}). pf_run_supply(runId, nodeId, value)로 제공하라.`,
          inputs,
        };
      }
      return {
        kind: "need_approval",
        runId,
        sessionId: st.sessionId,
        nodeId: st.suspended.nodeId,
        instruction: `노드 ${st.suspended.nodeId}는 external 부작용이라 승인이 필요하다.`,
        approvalHint: `procforge approve ${runId} ${st.suspended.nodeId} 또는 pf_run_supply(runId, nodeId, true) 후 pf_run_next(runId).`,
      };
    }
    return this.runStep(runId);
  }

  /** 생성값 공급·승인 후 자동 진행 (M5, MCP pf_run_supply) */
  async runSupply(a: {
    runId: unknown;
    nodeId: unknown;
    value: unknown;
  }): Promise<Awaited<ReturnType<ProcForgeApp["runStep"]>>> {
    const runId = a.runId as string;
    const nodeId = a.nodeId as string;
    if (!runId || !nodeId)
      throw pfError("bad_request", "runId·nodeId가 필요하다.");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    if (st.status === "done" || st.status === "failed") {
      throw pfError("bad_request", `run 이미 종료: ${st.status}`);
    }
    if (!st.suspended || st.suspended.nodeId !== nodeId) {
      throw pfError(
        "bad_request",
        `대기 중인 노드가 아님: ${nodeId}. pf_run_next로 먼저 진행하라.`,
      );
    }
    if (st.suspended.kind === "need_approval") {
      if (a.value !== true)
        throw pfError("bad_request", "승인은 value=true로 한다.");
      const approved = [...new Set([...st.approved, nodeId])];
      writeRunState(this.procforgeDir, {
        ...st,
        approved,
        suspended: undefined,
        status: "ready",
      });
      return this.runStep(runId);
    }
    const missing = st.suspended.missing ?? [];
    let patch: Record<string, unknown>;
    if (
      missing.length === 1 &&
      (typeof a.value !== "object" || a.value === null)
    ) {
      patch = { [missing[0]]: a.value };
    } else if (typeof a.value === "object" && a.value !== null) {
      const given = a.value as Record<string, unknown>;
      const absent = missing.filter((k) => !(k in given));
      if (absent.length > 0)
        throw pfError("bad_request", `생성값 부족: ${absent.join(", ")}`);
      patch = { ...given };
    } else {
      throw pfError(
        "bad_request",
        `생성값 부족: ${missing.join(", ")} (객체로 제공)`,
      );
    }
    const supplied = {
      ...st.supplied,
      [nodeId]: { ...(st.supplied[nodeId] ?? {}), ...patch },
    };
    writeRunState(this.procforgeDir, {
      ...st,
      supplied,
      suspended: undefined,
      status: "ready",
    });
    return this.runStep(runId);
  }

  /** run external 승인 (M5, CLI 전용) */
async runApprove(a: {
    runId: unknown;
    nodeId: unknown;
    /** M7-5-b: false 면 **거부** — 대기를 끝내고 잠금을 푼다 */
    approved?: unknown;
  }): Promise<{ runId: string; nodeId: string; approved: boolean }> {
    const runId = a.runId as string;
    const nodeId = a.nodeId as string;
    if (!runId || !nodeId)
      throw pfError("bad_request", "runId와nodeId가 필요합니다.");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    if (!st.pending.includes(nodeId))
      throw pfError("bad_request", `이 실행에서 대기 중이던 노드가 아닙니다: ${nodeId}`);
    const approvedFlag = a.approved !== false;
    if (!approvedFlag) {
      // M7-5-b: 거부를 "대기 유지"로 두면 그 절차서가 409 고착이다 → **끝낸다**.
      writeRunState(this.procforgeDir, {
        ...st,
        suspended: undefined,
        waiting: undefined,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      });
      this.finishRun(runId, st.procedure, "info", "승인 거부 — 실행 종료", nodeId);
      this.activeRuns.delete(st.procedure);
      this.waitingRuns.delete(runId);
      return { runId, nodeId, approved: false };
    }
    const approved = [...new Set([...st.approved, nodeId])];
    writeRunState(this.procforgeDir, {
      ...st,
      approved,
      suspended: undefined,
      waiting: undefined,
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
    // M7-5-b: 승인만 기록하고 멈춰두면 실행이 그대로 얼어붙는다 → **이어서 돌린다**.
    // 단, uiRun 으로 떠서 driveRun 이主導이던 실행만 해당한다.
    // (runStart/runNext 로 한 걸음씩 조종하는 쪽은 호출자가 다음 걸음을irn다 —
    //  여기서까지 대신 굴리면 세션 잠선이 충돌한다)
    if (st.waiting) this.resumeRunIfWaiting(runId, st.procedure);
    return { runId, nodeId, approved: true };
  }

  /** 절차서 노드 사전 승인 항목 생성 (M5.5-4.1-3, CLI approve 절차서 모드). */
  async approveProcedureNode(a: {
    procedure: unknown;
    nodeId: unknown;
    allowWildcard?: unknown;
  }): Promise<{
    procedureDir: string;
    path: string;
    nodeId: string;
    hash: string;
    replaced: boolean;
    args: Record<string, unknown>;
    warnings: string[];
  }> {
    const procRef = a.procedure as string;
    const nodeId = a.nodeId as string;
    if (!procRef) throw pfError("bad_request", "procedure가 필요하다.");
    if (!nodeId) throw pfError("bad_request", "node가 필요하다 (--node <id>).");
    const allowWildcard = Array.isArray(a.allowWildcard)
      ? (a.allowWildcard as string[])
      : [];
    const { doc, dir } = loadProcedureDoc(this.procforgeDir, procRef);
    const n = doc.nodes.find((x) => x.id === nodeId);
    if (!n) throw pfError("not_found", `노드 없음: ${nodeId} (${procRef})`);
    // M5.5-4.4-5: toHashable 단일 변환 (캐스팅 없음).
    const docById = new Map(doc.nodes.map((x) => [x.id, toHashable(x)]));
    const entry = buildApprovalEntry(
      {
        id: n.id,
        goal: n.goal,
        tool: n.tool,
        args: n.args,
        constraints: n.constraints,
        sideEffect: n.sideEffect,
        map: n.map,
        until: n.until,
      },
      allowWildcard,
      docById,
      (rel: string) => {
        try {
          return readFileSync(join(dir, rel), "utf8");
        } catch {
          return undefined;
        }
      },
    );
    const { path, replaced } = saveApproval(dir, entry);
    // M5.6.1-4: 범위 경고를 함께 반환 (CLI 출력).
    const scope = scopeWarnings({
      id: n.id,
      args: n.args as Record<string, unknown> | undefined,
    });
    return {
      procedureDir: dir,
      path,
      nodeId,
      hash: entry.node.hash,
      replaced,
      args: entry.args ?? {},
      warnings: scope,
    };
  }

  /** 절차서 live 일괄 실행 (M5, CLI run용). 일시정지면 suspended 포함 반환. */
  async runProcedure(a: {
    procedure: unknown;
    params?: unknown;
    out?: unknown;
    force?: unknown;
    allowBash?: unknown;
    allowProjectRead?: unknown;
    unattended?: unknown;
    toolRetry?: unknown;
    allowUnverified?: unknown;
  }): Promise<{
    runId: string;
    sessionId: string;
    mode: "live";
    passed: number;
    failed: number;
    unverified: number;
    skipped: number;
    blocked: number;
    suspended: number;
    approvalBlocked: boolean;
    reportPath: string;
    outDir?: string;
  }> {
    const procRef = a.procedure as string;
    if (!procRef) throw pfError("bad_request", "procedure가 필요하다.");
    const params = (a.params ?? {}) as Record<string, string>;
    const unattended = a.unattended === true;
    // M5.7-2: 무인 기본 on. M5.7.1: --allow-unverified 단일화 (runner가 unattended와 조합해 판단).
    const { report, sessionId } = await runProcedureTest(
      this.procforgeDir,
      this.projectRoot,
      procRef,
      {
        procforgeDir: this.procforgeDir,
        projectRoot: this.projectRoot,
        mode: "live",
        params,
        updateGolden: false,
        allowBash: a.allowBash === true,
        allowProjectRead: a.allowProjectRead === true,
        unattended,
        ...((a.toolRetry as { attempts?: number; baseMs?: number } | undefined)
          ? { toolRetry: a.toolRetry as { attempts?: number; baseMs?: number } }
          : {}),
        allowUnverified: a.allowUnverified === true,
      },
    );
    let outDir: string | undefined;
    const outOpt = a.out as string | undefined;
    if (outOpt !== undefined && outOpt !== "") {
      outDir = assertProjectPath(this.projectRoot, outOpt);
      copyRunFsToOut(this.procforgeDir, report.runId, outDir, a.force === true);
    }
    return {
      runId: report.runId,
      sessionId,
      mode: "live",
      passed: report.summary.pass,
      failed: report.summary.fail,
      unverified: report.summary.unverified,
      skipped: report.summary.skipped,
      blocked: report.summary.blocked,
      suspended: report.summary.suspended,
      approvalBlocked: report.results.some((r) =>
        r.failedConstraints.includes("approval"),
      ),
      reportPath: join(this.procforgeDir, "runs", report.runId, "report.json"),
      ...(outDir ? { outDir } : {}),
    };
  }
}
