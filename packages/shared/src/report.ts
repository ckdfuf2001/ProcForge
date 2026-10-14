import { createHash } from "node:crypto";
import type { Constraint } from "./schema.js";
import type {
  EvaluateFn,
  LocalEvaluation,
  ResultJsonMeta,
} from "./core-client.js";

// M6.1-1 (R8): resultJson 실데이터는 로컬 attempt 파일에만, core에는 메타만.
// resultJsonMetaOf·autoConstraints는 core/service.ts에서 옮김 (local도 사용).

/** 미리보기 상한 (R8: 4KB) */
export const RESULT_JSON_PREVIEW_CAP = 4096;

export function resultJsonMetaOf(v: unknown): ResultJsonMeta {
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    text = String(v);
  }
  return {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    size: Buffer.byteLength(text, "utf8"),
    preview: text.slice(0, RESULT_JSON_PREVIEW_CAP),
  };
}

/**
 * pass 결과 형태 기반 auto constraint 생성 (M1.5-2, M3.5.1-1 재생성).
 * file_exists는 attempt fixture 키가 아니라 sandbox 기준 논리 경로
 * (sources 매핑, 없으면 fixture 키 그대로). json_path_exists(result 최상위 키).
 * 최대 10개. source는 항상 auto.
 */
export function autoConstraints(
  resultJson: unknown,
  artifacts: string[],
  sources?: Record<string, string>,
  verifiedKeys?: string[],
): Constraint[] {
  const out: Constraint[] = [];
  let i = 0;
  const id = () => `auto-${i++}`;
  for (const a of artifacts) {
    if (out.length >= 10) break;
    out.push({
      id: id(),
      kind: "file_exists",
      spec: { path: sources?.[a] ?? a },
      source: "auto",
      note: "auto: first-pass shape",
    });
  }
  if (
    out.length < 10 &&
    resultJson !== null &&
    typeof resultJson === "object" &&
    !Array.isArray(resultJson)
  ) {
    for (const k of Object.keys(resultJson as Record<string, unknown>)) {
      if (out.length >= 10) break;
      if (!/^[A-Za-z0-9_.-]+$/.test(k)) continue;
      // M3.5.1-3: 확인된 키에서만 생성 (날조 키 auto 금지)
      if (verifiedKeys !== undefined && !verifiedKeys.includes(k)) continue;
      out.push({
        id: id(),
        kind: "json_path_exists",
        spec: { path: k },
        source: "auto",
        note: "auto: first-pass shape",
      });
    }
  }
  return out;
}

/**
 * verdict 계산 (M1.5-2: constraints가 비었으면 selfVerdict 사용).
 * core pfReport와 local 사전평가가 같은 함수를 쓴다 (parity).
 */
export function decideReportVerdict(args: {
  storedConstraints: Constraint[];
  freshAuto: Constraint[];
  selfVerdict: "pass" | "fail";
  evaluate: EvaluateFn;
  ctx: {
    resultSummary?: string;
    resultJson?: unknown;
    artifacts?: Record<string, string>;
  };
}): LocalEvaluation {
  const human = args.storedConstraints.filter((c) => c.source !== "auto");
  if (args.storedConstraints.length === 0) {
    const verdict = args.selfVerdict;
    return { verdict, failedConstraints: verdict === "pass" ? [] : ["self"] };
  }
  const r = args.evaluate([...human, ...args.freshAuto], {
    resultSummary: args.ctx.resultSummary,
    resultJson: args.ctx.resultJson,
    artifacts: args.ctx.artifacts,
  });
  const failedConstraints = [...r.failedConstraints];
  if (args.selfVerdict === "fail" && !failedConstraints.includes("self"))
    failedConstraints.push("self");
  return {
    verdict:
      r.verdict === "pass" && args.selfVerdict === "pass" ? "pass" : "fail",
    failedConstraints,
    unverified: r.unverified,
  };
}
