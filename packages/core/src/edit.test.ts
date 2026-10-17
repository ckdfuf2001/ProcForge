import { describe, it, expect } from "vitest";
import type { Node, Constraint } from "@procforge/shared/schema.js";
import { applyEdit, GOAL_MAX_LEN } from "./edit.js";

// M7-ui4-f: applyEdit는 **순수 함수**다.
// - 저장소를 몰라도 되고, 시각도 몰라도 된다.
// - 실패하면 부분 적용 객체를 돌려주지 않는다.
// - previewEdit와 pfEditNode가 이 함수 하나를 공유한다 (동치는 local 테스트).

const fail = (msg: string): never => {
  throw new Error(msg);
};

const node = (over: Partial<Node> = {}): Node =>
  ({
    id: "1.1",
    parentId: "1",
    goal: "목표",
    status: "open",
    depth: 1,
    dependsOn: [],
    attempts: 0,
    retriesLeft: 2,
    locked: false,
    sideEffect: "none",
    constraints: [],
    advice: [],
    attemptsList: [],
    children: [],
    hash: "h0",
    ...over,
  }) as unknown as Node;

const c = (id: string): Constraint =>
  ({ id, source: "human", kind: "equals", spec: { path: "/x", expected: id } }) as Constraint;

describe("M7-ui4-f applyEdit 순수성·검증", () => {
  it("원본 노드를 바꾸지 않는다 (복사본 반환)", () => {
    const n = node({ constraints: [c("a")], goal: "원래" });
    const r = applyEdit(n, { goal: "바뀐", addConstraints: [c("b")] }, { fail });
    expect(r.next).not.toBe(n);
    expect(n.goal).toBe("원래");
    expect(n.constraints).toHaveLength(1);
    expect(r.next.goal).toBe("바뀐");
    expect(r.next.constraints.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("빈 변경·빈 goal·공백 goal·상한 초과는 거절", () => {
    const n = node();
    expect(() => applyEdit(n, {}, { fail })).toThrow(/변경 내용 없음/);
    expect(() => applyEdit(n, { goal: "" }, { fail })).toThrow(/goal이 비어/);
    expect(() => applyEdit(n, { goal: "   " }, { fail })).toThrow(/goal이 비어/);
    expect(() => applyEdit(n, { goal: "x".repeat(GOAL_MAX_LEN + 1) }, { fail })).toThrow(
      /상한 초과/,
    );
  });

  it("중복 constraint는 조용히 버리지 않고 거절", () => {
    const n = node({ constraints: [c("dup")] });
    expect(() => applyEdit(n, { addConstraints: [c("dup")] }, { fail })).toThrow(
      /duplicate constraint/,
    );
  });

  it("존재하지 않는 constraint 제거는 거절", () => {
    const n = node({ constraints: [c("a")] });
    expect(() => applyEdit(n, { removeConstraintIds: ["nope"] }, { fail })).toThrow(
      /unknown constraint/,
    );
  });

  it("의존 제약은 dependsOn 비우기 금지", () => {
    expect(() => applyEdit(node({ dependsOn: ["1.2"] }), { dependsOn: [] }, { fail })).toThrow(
      /dependsOn 비우기 금지/,
    );
  });

  it("leaf + goal 변경 → open 재오픈 (split 은 그대로)", () => {
    expect(applyEdit(node({ status: "leaf" }), { goal: "x" }, { fail }).next.status).toBe(
      "open",
    );
    expect(applyEdit(node({ status: "split" }), { goal: "x" }, { fail }).next.status).toBe(
      "split",
    );
    expect(applyEdit(node({ status: "needs_human" }), { goal: "x" }, { fail }).next.status).toBe(
      "open",
    );
  });

  it("같은 값을 넣으면 changed=false", () => {
    const n = node({ goal: "같은", constraints: [c("a")] });
    expect(applyEdit(n, { goal: "같은" }, { fail }).changed).toBe(false);
    expect(applyEdit(n, { goal: "다른" }, { fail }).changed).toBe(true);
    expect(() => applyEdit(n, { addConstraints: [c("a")] }, { fail })).toThrow();
  });

  it("인자 patch는 확정 인자가 없으면 거절", () => {
    expect(
      () => applyEdit(node(), { patch: { set: { path: { kind: "fixed", value: "a" } } } }, { fail }),
    ).toThrow(/확정된 인자가 없어/);
  });
});