import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-drive-alive: drive 하트비트(`.drive.lock`) 교차 검증 (2 App, 동일 폴더).
// ① A drive 중 B prepareRun은 conflict, A 종료 후에는 통과.
// ② 죽은 pid의 fresh 하트비트는 회수되고 prepareRun이 통과한다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;

function writeProc(name: string, sleepSec: number) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "job.py"),
    `import time, json\ntime.sleep(${sleepSec})\nprint(json.dumps({"ok": True}))\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure", version: 1, name, sourceSession: "s",
      createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [{ id: "1", parentId: null, goal: "g", depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
    }),
  );
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

beforeEach(() => {
  root = makeTmp("pf-m11da-");
  pfdir = join(root, ".procforge");
});

describe("M11 drive alive (2 App, 동일 폴더)", () => {
  it("① drive 중 타 프로세스 prepareRun은 conflict, 종료 후 통과", async () => {
    writeProc("da", 4);
    const a = newApp();
    await a.approveProcedureNode({ procedure: "da", nodeId: "1", allowWildcard: [] });
    const started = await a.uiRun({ procedure: "da", params: {} });
    const b = newApp();
    type PR = { started: { runId: string } };
    let sawConflict = false;
    for (let i = 0; i < 30; i++) {
      try {
        await (b as unknown as { prepareRun(a: unknown, b: unknown, c: unknown): Promise<PR> })
          .prepareRun("da", {}, { procedure: "da", params: {} });
      } catch (e) {
        if ((e as { code?: string }).code === "conflict") {
          sawConflict = true;
          break;
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawConflict).toBe(true);
    // A 종료까지 대기.
    let last = "";
    for (let i = 0; i < 60; i++) {
      const info = await a.uiRunInfo({ runId: started.runId });
      last = info.status;
      if (last === "done" || last === "failed" || last === "cancelled") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(last).toBe("done");
    // 하트비트 파일이 정리됐고 B가 통과한다.
    expect(existsSync(join(pfdir, "procedures", ".locks", "da.drive.lock"))).toBe(false);
    const r = await (b as unknown as { prepareRun(a: unknown, b: unknown, c: unknown): Promise<PR> })
      .prepareRun("da", {}, { procedure: "da", params: {} });
    expect(typeof r.started.runId).toBe("string");
  }, 120000);

  it("② 죽은 pid의 fresh 하트비트는 회수되고 prepareRun이 통과한다", async () => {
    writeProc("da2", 0);
    const dir = join(pfdir, "procedures", ".locks");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "da2.drive.lock");
    writeFileSync(p, JSON.stringify({ pid: 2147483647, token: "dead", at: new Date().toISOString() }));
    expect(Date.now() - statSync(p).mtimeMs < 60000).toBe(true);
    const b = newApp();
    type PR = { started: { runId: string } };
    const r = await (b as unknown as { prepareRun(a: unknown, b: unknown, c: unknown): Promise<PR> })
      .prepareRun("da2", {}, { procedure: "da2", params: {} });
    expect(typeof r.started.runId).toBe("string");
    expect(existsSync(p)).toBe(false);
  }, 60000);
});
