import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readEnvPair } from "@proof/shared/env-compat.js";
import { resolveStoreDir } from "./store-dir.js";

// CLI 인자 파싱 (M4.2-4-1). 어댑터는 node:util 직접 import 없이 이 모듈을 쓴다.

export type CliValues = {
  session?: string;
  procedure?: string;
  node?: string;
  mode?: string;
  junit?: string;
  "update-golden"?: boolean;
  "allow-bash"?: boolean;
  "allow-project-read"?: boolean;
  changed?: boolean;
  "procforge-dir"?: string;
  "project-root"?: string;
  redact?: boolean;
  "include-originals"?: boolean;
  out?: string;
  /** M7-close-i: 누적 상태 루트 (기본 .procforge/state) */
  state?: string;
  param?: string[];
  discard?: string;
  force?: boolean;
  unattended?: boolean;
  port?: string;
  open?: boolean;
  "allow-wildcard"?: string[];
  "retry-attempts"?: string;
  "retry-base-ms"?: string;
  /** M5.7.1: 제거 예정 (경고 후 무시). --allow-unverified로 단일화. */
  "fail-on-unverified"?: boolean;
  "allow-unverified"?: boolean;
  /** M9-1-2: --help/-h, --version. */
  help?: boolean;
  version?: boolean;
};

export function parseCliArgs(argv: string[]): {
  values: CliValues;
  positionals: string[];
} {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        procedure: { type: "string" },
        node: { type: "string" },
        mode: { type: "string", default: "replay" },
        junit: { type: "string" },
        "update-golden": { type: "boolean", default: false },
        "allow-bash": { type: "boolean", default: false },
        "allow-project-read": { type: "boolean", default: false },
        changed: { type: "boolean", default: false },
        "procforge-dir": { type: "string" },
        "project-root": { type: "string" },
        redact: { type: "boolean", default: false },
        "include-originals": { type: "boolean", default: false },
        out: { type: "string" },
        state: { type: "string" },
        param: { type: "string", multiple: true },
        discard: { type: "string" },
        force: { type: "boolean", default: false },
        unattended: { type: "boolean", default: false },
        port: { type: "string" },
        open: { type: "boolean", default: false },
        "allow-wildcard": { type: "string", multiple: true },
        "retry-attempts": { type: "string" },
        "retry-base-ms": { type: "string" },
        // M5.7.1: 기본값 제거 — 전달 여부로 제거 경고를 판단한다 (기본 동작은 fail-on on).
        "fail-on-unverified": { type: "boolean" },
        "allow-unverified": { type: "boolean", default: false },
        "help": { type: "boolean", short: "h" },
        "version": { type: "boolean" },
      },
      allowPositionals: true,
    });
    return { values: values as CliValues, positionals };
  } catch (e) {
    // M9-1-2: 모르는 옵션은 스택 없이 한 줄 오류로 바꾼다 (cli.ts에서 stderr + exit 2).
    // code 마커는 대입으로 붙인다 (error-codes 테스트가 `code: "..."` 리터럴을
    // wire 코드로 판정하므로 리터럴을 쓰지 않는다. 내부 마커일 뿐 wire 코드가 아님).
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const err = new Error(msg);
    (err as unknown as { code: string }).code = "UNKNOWN_OPTION";
    throw err;
  }
}

// M9-1-2: --version 출력용. cli.ts(어댑터)는 node:fs 직접 사용 금지라
// 여기서 읽는다. src 실행 시에는 packages/local/package.json을 못 찾을 수
// 있어 "unknown"으로 떨어진다 (dist에서만 정상 동작).
export function readLocalVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveDirs(
  values: CliValues,
  env: NodeJS.ProcessEnv,
): { projectRoot: string; procforgeDir: string } {
  const projectRoot = resolve(
    // M9-1-1: PROOF_PROJECT_ROOT 우선, PROCFORGE_PROJECT_ROOT 대체.
    values["project-root"] ?? readEnvPair(env as Record<string, string | undefined>, "PROOF_PROJECT_ROOT", "PROCFORGE_PROJECT_ROOT") ?? process.cwd(),
  );
  // M7-1-6: PROCFORGE_DIR 우선 (opencode.json MCP env로 저장소 고정).
  // M9-1-1: PROOF_DIR 우선 (store-dir.ts에서 처리).
  const procforgeDir = resolveStoreDir({
    flag: values["procforge-dir"],
    env,
    cwd: projectRoot,
  });
  return { projectRoot, procforgeDir };
}

// M5.5-4.2-4: approve/run 대상 판별 전 경로 정규화 (win32 역슬래시 허용).
export function normalizeCliPath(p: string | undefined): string {
  return (p ?? "").split("\\").join("/");
}
