import { z } from "zod";
import { createHash } from "node:crypto";

// ---------- primitives ----------

export const NodeStatusSchema = z.enum([
  "open",
  "probing",
  "leaf",
  "split",
  "needs_human",
  "failed",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const NodeIdSchema = z
  .string()
  .regex(/^\d+(\.\d+)*$/, "Node id must be like '1', '2.1'");
export type NodeId = z.infer<typeof NodeIdSchema>;

/** 세션 id = UUID v4 (M2.6-2) */
export const SessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Session id must be UUID v4");
/** attempt id = UUID (M2.6-8) */
export const AttemptIdSchema = z.string().uuid("Attempt id must be UUID");

// ---------- ArgSpec ----------

export const PathRoleSchema = z.enum(["in", "out", "inout"]);
export type PathRole = z.infer<typeof PathRoleSchema>;

export const ArgSpecFixedSchema = z.object({
  kind: z.literal("fixed"),
  value: z.unknown(),
  /** 경로 역할 힌트 (M3.1-3, M3.2-3 inout). 미지정 시 inputSchema에서 추정 */
  path: PathRoleSchema.optional(),
});
export const ArgSpecVarSchema = z.object({
  kind: z.literal("var"),
  ref: z.string().min(1),
  path: PathRoleSchema.optional(),
});
export const ArgSpecGeneratedSchema = z.object({
  kind: z.literal("generated"),
  instruction: z.string().min(1),
  inputs: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  path: PathRoleSchema.optional(),
});
export const ArgSpecScriptSchema = z.object({
  /** 호스트 작성 스크립트 (M5.2-2). file은 workspace 상대경로(확정 시),
      finalize에서 procedures/<name>/scripts/<nodeId>.<ext>로 수집·재작성. */
  kind: z.literal("script"),
  file: z.string().min(1),
  runtime: z.enum(["python", "node"]).default("python"),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  path: PathRoleSchema.optional(),
});
export const ArgSpecSchema = z.discriminatedUnion("kind", [
  ArgSpecFixedSchema,
  ArgSpecVarSchema,
  ArgSpecGeneratedSchema,
  ArgSpecScriptSchema,
]);
export type ArgSpec = z.infer<typeof ArgSpecSchema>;

export const SideEffectSchema = z.enum(["none", "local_write", "external"]);
export type SideEffect = z.infer<typeof SideEffectSchema>;

// ---------- Constraint (M0-1 구체화) ----------

export const ConstraintKindSchema = z.enum([
  "file_exists",
  "json_path_exists",
  "equals",
  "regex",
  "count",
  "numeric_match",
  "pptx_table_sum",
  "schema",
  "llm_rubric",
]);

const ConstraintBase = z.object({
  id: z.string().min(1),
  source: z.enum(["auto", "human"]),
  note: z.string().optional(),
});

export const ConstraintFileExistsSchema = ConstraintBase.extend({
  kind: z.literal("file_exists"),
  spec: z.object({ path: z.string().min(1) }),
});
export const ConstraintJsonPathExistsSchema = ConstraintBase.extend({
  kind: z.literal("json_path_exists"),
  spec: z.object({
    path: z.string().min(1),
    jsonPointer: z.string().optional(),
    jsonPath: z.string().optional(),
  }),
});
export const ConstraintEqualsSchema = ConstraintBase.extend({
  kind: z.literal("equals"),
  spec: z.object({
    path: z.string().optional(),
    expected: z.unknown(),
    actual: z.unknown().optional(),
  }),
});
export const ConstraintRegexSchema = ConstraintBase.extend({
  kind: z.literal("regex"),
  spec: z.object({
    path: z.string().optional(),
    value: z.string().optional(),
    pattern: z.string().min(1),
    flags: z.string().optional(),
  }),
});
export const ConstraintCountSchema = ConstraintBase.extend({
  kind: z.literal("count"),
  spec: z.object({
    /** 생략 시 결과 전체 (M5.5-1 map 집계용) */
    path: z.string().min(1).optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    exact: z.number().int().min(0).optional(),
  }),
});
export const ConstraintNumericMatchSchema = ConstraintBase.extend({
  kind: z.literal("numeric_match"),
  spec: z.object({
    path: z.string().optional(),
    value: z.number().optional(),
    /** 결괏값 또는 ref ("$노드[.경로]" 약식 허용, "${params.x}") (M5.1-B2) */
    expected: z.union([z.number(), z.string()]).optional(),
    expectedRef: z.string().optional(),
    tolerance: z.number().min(0).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
});
export const ConstraintCsvRowsSchema = ConstraintBase.extend({
  kind: z.literal("csv_rows"),
  spec: z.object({
    /** run fs 상대 CSV 경로 */
    path: z.string().min(1),
    /** 비교 연산 */
    op: z.enum(["eq", "ne", "gt", "ge", "lt", "le"]),
    /** 비교값 리터럴 */
    value: z.number().optional(),
    /** 비교값 또는 ref ("$노드[.경로]", "${params.x}") (M5.1-B2) */
    expected: z.union([z.number(), z.string()]).optional(),
    expectedRef: z.string().optional(),
    tolerance: z.number().min(0).optional(),
    /** 헤더 1행 제외 (기본 true, pptx skipHeader와 동일) */
    skipHeader: z.boolean().optional(),
  }),
});
export const ConstraintSchemaKindSchema = ConstraintBase.extend({
  kind: z.literal("schema"),
  spec: z.object({ jsonSchema: z.record(z.unknown()) }),
});
export const ConstraintLlmRubricSchema = ConstraintBase.extend({
  kind: z.literal("llm_rubric"),
  spec: z.object({ rubric: z.string().min(1) }),
});

export const ConstraintPptxTableSumSchema = ConstraintBase.extend({
  kind: z.literal("pptx_table_sum"),
  spec: z.object({
    /** run fs 기준 pptx 경로 (${params.} 템플릿 허용) */
    path: z.string().min(1),
    /** 0-based 슬라이드. 생략 시 표가 있는 첫 슬라이드 */
    slide: z.number().int().min(0).optional(),
    /** 0-based 합산 열. 생략 시 마지막 열 */
    column: z.number().int().min(0).optional(),
    /** 첫 행(헤더) 제외. 기본 true */
    skipHeader: z.boolean().optional(),
    /** 고정값 또는 ref ("$노드[.경로]", "${params.x}") (M5.5-0) */
    expected: z.union([z.number(), z.string()]),
    tolerance: z.number().min(0).optional(),
  }),
});
export const ConstraintSchema = z.discriminatedUnion("kind", [
  ConstraintFileExistsSchema,
  ConstraintJsonPathExistsSchema,
  ConstraintEqualsSchema,
  ConstraintRegexSchema,
  ConstraintCountSchema,
  ConstraintNumericMatchSchema,
  ConstraintCsvRowsSchema,
  ConstraintPptxTableSumSchema,
  ConstraintSchemaKindSchema,
  ConstraintLlmRubricSchema,
]);
export type Constraint = z.infer<typeof ConstraintSchema>;

/** map 실행 명세 (M5.5-1). 템플릿은 인라인 (트리 자식 아님). */
export const MapSpecSchema = z.object({
  over: z.string().min(1),
  as: z.string().min(1).default("item"),
  maxItems: z.number().int().positive().optional(),
  policy: z
    .object({
      kind: z.enum(["all", "any", "threshold"]),
      ratio: z.number().min(0).max(1).optional(),
    })
    .default({ kind: "all" }),
  template: z.object({
    tool: z.object({ server: z.string().min(1), name: z.string().min(1) }),
    args: z.record(ArgSpecSchema),
    constraints: z.array(ConstraintSchema).default([]),
  }),
});
export type MapSpec = z.infer<typeof MapSpecSchema>;

/** until 실행 명세 (M5.5-2). 본문 템플릿 인라인 (트리 자식 아님). */
export const UntilSpecSchema = z.object({
  until: ConstraintSchema,
  maxIterations: z.number().int().positive(),
  carry: z.string().min(1).optional(),
  template: z.object({
    tool: z.object({ server: z.string().min(1), name: z.string().min(1) }),
    args: z.record(ArgSpecSchema),
    constraints: z.array(ConstraintSchema).default([]),
  }),
});
export type UntilSpec = z.infer<typeof UntilSpecSchema>;

// ---------- Tool / Attempt ----------

export const ToolRefSchema = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
});
export type ToolRef = z.infer<typeof ToolRefSchema>;

export const ToolWithSchemaSchema = ToolRefSchema.extend({
  schemaHash: z.string().min(1),
});
export type ToolWithSchema = z.infer<typeof ToolWithSchemaSchema>;

export const AttemptSchema = z.object({
  id: AttemptIdSchema,
  at: z.string().min(1),
  tool: ToolRefSchema,
  args: z.record(z.unknown()),
  resultSummary: z.string(),
  artifacts: z.array(z.string()).default([]),
  verdict: z.enum(["pass", "fail"]).optional(),
  failedConstraints: z.array(z.string()).default([]),
  /** llm_rubric (M1.5-3) */
  rubricReasons: z.record(z.string()).optional(),
  /** 실행 결과 JSON (구형 inline. 로드 시 분리 마이그레이션, 신규 저장 금지) */
  resultJson: z.unknown().optional(),
  /** 실행 결과 메타 (M5.8.2 후속: 실데이터는 로컬 attempt 파일, core는 메타만) */
  resultJsonMeta: z.object({
    sha256: z.string(),
    size: z.number().int().min(0),
    /** JSON 미리보기 (R8: 최대 4KB) */
    preview: z.string(),
  }).optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

// ---------- Node / Session ----------

export const NodeSchema = z.object({
  id: NodeIdSchema,
  parentId: NodeIdSchema.nullable(),
  goal: z.string().min(1),
  status: NodeStatusSchema,
  depth: z.number().int().min(0),
  dependsOn: z.array(NodeIdSchema).default([]),
  children: z.array(NodeIdSchema).default([]),
  tool: ToolWithSchemaSchema.optional(),
  args: z.record(ArgSpecSchema).optional(),
  /** map/until 노드 표시 (M5.5-1/2). map/until 명세와 함께 설정된다. */
  kind: z.enum(["map", "until"]).optional(),
  map: MapSpecSchema.optional(),
  until: UntilSpecSchema.optional(),
  /** 실행 간 상태 기록 선언 (M5.5-3). 성공 종료 시에만 procedures/<name>/state.json에 저장. */
  stateWrites: z.array(z.object({ key: z.string().min(1), from: z.string().min(1) })).optional(),
  /** script 재시도 선언 (M5.7-3, 멱등 opt-in. 일시 오류만, 기본 미재시도). */
  retry: z.object({ attempts: z.number().int().min(1).max(10) }).optional(),
  sideEffect: SideEffectSchema,
  constraints: z.array(ConstraintSchema).default([]),
  advice: z
    .array(z.object({ at: z.string(), text: z.string() }))
    .default([]),
  attempts: z.array(AttemptSchema).default([]),
  golden: z
    .object({
      fixtures: z.array(z.string()),
      output: z.string(),
      /** 확정 시점 pass attempt id (M3.1-5, generated 인자 출처) */
      attemptId: z.string().uuid().optional(),
      /** 출력 비교 제외 JSON 경로 (M3.1-2) */
      ignore: z.array(z.string()).default([]),
    })
    .optional(),
  /** external dry-run 승인 기록 (M2.6-4) */
  approval: z.object({ at: z.string(), note: z.string().optional() }).optional(),
  /** 사람이 수정한 인자 제안 (M4.2-2 pfEditArgs). 다음 보고 시 소진 */
  suggestedArgs: z.record(ArgSpecSchema).optional(),
  retries: z.number().int().min(0).default(0),
  hash: z.string().min(1),
  locked: z.boolean().default(false),
  /**
   * M7-ui2: stale 표시 (status에 stale이 없어 UI가 추측하지 않도록 core가 기록).
   * propagateStale이 기록하고, 재확정/재실행으로 해제된다.
   */
  staleSince: z
    .object({ revision: z.number().int().min(0), causeNodeId: NodeIdSchema })
    .optional(),
});
export type Node = z.infer<typeof NodeSchema>;

export const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const ToolCatalogEntrySchema = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  schemaHash: z.string().min(1),
  /** tools/list annotations (M3.2-3 경로 추정용) */
  annotations: ToolAnnotationsSchema.optional(),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

export const SessionSchema = z.object({
  id: SessionIdSchema,
  request: z.string().min(1),
  params: z.record(z.string()).default({}),
  toolCatalog: z.array(ToolCatalogEntrySchema),
  rootId: NodeIdSchema,
  limits: z.object({
    maxDepth: z.number().int().min(1),
    maxRetries: z.number().int().min(0),
    maxNodes: z.number().int().min(1),
  }),
  createdAt: z.string().min(1),
  /** 세션 revision (M4.2-0, R6). 구 세션은 로드 시 0으로 마이그레이션 */
  revision: z.number().int().min(0).default(0),
  /** 수집 시점 opencode 버전 (M3.6-7, 미상은 "unknown") */
  opencodeVersion: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** M7-ui1: core 세션 요약 (판단 없음. UI 목록용) */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  request: z.string(),
  revision: z.number().int().min(0),
  createdAt: z.string(),
  rootId: z.string(),
  nodeCount: z.number().int().min(0),
  rootStatus: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ---------- helpers ----------

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** M0-3: goal+args+constraints+dependsOn 해시 */
export function computeNodeHash(input: {
  goal: string;
  args?: Record<string, ArgSpec>;
  constraints: Constraint[];
  dependsOn: string[];
  map?: unknown;
  until?: unknown;
  stateWrites?: unknown;
}): string {
  const canonical = JSON.stringify(
    sortKeysDeep({
      goal: input.goal,
      args: input.args ?? {},
      constraints: input.constraints,
      dependsOn: [...input.dependsOn].sort(),
      // 미설정 시 기존 해시와 동일 (하위 호환)
      ...(input.map !== undefined ? { map: input.map } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.stateWrites !== undefined ? { stateWrites: input.stateWrites } : {}),
    }),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export const NodeStatusValues: NodeStatus[] = [
  "open",
  "probing",
  "leaf",
  "split",
  "needs_human",
  "failed",
];
