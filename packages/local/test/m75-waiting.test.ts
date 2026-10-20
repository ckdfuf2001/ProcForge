import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp, type AppDeps } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { readRunState } from "../src/services/run-state.js";
import { readEvents } from "../src/trace.js";

// M7-5-b: 승인/생성값 **대기**는 디스크(run-state.waiting)에 적힌다.
//   1) 승인 → 계속 → done
//   2) 거부 → 그 절차서가 409 고착되지 않고 다시 돈다
//   3) 대기 중 취소 → 즉시 잠금 해제
//   4) 서버 재시작 후에도 승인 재개가 된다
// 이전엔 대기가 메모리 Set 뿐이고 runApprove 가 "기록만" 하고 재개하지도 않아서
// 2~4 가 전부 "영원히 얼어붙음"이었다.

const ECHO_CAT = [
  { server: "fake-ppt", name: "echo", inputSchema: { type: "object" }, schemaHash: "h" },
];

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-wait-"));
  pfdir = join(root, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  // uiRun 은 실제 러너로 돌리므로 MCP 서버가 등록돼 있어야 한다
  const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
    "utf8",
  );
});

async function mkApp(extra?: Partial<AppDeps>) {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
    ...extra,
  });
}

/** external(승인 필요) leaf 하나짜리 절차서를 만들고 uiRun 까지 진행해 **대기 상태**로 둔다 */
async function waitingRun(name = "ext-proc", extra?: Partial<AppDeps>) {
  const app = await mkApp(extra);
  const started = await app.core.pfStart({
    request: "ext",
    toolCatalog: ECHO_CAT as never,
  });
  const sid = started.session.id;
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "split",
    children: [{ goal: "x" }],
  });
  await app.core.pfReport({
    sessionId: sid,
    nodeId: "1.1",
    tool: { server: "fake-ppt", name: "echo" },
    args: { note: "hi" },
    resultSummary: "ok",
    resultJson: { note: "hi" },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1.1",
    decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    sideEffect: "external",
  });
  await app.finalize({ sessionId: sid, name });
  const run = await app.uiRun({ procedure: name });
  // driveRun 이 멈출 때까지 기다린다
  for (let i = 0; i < 300; i++) {
    if (readRunState(pfdir, run.runId)?.waiting) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { app, run, sessionId: sid, nodeId: "1.1" };
}

/**
 * M7-close-b: external + **와일드카드**(var) 인자 leaf. 승인 화면에서 키를 명시
 * 선택해야 하는 케이스 — 거부는 선택 없이 가능해야 한다.
 * var ref 는 `${params.x}` (선언된 param 이라 finalize 검사를 통과, 실행 시 값 확정).
 */
async function waitingRunWildcard(name = "ext-wild") {
  const app = await mkApp();
  const started = await app.core.pfStart({
    request: "ext",
    params: { x: "v" },
    toolCatalog: ECHO_CAT as never,
  });
  const sid = started.session.id;
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "split",
    children: [{ goal: "x" }],
  });
  await app.core.pfReport({
    sessionId: sid,
    nodeId: "1.1",
    tool: { server: "fake-ppt", name: "echo" },
    args: { note: "hi" },
    resultSummary: "ok",
    resultJson: { note: "hi" },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1.1",
    decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { note: { kind: "var", ref: "${params.x}" } } as never,
    sideEffect: "external",
  });
  await app.finalize({ sessionId: sid, name });
  const run = await app.uiRun({ procedure: name, params: { x: "v" } });
  for (let i = 0; i < 300; i++) {
    if (readRunState(pfdir, run.runId)?.waiting) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { app, run, sessionId: sid, nodeId: "1.1" };
}

async function waitStatus(runId: string, want: string) {
  for (let i = 0; i < 300; i++) {
    const st = readRunState(pfdir, runId);
    if (st?.status === want) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readRunState(pfdir, runId);
}

describe("M7-5-b 대기 실행 영속", () => {
  it("대기 상태가 디스크에 기록된다", async () => {
    const { run } = await waitingRun();
    const st = readRunState(pfdir, run.runId);
    expect(st?.status).toBe("suspended");
    expect(st?.waiting?.nodeId).toBe("1.1");
  }, 60000);

  it("승인 → 이어서 실행 → done", async () => {
    const { app, run, nodeId } = await waitingRun();
    await app.runApprove({ runId: run.runId, nodeId });
    const st = await waitStatus(run.runId, "done");
    if (st?.status !== "done") throw new Error(`failed: ${st?.failedNodeId} ${st?.failedDetail}`);
    expect(st?.status).toBe("done");
    expect(st?.waiting).toBeUndefined();
  }, 60000);

  it("거부 → 그 절차서를 다시 돌릴 수 있다 (409 고착 아님)", async () => {
    const { app, run, nodeId } = await waitingRun();
    await app.runApprove({ runId: run.runId, nodeId, approved: false });
    const st = readRunState(pfdir, run.runId);
    expect(st?.status).toBe("cancelled");
    expect(st?.waiting).toBeUndefined();
    // 잠금이 풀렸는지: 같은 절차서를 다시 시작할 수 있어야 한다
    const again = await app.uiRun({ procedure: "ext-proc" });
    expect(again.runId).not.toBe(run.runId);
  }, 60000);

  it("대기 중 취소 → 즉시 잠금 해제, 다시 시작 가능", async () => {
    const { app, run } = await waitingRun();
    await app.uiRunCancel({ runId: run.runId });
    const st = readRunState(pfdir, run.runId);
    expect(st?.waiting).toBeUndefined();
    const again = await app.uiRun({ procedure: "ext-proc" });
    expect(again.runId).not.toBe(run.runId);
  }, 60000);

  it("waiting 기록 직후·캐시 등록 전 취소도 cancelled 로 확정된다", async () => {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const atGate = new Promise<void>((r) => (reached = r));
    let calls = 0;
    const { app, run } = await waitingRun("ext-proc", {
      onWaitingPersisted: async () => {
        calls += 1;
        if (calls === 1) {
          reached();
          await gate;
        }
      },
    });
    await atGate;
    // 아직 driveRun 은 waitingRuns 캐시에 넣기 전이다.
    expect(readRunState(pfdir, run.runId)?.status).toBe("suspended");
    expect(readRunState(pfdir, run.runId)?.waiting).toBeDefined();

    await app.uiRunCancel({ runId: run.runId });
    expect(readRunState(pfdir, run.runId)?.status).toBe("cancelled");
    expect(readRunState(pfdir, run.runId)?.waiting).toBeUndefined();

    // 잠금이 풀렸는지: 같은 절차서를 다시 시작할 수 있어야 한다.
    const again = await app.uiRun({ procedure: "ext-proc" });
    expect(again.runId).not.toBe(run.runId);
    open();
    await app.uiRunCancel({ runId: again.runId });
  }, 60000);

  it("재시작 후에도 승인이 재개된다 (대기는 디스크)", async () => {
    const { run, nodeId } = await waitingRun();
    // 메모리를 전부 버린 새 인스턴스 (= 서버 재시작)
    const app2 = await mkApp();
    // 새 프로세스라면 이게 409 여야 한다 (대기 중이므로 막힌다)
    await expect(app2.uiRun({ procedure: "ext-proc" })).rejects.toThrow(/이미 실행 중/);
    await app2.runApprove({ runId: run.runId, nodeId });
    const st = await waitStatus(run.runId, "done");
    if (st?.status !== "done") throw new Error(`failed: ${st?.failedNodeId} ${st?.failedDetail}`);
    expect(st?.status).toBe("done");
  }, 60000);
});

// M7-close-b: 실행 승인(uiRunApprove)의 회귀 — (1) 와일드카드 노드 **거부** 가능,
// (2) expectedRevision 실제 비교(불일치 409), (3) 승인 시 와일드카드 키 미선택 거부,
// (4) note 가 calls.jsonl 에 남는다.
describe("M7-close-b uiRunApprove 보정", () => {
  it("와일드카드 노드는 키 선택 없이 **거부**할 수 있다", async () => {
    const { app, run, nodeId } = await waitingRunWildcard();
    // 승인은 **실행 세션**(import 결과) 기준이다 — 화면도 run.sessionId 로 해시·리비전을 본다.
    const runSid = readRunState(pfdir, run.runId)!.sessionId;
    const info = await app.uiApprovalInfo({ sessionId: runSid, nodeId });
    expect(info.wildcardKeys).toContain("note");
    const rev = (await app.core.getSession(runSid)).revision;
    await app.uiRunApprove({
      runId: run.runId,
      nodeId,
      approvalHash: info.approvalHash,
      approved: false,
      expectedRevision: rev,
      note: "범위 밖",
    });
    const st = readRunState(pfdir, run.runId);
    expect(st?.status).toBe("cancelled");
    expect(st?.waiting).toBeUndefined();
    // note 가 버려지지 않고 호출 기록에 남는다
    const calls = readEvents(pfdir, runSid).filter(
      (e) => e.tool === "pf_run_approve",
    );
    expect(calls.at(-1)?.actor).toBe("ui");
    expect(calls.at(-1)?.note).toBe("범위 밖");
  }, 60000);

  it("expectedRevision 불일치면 409 (승인 전에 막는다)", async () => {
    const { app, run, nodeId } = await waitingRunWildcard();
    const runSid = readRunState(pfdir, run.runId)!.sessionId;
    const info = await app.uiApprovalInfo({ sessionId: runSid, nodeId });
    const rev = (await app.core.getSession(runSid)).revision;
    await expect(
      app.uiRunApprove({
        runId: run.runId,
        nodeId,
        approvalHash: info.approvalHash,
        approved: true,
        expectedRevision: rev + 1,
      }),
    ).rejects.toThrow(/revision mismatch/);
    // 대기는 그대로 (거부·승인 반영 안 됨)
    expect(readRunState(pfdir, run.runId)?.status).toBe("suspended");
  }, 60000);

  it("승인인데 와일드카드 키 미선택이면 거부(bad_request)", async () => {
    const { app, run, nodeId } = await waitingRunWildcard();
    const runSid = readRunState(pfdir, run.runId)!.sessionId;
    const info = await app.uiApprovalInfo({ sessionId: runSid, nodeId });
    const rev = (await app.core.getSession(runSid)).revision;
    await expect(
      app.uiRunApprove({
        runId: run.runId,
        nodeId,
        approvalHash: info.approvalHash,
        approved: true,
        expectedRevision: rev,
      }),
    ).rejects.toThrow(/와일드카드 미지정/);
  }, 60000);
});