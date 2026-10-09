import type { Constraint } from "@procforge/shared/schema.js";

// 사람 조언 → constraint 변환 (core 비공개 로직. local 번들에 포함 금지)
let seq = 0;

export function adviceToConstraints(text: string): Constraint[] {
  const t = text.trim();
  const id = () => `hc-${Date.now().toString(36)}-${seq++}`;
  // "N개", "N장" 개수 언급 → 결과 JSON의 items 배열 길이로 검사 (M2 가정, DECISIONS 참조)
  const countMatch = /(\d+)\s*(개|장|슬라이드|페이지)/.exec(t);
  if (countMatch) {
    return [
      {
        id: id(),
        kind: "count",
        spec: { path: "items", exact: Number(countMatch[1]) },
        source: "human",
        note: text,
      },
    ];
  }
  // 파일 존재 언급
  if (/파일|생성|저장|출력/.test(t)) {
    const pathMatch = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/.exec(t);
    if (pathMatch) {
      return [{ id: id(), kind: "file_exists", spec: { path: pathMatch[1] }, source: "human", note: text }];
    }
  }
  // 변환 불가 → llm_rubric
  return [{ id: id(), kind: "llm_rubric", spec: { rubric: t }, source: "human", note: text }];
}

/**
 * 금액 비교 조언 감지 (M4). 부가세 regex 변환(M1.5)은 문구 검사에 불과하므로 제거.
 * 해당 조언은 llm_rubric로 저장하고, pfAdvise 응답에서 numeric_match(expectedRef)
 * 제안을 안내한다.
 */
export function suggestsNumericRef(text: string): boolean {
  return /부가세|세전|세후|금액|합계/.test(text);
}
