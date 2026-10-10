import { z } from "zod";
import {
  ArgSpecSchema,
  ConstraintSchema,
  NodeIdSchema,
  SessionIdSchema,
  ToolCatalogEntrySchema,
  ToolRefSchema,
} from "./schema.js";
import { PROCEDURE_NAME_RE } from "./procedure.js";

// CoreClient·MCP outputSchema·UI API 공용 DTO (M4.2-0, 가이드 2절 목표 형태).
// R5: 입출력 JSON 직렬화 가능 (Date, Map, Buffer, 함수 금지).

/** 변경 주체 (R7 actor) */
export const ActorSchema = z.enum(["host", "human", "runner"]);
export type Actor = z.infer<typeof ActorSchema>;

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
  limits: z.object({ maxDepth: z.number().int().min(1), maxRetries: z.number().int().min(0), maxNodes: z.number().int().min(1) }).optional(),
});
export type StartInput = z.infer<typeof StartInputSchema>;

export const NextInputSchema = z.object({ sessionId: SessionIdSchema }).merge(RevisionOptsSchema);
export type NextInput = z.infer<typeof NextInputSchema>;

export const ReportInputSchema = z.object({
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
}).merge(RevisionOptsSchema);
export type ReportInput = z.infer<typeof ReportInputSchema>;

export const SplitInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  children: z.array(z.object({
    goal: z.string().min(1),
    dependsOn: z.array(z.string()).optional(),
    sideEffect: z.enum(["none", "local_write", "external"]).optional(),
  })).min(1),
}).merge(RevisionOptsSchema);
export type SplitInput = z.infer<typeof SplitInputSchema>;

export const ConfirmLeafInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  tool: ToolRefSchema,
  argSpecs: z.record(ArgSpecSchema),
  sideEffect: z.enum(["none", "local_write", "external"]).optional(),
  ignore: z.array(z.string()).optional(),
}).merge(RevisionOptsSchema);
export type ConfirmLeafInput = z.infer<typeof ConfirmLeafInputSchema>;

export const RetryInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  reason: z.string().min(1),
}).merge(RevisionOptsSchema);
export type RetryInput = z.infer<typeof RetryInputSchema>;

export const AskHumanInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  question: z.string().min(1),
  plan: z.object({ tool: ToolRefSchema, args: z.record(z.unknown()) }).optional(),
}).merge(RevisionOptsSchema);
export type AskHumanInput = z.infer<typeof AskHumanInputSchema>;

export const ApproveInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  approved: z.boolean(),
  note: z.string().optional(),
}).merge(RevisionOptsSchema);
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const AdviseInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  text: z.string().min(1),
  proposedConstraints: z.array(ConstraintSchema).optional(),
}).merge(RevisionOptsSchema);
export type AdviseInput = z.infer<typeof AdviseInputSchema>;

export const TreeInputSchema = z.object({
  sessionId: SessionIdSchema,
  detail: z.enum(["summary", "full"]).optional(),
  nodeId: NodeIdSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.number().int().min(0).optional(),
});
export type TreeInput = z.infer<typeof TreeInputSchema>;

export const GetNodeInputSchema = z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema });
export type GetNodeInput = z.infer<typeof GetNodeInputSchema>;

export const LockInputSchema = z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema }).merge(RevisionOptsSchema);
export type LockInput = z.infer<typeof LockInputSchema>;

export const ReopenInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  reason: z.string().min(1),
}).merge(RevisionOptsSchema);
export type ReopenInput = z.infer<typeof ReopenInputSchema>;

export const RefreshCatalogInputSchema = z.object({});
export type RefreshCatalogInput = z.infer<typeof RefreshCatalogInputSchema>;

export const TestInputSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  procedure: z.string().regex(PROCEDURE_NAME_RE, "procedure 이름 규칙 위반").optional(),
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
});
export type FinalizeInput = z.infer<typeof FinalizeInputSchema>;

export const EditArgsInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  patch: z.object({
    set: z.record(ArgSpecSchema).optional(),
    remove: z.array(z.string()).optional(),
  }),
}).merge(RevisionOptsSchema);
export type EditArgsInput = z.infer<typeof EditArgsInputSchema>;

export const EditNodeInputSchema = z.object({
  sessionId: SessionIdSchema,
  nodeId: NodeIdSchema,
  goal: z.string().min(1).optional(),
  addConstraints: z.array(ConstraintSchema).optional(),
  removeConstraintIds: z.array(z.string()).optional(),
}).merge(RevisionOptsSchema);
export type EditNodeInput = z.infer<typeof EditNodeInputSchema>;
