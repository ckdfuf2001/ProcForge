import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { listChildren } from "../src/app/run-control.js";
import { aggregate } from "../src/services/lessons-agg.js";
import { readEventsText } from "../src/services/events-log.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M13-1: 취소 기록 정확성 (취소된 노드는 cancelled, 실패가 아니다).
// 3모드(__testStack__ 경유: inprocess/loopback/remote).
useTmpCleanup();

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkProc(pfdir: string, root: string, name: string, script: string): void {
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
}

async function waitEnd(app: ProcForgeApp, runId: string, timeoutMs = 90000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const st = (await app.uiRunInfo({ runId })).status;
    if (st === "done" || st === "failed" || st === "cancelled") return st;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run 미종료: ${st}`);
    await sleep(500);
  }
}

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}

const SLOW = "import time\ntime.sleep(30)\nprint('{\"ok\": true}')\n";
const FAST = "print('{\"ok\": true}')\n";

describe("M13-1 취소 기록", () => {
  for (let round = 1; round <= 3; round++) {
    it(`① 실행 중 취소 ${round}/3회차: run과 노드 모두 cancelled`, async () => {
      const root = makeTmp("pf-m13-cancel-");
      const pfdir = join(root, ".procforge");
      mkdirSync(pfdir, { recursive: true });
      mkProc(pfdir, root, "slow", SLOW);
      const { client } = testStack(pfdir);
      const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
      const r = await app.uiRun({ procedure: "slow" });
      for (let i = 0; i < 100 && listChildren(pfdir, r.runId).length === 0; i++) {
        await sleep(100);
      }
      const kids = listChildren(pfdir, r.runId);
      // 조용 통과 금지 — 취소 대상(실행 중 자식)이 없으면 검증이 아니다.
      expect(kids.length).toBeGreaterThan(0);
      const cres = await app.uiRunCancel({ runId: r.runId });
      expect(cres.cancelled).toBe(true);
      const st = await waitEnd(app, r.runId);
      expect(st).toBe("cancelled");
      const rep = readJson(join(pfdir, "runs", r.runId, "report.json")) as {
        results: { nodeId: string; status: string; detail?: string }[];
      };
      const n1 = rep.results.find((x) => x.nodeId === "1");
      expect(n1?.status).toBe("cancelled");
      expect(n1?.detail).toBe("취소됨");
      expect(rep.results.filter((x) => x.status === "fail").length).toBe(0);
      expect(existsSync(join(pfdir, "runs", r.runId, "cancel.json"))).toBe(true);
      const state = readJson(join(pfdir, "runs", r.runId, "state.json")) as { status: string };
      expect(state.status).toBe("cancelled");
      console.log(`M13-1-① round-${round} run=${r.runId} node=1 status=${n1?.status} final=${st}`);
    }, 120000);
  }

  it("② 시작 직후 취소: fail 노드 0건", async () => {
    const root = makeTmp("pf-m13-cancel-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    mkProc(pfdir, root, "slow", SLOW);
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const r = await app.uiRun({ procedure: "slow" });
    const cres = await app.uiRunCancel({ runId: r.runId });
    expect(cres.cancelled).toBe(true);
    const st = await waitEnd(app, r.runId);
    expect(st).toBe("cancelled");
    const repPath = join(pfdir, "runs", r.runId, "report.json");
    if (existsSync(repPath)) {
      const rep = readJson(repPath) as {
        results: { nodeId: string; status: string }[];
      };
      expect(rep.results.filter((x) => x.status === "fail").length).toBe(0);
      const n1 = rep.results.find((x) => x.nodeId === "1");
      if (n1) expect(n1.status).toBe("cancelled");
    }
    expect(existsSync(join(pfdir, "runs", r.runId, "cancel.json"))).toBe(true);
    console.log(`M13-1-② run=${r.runId} final=${st} report=${existsSync(repPath) ? "exists" : "absent"}`);
  }, 120000);

  it("③ 취소 없는 run은 기존 기록과 바이트 단위로 동일(회귀)", async () => {
    const root = makeTmp("pf-m13-cancel-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    mkProc(pfdir, root, "okfast", FAST);
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const r1 = await app.uiRun({ procedure: "okfast" });
    expect(await waitEnd(app, r1.runId)).toBe("done");
    const r2 = await app.uiRun({ procedure: "okfast" });
    expect(await waitEnd(app, r2.runId)).toBe("done");
    const raw1 = readFileSync(join(pfdir, "runs", r1.runId, "report.json"), "utf8");
    const raw2 = readFileSync(join(pfdir, "runs", r2.runId, "report.json"), "utf8");
    // runId/at/durationMs(벽시계) 제외하고 비교 (2회 실행이 같은 기록을 남기는지).
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
    const rep = JSON.parse(raw1) as {
      results: { nodeId: string; status: string }[];
    };
    expect(rep.results.find((x) => x.nodeId === "1")?.status).toBe("pass");
    console.log(`M13-1-③ run1=${r1.runId} run2=${r2.runId} identical=${norm(raw1) === norm(raw2)}`);
  }, 120000);

  it("④ 교훈 집계의 실패 수가 0 (취소 run)", async () => {
    const root = makeTmp("pf-m13-cancel-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    mkProc(pfdir, root, "slow", SLOW);
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const r = await app.uiRun({ procedure: "slow" });
    await app.uiRunCancel({ runId: r.runId });
    expect(await waitEnd(app, r.runId)).toBe("cancelled");
    const agg = aggregate(pfdir, "slow");
    expect(agg.runs).toBeGreaterThanOrEqual(1);
    for (const n of agg.nodes) expect(n.fails).toBe(0);
    // events 원문에도 취소 run_end가 있고, cancelled 노드가 fail로 세어지지 않는다.
    const lines = readEventsText(pfdir, "slow").split("\n").filter((l) => l.length > 0);
    const ends = lines.map((l) => JSON.parse(l) as { kind?: string; status?: string });
    expect(ends.some((e) => e.kind === "run_end" && e.status === "cancelled")).toBe(true);
    console.log(`M13-1-④ run=${r.runId} runs=${agg.runs} fails=${agg.nodes.map((n) => n.fails).join(",")}`);
  }, 120000);
});
