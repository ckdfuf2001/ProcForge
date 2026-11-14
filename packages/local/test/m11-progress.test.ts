import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { listProcedureProgress } from "../src/services/procedure-progress.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-1: 절차서별 실행 결과 기반 진행률 (읽기 전용 집계).
// testStack 사용 → inprocess/loopback/remote 3모드에서 동일 검증.
// m11p-1 절차서 2개 합산 (일부 fail live run + run 0회).
// m11p-2 replay run만 있으면 "실행 기록 없음" (live만 집계).
// m11p-3 승인 무효 노드가 needsReapproval에 포함되고 미완료로 집계.
// m11p-4 호출 전후 procedure.json/approvals.json/runs 바이트와 파일 수 그대로.
// m11p-5 HTTP GET 200, 응답 이름순.
// m11p-6 map 자식 leaf 승인 후 needsReapproval 빈값.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let emptyDir: string;

function writeProc(name: string, leaves: { id: string; goal: string; fail?: boolean }[]) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: leaves.map((l) => ({
      id: l.id, parentId: null, goal: l.goal, depth: 0, children: [],
      tool: { server: "t", name: "echo", schemaHash: "h" },
      args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
      sideEffect: "external", dependsOn: [],
      constraints: l.fail
        ? [{ id: `c-${l.id}`, source: "human", kind: "file_exists", spec: { path: "m11p-missing.txt" } }]
        : [],
    })),
  }));
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

async function waitDone(app: ProcForgeApp, runId: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 120; i++) {
    const info = await app.uiRunInfo({ runId });
    last = info.status;
    if (last === "done" || last === "failed" || last === "cancelled") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

async function waitReport(runId: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (existsSync(join(pfdir, "runs", runId, "report.json"))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`report.json 없음: ${runId}`);
}

function snapshotTree(base: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else {
        try {
          out.set(r, statSync(p).size);
        } catch {
          // 사라진 파일 무시
        }
      }
    }
  };
  if (existsSync(base)) walk(base, "");
  return out;
}

beforeEach(() => {
  root = makeTmp("pf-m11p-");
  pfdir = join(root, ".procforge");
  emptyDir = makeTmp("pf-m11pe-");
});

describe("M11-1 절차서별 진행률", () => {
  it("m11p-1 절차서 2개 합산 (일부 fail + run 0회)", async () => {
    writeProc("m11pa", [
      { id: "1", goal: "첫째" },
      { id: "2", goal: "둘째", fail: true },
    ]);
    writeProc("m11pb", [{ id: "1", goal: "외톨이" }]);
    const app = newApp();
    await app.approveProcedureNode({ procedure: "m11pa", nodeId: "1", allowWildcard: [] });
    await app.approveProcedureNode({ procedure: "m11pa", nodeId: "2", allowWildcard: [] });
    const started = await app.uiRun({ procedure: "m11pa", params: {} });
    expect(await waitDone(app, started.runId)).toBe("failed");
    await waitReport(started.runId);
    const rows = await app.listProcedureProgress();
    expect(rows.map((r) => r.name)).toEqual(["m11pa", "m11pb"]);
    const a = rows.find((r) => r.name === "m11pa");
    const b = rows.find((r) => r.name === "m11pb");
    expect(a).toMatchObject({ leaves: 2, done: 1, remaining: ["2"], needsReapproval: [], progress: 0.5, runId: started.runId });
    expect(b).toMatchObject({ leaves: 1, done: 0, remaining: ["1"], progress: null, runId: null });
  }, 120000);

  it("m11p-2 replay run만 있으면 실행 기록 없음", async () => {
    writeProc("m11pc", [{ id: "1", goal: "재생" }]);
    const { report } = await runProcedureTest(pfdir, root, "m11pc", {});
    expect(report.mode).toBe("replay");
    const rows = listProcedureProgress(pfdir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "m11pc", leaves: 1, done: 0, progress: null, runId: null });
    expect(rows[0].remaining).toEqual(["1"]);
  }, 120000);

  it("m11p-3 승인 무효 노드가 needsReapproval + 미완료로 집계", async () => {
    writeProc("m11pd", [
      { id: "1", goal: "가만히" },
      { id: "2", goal: "바뀔 것" },
    ]);
    const app = newApp();
    await app.approveProcedureNode({ procedure: "m11pd", nodeId: "1", allowWildcard: [] });
    await app.approveProcedureNode({ procedure: "m11pd", nodeId: "2", allowWildcard: [] });
    const started = await app.uiRun({ procedure: "m11pd", params: {} });
    expect(await waitDone(app, started.runId)).toBe("done");
    await waitReport(started.runId);
    const before = (await app.listProcedureProgress()).find((r) => r.name === "m11pd");
    expect(before).toMatchObject({ done: 2, progress: 1, needsReapproval: [] });
    const procFile = join(pfdir, "procedures", "m11pd", "procedure.json");
    const doc = JSON.parse(readFileSync(procFile, "utf8")) as string;
    const target = (doc as { nodes: { id: string; goal: string }[] }).nodes.find((n) => n.id === "2");
    if (!target) throw new Error("leaf 2 없음");
    target.goal = "바뀐 목표";
    writeFileSync(procFile, JSON.stringify(doc), "utf8");
    const after = (await app.listProcedureProgress()).find((r) => r.name === "m11pd");
    expect(after).toMatchObject({ leaves: 2, done: 1, progress: 0.5, runId: started.runId });
    expect(after?.needsReapproval).toEqual(["2"]);
    expect(after?.remaining).toEqual(["2"]);
  }, 120000);

  it("m11p-4 호출 전후 바이트와 파일 수 그대로", async () => {
    writeProc("m11pe", [{ id: "1", goal: "그대로" }]);
    const app = newApp();
    await app.approveProcedureNode({ procedure: "m11pe", nodeId: "1", allowWildcard: [] });
    const started = await app.uiRun({ procedure: "m11pe", params: {} });
    expect(await waitDone(app, started.runId)).toBe("done");
    await waitReport(started.runId);
    const snap = snapshotTree(pfdir);
    await app.listProcedureProgress();
    listProcedureProgress(pfdir);
    const snap2 = snapshotTree(pfdir);
    expect(snap2.size).toBe(snap.size);
    expect([...snap2.entries()]).toEqual([...snap.entries()]);
  }, 120000);

  it("m11p-5 HTTP GET 200, 응답 이름순", async () => {
    writeProc("m11pz", [{ id: "1", goal: "나중" }]);
    writeProc("m11pa", [{ id: "1", goal: "먼저" }]);
    const srv = await createUiServer({ app: newApp(), staticDir: emptyDir });
    try {
      const res = await fetch(`${srv.url}/api/procedures/progress`, {
        headers: { "x-procforge-token": srv.token },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string }[];
      expect(body.map((r) => r.name)).toEqual(["m11pa", "m11pz"]);
    } finally {
      await srv.close();
    }
  }, 120000);
  it("m11p-6 map 자식 leaf 승인 후 needsReapproval 빈값", async () => {
    const dir = join(pfdir, "procedures", "m11pm");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
    writeFileSync(join(dir, "procedure.json"), JSON.stringify({
      format: "procforge-procedure", version: 1, name: "m11pm", sourceSession: "s",
      createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [
        { id: "1", parentId: null, goal: "묶음", depth: 0, children: ["1.1", "1.2"], kind: "map", map: {}, sideEffect: "none", dependsOn: [], constraints: [] },
        { id: "1.1", parentId: "1", goal: "첫째", depth: 1, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] },
        { id: "1.2", parentId: "1", goal: "둘째", depth: 1, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] },
      ],
    }));
    const app = newApp();
    await app.approveProcedureNode({ procedure: "m11pm", nodeId: "1.1", allowWildcard: [] });
    await app.approveProcedureNode({ procedure: "m11pm", nodeId: "1.2", allowWildcard: [] });
    const rows = await app.listProcedureProgress();
    const r = rows.find((x) => x.name === "m11pm");
    expect(r?.needsReapproval).toEqual([]);
    expect(r?.remaining).toEqual(["1.1", "1.2"]);
    expect(r?.progress).toBeNull();
  }, 120000);
});