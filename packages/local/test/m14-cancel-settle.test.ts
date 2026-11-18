import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runScript } from "../src/runner/script-run.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { listChildren } from "../src/app/run-control.js";
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
  it("① close 미도래: grace+1초 안에 cancelled reject + 판별 로그", async () => {
    const cap = captureStderr();
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
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - t0;
      expect((err as { code?: string } | null)?.code).toBe("cancelled");
      expect((err as Error | null)?.message).toBe("취소됨");
      expect(elapsed).toBeLessThanOrEqual(1300);
      expect(cap.lines.some((l) => l.includes("취소 강제 종료: close 미도래"))).toBe(true);
      console.log(`M14-3-① elapsed=${elapsed}`);
    } finally {
      cap.restore();
    }
  }, 15000);

  it("② terminate 미완료: close는 왔는데 끝나지 않으면 같은 결과 + 판별 로그", async () => {
    const cap = captureStderr();
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
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - t0;
      expect((err as { code?: string } | null)?.code).toBe("cancelled");
      expect((err as Error | null)?.message).toBe("취소됨");
      expect(elapsed).toBeLessThanOrEqual(1300);
      expect(cap.lines.some((l) => l.includes("취소 강제 종료: terminate 미완료"))).toBe(true);
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
});
