import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp, driveLoopTuning } from "../src/app/app.js";
import { readGuide, writeGuide } from "../src/services/guide.js";
import { readRunState, writeRunState } from "../src/services/run-state.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-guide-zombie: 드라이버 없는 running/ready는 failed로 확정한다.
// ① 재시작 뒤 advance는 failed, 재시도하면 새 runId로 done.
// ② 상한 주입 시 run이 failed("drive 상한 초과")가 된다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

function writeProc(pfdir: string, root: string, name: string, goal: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure", version: 1, name, sourceSession: "s",
      createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [{ id: "1", parentId: null, goal, depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
    }),
  );
}

let root: string;
let pfdir: string;
let oldMax: number;

beforeEach(() => {
  root = makeTmp("pf-m11gz-");
  pfdir = join(root, ".procforge");
  oldMax = driveLoopTuning.maxIterations;
});

afterEach(() => {
  driveLoopTuning.maxIterations = oldMax;
});

describe("M11 guide zombie", () => {
  it("① 드라이버 없는 running은 advance에서 failed, 재시도는 새 runId로 done", async () => {
    writeProc(pfdir, root, "gz", "밤 집계");
    const { client } = testStack(pfdir);
    const app1 = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    await app1.approveProcedureNode({ procedure: "gz", nodeId: "1", allowWildcard: [] });
    const g = await app1.startGuide({ steps: [{ procedure: "gz", params: {} }] });
    type PR = { started: { runId: string; sessionId: string; procedure: string; params: Record<string, string> }; docName: string };
    const { started } = await (app1 as unknown as { prepareRun(a: unknown, b: unknown, c: unknown): Promise<PR> }).prepareRun("gz", {}, { procedure: "gz", params: {} });
    // crash 시뮬레이션: launchDrive 이후 guide만 running으로 남기고 App을 버린다.
    const guide = readGuide(pfdir, g.guideId);
    guide.state[0] = { status: "running", runId: started.runId, sessionId: started.sessionId, updatedAt: new Date().toISOString() };
    writeGuide(pfdir, guide);
    const { client: client2 } = testStack(pfdir);
    const app2 = new ProcForgeApp({ core: client2, procforgeDir: pfdir, projectRoot: root });
    const r0 = await app2.advanceGuide({ guideId: g.guideId, stepIndex: 0, timeoutMs: 5000 });
    expect(r0.status).toBe("failed");
    const st0 = readRunState(pfdir, started.runId);
    expect(st0?.status).toBe("failed");
    expect(st0?.failedDetail ?? "").toContain("재시작");
    const r1 = await app2.advanceGuide({ guideId: g.guideId, timeoutMs: 120000 });
    expect(r1.status).toBe("done");
    expect(r1.runId).not.toBe(started.runId);
  }, 180000);

  it("② 상한 주입 시 run이 failed(drive 상한 초과)가 된다", async () => {
    writeProc(pfdir, root, "gz2", "밤 집계");
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    await app.approveProcedureNode({ procedure: "gz2", nodeId: "1", allowWildcard: [] });
    driveLoopTuning.maxIterations = 0;
    const started = await app.uiRun({ procedure: "gz2", params: {} });
    let last = "";
    for (let i = 0; i < 40; i++) {
      const info = await app.uiRunInfo({ runId: started.runId });
      last = info.status;
      if (last === "done" || last === "failed" || last === "cancelled") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(last).toBe("failed");
    const info = await app.uiRunInfo({ runId: started.runId });
    expect(info.failedDetail ?? "").toContain("drive 상한 초과");
  }, 120000);
});
