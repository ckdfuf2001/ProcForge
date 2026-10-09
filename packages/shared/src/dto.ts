import { z } from "zod";
import { SessionIdSchema } from "./schema.js";

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
