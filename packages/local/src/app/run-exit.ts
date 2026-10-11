// M5.5-4: run 종료 코드 결정 (순수 함수, CLI·테스트 공용).
// 0 성공 / 1 검사 실패·중단 / 2 입력 오류 / 3 승인 필요 / 4 겹친 실행.
// M5.7-2: 무인 실행 기본 on — unverified>0도 1.

export type RunExitInput = {
  failed: number;
  suspended: number;
  approvalBlocked: boolean;
  unverified?: number;
  failOnUnverified?: boolean;
};

export function runExitCode(o: RunExitInput): number {
  if (o.approvalBlocked) return 3;
  if (o.failed > 0 || o.suspended > 0) return 1;
  if ((o.failOnUnverified ?? false) && (o.unverified ?? 0) > 0) return 1;
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

// M5.6.1-2: --retry-attempts/--retry-base-ms 파싱. attempts 1..10, baseMs 0 이상.
// 벗어나면 bad_request (CLI exit 2).
export function parseRetryOptions(
  attemptsRaw: string | undefined,
  baseMsRaw: string | undefined,
): { attempts: number; baseMs: number } {
  const attempts = attemptsRaw === undefined ? 3 : Number(attemptsRaw);
  const baseMs = baseMsRaw === undefined ? 500 : Number(baseMsRaw);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw Object.assign(new Error("bad --retry-attempts (1 이상 10 이하 정수)"), { code: "bad_request" });
  }
  if (!Number.isInteger(baseMs) || baseMs < 0) {
    throw Object.assign(new Error("bad --retry-base-ms (0 이상 정수)"), { code: "bad_request" });
  }
  return { attempts, baseMs };
}

// M5.5-4.1-1: 입력 오류 코드 (exit 2). scheduling.md 표와 일치 고정.
const INPUT_ERROR_CODES: readonly string[] = [
  "bad_request",
  "bad_args",
  "not_found",
  "session_not_found",
];
