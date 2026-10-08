import type { Constraint } from "@procforge/shared/schema.js";

export type EvaluateFn = (
  constraints: Constraint[],
  ctx: { resultSummary?: string; resultJson?: unknown; artifacts?: Record<string, string> },
) => { verdict: "pass" | "fail"; failedConstraints: string[]; unverified?: string[] };

/** M1 기본 evaluator: 결정적 검사를 local checker 주입 없이도 상태머신 테스트 가능하게.
 *  실제 서비스에서는 local이 checker.evaluateAll을 주입한다.
 *  기본 동작: constraints가 비어 있으면 pass, 있으면 fail-closed가 아니라
 *  resultSummary가 비어 있지 않으면 pass로 간주하지 않고 fail로 둔다?
 *  M1 테스트 단순화를 위해: constraints가 없으면 pass, 있으면 fail (호출자가 주입하도록 유도).
 *  단 테스트에서 제약을 걸고 통과시키고 싶으면 주입을 사용한다.
 */
export const defaultEvaluate: EvaluateFn = (constraints) => {
  if (constraints.length === 0) return { verdict: "pass", failedConstraints: [] };
  return { verdict: "fail", failedConstraints: constraints.map((c) => c.id) };
};
