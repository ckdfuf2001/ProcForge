import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcForgeApp } from "../src/app/app.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runSession } from "../src/runner/index.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5-7: live 실행 E2E (fake 서버, CI 양 OS).

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m5-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m5home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "template.j2"), "template {{month}}");
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

function appFor() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

const FILL_CAT = [{ server: "fake-ppt", name: "fill_template", inputSchema: {}, schemaHash: "h" }] as never;
const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;

async function finalizeFillTemplate(month: string, name: string): Promise<string> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "live", params: { month }, toolCatalog: FILL_CAT });
  const sid = started.session.id;
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "fill" }] });
  // 호스트가 sandbox에 산출물을 만든 상태 (m3 leaf 패턴: 수동 ingest)
  mkdirSync(join(root, "output"), { recursive: true });
  writeFileSync(join(root, "output", "report.pptx"), "PPTX-OUT-BYTES");
  const attemptId = randomUUID();
  const ing = ingestArtifacts({
    procforgeDir: pfdir, sessionId: sid, nodeId: "1.1", attemptId,
    baseDir: root, paths: ["template.j2", "output/report.pptx"],
  });
  await client.pfReport({
    sessionId: sid, nodeId: "1.1",
    tool: { server: "fake-ppt", name: "fill_template" },
    args: { template: "template.j2", month, output: "output/report.pptx" },
    resultSummary: JSON.stringify({ output: "output/report.pptx", month }),
    resultJson: { output: "output/report.pptx", month },
    artifacts: ing.stored, artifactContents: ing.contents,
    selfVerdict: "pass", selfReason: "ok", attemptId,
  });
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "fill_template" },
    argSpecs: {
      template: { kind: "fixed", value: "template.j2", path: "in" },
      month: { kind: "var", ref: "${params.month}" },
      output: { kind: "fixed", value: "output/report.pptx", path: "out" },
    } as never,
    goldenIgnore: ["output"],
  });
  await app.finalize({ sessionId: sid, name });
  return sid;
}

describe("M5 live 실행 E2E", () => {
  it("params 변경 live 실행: 새 값 산출물 + 통과", async () => {
    await finalizeFillTemplate("2026-09", "m5-rebind");
    const { report } = await runProcedureTest(pfdir, root, "m5-rebind", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(1);
    const out = readFileSync(join(pfdir, "runs", report.runId, "fs", "output", "report.pptx"), "utf8");
    expect(out).toContain("2026-10");
  }, 60000);

  it("generated suspended→supply→done", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "gen", toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "g" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" }, args: {},
      resultSummary: "ok", resultJson: {}, selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "generated", instruction: "인사말 생성" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "m5-gen" });
    const st = await app.runStart({ procedure: "m5-gen", params: {} });
    const n1 = await app.runNext({ runId: st.runId });
    expect(n1.kind).toBe("need_generated");
    if (n1.kind !== "need_generated") throw new Error("unreachable");
    expect(n1.nodeId).toBe("1.1");
    const n2 = await app.runSupply({ runId: st.runId, nodeId: "1.1", value: "hello" });
    expect(n2.kind).toBe("done");
    if (n2.kind !== "done") throw new Error("unreachable");
    expect(n2.pass).toBe(1);
  }, 60000);

  it("M5-5 external need_approval → 승인 후 실행", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "ext", toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "x" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" },
      resultSummary: "ok", resultJson: { note: "hi" }, selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
      sideEffect: "external",
    });
    await app.finalize({ sessionId: sid, name: "m5-ext" });
    const st = await app.runStart({ procedure: "m5-ext", params: {} });
    const n1 = await app.runNext({ runId: st.runId });
    expect(n1.kind).toBe("need_approval");
    if (n1.kind !== "need_approval") throw new Error("unreachable");
    expect(n1.approvalHint).toMatch(/approve/);
    await app.runApprove({ runId: st.runId, nodeId: "1.1" });
    const n2 = await app.runNext({ runId: st.runId });
    expect(n2.kind).toBe("done");
  }, 60000);

  it("M5-4 실패 노드 하류 미실행 + 수정 힌트", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({
      request: "fail",
      toolCatalog: [
        { server: "opencode", name: "bash", inputSchema: {}, schemaHash: "h" },
        { server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" },
      ] as never,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "boom" }, { goal: "after", dependsOn: ["1.1"] }],
    });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "bash" }, args: { command: "exit 1" },
      resultSummary: "boom", resultJson: { command: "exit 1" }, selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "opencode", name: "bash" },
      argSpecs: { command: { kind: "fixed", value: "exit 1" } } as never,
    });
    await client.pfReport({
      sessionId: sid, nodeId: "1.2",
      tool: { server: "fake-ppt", name: "echo" }, args: { note: "after" },
      resultSummary: "ok", resultJson: { note: "after" }, selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "after" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "m5-fail" });
    // 배치 live: 실패 + 하류 차단
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "live" });
    expect(rep.results.find((r) => r.nodeId === "1.1")?.status).toBe("fail");
    expect(rep.results.find((r) => r.nodeId === "1.2")?.status).toBe("blocked");
    // pf_run_next: 실패 + 수정 힌트
    const st = await app.runStart({ procedure: "m5-fail", params: {} });
    const n1 = await app.runNext({ runId: st.runId });
    expect(n1.kind).toBe("failed");
    if (n1.kind !== "failed") throw new Error("unreachable");
    expect(n1.hint).toMatch(/pf_reopen/);
  }, 60000);
});
