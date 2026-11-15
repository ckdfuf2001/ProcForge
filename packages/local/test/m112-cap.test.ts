import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup, settleRun } from "./tmp-hooks.js";

// M11-2-cap: 동시 실행 상한 3 (3모드 — testStack이 모드를 가린다).
useTmpCleanup();

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

const SLEEP_S = 15;

function writeSlowProc(pfdir: string, name: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), `import time; time.sleep(${SLEEP_S})\nprint('{"ok": true}')\n`, "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{
      id: "1", parentId: null, goal: "slow", depth: 0, children: [],
      tool: { server: "t", name: "echo", schemaHash: "h" },
      args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
      sideEffect: "external", dependsOn: [], constraints: [],
    }],
  }));
}

function setup(names: string[]) {
  const root = makeTmp("pf-m112-cap-");
  const pfdir = join(root, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  for (const n of names) writeSlowProc(pfdir, n);
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  return { root, pfdir, app };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runDirCount(pfdir: string): number {
  try {
    return readdirSync(join(pfdir, "runs")).length;
  } catch {
    return 0;
  }
}

async function codeOf(p: Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  try {
    await p;
    return { message: "no-error" };
  } catch (e) {
    return { code: (e as { code?: unknown })?.code, message: e instanceof Error ? e.message : String(e) };
  }
}

async function waitStatus(app: ProcForgeApp, runId: string, want: string[], budgetMs: number): Promise<string> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < budgetMs) {
    last = (await app.uiRunInfo({ runId })).status;
    if (want.includes(last)) return last;
    await sleep(1000);
  }
  return last;
}

describe("M11-2-cap 동시 실행 상한 3", () => {
  it("① 3개 실행 중 4번째는 conflict + runs/ 그대로", async () => {
    const { pfdir, app } = setup(["cap-a", "cap-b", "cap-c", "cap-d"]);
    const ra = await app.uiRun({ procedure: "cap-a" });
    const rb = await app.uiRun({ procedure: "cap-b" });
    const rc = await app.uiRun({ procedure: "cap-c" });
    try {
      const n0 = runDirCount(pfdir);
      const r = await codeOf(app.uiRun({ procedure: "cap-d" }));
      expect(r.code).toBe("conflict");
      expect(r.message).toBe("동시 실행 상한(3) 초과");
      expect(runDirCount(pfdir)).toBe(n0);
    } finally {
      for (const r of [ra, rb, rc]) {
        try { await settleRun(app, pfdir, r.runId); } catch { /* 정리 베스트 에퍼트 */ }
      }
    }
  }, 180000);

  it("② 하나 done 후 4번째는 성공", async () => {
    const { pfdir, app } = setup(["cap-a", "cap-b", "cap-c", "cap-d"]);
    const ra = await app.uiRun({ procedure: "cap-a" });
    const rb = await app.uiRun({ procedure: "cap-b" });
    const rc = await app.uiRun({ procedure: "cap-c" });
    expect(await waitStatus(app, ra.runId, ["done"], 90000)).toBe("done");
    const rd = await app.uiRun({ procedure: "cap-d" });
    try {
      expect(rd.runId).toBeTruthy();
    } finally {
      for (const r of [rb, rc, rd]) {
        try { await settleRun(app, pfdir, r.runId); } catch { /* 정리 베스트 에퍼트 */ }
      }
    }
  }, 180000);

  it("③ 같은 절차서 중복은 기존 메시지 그대로", async () => {
    const { pfdir, app } = setup(["cap-a"]);
    const ra = await app.uiRun({ procedure: "cap-a" });
    try {
      const r = await codeOf(app.uiRun({ procedure: "cap-a" }));
      expect(r.code).toBe("conflict");
      expect(r.message.startsWith("이미 실행 중입니다")).toBe(true);
    } finally {
      try { await settleRun(app, pfdir, ra.runId); } catch { /* 정리 베스트 에퍼트 */ }
    }
  }, 180000);

  it("④ App2 2개 + App1 1개 실행 중 App1 다음 요청은 conflict", async () => {
    const root = makeTmp("pf-m112-cap-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    for (const n of ["cap-e", "cap-f", "cap-g", "cap-h"]) writeSlowProc(pfdir, n);
    const app1 = new ProcForgeApp({ core: testStack(pfdir).client, procforgeDir: pfdir, projectRoot: root });
    const app2 = new ProcForgeApp({ core: testStack(pfdir).client, procforgeDir: pfdir, projectRoot: root });
    const re = await app2.uiRun({ procedure: "cap-e" });
    const rf = await app2.uiRun({ procedure: "cap-f" });
    // App2의 drive 하트비트가 뜰 때까지 대기 (없으면 셈이 어긋난다).
    const lockDir = join(pfdir, "procedures", ".locks");
    const t0 = Date.now();
    let lockFiles: string[] = [];
    for (;;) {
      let files: string[] = [];
      try { files = readdirSync(lockDir); } catch { files = []; }
      lockFiles = files;
      if (files.includes("cap-e.drive.lock") && files.includes("cap-f.drive.lock")) break;
      if (Date.now() - t0 > 15000) break;
      await sleep(500);
    }
    // M11-2-cap-fix: lock 2개 단언 (대기 실패와 상한 실패를 구분한다).
    expect(lockFiles).toContain("cap-e.drive.lock");
    expect(lockFiles).toContain("cap-f.drive.lock");
    const rg = await app1.uiRun({ procedure: "cap-g" });
    try {
      const r = await codeOf(app1.uiRun({ procedure: "cap-h" }));
      expect(r.code).toBe("conflict");
      expect(r.message).toBe("동시 실행 상한(3) 초과");
    } finally {
      for (const [a, r] of [[app2, re], [app2, rf], [app1, rg]] as const) {
        try { await settleRun(a, pfdir, r.runId); } catch { /* 정리 베스트 에퍼트 */ }
      }
    }
  }, 180000);

  it("⑤ 2개 실행 중 서로 다른 2개를 동시에 요청하면 정확히 1개만 conflict", async () => {
    const { pfdir, app } = setup(["cap-a", "cap-b", "cap-c", "cap-d"]);
    const ra = await app.uiRun({ procedure: "cap-a" });
    const rb = await app.uiRun({ procedure: "cap-b" });
    const done: string[] = [];
    try {
      const [rc, rd] = await Promise.allSettled([
        app.uiRun({ procedure: "cap-c" }),
        app.uiRun({ procedure: "cap-d" }),
      ]);
      const ok = [rc, rd].filter((r) => r.status === "fulfilled");
      const ng = [rc, rd].filter((r) => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(ng.length).toBe(1);
      const err = (ng[0] as PromiseRejectedResult).reason as { code?: unknown; message?: string };
      expect(err.code).toBe("conflict");
      expect(err.message).toBe("동시 실행 상한(3) 초과");
      for (const r of ok) {
        done.push((r as PromiseFulfilledResult<{ runId: string }>).value.runId);
      }
    } finally {
      for (const runId of [...done, ra.runId, rb.runId]) {
        try { await settleRun(app, pfdir, runId); } catch { /* 정리 베스트 에퍼트 */ }
      }
    }
  }, 180000);
});
