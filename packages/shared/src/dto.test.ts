import { describe, it, expect } from "vitest";
import { ActorSchema, EventEntrySchema, ChangeInputBaseSchema, MutationOutputBaseSchema } from "../src/dto.js";

const event = {
  seq: 1,
  revision: 1,
  at: "2026-10-09T00:00:00Z",
  actor: "host",
  method: "pfReport",
  nodeIds: ["1.1"],
  beforeHash: "a",
  afterHash: "b",
  summary: "report pass",
};

describe("dto", () => {
  it("M4.2-0 EventEntry 스키마", () => {
    expect(EventEntrySchema.safeParse(event).success).toBe(true);
    expect(EventEntrySchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(EventEntrySchema.safeParse({ ...event, actor: "bot" }).success).toBe(false);
    expect(ActorSchema.safeParse("human").success).toBe(true);
  });

  it("M4.2-0 변경 입출력 envelope", () => {
    expect(ChangeInputBaseSchema.safeParse({ sessionId: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(true);
    expect(ChangeInputBaseSchema.safeParse({ sessionId: "nope" }).success).toBe(false);
    expect(
      MutationOutputBaseSchema.safeParse({ revision: 3, changedNodeIds: ["1.1"], events: [event] }).success,
    ).toBe(true);
  });
});
