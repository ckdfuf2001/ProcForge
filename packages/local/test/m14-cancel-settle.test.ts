import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runScript } from "../src/runner/script-run.js";
import { recordCancelForced } from "../src/runner/run.js";
import { registerChild, unregisterChild, listChildren } from "../src/app/run-control.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M14-3: 취소 grace 강제 reject (H1 close 미도래 / H4 terminate 미완료).
// ①②는 runScript 직접 호출(주입: 가짜 spawn·terminate·graceMs), ③④는 uiRun 실측.
// 3모드(testStack 경유)로 실행한다.
useTmpCleanup();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

const SLOW = "import time\ntime.sleep(30)\nprint('{\"ok\": true}')\n";
const FAST = "print('{\"ok\": true}')\n";

// close/error를 직접 제어하는 가짜 자식 (실제 프로세스 없음).
function fakeChild(pid = 999999): EventEmitter & { pid: number; stdout: null; stderr: null } {
  const em = new EventEmitter() as EventEmitter & { pid: number; stdout: null; stderr: null };
  em.pid = pid;
  em.stdout = null;
  em.stderr = null;
  return em;
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

function mkProc(pfdir: string, name: string, script: string): string {
  const root = join(pfdir, "..");
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), script, "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{
      id: "1", parentId: null, goal: "g", depth: 0, children: [],
      tool: { server: "t", name: "echo", schemaHash: "h" },
      args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
      sideEffect: "external", dependsOn: [], constraints: [],
    }],
  }));
  return root;
}

async function waitEnd(app: ProcForgeApp, runId: string): Promise<string> {
  for (let i = 0; i < 180; i++) {
    const st = (await app.uiRunInfo({ runId })).status;
    if (st === "done" || st === "failed" || st === "cancelled") return st;
    await sleep(500);
  }
  throw new Error("run 미종료");
}

describe("M14-3 취소 grace 강제 reject", () => {
  it("① close 미도래: grace+1초 안에 cancelled reject + 판별 로그 + 판별 콜백", async () => {
    const cap = captureStderr();
    const reasons: string[] = [];
    try {
      const t0 = Date.now();
      const err = await runScript({
        runtime: "node",
        scriptAbs: "dummy.js",
        args: {},
        cwd: "dummy",
        isCancelled: () => true,
        graceMs: 300,
        spawnImpl: (() => fakeChild()) as never,
        // M14-3-fix 결함 3: 기본 killScriptTree(실제 taskkill) 대신 no-op 주입.
        terminateImpl: () => Promise.resolve(),
        onCancelForced: (r) => {
          reasons.push(r);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - t0;
      expect((err as { code?: string } | null)?.code).toBe("cancelled");
      expect((err as Error | null)?.message).toBe("취소됨");
      expect(elapsed).toBeLessThanOrEqual(1300);
      expect(cap.lines.some((l) => l.includes("취소 강제 종료: close 미도래"))).toBe(true);
      expect(reasons).toEqual(["close 미도래"]);
      console.log(`M14-3-① elapsed=${elapsed}`);
    } finally {
      cap.restore();
    }
  }, 15000);

  it("② terminate 미완료: close는 왔는데 끝나지 않으면 같은 결과 + 판별 로그 + 판별 콜백", async () => {
    const cap = captureStderr();
    const reasons: string[] = [];
    try {
      const em = fakeChild();
      const t0 = Date.now();
      const err = await runScript({
        runtime: "node",
        scriptAbs: "dummy.js",
        args: {},
        cwd: "dummy",
        isCancelled: () => true,
        graceMs: 300,
        spawnImpl: (() => em) as never,
        terminateImpl: () => {
          setTimeout(() => em.emit("close", 1, null), 50);
          return new Promise(() => {});
        },
        onCancelForced: (r) => {
          reasons.push(r);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - t0;
      expect((err as { code?: string } | null)?.code).toBe("cancelled");
      expect((err as Error | null)?.message).toBe("취소됨");
      expect(elapsed).toBeLessThanOrEqual(1300);
      expect(cap.lines.some((l) => l.includes("취소 강제 종료: terminate 미완료"))).toBe(true);
      expect(reasons).toEqual(["terminate 미완료"]);
      console.log(`M14-3-② elapsed=${elapsed}`);
    } finally {
      cap.restore();
    }
  }, 15000);

  it("③ 정상 취소: 강제 종료 줄 0, phase 순서 동일", async () => {
    const root = makeTmp("pf-m14-settle-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    mkProc(pfdir, "slow", SLOW);
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const cap = captureStderr();
    let runId = "";
    try {
      const r = await app.uiRun({ procedure: "slow" });
      runId = r.runId;
      for (let i = 0; i < 100 && listChildren(pfdir, r.runId).length === 0; i++) {
        await sleep(100);
      }
      expect(listChildren(pfdir, r.runId).length).toBeGreaterThan(0);
      const cres = await app.uiRunCancel({ runId: r.runId });
      expect(cres.cancelled).toBe(true);
      const st = await waitEnd(app, r.runId);
      expect(st).toBe("cancelled");
    } finally {
      cap.restore();
    }
    expect(cap.lines.some((l) => l.includes("취소 강제 종료"))).toBe(false);
    const log = await app.uiRunLog({ runId });
    const phases = log.entries
      .map((e) => /\(phase:([^)]+)\)/.exec(e.message)?.[1] ?? "?")
      .filter((p) => p !== "?");
    expect(phases).toEqual(["started", "cancelled", "cancelled"]);
    console.log(`M14-3-③ run=${runId} phases=${phases.join(",")}`);
  }, 120000);

  it("④ 취소 없는 run의 기록은 지금과 같다 (정규화 비교)", async () => {
    const root = makeTmp("pf-m14-settle-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    mkProc(pfdir, "okfast", FAST);
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const r1 = await app.uiRun({ procedure: "okfast" });
    expect(await waitEnd(app, r1.runId)).toBe("done");
    const r2 = await app.uiRun({ procedure: "okfast" });
    expect(await waitEnd(app, r2.runId)).toBe("done");
    const raw1 = readFileSync(join(pfdir, "runs", r1.runId, "report.json"), "utf8");
    const raw2 = readFileSync(join(pfdir, "runs", r2.runId, "report.json"), "utf8");
    const norm = (raw: string): string => {
      const o = JSON.parse(raw) as {
        results: { durationMs?: unknown }[];
        summary: unknown;
        nodeHashes: unknown;
      };
      const results = o.results.map((r) => ({ ...r, durationMs: 0 }));
      return JSON.stringify({ results, summary: o.summary, nodeHashes: o.nodeHashes });
    };
    expect(norm(raw1)).toBe(norm(raw2));
    expect(raw1.includes("cancelled")).toBe(false);
    expect(raw1.includes("취소 강제 종료")).toBe(false);
    console.log(`M14-3-④ identical=${norm(raw1) === norm(raw2)}`);
  }, 120000);

  // ⑤⑥: 타이머→콜백→run 로그·등록 해제의 전체 사슬을 검증한다.
  // run 레벨 강제 재현은 vi.mock으로 spawn을 가로챌 수 없어 결정적으로 불가하므로,
  // runScript에 가짜 자식을 물리고 실제 recordCancelForced 콜백을 연결한다.
  function mkForcedFiles(runId: string): { pfdir: string } {
    const root = makeTmp("pf-m14-settle-");
    const pfdir = join(root, ".procforge");
    mkdirSync(join(pfdir, "runs", runId), { recursive: true });
    registerChild(pfdir, runId, 424242);
    return { pfdir };
  }

  it("⑤ 강제 종료 시 log.ndjson에 판별 줄 1줄 (close 미도래)", async () => {
    const { pfdir } = mkForcedFiles("rid-forced-close");
    const runId = "rid-forced-close";
    const reasons: string[] = [];
    const t0 = Date.now();
    const err = await runScript({
      runtime: "node",
      scriptAbs: "dummy.js",
      args: {},
      cwd: "dummy",
      isCancelled: () => true,
      graceMs: 300,
      spawnImpl: (() => fakeChild()) as never,
      terminateImpl: () => Promise.resolve(),
      onCancelForced: (r) => {
        reasons.push(r);
        recordCancelForced(pfdir, runId, "1", 424242, (pid) => unregisterChild(pfdir, runId, pid), r);
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - t0;
    expect((err as { code?: string } | null)?.code).toBe("cancelled");
    expect(reasons).toEqual(["close 미도래"]);
    expect(elapsed).toBeLessThanOrEqual(1300);
    const lines = readFileSync(join(pfdir, "runs", runId, "log.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("취소 강제 종료: close 미도래 (phase:cancelled)");
    expect(JSON.parse(readFileSync(join(pfdir, "runs", runId, "children.json"), "utf8"))).toEqual([]);
    console.log(`M14-3-⑤ forced-logged elapsed=${elapsed}`);
  }, 15000);

  it("⑥ terminate 미완료 경로도 run 로그에 1줄 남기고 children을 비움", async () => {
    const { pfdir } = mkForcedFiles("rid-forced-term");
    const runId = "rid-forced-term";
    const em = fakeChild();
    const reasons: string[] = [];
    const t0 = Date.now();
    const err = await runScript({
      runtime: "node",
      scriptAbs: "dummy.js",
      args: {},
      cwd: "dummy",
      isCancelled: () => true,
      graceMs: 300,
      spawnImpl: (() => em) as never,
      terminateImpl: () => {
        setTimeout(() => em.emit("close", 1, null), 50);
        return new Promise(() => {});
      },
      onCancelForced: (r) => {
        reasons.push(r);
        recordCancelForced(pfdir, runId, "1", 424242, (pid) => unregisterChild(pfdir, runId, pid), r);
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - t0;
    expect((err as { code?: string } | null)?.code).toBe("cancelled");
    expect(reasons).toEqual(["terminate 미완료"]);
    expect(elapsed).toBeLessThanOrEqual(1300);
    const lines = readFileSync(join(pfdir, "runs", runId, "log.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("취소 강제 종료: terminate 미완료 (phase:cancelled)");
    expect(JSON.parse(readFileSync(join(pfdir, "runs", runId, "children.json"), "utf8"))).toEqual([]);
    console.log(`M14-3-⑥ forced-logged elapsed=${elapsed}`);
  }, 15000);
});
