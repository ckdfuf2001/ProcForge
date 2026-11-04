#!/usr/bin/env node
import { resolve } from "node:path";
import { readEnvPair } from "@proof/shared/env-compat.js";
import { createApp, DEFAULT_SESSION_TTL_MS } from "./app/bootstrap.js";
import { runStdio } from "./server.js";
import { resolveStoreDir } from "./app/store-dir.js";

// M9-1-1: PROOF_* 우선, PROCFORGE_* 대체. 보안 5종 중 READ_ONLY·STRICT_SANDBOX는
// 두 이름 값이 다르면 기동 오류로 종료한다.
const env = process.env as Record<string, string | undefined>;
const projectRoot = resolve(
  readEnvPair(env, "PROOF_PROJECT_ROOT", "PROCFORGE_PROJECT_ROOT") ?? process.argv[2] ?? process.cwd(),
);
// M7-1-6: cli-args와 같은 단일 규칙 (PROOF_DIR 우선).
const procforgeDir = resolveStoreDir({
  flag: process.argv[3],
  env: process.env,
  cwd: projectRoot,
});
const readOnly = readEnvPair(env, "PROOF_READ_ONLY", "PROCFORGE_READ_ONLY", { onConflict: "fail" }) === "1";
const ttlDays = Number(readEnvPair(env, "PROOF_SESSION_TTL_DAYS", "PROCFORGE_SESSION_TTL_DAYS") ?? "30");
const sessionTtlMs =
  Number.isFinite(ttlDays) && ttlDays > 0
    ? ttlDays * 86400000
    : DEFAULT_SESSION_TTL_MS;
const strictSandbox = readEnvPair(env, "PROOF_STRICT_SANDBOX", "PROCFORGE_STRICT_SANDBOX", { onConflict: "fail" }) !== "0";
const maxArtifactBytes = Number(
  readEnvPair(env, "PROOF_MAX_ARTIFACT_BYTES", "PROCFORGE_MAX_ARTIFACT_BYTES") ?? `${5 * 1024 * 1024}`,
);
const catalogTimeoutMsRaw = Number(
  readEnvPair(env, "PROOF_CATALOG_TIMEOUT_MS", "PROCFORGE_CATALOG_TIMEOUT_MS") ?? "",
);
const catalogTimeoutMs =
  Number.isFinite(catalogTimeoutMsRaw) && catalogTimeoutMsRaw > 0
    ? catalogTimeoutMsRaw
    : undefined;

// App 조립은 app/bootstrap으로 (M4.2-4-1). server는 완성된 App만 받는다.
const { app } = createApp({
  procforgeDir,
  projectRoot,
  sessionTtlMs,
  strictSandbox,
  maxArtifactBytes,
  catalogTimeoutMs,
});
await runStdio({ app, procforgeDir, projectRoot, readOnly });
