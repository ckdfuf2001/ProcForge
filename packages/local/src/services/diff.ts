// M7-5-2: 승인 화면용 최소 diff. 외부 의존성 없이 줄 단위 비교로 만든다.
// 화면은 이 텍스트를 textContent로만 넣는다 (HTML로 해석 금지).

type Op = { kind: "same" | "add" | "del"; line: string };

/** LCS 기반 줄 단위 diff (작은 스크립트 규모에서 충분) */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // 길이가 지나치게 크면 앞뒤만 비교한다 (메모리 폭주 방지)
  const cap = 2000;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  if (n * m <= 4_000_000) {
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] =
          a[i] === b[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: "del", line: a[i] });
      i++;
    } else {
      out.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", line: a[i++] });
  while (j < m) out.push({ kind: "add", line: b[j++] });
  return out.slice(0, cap * 3);
}

export function unifiedDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const op of ops) {
    const p = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    lines.push(`${p}${op.line}`);
  }
  return lines.join("\n");
}

/** 한 줄 요약 (화면 상단에 배지로 붙인다) */
export function diffStat(before: string, after: string): { added: number; removed: number } {
  const ops = diffLines(before.split("\n"), after.split("\n"));
  return {
    added: ops.filter((o) => o.kind === "add").length,
    removed: ops.filter((o) => o.kind === "del").length,
  };
}