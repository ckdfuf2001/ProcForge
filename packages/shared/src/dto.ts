import { z } from "zod";
import {
  ArgSpecSchema,
  ConstraintSchema,
  NodeIdSchema,
  NodeStatusSchema,
  SessionIdSchema,
  SideEffectSchema,
  ToolCatalogEntrySchema,
  ToolRefSchema,
} from "./schema.js";
import { PROCEDURE_NAME_RE } from "./procedure.js";

// CoreClient·MCP outputSchema·UI API 공용 DTO (M4.2-0, 가이드 2절 목표 형태).
// R5: 입출력 JSON 직렬화 가능 (Date, Map, Buffer, 함수 금지).

/** 변경 주체 (R7 actor). ui는 MCP를 거치지 않는 UI 직접 호출 (M7-1-7) */
export const ActorSchema = z.enum(["host", "human", "runner", "ui"]);
export type Actor = z.infer<typeof ActorSchema>;

/** M8-ui2: 이벤트 스냅샷·특정 revision 트리에 쓰는 노드 (attempts 등 큰 필드 제외) */
export const HistoryNodeSchema = z.object({
  id: NodeIdSchema,
  parentId: NodeIdSchema.nullable(),
  goal: z.string().nullable(),
  status: NodeStatusSchema.nullable(),
  depth: z.number().int().min(0),
  children: z.array(NodeIdSchema),
  dependsOn: z.array(NodeIdSchema),
  locked: z.boolean(),
  sideEffect: SideEffectSchema.nullable(),
  staleSince: z
    .object({
      revision: z.number().int().min(0),
      causeNodeId: NodeIdSchema,
    })
    .optional(),
  hash: z.string().nullable(),
});
export type HistoryNode = z.infer<typeof HistoryNodeSchema>;

/**
 * 상태 변경 이벤트 상세 (M8-ui1).
 * split 전용 필드는 이벤트에, 공통 필드는 모든 쓰기 이벤트에 기록한다.
 */
export const EventDetailSchema = z.object({
  parentId: NodeIdSchema.optional(),
  childIds: z.array(NodeIdSchema).optional(),
  reason: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  causeAdviseIds: z.array(z.string()).optional(),
  /** 이 이벤트로 값이 바뀐 노드의 스냅샷 (변경분만, 큰 필드 제외) */
  nodesAfter: z.array(HistoryNodeSchema).optional(),
  removedIds: z.array(NodeIdSchema).optional(),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;

/** 상태 변경 이벤트 1건 (R7, events.jsonl 한 줄). seq == revision */
export const EventEntrySchema = z.object({
  seq: z.number().int().min(1),
  revision: z.number().int().min(0),
  at: z.string().min(1),
  actor: ActorSchema,
  method: z.string().min(1),
  nodeIds: z.array(z.string()),
  beforeHash: z.string(),
  afterHash: z.string(),
  summary: z.string(),
  /** M8-ui1: 패치 없는 구간은 detail 자체가 없다 (구 이벤트 호환) */
  detail: EventDetailSchema.optional(),
});
export type EventEntry = z.infer<typeof EventEntrySchema>;

/** 변경 메서드 공통 입력 */
export const ChangeInputBaseSchema = z.object({
  sessionId: SessionIdSchema,
  expectedRevision: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
});
export type ChangeInputBase = z.infer<typeof ChangeInputBaseSchema>;

/** 변경 메서드 공통 출력 */
export const MutationOutputBaseSchema = z.object({
  revision: z.number().int().min(0),
  changedNodeIds: z.array(z.string()),
  events: z.array(EventEntrySchema),
});
export type MutationOutputBase = z.infer<typeof MutationOutputBaseSchema>;

// ---------- App 메서드 입출력 DTO (M4.2-2.5-6). MCP inputSchema와 공유 ----------

const RevisionOptsSchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
});

export const StartInputSchema = z.object({
  request: z.string().min(1),
  params: z.record(z.string()).optional(),
  toolCatalog: z.array(ToolCatalogEntrySchema).optional(),
  seedFiles: z.array(z.string()).optional(),
  limits: z
    .object({
      maxDepth: z.number().int().min(1),
      maxRetries: z.number().int().min(0),
      maxNodes: z.number().int().min(1),
    })
    .optional(),
  /** MCP initialize clientInfo. 서버가 자동 기입, 모델이 직접 넣지 말 것 (M5.8.1-6) */
  clientName: z.string().optional(),
  clientVersion: z.string().optional(),
});
export type StartInput = z.infer<typeof StartInputSchema>;

export const NextInputSchema = z
  .object({ sessionId: SessionIdSchema })
  .merge(RevisionOptsSchema);
export type NextInput = z.infer<typeof NextInputSchema>;

export const ReportInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    tool: ToolRefSchema,
    args: z.record(z.unknown()),
    resultSummary: z.string(),
    resultJson: z.unknown().optional(),
    artifacts: z.array(z.string()).optional(),
    selfVerdict: z.enum(["pass", "fail"]),
    selfReason: z.string().min(1),
    rubricReasons: z.record(z.string()).optional(),
  })
  .merge(RevisionOptsSchema);
export type ReportInput = z.infer<typeof ReportInputSchema>;

export const SplitInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    children: z
      .array(
        z.object({
          goal: z.string().min(1),
          dependsOn: z.array(z.string()).optional(),
          sideEffect: z.enum(["none", "local_write", "external"]).optional(),
        }),
      )
      .min(1),
    /**
     * M8-ui1: 왜 이렇게 나눴는지 (사람이 읽고 의견을 준다).
     * zod는 형태만 본다 — 필수 여부·길이 판정은 App(사용자 경로)이
     * bad_request + 힌트로 알린다 (MCP SDK 검증 에러와 다른 봉투).
     */
    reason: z.string().optional(),
    /** M8-ui1: 버린 대안 (최대 3개) */
    alternatives: z.array(z.string()).max(3).optional(),
  })
  .merge(RevisionOptsSchema);
export type SplitInput = z.infer<typeof SplitInputSchema>;

export const ConfirmLeafInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    tool: ToolRefSchema,
    argSpecs: z.record(ArgSpecSchema),
    sideEffect: z.enum(["none", "local_write", "external"]).optional(),
    ignore: z.array(z.string()).optional(),
    /** bash leaf opt-in 선언 (절차서 단위 의도, 기본 거부. DECISIONS M5.8.1-1) */
    allowBash: z.boolean().optional(),
    /** 엄격 모드 (M5.8.2 후속: ref 검증 불가면 거부) */
    strict: z.boolean().optional(),
  })
  .merge(RevisionOptsSchema);
export type ConfirmLeafInput = z.infer<typeof ConfirmLeafInputSchema>;

export const RetryInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    reason: z.string().min(1),
  })
  .merge(RevisionOptsSchema);
export type RetryInput = z.infer<typeof RetryInputSchema>;

export const AskHumanInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    question: z.string().min(1),
    plan: z
      .object({ tool: ToolRefSchema, args: z.record(z.unknown()) })
      .optional(),
  })
  .merge(RevisionOptsSchema);
export type AskHumanInput = z.infer<typeof AskHumanInputSchema>;

export const ApproveInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    approved: z.boolean(),
    note: z.string().optional(),
  })
  .merge(RevisionOptsSchema);
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const AdviseInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    text: z.string().min(1),
    proposedConstraints: z.array(ConstraintSchema).optional(),
  })
  .merge(RevisionOptsSchema);
export type AdviseInput = z.infer<typeof AdviseInputSchema>;

export const TreeInputSchema = z.object({
  sessionId: SessionIdSchema,
  detail: z.enum(["summary", "full"]).optional(),
  nodeId: NodeIdSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.number().int().min(0).optional(),
});
export type TreeInput = z.infer<typeof TreeInputSchema>;

export const GetNodeInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
});
export type GetNodeInput = z.infer<typeof GetNodeInputSchema>;

/** M8-ui2: 분해 라운드 1건 (읽기 전용, touch 없음) */
export const DecompositionHistoryEntrySchema = z.object({
  revision: z.number().int().min(0),
  at: z.string().min(1),
  actor: ActorSchema,
  /** 부모 노드의 그 시점 스냅샷 depth 우선, 없으면 ID 세그먼트 (depthSource 참고) */
  depth: z.number().int().min(0),
  depthSource: z.enum(["snapshot", "id"]),
  parentId: NodeIdSchema,
  childIds: z.array(NodeIdSchema),
  reason: z.string().nullable(),
  alternatives: z.array(z.string()),
  causeAdviseIds: z.array(z.string()),
});
export type DecompositionHistoryEntry = z.infer<
  typeof DecompositionHistoryEntrySchema
>;

export const DecompositionHistoryInputSchema = z.object({
  sessionId: SessionIdSchema,
});
export type DecompositionHistoryInput = z.infer<
  typeof DecompositionHistoryInputSchema
>;

/** M8-ui2: 특정 revision 시점 트리 노드 (구간 미상은 null) */
export const TreeAtInputSchema = z.object({
  sessionId: SessionIdSchema,
  revision: z.number().int().min(0),
});
export type TreeAtInput = z.infer<typeof TreeAtInputSchema>;

export const TreeAtOutputSchema = z.object({
  nodes: z.array(HistoryNodeSchema),
  structureOnly: z.boolean(),
});
export type TreeAtOutput = z.infer<typeof TreeAtOutputSchema>;

export const LockInputSchema = z
  .object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema })
  .merge(RevisionOptsSchema);
export type LockInput = z.infer<typeof LockInputSchema>;

export const ReopenInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    reason: z.string().min(1),
  })
  .merge(RevisionOptsSchema);
export type ReopenInput = z.infer<typeof ReopenInputSchema>;

export const RefreshCatalogInputSchema = z.object({});
export type RefreshCatalogInput = z.infer<typeof RefreshCatalogInputSchema>;

export const TestInputSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  procedure: z
    .string()
    .regex(PROCEDURE_NAME_RE, "procedure 이름 규칙 위반")
    .optional(),
  nodeId: NodeIdSchema.optional(),
  params: z.record(z.string()).optional(),
  mode: z.enum(["record", "replay", "passthrough", "live"]).optional(),
  updateGolden: z.boolean().optional(),
  allowProjectRead: z.boolean().optional(),
  changed: z.boolean().optional(),
  junitPath: z.string().optional(),
});
export type TestInput = z.infer<typeof TestInputSchema>;

export const FinalizeInputSchema = z.object({
  sessionId: SessionIdSchema,
  name: z.string().min(1),
  force: z.boolean().optional(),
  /** 고정값 감사 실패 시 거부 (M5.1-B1) */
  strict: z.boolean().optional(),
});
export type FinalizeInput = z.infer<typeof FinalizeInputSchema>;

export const RunStartInputSchema = z.object({
  procedure: z.string().regex(PROCEDURE_NAME_RE, "procedure 이름 규칙 위반"),
  params: z.record(z.string()).optional(),
});
export type RunStartInput = z.infer<typeof RunStartInputSchema>;

export const RunNextInputSchema = z.object({
  runId: z.string().uuid(),
});
export type RunNextInput = z.infer<typeof RunNextInputSchema>;

export const RunSupplyInputSchema = z.object({
  runId: z.string().uuid(),
  nodeId: NodeIdSchema,
  value: z.unknown(),
});
export type RunSupplyInput = z.infer<typeof RunSupplyInputSchema>;
export const EditArgsInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    patch: z.object({
      set: z.record(ArgSpecSchema).optional(),
      remove: z.array(z.string()).optional(),
    }),
  })
  .merge(RevisionOptsSchema);
export type EditArgsInput = z.infer<typeof EditArgsInputSchema>;

export const EditNodeInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    goal: z.string().min(1).optional(),
    addConstraints: z.array(ConstraintSchema).optional(),
    removeConstraintIds: z.array(z.string()).optional(),
    /** map 실행 명세 (M5.5-1, kind:"map"과 함께 설정) */
    map: z.unknown().optional(),
    /** until 실행 명세 (M5.5-2, kind:"until"과 함께 설정) */
    until: z.unknown().optional(),
    /** 실행 간 상태 기록 선언 (M5.5-3) */
    stateWrites: z.unknown().optional(),
    /** script 재시도 선언 (M5.7-3, 멱등 opt-in) */
    retry: z.object({ attempts: z.number().int().min(1).max(10) }).optional(),
    /** 선행 의존 사후 편집 (M5.8.1-4, 기존 노드만·순환 거부) */
    dependsOn: z.array(z.string()).optional(),
  })
  .merge(RevisionOptsSchema);
export type EditNodeInput = z.infer<typeof EditNodeInputSchema>;
