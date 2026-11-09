import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { loadApprovals, gateArgsFor } from "../src/services/approvals.js";
import { resolveArgs } from "../src/runner/resolve.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-entry-fix 결함 2: 승인 게이트 통과 판정.
// (a) 승인된 script는 무인 실행이 통과한다.
// (b) goal을 바꾸면 stale로 fail["approval"]이 난다.
// M10-gate-unify: CLI 무인 실행과 가이드 단계의 판정 일치.
// (c) 승인됨 (d) stale (e) 승인 없음 — 양쪽 판정이 같다.
// (f) gateArgsFor 키 집합 == commitApproval 저장 키 집합.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

function writeProc(name: string, goal: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name,
      sourceSession: "s",
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [
        {
          id: "1", parentId: null, goal, depth: 0, children: [],
          tool: { server: "t", name: "echo", schemaHash: "h" },
          args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
          sideEffect: "external", dependsOn: [], constraints: [],
        },
      ],
    }),
  );
}

function changeGoal(name: string, goal: string) {
  const dir = join(pfdir, "procedures", name);
  const raw = JSON.parse(readFileSync(join(dir, "procedure.json"), "utf8")) as {
    nodes: { id: string; goal?: string }[];
  };
  const n = raw.nodes.find((x) => x.id === "1");
  if (!n) throw new Error("node 없음");
  n.goal = goal;
  writeFileSync(join(dir, "procedure.json"), JSON.stringify(raw));
}

async function guideStep(name: string) {
  const g = await app.startGuide({ steps: [{ procedure: name, params: {} }] });
  return app.advanceGuide({ guideId: g.guideId });
}

beforeEach(() => {
  root = makeTmp("pf-m10gate-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

describe("M10-entry gate", () => {
  it("(a) 승인된 script는 무인 실행이 통과", async () => {
    writeProc("g-ok", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-ok", nodeId: "1", allowWildcard: [] });
    const r = await app.runProcedure({ procedure: "g-ok", params: {}, unattended: true });
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(1);
  }, 120000);

  it("(b) goal 변경 후 무인 실행은 stale로 fail", async () => {
    writeProc("g-st", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-st", nodeId: "1", allowWildcard: [] });
    changeGoal("g-st", "밤 집계 v2");
    const r = await app.runProcedure({ procedure: "g-st", params: {}, unattended: true });
    expect(r.failed).toBe(1);
    expect(JSON.stringify(r)).toContain("approval");
  }, 120000);

  it("(c) 일치: 승인됨 — CLI ok + 가이드 done", async () => {
    writeProc("g-p-ok", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-p-ok", nodeId: "1", allowWildcard: [] });
    const r = await app.runProcedure({ procedure: "g-p-ok", params: {}, unattended: true });
    expect(r.failed).toBe(0);
    const g = await guideStep("g-p-ok");
    expect(g.status).toBe("done");
  }, 180000);

  it("(d) 일치: stale — CLI fail + 가이드 failed(갱신 필요)", async () => {
    writeProc("g-p-st", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-p-st", nodeId: "1", allowWildcard: [] });
    changeGoal("g-p-st", "밤 집계 v2");
    const r = await app.runProcedure({ procedure: "g-p-st", params: {}, unattended: true });
    expect(r.failed).toBe(1);
    expect(r.approvalBlocked).toBe(true);
    const g = await guideStep("g-p-st");
    expect(g.status).toBe("failed");
    const info = await app.uiRunInfo({ runId: g.runId });
    expect(info.failedDetail ?? "").toContain("갱신");
  }, 180000);

  it("(e) 일치: 승인 없음 — CLI fail + 가이드 failed(미승인)", async () => {
    writeProc("g-p-no", "밤 집계");
    const r = await app.runProcedure({ procedure: "g-p-no", params: {}, unattended: true });
    expect(r.failed).toBe(1);
    expect(r.approvalBlocked).toBe(true);
    const g = await guideStep("g-p-no");
    expect(g.status).toBe("failed");
    const info = await app.uiRunInfo({ runId: g.runId });
    expect(info.failedDetail ?? "").toContain("미승인");
  }, 180000);

  it("(f) gateArgsFor 키 집합 == 저장 entry 키 집합", async () => {
    writeProc("g-keys", "밤 집계");
    const dir = join(pfdir, "procedures", "g-keys");
    await app.approveProcedureNode({ procedure: "g-keys", nodeId: "1", allowWildcard: [] });
    const doc = JSON.parse(readFileSync(join(dir, "procedure.json"), "utf8")) as {
      nodes: { id: string; args?: Record<string, unknown> }[];
    };
    const node = doc.nodes.find((x) => x.id === "1");
    if (!node) throw new Error("node 없음");
    const entries = loadApprovals(dir);
    expect(entries.length).toBe(1);
    // 가이드 경로: 실제 resolveArgs 출력을 gateArgsFor에 넘긴다 (하드코딩 금지).
    const resolved = resolveArgs({
      specs: (node.args ?? {}) as never,
      params: {},
      outputs: new Map(),
      attempts: [],
      live: true,
    });
    const guideSide = gateArgsFor(node, resolved);
    // runner 경로: script-kind가 도구 인자 파이프라인에서 제외되므로 비어 있다.
    const runnerSide = gateArgsFor(node, {});
    const entryKeys = Object.keys(entries[0].args ?? {}).sort();
    expect(Object.keys(guideSide).sort()).toEqual(entryKeys);
    expect(Object.keys(runnerSide).sort()).toEqual(entryKeys);
    expect(guideSide).toEqual(runnerSide);
    expect(guideSide).toEqual({ script: { file: "scripts/job.py" } });
  }, 60000);
});
