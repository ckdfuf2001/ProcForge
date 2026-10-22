import { describe, it, expect } from "vitest";
import { ActorSchema, EventEntrySchema, ChangeInputBaseSchema, MutationOutputBaseSchema, SplitInputSchema, EventDetailSchema, DecompositionHistoryEntrySchema, TreeAtOutputSchema } from "../src/dto.js";

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

  it("M8-ui1 이벤트 상세(선택) 파싱", () => {
    // detail 없는 구 이벤트도 그대로 읽힌다 (하위 호환).
    expect(EventEntrySchema.safeParse(event).success).toBe(true);
    const withDetail = {
      ...event,
      detail: {
        parentId: "1",
        childIds: ["1.1", "1.2"],
        reason: "한 번에 처리하기 어려워 나눈다.",
        alternatives: ["전부 한 번에"],
        causeAdviseIds: ["adv-1"],
        nodesAfter: [
          {
            id: "1",
            parentId: null,
            goal: "r",
            status: "split",
            depth: 0,
            children: ["1.1", "1.2"],
            dependsOn: [],
            locked: false,
            sideEffect: "none",
            hash: "h",
          },
        ],
        removedIds: ["9"],
      },
    };
    expect(EventEntrySchema.safeParse(withDetail).success).toBe(true);
    // 잘못된 노드 스냅샷은 거부된다.
    expect(
      EventDetailSchema.safeParse({ nodesAfter: [{ id: "x", parentId: null }] }).success,
    ).toBe(false);
  });

  it("M8-ui1 SplitInput은 reason·alternatives를 받는다", () => {
    const base = {
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      nodeId: "1",
      children: [{ goal: "a" }],
    };
    expect(SplitInputSchema.safeParse(base).success).toBe(true);
    expect(
      SplitInputSchema.safeParse({ ...base, reason: "이렇게 나눴다.", alternatives: ["a"] }).success,
    ).toBe(true);
    // 대안은 최대 3개.
    expect(
      SplitInputSchema.safeParse({ ...base, alternatives: ["1", "2", "3", "4"] }).success,
    ).toBe(false);
  });

  it("M8-ui2 이력·트리 출력 스키마", () => {
    const round = {
      revision: 2,
      at: "2026-10-20T00:00:00Z",
      actor: "host",
      depth: 0,
      parentId: "1",
      childIds: ["1.1"],
      reason: null,
      alternatives: [],
      causeAdviseIds: [],
      depthSource: "snapshot",
    };
    expect(DecompositionHistoryEntrySchema.safeParse(round).success).toBe(true);
    expect(DecompositionHistoryEntrySchema.safeParse({ ...round, reason: "사유" }).success).toBe(true);
    expect(
      DecompositionHistoryEntrySchema.safeParse({ ...round, depthSource: "guess" }).success,
    ).toBe(false);
    expect(TreeAtOutputSchema.safeParse({ nodes: [], structureOnly: true }).success).toBe(true);
    expect(TreeAtOutputSchema.safeParse({ nodes: [] }).success).toBe(false);
  });
});
