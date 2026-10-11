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
  return code === "bad_request" ? 2 : 1;
}
