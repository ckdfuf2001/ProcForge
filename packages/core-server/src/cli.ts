import { startServer, parseApiKeys } from "./server.js";
import { readEnvPair } from "@procforge/shared/env-compat.js";

// procforge-core-server --port <n> --data-dir <dir> --api-keys "tid:key,..."
// env: PROOF_CORE_PORT / PROOF_CORE_DATA_DIR / PROOF_API_KEYS (대체 PROCFORGE_*).
// M9-1-1: API_KEYS·DEV_AUTH는 보안 변수라 두 이름 값이 다르면 기동 오류로 종료한다.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const env = process.env as Record<string, string | undefined>;
const port = Number(arg("--port") ?? readEnvPair(env, "PROOF_CORE_PORT", "PROCFORGE_CORE_PORT") ?? "4096");
const dataDir =
  arg("--data-dir") ??
  readEnvPair(env, "PROOF_CORE_DATA_DIR", "PROCFORGE_CORE_DATA_DIR") ??
  "./.procforge-remote";
const keysRaw = arg("--api-keys") ?? readEnvPair(env, "PROOF_API_KEYS", "PROCFORGE_API_KEYS", { secret: true, onConflict: "fail" }) ?? "";
// DEV_AUTH는 server.ts 요청 시점에 읽지만, 불일치는 기동 시점에 먼저 거른다.
void readEnvPair(env, "PROOF_DEV_AUTH", "PROCFORGE_DEV_AUTH", { secret: true, onConflict: "fail" });

try {
  const apiKeys = parseApiKeys(keysRaw);
  if (apiKeys.length === 0) {
    console.error(
      'API 키 없음: --api-keys "tid:key,..." 또는 PROOF_API_KEYS (대체 PROCFORGE_API_KEYS) 필요',
    );
    process.exit(2);
  }
  const { port: bound } = await startServer({ dataDir, apiKeys, port });
  console.error(
    `procforge core-server listening on 127.0.0.1:${bound} (data ${dataDir})`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
