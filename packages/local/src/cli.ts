#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { runSession, toJUnit } from "./runner/index.js";
import { runProcedureTest } from "./runner/procedure-run.js";
import { buildTrace, formatTraceMarkdown } from "./trace.js";
import { exportSession } from "./export.js";

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
    "allow-project-read": { type: "boolean", default: false },
    changed: { type: "boolean", default: false },
    "procforge-dir": { type: "string" },
    "project-root": { type: "string" },
    redact: { type: "boolean", default: false },
    "include-originals": { type: "boolean", default: false },
    out: { type: "string" },
    param: { type: "string", multiple: true },
  },
  allowPositionals: true,
});

function dirs(): { projectRoot: string; procforgeDir: string } {
  const projectRoot = resolve(values["project-root"] ?? process.env.PROCFORGE_PROJECT_ROOT ?? process.cwd());
  const procforgeDir = resolve(values["procforge-dir"] ?? process.env.PROCFORGE_DIR ?? `${projectRoot}/.procforge`);
  return { projectRoot, procforgeDir };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function cmdTest(): Promise<number> {
  if (values.procedure && !values.session && !positionals[1]) {
    console.error("procedure 실행: procforge test procedures/<name> [--param k=v]");
    return 2;
  }
  // positional이 UUID면 세션 id로 해석 (M3.5 지시 호환)
  const positional = positionals[1];
  if (!values.session && positional && UUID_RE.test(positional)) {
    values.session = positional;
  }
  const procRef = (!values.session ? positional : undefined) ?? values.procedure;
  const params: Record<string, string> = {};
  for (const p of (values.param as string[] | undefined) ?? []) {
    const i = p.indexOf("=");
    if (i === -1) {
      console.error(`bad --param (k=v 필요): ${p}`);
      return 2;
    }
    params[p.slice(0, i)] = p.slice(i + 1);
  }
  const { projectRoot, procforgeDir } = dirs();
  if (procRef && !values.session) {
    // 절차서 실행 (M4)
    try {
      const mode = values.mode as string;
      if (!["record", "replay", "passthrough", "live"].includes(mode)) {
        console.error(`bad --mode: ${mode}`);
        return 2;
      }
      if (mode === "replay" && values["update-golden"]) {
        console.error("--update-golden은 record/passthrough에서만 허용 (replay 불가)");
        return 2;
      }
      const { report, sessionId } = await runProcedureTest(procforgeDir, projectRoot, procRef, {
        procforgeDir,
        projectRoot,
        mode: mode as "record" | "replay" | "passthrough" | "live",
        params,
        updateGolden: values["update-golden"] ?? false,
        allowBash: values["allow-bash"] ?? false,
        allowProjectRead: values["allow-project-read"] ?? false,
        nodeId: values.node,
        changed: values.changed ?? false,
      });
      if (values.junit) writeFileSync(resolve(values.junit), toJUnit(report));
      const { pass, fail, unverified, skipped, blocked } = report.summary;
      console.log(`procedure run ${report.runId} (session ${sessionId}): pass=${pass} fail=${fail} unverified=${unverified} skipped=${skipped} blocked=${blocked}`);
      return fail > 0 ? 1 : 0;
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!values.session) {
    console.error("missing --session");
    return 2;
  }
  const mode = values.mode as string;
  if (!["record", "replay", "passthrough", "live"].includes(mode)) {
    console.error(`bad --mode: ${mode}`);
    return 2;
  }
  if (mode === "replay" && values["update-golden"]) {
    console.error("--update-golden은 record/passthrough에서만 허용 (replay 불가)");
    return 2;
  }
  try {
    const report = await runSession({
      procforgeDir,
      projectRoot,
      sessionId: values.session,
      nodeId: values.node,
      mode: mode as "record" | "replay" | "passthrough" | "live",
      updateGolden: values["update-golden"] ?? false,
      allowBash: values["allow-bash"] ?? false,
      allowProjectRead: values["allow-project-read"] ?? false,
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

async function cmdTrace(): Promise<number> {
  const [sid] = positionals.slice(1);
  if (!sid) {
    console.error("usage: procforge trace <sessionId>");
    return 2;
  }
  const { procforgeDir } = dirs();
  try {
    console.log(formatTraceMarkdown(buildTrace(procforgeDir, sid)));
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdExport(): Promise<number> {
  const [sid] = positionals.slice(1);
  if (!sid) {
    console.error("usage: procforge export <sessionId> [--redact] [--include-originals] [--out path]");
    return 2;
  }
  const { procforgeDir } = dirs();
  try {
    const outPath = resolve(values.out ?? `${procforgeDir}/exports/${sid}.zip`);
    const r = exportSession({
      procforgeDir,
      sessionId: sid,
      outPath,
      redact: values.redact ?? false,
      includeOriginals: values["include-originals"] ?? false,
    });
    console.log(`exported: ${r.outPath} (${r.files} files, redacted=${r.redacted})`);
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  const [cmd] = positionals;
  if (cmd === "test") return cmdTest();
  if (cmd === "trace") return cmdTrace();
  if (cmd === "export") return cmdExport();
  console.error("usage: procforge <test|trace|export> ...");
  return 2;
}

process.exit(await main());
