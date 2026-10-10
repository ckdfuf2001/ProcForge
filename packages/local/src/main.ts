#!/usr/bin/env node
import { resolve } from "node:path";
import { createApp, DEFAULT_SESSION_TTL_MS } from "./app/bootstrap.js";
import { runStdio } from "./server.js";

const projectRoot = resolve(process.env.PROCFORGE_PROJECT_ROOT ?? process.argv[2] ?? process.cwd());
const procforgeDir = resolve(process.env.PROCFORGE_DIR ?? process.argv[3] ?? `${projectRoot}/.procforge`);
const readOnly = process.env.PROCFORGE_READ_ONLY === "1";
const ttlDays = Number(process.env.PROCFORGE_SESSION_TTL_DAYS ?? "30");
const sessionTtlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400000 : DEFAULT_SESSION_TTL_MS;
const strictSandbox = process.env.PROCFORGE_STRICT_SANDBOX !== "0";
const maxArtifactBytes = Number(process.env.PROCFORGE_MAX_ARTIFACT_BYTES ?? `${5 * 1024 * 1024}`);
const catalogTimeoutMsRaw = Number(process.env.PROCFORGE_CATALOG_TIMEOUT_MS ?? "");
const catalogTimeoutMs = Number.isFinite(catalogTimeoutMsRaw) && catalogTimeoutMsRaw > 0 ? catalogTimeoutMsRaw : undefined;

// App 조립은 app/bootstrap으로 (M4.2-4-1). server는 완성된 App만 받는다.
const { app } = createApp({ procforgeDir, projectRoot, sessionTtlMs, strictSandbox, maxArtifactBytes, catalogTimeoutMs });
await runStdio({ app, procforgeDir, readOnly });
