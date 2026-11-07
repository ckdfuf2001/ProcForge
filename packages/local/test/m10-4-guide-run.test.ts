import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup, settleRun } from "./tmp-hooks.js";

useTmpCleanup();

// M10-4: 순차 자동 실행 단위 테스트.
// ① 끝까지 실행 ② 재시작 후 이어감 ③ 실패 시 정지 ④ 취소 시 run 정리.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;
const TOOL = { server: "t", name: "echo" } as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

const liveRuns: { app: ProcForgeApp; pfdir: string; runId: string }[] = [];

beforeEach(() => {
  root = makeTmp("pf-m104-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

afterEach(async () => {
  for (const t of liveRuns.splice(0)) await settleRun(t.app, t.pfdir, t.runId);
}, 30000);

function writeProcedure(name: string, doc: unknown) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "procedure.json"), JSON.stringify(doc));
}

/** 즉시 끝나는 빈 절차서 (m10-3-guide와 같은 모양). */
function instantProcedure(name: string) {
  writeProcedure(name, {
    format: "procforge-procedure",
    version: 1,
    name,
    sourceSession: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [],
  });
}

/** 종료코드 1 스크립트 노드 (승인 항목 미리 저장) — 실행 실패를 낸다. */
async function failingProcedure(name: string) {
  writeFileSync(join(root, "fail.py"), "import sys\nsys.exit(1)\n", "utf8");
  const s = await app.start({ request: "fail", toolCatalog: CAT });
  const sid = s.sessionId;
  await app.split({
    sessionId: sid, nodeId: "1",
    reason: "M10-4 테스트용 분해 사유입니다.",
    children: [{ goal: "x" }],
    expectedRevision: 0,
  } as never);
  await app.report({
    sessionId: sid, nodeId: "1.1", tool: TOOL,
    args: {}, resultSummary: "ok", resultJson: {},
    selfVerdict: "pass", selfReason: "ok",
  });
  await app.confirmLeaf({
    sessionId: sid, nodeId: "1.1", tool: TOOL,
    argSpecs: { script: { kind: "script", file: "fail.py", runtime: "python" } } as never,
  });
  await app.finalize({ sessionId: sid, name });
  const { buildApprovalEntry: build, saveApproval: save } = await import(
    "../src/services/approvals.js"
  );
  save(
    join(pfdir, "procedures", name),
    build(
      {
        id: "1.1", goal: "x",
        tool: { server: "t", name: "echo" },
        args: { script: { kind: "script", file: "fail.py", runtime: "python" } },
        constraints: [],
      },
      [],
    ),
  );
}

describe("M10-4 guide run", () => {
  it("① 2단계 끝까지 실행→done, lane 이벤트 기록", async () => {
    instantProcedure("g-a");
    instantProcedure("g-b");
    const g = await app.startGuide({
      steps: [{ procedure: "g-a", params: {} }, { procedure: "g-b", params: {} }],
    });
    expect(g.state.map((s) => s.status)).toEqual(["pending", "pending"]);
    const r0 = await app.advanceGuide({ guideId: g.guideId });
    expect(r0.status).toBe("done");
    expect(r0.stepIndex).toBe(0);
    const r1 = await app.advanceGuide({ guideId: g.guideId });
    expect(r1.status).toBe("done");
    expect(r1.stepIndex).toBe(1);
    expect(r1.runId).not.toBe(r0.runId);
    const file = await app.guideStatus({ guideId: g.guideId });
    expect(file.state.map((s) => s.status)).toEqual(["done", "done"]);
    // 실행 세션에 lane.started/finished가 실제로 남는다.
    const info = await app.uiRunInfo({ runId: r0.runId });
    expect(file.state[0].sessionId).toBe(info.sessionId);
    const evs = await app.getEventsPage({ sessionId: info.sessionId, afterRevision: 0 });
    expect(evs.events.map((e) => e.method)).toEqual(["lane.started", "lane.finished"]);
    expect(evs.events[0].actor).toBe("ui");
  }, 60000);

  it("② 재시작 후 이어감 (새 App도 같은 파일로 다음 단계)", async () => {
    instantProcedure("g-a");
    instantProcedure("g-b");
    const g = await app.startGuide({
      steps: [{ procedure: "g-a", params: {} }, { procedure: "g-b", params: {} }],
    });
    await app.advanceGuide({ guideId: g.guideId });
    // "재시작": 같은 pfdir로 새 App.
    const { client } = testStack(pfdir);
    const app2 = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const resumed = await app2.guideStatus({ guideId: g.guideId });
    expect(resumed.state.map((s) => s.status)).toEqual(["done", "pending"]);
    const r1 = await app2.advanceGuide({ guideId: g.guideId });
    expect(r1.stepIndex).toBe(1);
    expect(r1.status).toBe("done");
  }, 60000);

  it("③ 실패 시 정지 (다음 단계 자동 실행 없음)", async () => {
    await failingProcedure("g-x");
    instantProcedure("g-a");
    const g = await app.startGuide({
      steps: [{ procedure: "g-x", params: {} }, { procedure: "g-a", params: {} }],
    });
    const r0 = await app.advanceGuide({ guideId: g.guideId });
    expect(r0.status).toBe("failed");
    const file = await app.guideStatus({ guideId: g.guideId });
    expect(file.state.map((s) => s.status)).toEqual(["failed", "pending"]);
  }, 120000);

  it("④ 취소 시 run 정리 + 단계 cancelled", async () => {    const script = ["import time", "time.sleep(60)"].join("\n");
    writeFileSync(join(root, "slow.py"), script, "utf8");
    const s = await app.start({ request: "run", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid, nodeId: "1",
      reason: "M10-4 테스트용 분해 사유입니다.",
      children: [{ goal: "run script" }],
      expectedRevision: 0,
    } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      args: {}, resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { script: { kind: "script", file: "slow.py", runtime: "python" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "g-slow" });
    const g = await app.startGuide({ steps: [{ procedure: "g-slow", params: {} }] });
    const advancing = app.advanceGuide({ guideId: g.guideId, timeoutMs: 120000 });
    // 실행 중이 될 때까지 대기 후 취소.
    let runId = "";
    for (let i = 0; i < 100; i++) {
      const cur = await app.guideStatus({ guideId: g.guideId });
      if (cur.state[0].runId) {
        runId = cur.state[0].runId as string;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runId).not.toBe("");
    liveRuns.push({ app, pfdir, runId });
    const c = await app.cancelGuideStep({ guideId: g.guideId });
    expect(c.status).toBe("cancelled");
    const done = await advancing;
    expect(done.status).toBe("cancelled");
    const file = await app.guideStatus({ guideId: g.guideId });
    expect(file.state[0].status).toBe("cancelled");
    const info = await app.uiRunInfo({ runId });
    expect(info.status).toBe("cancelled");
  }, 180000);

  /** 승인 없는 external 노드 — 무인 경로에서 waiting에 걸린다. */
  async function waitingProcedure(name: string) {
    const s = await app.start({ request: "wait", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid, nodeId: "1",
      reason: "M10-4 테스트용 분해 사유입니다.",
      children: [{ goal: "x" }],
      expectedRevision: 0,
    } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      args: { note: "hi" }, resultSummary: "ok", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
      sideEffect: "external",
    });
    await app.finalize({ sessionId: sid, name });
  }

  function runDirCount(): number {
    try {
      // runs/by-session 은 인덱스이므로 제외.
      return readdirSync(join(pfdir, "runs")).filter((e) => e !== "by-session").length;
    } catch {
      return 0;
    }
  }

  it("⑤ waiting 단계 advance 재호출은 같은 runId로 폴링만 (새 run 없음)", async () => {
    await waitingProcedure("g-w");
    const g = await app.startGuide({ steps: [{ procedure: "g-w", params: {} }] });
    const before = runDirCount();
    const r0 = await app.advanceGuide({ guideId: g.guideId });
    expect(r0.status).toBe("waiting");
    const r1 = await app.advanceGuide({ guideId: g.guideId });
    expect(r1.status).toBe("waiting");
    expect(r1.runId).toBe(r0.runId);
    expect(runDirCount()).toBe(before + 1);
    liveRuns.push({ app, pfdir, runId: r0.runId });
  }, 120000);

  it("⑥ 시간 초과 후 advance는 같은 runId로 끝까지 감 (throw 없음)", async () => {
    writeFileSync(join(root, "slow10.py"), "import time, json\ntime.sleep(10)\nprint(json.dumps({\"slept\": True}))\n", "utf8");
    const s = await app.start({ request: "run", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid, nodeId: "1",
      reason: "M10-4 테스트용 분해 사유입니다.",
      children: [{ goal: "run script" }],
      expectedRevision: 0,
    } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      args: {}, resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { script: { kind: "script", file: "slow10.py", runtime: "python" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "g-s10" });
    const g = await app.startGuide({ steps: [{ procedure: "g-s10", params: {} }] });
    const r0 = await app.advanceGuide({ guideId: g.guideId, timeoutMs: 1000 });
    expect(r0.status).toBe("running");
    liveRuns.push({ app, pfdir, runId: r0.runId });
    const r1 = await app.advanceGuide({ guideId: g.guideId, timeoutMs: 60000 });
    expect(r1.status).toBe("done");
    expect(r1.runId).toBe(r0.runId);
  }, 120000);
});
