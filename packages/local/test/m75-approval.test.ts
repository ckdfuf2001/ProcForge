import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { unifiedDiff } from "../src/services/diff.js";

// M7 5-2: 승인 화면 — 스크립트 sha + diff + approvalHash 필수(불일치 409).

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-approval-")), ".procforge");
});

const scriptRel = "scripts/step.py";

/** script-kind 노드가 있는 세션 + 절차서 등록 */
async function withScriptNode() {
  const catalog = [
    {
      server: "fs",
      name: "read",
      inputSchema: { type: "object" },
      schemaHash: "h",
    },
  ];
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    children: [{ goal: "a" }],
    expectedRevision: 0,
  });
  // 스크립트 파일 + script-kind 확정 인자
  const sdir = join(pfdir, "sessions", s.sessionId);
  mkdirSync(join(sdir, "scripts"), { recursive: true });
  writeFileSync(join(sdir, scriptRel), "print('v1')\n", "utf8");
  // leaf 확정은 통과 attempt가 먼저 있어야 한다 (M5 규칙)
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
    argSpecs: {
      script: { kind: "script", file: scriptRel, runtime: "python" },
    },
  });
  // 절차서 등록(승인 이력이 붙는 곳)
  const dir = join(pfdir, "procedures", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name: "demo",
      sourceSession: s.sessionId,
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: catalog,
      tree: { rootId: "1", nodes: [] },
      nodes: [],
    }),
    "utf8",
  );
  // 승인 대기(needs_human) 상태로 만든다 — pf_approve 대상이 되는 상태
  await app.askHuman({
    sessionId: s.sessionId,
    nodeId: "1.1",
    question: "실행해도 될까요?",
    plan: { tool: { server: "fs", name: "read" }, args: { path: "out.txt" } },
  });
  // runStart만 쓴다 (백그라운드 실행을 붙이지 않아 revision이 조용히 변하지 않는다)
  const run = await app.runStart({ procedure: "demo" });
  return { app, sid: s.sessionId, runId: run.runId };
}

/** M7-5-2: 파일당 서버 1개 (Windows loopback ephemeral 포트 고갈 방지) */
let currentApp: Record<string, unknown> | null = null;
const appProxy = new Proxy({}, { get: (_t, k) => { const a = currentApp; if (!a) throw new Error("currentApp 미설정"); const v = a[k as string]; return typeof v === "function" ? v.bind(a) : v; } }) as never;
let sharedPromise: Promise<{ url: string; token: string }> | null = null;
let sharedClose: (() => void) | null = null;
function sharedServer(app: unknown): Promise<{ url: string; token: string }> {
  currentApp = app as Record<string, unknown>;
  sharedPromise ??= createUiServer({ app: appProxy }).then((s) => {
    sharedClose = s.close;
    return { url: s.url, token: s.token };
  });
  return sharedPromise;
}
afterAll(() => {
  sharedClose?.();
  sharedClose = null;
  sharedPromise = null;
  currentApp = null;
});

describe("M7 5-2 승인 정보 (sha + diff)", () => {
  it("스크립트 sha256·내용·approvalHash를 준다", async () => {
    const { app, sid } = await withScriptNode();
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.script?.rel).toBe(scriptRel);
    expect(info.script?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.script?.content).toContain("v1");
    expect(info.approvalHash).toMatch(/^[0-9a-f]/);
  }, 30000);

  it("스크립트가 바뀌면 sha와 diff가 함께 바뀐다 (재승인 필요 배지)", async () => {
    const { app, sid } = await withScriptNode();
    const before = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    writeFileSync(
      join(pfdir, "sessions", sid, scriptRel),
      "print('v2')\nprint('extra')\n",
      "utf8",
    );
    const after = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(after.script?.sha256).not.toBe(before.script?.sha256);
    // 내용은 비교 대상이 된다 (sha가 묶어준다)
    expect(after.script?.content).toContain("extra");
  }, 30000);
});

describe("M7 5-2 승인 POST", () => {
  it("approvalHash가 지금 값과 다르면 409", async () => {
    const { app, sid } = await withScriptNode();
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    const srv = await sharedServer(app);
    try {
      const r = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({
          approvalHash: "0".repeat(64),
          approved: true,
          expectedRevision: (await app.readSession(sid)).revision,
        }),
      });
      expect(r.status).toBe(409);
      // 화면 값으로 승인하면 통과
      const fresh = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
      const ok = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({
          approvalHash: fresh.approvalHash,
          approved: true,
          expectedRevision: (await app.readSession(sid)).revision,
        }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { approvalHash: string };
      expect(body.approvalHash).toBe(info.approvalHash);
    } finally {
      // 서버는 afterAll에서 닫는다
    }
  }, 30000);

  it("approvalHash 누락 400 / stale 승인 표시", async () => {
    const { app, sid } = await withScriptNode();
    const srv = await sharedServer(app);
    try {
      const r = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({ approved: true, expectedRevision: 0 }),
      });
      expect(r.status).toBe(400);
      // 승인 후 스크립트를 바꾸면 needsReapproval
      const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
      await app.uiApprove({
        sessionId: sid,
        nodeId: "1.1",
        approvalHash: info.approvalHash,
        approved: true,
        expectedRevision: (await app.readSession(sid)).revision,
      });
      // 스크립트를 바꾸면 approvalHash가 달라진다 (= 재승인 필요 신호)
      writeFileSync(join(pfdir, "sessions", sid, scriptRel), "print('v3')\n", "utf8");
      const stale = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
      expect(stale.approvalHash).not.toBe(info.approvalHash);
      expect(stale.approved).toBe(false);
    } finally {
      // 서버는 afterAll에서 닫는다
    }
  }, 30000);
});

describe("M7 5-2 diff 유틸", () => {
  it("추가/삭제 줄이 표시된다", () => {
    const d = unifiedDiff("a\nb\nc", "a\nx\nc", "old", "new");
    expect(d).toContain("--- old");
    expect(d).toContain("+++ new");
    expect(d).toContain("-b");
    expect(d).toContain("+x");
    expect(d).toContain(" a");
  });
});
