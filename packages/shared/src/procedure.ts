import { z } from "zod";

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
  params: z.record(z.object({ type: z.string(), default: z.string(), description: z.string() })),
  toolCatalog: z.array(z.object({
    server: z.string(),
    name: z.string(),
    inputSchema: z.record(z.unknown()),
    schemaHash: z.string(),
  })),
  nodes: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    goal: z.string(),
    depth: z.number(),
    dependsOn: z.array(z.string()),
    children: z.array(z.string()),
    tool: z.object({ server: z.string(), name: z.string(), schemaHash: z.string() }).optional(),
    args: z.record(z.unknown()).optional(),
    sideEffect: z.enum(["none", "local_write", "external"]),
    constraints: z.array(z.unknown()),
    golden: z.object({
      fixtures: z.array(z.string()),
      output: z.string(),
      attemptId: z.string().optional(),
      ignore: z.array(z.string()).default([]),
    }).optional(),
    goldenArgs: z.record(z.unknown()).optional(),
  })),
});
export type ProcedureDoc = z.infer<typeof ProcedureDocSchema>;
