import { z } from "zod";
import {
  ArgSpecSchema,
  ConstraintSchema,
  NodeIdSchema,
  NodeSchema,
  SessionIdSchema,
  SessionSchema,
  SessionSummarySchema,
  SideEffectSchema,
  ToolCatalogEntrySchema,
  ToolRefSchema,
} from "./schema.js";
import { ActorSchema, EventEntrySchema } from "./dto.js";
import { ProcedureDocSchema } from "./procedure.js";
import { errorCodeOf, pfError } from "./errors.js";

/**
 * M6-1 wire 계약: CoreClient 메서드 1:1 HTTP(JSON) 엔드포인트.
 * POST /v1/<method>, JSON object body. 요청·응답 모두 아래 zod로 양쪽 검증.
 * 공유 스키마 재사용 + 메서드별 필수 키. 깊은 페이로드는 shared 스키마 그대로.
 */

/** 프로토콜 버전 (M6-1). 클라이언트는 헤더로 전송, 서버는 검사. */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION_HEADER = "x-procforge-version";

const RevActor = {
  expectedRevision: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
};

const ChangeMeta = {
  revision: z.number().int().min(0),
  changedNodeIds: z.array(z.string()),
};

const LimitsSchema = z.object({
  maxDepth: z.number().int().min(1),
  maxRetries: z.number().int().min(0),
  maxNodes: z.number().int().min(1),
});

const RefCheckSchema = z.object({
  key: z.string(),
  verdict: z.enum(["match", "mismatch", "unverifiable"]),
  probing: z.string().optional(),
  resolved: z.string().optional(),
});

const SplitChildSchema = z.object({
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  sideEffect: SideEffectSchema.optional(),
});

const BlockedEntrySchema = z.object({
  nodeId: z.string(),
  waitingOn: z.array(z.string()),
  reason: z.enum([
    "dep_failed",
    "dep_empty_split",
    "dep_missing",
    "dep_pending",
  ]),
});

export type WireMethodName =
  | "pfStart"
  | "pfNext"
  | "pfReport"
  | "pfResolve"
  | "pfAdvise"
  | "pfTree"
  | "pfLock"
  | "pfReopen"
  | "amendAttemptArtifacts"
  | "pfUpdateCatalog"
  | "pfEditArgs"
  | "pfEditNode"
  | "getEvents"
  | "getEventsPage"
  | "getBlocked"
  | "getSession"
  | "getNode"
  | "getSessions"
  | "pfBuildProcedure"
  | "pfApprove"
  | "pfImportProcedure"
  | "pfWriteGolden";

export type WireDef = {
  path: string;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
};

export const WireMethods: Record<WireMethodName, WireDef> = {
  pfStart: {
    path: "/v1/pfStart",
    input: z.object({
      request: z.string().min(1),
      params: z.record(z.string()).optional(),
      toolCatalog: z.array(ToolCatalogEntrySchema),
      limits: LimitsSchema.optional(),
      opencodeVersion: z.string().optional(),
    }),
    output: z.object({
      session: SessionSchema,
      node: NodeSchema,
      instruction: z.string(),
    }),
  },
  pfNext: {
    path: "/v1/pfNext",
    input: z.object({ sessionId: SessionIdSchema, ...RevActor }),
    output: z.union([
      z.object({
        done: z.literal(false),
        node: NodeSchema,
        blocked: z.array(BlockedEntrySchema).optional(),
        instruction: z.string(),
        enteredProbing: z.boolean(),
        revision: z.number().int().min(0),
        changedNodeIds: z.array(z.string()),
      }),
      z.object({
        done: z.literal(true),
        revision: z.number().int().min(0),
        changedNodeIds: z.array(z.string()),
      }),
    ]),
  },
  pfReport: {
    path: "/v1/pfReport",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      tool: ToolRefSchema,
      args: z.record(z.unknown()),
      resultSummary: z.string(),
      resultJson: z.unknown().optional(),
      // M6.1-1: 원격 사전평가 경로 (resultJson과 병행 금지, core가 거부).
      resultJsonMeta: z
        .object({ sha256: z.string(), size: z.number(), preview: z.string() })
        .optional(),
      localEvaluation: z
        .object({
          verdict: z.enum(["pass", "fail"]),
          failedConstraints: z.array(z.string()),
          unverified: z.array(z.string()).optional(),
        })
        .optional(),
      autoConstraints: z.array(ConstraintSchema).optional(),
      artifacts: z.array(z.string()).optional(),
      artifactContents: z.record(z.string()).optional(),
      artifactSources: z.record(z.string()).optional(),
      verifiedJsonKeys: z.array(z.string()).optional(),
      selfVerdict: z.enum(["pass", "fail"]),
      selfReason: z.string().min(1),
      rubricReasons: z.record(z.string()).optional(),
      attemptId: z.string().optional(),
      ...RevActor,
    }),
    output: z.object({
      verdict: z.enum(["pass", "fail", "unverifiable"]),
      failedConstraints: z.array(z.string()),
      unverified: z.array(z.string()).optional(),
      instruction: z.string(),
      ...ChangeMeta,
    }),
  },
  pfResolve: {
    path: "/v1/pfResolve",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      decision: z.enum(["leaf", "split", "retry", "ask_human"]),
      children: z.array(SplitChildSchema).optional(),
      argSpecs: z.record(ArgSpecSchema).optional(),
      sideEffect: SideEffectSchema.optional(),
      tool: ToolRefSchema.optional(),
      plan: z
        .object({ tool: ToolRefSchema, args: z.record(z.unknown()) })
        .optional(),
      note: z.string().optional(),
      goldenIgnore: z.array(z.string()).optional(),
      artifacts: z.array(z.string()).optional(),
      runnableTools: z.array(z.string()).optional(),
      refCheck: z.array(RefCheckSchema).optional(),
      strict: z.boolean().optional(),
      ...RevActor,
    }),
    output: z.object({
      node: NodeSchema,
      created: z.array(NodeSchema).optional(),
      instruction: z.string(),
      ...ChangeMeta,
    }),
  },
  pfAdvise: {
    path: "/v1/pfAdvise",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      text: z.string(),
      proposedConstraints: z.array(z.unknown()).optional(),
      fixtureContents: z.record(z.string()).optional(),
      ...RevActor,
    }),
    output: z.object({
      constraints: z.array(ConstraintSchema),
      rejected: z.array(
        z.object({ proposal: z.unknown(), reason: z.string() }),
      ),
      node: NodeSchema,
      note: z.string().optional(),
      ...ChangeMeta,
    }),
  },
  pfTree: {
    path: "/v1/pfTree",
    input: z.object({ sessionId: SessionIdSchema }),
    output: z.object({ nodes: z.array(NodeSchema), session: SessionSchema }),
  },
  pfLock: {
    path: "/v1/pfLock",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      ...RevActor,
    }),
    output: z.object({ node: NodeSchema, ...ChangeMeta }),
  },
  pfReopen: {
    path: "/v1/pfReopen",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      reason: z.string().min(1),
      ...RevActor,
    }),
    output: z.object({ node: NodeSchema, ...ChangeMeta }),
  },
  amendAttemptArtifacts: {
    path: "/v1/amendAttemptArtifacts",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      attemptId: z.string(),
      artifacts: z.array(z.string()),
      ...RevActor,
    }),
    output: z.object({ node: NodeSchema, ...ChangeMeta }),
  },
  pfUpdateCatalog: {
    path: "/v1/pfUpdateCatalog",
    input: z.object({
      sessionId: SessionIdSchema,
      entries: z.array(z.unknown()),
      ...RevActor,
    }),
    output: z.object({ ...ChangeMeta }),
  },
  pfEditArgs: {
    path: "/v1/pfEditArgs",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      patch: z.object({
        set: z.record(ArgSpecSchema).optional(),
        remove: z.array(z.string()).optional(),
      }),
      ...RevActor,
    }),
    output: z.object({
      node: NodeSchema,
      instruction: z.string(),
      ...ChangeMeta,
    }),
  },
  pfEditNode: {
    path: "/v1/pfEditNode",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      goal: z.string().min(1).optional(),
      addConstraints: z.array(ConstraintSchema).optional(),
      removeConstraintIds: z.array(z.string()).optional(),
      map: z.unknown().optional(),
      until: z.unknown().optional(),
      stateWrites: z.unknown().optional(),
      retry: z.object({ attempts: z.number().int() }).optional(),
      dependsOn: z.array(z.string()).optional(),
      ...RevActor,
    }),
    output: z.object({
      node: NodeSchema,
      instruction: z.string(),
      ...ChangeMeta,
    }),
  },
  getEvents: {
    path: "/v1/getEvents",
    input: z.object({
      sessionId: SessionIdSchema,
      sinceSeq: z.number().int().min(0).optional(),
    }),
    output: z.array(EventEntrySchema),
  },
  getSession: {
    path: "/v1/getSession",
    input: z.object({ sessionId: SessionIdSchema }),
    output: SessionSchema,
  },
  getNode: {
    path: "/v1/getNode",
    input: z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema }),
    output: NodeSchema,
  },
  getSessions: {
    path: "/v1/getSessions",
    input: z.object({}),
    output: z.object({ sessions: z.array(SessionSummarySchema) }),
  },
  getEventsPage: {
    path: "/v1/getEventsPage",
    input: z.object({
      sessionId: SessionIdSchema,
      afterRevision: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      /** M7-ui3: 노드 이력 보기 (서버측 필터) */
      nodeId: NodeIdSchema.optional(),
    }),
    output: z.object({
      events: z.array(EventEntrySchema),
      lastRevision: z.number().int().min(0),
    }),
  },
  getBlocked: {
    path: "/v1/getBlocked",
    input: z.object({ sessionId: SessionIdSchema }),
    output: z.object({
      blocked: z.array(BlockedEntrySchema),
      needsHuman: z.array(NodeIdSchema),
      revision: z.number().int().min(0),
    }),
  },
  pfBuildProcedure: {
    path: "/v1/pfBuildProcedure",
    input: z.object({ sessionId: SessionIdSchema, name: z.string() }),
    output: z.object({
      doc: ProcedureDocSchema,
      warnings: z.array(z.string()),
    }),
  },
  pfApprove: {
    path: "/v1/pfApprove",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      approved: z.boolean(),
      note: z.string().optional(),
      ...RevActor,
    }),
    output: z.object({ node: NodeSchema, ...ChangeMeta }),
  },
  pfImportProcedure: {
    path: "/v1/pfImportProcedure",
    input: z.object({
      doc: ProcedureDocSchema,
      params: z.record(z.string()).optional(),
      ...RevActor,
    }),
    output: z.object({ sessionId: SessionIdSchema }),
  },
  pfWriteGolden: {
    path: "/v1/pfWriteGolden",
    input: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      golden: z.object({
        fixtures: z.array(z.string()),
        output: z.string(),
        attemptId: z.string().uuid().optional(),
        ignore: z.array(z.string()).default([]),
      }),
      ...RevActor,
    }),
    output: z.object({ node: NodeSchema, ...ChangeMeta }),
  },
};

/** 프로토콜 버전 검사 (M6-1, 서버 측). 불일치면 conflict + 업그레이드 힌트. */
export function checkProtocolVersion(header: string | undefined): void {
  if (header !== String(PROTOCOL_VERSION)) {
    throw pfError(
      "conflict",
      `프로토콜 버전 불일치: 서버 v${PROTOCOL_VERSION} (받은 값: ${header ?? "없음"})`,
      `클라이언트·서버를 같은 버전으로 업그레이드하라 (현재 v${PROTOCOL_VERSION})`,
    );
  }
}

export type WireError = { code: string; message: string; hint?: string };

/**
 * 서버 측 에러 봉투 (M6-1). 기존 코드 체계 그대로, 스택 비노출.
 * internal은 고정 메시지만 (원인·스택을 선밖으로 내보내지 않음).
 */
export function toWireError(e: unknown): WireError {
  const code = errorCodeOf(e);
  if (code === "internal") return { code, message: "내부 오류가 발생했다." };
  const hint = (e as { hint?: unknown } | null)?.hint;
  return {
    code,
    message: e instanceof Error ? e.message : String(e),
    ...(typeof hint === "string" && hint.length > 0 ? { hint } : {}),
  };
}

/** 클라이언트 측: 봉투를 에러로 되살린다 (code 보존). */
export function throwWireError(w: WireError): never {
  const hint =
    typeof w.hint === "string" && w.hint.length > 0 ? `\nhint: ${w.hint}` : "";
  throw Object.assign(new Error(`${w.code}: ${w.message}${hint}`), {
    code: w.code,
  });
}
