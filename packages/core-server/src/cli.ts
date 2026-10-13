import { startServer, parseApiKeys } from "./server.js";

// procforge-core-server --port <n> --data-dir <dir> --api-keys "tid:key,..."
// env: PROCFORGE_CORE_PORT / PROCFORGE_CORE_DATA_DIR / PROCFORGE_API_KEYS.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const port = Number(arg("--port") ?? process.env.PROCFORGE_CORE_PORT ?? "4096");
const dataDir = arg("--data-dir") ?? process.env.PROCFORGE_CORE_DATA_DIR ?? "./.procforge-remote";
const keysRaw = arg("--api-keys") ?? process.env.PROCFORGE_API_KEYS ?? "";

try {
  const apiKeys = parseApiKeys(keysRaw);
  if (apiKeys.size === 0) {
    console.error("API 키 없음: --api-keys \"tid:key,...\" 또는 PROCFORGE_API_KEYS 필요");
    process.exit(2);
  }
  const { port: bound } = await startServer({ dataDir, apiKeys, port });
  console.error(`procforge core-server listening on 127.0.0.1:${bound} (data ${dataDir})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
