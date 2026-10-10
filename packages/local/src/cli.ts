#!/usr/bin/env node
import { parseCliArgs, resolveDirs } from "./app/cli-args.js";
import { createApp } from "./app/bootstrap.js";

// CLI 어댑터 (M4.2-4-1). 파일·저장소 작업은 App 메서드로만 수행한다
// (check-deps: app/ 외 local 내부·node:fs import 금지).

const { values, positionals } = parseCliArgs(process.argv.slice(2));

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
  for (const p of values.param ?? []) {
    const i = p.indexOf("=");
    if (i === -1) {
      console.error(`bad --param (k=v 필요): ${p}`);
      return 2;
    }
    params[p.slice(0, i)] = p.slice(i + 1);
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
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    if (procRef && !values.session) {
      // 절차서 실행 (M4)
      const out = await app.test({
        procedure: procRef,
        params,
        mode: mode as "record" | "replay" | "passthrough" | "live",
        updateGolden: values["update-golden"] ?? false,
        allowProjectRead: values["allow-project-read"] ?? false,
        junitPath: values.junit,
      });
      console.log(`procedure run ${out.runId} (session ${out.sessionId}): pass=${out.passed} fail=${out.failed} unverified=${out.unverified} skipped=${out.skipped} blocked=${out.blocked}`);
      return out.failed > 0 ? 1 : 0;
    }
    if (!values.session) {
      console.error("missing --session");
      return 2;
    }
    const out = await app.test({
      sessionId: values.session,
      nodeId: values.node,
      mode: mode as "record" | "replay" | "passthrough" | "live",
      updateGolden: values["update-golden"] ?? false,
      allowProjectRead: values["allow-project-read"] ?? false,
      changed: values.changed ?? false,
      junitPath: values.junit,
    });
    console.log(`run ${out.runId}: pass=${out.passed} fail=${out.failed} unverified=${out.unverified} skipped=${out.skipped} blocked=${out.blocked}`);
    console.log(`report: ${out.reportPath}`);
    return out.failed > 0 ? 1 : 0;
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
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    console.log((await app.traceMarkdown({ sessionId: sid })).markdown);
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
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    const r = await app.exportSession({
      sessionId: sid,
      outPath: values.out,
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

async function cmdRun(): Promise<number> {
  const positional = positionals[1];
  const procRef = (!values.session ? positional : undefined) ?? values.procedure;
  if (!procRef) {
    console.error("procedure 실행: procforge run procedures/<name> [--param k=v] [--out dir] [--force]");
    return 2;
  }
  const params: Record<string, string> = {};
  for (const p of values.param ?? []) {
    const i = p.indexOf("=");
    if (i === -1) {
      console.error(`bad --param (k=v 필요): ${p}`);
      return 2;
    }
    params[p.slice(0, i)] = p.slice(i + 1);
  }
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    const out = await app.runProcedure({
      procedure: procRef,
      params,
      out: values.out,
      force: values.force ?? false,
      allowBash: values["allow-bash"] ?? false,
      allowProjectRead: values["allow-project-read"] ?? false,
    });
    console.log(`run ${out.runId} (session ${out.sessionId}): pass=${out.passed} fail=${out.failed} unverified=${out.unverified} skipped=${out.skipped} blocked=${out.blocked} suspended=${out.suspended}`);
    console.log(`report: ${out.reportPath}`);
    if (out.outDir) console.log(`out: ${out.outDir}`);
    if (out.suspended > 0) {
      console.error("suspended: pf_run_next로 재개 (MCP) — 생성값·승인 필요");
      return 1;
    }
    return out.failed > 0 ? 1 : 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdApprove(): Promise<number> {
  const [, runId, nodeId] = positionals;
  if (!runId || !nodeId) {
    console.error("usage: procforge approve <runId> <nodeId>");
    return 2;
  }
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    const r = await app.runApprove({ runId, nodeId });
    console.log(`approved: run ${r.runId} node ${r.nodeId}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdRepair(): Promise<number> {  const [sid] = positionals.slice(1);
  const discard = values.discard;
  if (!sid || discard === undefined) {
    console.error("usage: procforge repair <sessionId> --discard <rev>");
    return 2;
  }
  if (!/^\d+$/.test(discard)) {
    console.error(`bad --discard (revision 숫자 필요): ${discard}`);
    return 2;
  }
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    const r = await app.repair({ sessionId: sid, discardRev: Number(discard) });
    console.log(`repaired: discarded ${r.removed.length} files (${r.removed.join(", ")})`);
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
  if (cmd === "repair") return cmdRepair();
  if (cmd === "run") return cmdRun();
  if (cmd === "approve") return cmdApprove();
  console.error("usage: procforge <test|trace|export|repair|run|approve> ...");
  return 2;
}

process.exit(await main());
