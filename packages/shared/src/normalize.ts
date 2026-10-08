// 출력 정규화 비교 (M3.1-2). runner drift 검출용. LLM 불필요, 결정적.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;

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
 */
export function compareNormalized(expected: string, actual: string, ignore: string[] = [], runFsAbs?: string): NormalizedDiff {
  const e = normalizeOutputText(expected, runFsAbs);
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
