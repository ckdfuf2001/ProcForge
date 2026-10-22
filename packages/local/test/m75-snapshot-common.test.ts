import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { readApprovedSnapshot } from "../src/services/approval-scripts.js";
import { loadApprovals } from "../src/services/approvals.js";

// M7-5-e: 승인 스냅샷은 **공통 승인 경로**에서 저장된다.
// 이전엔 uiApprove 안에서만 저장해서 MCP(pf_approve)·CLI 로 승인한 스크립트는
// diff 가 계속 null 이었다 (= "무엇이 승인됐는지"가 나중에 없다).

const catalog = [{ server: "fs", name: "read", inputSchema: { type: "object" }, schemaHash: "h" }];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-snap-")), ".procforge");
  mkdirSync(pfdir, { recursive: true });
});
afterAll(() => {
  currentApp = null;
});

let currentApp: ProcForgeApp | null = null;

/** 스크립트 leaf + 절차서 + 실행까지 만든다 (세션·절차서 컨텍스트 확보) */
async function setup() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  currentApp = app;
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "a" }],
    expectedRevision: 0,
  });
  // 스크립트는 세션/프로젝트 양쪽에 둔다 (검증 경로가 둘 다 본다)
  const sdir = join(pfdir, "sessions", s.sessionId, "scripts");
  mkdirSync(sdir, { recursive: true });
  mkdirSync(join(pfdir, "scripts"), { recursive: true });
  writeFileSync(join(sdir, "step.py"), "print('v1')\n", "utf8");
  writeFileSync(join(pfdir, "scripts", "step.py"), "print('v1')\n", "utf8");
  await app.report({
    sessionId: s.sessionId,
    nodeId: "1.1",
    tool: { server: "fs", name: "read" },
    args: {},
    resultSummary: "ok",
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await app.confirmLeaf({
    sessionId: s.sessionId,
    nodeId: "1.1",
    tool: { server: "fs", name: "read" },
    argSpecs: { script: { kind: "script", file: "scripts/step.py", runtime: "python" } },
  });
  await app.finalize({ sessionId: s.sessionId, name: "demo" });
  const run = await app.runStart({ procedure: "demo" });
  const rsid = run.sessionId;
  await app.askHuman({
    sessionId: rsid,
    nodeId: "1.1",
    question: "스크립트를 승인할까요?",
    plan: { tool: { server: "fs", name: "read" }, args: { path: "out.txt" } },
  });
  const procedureDir = join(pfdir, "procedures", "demo");
  // runStart 가 만든 세션에도 스크립트를 둔다 (승인 기준은 실행 세션 쪽이다)
  const rdir = join(pfdir, "sessions", rsid, "scripts");
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "step.py"), "print('v1')\n", "utf8");
  writeFileSync(join(pfdir, "procedures", "demo", "step.py"), "print('v1')\n", "utf8");
  return { app, sid: rsid, sdir: rdir, procedureDir };
}

describe("M7-5-e 공통 승인 경로 스냅샷", () => {
  it("MCP pf_approve 로 승인하면 스냅샷이 남고, 수정하면 diff 가 생긴다", async () => {
    const { app, sid, sdir, procedureDir } = await setup();
    // MCP 경로 승인 (actor=host)
    await app.approve({
      sessionId: sid,
      nodeId: "1.1",
      approved: true,
      expectedRevision: (await app.readSession(sid)).revision,
    } as never);

    // 1) 스냅샷이 저장됐다
    expect(readApprovedSnapshot(procedureDir, "1.1")).toBe("print('v1')\n");
    const entries = loadApprovals(procedureDir);
    expect(entries.length).toBe(1);
    expect(
      (entries[0].args as { script?: { snapshot?: string } }).script?.snapshot,
    ).toMatch(/\.snap$/);

    // 2) 승인 후 스크립트를 고치면 diff 가 보인다 (읽는 곳 = 세션/<sid>/<rel>)
    const before = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    const rel = before.script?.rel ?? "";
    expect(rel).not.toBe("");
    writeFileSync(join(pfdir, "sessions", sid, rel), "print('v2')\n", "utf8");
    const after = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(after.script?.content).toContain("v2");
    expect(after.diff).not.toBeNull();
    expect(after.diff).toContain("-print('v1')");
    expect(after.diff).toContain("+print('v2')");
  }, 60000);

  it("CLI 승인 경로도 스냅샷을 남긴다", async () => {
    const { app, procedureDir } = await setup();
    await app.approveProcedureNode({ procedure: "demo", nodeId: "1.1" });
    expect(readApprovedSnapshot(procedureDir, "1.1")).toBe("print('v1')\n");
  }, 60000);

  it("UI 승인 경로도 같은 스냅샷 파일을 쓴다", async () => {
    const { app, sid, procedureDir } = await setup();
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    await app.uiApprove({
      sessionId: sid,
      nodeId: "1.1",
      approvalHash: info.approvalHash,
      approved: true,
      expectedRevision: (await app.readSession(sid)).revision,
    });
    expect(readApprovedSnapshot(procedureDir, "1.1")).toBe("print('v1')\n");
  }, 60000);
});
