import { describe, it, expect, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { isAlive, listChildren, killProcessTree } from "../src/app/run-control.js";
import { readRunState } from "../src/services/run-state.js";
import { makeTmp, cleanRegisteredTmp, cleanRegisteredTmpUntil } from "@proof/shared/tmp.js";
import { useTmpCleanup, settleRun } from "./tmp-hooks.js";

// M9-tmp2: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M9-tmp2-fix: 만든 실행은 테스트가 끝나기 전에 수습한다 (취소+종료대기).
// afterAll rmSync와 살아 있는 자식·열린 로그 핸들의 경쟁(EBUSY 부분 정리)을 막는다.
const liveRuns: { app: ProcForgeApp; pfdir: string; runId: string }[] = [];
// M11-e2e-tmp-leak: afterEach가 splice로 비워도 afterAll 2중망용으로 전수 보관한다.
const auditRuns: { app: ProcForgeApp; pfdir: string; runId: string }[] = [];
// 예산: hook 30s > settle 20s (SETTLE_BUDGET_MS). hook이 먼저 끊기면
// afterAll rmSync와 살아 있는 자식·열린 로그 핸들의 경쟁(EBUSY 부분 정리)을 막는다.
afterEach(async () => {
  for (const t of liveRuns.splice(0)) await settleRun(t.app, t.pfdir, t.runId);
}, 30000);

// M11-e2e-tmp-leak: L3 뒤 pf-cancel-e2e-* 잔재(+1) 방지 2중망.
// afterEach settle로도 자식이 늦게 죽으면 afterAll rmSync가 Windows 잠금에
// 막혀 폴더가 남는다. 여기서 잔존 트리를 직접 죽이고 등록 정리를 재시도한다.
// M14-1-fix: afterAll 정리 예산. settle 최대 20초×런 수 + 잔존 kill + 재시도
// 8초 마감을 60초 hook 안에 둔다 (dev-verify의 --hookTimeout=20000보다 파일
// 인자가 우선하므로 여기서 60000을 박는다). 마감을 넘겨도 FAIL하지 않는다.
const CLEANUP_DEADLINE_MS = 8000;
afterAll(async () => {
  for (const t of auditRuns) {
    try {
      await settleRun(t.app, t.pfdir, t.runId);
      for (const pid of listChildren(t.pfdir, t.runId)) {
        if (isAlive(pid)) await killProcessTree(pid);
      }
    } catch { /* 정리 베스트 에퍼트 */ }
  }
  // M14-1-fix2: 재시도 루프를 shared로 추출 (마감·간격 인자, 무한 재시도 금지).
  // 마감을 넘겨도 FAIL하지 않고 남은 dir을 돌려준다.
  const remain = await cleanRegisteredTmpUntil(CLEANUP_DEADLINE_MS, 500);
  if (remain.length > 0) {
    process.stderr.write("[tmp] 정리 마감(8초) 초과, 잔재 남김 (best-effort, FAIL 아님)\n");
  }
  // M14-1-fix 계측: 멈춘 원인 확정을 위해 남은 잔재마다 run 상태를 정리 실패
  // 기록에 남긴다 (FAIL 아님 — stderr 1줄씩).
  for (const t of auditRuns) {
    try {
      if (!existsSync(join(t.pfdir, "runs", t.runId))) continue;
      const st = readRunState(t.pfdir, t.runId);
      process.stderr.write(
        `[tmp] 잔재 runId=${t.runId} status=${st?.status ?? "none"} pending=${(st?.pending ?? []).join(",")} done=${(st?.done ?? []).join(",")} waiting=${st?.waiting ? `${st.waiting.nodeId}:${st.waiting.kind}` : "-"} children=${listChildren(t.pfdir, t.runId).join(",")}\n`,
      );
    } catch { /* 기록 베스트 에퍼트 */ }
  }
}, 60000);


// M7-5-a/b: 취소가 **실제 runner가 띄운 자식**을 멈추는지.
// 헬퍼 프로세스가 아니라 (1) 세션 → leaf 확정 → 절차서 → uiRun → runStep 실제 경로로
// 스크립트를 실행하고, 그 pid 를 취소로 죽인다.
// POSIX(b) 는 같은 그룹의 **손자**까지 죽어야 한다 — 개별 pid 만 죽으면 손자가 산다.

const catalog = [
  { server: "fs", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

const SCRIPT = [
  "import os, subprocess, sys, time",
  // 손자: 같은 그룹에 속하는 길게 사는 프로세스
  "kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
  "print(kid.pid, flush=True)",
  "time.sleep(120)",
].join("\n");

async function running() {
  const pfdir = join(makeTmp("pf-cancel-e2e-"), ".procforge");
  // remote 모드에서는 로컬 pfdir 이 아직 없다 (core 는 별도 dataDir)
  mkdirSync(pfdir, { recursive: true });
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "run", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "run script" }],
    expectedRevision: 0,
  });
  // 절차서 수집은 projectRoot 아래 .py/.mjs 를 본다
  writeFileSync(join(pfdir, "slow.py"), SCRIPT, "utf8");
  const sdir = join(pfdir, "sessions", s.sessionId);
  mkdirSync(join(sdir, "scripts"), { recursive: true });
  writeFileSync(join(sdir, "slow.py"), SCRIPT, "utf8");
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
    argSpecs: { script: { kind: "script", file: "slow.py", runtime: "python" } },
  });
  await app.finalize({ sessionId: s.sessionId, name: "slow" });
  const run = await app.uiRun({ procedure: "slow" });
  liveRuns.push({ app, pfdir, runId: run.runId });
  auditRuns.push({ app, pfdir, runId: run.runId });
  let kids: number[] = [];
  for (let i = 0; i < 100 && kids.length === 0; i++) {
    kids = listChildren(pfdir, run.runId);
    if (kids.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
  return { pfdir, app, run, kids };
}

describe("M7-5-a 실제 runner 자식이 취소에 죽는다", () => {
  it("등록 → 취소 → 프로세스 종료 (헬퍼 아님)", async () => {
    const { pfdir, app, run, kids } = await running();
    // 취소가 잡을 대상이 실제로 등록돼야 의미가 있다
    expect(kids.length).toBeGreaterThan(0);
    const child = kids[0];
    expect(isAlive(child)).toBe(true);

    const res = await app.uiRunCancel({ runId: run.runId });
    expect(res.cancelled).toBe(true);

    for (let i = 0; i < 100 && isAlive(child); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(child)).toBe(false);
    // 실행 기록은 남는다 (취소는 기록을 지우지 않는다)
    expect(readRunState(pfdir, run.runId)?.runId).toBe(run.runId);
  }, 180000);

  it("취소 로그와 actor ui 기록이 남는다", async () => {
    const { pfdir, app, run, kids } = await running();
    // M9-tmp2-fix: 조용 통과 금지 — 취소 대상이 없으면 테스트가 아무것도 검증하지 않는다.
    expect(kids.length).toBeGreaterThan(0);
    const srv = await createUiServer({ app: app as never });
    try {
      await app.uiRunCancel({ runId: run.runId });
      await new Promise((r) => setTimeout(r, 300));
      const log = await app.uiRunLog({ runId: run.runId });
      expect(log.entries.some((e) => e.message.includes("취소"))).toBe(true);
      const st = readRunState(pfdir, run.runId);
      expect(st).toBeDefined();
    } finally {
      srv.close();
    }
  }, 180000);
});

describe("M7-5-b POSIX: 손자까지 죽는다 (그룹 kill)", () => {
  it.runIf(process.platform !== "win32")("detached 그룹 → grandchild 0", async () => {
    const { app, run, kids } = await running();
    expect(kids.length).toBeGreaterThan(0);
    const child = kids[0];
    // 자식의 손자를 확인해 둔다 (죽이기 전에 "살아 있음"을 보증)
    const grandkids = execSync(`pgrep -P ${child} || true`, { encoding: "utf8" })
      .split("\n")
      .filter((x) => x.trim())
      .map(Number);
    const aliveBefore = grandkids.filter((p) => isAlive(p));
    expect(aliveBefore.length).toBeGreaterThan(0);

    await app.uiRunCancel({ runId: run.runId });
    for (let i = 0; i < 100 && isAlive(child); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isAlive(child)).toBe(false);
    // 그룹을 죽이지 않으면 손자가 산다 — 여기가 진짜 단언
    for (const g of aliveBefore) {
      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        alive = isAlive(g);
        if (alive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(isAlive(g)).toBe(false);
    }
  }, 180000);
});