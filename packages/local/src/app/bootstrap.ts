import { createLocalStack } from "../core-inprocess.js";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { ProcForgeApp, DEFAULT_SESSION_TTL_MS } from "./app.js";

// 진입점 조립 (M4.2-4-1). 어댑터(server/cli 진입)는 App 합성을 이 모듈로만 한다.
export { DEFAULT_SESSION_TTL_MS };

export function createApp(opts: {
  procforgeDir: string;
  projectRoot: string;
  sessionTtlMs?: number;
  strictSandbox?: boolean;
  maxArtifactBytes?: number;
  catalogTimeoutMs?: number;
}): { app: ProcForgeApp; client: CoreClient } {
  const { client } = createLocalStack(
    opts.procforgeDir,
    opts.sessionTtlMs !== undefined ? { sessionTtlMs: opts.sessionTtlMs } : {},
  );
  const app = new ProcForgeApp({
    core: client,
    procforgeDir: opts.procforgeDir,
    projectRoot: opts.projectRoot,
    sessionTtlMs: opts.sessionTtlMs,
    strictSandbox: opts.strictSandbox,
    maxArtifactBytes: opts.maxArtifactBytes,
    catalogTimeoutMs: opts.catalogTimeoutMs,
  });
  return { app, client };
}
