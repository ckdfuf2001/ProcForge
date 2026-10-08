#!/usr/bin/env node
import { resolve } from "node:path";
import { createLocalStack } from "./core-inprocess.js";
import { runStdio } from "./server.js";

const projectRoot = resolve(process.env.PROCFORGE_PROJECT_ROOT ?? process.argv[2] ?? process.cwd());
const procforgeDir = resolve(process.env.PROCFORGE_DIR ?? process.argv[3] ?? `${projectRoot}/.procforge`);

const { client } = createLocalStack(procforgeDir);
await runStdio({ client, procforgeDir, projectRoot });
