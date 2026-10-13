/**
 * 안정 직렬화 (M5.8.2-4): 객체 키 정렬 재귀 직렬화.
 * 값 동등 비교용 (삽입 순서 무관). JSON.stringify와 같은 값 영역
 * (undefined·함수·심볼은 객체에서 생략, 배열에서 null).
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function stableStringify(v: unknown): string {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      parts.push(x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : stableStringify(x));
    }
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(v)) {
    try {
      return JSON.stringify(v) ?? "";
    } catch {
      return "";
    }
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined || typeof x === "function" || typeof x === "symbol") continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(x)}`);
  }
  return `{${parts.join(",")}}`;
}
