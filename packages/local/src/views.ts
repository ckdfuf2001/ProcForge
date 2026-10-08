import { z } from "zod";
import { NodeSchema, type Constraint, type Node, type Session } from "@procforge/shared/schema.js";

// 응답 크기 축소용 요약 뷰 (M2.5-5). full 노드는 pf_get_node에서만.

export function constraintSummary(c: Constraint): string {
  const s = c.spec as Record<string, unknown>;
  switch (c.kind) {
    case "file_exists":
      return `path=${s["path"]}`;
    case "json_path_exists":
      return `path=${s["jsonPointer"] ?? s["jsonPath"] ?? s["path"]}`;
    case "equals":
      return `path=${s["path"] ?? "(value)"}`;
    case "regex":
      return `pattern=${s["pattern"]}`;
    case "count":
      return s["exact"] !== undefined ? `exact=${s["exact"]}` : `min=${s["min"] ?? "-"} max=${s["max"] ?? "-"}`;
    case "numeric_match":
      return s["expected"] !== undefined ? `expected=${s["expected"]}` : `min=${s["min"] ?? "-"} max=${s["max"] ?? "-"}`;
    case "schema":
      return "json-schema";
    case "llm_rubric":
      return `rubric=${String(s["rubric"]).slice(0, 40)}`;
  }
}

export const ConstraintSummarySchema = z.object({ id: z.string(), kind: z.string(), summary: z.string() });
export const AttemptSummarySchema = z.object({
  id: z.string(),
  at: z.string(),
  tool: z.object({ server: z.string(), name: z.string() }),
  verdict: z.enum(["pass", "fail"]).optional(),
  failedConstraints: z.array(z.string()),
});
export const NodeSummarySchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.string(),
  depth: z.number(),
  dependsOn: z.array(z.string()),
  constraints: z.array(ConstraintSummarySchema),
  advice: z.array(z.object({ at: z.string(), text: z.string() })),
  lastAttempt: AttemptSummarySchema.nullable(),
  retriesLeft: z.number(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

/** 총 시도 횟수 = maxRetries + 1 기준 잔여 횟수 */
export function retriesLeft(node: Node, limits: Session["limits"]): number {
  return Math.max(0, limits.maxRetries + 1 - node.attempts.length);
}

export function nodeSummary(node: Node, limits: Session["limits"]): NodeSummary {
  const last = node.attempts[node.attempts.length - 1];
  return {
    id: node.id,
    goal: node.goal,
    status: node.status,
    depth: node.depth,
    dependsOn: node.dependsOn,
    constraints: node.constraints.map((c) => ({ id: c.id, kind: c.kind, summary: constraintSummary(c) })),
    advice: node.advice,
    lastAttempt: last
      ? { id: last.id, at: last.at, tool: last.tool, verdict: last.verdict, failedConstraints: last.failedConstraints }
      : null,
    retriesLeft: retriesLeft(node, limits),
  };
}

// ---- 도구별 outputSchema (계약 테스트와 공유) ----

export const ErrorEnvelopeShape = z.object({
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
});

export const PfStartOutputSchema = z.object({
  sessionId: z.string(),
  node: NodeSummarySchema,
  instruction: z.string(),
  warnings: z.array(z.string()),
  sessionExpiresInDays: z.number(),
});
export const PfNextOutputSchema = z.object({
  done: z.boolean(),
  node: NodeSummarySchema.optional(),
  instruction: z.string().optional(),
});
export const PfReportOutputSchema = z.object({
  verdict: z.enum(["pass", "fail", "unverifiable"]),
  failedConstraints: z.array(z.string()),
  unverified: z.array(z.string()).optional(),
  instruction: z.string(),
});
export const PfSplitOutputSchema = z.object({
  node: NodeSummarySchema,
  created: z.array(NodeSummarySchema),
  instruction: z.string(),
});
export const PfConfirmLeafOutputSchema = z.object({ node: NodeSummarySchema, instruction: z.string() });
export const PfRetryOutputSchema = z.object({ node: NodeSummarySchema, instruction: z.string() });
export const PfAskHumanOutputSchema = z.object({ node: NodeSummarySchema, instruction: z.string() });
export const PfAdviseOutputSchema = z.object({
  constraints: z.array(ConstraintSummarySchema),
  node: NodeSummarySchema,
});
export const TreeEntrySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  goal: z.string(),
  status: z.string(),
  node: NodeSchema.optional(),
});
export const PfTreeOutputSchema = z.object({
  entries: z.array(TreeEntrySchema),
  counts: z.record(z.number()),
  hasMore: z.boolean(),
  nextCursor: z.number().nullable(),
});
export const PfGetNodeOutputSchema = z.object({ node: NodeSchema });
export const PfLockOutputSchema = z.object({ node: NodeSummarySchema });
export const PfReopenOutputSchema = z.object({ node: NodeSummarySchema });
export const PfApproveOutputSchema = z.object({ node: NodeSummarySchema });
export const CatalogEntrySummarySchema = z.object({ server: z.string(), name: z.string(), schemaHash: z.string() });
export const PfRefreshCatalogOutputSchema = z.object({
  entries: z.array(CatalogEntrySummarySchema),
  warnings: z.array(z.string()),
  cached: z.boolean(),
});
export const PfTestOutputSchema = z.object({
  runId: z.string(),
  mode: z.string(),
  passed: z.number(),
  failed: z.number(),
  unverified: z.number(),
  skipped: z.number(),
  blocked: z.number(),
  reportPath: z.string(),
});

export const OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  pf_start: PfStartOutputSchema,
  pf_next: PfNextOutputSchema,
  pf_report: PfReportOutputSchema,
  pf_split: PfSplitOutputSchema,
  pf_confirm_leaf: PfConfirmLeafOutputSchema,
  pf_retry: PfRetryOutputSchema,
  pf_ask_human: PfAskHumanOutputSchema,
  pf_advise: PfAdviseOutputSchema,
  pf_tree: PfTreeOutputSchema,
  pf_get_node: PfGetNodeOutputSchema,
  pf_lock: PfLockOutputSchema,
  pf_reopen: PfReopenOutputSchema,
  pf_approve: PfApproveOutputSchema,
  pf_refresh_catalog: PfRefreshCatalogOutputSchema,
  pf_test: PfTestOutputSchema,
};
