// M9-1-1: env 이름 호환 (PROOF_* 우선, PROCFORGE_* 대체).
// 규칙: PROOF_*를 먼저 읽고, 없으면 PROCFORGE_*를 쓰면서 stderr 경고 1회를 낸다.
// 보안 5종(READ_ONLY·STRICT_SANDBOX·DEV_AUTH·API_KEYS·CORE_API_KEY)은
// 두 이름의 값이 다르면 기동 오류로 종료한다 (조용한 보호 해제를 막는다).
// 경고에는 비밀값을 찍지 않는다 (변수 이름만). 경로 변수는 절대경로만 적는다.
import { logger } from "./logger.js";

export type EnvLike = Record<string, string | undefined>;
export type EnvConflictPolicy = "prefer-proof" | "fail";
export type EnvWarn = (msg: string) => void;

export type ReadEnvPairOpts = {
  /** 비밀 변수: 경고에 값을 찍지 않는다 (변수 이름만). */
  secret?: boolean;
  /** both set + different: "prefer-proof"(기본) | "fail"(기동 오류). */
  onConflict?: EnvConflictPolicy;
  /** 경고 출력 (기본 logger.warn = stderr). 테스트 주입용. */
  warn?: EnvWarn;
  /** 충돌 경고에 덧붙일 표시값 (예: 경로 변수의 절대경로). 비밀 변수에는 전달 금지. */
  displayValue?: string;
};

const warned = new Set<string>();

/** 테스트용: 경고 1회 기록 초기화 (테스트 순서 의존 제거). */
export function resetEnvCompatWarnings(): void {
  warned.clear();
}

/** 같은 seen 집합을 쓰는 1회 경고 (DEV_AUTH 별도 경고 등 호출 측 경고용). */
export function warnOnceEnv(key: string, msg: string, warn?: EnvWarn): void {
  if (warned.has(key)) return;
  warned.add(key);
  (warn ?? ((m: string) => logger.warn(m)))(msg);
}

export function readEnvPair(
  env: EnvLike,
  proofKey: string,
  legacyKey: string,
  opts: ReadEnvPairOpts = {},
): string | undefined {
  const proof = env[proofKey];
  const legacy = env[legacyKey];
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  if (proof !== undefined && legacy !== undefined && proof !== legacy) {
    if (opts.onConflict === "fail") {
      throw new Error(
        `${proofKey}/${legacyKey} 값이 다르면 기동할 수 없다 (${proofKey}와 ${legacyKey} 중 하나로 통일하라)`,
      );
    }
    warnOnceEnv(
      `${proofKey}|conflict`,
      opts.secret === true || opts.displayValue === undefined
        ? `${legacyKey} 대신 ${proofKey}를 사용한다 (값이 다름)`
        : `${legacyKey} 대신 ${proofKey}를 사용한다 (값이 다름, 사용: ${opts.displayValue})`,
      warn,
    );
    return proof;
  }
  if (legacy !== undefined && proof === undefined) {
    warnOnceEnv(
      legacyKey,
      `${legacyKey}는 옛 이름이다. ${proofKey} 사용을 권장한다 (옛 이름도 동작한다)`,
      warn,
    );
    return legacy;
  }
  return proof;
}
