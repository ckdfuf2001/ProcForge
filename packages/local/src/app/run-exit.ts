// M5.5-4: run 종료 코드 결정 (순수 함수, CLI·테스트 공용).
// 0 성공 / 1 검사 실패·중단 / 2 입력 오류 / 3 승인 필요.

export type RunExitInput = {
  failed: number;
  suspended: number;
  approvalBlocked: boolean;
};

export function runExitCode(o: RunExitInput): number {
  if (o.approvalBlocked) return 3;
  if (o.failed > 0 || o.suspended > 0) return 1;
  return 0;
}

export function cliErrorExit(e: unknown): number {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && INPUT_ERROR_CODES.includes(code) ? 2 : 1;
}

// M5.5-4.1-5: run 명령 에러 매핑. 겹친 실행(conflict)만 4, 나머지는 cliErrorExit.
export function runErrorExit(e: unknown): number {
  if ((e as { code?: unknown } | null)?.code === "conflict") return 4;
  return cliErrorExit(e);
}

// M5.5-4.1-1: 입력 오류 코드 (exit 2). scheduling.md 표와 일치 고정.
const INPUT_ERROR_CODES: readonly string[] = [
  "bad_request",
  "bad_args",
  "not_found",
  "session_not_found",
];
