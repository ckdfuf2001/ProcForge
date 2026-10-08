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

export const ArgSpecFixedSchema = z.object({
  kind: z.literal("fixed"),
  value: z.unknown(),
  /** 경로 역할 힌트 (M3.1-3). 미지정 시 inputSchema에서 추정 */
  path: z.enum(["in", "out"]).optional(),
});
export const ArgSpecVarSchema = z.object({
  kind: z.literal("var"),
  ref: z.string().min(1),
  path: z.enum(["in", "out"]).optional(),
});
export const ArgSpecGeneratedSchema = z.object({
  kind: z.literal("generated"),
  instruction: z.string().min(1),
  inputs: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  path: z.enum(["in", "out"]).optional(),
});
export const ArgSpecSchema = z.discriminatedUnion("kind", [
  ArgSpecFixedSchema,
  ArgSpecVarSchema,
  ArgSpecGeneratedSchema,
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
    path: z.string().min(1),
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
    expected: z.number().optional(),
    tolerance: z.number().min(0).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
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

export const ConstraintSchema = z.discriminatedUnion("kind", [
  ConstraintFileExistsSchema,
  ConstraintJsonPathExistsSchema,
  ConstraintEqualsSchema,
  ConstraintRegexSchema,
  ConstraintCountSchema,
  ConstraintNumericMatchSchema,
  ConstraintSchemaKindSchema,
  ConstraintLlmRubricSchema,
]);
export type Constraint = z.infer<typeof ConstraintSchema>;

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
  /** llm_rubric 판정 사유 기록 (M1.5-3) */
  rubricReasons: z.record(z.string()).optional(),
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
  iterate: z.object({ over: z.string(), as: z.string() }).optional(),
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
  retries: z.number().int().min(0).default(0),
  hash: z.string().min(1),
  locked: z.boolean().default(false),
});
export type Node = z.infer<typeof NodeSchema>;

export const ToolCatalogEntrySchema = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  schemaHash: z.string().min(1),
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
});
export type Session = z.infer<typeof SessionSchema>;

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
}): string {
  const canonical = JSON.stringify(
    sortKeysDeep({
      goal: input.goal,
      args: input.args ?? {},
      constraints: input.constraints,
      dependsOn: [...input.dependsOn].sort(),
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
