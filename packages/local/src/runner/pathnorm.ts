// 경로 정규화 단일 함수 (M3.4.1-2). 녹화 키 + 응답 정규화가 모두 사용.
// 치환 대상 형태 = 원형, "/" 형태, JSON 이스케이프 형태, 각각의 "/" 변형.
// Windows 드라이브 문자 대소문자 무시.

function withDriveVariants(s: string, out: Set<string>): void {
  out.add(s);
  const m = /^([A-Za-z]:)(.*)$/s.exec(s);
  if (m) {
    out.add(m[1].toLowerCase() + m[2]);
    out.add(m[1].toUpperCase() + m[2]);
  }
}

/** needle의 모든 표기 변형 (긴 것 우선) */
export function normForms(needle: string): string[] {
  const out = new Set<string>();
  withDriveVariants(needle, out);
  withDriveVariants(needle.replace(/\\/g, "/"), out);
  addJsonForms(out, needle);
  return [...out].sort((a, b) => b.length - a.length);
}

function addJsonForms(out: Set<string>, needle: string): void {
  for (const base of [needle, needle.replace(/\\/g, "/")]) {
    try {
      const esc = JSON.stringify(base).slice(1, -1);
      withDriveVariants(esc, out);
    } catch {
      // 무시
    }
  }
}

export function replacePathForms(haystack: string, needle: string, replacement: string): string {
  let out = haystack;
  for (const f of normForms(needle)) {
    if (f.length > 0) out = out.split(f).join(replacement);
  }
  return out;
}
