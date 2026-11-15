import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup, settleRun } from "./tmp-hooks.js";
import { readRunState } from "../src/services/run-state.js";

// M11-2-ui: listActiveRuns 단위 테스트 (3모드 — testStack이 모드를 가린다).
useTmpCleanup();

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeSlowProc(pfdir: string, name: string, secs = 8) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), `import time; time.sleep(${secs})\nprint('{"ok": true}')\n`, "utf8");
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

function setup(names: string[], secs: Record<string, number> = {}) {
  const root = makeTmp("pf-m112-act-");
  const pfdir = join(root, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  for (const n of names) writeSlowProc(pfdir, n, secs[n] ?? 8);
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  return { pfdir, app };
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

describe("M11-2-ui listActiveRuns", () => {
  it("2개 실행하면 목록에 2개 (이름순)", async () => {
    const { pfdir, app } = setup(["act-b", "act-a"]);
    const ra = await app.uiRun({ procedure: "act-a" });
    const rb = await app.uiRun({ procedure: "act-b" });
    try {
      const rows = app.listActiveRuns();
      expect(rows.map((r) => r.procedure)).toEqual(["act-a", "act-b"]);
      expect(rows.length).toBe(2);
    } finally {
      for (const r of [ra, rb]) {
        try { await settleRun(app, pfdir, r.runId); } catch { /* 정리 베스트 에퍼트 */ }
      }
    }
  }, 120000);

  it("하나 done이면 1개", async () => {
    const { pfdir, app } = setup(["act-a", "act-b"], { "act-a": 3, "act-b": 25 });
    const r1 = await app.uiRun({ procedure: "act-a" });
    const r2 = await app.uiRun({ procedure: "act-b" });
    try {
      expect(await waitStatus(app, r1.runId, ["done"], 60000)).toBe("done");
      // done 기록과 activeRuns 해제 사이에 틈이 있어 폴링으로 확인한다.
      let rows = app.listActiveRuns();
      const t0 = Date.now();
      while (rows.length !== 1 && Date.now() - t0 < 15000) {
        await sleep(500);
        rows = app.listActiveRuns();
      }
      expect(rows.length).toBe(1);
      expect(rows[0].procedure).toBe("act-b");
    } finally {
      try { await settleRun(app, pfdir, r2.runId); } catch { /* 정리 베스트 에퍼트 */ }
    }
  }, 120000);

  it("승인 대기면 waiting:true", async () => {
    const root = makeTmp("pf-m112-act-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const TOOL = { server: "t", name: "echo" };
    const s = await app.start({ request: "ext", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({ sessionId: sid, nodeId: "1", reason: "M11-2-ui 단계 0 실측용입니다.", children: [{ goal: "x" }], expectedRevision: 0 });
    await app.report({ sessionId: sid, nodeId: "1.1", tool: TOOL, args: { note: "hi" }, resultSummary: "ok", resultJson: { note: "hi" }, selfVerdict: "pass", selfReason: "ok" } as never);
    await app.confirmLeaf({ sessionId: sid, nodeId: "1.1", tool: TOOL, argSpecs: { note: { kind: "fixed", value: "hi" } } as never, sideEffect: "external" } as never);
    await app.finalize({ sessionId: sid, name: "act-w" });
    const r = await app.uiRun({ procedure: "act-w" });
    try {
      let waiting: unknown;
      for (let i = 0; i < 40; i++) {
        const st = readRunState(pfdir, r.runId) as { waiting?: unknown } | undefined;
        waiting = st?.waiting;
        if (waiting !== undefined) break;
        await sleep(500);
      }
      expect(waiting).not.toBeUndefined();
      const rows = app.listActiveRuns();
      expect(rows.length).toBe(1);
      expect(rows[0].procedure).toBe("act-w");
      expect(rows[0].waiting).toBe(true);
    } finally {
      try { await app.uiRunCancel({ runId: r.runId }); } catch { /* 정리 베스트 에퍼트 */ }
      try { await settleRun(app, pfdir, r.runId); } catch { /* 정리 베스트 에퍼트 */ }
    }
  }, 120000);
});
