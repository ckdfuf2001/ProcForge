#!/usr/bin/env node
import { resolve } from "node:path";
import { createLocalStack } from "./core-inprocess.js";
import { DEFAULT_SESSION_TTL_MS, runStdio } from "./server.js";

const projectRoot = resolve(process.env.PROCFORGE_PROJECT_ROOT ?? process.argv[2] ?? process.cwd());
const procforgeDir = resolve(process.env.PROCFORGE_DIR ?? process.argv[3] ?? `${projectRoot}/.procforge`);
const readOnly = process.env.PROCFORGE_READ_ONLY === "1";
const ttlDays = Number(process.env.PROCFORGE_SESSION_TTL_DAYS ?? "30");
const sessionTtlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400000 : DEFAULT_SESSION_TTL_MS;

const { client, store } = createLocalStack(procforgeDir);
await runStdio({ client, store, procforgeDir, projectRoot, sessionTtlMs, readOnly });
