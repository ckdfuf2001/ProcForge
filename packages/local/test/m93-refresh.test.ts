import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { refreshLessons } from "../src/services/lessons-agg.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M9-3-3: 교훈 자동 구획 갱신 (testStack 사용 → inprocess/loopback/remote 3모드).
// ① 구획 밖 바이트 동일 ② 두 번 갱신해도 결과가 같음
// ③ 재finalize 후 보존 ④ HTTP 200.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;
const TOOL = { server: "t", name: "echo" } as never;

const AUTO_OPEN = "<!-- proof:auto -->";
const AUTO_CLOSE = "<!-- /proof:auto -->";

let root: string;
let pfdir: string;

function writeProc(name: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id: "1", parentId: null, goal: "g", depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
  }));
}

function writeEvents(name: string) {
  mkdirSync(join(pfdir, "runs", "by-procedure", name), { recursive: true });
  const lines = [
    JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "run_end", procedure: name, runId: "r1", status: "done", mode: "live", nodes: [{ nodeId: "1", status: "pass", durationMs: 120 }] }),
    JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "approve", procedure: name, nodeId: "1", hash12: "aaaaaaaaaaaa" }),
    JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "approve", procedure: name, nodeId: "1", hash12: "bbbbbbbbbbbb" }),
  ];
  writeFileSync(join(pfdir, "runs", "by-procedure", name, "events.ndjson"), lines.join("\n") + "\n", "utf8");
}

function stripAuto(content: string): string {
  const oi = content.indexOf(AUTO_OPEN);
  const ci = content.indexOf(AUTO_CLOSE);
  if (oi === -1 || ci === -1 || ci <= oi) return content;
  return content.slice(0, oi) + content.slice(ci + AUTO_CLOSE.length);
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

beforeEach(() => {
  root = makeTmp("pf-m93rf-");
  pfdir = join(root, ".procforge");
});

describe("M9-3-3 lessons 자동 구획 갱신", () => {
  it("① 구획 밖 바이트 동일", () => {
    writeProc("rf1");
    writeEvents("rf1");
    const manual = "# 교훈\n- 밤 집계를 먼저 한다.\n- 재시도는 한 번만.\n";
    writeFileSync(join(pfdir, "procedures", "rf1", "lessons.md"), manual, "utf8");
    const r = refreshLessons(pfdir, "rf1");
    expect(r).toEqual({ procedure: "rf1", lines: 1 });
    const after = readFileSync(join(pfdir, "procedures", "rf1", "lessons.md"), "utf8");
    expect(stripAuto(after)).toBe(manual);
    expect(after).toContain(AUTO_OPEN);
    expect(after).toContain("- 1: 실패 0회, 평균 120ms, 재승인 1회");
  });

  it("② 두 번 갱신해도 결과가 같음", () => {
    writeProc("rf2");
    writeEvents("rf2");
    writeFileSync(join(pfdir, "procedures", "rf2", "lessons.md"), "- 수기\n", "utf8");
    refreshLessons(pfdir, "rf2");
    const once = readFileSync(join(pfdir, "procedures", "rf2", "lessons.md"), "utf8");
    refreshLessons(pfdir, "rf2");
    const twice = readFileSync(join(pfdir, "procedures", "rf2", "lessons.md"), "utf8");
    expect(twice).toBe(once);
  });

  it("③ 재finalize 후 보존", async () => {
    const app = newApp();
    writeFileSync(join(root, "beacon.py"), "print('{\"ok\": true}')\n", "utf8");
    const s = await app.start({ request: "보존", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({ sessionId: sid, nodeId: "1", reason: "M9-3-3 테스트용 분해 사유입니다.", children: [{ goal: "x" }] } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL, args: {},
      resultSummary: "ok", resultJson: {}, selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { script: { kind: "script", file: "beacon.py", runtime: "python" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "rf3" });
    const dir = join(pfdir, "procedures", "rf3");
    const manual = "# 교훈\n- 밤 집계를 먼저 한다.\n";
    writeFileSync(join(dir, "lessons.md"), manual, "utf8");
    const r = await app.refreshProcedureLessons({ procedure: "rf3" });
    expect(r.procedure).toBe("rf3");
    const before = readFileSync(join(dir, "lessons.md"), "utf8");
    await app.finalize({ sessionId: sid, name: "rf3", force: true } as never);
    const after = readFileSync(join(dir, "lessons.md"), "utf8");
    expect(after).toBe(before);
    expect(stripAuto(after)).toBe(manual);
  }, 120000);

  it("④ HTTP 200", async () => {
    writeProc("rf4");
    writeEvents("rf4");
    const app = newApp();
    const srv: UiServer = await createUiServer({ app, staticDir: makeTmp("pf-m93rfe-") });
    try {
      const res = await fetch(`${srv.url}/api/procedures/rf4/lessons/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { procedure: string; lines: number };
      expect(body).toEqual({ procedure: "rf4", lines: 1 });
      const missing = await fetch(`${srv.url}/api/procedures/no-such-proc/lessons/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: "{}",
      });
      expect(missing.status).toBe(400);
    } finally {
      await srv.close();
    }
  }, 120000);
});
