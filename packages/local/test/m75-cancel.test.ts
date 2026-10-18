import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { isAlive, listChildren } from "../src/app/run-control.js";
import { readRunState } from "../src/services/run-state.js";

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
  const pfdir = join(mkdtempSync(join(tmpdir(), "pf-cancel-e2e-")), ".procforge");
  // remote 모드에서는 로컬 pfdir 이 아직 없다 (core 는 별도 dataDir)
  mkdirSync(pfdir, { recursive: true });
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "run", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
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
    if (kids.length === 0) return;
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