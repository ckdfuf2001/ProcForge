import type { Constraint } from "@procforge/shared/schema.js";
import {
  autoConstraints,
  decideReportVerdict,
  resultJsonMetaOf,
} from "@procforge/shared/report.js";
import { checkerEvaluate } from "./checker.js";
import { isMetaShape } from "./services/egress.js";

// M6.1-2: pfReport R8 변환 (LocalServices 측).
// 원문 resultJson이 있으면 wire에 싣기 전에 메타+로컬 판정+auto 제약으로
// 바꿔 core에는 판정만 전송한다 (평가는 local, 저장은 core).
// raw가 guard까지 가면 차단되므로, 변환이 유일한 원격 경로다.

export async function convertReportForRemote(
  body: Record<string, unknown>,
  getNode: (
    sessionId: string,
    nodeId: string,
  ) => Promise<{ constraints?: Constraint[] }>,
): Promise<Record<string, unknown>> {
  const rj = body["resultJson"];
  if (rj === undefined || isMetaShape(rj)) return body;
  const sid = body["sessionId"] as string;
  const nid = body["nodeId"] as string;
  const node = await getNode(sid, nid);
  const stored = (body["artifacts"] ?? []) as string[];
  const freshAuto = autoConstraints(
    rj,
    stored,
    body["artifactSources"] as Record<string, string> | undefined,
    body["verifiedJsonKeys"] as string[] | undefined,
  );
  const localEvaluation = decideReportVerdict({
    storedConstraints: node.constraints ?? [],
    freshAuto,
    selfVerdict: body["selfVerdict"] as "pass" | "fail",
    evaluate: checkerEvaluate,
    ctx: {
      resultSummary: body["resultSummary"] as string,
      resultJson: rj,
      artifacts: (body["artifactContents"] ?? {}) as Record<string, string>,
    },
  });
  const { resultJson: _drop, artifactContents: _drop2, ...rest } = body;
  void _drop;
  void _drop2;
  return {
    ...rest,
    resultJsonMeta: resultJsonMetaOf(rj),
    localEvaluation,
    autoConstraints: freshAuto,
  };
}
