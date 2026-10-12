import type { ArgSpec, Constraint, Node } from "@procforge/shared/schema.js";

// finalize 고정값 감사 (M5.1-B1). 확정 시점에 박힌 값 중 params·날짜·녹화 수치를 검출.
// - fixed 인자의 params 부분 일치는 core 경고가 담당 (중복 방지: 여기서는 제외).
// - constraint spec 값은 human/auto 모두 검사 (params 부분 일치 포함).
// - 날짜 표현·녹화 응답 수치는 fixed 인자 + constraint spec 모두 검사.
// - 수치 역치는 4자리 이상 정수 (인덱스·개수·tolerance 오탐 방지).
// - M5.1-B1 정밀화 (C1 dogfood 교정):
//   R1 numeric_match의 expected/expectedRef/min/max는 검사값이므로 녹화 수치
//      일치에서 면제 (params 부분 일치·날짜 검사는 유지).
//   R2 노드 자신의 resultJson/resultSummary에 그대로 있는 값(미러)은
//      결정성(원인==결과)이므로 자기 노드 녹화 수치 일치에서 면제 (params·날짜 유지).
// - M5.2-3 값 흐름: fixed 값이 다른 노드 녹화 출력과 일치하면 면제 없이 경고
//   (ref 후보). R2 미러 면제는 자기 노드 녹화에만 적용.

const DATE_RES = [
  /\b(19|20)\d{2}-(0?[1-9]|1[0-2])\b/,
  /(19|20)\d{2}년\s?\d{1,2}월/,
  /(?:^|[^\d])\d{1,2}월/,
  /\b(19|20)\d{2}(0[1-9]|1[0-2])\b/,
];

function isDateLike(s: string): boolean {
  return DATE_RES.some((re) => re.test(s));
}

export { isDateLike };

/** M5.7-1: 출력 단언 constraint 종류 (결정적 kind만. llm_rubric 제외). */
export const OUTPUT_ASSERT_KINDS: ReadonlySet<string> = new Set([
  "equals",
  "count",
  "numeric_match",
  "json_path_exists",
  "regex",
  "pptx_table_sum",
  "schema",
]);

/**
 * M5.6-g: 누적(stateWrites) 노드 출력 단언 감사.
 * stateWrites가 있는데 human 출력 단언 제약이 하나도 없으면 경고를 남긴다
 * (빈 누적 결과가 그대로 통과하는 것을 막기 위함. auto 제약은 존재 확인에
 * 불과하므로 인정하지 않음).
 */
export function auditStateWrites(
  nodes: { id: string; constraints?: { kind?: string; source?: string }[]; stateWrites?: { key: string; from: string }[] }[],
): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const sw = n.stateWrites;
    if (!Array.isArray(sw) || sw.length === 0) continue;
    const asserted = (n.constraints ?? []).some(
      (c) => c.source === "human" && OUTPUT_ASSERT_KINDS.has(c.kind ?? ""),
    );
    if (!asserted) {
      out.push(
        `stateWrites 출력 단언 없음: ${n.id} (state ${sw.map((e) => e.key).join(",")}) — 누적 결과가 비어도 통과한다. count 등 출력 제약을 추가하라.`,
      );
    }
  }
  return out;
}

/**
 * M5.7.1: 절차서에 llm_rubric constraint가 남아 있으면 finalize 경고.
 * 무인 실행에서는 해당 노드가 unverified → exit 1이 되므로 결정적
 * constraint로 교체하도록 안내한다. strict면 호출 측에서 거부한다.
 */
export function auditRubricConstraints(
  nodes: { id: string; constraints?: { id?: string; kind?: string }[] }[],
): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const ids = (n.constraints ?? [])
      .filter((c) => c.kind === "llm_rubric")
      .map((c) => c.id ?? "?");
    if (ids.length > 0) {
      out.push(
        `llm_rubric 잔존: ${n.id} (${ids.join(",")}) — 무인 실행 시 이 노드는 unverified → exit 1. 결정적 constraint(count·file_exists·json_path·numeric_match 등)로 바꾸라.`,
      );
    }
  }
  return out;
}

/** 텍스트 속 첫 날짜 표현 샘플 (없으면 null) */
export function findDateSample(text: string): string | null {
  const m = text.match(
    /(19|20)\d{2}-(0?[1-9]|1[0-2])\b|(19|20)\d{2}년\s?\d{1,2}월|(?:^|[^\d])\d{1,2}월|\b(19|20)\d{2}(0[1-9]|1[0-2])\b/,
  );
  if (!m) return null;
  const sample = m[0].trim().slice(0, 40);
  return isDateLike(sample) ? sample : null;
}

/** 기록된 응답 속 수치 상수 집합 (4자리 이상 정수) */
export function recordedNumbers(entries: { response: { summary: string; json?: unknown } }[]): Set<number> {
  const out = new Set<number>();
  const grabText = (t: string): void => {
    for (const m of t.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isInteger(n) && Math.abs(n) >= 1000) out.add(n);
    }
  };
  for (const e of entries) {
    grabText(e.response.summary);
    grabText(JSON.stringify(e.response.json ?? null));
  }
  return out;
}

function numValue(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const t = v.replace(/,/g, "").trim();
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return undefined;
}

type Scalar = { value: string | number; path: string };
function deepScalars(v: unknown, out: Scalar[], base: string): void {
  if (typeof v === "string" || typeof v === "number") {
    out.push({ value: v, path: base });
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => deepScalars(x, out, `${base}[${i}]`));
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      deepScalars(x, out, base ? `${base}.${k}` : k);
    }
  }
}

export function auditFixedValues(input: {
  params: Record<string, string>;
  nodes: Node[];
  cassettes: Map<string, { response: { summary: string; json?: unknown } }[]>;
}): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  const push = (nodeId: string, where: string, value: string, reason: string): void => {
    const key = `${nodeId}\0${where}\0${value}\0${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(`${nodeId}.${where}="${value}": ${reason} (var 후보)`);
  };
  const recNums = new Map<string, Set<number>>();
  for (const [nid, entries] of input.cassettes) recNums.set(nid, recordedNumbers(entries));
  // R2: 노드 자신의 attempt 결과물에 그대로 있는 수치 (미러)
  const mirrorOf = (n: Node): Set<number> => {
    const out = new Set<number>();
    const atts = (n as unknown as { attempts?: { resultJson?: unknown; resultSummary?: string }[] }).attempts ?? [];
    for (const a of atts) {
      const scalars: Scalar[] = [];
      deepScalars(a.resultJson, scalars, "");
      for (const { value } of scalars) {
        const num = numValue(value);
        if (num !== undefined) out.add(num);
      }
      for (const m of String(a.resultSummary ?? "").matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
        const num = numValue(m[0]);
        if (num !== undefined) out.add(num);
      }
    }
    return out;
  };
  const paramEntries = Object.entries(input.params).filter(([, v]) => v.length >= 3);
  /** 다른 노드 녹화 집합에 포함된 노드 id (M5.2-3 값 흐름) */
  const crossHits = (nodeId: string, num: number): string[] => {
    const out: string[] = [];
    for (const [nid, set] of recNums) {
      if (nid !== nodeId && set.has(num)) out.push(nid);
    }
    return out;
  };
  const checkScalar = (
    nodeId: string, where: string, value: string | number, checkParams: boolean,
    opts: { mirror: Set<number>; bound: boolean },
  ): void => {
    if (typeof value === "string") {
      if (checkParams) {
        for (const [pk, pv] of paramEntries) {
          if (value.includes(pv)) {
            push(nodeId, where, value, `params "${pk}" 값 포함`);
            break;
          }
        }
      }
      if (isDateLike(value)) push(nodeId, where, value, "날짜 표현");
      const num = numValue(value);
      if (num === undefined || Math.abs(num) < 1000) return;
      if (!opts.bound && !opts.mirror.has(num) && (recNums.get(nodeId) ?? new Set()).has(num)) {
        push(nodeId, where, value, "녹화 응답 수치와 일치");
      }
      // M5.2-3: fixed 값이 다른 노드 녹화 출력과 일치하면 면제 없이 경고 (ref 후보)
      if (!checkParams) {
        const hit = crossHits(nodeId, num);
        if (hit.length > 0) push(nodeId, where, value, `다른 노드(${hit.join(",")}) 녹화 출력과 일치 (ref 후보)`);
      }
    } else if (Math.abs(value) >= 1000) {
      if (!opts.bound && !opts.mirror.has(value) && (recNums.get(nodeId) ?? new Set()).has(value)) {
        push(nodeId, where, String(value), "녹화 응답 수치와 일치");
      }
      if (!checkParams) {
        const hit = crossHits(nodeId, value);
        if (hit.length > 0) push(nodeId, where, String(value), `다른 노드(${hit.join(",")}) 녹화 출력과 일치 (ref 후보)`);
      }
    }
  };
  // M5.2-4: numeric expected 고정 숫자는 감사 대상 (ref 권장).
  // 면제는 expectedRef/min/max만 유지 (R1 축소).
  const NUMERIC_BOUND_FIELDS = new Set(["expectedRef", "min", "max"]);
  for (const n of input.nodes) {
    const mirror = mirrorOf(n);
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as ArgSpec;
      if (s.kind !== "fixed") continue;
      const scalars: Scalar[] = [];
      deepScalars((s as { value: unknown }).value, scalars, k);
      for (const { value, path } of scalars) checkScalar(n.id, path, value, false, { mirror, bound: false });
    }
    for (const c of n.constraints ?? []) {
      const cc = c as Constraint;
      // 시스템 생성 fixture 경로는 감사 제외 (uuid 오탐 방지). 논리 경로(source rel)는 검사.
      const specPath = (cc as unknown as { spec?: { path?: unknown } }).spec?.path;
      if (cc.kind === "file_exists" && typeof specPath === "string" && specPath.startsWith("fixtures/")) continue;
      const scalars: Scalar[] = [];
      deepScalars((c as unknown as { spec?: unknown }).spec, scalars, `constraints.${(c as Constraint).id}`);
      for (const { value, path } of scalars) {
        // R1: numeric_match 검사값 필드는 녹화 수치 일치에서 면제
        const field = path.split(".").pop() ?? "";
        const bound = cc.kind === "numeric_match" && NUMERIC_BOUND_FIELDS.has(field);
        checkScalar(n.id, path, value, true, { mirror, bound });
      }
    }
  }
  return findings;
}
