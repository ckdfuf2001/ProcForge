import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import type { CoreClient } from "@proof/shared/core-client.js";
import type { Actor } from "@proof/shared/dto.js";
import { pfError } from "@proof/shared/errors.js";
import { readEnvPair } from "@proof/shared/env-compat.js";
import { collectCatalog } from "../catalog.js";
import { FileStore } from "../filestore.js";
import { constraintSummary, nodeSummary, retriesLeft } from "../views.js";
import type { NodeSummary, OUTPUT_SCHEMAS } from "../views.js";
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
} from "@proof/shared/dto.js";

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
import { discoverPairing, discoveryDegraded } from "../services/pair-discovery.js";
import type { SignalWatchOutcome } from "../services/opencode-link.js";
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
  commitApproval,
  saveApproval,
  scopeWarnings,
  toHashable,
} from "../services/approvals.js";
import { copyImportFiles } from "../procedure.js";
import {
  readGuide,
  writeGuide,
  nextStepIndex,
  newGuideId,
  assertGuideId,
  touchGuide,
  guidePath,
  type GuideFile,
  type GuideStepState,
} from "../services/guide.js";
import { loadAccumulateFromProcedure } from "../services/accumulate.js";
import { resolveDateParams } from "../services/date-params.js";
import { runnableTools } from "../services/runnable-tools.js";
import {
  buildRefOutputs,
  checkProbingArgs,
  type RefNodeInfo,
  type RefVerdict,
} from "../services/ref-check.js";
import { varRefNodeIds } from "@proof/shared/deps.js";
import { varRefNodeId } from "@proof/shared/args-schema.js";
import { resolveRefValue } from "@proof/shared/validator.js";
import {
  readRunState,
  readRunStateBySession,
  writeRunState,
  type RunState,
} from "../services/run-state.js";
import {
  listProceduresWithLatest,
  filterProcedures,
  type SimilarProcedure,
} from "../services/similar.js";
import {
  runRedraft,
  openCodeAuthHeaders,
  type RedraftResult,
  type DraftOp,
} from "../services/redraft.js";
import { PROCEDURE_NAME_RE } from "@proof/shared/procedure.js";
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
import { writeProcedure, writeFileAtomic } from "../services/procedureWriter.js";

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
  "9. pf_split의 각 하위 노드에 why(왜 이렇게 나눴는지 1줄)를 쓴다.",
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
  /** M10-3-ui: 그래프 카드용 분해 사유 1줄 (없으면 null) */
  why: string | null;
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
  /** M10-3-ui: 분해 사유 1줄 (없으면 null) */
  why: string | null;
  /** M8-1-0: 자기 재검증 대기 사유 (확정 후 hash 변경) */
  reverifySince: {
    revision: number;
    causeNodeId: string;
    cause: "advise" | "edit_args" | "edit_node";
  } | null;
  hash: string;
  tool: { server: string; name: string } | null;
  args: Record<string, unknown>;
  map: unknown;
  until: unknown;
  dependsOn: string[];
  constraints: import("@proof/shared/schema.js").Constraint[];
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
  /**
   * 테스트 전용: 대기 상태가 디스크에 기록된 직후, waitingRuns 캐시 등록 전에
   * 호출된다. 이 구간의 취소 경쟁을 결정적으로 재현하기 위한 훅이다.
   */
  onWaitingPersisted?: (runId: string, procedure: string) => void | Promise<void>;
};

/** M7-ui4-b/c: 신호 대상 (서버 설정에서만 온다) */
export type SignalTarget = {
  baseUrl: string;
  mode: LinkMode;
  /**
   * M8-1: 신호 문구에 쓸 **도구 이름 접두어** (예: "procforge" → procforge_pf_next).
   * 모델이 보는 도구 이름은 OpenCode 의 MCP 등록 키로 정해지므로 서버 설정에서 받는다.
   * 비우면 접두어 없이 "ProcForge의 pf_next 도구" 로 쓴다.
   */
  toolPrefix?: string;
  timeoutMs?: number;
  serverVersion?: string;
};

/** M8-1 c: 도구 접두어 형식 (위반은 무시 + 경고 로그 — 기동을 죽이지 않는다) */
const TOOL_PREFIX_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** M8-1: 신호 문구 길이 상한 */
export const SIGNAL_TEXT_MAX = 500;

/**
 * M8-1: **신호 문구 함수 하나.**
 * B(전송 text)와 C(copyText)가 같은 문자열을 쓴다 — 붙여넣은 문구를 모델이 그대로 읽는다.
 * 의견 본문은 넣지 않는다(모델은 pf_next 로 읽는다).
 */
export function signalText(input: {
  sessionId: string;
  nodeId: string;
  /** 도구 이름 접두어 (예: "procforge"). 모르면 생략 */
  toolPrefix?: string;
}): string {
  const sid = input.sessionId;
  const nid = input.nodeId;
  const prefix = (input.toolPrefix ?? "").trim().replace(/_+$/, "");
  const toolRef = prefix
    ? `${prefix}_pf_next({sessionId:"${sid}"})`
    : "Proof의 pf_next 도구";
  const text =
    `Proof 세션 ${sid}의 노드 ${nid}에 사람 의견이 추가됐습니다. ` +
    `새 세션을 만들지 말고(pf_start 금지) ${toolRef}로 이어서 진행하세요.`;
  return text.length > SIGNAL_TEXT_MAX
    ? text.slice(0, SIGNAL_TEXT_MAX)
    : text;
}

export class ProcForgeApp {
  private core: CoreClient;
  private procforgeDir: string;
  private projectRoot: string;
  private sessionTtlMs: number | undefined;
  private strictSandbox: boolean;
  private maxArtifactBytes: number;
  private catalogTimeoutMs: number | undefined;
  private linkFetchImpl: typeof fetch | undefined;
  private onWaitingPersisted: AppDeps["onWaitingPersisted"];
  /** M7-ui4: UI 연결 id (호출 귀속 기록용. 연결마다 1개) */
  private readonly uiConnectionId = `ui-${randomUUID()}`;
  private readonly signal: SignalTarget;
  /** M7 5-1: 실행 중 절차서 → runId (동시 1개 강제). 취소되면 반납. */
  private activeRuns = new Map<string, string>();
  /** M8-1-close2 b: 신호 감시 결과 배지 갱신 (UI 서버가 주입. 없으면 기록만) */
  private signalNotifier: ((sessionId: string, payload: unknown) => void) | undefined;
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
    this.onWaitingPersisted = deps.onWaitingPersisted;
    // M7-ui4-b: 신호 대상은 여기서 한 번만 정한다.
    // M9-1-1: PROOF_OPENCODE_* 우선, PROCFORGE_OPENCODE_* 대체.
    const toolPrefix =
      deps.signal?.toolPrefix ?? readEnvPair(process.env as Record<string, string | undefined>, "PROOF_OPENCODE_TOOL_PREFIX", "PROCFORGE_OPENCODE_TOOL_PREFIX");
    // M8-1 c: 형식 검증 — 위반이면 무시 + 경고 (기동은 계속한다).
    const validPrefix =
      toolPrefix !== undefined && TOOL_PREFIX_RE.test(toolPrefix)
        ? toolPrefix
        : undefined;
    if (toolPrefix !== undefined && validPrefix === undefined) {
      logger.warn("toolPrefix 형식 위반 — 무시 (A-Za-z0-9_- 1~40자)", {
        length: toolPrefix.length,
      });
    }
    this.signal = {
      baseUrl: deps.signal?.baseUrl ?? readEnvPair(process.env as Record<string, string | undefined>, "PROOF_OPENCODE_URL", "PROCFORGE_OPENCODE_URL") ?? "",
      mode: (deps.signal?.mode ??
        (readEnvPair(process.env as Record<string, string | undefined>, "PROOF_OPENCODE_MODE", "PROCFORGE_OPENCODE_MODE") as LinkMode | undefined) ??
        "b") as LinkMode,
      toolPrefix: validPrefix,
      timeoutMs: deps.signal?.timeoutMs,
      serverVersion: deps.signal?.serverVersion,
    };
  }

  /** M8-1-close2 b: 신호 감시 결과 배지 갱신 주입 (cli ui 기동 시 연결) */
  setSignalNotifier(fn: (sessionId: string, payload: unknown) => void): void {
    this.signalNotifier = fn;
  }

  /**
   * M8-1-close2 b: delivered 뒤 감시 결과를 signals.jsonl에 남기고 SSE로 민다.
   * 기록 실패는 신호 결과에 영향을 주지 않는다 (best-effort).
   */
  recordSignalWatch(
    sessionId: string,
    nodeId: string,
    outcome: SignalWatchOutcome,
  ): void {
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        sessionId,
        nodeId,
        openCodeSessionId: outcome.openCodeSessionId,
        kind: outcome.kind,
        ...(outcome.text !== undefined ? { text: outcome.text } : {}),
      }) + "\n";
    try {
      const dir = join(this.procforgeDir, "sessions", sessionId);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "signals.jsonl"), line, "utf8");
    } catch {
      // 기록 실패 무시
    }
    try {
      this.signalNotifier?.(sessionId, {
        ...JSON.parse(line),
        type: "signal-watch",
      });
    } catch {
      // 배지 갱신 실패 무시
    }
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
    let treeCache: import("@proof/shared/schema.js").Node[] | undefined;
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
        import("@proof/shared/schema.js").ArgSpec
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
      let treeCacheC: import("@proof/shared/schema.js").Node[] | undefined;
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
    // M8-ui1: 분해 사유는 필수 — 사람이 읽고 의견을 준다.
    const reason = typeof a.reason === "string" ? a.reason.trim() : "";
    if (reason.length < 10)
      throw pfError(
        "bad_request",
        `reason이 없다(또는 너무 짧다): ${reason.length}자.`,
        "왜 이렇게 나눴는지 10자 이상으로 적어라. 버린 대안은 alternatives에 (최대 3개).",
      );
    if (reason.length > 1000)
      throw pfError(
        "bad_request",
        `reason이 너무 길다: ${reason.length}자.`,
        "1000자 이내로 줄여라.",
      );
    const alternatives = ((a.alternatives ?? []) as string[])
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (alternatives.length > 3)
      throw pfError(
        "bad_request",
        `alternatives가 너무 많다: ${alternatives.length}개.`,
        "버린 대안은 최대 3개만 적어라.",
      );
    for (const alt of alternatives)
      if (alt.length > 300)
        throw pfError(
          "bad_request",
          "alternatives 항목이 너무 길다.",
          "대안 설명은 300자 이내로 줄여라.",
        );
    const out = await this.core.pfResolve({
      sessionId: sid,
      nodeId: a.nodeId as string,
      decision: "split",
      children: kids,
      reason,
      ...(alternatives.length > 0 ? { alternatives } : {}),
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
    // M7-5-e: MCP 승인도 UI 와 **같은** 승인 기록(스냅샷 포함)을 남긴다.
    // (여기를 빠지면 모델이 승인한 스크립트는 diff 가 영원히 null 이다)
    this.persistSessionApproval(sid, a.nodeId as string, out.node as never);
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  /** M10-why-2: 분해 사유 수정 (의견 경로와 같은 취급, MCP 도구는 만들지 않는다). */
  async editWhy(a: {
    sessionId: string;
    nodeId: string;
    why: string;
    expectedRevision?: number;
  }): Promise<{
    node: NodeSummary;
    revision: number;
    changedNodeIds: string[];
  }> {
    const sid = a.sessionId as string;
    const s = await this.core.getSession(sid);
    const out = await this.core.pfEditWhy({
      sessionId: sid,
      nodeId: a.nodeId as string,
      why: a.why as string,
      expectedRevision: a.expectedRevision as number | undefined,
      actor: "host",
    });
    return {
      node: nodeSummary(out.node, s.limits),
      revision: out.revision,
      changedNodeIds: out.changedNodeIds,
    };
  }

  /**
   * M10-3-events: 세션 알림 이벤트 기록 (lane/memory/draft).
   * 상태 변경 없음 — revision만 +1. UI는 세션 events 폴링/SSE로 수신한다.
   * 레인 실측정 송출은 M10-4(순차 자동 실행)에서 연결한다.
   */
  async notifySessionEvent(a: {
    sessionId: string;
    method: "lane.started" | "lane.finished" | "memory.loaded" | "draft.ready";
    summary: string;
    nodeIds?: string[];
    reason?: string;
    expectedRevision?: number;
    actor?: "host" | "human" | "runner" | "ui";
  }): Promise<{ revision: number; changedNodeIds: string[] }> {
    const sid = String(a.sessionId ?? "");
    if (sid.length === 0) throw pfError("bad_request", "sessionId 필수");
    const allowed = new Set([
      "lane.started",
      "lane.finished",
      "memory.loaded",
      "draft.ready",
    ]);
    if (!allowed.has(a.method)) {
      throw pfError("bad_request", `알 수 없는 알림: ${String(a.method)}`);
    }
    const summary = String(a.summary ?? "").trim();
    if (summary.length === 0) throw pfError("bad_request", "알림 요약(summary) 필수");
    return this.core.pfNotify({
      sessionId: sid,
      method: a.method,
      summary,
      ...(a.nodeIds !== undefined ? { nodeIds: a.nodeIds } : {}),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.expectedRevision !== undefined
        ? { expectedRevision: a.expectedRevision }
        : {}),
      actor: a.actor ?? "ui",
    });
  }

  /** 세션(절차서) 컨텍스트가 있으면 승인 + 스냅샷을 공통 경로로 남긴다 */
  private persistSessionApproval(
    sessionId: string,
    nodeId: string,
    node: Parameters<typeof buildApprovalEntry>[0],
  ): void {
    const st = readRunStateBySession(this.procforgeDir, sessionId);
    if (!st?.procedureDir) return;
    const sessionRoot = join(this.procforgeDir, "sessions", sessionId);
    const readScript = (rel: string): string | undefined => {
      try {
        return readSandboxed(sessionRoot, rel);
      } catch {
        return undefined;
      }
    };
    try {
      const accumulate = loadAccumulateFromProcedure(st.procedureDir);
      const entry = buildApprovalEntry(
        node,
        [],
        new Map(),
        readScript,
        accumulate,
      );
      const spec = (node as { args?: Record<string, { kind?: string; file?: string }> }).args
        ?.script;
      const content = spec?.file ? readScript(spec.file) : undefined;
      commitApproval(
        st.procedureDir,
        entry,
        spec?.file && content !== undefined
          ? { nodeId, rel: spec.file, content }
          : undefined,
      );
    } catch (e) {
      // 승인은 이미 core 에 반영됐으므로 여기서 터뜨리지 않는다 (경고만 남긴다)
      logger.warn("승인 기록 저장 실패(무시)", { sessionId, nodeId, err: String(e) });
    }
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
  }): Promise<{ events: import("@proof/shared/dto.js").EventEntry[]; lastRevision: number }> {
    return this.core.getEventsPage(input);
  }

  /** M8-ui2: 분해 라운드 이력 (읽기 전용. touch 없음) */
  async getDecompositionHistory(input: {
    sessionId: string;
  }): Promise<import("@proof/shared/dto.js").DecompositionHistoryEntry[]> {
    return this.core.getDecompositionHistory(input);
  }

  /** M8-ui2: 특정 revision 시점 트리 (읽기 전용. touch 없음) */
  async getTreeAt(input: {
    sessionId: string;
    revision: number;
  }): Promise<import("@proof/shared/dto.js").TreeAtOutput> {
    return this.core.getTreeAt(input);
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
      // M10-3-ui: 노드 상세 "왜" 읽기용 (없으면 null).
      why: typeof node.why === "string" && node.why.length > 0 ? node.why : null,
      reverifySince: node.reverifySince ?? null,
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
        // M10-3-ui: 그래프 카드 1줄 (Node에 why가 있으면 그대로).
        why:
          typeof e.node?.why === "string" && e.node.why.length > 0
            ? e.node.why
            : null,
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
    blocked: import("@proof/shared/core-client.js").BlockedEntry[];
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
   * M8-1: 문구는 서버가 만든다(signalText) — 클라이언트는 정하지 못한다.
   * M8-1: 짝 유효성 ①생존 확인 ②역방향 짝 ③양방향 일치 때만 전송.
   */
  async signalOnly(input: {
    sessionId: string;
    /** M8-1: 문구에 들어갈 노드 id (누가的意见인지 모델이 알아야 한다) */
    nodeId: string;
    /** 미지정 시 이 세션의 최신 짝짓기를 쓴다 (UI는 클라이언트가 못 고른다) */
    openCodeSessionId?: string;
  }): Promise<LinkResult> {
    const sid = input.sessionId;
    const cfg = this.signal;
    let openSid = input.openCodeSessionId ?? this.latestPairingSessionId(sid);
    // M8-1: B(전송)와 C(복사)는 **같은 문구**다.
    const text = signalText({
      sessionId: sid,
      nodeId: input.nodeId,
      toolPrefix: cfg.toolPrefix,
    });
    // M8-1: 문구 우선순위 — 1 미설정 → 2 짝 없음 → 3 짝 세션 없음 →
    // 4 다른 세션과 짝 → 5 전송 실패
    const notSent = (reason: string): LinkResult => ({
      delivered: false,
      degraded: `${reason}. 전송하지 않음`,
      copyText: text,
    });
    if (!cfg.baseUrl) return notSent("OpenCode 주소 미설정");
    // M8-1-pair: 짝이 없을 때만 첫 짝 찾기 (사양 b2). 복사 전용(c)은 보내지 않으므로 찾지 않는다.
    // 판정이 막히면 자동 전송하지 않는다 (0개·2개 이상·확인 불가).
    if (!openSid && cfg.mode !== "c") {
      // M8-1-pair 보정 b: PF 생성 시각보다 이전에 갱신된 OpenCode 세션은 건너뛴다
      let pfCreatedAt: number | undefined;
      try {
        const s = (await this.core.getSession(sid)) as { createdAt?: unknown };
        const t = typeof s.createdAt === "string" ? Date.parse(s.createdAt) : NaN;
        if (!Number.isNaN(t)) pfCreatedAt = t;
      } catch {
        // 시각을 모르면 건너뛰기 없이 찾는다 (더 많이 읽는다)
      }
      const found = await discoverPairing({
        baseUrl: cfg.baseUrl,
        pfSessionId: sid,
        toolPrefix: cfg.toolPrefix,
        pfCreatedAt,
        fetchImpl: this.linkFetchImpl,
      });
      const degraded = discoveryDegraded(found);
      if (degraded !== undefined) return notSent(degraded);
      if (found.status === "found") {
        openSid = found.openCodeSessionId;
        savePairing(this.procforgeDir, openSid, sid, "discovered");
      }
    }
    if (!openSid) return notSent("OpenCode 세션 짝이 없음");
    // M8-1 ②(로컬 먼저): 역방향 — 그 ocId 의 최신 짝이 다른 PF 세션이면
    // 네트워크 조회 전에 보내지 않는다.
    const pair = getPairing(this.procforgeDir, openSid);
    const mismatch = pair !== undefined && pair.pfSessionId !== sid;
    // M8-1 ①: 짝 세션이 OpenCode 서버에 살아 있는지 확인한다(없으면 미전송).
    // ②가 어긋났어도 생존 확인을 먼저 해서, 문구 우선순위('짝 세션 없음'이
    // '다른 세션과 짝'보다 앞)를 유지한다.
    if (cfg.mode !== "c" && !(await this.openCodeSessionAlive(openSid))) {
      return notSent("짝 세션 없음");
    }
    if (mismatch) {
      return notSent(`다른 세션과 짝(${pair!.pfSessionId})`);
    }
    // M7-ui4-i: 버전은 서버 설정 또는 OpenCode 서버 조회값만 (default-deny 유지)
    const serverVersion =
      cfg.serverVersion ??
      (await fetchServerVersion(cfg.baseUrl, { fetchImpl: this.linkFetchImpl }));
    const http = httpLinkDeps(cfg.baseUrl, this.linkFetchImpl);
    return sendContinue({
      baseUrl: cfg.baseUrl,
      openCodeSessionId: openSid,
      text,
      // M8-1 a2:pf_next/pf_report 입력 sessionId 비교용
      pfSessionId: sid,
      mode: cfg.mode,
      timeoutMs: clampTimeoutMs(cfg.timeoutMs),
      serverVersion,
      deps: {
        fetchImpl: this.linkFetchImpl,
        ...http,
        onPairing: (osid, pfSid) => {
          // M8-1-pair: 같은 짝이면 다시 쓰지 않는다 (찾기로 저장한 source 를 지우지 않는다)
          if (getPairing(this.procforgeDir, osid)?.pfSessionId === pfSid) return;
          savePairing(this.procforgeDir, osid, pfSid);
        },
        // M8-1-close2 b: 감시 결과 기록·배지 (nodeId는 이 신호 대상).
        onSignalWatch: (outcome) =>
          this.recordSignalWatch(sid, input.nodeId, outcome),
      },
    });
  }

  /**
   * M8-1 ①: OpenCode 서버에 그 세션이 살아 있는지 확인한다 (GET /session/:id).
   * 404 = 그 세션이 없다 → 미전송. 그 밖의 실패(네트워크·5xx·**응답 없음**)는
   * "모름"으로 보고 전송을 막지 않는다(가짜 경고로 신호를 죽이지 않는다).
   * 응답이 없는 서버에 매달리지 않게 3초 상한(AbortSignal.timeout)을 둔다.
   */
  private openCodeSessionAlive(ocSid: string): Promise<boolean> {
    const base = this.signal.baseUrl.replace(/\/$/, "");
    const doFetch = this.linkFetchImpl ?? fetch;
    const url = `${base}/session/${encodeURIComponent(ocSid)}`;
    return doFetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => r.status !== 404)
      .catch(() => true);
  }

  /** 이 세션에 짝지어진 OpenCode 세션 중 가장 최근 것 */
  private latestPairingSessionId(sessionId: string): string | undefined {
    const all = loadPairings(this.procforgeDir);
    // map(ocId별 최신) + history(과거 짝) 를 함께 본다 — ocId 의 짝이 다른
    // PF 세션으로 바뀌면 map 에서 이 세션의 짝이 사라지므로 history 가 필요하다.
    const entries = [...Object.values(all.pairs), ...all.history].filter(
      (p) => p.pfSessionId === sessionId,
    );
    entries.sort((a, b) => (a.at < b.at ? 1 : -1));
    return entries[0]?.openCodeSessionId;
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
    // M8-1: 신호 문구는 **서버가 만든다**(세션·노드가 있어야 문구가 성립한다).
    // 타입에서 빠졌지만 JS 클라이언트가 보낼 수 있으므로 런타임에서도 막는다.
    if ((link as { text?: unknown }).text !== undefined) {
      throw pfError(
        "bad_request",
        "link.text는 서버 설정에서만 결정됩니다 (M8-1 — 신호 문구는 서버가 만듭니다).",
      );
    }
    const advised = await this.advise(a);
    // M7-ui4-i: 버전·타임아웃은 위에서 400 처리했으므로 여기서 넘기지 않는다.
    const signal = await this.signalOnly({
      sessionId: a.sessionId as string,
      nodeId: a.nodeId as string,
      openCodeSessionId: link.openCodeSessionId,
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
      /** M8-1: 저장하려는 의견 본문 */
      advice?: string;
    };
  }): Promise<{
    wouldStale: string[];
    newHash: string;
    revision: number;
    selfReverify: boolean;
    /** M8-1: 이 노드를 포함한 이 세션의 확정 절차서 이름 (없으면 생략) */
    procedure?: string;
  }> {
    const out = await this.core.previewEdit(input as never);
    const procedure = this.procedureForNode(input.sessionId, input.nodeId);
    return procedure !== undefined ? { ...out, procedure } : out;
  }

  /**
   * M8-1: 이 세션의 가장 최근 확정 절차서 중 이 노드를 포함한 것의 이름.
   * 절차서가 없거나 노드가 없으면 undefined. (무인 실행이 이 노드를 쓴다는 근거)
   */
  private procedureForNode(sessionId: string, nodeId: string): string | undefined {
    const st = readRunStateBySession(this.procforgeDir, sessionId);
    if (!st?.procedureDir) return undefined;
    try {
      const name = basename(st.procedureDir);
      const { doc } = loadProcedureDoc(this.procforgeDir, name);
      return doc.nodes.some((n) => n.id === nodeId) ? name : undefined;
    } catch {
      return undefined;
    }
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
    const signal = await this.signalOnly({ sessionId: sid, nodeId: input.nodeId });
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
    note?: string,
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
      ...(note !== undefined && note !== "" ? { note } : {}),
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
          | Record<string, import("@proof/shared/schema.js").ArgSpec>
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
        import("@proof/shared/schema.js").Constraint[] | undefined,
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
        // M8-1-0 보정: 재검증 대기 노드 수 (실행 안 함)
        needsReverify: report.summary.needsReverify,
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
      // M8-1-0 보정: 재검증 대기 노드 수 (실행 안 함)
      needsReverify: report.summary.needsReverify,
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
    // M8-1-0: 자기 재검증 대기(needs_reverify) 노드가 있으면 확정 금지.
    const { nodes: treeNodes } = await this.core.pfTree(sid);
    const reverifying = treeNodes
      .filter((n) => n.status === "needs_reverify")
      .map((n) => n.id);
    if (reverifying.length > 0) {
      throw pfError(
        "bad_request",
        `재검증 대기 노드가 있어 확정할 수 없습니다: ${reverifying.join(", ")}`,
        "pf_next → pf_report → pf_confirm_leaf로 재검증을 마친 뒤 다시 확정하세요.",
      );
    }
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
    // M8-1-0 보정: 자기 재검증으로 hash가 바뀐 노드는 승인이 무효다 → 재승인 안내.
    //  - core 승인 기록(사람이 external 계획을 승인) — approval.hash vs 현재 hash
    //  - approvals.json(무인 실행이 실제로 쓰는 승인 목록) — approvalHash vs 현재 approvalHash
    {
      const reapproval = new Set<string>();
      for (const n of fullNodes as {
        id: string;
        hash?: string;
        approval?: { at: string; note?: string; hash?: string } | undefined;
      }[]) {
        if (!n.approval?.hash || !n.hash) continue;
        if (n.approval.hash === n.hash) continue;
        reapproval.add(n.id);
      }
      const st = readRunStateBySession(this.procforgeDir, sid);
      if (st?.procedureDir) {
        const approvals = loadApprovals(st.procedureDir);
        if (approvals.length > 0) {
          const byId = new Map(nodes.map((n) => [n.id, n]));
          const accumulate = loadAccumulateFromProcedure(st.procedureDir);
          const readScript = (rel: string): string | undefined => {
            try {
              return readSandboxed(join(this.procforgeDir, "sessions", sid), rel);
            } catch {
              return undefined;
            }
          };
          for (const e of approvals) {
            const n = byId.get(e.node.id);
            if (!n) continue;
            if (!e.approvalHash) continue;
            const parent = n.parentId ? byId.get(n.parentId) : undefined;
            const pins = approvalPins(
              n,
              parent
                ? {
                    id: parent.id,
                    hash: parent.hash,
                    kind: (parent as { kind?: string }).kind,
                  }
                : undefined,
              toHashableMap(byId),
              readScript,
              accumulate,
            );
            const current = pins.find((p) => p.id === e.node.id)?.approvalHash ?? "";
            if (!current || current === e.approvalHash) continue;
            reapproval.add(e.node.id);
          }
        }
      }
      for (const id of [...reapproval].sort()) {
        allAudit.push(
          `재승인 필요: 노드 ${id} (승인 후 재검증으로 hash 변경 — procforge approve로 다시 승인하세요)`,
        );
      }
    }
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
    // M9-2-1: 실행 중 재finalize 금지. runSession의 절차서 run 잠금과 같은 기제
    // (FileStore.acquireFileLock, stale 60초 — run.ts:319-335를 재사용, 새로 만들지 않음).
    // UI·MCP·CLI 모두 app.finalize를 경유하므로 한 곳에서만 검사한다.
    // M9-2-1-fix: 잠금은 writeProcedure(swap 포함)가 끝날 때까지 쥐고 finally에서
    // 놓는다. 검사 후 바로 놓으면 검사-교체 사이에 run이 시작되는 틈이 남는다.
    const procRunLockPath = join(
      this.procforgeDir,
      "procedures",
      doc.name,
      ".run.lock",
    );
    let releaseProcRunLock: (() => void) | undefined;
    try {
      releaseProcRunLock = new FileStore(this.procforgeDir).acquireFileLock(
        procRunLockPath,
        `procedure finalize locked: ${doc.name}`,
        60000,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "conflict") {
        throw pfError(
          "conflict",
          `실행 중인 절차서는 확정할 수 없습니다: ${doc.name} (실행 종료 후 다시 확정하세요)`,
        );
      }
      throw e;
    }
    try {
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
    } finally {
      releaseProcRunLock?.();
    }
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
  /**
   * M7-5-4: var/generated 인자는 승인 파일에 `$any` 로 고정되므로 **키를 명시 선택**해야 한다
   * (CLI `--allow-wildcard` 와 동일). fixed/script 는 값이 확정되므로 여기 없다.
   */
  wildcardKeys: string[];
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
  const st = readRunStateBySession(this.procforgeDir, sid);
  const accumulate = st?.procedureDir
    ? loadAccumulateFromProcedure(st.procedureDir)
    : undefined;
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  const pins = approvalPins(
    n,
    parent ? { id: parent.id, hash: parent.hash, kind: (parent as { kind?: string }).kind } : undefined,
    toHashableMap(byId),
    readScript,
    accumulate,
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
    if (st?.procedureDir) {
      const prevScript = readApprovedSnapshot(st.procedureDir, nid);

      if (prevScript !== undefined && prevScript !== content) {
        diff = unifiedDiff(prevScript, content, "approved", rel);
      }
    }
  }
  const approved = pins.length > 0 && this.hasCurrentApproval(sid, nid, pins);
  const wildcardKeys = Object.entries(
    (n.args ?? {}) as Record<string, { kind?: string }>,
  )
    .filter(([, s]) => s?.kind !== "fixed" && s?.kind !== "script")
    .map(([k]) => k);
  return {
    sessionId: sid,
    nodeId: nid,
    approvalHash,
    script,
    diff,
    approved,
    // 예전 승인이 있는데 지금 값과 다르면 갱신 필요
    needsReapproval: !approved && this.hasAnyApproval(sid, nid),
    wildcardKeys,
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
  /** M7-5-4: var/generated 키를 명시 선택 (CLI --allow-wildcard 와 동일) */
  allowWildcard?: string[];
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
  // M7-5-4: wildcard 키는 **명시 선택**해야 한다. core 승인 전에 막아
  // "core 는 승인됐는데 approvals.json 기록만 실패" 상태를 만들지 않는다.
  // M7-close-b: 거부(approved:false)에는 선택이 필요 없다 — 승인일 때만 검사한다
  // (아니면 와일드카드가 있는 노드를 영영 거부할 수 없다).
  const allowWildcard = Array.isArray(input.allowWildcard)
    ? input.allowWildcard.filter((k): k is string => typeof k === "string")
    : [];
  const missingWildcard = info.wildcardKeys.filter((k) => !allowWildcard.includes(k));
  if (input.approved && missingWildcard.length > 0) {
    throw pfError(
      "bad_request",
      `승인 불가: 와일드카드 미지정 키 (${missingWildcard.join(",")}). 키를 명시 선택하세요.`,
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
    // M7-5-e: sandbox 로 읽는다 (raw readFileSync 는 "../" 로 세션 밖을 읽는다)
    const sessionRoot = join(this.procforgeDir, "sessions", input.sessionId);
    const entry = buildApprovalEntry(
      out.node as never,
      allowWildcard,
      new Map(),
      (rel: string) => {
        try {
          return readSandboxed(sessionRoot, rel);
        } catch {
          return undefined;
        }
      },
      loadAccumulateFromProcedure(st.procedureDir),
    );
    // M7-5-e: 스냅샷 저장도 공통 경로로 (MCP/CLI 승인도 같은 기준을 갖게)
    commitApproval(
      st.procedureDir,
      { ...entry, approvalHash: info.approvalHash },
      info.script
        ? { nodeId: input.nodeId, rel: info.script.rel, content: info.script.content }
        : undefined,
    );
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
      this.finishRun(waitingRun.runId, waitingRun.procedure, "info", "거부됨 — 실행 종료", input.nodeId, "cancelled");
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

  /** M7-close-a: 실행 external 승인 — CLI runApprove 와 같은 경로(UI 검증 포함). */
  async uiRunApprove(input: {
    runId: string;
    nodeId: string;
    approvalHash: string;
    approved: boolean;
    expectedRevision: number;
    note?: string;
    allowWildcard?: string[];
  }): Promise<{ runId: string; nodeId: string; approved: boolean }> {
    if (!Number.isInteger(input.expectedRevision)) {
      throw pfError("bad_request", "expectedRevision 필수");
    }
    if (!input.approvalHash) {
      throw pfError("bad_request", "approvalHash 필수 (M7-5-2)");
    }
    if (typeof input.approved !== "boolean") {
      throw pfError("bad_request", "approved 는 boolean 으로 명시해야 합니다 (M7-5-i).");
    }
    const st = readRunState(this.procforgeDir, input.runId) as RunState | undefined;
    if (!st) throw pfError("not_found", `run ${input.runId} not found`);
    // M7-close-b: expectedRevision을 **실제로 비교**한다(ui4-2). 화면이 본 리비전과
    // 지금 세션 리비전이 다르면 승인 전에 409 (무음 승인 금지, 다른 기기 끼어들기 차단).
    const s = await this.core.getSession(st.sessionId);
    if (input.expectedRevision !== s.revision) {
      throw pfError(
        "conflict",
        `revision mismatch: expected ${input.expectedRevision}, actual ${s.revision}`,
      );
    }
    const info = await this.uiApprovalInfo({
      sessionId: st.sessionId,
      nodeId: input.nodeId,
    });
    if (info.approvalHash !== input.approvalHash) {
      throw pfError(
        "conflict",
        `approvalHash 불일치 (화면 ${input.approvalHash.slice(0, 8)} ≠ 현재 ${info.approvalHash.slice(0, 8)}). 다시 읽으세요.`,
      );
    }
    // M7-close-b: 와일드카드 선택 검사는 **승인일 때만**. 거부(approved:false)는
    // 선택이 필요 없고, 검사하면 와일드카드 노드를 거부할 수 없게 된다.
    const allowWildcard = Array.isArray(input.allowWildcard)
      ? input.allowWildcard.filter((k): k is string => typeof k === "string")
      : [];
    const missingWildcard = info.wildcardKeys.filter((k) => !allowWildcard.includes(k));
    if (input.approved && missingWildcard.length > 0) {
      throw pfError(
        "bad_request",
        `승인 불가: 와일드카드 미지정 키 (${missingWildcard.join(",")}). 키를 명시 선택하세요.`,
      );
    }
    const out = await this.runApprove({
      runId: input.runId,
      nodeId: input.nodeId,
      approved: input.approved,
    });
    // M7-close-b: note를 받아서 버리지 않는다 — calls 기록에 남긴다(runApprove는 note를
    // 저장하지 않으므로 여기서 보존). nodeId 뒤(err 자리) undefined, 5번째가 note.
    this.recordUiCall(st.sessionId, "pf_run_approve", input.nodeId, undefined, input.note);
    return { runId: out.runId, nodeId: out.nodeId, approved: out.approved };
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
   * M10-4: 순차 자동 실행 가이드.
   * - 사람이 단계마다 확인하면(advanceGuide 호출) 다음 단계를 uiRun 계열로 실행한다.
   * - 실행 중 lane.started/finished를 실행 세션에 기록한다 (run.phase는 uiRun 경로가 기록).
   * - 진행 상태는 guides/<id>.json에 저장 → 재시작 후 guideStatus/advanceGuide로 이어간다.
   * - session.error 즉시 실패: M10-4 경로에 OpenCode가 없으므로(역할 표) 해당 없음.
   *   실행 중 예외는 단계 failed로 기록하고 자동 재시도하지 않는다.
   * - OpenCode 권한 요청에 always로 응답하지 않는다: advance 경로는 승인 API를 부르지 않는다.
   */
  async startGuide(a: {
    guideId?: string;
    steps: { procedure: string; params?: Record<string, string> }[];
  }): Promise<GuideFile> {
    const steps = a.steps;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 50) {
      throw pfError("bad_request", "steps는 1~50개의 배열이어야 함");
    }
    const norm = steps.map((s, i) => {
      const procedure = String(s?.procedure ?? "");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(procedure)) {
        throw pfError("bad_request", `단계 ${i}: procedure 이름 오류`);
      }
      try {
        loadProcedureDoc(this.procforgeDir, procedure);
      } catch {
        throw pfError("bad_request", `단계 ${i}: 등록되지 않은 절차서: ${procedure}`);
      }
      const params = s?.params ?? {};
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw pfError("bad_request", `단계 ${i}: params는 문자열 맵이어야 함`);
      }
      for (const [k, v] of Object.entries(params)) {
        if (typeof v !== "string") {
          throw pfError("bad_request", `단계 ${i}: param ${k}는 문자열이어야 함`);
        }
      }
      return { procedure, params: params as Record<string, string> };
    });
    const guideId = typeof a.guideId === "string" && a.guideId.length > 0 ? a.guideId : newGuideId();
    assertGuideId(guideId);
    if (existsSync(guidePath(this.procforgeDir, guideId))) {
      throw pfError("conflict", `이미 있는 가이드: ${guideId}`);
    }
    const now = new Date().toISOString();
    const guide: GuideFile = {
      version: 1,
      guideId,
      steps: norm,
      state: norm.map(() => ({ status: "pending" as const, updatedAt: now })),
      createdAt: now,
      updatedAt: now,
    };
    writeGuide(this.procforgeDir, guide);
    return guide;
  }

  /** M10-4: 가이드 상태 조회 (읽기 전용, 재시작 후 이어가기용). */
  async guideStatus(a: { guideId: string }): Promise<GuideFile> {
    return readGuide(this.procforgeDir, String(a.guideId ?? ""));
  }

  /**
   * M10-4: 사람 확인 후 다음 단계 실행. 완료 단계는 건너뛴다.
   * M10-4-fix-resume: running/waiting 단계는 기존 runId로 폴링만 한다
   * (새 run 금지). pending/failed/cancelled만 새 run을 시작한다.
   * 종료(done/failed/cancelled)까지 폴링한 뒤 guides/<id>.json에 기록한다.
   * 대기(waiting·suspended)에 걸리면 단계 waiting으로 두고 돌아온다
   * (승인·생성값은 화면에서 처리한 뒤 다시 advance로 이어간다).
   * 시간 초과면 throw 없이 저장된 상태 그대로 돌려준다.
   */
  async advanceGuide(a: {
    guideId: string;
    stepIndex?: number;
    timeoutMs?: number;
  }): Promise<{ guideId: string; stepIndex: number; status: GuideStepState["status"]; runId: string }> {
    const guideId = String(a.guideId ?? "");
    let guide = readGuide(this.procforgeDir, guideId);
    const next = nextStepIndex(guide);
    const idx =
      typeof a.stepIndex === "number" ? a.stepIndex : next;
    if (!Number.isInteger(idx) || idx < 0 || idx >= guide.steps.length) {
      throw pfError("bad_request", "stepIndex 범위 오류 (다음 차례 없음 포함)");
    }
    if (guide.state[idx].status === "done") {
      throw pfError("bad_request", `단계 ${idx}는 이미 완료됨`);
    }
    for (let i = 0; i < idx; i++) {
      if (guide.state[i].status !== "done") {
        throw pfError("bad_request", `단계 ${i}가 끝나야 ${idx}를 실행할 수 있음`);
      }
    }
    const timeoutMs =
      a.timeoutMs === undefined ? 120000 : Number(a.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
      throw pfError("bad_request", "timeoutMs는 1000~600000 정수");
    }
    const step = guide.steps[idx];
    // M10-4-fix-resume: running/waiting + runId가 있으면 그 run을 이어서 폴링만 한다.
    // 새 run은 pending/failed/cancelled일 때만 시작한다 (중복 실행 금지).
    const existing = guide.state[idx];
    if (
      (existing.status === "running" || existing.status === "waiting") &&
      typeof existing.runId === "string" &&
      existing.runId.length > 0
    ) {
      return this.pollGuideRun(guideId, idx, existing.runId, step.procedure, timeoutMs);
    }
    // M10-4: prepare → lane.started → drive 순서 (drive가 세션 락을 잡기 전에
    // 알림을 끝낸다. 반대로 하면 drive의 단일 시도 acquireLock이 죽고 run이 멈춘다).
    const { started } = await this.prepareRun(step.procedure, step.params, {
      procedure: step.procedure,
      params: step.params,
    });
    guide.state[idx] = {
      status: "running",
      runId: started.runId,
      sessionId: started.sessionId,
      updatedAt: new Date().toISOString(),
    };
    writeGuide(this.procforgeDir, touchGuide(guide));
    try {
      await this.notifySessionEvent({
        sessionId: started.sessionId,
        method: "lane.started",
        summary: `실행 단계 시작: ${step.procedure}`,
      });
    } catch {
      // 알림 실패는 실행을 막지 않는다
    }
    this.launchDrive(started.runId, started.procedure);
    return this.pollGuideRun(guideId, idx, started.runId, step.procedure, timeoutMs);
  }

  /**
   * M10-4-fix-resume: 기존 run 폴링 (새 run 시작 없음).
   * 종료하면 단계 기록 + lane.finished, 대기면 waiting 기록,
   * 시간 초과면 기록 없이 저장된 상태 그대로 돌려준다 (throw 없음).
   */
  private async pollGuideRun(
    guideId: string,
    idx: number,
    runId: string,
    procedure: string,
    timeoutMs: number,
  ): Promise<{ guideId: string; stepIndex: number; status: GuideStepState["status"]; runId: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.uiRunInfo({ runId });
      const terminal =
        info.status === "done" ||
        info.status === "failed" ||
        info.status === "cancelled";
      if (terminal) {
        const status = info.status as GuideStepState["status"];
        const guide = readGuide(this.procforgeDir, guideId);
        guide.state[idx] = {
          status,
          runId,
          sessionId: info.sessionId,
          updatedAt: new Date().toISOString(),
        };
        writeGuide(this.procforgeDir, touchGuide(guide));
        try {
          await this.notifySessionEvent({
            sessionId: info.sessionId,
            method: "lane.finished",
            summary: `실행 단계 종료: ${procedure} (${status})`,
          });
        } catch {
          // 알림 실패는 결과를 바꾸지 않는다
        }
        return { guideId, stepIndex: idx, status, runId };
      }
      if (info.waiting !== null || info.suspended !== null) {
        const guide = readGuide(this.procforgeDir, guideId);
        guide.state[idx] = {
          status: "waiting",
          runId,
          sessionId: info.sessionId,
          updatedAt: new Date().toISOString(),
        };
        writeGuide(this.procforgeDir, touchGuide(guide));
        return { guideId, stepIndex: idx, status: "waiting", runId };
      }
      if (Date.now() > deadline) {
        // 기록 없이 저장된 상태 그대로 (runId 유지) — 다음 advance가 이어간다.
        const guide = readGuide(this.procforgeDir, guideId);
        const stored = guide.state[idx].status;
        return { guideId, stepIndex: idx, status: stored, runId };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** M10-4: 실행 중인 단계 취소 (run 정리 + 단계 cancelled 기록). */
  async cancelGuideStep(a: {
    guideId: string;
    stepIndex?: number;
  }): Promise<{ guideId: string; stepIndex: number; status: "cancelled"; runId: string }> {
    const guideId = String(a.guideId ?? "");
    const guide = readGuide(this.procforgeDir, guideId);
    let idx: number;
    if (typeof a.stepIndex === "number") {
      idx = a.stepIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= guide.steps.length) {
        throw pfError("bad_request", "stepIndex 범위 오류");
      }
    } else {
      idx = guide.state.findIndex(
        (s) => (s.status === "running" || s.status === "waiting") && s.runId,
      );
      if (idx < 0) throw pfError("bad_request", "취소할 실행 중인 단계 없음");
    }
    const st = guide.state[idx];
    if ((st.status !== "running" && st.status !== "waiting") || !st.runId) {
      throw pfError("bad_request", `단계 ${idx}는 실행 중이 아님`);
    }
    const step = guide.steps[idx];
    const info = await this.uiRunInfo({ runId: st.runId });
    await this.uiRunCancel({ runId: st.runId });
    guide.state[idx] = {
      status: "cancelled",
      runId: st.runId,
      updatedAt: new Date().toISOString(),
    };
    writeGuide(this.procforgeDir, touchGuide(guide));
    try {
      await this.notifySessionEvent({
        sessionId: info.sessionId,
        method: "lane.finished",
        summary: `실행 단계 취소: ${step.procedure}`,
      });
    } catch {
      // 알림 실패는 취소 결과를 바꾸지 않는다
    }
    return { guideId, stepIndex: idx, status: "cancelled", runId: st.runId };
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
    const { started } = await this.prepareRun(input.procedure, input.params, input);
    this.launchDrive(started.runId, started.procedure);
    return started;
  }

  /**
   * 실행 준비 (검증 + runStart + 시작 로그, drive 미기동).
   * uiRun과 advanceGuide가 공유한다. advanceGuide는 여기서 반환된 뒤
   * lane.started를 기록하고 drive를 띄운다 — drive가 세션 락을 잡기 전에
   * 알림을 끝내야 경합으로 drive가 죽지 않는다 (M10-4).
   */
  private async prepareRun(
    procedureArg: unknown,
    paramsArg: unknown,
    rawInput: unknown,
  ): Promise<{
    started: { runId: string; sessionId: string; procedure: string; params: Record<string, string> };
    docName: string;
  }> {
    // M7-5-d: **화이트리스트**. denylist 는 키가 늘 때마다 구멍이 된다.
    const allowed = new Set(["procedure", "params"]);
    const extra = Object.keys((rawInput ?? {}) as Record<string, unknown>).filter(
      (k) => !allowed.has(k),
    );
    if (extra.length > 0) {
      throw pfError("bad_request", `지정할 수 없는 키: ${extra.join(",")} (M7-5-d).`);
    }
    for (const [k, v] of Object.entries((paramsArg ?? {}) as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw pfError("bad_request", `param ${k}는 문자열이어야 합니다 (M7-5-d).`);
      }
    }
    const ref = String(procedureArg ?? "");
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
    const params = (paramsArg ?? {}) as Record<string, string>;
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
      // M10-3-events: run.phase 기계 판독 마커 (기존 문구 유지 + 접미).
      message: `실행 시작: ${started.procedure} (phase:started)`,
    });
    // M7-5-d: 실행 요청도 calls.jsonl 에 남긴다 (누가 무엇을 띄웠는지)
    this.recordUiCall(started.sessionId, "pf_run_start", "");
    return { started, docName: doc.name };
  }

  /**
   * 백그라운드 진행 시작 (uiRun·advanceGuide 공유).
   * drive가 세션 락을 잡기 전에 호출자가 알림 등을 끝내야 한다.
   */
  private launchDrive(runId: string, docName: string): void {
    // 백그라운드 진행 — UI는 기다리지 않는다(로그·결과는 SSE).
    void this.driveRun(runId, docName).catch(() => {
      // 오류는 로그로 남는다 (흘러나오면 UI가 조용히 멈춘 것처럼 보인다)
      appendRunLog(this.procforgeDir, runId, {
        level: "error",
        message: "실행 진행 중 오류",
      });
    });
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
    // 대기 표식은 cancelRun 전에 읽어 둔다. 취소가 waiting 기록 직후·캐시 등록
    // 전에 들어와도 디스크가 진실이므로 여기서 취소를 확정해야 한다.
    const persistedWaiting = st.waiting !== undefined;
    const r = await cancelRun(this.procforgeDir, runId, "UI 실행 화면에서 취소");
    // M7-5-b: **대기 중** 취소는 driveRun 이 이미 빠져나갔으므로 그 자식의 종료를 볼 주체가 없다.
    // 여기서 바로 잠금을 푼다 (안 하면 그 절차서는 409 고착).
    if (persistedWaiting || this.waitingRuns.has(runId)) {
      const wst = readRunState(this.procforgeDir, runId) as RunState | undefined;
      if (wst?.procedure) this.markCancelled(runId, wst.procedure);
    }
    appendRunLog(this.procforgeDir, runId, {
      level: "info",
      // M10-3-events: run.phase 기계 판독 마커 (기존 문구 유지 + 접미).
      message: `취소 요청 (자식 ${r.children.length}개 종료 시도) (phase:cancelled)`,
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
      // M7-close-a: 종료 상태는 취소 플래그가 남아도 그대로 보여준다.
      // (안 그러면 취소된 실행이 영원히 "cancelling" 이라 재실행 버튼이 안 뜬다)
      status: this.runStatus(st),
      entries: readRunLog(this.procforgeDir, runId, input.afterSeq ?? 0),
      sessionId: st.sessionId,
      procedure: st.procedure,
    };
  }

  /**
   * M7-5-4: 실행 결과 화면용 상태. 노드별 status 는 runner 가 기록한 **문자열 그대로** 준다
   * (UI 가 pass/fail 로 해석하지 않는다). 실행 중에는 화면이 이 값을 폴링한다.
   */
  async uiRunInfo(input: { runId: string }): Promise<{
    runId: string;
    status: string;
    procedure: string;
    sessionId: string;
    params: Record<string, string>;
    results: { nodeId: string; status: string }[];
    summary?: RunState["summary"];
    failedNodeId?: string;
    failedDetail?: string;
    waiting: RunState["waiting"] | null;
    suspended: RunState["suspended"] | null;
  }> {
    const runId = String(input.runId ?? "");
    const st = readRunState(this.procforgeDir, runId);
    if (!st) throw pfError("not_found", `run ${runId} not found`);
    return {
      runId,
      status: this.runStatus(st),
      procedure: st.procedure,
      sessionId: st.sessionId,
      params: st.params,
      results: st.results ?? [],
      ...(st.summary !== undefined ? { summary: st.summary } : {}),
      ...(st.failedNodeId !== undefined ? { failedNodeId: st.failedNodeId } : {}),
      ...(st.failedDetail !== undefined ? { failedDetail: st.failedDetail } : {}),
      waiting: st.waiting ?? null,
      suspended: st.suspended ?? null,
    };
  }

  /** M7-5-4: 새로고침 후에도 결과 화면을 복원할 수 있게 최근 runId 를 준다. */
  async uiLatestRun(input: {
    procedure?: string;
    sessionId?: string;
  }): Promise<{ runId: string | null }> {
    if (input.procedure) {
      const runsDir = join(this.procforgeDir, "runs");
      let names: string[];
      try {
        names = readdirSync(runsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return { runId: null };
      }
      let best: RunState | undefined;
      for (const name of names) {
        const st = readRunState(this.procforgeDir, name);
        if (st?.procedure !== input.procedure) continue;
        if (!best || st.updatedAt > best.updatedAt) best = st;
      }
      return { runId: best?.runId ?? null };
    }
    if (input.sessionId) {
      const st = readRunStateBySession(this.procforgeDir, input.sessionId);
      return { runId: st?.runId ?? null };
    }
    return { runId: null };
  }

  /**
   * M7-5-4: 실행 화면의 절차서 목록. `procedures/<name>/procedure.json` 만 읽는다
   * (손상된 항목은 목록에서 숨긴다 — 화면이 깨지지 않게).
   */
  async listProcedures(): Promise<{
    procedures: {
      name: string;
      params: {
        name: string;
        type: string;
        required: boolean;
        default?: string;
        description: string;
      }[];
    }[];
  }> {
    const root = join(this.procforgeDir, "procedures");
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return { procedures: [] };
    }
    const out: {
      name: string;
      params: {
        name: string;
        type: string;
        required: boolean;
        default?: string;
        description: string;
      }[];
    }[] = [];
    for (const dirName of names.sort()) {
      try {
        const { doc } = loadProcedureDoc(this.procforgeDir, dirName);
        out.push({
          name: doc.name,
          params: Object.entries(doc.params ?? {}).map(([k, v]) => ({
            name: k,
            type: v.type,
            required: v.required === true,
            ...(v.default !== undefined ? { default: v.default } : {}),
            description: v.description,
          })),
        });
      } catch {
        // 손상·읽기 실패 항목은 목록에서 제외
      }
    }
    return { procedures: out };
  }

  /** M10-1: 유사 분석 조회 (읽기 전용, 로컬 전용). MCP 표면 불변. */
  async similarProcedures(a: {
    query?: string;
    limit?: number;
    /** M10-3-events: 지정 시 조회 뒤 memory.loaded 알림을 해당 세션에 남긴다. */
    sessionId?: string;
  }): Promise<{
    procedures: SimilarProcedure[];
  }> {
    const all = listProceduresWithLatest(this.procforgeDir);
    const q = typeof a.query === "string" ? a.query : "";
    const lim = typeof a.limit === "number" ? a.limit : undefined;
    const out = { procedures: filterProcedures(all, q, lim) };
    if (typeof a.sessionId === "string" && a.sessionId.length > 0) {
      await this.notifySessionEvent({
        sessionId: a.sessionId,
        method: "memory.loaded",
        summary: `memory loaded: ${out.procedures.length}건`,
        reason: q.length > 0 ? q.slice(0, 200) : undefined,
      });
    }
    return out;
  }

  /** M10-2: 재분석 초안 생성 (App 메서드, MCP 표면 불변).
   * 모델은 서버 기본값(GET /config/providers default 첫 항목)을 쓴다
   * (명시 모델 파라미터 없음 — M10-spec 판정 6). */
  async createRedraft(a: {
    procedure: string;
    request: string;
    /** M10-3-events: 지정 시 초안 준비 뒤 draft.ready 알림을 해당 세션에 남긴다. */
    sessionId?: string;
  }): Promise<RedraftResult> {
    const baseUrl = this.signal.baseUrl;
    if (!baseUrl) {
      throw pfError("bad_request", "OpenCode 서버 주소 없음 (PROOF_OPENCODE_URL)");
    }
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const headers = openCodeAuthHeaders(password);
    let model: { providerID: string; modelID: string } | undefined;
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/config/providers`, { headers });
      const j = (await r.json()) as {
        default?: Record<string, string>;
        providers?: Record<string, { models?: Record<string, unknown> }>;
      };
      const firstDefault = j && typeof j === "object" ? Object.entries(j.default ?? {})[0] : undefined;
      if (firstDefault) {
        model = { providerID: firstDefault[0], modelID: firstDefault[1] };
      } else {
        const firstProv = j && typeof j === "object" ? Object.entries(j.providers ?? {})[0] : undefined;
        const firstModel = firstProv ? Object.keys(firstProv[1].models ?? {})[0] : undefined;
        if (firstProv && firstModel) model = { providerID: firstProv[0], modelID: firstModel };
      }
    } catch {
      // 조회 실패는 아래 기본 모델 없음 오류로 합친다
    }
    if (!model) throw pfError("bad_request", "OpenCode 기본 모델 없음 (서버 providers 확인)");
    const result = await runRedraft({
      procforgeDir: this.procforgeDir,
      procedure: String(a.procedure),
      request: String(a.request),
      openCode: { baseUrl, ...(password ? { password } : {}), model },
    });
    if (typeof a.sessionId === "string" && a.sessionId.length > 0) {
      await this.notifySessionEvent({
        sessionId: a.sessionId,
        method: "draft.ready",
        summary: `draft ready ${result.draftId}`,
      });
    }
    return result;
  }

  /** M10-3-api: 재분석 초안 조회 (읽기 전용). draft.json 그대로 반환. */
  async getDraft(a: { draftId: string }): Promise<RedraftResult> {
    const id = String(a.draftId ?? "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.includes("..")) {
      throw pfError("bad_request", "draftId 형식이 잘못되었습니다.");
    }
    const file = join(this.procforgeDir, "drafts", id, "draft.json");
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw pfError("not_found", `초안 없음: ${id}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw pfError("bad_request", `draft.json 파싱 실패: ${id}`);
    }
    const d = parsed as Partial<RedraftResult>;
    if (
      !d ||
      typeof d !== "object" ||
      typeof d.procedure !== "string" ||
      typeof d.sourceHash !== "string" ||
      typeof d.status !== "string" ||
      !Array.isArray(d.ops)
    ) {
      throw pfError("bad_request", `draft.json 형식 오류: ${id}`);
    }
    return parsed as RedraftResult;
  }

  /** M10-3-api: 재분석 diff 적용.
   *
   * 판정 B의 기존 경로 재사용 = 절차서 문서에 필드 규칙 그대로 적용:
   * edit_goal→node.goal (pfEditNode 상당), edit_arg→node.args (pfEditArgs 상당,
   * 확정값 fixed로 기록), edit_why→node.why (editWhy 상당, trim 후 1~500 동일 문구).
   * draft는 절차서 스코프(sourceHash가 procedure.json 기준)이므로 절차서 파일에
   * 직접 적용한다.
   *
   * M10-3-apply-fix: 실행 중 적용 금지(finalize와 같은 .run.lock, 409) +
   * 원자 쓰기(임시+교체) + 적용 전 판본 history 보관.
   * 승인 게이트는 별도 코드가 아니라 기존 approvals.json stale 판정이다:
   * goal/arg가 바뀐 승인 대상 노드는 다음 무인 실행에서 fail["approval"]
   * (승인 갱신 필요)로 걸린다. 순수 분해 노드(승인 대상 아님)의 goal 변경은
   * 게이트 없이 다음 import에 반영된다 — "판정 필요" 참조.
   * sourceHash가 현재 절차서와 다르면 적용 전체를 거부한다 (conflict → HTTP 409).
   */
  async applyDraft(a: {
    draftId: string;
    opIds: unknown;
  }): Promise<{
    draftId: string;
    procedure: string;
    applied: { nodeId: string; kind: string }[];
    /** 바뀐 노드 id (정렬·중복 제거) */
    changedNodes: string[];
    /**
     * 승인이 풀린 노드 (다음 실행 때 승인 필요).
     * goal/arg-kind 적용 + 승인 대상(external·script) + approvals.json에 기존 항목.
     * why-kind는 승인 해시에 안 들어가므로 제외.
     */
    approvalReset: string[];
  }> {
    const draft = await this.getDraft({ draftId: a.draftId });
    if (draft.status !== "ready") {
      throw pfError(
        "bad_request",
        "초안이 적용 가능 상태가 아님 (ready 아님).",
        "ready 상태의 초안만 적용할 수 있다.",
      );
    }
    if (
      !Array.isArray(a.opIds) ||
      a.opIds.length === 0 ||
      a.opIds.some(
        (n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) >= draft.ops.length,
      )
    ) {
      throw pfError(
        "bad_request",
        "opIds는 draft ops 인덱스의 비어 있지 않은 배열이어야 함.",
        "적용할 diff 항목 번호를 배열로 넘겨라.",
      );
    }
    if (!PROCEDURE_NAME_RE.test(draft.procedure)) {
      throw pfError("bad_request", `절차서 이름 오류: ${draft.procedure}`);
    }
    const procDir = join(this.procforgeDir, "procedures", draft.procedure);
    const procFile = join(procDir, "procedure.json");
    // M10-3-apply-fix: 실행 중 적용 금지 (finalize와 같은 .run.lock 기제).
    let releaseRunLock: (() => void) | undefined;
    try {
      releaseRunLock = new FileStore(this.procforgeDir).acquireFileLock(
        join(procDir, ".run.lock"),
        `procedure apply locked: ${draft.procedure}`,
        60000,
      );
    } catch (e) {
      if ((e as { code?: string }).code === "conflict") {
        throw pfError(
          "conflict",
          `실행 중인 절차서에는 초안을 적용할 수 없습니다: ${draft.procedure} (실행 종료 후 다시 적용하세요)`,
        );
      }
      throw e;
    }
    try {
      let raw: string;
      try {
        raw = readFileSync(procFile, "utf8");
      } catch {
        throw pfError("not_found", `절차서 없음: ${draft.procedure}`);
      }
      const cur = createHash("sha256").update(raw, "utf8").digest("hex");
      if (cur !== draft.sourceHash) {
        throw pfError(
          "conflict",
          "절차서가 바뀜: 재분석 필요 (sourceHash 불일치).",
          "draft 생성 이후 procedure.json이 바뀌었다. 다시 재분석하라.",
        );
      }
      let doc: {
        nodes?: {
          id?: unknown;
          goal?: unknown;
          tool?: { server?: unknown; name?: unknown };
          args?: Record<string, unknown>;
          sideEffect?: unknown;
          why?: unknown;
        }[];
      };
      try {
        doc = JSON.parse(raw) as typeof doc;
      } catch {
        throw pfError("bad_request", `procedure.json 파싱 실패: ${draft.procedure}`);
      }
      if (!doc || typeof doc !== "object" || !Array.isArray(doc.nodes)) {
        throw pfError("bad_request", `procedure.json 형식 오류: ${draft.procedure}`);
      }
      const applied: { nodeId: string; kind: string }[] = [];
      for (const n of a.opIds as number[]) {
        const op = draft.ops[n] as DraftOp;
        const node = doc.nodes.find((x) => x.id === op.nodeId);
        if (!node) throw pfError("bad_request", `없는 노드: ${op.nodeId}`);
        if (op.op === "edit_goal") {
          if (typeof op.goal !== "string" || op.goal.trim().length === 0) {
            throw pfError("bad_request", `edit_goal에 goal 없음: ${op.nodeId}`);
          }
          node.goal = op.goal;
          applied.push({ nodeId: op.nodeId, kind: "goal" });
        } else if (op.op === "edit_arg") {
          if (!node.args || typeof node.args !== "object" || !(op.arg in node.args)) {
            throw pfError("bad_request", `없는 인자: ${op.nodeId}.${op.arg}`);
          }
          node.args[op.arg] = { kind: "fixed", value: op.value };
          applied.push({ nodeId: op.nodeId, kind: "arg" });
        } else {
          const why = typeof op.why === "string" ? op.why.trim() : "";
          if (why.length < 1 || why.length > 500) {
            throw pfError(
              "bad_request",
              "why는 1~500자여야 한다.",
              "바꾼 이유를 1줄로 적어라.",
            );
          }
          node.why = why;
          applied.push({ nodeId: op.nodeId, kind: "why" });
        }
      }
      // M10-3-apply-fix: 적용 전 판본 보관 (재사용 메모리 M9-2).
      const histDir = join(procDir, "history");
      mkdirSync(histDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      writeFileSync(join(histDir, `${stamp}-${cur.slice(0, 12)}.json`), raw);
      // M10-3-apply-fix: 원자 쓰기 (임시 파일 + 교체).
      writeFileAtomic(procFile, JSON.stringify(doc, null, 2));
      const changedNodes = [...new Set(applied.map((x) => x.nodeId))].sort();
      // M10-3-apply-fix: 승인 리셋 판정. goal/arg 변경 + 승인 대상 노드 +
      // approvals.json에 기존 항목이 있으면 다음 실행에서 stale로 걸린다.
      const byId = new Map(doc.nodes.map((x) => [String(x.id), x]));
      let approvalReset: string[];
      try {
        const entries = loadApprovals(procDir);
        const pinned = new Set(entries.map((e) => e.node.id));
        approvalReset = changedNodes.filter((id) => {
          if (!pinned.has(id)) return false;
          if (!applied.some((x) => x.nodeId === id && (x.kind === "goal" || x.kind === "arg"))) {
            return false;
          }
          const node = byId.get(id);
          if (!node || typeof node.tool !== "object" || node.tool === null) return false;
          if (node.sideEffect === "external") return true;
          const args = node.args;
          if (!args || typeof args !== "object") return false;
          return Object.values(args).some(
            (s) => typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "script",
          );
        });
      } catch {
        // approvals.json 파싱 실패는 적용을 막지 않는다 — 다음 실행에서 판정된다.
        approvalReset = [];
      }
      return {
        draftId: draft.draftId,
        procedure: draft.procedure,
        applied,
        changedNodes,
        approvalReset,
      };
    } finally {
      releaseRunLock?.();
    }
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
          this.markCancelled(runId, procedure);
          return;
        }
        const step = await this.runStep(runId, { unattended: true });
        if (readCancelFlag(this.procforgeDir, runId)) {
          this.markCancelled(runId, procedure);
          return;
        }
        if (step.kind === "done") {
          this.finishRun(
            runId,
            procedure,
            "result",
            `완료: pass ${step.pass} / fail ${step.fail} / blocked ${step.blocked}`,
            undefined,
            "done",
          );
          return;
        }
        if (step.kind === "failed") {
          this.finishRun(runId, procedure, "error", `실패: ${step.detail}`, step.nodeId, "failed");
          return;
        }
        // need_generated / need_approval 은 사람이 결정해야 한다 → 멈추되
        // **잠금은 유지**한다 (같은 절차서 중복 실행 방지).
        appendRunLog(this.procforgeDir, runId, {
          level: "info",
          nodeId: step.nodeId,
          // M10-3-events: run.phase 기계 판독 마커 (기존 문구 유지 + 접미).
          message:
            step.kind === "need_approval"
              ? "승인 대기 — 결정을 기다립니다 (phase:waiting-approval)"
              : "생성값 대기 — 값을 기다립니다 (phase:waiting-input)",
        });
        // 테스트 전용 경쟁 재현: waiting 기록 후·캐시 등록 전.
        if (this.onWaitingPersisted) {
          await this.onWaitingPersisted(runId, procedure);
        }
        this.waitingRuns.add(runId);
        // 캐시 등록 직후 다시 본다. 이 시점의 확인은 await 없이 끝나므로,
        // 취소가 그 전에 들어왔으면 여기서, 후에 들어왔으면 uiRunCancel 이
        // waitingRuns 캐시를 보고 정리한다. 두 경우 모두 잠금이 남지 않는다.
        const afterWaiting = readRunState(this.procforgeDir, runId) as
          | RunState
          | undefined;
        if (afterWaiting?.status === "cancelled") {
          this.releaseRun(procedure, runId);
          return;
        }
        if (readCancelFlag(this.procforgeDir, runId)) {
          this.markCancelled(runId, procedure);
        }
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
      if (!this.waitingRuns.has(runId)) this.releaseRun(procedure, runId);
    }
  }

  /** runId 가 실제 잠금 소유자일 때만 푼다 (뒤에 시작한 실행의 잠금을 지우지 않는다). */
  private releaseRun(procedure: string, runId: string): void {
    this.waitingRuns.delete(runId);
    if (this.activeRuns.get(procedure) === runId) this.activeRuns.delete(procedure);
  }

  /** M7-close-a: 취소 플래그를 반영한 표시용 상태 (종료 상태는 덮지 않는다). */
  private runStatus(st: RunState): string {
    const terminal =
      st.status === "done" || st.status === "failed" || st.status === "cancelled";
    return !terminal && readCancelFlag(this.procforgeDir, st.runId)
      ? "cancelling"
      : st.status;
  }

  /**
   * M7-close-a: 취소 확정 — 상태를 **cancelled** 로 굳히고 로그·잠금을 정리한다.
   * (finishRun 만 부르면 취소 플래그가 남아 uiRunInfo 가 영원히 "cancelling" 이다.)
   */
  private markCancelled(runId: string, procedure: string): void {
    const st = readRunState(this.procforgeDir, runId) as RunState | undefined;
    if (!st) {
      this.finishRun(runId, procedure, "info", "취소됨", undefined, "cancelled");
      return;
    }
    // 취소 확정은 여러 경로(uiRunCancel·driveRun)에서 동시에 불릴 수 있다.
    // 이미 확정됐으면 로그를 중복으로 남기지 않고 잠금만 정리한다.
    if (st.status === "cancelled") {
      this.releaseRun(procedure, runId);
      return;
    }
    writeRunState(this.procforgeDir, {
      ...st,
      status: "cancelled",
      waiting: undefined,
      suspended: undefined,
      failedNodeId: undefined,
      failedDetail: undefined,
      updatedAt: new Date().toISOString(),
    });
    this.finishRun(runId, procedure, "info", "취소됨", undefined, "cancelled");
  }

  /** 실행 종료 처리 (로그 + 잠금 해제) */
  private finishRun(
    runId: string,
    procedure: string,
    level: "info" | "error" | "result",
    message: string,
    nodeId?: string,
    // M10-3-events: run.phase 기계 판독 마커 (종료 전환에만 부여).
    phase?: "done" | "failed" | "cancelled",
  ): void {
    appendRunLog(this.procforgeDir, runId, {
      level,
      message: phase === undefined ? message : `${message} (phase:${phase})`,
      ...(nodeId !== undefined ? { nodeId } : {}),
    });
    // 뒤에 시작한 실행이 잠금을 가져갔을 수 있다. runId 가 소유자일 때만 푼다.
    this.releaseRun(procedure, runId);
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
      this.markCancelled(runId, procedure);
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
      // M10-3-events: run.phase 기계 판독 마커 (기존 문구 유지 + 접미).
      message: "결정 반영 — 실행을 이어갑니다 (phase:resumed)",
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
      ...(st.stateRoot ? { stateRoot: st.stateRoot } : {}),
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
    // M7-5-4: 노드별 결과를 **그대로** 누적한다. 같은 실행의 뒤 단계에서
    // skipNodeIds 때문에 "skipped" 로 다시 나온 노드는 이전 결과를 유지한다.
    const resultMap = new Map((st.results ?? []).map((r) => [r.nodeId, r.status]));
    for (const r of report.results) {
      if (r.status === "skipped" && resultMap.has(r.nodeId)) continue;
      resultMap.set(r.nodeId, r.status);
    }
    const results = [...resultMap].map(([nodeId, status]) => ({ nodeId, status }));
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
        results,
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
        results,
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
      results,
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
      this.finishRun(runId, st.procedure, "info", "승인 거부 — 실행 종료", nodeId, "cancelled");
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
    const docNode = {
      id: n.id,
      goal: n.goal,
      tool: n.tool,
      args: n.args,
      constraints: n.constraints,
      sideEffect: n.sideEffect,
      map: n.map,
      until: n.until,
    };
    // M7-5-d: 절차서 안 스크립트도 sandbox 로 읽는다 ("../" 로 절차서 밖을 못 읽게)
    const readScript = (rel: string): string | undefined => {
      try {
        return readSandboxed(dir, rel);
      } catch {
        return undefined;
      }
    };
    const entry = buildApprovalEntry(
      docNode,
      allowWildcard,
      docById,
      readScript,
      doc.accumulate,
    );
    // M7-5-e: CLI 승인도 스냅샷을 남긴다 (UI/MCP 와 같은 기준)
    const scriptFile = (n.args as Record<string, { kind?: string; file?: string }> | undefined)
      ?.script?.file;
    const scriptContent = scriptFile ? readScript(scriptFile) : undefined;
    const { path, replaced } = commitApproval(
      dir,
      entry,
      scriptFile && scriptContent !== undefined
        ? { nodeId: n.id, rel: scriptFile, content: scriptContent }
        : undefined,
    );
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
    state?: unknown;
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
    /** M8-1-0 보정: 재검증 대기 노드 수 (실행 안 함) */
    needsReverify: number;
  }> {
    const procRef = a.procedure as string;
    if (!procRef) throw pfError("bad_request", "procedure가 필요하다.");
    const params = (a.params ?? {}) as Record<string, string>;
    const unattended = a.unattended === true;
    const stateRoot =
      typeof a.state === "string" && a.state.trim() !== ""
        ? resolve(this.projectRoot, a.state)
        : undefined;
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
        ...(stateRoot ? { stateRoot } : {}),
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
      // M8-1-0 보정: 재검증 대기 노드 수 (실행 안 함)
      needsReverify: report.summary.needsReverify,
      approvalBlocked: report.results.some((r) =>
        r.failedConstraints.includes("approval"),
      ),
      reportPath: join(this.procforgeDir, "runs", report.runId, "report.json"),
      ...(outDir ? { outDir } : {}),
    };
  }
}
