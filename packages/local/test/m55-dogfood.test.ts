import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { runExitCode, runErrorExit } from "../src/app/run-exit.js";
import { testStack } from "./client-mode.js";

// M5.5-5 dogfood: 목록(3페이지) → 상세(map·threshold) → 신규만 CSV 누적.
// fake board(day별 목록) + detail(x3 실패). run1(d1): x1,x2 / run2(d2): x4 신규.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const CAT = [
  { server: "fake-ppt", name: "board", inputSchema: {}, schemaHash: "h" },
  { server: "fake-ppt", name: "detail", inputSchema: {}, schemaHash: "h" },
  { server: "host", name: "script", inputSchema: {}, schemaHash: "script" },
] as never;

const FLAT_PY = `import json,sys
pages = json.load(sys.stdin)["pages"]
ids = [it["id"] for p in pages for it in p.get("items", []) if "id" in it]
print(json.dumps({"json": {"ids": ids}}))
`;

const ACC_PY = `import json,os,sys
inp = json.load(sys.stdin)
seen = inp.get("seen") or []
ids = [d["id"] for d in inp.get("details", []) if isinstance(d, dict) and "id" in d]
new = [i for i in ids if i not in seen]
allids = seen + [i for i in new if i not in seen]
os.makedirs(os.path.dirname(inp["output"]) or ".", exist_ok=True)
with open(inp["output"], "w", encoding="utf-8") as f:
    f.write("id\\n" + "".join(i + "\\n" for i in new))
print(json.dumps({"json": {"allIds": allids, "newIds": new}}))
`;

function runPy(script: string, input: unknown, cwd: string): unknown {
  const raw = execFileSync("python", [script], { input: JSON.stringify(input), encoding: "utf-8", cwd });
  return (JSON.parse(raw) as { json: unknown }).json;
}

const P1 = { items: [{ id: "x1" }, { id: "x2" }], nextCursor: "p2" };
const P2 = { items: [{ id: "x3" }], nextCursor: "p3" };
const P3EMPTY = { items: [], nextCursor: null };
const P3X4 = { items: [{ id: "x4" }], nextCursor: null };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m555-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m555home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "flat.py"), FLAT_PY);
  writeFileSync(join(root, "scripts", "acc.py"), ACC_PY);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildDogfood(): Promise<ProcForgeApp> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "daily crawl", params: { day: "d1" }, toolCatalog: CAT });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [
      { goal: "목록 페이지 수집" },
      { goal: "페이지 평탄화", dependsOn: ["1.1"] },
      { goal: "상세 조회", dependsOn: ["1.2"] },
      { goal: "신규 누적", dependsOn: ["1.3"] },
    ],
  });
  // ---- 1.1 until board ----
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "board" },
    args: { day: "d1", cursor: "" }, resultSummary: "board probe", resultJson: [P1],
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.1",
    addConstraints: [{ id: "c-n", kind: "count", spec: { min: 1 }, source: "human" }],
    until: {
      until: { id: "c-done", kind: "equals", spec: { path: "nextCursor", expected: null }, source: "human" },
      maxIterations: 5,
      carry: "$self.nextCursor",
      template: {
        tool: { server: "fake-ppt", name: "board" },
        args: {
          day: { kind: "var", ref: "${params.day}" },
          cursor: { kind: "var", ref: "$self" },
        },
        constraints: [],
      },
    } as never,
  });
  const ru = await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "board" },
    args: { day: "d1", cursor: "" }, resultSummary: "board probe", resultJson: [P1],
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(ru.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "board" },
    argSpecs: {
      day: { kind: "var", ref: "${params.day}" },
      cursor: { kind: "var", ref: "$self" },
    } as never,
  });
  // ---- 1.2 script flatten ----
  const flat = runPy(join(root, "scripts", "flat.py"), { pages: [P1, P2, P3EMPTY] }, root);
  expect(flat).toEqual({ ids: ["x1", "x2", "x3"] });
  const rf = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: { pages: [P1, P2, P3EMPTY] }, resultSummary: "flat 3", resultJson: flat,
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(rf.verdict).toBe("pass");
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    addConstraints: [{ id: "c-ids", kind: "json_path_exists", spec: { path: "ids" }, source: "human" }],
  });
  const rf2 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: { pages: [P1, P2, P3EMPTY] }, resultSummary: "flat 3", resultJson: flat,
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(rf2.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "host", name: "script" },
    argSpecs: {
      pages: { kind: "var", ref: "$1.1" },
      flat: { kind: "script", file: "scripts/flat.py" },
    } as never,
  });
  // ---- 1.3 map detail (external) ----
  const probeDetails = [{ id: "x1", title: "t-x1" }, { id: "x2", title: "t-x2" }];
  await client.pfReport({
    sessionId: sid, nodeId: "1.3", tool: { server: "fake-ppt", name: "detail" },
    args: { id: "x1" }, resultSummary: "detail probe", resultJson: probeDetails,
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.3",
    addConstraints: [{ id: "c-n", kind: "count", spec: { min: 1 }, source: "human" }],
    map: {
      over: "$1.2.ids", as: "item", maxItems: 10, policy: { kind: "threshold", ratio: 0.5 },
      template: {
        tool: { server: "fake-ppt", name: "detail" },
        args: { id: { kind: "var", ref: "${item}" } },
        constraints: [],
      },
    } as never,
  });
  const rm = await client.pfReport({
    sessionId: sid, nodeId: "1.3", tool: { server: "fake-ppt", name: "detail" },
    args: { id: "x1" }, resultSummary: "detail probe", resultJson: probeDetails,
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(rm.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.3", decision: "leaf",
    tool: { server: "fake-ppt", name: "detail" },
    argSpecs: { id: { kind: "var", ref: "${item}" } } as never,
    sideEffect: "external",
  });
  // ---- 1.4 script accumulate ----
  const acc = runPy(
    join(root, "scripts", "acc.py"),
    { details: probeDetails, seen: [], output: "output/seen.csv" }, root,
  );
  expect(acc).toEqual({ allIds: ["x1", "x2"], newIds: ["x1", "x2"] });
  await client.pfReport({
    sessionId: sid, nodeId: "1.4", tool: { server: "host", name: "script" },
    args: { details: probeDetails, seen: [], output: "output/seen.csv" },
    resultSummary: "acc 2", resultJson: acc,
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.4",
    addConstraints: [{ id: "c-new", kind: "json_path_exists", spec: { path: "newIds" }, source: "human" }],
    stateWrites: [{ key: "seenIds", from: "$1.4.allIds" }],
  });
  const ra = await client.pfReport({
    sessionId: sid, nodeId: "1.4", tool: { server: "host", name: "script" },
    args: { details: probeDetails, seen: [], output: "output/seen.csv" },
    resultSummary: "acc 2", resultJson: acc,
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(ra.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.4", decision: "leaf",
    tool: { server: "host", name: "script" },
    argSpecs: {
      details: { kind: "var", ref: "$1.3" },
      seen: { kind: "var", ref: "${state.seenIds}" },
      output: { kind: "fixed", value: "output/seen.csv", path: "out" },
      acc: { kind: "script", file: "scripts/acc.py" },
    } as never,
  });
  const fin = await app.finalize({ sessionId: sid, name: "daily-crawl" });
  expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
  return app;
}

function csvOf(runId: string): string[] {
  return readFileSync(join(pfdir, "runs", runId, "fs", "output", "seen.csv"), "utf8").split(/\r?\n/);
}

function stateOf(): unknown {
  return JSON.parse(readFileSync(join(pfdir, "procedures", "daily-crawl", "state.json"), "utf-8"));
}

function baseOpts(day: string, extraParams: Record<string, string> = {}) {
  return {
    procforgeDir: pfdir, projectRoot: root, mode: "live" as const,
    params: { day, ...extraParams }, unattended: true,
  };
}

describe("M5.5-5 dogfood", () => {
  it("run1 전체 + run2 신규만 (중복 0)", async () => {
    const app = await buildDogfood();
    await app.approveProcedureNode({ procedure: "daily-crawl", nodeId: "1.3" });
    const r1 = await runProcedureTest(pfdir, root, "daily-crawl", baseOpts("d1", { stateDefaults: '{"seenIds":[]}' }));
    expect(r1.report.summary.fail).toBe(0);
    expect(r1.report.results.find((r) => r.nodeId === "1.3")?.failedItems).toEqual([2]);
    expect(csvOf(r1.report.runId)).toEqual(["id", "x1", "x2", ""]);
    expect(stateOf()).toEqual({ seenIds: ["x1", "x2"] });
    const r2 = await runProcedureTest(pfdir, root, "daily-crawl", baseOpts("d2"));
    expect(r2.report.summary.fail).toBe(0);
    expect(csvOf(r2.report.runId)).toEqual(["id", "x4", ""]);
    expect(stateOf()).toEqual({ seenIds: ["x1", "x2", "x4"] });
  }, 180000);

  it("(a) 승인 해시 불일치 → fail [approval] + exit 3", async () => {
    const app = await buildDogfood();
    const ap = await app.approveProcedureNode({ procedure: "daily-crawl", nodeId: "1.3" });
    const { writeFileSync: wfs } = await import("node:fs");
    wfs(
      join(pfdir, "procedures", "daily-crawl", "approvals.json"),
      JSON.stringify([{ node: { id: "1.3", hash: "stale" }, tool: { server: "fake-ppt", name: "detail" }, args: { id: "*" } }]),
    );
    expect(ap.hash).not.toBe("stale");
    const r = await runProcedureTest(pfdir, root, "daily-crawl", baseOpts("d1", { stateDefaults: '{"seenIds":[]}' }));
    expect(r.report.summary.fail).toBeGreaterThanOrEqual(1);
    expect(r.report.results.some((x) => x.failedConstraints.includes("approval"))).toBe(true);
    expect(runExitCode({ failed: r.report.summary.fail, suspended: 0, approvalBlocked: true })).toBe(3);
  }, 180000);

  it("(b) 겹친 실행 → 두 번째 conflict", async () => {
    const app = await buildDogfood();
    await app.approveProcedureNode({ procedure: "daily-crawl", nodeId: "1.3" });
    const o1 = baseOpts("d1", { stateDefaults: '{"seenIds":[]}' });
    const o2 = baseOpts("d1", { stateDefaults: '{"seenIds":[]}' });
    const [a, b] = await Promise.allSettled([
      runProcedureTest(pfdir, root, "daily-crawl", { ...o1 }),
      runProcedureTest(pfdir, root, "daily-crawl", { ...o2 }),
    ]);
    const ng = [a, b].filter((r) => r.status === "rejected");
    expect([a, b].filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(ng.length).toBe(1);
    const err = (ng[0] as PromiseRejectedResult).reason as { code?: string };
    expect(err.code).toBe("conflict");
    expect(runErrorExit(err)).toBe(4);
  }, 180000);
});
