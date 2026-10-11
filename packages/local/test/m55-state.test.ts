import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.5-3 실행 간 state E2E.
// feed.json(workspace 실파일, read_json 절대경로) → 1.2 script가 since 이후만 처리.
// state.json에 lastId 저장. 2회째는 신규만, 실패 run은 state 불변.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const CAT = [
  { server: "fake-ppt", name: "read_json", inputSchema: {}, schemaHash: "h" },
  { server: "host", name: "script", inputSchema: {}, schemaHash: "s" },
] as never;
const PY_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

const FILTER_PY = `import json,sys,os
a=json.load(sys.stdin)
items=a["items"]; since=a.get("since") or ""
ids=[r["id"] for r in items]
start=ids.index(since)+1 if since in ids else 0
new=items[start:]
last=new[-1]["id"] if new else since
os.makedirs(os.path.dirname(a["output"]),exist_ok=True)
open(a["output"],"w").write("id\\n"+"\\n".join(r["id"] for r in new)+("\\n" if new else ""))
print(json.dumps({"summary":"new %d last %s"%(len(new),last),"json":{"items":new,"last":last}}))`;

function feedAbs(): string {
  return join(root, "feed.json").replace(/\\/g, "/");
}

function writeFeed(ids: string[]): void {
  writeFileSync(join(root, "feed.json"), JSON.stringify({ items: ids.map((id) => ({ id })) }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m553-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m553home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
  writeFeed(["a", "b"]);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "filter.py"), FILTER_PY);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

function runFilter(items: unknown, since: string): { items: unknown[]; last: string } {
  mkdirSync(join(root, "output"), { recursive: true });
  const raw = execFileSync("python", [join(root, "scripts", "filter.py")], {
    input: JSON.stringify({ items, since, output: join(root, "output", "seen.csv") }),
    encoding: "utf-8", env: PY_ENV,
  });
  return (JSON.parse(raw) as { json: { items: unknown[]; last: string } }).json;
}

async function buildState(): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const feed = feedAbs();
  const started = await client.pfStart({
    request: "누적", params: { feed }, toolCatalog: CAT,
  });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [
      { goal: "목록 읽기" },
      { goal: "신규만 처리", dependsOn: ["1.1"], sideEffect: "local_write" },
    ],
  });
  const data = JSON.parse(readFileSync(join(root, "feed.json"), "utf-8"));
  const a1 = randomUUID();
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "read_json" },
    args: { path: feed }, resultSummary: "2 items", resultJson: data,
    artifacts: [], artifactContents: {},
    selfVerdict: "pass", selfReason: "ok", attemptId: a1,
  });
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "read_json" },
    argSpecs: { path: { kind: "var", ref: "${params.feed}", path: "in" } } as never,
  });
  const agg = runFilter(data.items, "");
  const a2 = randomUUID();
  const ing2 = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId: "1.2", attemptId: a2, baseDir: root, paths: ["output/seen.csv"] });
  await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: { items: data.items, since: "", output: "output/seen.csv" },
    resultSummary: `new 2 last b`, resultJson: agg,
    artifacts: ing2.stored, artifactContents: ing2.contents,
    selfVerdict: "pass", selfReason: "ok", attemptId: a2,
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    // M5.6-g: 누적 노드 human 출력 단언 (strict finalize 필수).
    addConstraints: [{ id: "c-last", kind: "json_path_exists", spec: { path: "last" }, source: "human" }],
    stateWrites: [{ key: "lastId", from: "$1.2.last" }],
  });
  const r2 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: { items: data.items, since: "", output: "output/seen.csv" },
    resultSummary: `new 2 last b`, resultJson: agg,
    artifacts: ing2.stored, artifactContents: ing2.contents,
    selfVerdict: "pass", selfReason: "ok", attemptId: randomUUID(),
  });
  expect(r2.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "host", name: "script" },
    argSpecs: {
      items: { kind: "var", ref: "$1.1.items" },
      since: { kind: "var", ref: "${state.lastId}" },
      output: { kind: "fixed", value: "output/seen.csv", path: "out" },
      filter: { kind: "script", file: "scripts/filter.py" },
    } as never,
  });
  const fin = await app.finalize({ sessionId: sid, name: "m55-state", strict: true });
  expect(fin.warnings).toEqual([]);
}

function stateFile(): string {
  return join(pfdir, "procedures", "m55-state", "state.json");
}

function runOpts(extraParams: Record<string, string> = {}) {
  return {
    procforgeDir: pfdir, projectRoot: root, mode: "live" as const,
    params: { feed: feedAbs(), ...extraParams }, allowProjectRead: true,
  };
}

describe("M5.5-3 실행 간 state", () => {
  it("1회차 전체 + 2회차 신규만", async () => {
    await buildState();
    const r1 = await runProcedureTest(pfdir, root, "m55-state", runOpts({ stateDefaults: '{"lastId":""}' }));
    expect(r1.report.summary.fail).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(), "utf-8"))).toEqual({ lastId: "b" });
    const csv1 = readFileSync(join(pfdir, "runs", r1.report.runId, "fs", "output", "seen.csv"), "utf8").split(/\r?\n/);
    expect(csv1).toEqual(["id", "a", "b", ""]);
    writeFeed(["a", "b", "c"]);
    const r2 = await runProcedureTest(pfdir, root, "m55-state", runOpts());
    expect(r2.report.summary.fail).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(), "utf-8"))).toEqual({ lastId: "c" });
    const csv2 = readFileSync(join(pfdir, "runs", r2.report.runId, "fs", "output", "seen.csv"), "utf8").split(/\r?\n/);
    expect(csv2).toEqual(["id", "c", ""]);
  }, 180000);

  it("state 없이 defaults 없이 → bad_request, 실패 run은 state 불변", async () => {
    await buildState();
    await expect(runProcedureTest(pfdir, root, "m55-state", {
      procforgeDir: pfdir, projectRoot: root, mode: "live",
      params: { feed: feedAbs() }, allowProjectRead: true,
    })).rejects.toThrow(/state 없음/);
    // 실패 run 후에도 state 파일 없음
    const { existsSync } = await import("node:fs");
    expect(existsSync(stateFile())).toBe(false);
    const r1 = await runProcedureTest(pfdir, root, "m55-state", runOpts({ stateDefaults: '{"lastId":""}' }));
    expect(r1.report.summary.fail).toBe(0);
    const before = readFileSync(stateFile(), "utf-8");
    expect(JSON.parse(before)).toEqual({ lastId: "b" });
    // 존재하지 않는 feed → run 실패(fail 리포트), state 불변
    const bad = await runProcedureTest(pfdir, root, "m55-state", {
      procforgeDir: pfdir, projectRoot: root, mode: "live",
      params: { feed: join(root, "nope.json").replace(/\\/g, "/"), stateDefaults: '{"lastId":""}' },
      allowProjectRead: true,
    });
    expect(bad.report.summary.fail).toBeGreaterThanOrEqual(1);
    expect(readFileSync(stateFile(), "utf-8")).toBe(before);
  }, 180000);
});
