#!/usr/bin/env node
import { parseCliArgs, resolveDirs, normalizeCliPath } from "./app/cli-args.js";
import { createApp } from "./app/bootstrap.js";
import { cliErrorExit, runErrorExit, runExitCode } from "./app/run-exit.js";

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
    console.error("procedure 실행: procforge run procedures/<name> [--param k=v] [--out dir] [--force] [--unattended]");
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
      unattended: values.unattended ?? false,
    });
    console.log(`run ${out.runId} (session ${out.sessionId}): pass=${out.passed} fail=${out.failed} unverified=${out.unverified} skipped=${out.skipped} blocked=${out.blocked} suspended=${out.suspended}`);
    console.log(`report: ${out.reportPath}`);
    if (out.outDir) console.log(`out: ${out.outDir}`);
    // M5.5-4: 종료 코드 0 성공 / 1 실패·중단 / 2 입력 오류 / 3 승인 필요.
    // M5.5-4.1-5: 겹친 실행(conflict)은 4.
    if (out.approvalBlocked) {
      console.error("approval 필요: 무인 실행 미승인 external. approvals.json에 tool·인자 등록 후 재실행");
      return 3;
    }
    if (out.suspended > 0) {
      console.error("suspended: pf_run_next로 재개 (MCP) — 생성값·승인 필요");
      return 1;
    }
    return runExitCode({ failed: out.failed, suspended: out.suspended, approvalBlocked: out.approvalBlocked });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return runErrorExit(e);
  }
}

async function cmdApprove(): Promise<number> {
  // M5.5-4.2-4: 판별 전 정규화 (win32 "procedures\m55-unatt" 허용).
  // M5.6-a: UUID면 run 승인, 아니면 절차서 승인 (bare name·procedures/·.json·디렉터리).
  const target = normalizeCliPath(positionals[1]);
  const nodeId = positionals[2];
  if (!target) {
    console.error("usage: procforge approve <runId> <nodeId> | procforge approve <procedure> --node <id> [--allow-wildcard <key> ...]");
    return 2;
  }
  const { projectRoot, procforgeDir } = resolveDirs(values, process.env);
  try {
    const { app } = createApp({ procforgeDir, projectRoot });
    // M5.6-a: UUID면 run 승인, 아니면 절차서 승인 (bare name·procedures/·.json·디렉터리).
    // resolveProcedureRef가 3형식을 같은 dir로 푼다.
    const targetIsProc = !UUID_RE.test(target);
    if (targetIsProc) {
      const r = await app.approveProcedureNode({
        procedure: target, nodeId: values.node ?? nodeId, allowWildcard: values["allow-wildcard"] ?? [],
      });
      console.log(`approved: ${r.nodeId} (hash ${r.hash.slice(0, 12)}…) → ${r.path}${r.replaced ? " (갱신)" : ""}`);
      return 0;
    }
    if (!target || !nodeId) {
      console.error("usage: procforge approve <runId> <nodeId> | procforge approve procedures/<name> --node <id>");
      return 2;
    }
    const r = await app.runApprove({ runId: target, nodeId });
    console.log(`approved: run ${r.runId} node ${r.nodeId}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return cliErrorExit(e);
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
  console.error("  approve <runId> <nodeId> | approve <procedure> --node <id> [--allow-wildcard <key> ...]");
  console.error("  <procedure>: 이름 | procedures/<name> | <dir> | <procedure.json>");
  return 2;
}

process.exit(await main());
