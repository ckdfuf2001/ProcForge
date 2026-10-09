// 출력 정규화 비교 (M3.1-2). runner drift 검출용. LLM 불필요, 결정적.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;
const PARAM_REF_RE = /\$\{params\.([A-Za-z0-9_.-]+)\}/g;

/**
 * 확정 시 golden.output 안의 params 값을 ${params.key} 자리표시자로 저장 (M3.6-4).
 * - JSON이면 파싱 후 문자열 값의 완전 일치만 치환 (부분 문자열 치환 금지).
 * - JSON이 아니면 길이가 4 이상인 값의 모든 출현을 치환.
 */
export function maskParamsValues(text: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(maskJsonValue(parsed, new Map(entries)));
  } catch {
    let out = text;
    for (const [k, v] of entries) {
      if (v.length < 4) continue;
      out = out.split(v).join(`\${params.${k}}`);
    }
    return out;
  }
}

function maskJsonValue(v: unknown, params: Map<string, string>): unknown {
  if (typeof v === "string") {
    for (const [k, val] of params) {
      if (v === val) return `\${params.${k}}`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => maskJsonValue(x, params));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = maskJsonValue(x, params);
    return out;
  }
  return v;
}

/** 비교 시 자리표시자를 현재 params로 복원. 모르는 키는 그대로 둔다. */
export function restoreParamsPlaceholders(text: string, params: Record<string, string>): string {
  return text.replace(PARAM_REF_RE, (m, k: string) => (k in params ? params[k] : m));
}

export function normalizeOutputText(text: string, runFsAbs?: string): string {
  let out = text;
  if (runFsAbs) {
    const norm = runFsAbs.replace(/\\/g, "/");
    out = out.split(runFsAbs).join("{RUNFS}").split(norm).join("{RUNFS}");
  }
  out = out.replace(ISO_RE, "{TIME}").replace(UUID_RE, "{UUID}");
  return out;
}

function deleteJsonPath(root: unknown, path: string): void {
  const parts = path.split(".");
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) {
    delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
  }
}

function firstDiffPath(a: unknown, b: unknown, base = ""): string | null {
  if (typeof a !== typeof b) return base || "(root)";
  if (a === null || b === null) return a === b ? null : base || "(root)";
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return base || "(root)";
    if (a.length !== b.length) return `${base || "(root)"}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], `${base}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      const d = firstDiffPath(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        base ? `${base}.${k}` : k,
      );
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) ? null : base || "(root)";
}

export type NormalizedDiff =
  | { equal: true }
  | { equal: false; path: string; expectedExcerpt: string; actualExcerpt: string };

function excerpt(s: string, at: number): string {
  return s.slice(Math.max(0, at - 200), at + 200);
}

/**
 * golden 출력과 실제 출력 비교.
 * - 둘 다 JSON 파싱되면 구조 비교 (ignore 경로 제거 후). diff는 첫 불일치 JSON 경로 + 앞뒤 200자.
 * - 아니면 정규화 후 텍스트 비교. diff는 첫 불일치 위치 앞뒤 200자.
 * - expected의 ${params.k} 자리표시자는 params로 복원 후 비교 (M3.6-4).
 */
export function compareNormalized(expected: string, actual: string, ignore: string[] = [], runFsAbs?: string, params?: Record<string, string>): NormalizedDiff {
  const e = normalizeOutputText(restoreParamsPlaceholders(expected, params ?? {}), runFsAbs);
  const a = normalizeOutputText(actual, runFsAbs);
  let ej: unknown;
  let aj: unknown;
  try {
    ej = JSON.parse(e);
    aj = JSON.parse(a);
  } catch {
    ej = undefined;
    aj = undefined;
  }
  if (ej !== undefined && aj !== undefined) {
    const ec = JSON.parse(JSON.stringify(ej));
    const ac = JSON.parse(JSON.stringify(aj));
    for (const p of ignore) {
      deleteJsonPath(ec, p);
      deleteJsonPath(ac, p);
    }
    const d = firstDiffPath(ec, ac);
    if (!d) return { equal: true };
    return {
      equal: false,
      path: d,
      expectedExcerpt: JSON.stringify(ec).slice(0, 400),
      actualExcerpt: JSON.stringify(ac).slice(0, 400),
    };
  }
  if (e === a) return { equal: true };
  let i = 0;
  while (i < e.length && i < a.length && e[i] === a[i]) i++;
  return { equal: false, path: `(char ${i})`, expectedExcerpt: excerpt(e, i), actualExcerpt: excerpt(a, i) };
}
