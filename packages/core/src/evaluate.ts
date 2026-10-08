import type { EvaluateFn } from "@procforge/shared/core-client.js";

export type { EvaluateFn };

/** M1 기본 evaluator: 결정적 검사를 local checker 주입 없이도 상태머신 테스트 가능하게.
 *  실제 서비스에서는 local이 checker.evaluateAll을 주입한다.
 *  기본 동작: constraints가 비어 있으면 pass, 있으면 fail.
 */
export const defaultEvaluate: EvaluateFn = (constraints) => {
  if (constraints.length === 0) return { verdict: "pass", failedConstraints: [] };
  return { verdict: "fail", failedConstraints: constraints.map((c) => c.id) };
};
