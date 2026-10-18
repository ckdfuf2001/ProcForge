import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { unifiedDiff, diffStat, DIFF_SKIPPED } from "../src/services/diff.js";

// M7-5-e/f/g/h/i: 승인이 실제로 통하는지.
// e diff 는 **스냅샷** 대 현재본 / f 해시 없는 이력은 미승인 /
// g 스크립트 읽기 sandbox / h 큰 입력은 표를 만들지 않는다 / i approved 명시.

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-apv2-")), ".procforge");
});

const catalog = [
  { server: "fs", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let currentApp: Record<string, unknown> | null = null;
const appProxy = new Proxy(
  {},
  {
    get: (_t, k) => {
      const a = currentApp;
      if (!a) throw new Error("currentApp 미설정");
      const v = a[k as string];
      return typeof v === "function" ? v.bind(a) : v;
    },
  },
) as never;
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

/** 승인 대기가 아닌, 스크립트 인자를 가진 leaf 세션 */
/** 승인 대기가 성립하는 **실행 세션**을 만든다 (실행은 import 세션에서 돈다). */
async function withScriptNode() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    children: [{ goal: "a" }],
    expectedRevision: 0,
  });
  mkdirSync(join(pfdir, "scripts"), { recursive: true });
  writeFileSync(join(pfdir, "scripts/step.py"), "print('v1')\n", "utf8");
  const sdir = join(pfdir, "sessions", s.sessionId);
  mkdirSync(join(sdir, "scripts"), { recursive: true });
  writeFileSync(join(sdir, "scripts/step.py"), "print('v1')\n", "utf8");
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
  const built = await app.finalize({ sessionId: s.sessionId, name: "demo" });
  const run = await app.runStart({ procedure: "demo" });
  const rsid = run.sessionId;
  // 실행 세션에서 승인 대기를 만든다 (pf_approve 대상)
  await app.askHuman({
    sessionId: rsid,
    nodeId: "1.1",
    question: "실행해도 될까요?",
    plan: { tool: { server: "fs", name: "read" }, args: { path: "out.txt" } },
  });
  const procedureDir = join(pfdir, "procedures", "demo");
  return {
    app,
    sid: rsid,
    procedureDir,
    sdir: join(pfdir, "sessions", rsid),
    built,
  };
}

async function approve(app: ProcForgeApp, sid: string, hash: string) {
  return app.uiApprove({
    sessionId: sid,
    nodeId: "1.1",
    approvalHash: hash,
    approved: true,
    expectedRevision: (await app.readSession(sid)).revision,
  });
}

describe("M7-5-e 승인 스냅샷 → diff 가 산다", () => {
  it("승인 → 수정 → diff 에 -v1 / +v2", async () => {
    const { app, sid, procedureDir, sdir } = await withScriptNode();
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.script?.content).toContain("v1");
    await approve(app, sid, info.approvalHash);
    // eslint-disable-next-line no-console
    

    // 스냅샷이 남는다
    const approvedDir = join(procedureDir, "approved");
    expect(existsSync(approvedDir)).toBe(true);

    // 승인 후 수정 → diff 가 실제로 나온다
    // 실제 노드가 가리키는 스크립트 경로(= 절차서가 정규화한 이름)를 고친다
    writeFileSync(join(sdir, info.script?.rel ?? "scripts/step.py"), "print('v2')\n", "utf8");
    const after = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });

    expect(after.diff).not.toBeNull();
    expect(after.diff).toContain("-print('v1')");
    expect(after.diff).toContain("+print('v2')");
  }, 60000);
});

describe("M7-5-f approvalHash 없는 이력 = 미승인", () => {
  it("해시 없는 승인은 재승인 필요하다", async () => {
    const { app, sid, procedureDir } = await withScriptNode();
    // v1 형식(해시 없음) 이력을 손으로 심는다
    writeFileSync(
      join(procedureDir, "approvals.json"),
      JSON.stringify({
        version: 2,
        entries: [
          {
            node: { id: "1.1", hash: "whatever" },
            tool: { server: "fs", name: "read" },
          },
        ],
      }),
      "utf8",
    );
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.approved).toBe(false);
  }, 60000);
});

describe("M7-5-d 스크립트 읽기 sandbox e2e", () => {
  /**
   * "../" 를 가진 leaf 를 **픽스처에서 직접** 만든다.
   * (이전 테스트는 이미 확정된 노드에 confirmLeaf 를 다시 걸어 인자가 안 바뀌었고,
   *  비밀 값이 안 보인다는 건 당연한 결과였다)
   */
  async function sessionWithEscapeScript(rel: string) {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
    });
    const s = await app.start({ request: "r", toolCatalog: catalog as never });
    await app.split({
      sessionId: s.sessionId,
      nodeId: "1",
      children: [{ goal: "a" }],
      expectedRevision: 0,
    });
    await app.report({
      sessionId: s.sessionId,
      nodeId: "1.1",
      tool: { server: "fs", name: "read" },
      args: {},
      resultSummary: "ok",
      selfVerdict: "pass",
      selfReason: "ok",
    });
    // 만들 때부터 탈출 경로를 넣는다 (그래야 실제 경로가 들어간다)
    await app.confirmLeaf({
      sessionId: s.sessionId,
      nodeId: "1.1",
      tool: { server: "fs", name: "read" },
      argSpecs: { script: { kind: "script", file: rel, runtime: "python" } },
    });
    return { app, sid: s.sessionId };
  }

  it("../ 경로 노드는 본문을 새지 않는다", async () => {
// "../secret.txt" 는 **세션 디렉터리 바깥**(sessions/secret.txt)을 가리킨다.
    // 거기 실제로 파일을 둔다 — 없으면 "안 보임"이 아니라 "파일이 없어서 안 보임"이다.
    mkdirSync(join(pfdir, "sessions"), { recursive: true });
    writeFileSync(join(pfdir, "sessions", "secret.txt"), "TOP-SECRET", "utf8");
    const { app, sid } = await sessionWithEscapeScript("../secret.txt");
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(JSON.stringify(info)).not.toContain("TOP-SECRET");
    // 못 읽었으므로 본문은 비어 있다
    expect(info.script?.content ?? "").toBe("");
  }, 60000);

  it("sandbox 안 경로 노드는 본문을 준다 (대조군)", async () => {
    const sdir = join(pfdir, "sessions");
    mkdirSync(sdir, { recursive: true });
    const { app, sid } = await sessionWithEscapeScript("scripts/inside.py");
    const sess = join(sdir, sid, "scripts");
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, "inside.py"), "print('v1')\n", "utf8");
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.script?.content).toContain("print('v1')");
  }, 60000);
});

describe("M7-5-h 큰 diff 는 표를 만들지 않는다", () => {
  it("1만 줄 × 1만 줄 → 생략 (메모리 폭주 없음)", () => {
    const a = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join("\n");
    const b = Array.from({ length: 10_000 }, (_, i) => `line ${i}X`).join("\n");
    const t0 = Date.now();
    const d = unifiedDiff(a, b, "old", "new");
    expect(d).toBe(DIFF_SKIPPED);
    expect(diffStat(a, b)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 30000);

  it("작은 diff 는 그대로", () => {
    const d = unifiedDiff("a\nb\nc", "a\nx\nc", "old", "new");
    expect(d).toContain("-b");
    expect(d).toContain("+x");
  });
});

describe("M7-5-i approved 는 명시해야 한다", () => {
  it("빠지면 400 (조용히 승인으로 만들지 않는다)", async () => {
    const { app, sid } = await withScriptNode();
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    const srv = await sharedServer(app);
    const r = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-procforge-token": srv.token },
      body: JSON.stringify({
        approvalHash: info.approvalHash,
        expectedRevision: (await app.readSession(sid)).revision,
      }),
    });
    expect(r.status).toBe(400);
  }, 60000);
});
