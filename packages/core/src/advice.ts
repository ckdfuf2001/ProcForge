import type { Constraint } from "@procforge/shared/schema.js";

// 사람 조언 → constraint 변환 (core 비공개 로직. local 번들에 포함 금지)
let seq = 0;

export function adviceToConstraints(text: string): Constraint[] {
  const t = text.trim();
  const id = () => `hc-${Date.now().toString(36)}-${seq++}`;
  // "매출은 부가세 제외" 계열: 요약에 세전 기준 명시를 강제하는 regex (결정적 검사 가능)
  if (/부가세/.test(t) && /(제외|별도|미포함|세전)/.test(t)) {
    return [
      {
        id: id(),
        kind: "regex",
        spec: { path: "summary", pattern: "부가세.?제외|세전|VAT[^\\n]*excl", flags: "i" },
        source: "human",
        note: text,
      },
    ];
  }
  // "N개", "N장" 개수 언급
  const countMatch = /(\d+)\s*(개|장|슬라이드|페이지)/.exec(t);
  if (countMatch) {
    return [
      {
        id: id(),
        kind: "count",
        spec: { path: "result.items", exact: Number(countMatch[1]) },
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
