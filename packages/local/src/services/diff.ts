// M7-5-2: 승인 화면용 최소 diff. 외부 의존성 없이 줄 단위 비교로 만든다.
// 화면은 이 텍스트를 textContent로만 넣는다 (HTML로 해석 금지).

type Op = { kind: "same" | "add" | "del"; line: string };

/** M7-5-h: LCS 표 최대 칸 수. 넘으면 표를 아예 만들지 않는다. */
const MAX_TABLE_CELLS = 4_000_000;

/** 줄 수 상한 (비교 대상이 지나치게 크면 생략) */
const MAX_LINES = 20_000;

/** LCS 기반 줄 단위 diff (작은 스크립트 규모에서 충분) */
function diffLines(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  // **할당을 크기 검사 뒤에** 한다. 이전 코드는 검사 전에 (n+1)×(m+1) 표를
  // 만들어서 1만 줄 × 1만 줄이면 1억 칸을 잡았다.
  if (n > MAX_LINES || m > MAX_LINES || (n + 1) * (m + 1) > MAX_TABLE_CELLS) {
    return null;
  }
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
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
  return out.slice(0, MAX_LINES * 3);
}

/** 크기 초과 시 diff 를 생략했다는 사실을 **보인다** (빈 문자열과 구분) */
export const DIFF_SKIPPED = "(diff 생략: 크기 초과)";

export function unifiedDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  const ops = diffLines(before.split("\n"), after.split("\n"));
  // M7-5-h: 표를 못 만들면 "생략"을 알린다 (빈 diff 와 구분되지 않게)
  if (ops === null) return DIFF_SKIPPED;
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const op of ops) {
    const p = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    lines.push(`${p}${op.line}`);
  }
  return lines.join("\n");
}

/** 한 줄 요약 (화면 상단에 배지로 붙인다) */
export function diffStat(before: string, after: string): { added: number; removed: number } | null {
  const ops = diffLines(before.split("\n"), after.split("\n"));
  if (ops === null) return null;
  return {
    added: ops.filter((o) => o.kind === "add").length,
    removed: ops.filter((o) => o.kind === "del").length,
  };
}