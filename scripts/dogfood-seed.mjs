#!/usr/bin/env node
// M10-dogfood-seed: dogfood용 절차서 시드 (보고 전용, L3 게이트 아님).
// MCP stdio로 packages/local/dist/main.js에 붙어 정상 경로(pf_start→분해→
// 보고→pf_finalize)로 dog-a(즉시 끝나는 script 1개)와 dog-b(40초 script 1개)를
// 만든다. LLM을 쓰지 않는다.
//
//   node scripts/dogfood-seed.mjs init --dir <작업폴더>
//   node scripts/dogfood-seed.mjs finalize --dir <작업폴더> --session <sid> --name <절차서>
// finalize는 응답이 무엇이든 exit 0이다.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const localDir = join(repo, "packages", "local");
const mainJs = join(localDir, "dist", "main.js");
const need = createRequire(join(localDir, "package.json"));
const { Client } = need("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = need("@modelcontextprotocol/sdk/client/stdio.js");

const CAT = [{ server: "t", name: "echo", inputSchema: {}, schemaHash: "h" }];
const TOOL = { server: "t", name: "echo" };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

async function connect(dir) {
  const pfdir = join(dir, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mainJs, dir],
    env: {
      ...process.env,
      PROOF_DIR: pfdir,
      PROOF_PROJECT_ROOT: dir,
      PROOF_SESSION_TTL_DAYS: "30",
    },
    stderr: "ignore",
  });
  const mcp = new Client({ name: "dogfood-seed", version: "1.0.0" });
  await mcp.connect(transport);
  const call = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content || []).map((p) => (p && p.text) || "").join("\n");
    if (r.isError) throw Object.assign(new Error(text.split("\n")[0]), { mcpError: text });
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
  return { mcp, transport, call, pfdir };
}

async function buildProcedure(call, dir, name, request, childGoal, scriptFile, scriptBody, resultJson) {
  writeFileSync(join(dir, scriptFile), scriptBody, "utf8");
  const s = await call("pf_start", { request, params: {}, toolCatalog: CAT });
  const sid = s.sessionId || s.session?.id || s.id;
  if (!sid) throw new Error("pf_start 응답에 sessionId 없음: " + JSON.stringify(s).slice(0, 200));
  await call("pf_split", {
    sessionId: sid, nodeId: "1", reason: `${name} 절차서 분해 사유입니다.`, children: [{ goal: childGoal }], expectedRevision: 0,
  });
  await call("pf_report", {
    sessionId: sid, nodeId: "1.1", tool: TOOL, args: {}, resultSummary: "ok", resultJson, selfVerdict: "pass", selfReason: "ok",
  });
  await call("pf_confirm_leaf", {
    sessionId: sid, nodeId: "1.1", tool: TOOL,
    argSpecs: { script: { kind: "script", file: scriptFile, runtime: "python" } },
  });
  const finArgs = { sessionId: sid, name };
  const fin = await call("pf_finalize", finArgs);
  return { sid, fin, finArgs };
}

async function cmdInit() {
  const dir = resolve(arg("--dir") || "");
  if (!dir) throw new Error("init에는 --dir <작업폴더>가 필요하다");
  mkdirSync(dir, { recursive: true });
  const { mcp, transport, call, pfdir } = await connect(dir);
  try {
    const a = await buildProcedure(
      call, dir, "dog-a", "월간보고서 완성", "데이터 수집",
      "instant.py", "import json\nprint(json.dumps({\"ok\": True}))\n", { ok: true },
    );
    console.log(JSON.stringify({ op: "init", procedure: "dog-a", sessionId: a.sid, path: join(pfdir, "procedures", "dog-a", "procedure.json"), finalizeArgs: a.finArgs }));
    const b = await buildProcedure(
      call, dir, "dog-b", "야간 집계", "40초 대기 후 집계",
      "wait40.py", "import time, json\ntime.sleep(40)\nprint(json.dumps({\"done\": True}))\n", { done: true },
    );
    console.log(JSON.stringify({ op: "init", procedure: "dog-b", sessionId: b.sid, path: join(pfdir, "procedures", "dog-b", "procedure.json"), finalizeArgs: b.finArgs }));
  } finally {
    await mcp.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function cmdFinalize() {
  const dir = resolve(arg("--dir") || "");
  const sid = arg("--session") || "";
  const name = arg("--name") || "";
  if (!dir || !sid || !name) {
    console.log(JSON.stringify({ op: "finalize", code: "bad_request", message: "--dir/--session/--name이 필요하다" }));
    return;
  }
  let mcp;
  let transport;
  try {
    const c = await connect(dir);
    mcp = c.mcp;
    transport = c.transport;
    const r = await mcp.callTool({ name: "pf_finalize", arguments: { sessionId: sid, name } });
    const text = (r.content || []).map((p) => (p && p.text) || "").join("\n");
    if (r.isError) {
      const code = (text.split(":")[0] || "error").trim();
      console.log(JSON.stringify({ op: "finalize", code, message: text }));
    } else {
      console.log(JSON.stringify({ op: "finalize", code: "ok", message: text.slice(0, 500) }));
    }
  } catch (e) {
    const t = String((e && e.mcpError) || (e && e.message) || e);
    const code = (t.split(":")[0] || "error").trim();
    console.log(JSON.stringify({ op: "finalize", code, message: t.slice(0, 500) }));
  } finally {
    try { await mcp.close(); } catch { /* 무시 */ }
    try { await transport.close(); } catch { /* 무시 */ }
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "init") await cmdInit();
  else if (cmd === "finalize") await cmdFinalize();
  else {
    console.log(JSON.stringify({ op: "usage", code: "bad_request", message: "init --dir <폴더> | finalize --dir <폴더> --session <sid> --name <절차서>" }));
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log(JSON.stringify({ op: "error", code: "internal", message: String((e && e.message) || e).slice(0, 300) }));
    process.exit(0);
  },
);
