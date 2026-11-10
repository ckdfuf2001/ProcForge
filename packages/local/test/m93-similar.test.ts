import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M9-3-4: 유사분석 연동 (testStack 사용 → inprocess/loopback/remote 3모드).
// ① lessons와 stats가 포함됨.
// ② 둘 다 없으면 빈 값이고 순위가 같음 (순위 계산 불변).
// (③ 재분석 프롬프트 포함 여부는 이번에 넣지 않고 보고서로만 둔다.)

let root: string;
let pfdir: string;

function writeProc(name: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: [],
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id: "1", parentId: null, goal: "밤 집계", depth: 0, children: [] }],
  }));
}

function writeEvents(name: string, lines: string[]) {
  mkdirSync(join(pfdir, "runs", "by-procedure", name), { recursive: true });
  writeFileSync(join(pfdir, "runs", "by-procedure", name, "events.ndjson"), lines.join("\n") + "\n", "utf8");
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

beforeEach(() => {
  root = makeTmp("pf-m93sm-");
  pfdir = join(root, ".procforge");
});

describe("M9-3-4 유사분석 연동", () => {
  it("① lessons와 stats가 포함됨", async () => {
    writeProc("sma");
    writeFileSync(join(pfdir, "procedures", "sma", "lessons.md"), "# 교훈\n- 밤 집계를 먼저 한다.\n- 재시도는 한 번만.\n", "utf8");
    writeEvents("sma", [
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "run_end", procedure: "sma", runId: "r1", status: "failed", mode: "live", nodes: [{ nodeId: "1", status: "fail", durationMs: 50 }, { nodeId: "2", status: "fail", durationMs: 60 }] }),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "run_end", procedure: "sma", runId: "r2", status: "done", mode: "live", nodes: [{ nodeId: "1", status: "pass", durationMs: 100 }] }),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "run_end", procedure: "sma", runId: "r3", status: "done", mode: "replay", nodes: [{ nodeId: "9", status: "fail", durationMs: 1 }] }),
      JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "approve", procedure: "sma", nodeId: "1", hash12: "aaaaaaaaaaaa" }),
    ]);
    const app = newApp();
    const r = await app.similarProcedures({ query: "" });
    const found = r.procedures.find((p) => p.name === "sma")!;
    expect(found).toBeDefined();
    expect(found.lessons).toEqual([
      { text: "밤 집계를 먼저 한다.", truncated: false },
      { text: "재시도는 한 번만.", truncated: false },
    ]);
    // replay run은 집계에서 제외된다 (runs=2, 노드 9 없음).
    expect(found.stats.runs).toBe(2);
    expect(found.stats.topFails).toEqual([
      { nodeId: "1", fails: 1 },
      { nodeId: "2", fails: 1 },
    ]);
  });

  it("② 둘 다 없으면 빈 값이고 순위가 같음", async () => {
    writeProc("smb");
    writeProc("sma");
    const app = newApp();
    const r = await app.similarProcedures({ query: "" });
    expect(r.procedures.map((p) => p.name)).toEqual(["sma", "smb"]);
    for (const p of r.procedures) {
      expect(p.lessons).toEqual([]);
      expect(p.stats).toEqual({ runs: 0, topFails: [] });
    }
  });
});
