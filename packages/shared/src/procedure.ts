import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ToolAnnotationsSchema, computeNodeHash } from "./schema.js";
import type { ArgSpec, Constraint, Node, Session } from "./schema.js";
import { pfError } from "./errors.js";

// 절차서 문서 DTO (M4.2-1, core pfBuildProcedure ↔ local procedureWriter 공용).
// JSON 직렬화 가능 (R5).

/** 절차 이름 규칙 (M4.1-6, skill 호환): 소문자·숫자·하이픈, 1~64자 */
export const PROCEDURE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ProcedureDocSchema = z.object({
  format: z.literal("procforge-procedure"),
  version: z.literal(1),
  name: z.string().min(1),
  sourceSession: z.string(),
  createdAt: z.string(),
  params: z.record(
    z.object({
      type: z.string(),
      default: z.string().optional(),
      required: z.boolean().optional(),
      description: z.string(),
    }),
  ),
  toolCatalog: z.array(
    z.object({
      server: z.string(),
      name: z.string(),
      inputSchema: z.record(z.unknown()),
      schemaHash: z.string(),
      // M5.6-f: readOnlyHint 등 실행 시점 힌트 유지 (runSession catalogReadOnly용).
      annotations: ToolAnnotationsSchema.optional(),
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable(),
      goal: z.string(),
      depth: z.number(),
      dependsOn: z.array(z.string()),
      children: z.array(z.string()),
      tool: z
        .object({
          server: z.string(),
          name: z.string(),
          schemaHash: z.string(),
        })
        .optional(),
      args: z.record(z.unknown()).optional(),
      kind: z.enum(["map", "until"]).optional(),
      map: z.unknown().optional(),
      until: z.unknown().optional(),
      stateWrites: z
        .array(z.object({ key: z.string(), from: z.string() }))
        .optional(),
      sideEffect: z.enum(["none", "local_write", "external"]),
      retry: z.object({ attempts: z.number().int().min(1).max(10) }).optional(),
      constraints: z.array(z.unknown()),
      golden: z
        .object({
          fixtures: z.array(z.string()),
          output: z.string(),
          attemptId: z.string().optional(),
          ignore: z.array(z.string()).default([]),
        })
        .optional(),
      goldenArgs: z.record(z.unknown()).optional(),
    }),
  ),
});
export type ProcedureDoc = z.infer<typeof ProcedureDocSchema>;

/**
 * procedure.json → 실행용 세션·노드 조립 (M6.1-2, 순수).
 * 파일 복사(procedures/→sessions/)는 local이 담당, core는 저장만.
 * local importProcedure와 core pfImportProcedure가 같은 함수를 쓴다.
 */
export function buildImportSession(
  doc: ProcedureDoc,
  params: Record<string, string> = {},
  sessionId?: string,
): { session: Session; nodes: Node[] } {
  const parsed = ProcedureDocSchema.parse(doc);
  const defaults: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.params)) {
    if (v.default !== undefined) defaults[k] = v.default;
  }
  // M5.3.1-3: required params 미지정 시 실행 전 bad_request.
  const missing = Object.entries(parsed.params)
    .filter(
      ([k, v]) =>
        v.required === true && v.default === undefined && !(k in params),
    )
    .map(([k]) => k);
  if (missing.length > 0) {
    throw pfError(
      "bad_request",
      `필수 params 누락: ${missing.join(",")} (--param으로 지정하라)`,
    );
  }
  const sid = sessionId ?? randomUUID();
  const session: Session = {
    id: sid,
    request: `import:${parsed.name}`,
    params: { ...defaults, ...params },
    toolCatalog: parsed.toolCatalog as Session["toolCatalog"],
    rootId:
      parsed.nodes.find((n) => n.parentId === null)?.id ??
      parsed.nodes[0]?.id ??
      "1",
    limits: { maxDepth: 20, maxRetries: 2, maxNodes: 500 },
    createdAt: new Date().toISOString(),
    revision: 0,
  };
  const nodes: Node[] = parsed.nodes.map((n) => {
    const lastArgs = (n.goldenArgs ?? {}) as Record<string, unknown>;
    const attemptId = n.golden?.attemptId ?? randomUUID();
    return {
      id: n.id,
      parentId: n.parentId,
      goal: n.goal,
      status: (n.tool
        ? "leaf"
        : n.children.length > 0
          ? "split"
          : "open") as Node["status"],
      depth: n.depth,
      dependsOn: n.dependsOn,
      children: n.children,
      tool: n.tool ? { ...n.tool } : undefined,
      args: (n.args ?? {}) as Record<string, ArgSpec>,
      ...(n.kind === "map" ? { kind: "map" as const } : {}),
      ...(n.kind === "until" ? { kind: "until" as const } : {}),
      ...(n.map !== undefined ? { map: n.map as Node["map"] } : {}),
      ...(n.until !== undefined ? { until: n.until as Node["until"] } : {}),
      ...(n.stateWrites !== undefined
        ? { stateWrites: n.stateWrites as Node["stateWrites"] }
        : {}),
      ...(n.retry !== undefined ? { retry: n.retry as Node["retry"] } : {}),
      sideEffect: n.sideEffect,
      constraints: (n.constraints ?? []) as Constraint[],
      advice: [],
      attempts: n.tool
        ? [
            {
              id: attemptId,
              at: parsed.createdAt,
              tool: { server: n.tool.server, name: n.tool.name },
              args: lastArgs,
              resultSummary: n.golden?.output ?? "",
              artifacts: n.golden?.fixtures ?? [],
              verdict: "pass" as const,
              failedConstraints: [],
            },
          ]
        : [],
      golden: n.golden
        ? {
            fixtures: [...n.golden.fixtures],
            output: n.golden.output,
            attemptId,
            ignore: n.golden.ignore ?? [],
          }
        : undefined,
      retries: 0,
      hash: computeNodeHash({
        goal: n.goal,
        args: (n.args ?? {}) as Record<string, ArgSpec>,
        constraints: (n.constraints ?? []) as Constraint[],
        dependsOn: [],
      }),
      locked: false,
    };
  });
  return { session, nodes };
}
