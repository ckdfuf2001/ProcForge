#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { runSession, toJUnit } from "./runner/index.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    session: { type: "string" },
    procedure: { type: "string" },
    node: { type: "string" },
    mode: { type: "string", default: "replay" },
    junit: { type: "string" },
    "update-golden": { type: "boolean", default: false },
    "allow-bash": { type: "boolean", default: false },
    changed: { type: "boolean", default: false },
    "procforge-dir": { type: "string" },
    "project-root": { type: "string" },
  },
  allowPositionals: true,
});

async function main(): Promise<number> {
  const [cmd] = positionals;
  if (cmd !== "test") {
    console.error("usage: procforge test --session <id> [--node <id>] [--mode record|replay|passthrough] [--update-golden] [--allow-bash] [--changed] [--junit out.xml]");
    return 2;
  }
  if (values.procedure && !values.session) {
    console.error("procedure 실행은 M5에서 지원 (현재는 --session만)");
    return 2;
  }
  if (!values.session) {
    console.error("missing --session");
    return 2;
  }
  const mode = values.mode as string;
  if (!["record", "replay", "passthrough"].includes(mode)) {
    console.error(`bad --mode: ${mode}`);
    return 2;
  }
  if (mode === "replay" && values["update-golden"]) {
    console.error("--update-golden은 record/passthrough에서만 허용 (replay 불가)");
    return 2;
  }
  const projectRoot = resolve(values["project-root"] ?? process.env.PROCFORGE_PROJECT_ROOT ?? process.cwd());
  const procforgeDir = resolve(values["procforge-dir"] ?? process.env.PROCFORGE_DIR ?? `${projectRoot}/.procforge`);
  try {
    const report = await runSession({
      procforgeDir,
      projectRoot,
      sessionId: values.session,
      nodeId: values.node,
      mode: mode as "record" | "replay" | "passthrough",
      updateGolden: values["update-golden"] ?? false,
      allowBash: values["allow-bash"] ?? false,
      changed: values.changed ?? false,
    });
    if (values.junit) writeFileSync(resolve(values.junit), toJUnit(report));
    const { pass, fail, unverified, skipped, blocked } = report.summary;
    console.log(`run ${report.runId}: pass=${pass} fail=${fail} unverified=${unverified} skipped=${skipped} blocked=${blocked}`);
    console.log(`report: ${procforgeDir}/runs/${report.runId}/report.json`);
    return fail > 0 ? 1 : 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
