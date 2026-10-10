import type { ArgSpec, Constraint, Node } from "@procforge/shared/schema.js";

// finalize 고정값 감사 (M5.1-B1). 확정 시점에 박힌 값 중 params·날짜·녹화 수치를 검출.
// - fixed 인자의 params 부분 일치는 core 경고가 담당 (중복 방지: 여기서는 제외).
// - constraint spec 값은 human/auto 모두 검사 (params 부분 일치 포함).
// - 날짜 표현·녹화 응답 수치는 fixed 인자 + constraint spec 모두 검사.
// - 수치 역치는 4자리 이상 정수 (인덱스·개수·tolerance 오탐 방지).

const DATE_RES = [
  /\b(19|20)\d{2}-(0?[1-9]|1[0-2])\b/,
  /(19|20)\d{2}년\s?\d{1,2}월/,
  /(?:^|[^\d])\d{1,2}월/,
  /\b(19|20)\d{2}(0[1-9]|1[0-2])\b/,
];

function isDateLike(s: string): boolean {
  return DATE_RES.some((re) => re.test(s));
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
  const paramEntries = Object.entries(input.params).filter(([, v]) => v.length >= 3);
  const checkScalar = (nodeId: string, where: string, value: string | number, checkParams: boolean): void => {
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
      if (num !== undefined && Math.abs(num) >= 1000 && (recNums.get(nodeId) ?? new Set()).has(num)) {
        push(nodeId, where, value, "녹화 응답 수치와 일치");
      }
    } else if (Math.abs(value) >= 1000 && (recNums.get(nodeId) ?? new Set()).has(value)) {
      push(nodeId, where, String(value), "녹화 응답 수치와 일치");
    }
  };
  for (const n of input.nodes) {
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as ArgSpec;
      if (s.kind !== "fixed") continue;
      const scalars: Scalar[] = [];
      deepScalars((s as { value: unknown }).value, scalars, k);
      for (const { value, path } of scalars) checkScalar(n.id, path, value, false);
    }
    for (const c of n.constraints ?? []) {
      const cc = c as Constraint;
      // 시스템 생성 fixture 경로는 감사 제외 (uuid 오탐 방지). 논리 경로(source rel)는 검사.
      const specPath = (cc as unknown as { spec?: { path?: unknown } }).spec?.path;
      if (cc.kind === "file_exists" && typeof specPath === "string" && specPath.startsWith("fixtures/")) continue;
      const scalars: Scalar[] = [];
      deepScalars((c as unknown as { spec?: unknown }).spec, scalars, `constraints.${(c as Constraint).id}`);
      for (const { value, path } of scalars) checkScalar(n.id, path, value, true);
    }
  }
  return findings;
}
