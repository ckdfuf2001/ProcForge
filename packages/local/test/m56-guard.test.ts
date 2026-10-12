import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { runExitCode, resolveAllowUnverified } from "../src/app/run-exit.js";
import { testStack } from "./client-mode.js";

// M5.6-g: 누적(stateWrites) 노드 출력 단언 필수 (없으면 경고, strict면 거부).

const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;
const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m56g-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m56ghome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildAcc(withRubric = false): Promise<{ app: ProcForgeApp; sid: string; editCount: () => Promise<void> }> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "acc", params: {}, toolCatalog: ECHO_CAT });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [{ goal: "원본" }, { goal: "누적", dependsOn: ["1.1"] }],
  });
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
    args: { v: "a" }, resultSummary: "a", resultJson: { v: "a" },
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { v: { kind: "fixed", value: "a" } } as never,
  });
  await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
    args: { v: "a" }, resultSummary: "a", resultJson: { v: "a", all: ["a"] },
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    ...(withRubric
      ? { addConstraints: [{ id: "c-r", kind: "llm_rubric", spec: { rubric: "요약 품질" }, source: "human" }] }
      : {}),
    stateWrites: [{ key: "seen", from: "$1.2.all" }],
  });
  const r = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
    args: { v: "a" }, resultSummary: "a", resultJson: withRubric ? { v: "a", all: [] } : { v: "a", all: ["a"] },
    ...(withRubric ? { rubricReasons: { "c-r": "비어 있음 확인" } } : {}),
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(r.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { v: { kind: "var", ref: "$1.1.v" } } as never,
  });
  return {
    app, sid,
    editCount: () => client.pfEditNode({
      sessionId: sid, nodeId: "1.2",
      addConstraints: [{ id: "c-n", kind: "count", spec: { min: 1 }, source: "human" }],
    }).then(() => undefined),
  };
}

describe("M5.6-g 누적 출력 단언", () => {
  it("없으면 경고, strict면 거부", async () => {
    const { app, sid } = await buildAcc();
    const fin = await app.finalize({ sessionId: sid, name: "m56-acc-warn" });
    expect(fin.warnings.some((w) => w.includes("stateWrites 출력 단언 없음: 1.2"))).toBe(true);
    await expect(app.finalize({ sessionId: sid, name: "m56-acc-strict", strict: true })).rejects.toThrow(/stateWrites 출력 단언 없음/);
  }, 60000);

  it("count 추가하면 경고 없음", async () => {
    const { app, sid, editCount } = await buildAcc();
    await editCount();
    const fin = await app.finalize({ sessionId: sid, name: "m56-acc-ok" });
    expect(fin.warnings.some((w) => w.includes("stateWrites 출력 단언 없음"))).toBe(false);
    const strict = await app.finalize({ sessionId: sid, name: "m56-acc-ok2", strict: true });
    expect(strict.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
  }, 60000);

  it("M5.7-1: llm_rubric만 있으면 경고, strict면 거부 (빈 누적)", async () => {
    const { app, sid } = await buildAcc(true);
    const fin = await app.finalize({ sessionId: sid, name: "m57-acc-rubric" });
    expect(fin.warnings.some((w) => w.includes("stateWrites 출력 단언 없음: 1.2"))).toBe(true);
    await expect(app.finalize({ sessionId: sid, name: "m57-acc-rubric-strict", strict: true })).rejects.toThrow(/stateWrites 출력 단언 없음/);
  }, 60000);
});

describe("M5.7.1 unverified 기본 on·해제 (구 M5.7-2)", () => {
  async function buildRubric(): Promise<{ app: ProcForgeApp; sid: string }> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "rubric", params: {}, toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "판정" }],
    });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "a" }, resultSummary: "a", resultJson: { note: "a" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfEditNode({
      sessionId: sid, nodeId: "1.1",
      addConstraints: [{ id: "c-r", kind: "llm_rubric", spec: { rubric: "품질" }, source: "human" }],
      stateWrites: [{ key: "k", from: "$1.1.note" }],
    });
    const r = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "a" }, resultSummary: "a", resultJson: { note: "a" },
      rubricReasons: { "c-r": "좋음" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "a" } } as never,
    });
    const fin = await app.finalize({ sessionId: sid, name: "m57-fou" });
    expect(fin.warnings.some((w) => w.includes("stateWrites 출력 단언 없음: 1.1"))).toBe(true);
    return { app, sid };
  }

  function statePath(): string {
    return join(pfdir, "procedures", "m57-fou", "state.json");
  }

  it("기본 on: unverified → exit 1 + state 미저장", async () => {
    await buildRubric();
    expect(existsSync(statePath())).toBe(false);
    const { report } = await runProcedureTest(pfdir, root, "m57-fou", {
      procforgeDir: pfdir, projectRoot: root, mode: "live",
      params: { stateDefaults: '{"k":""}' }, unattended: true,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.unverified).toBe(1);
    expect(existsSync(statePath())).toBe(false);
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false, unverified: 1 })).toBe(1);
  }, 120000);

  it("해제 시: exit 0 + state 저장", async () => {
    await buildRubric();
    const { report } = await runProcedureTest(pfdir, root, "m57-fou", {
      procforgeDir: pfdir, projectRoot: root, mode: "live",
      params: { stateDefaults: '{"k":""}' }, unattended: true, allowUnverified: true,
    });
    expect(report.summary.fail).toBe(0);
    expect(JSON.parse(readFileSync(statePath(), "utf-8"))).toEqual({ k: "a" });
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false, unverified: 1, allowUnverified: true })).toBe(0);
  }, 120000);
});

describe("M5.7.1 finalize rubric 경고", () => {
  it("llm_rubric 잔존 시 경고 1건", async () => {
    const { app, sid } = await buildAcc(true);
    const fin = await app.finalize({ sessionId: sid, name: "m571-rubric-warn" });
    expect(fin.warnings.filter((w) => w.includes("llm_rubric 잔존: 1.2"))).toHaveLength(1);
  }, 60000);

  it("strict면 거부", async () => {
    const { app, sid } = await buildAcc(true);
    await expect(app.finalize({ sessionId: sid, name: "m571-rubric-strict", strict: true })).rejects.toThrow(/llm_rubric 잔존: 1\.2/);
  }, 60000);

  it("rubric 없음 → 경고 없음", async () => {
    const { app, sid } = await buildAcc(false);
    const fin = await app.finalize({ sessionId: sid, name: "m571-rubric-clean" });
    expect(fin.warnings.some((w) => w.includes("llm_rubric 잔존"))).toBe(false);
  }, 60000);
});

describe("M5.7.1 unverified 옵션 정리", () => {
  it("기본 → unverified 시 exit 1", () => {
    const r = resolveAllowUnverified({});
    expect(r).toEqual({ allowUnverified: false, deprecatedWarned: false });
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false, unverified: 1, allowUnverified: r.allowUnverified })).toBe(1);
  });

  it("--allow-unverified → exit 0", () => {
    const r = resolveAllowUnverified({ "allow-unverified": true });
    expect(r).toEqual({ allowUnverified: true, deprecatedWarned: false });
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false, unverified: 1, allowUnverified: r.allowUnverified })).toBe(0);
  });

  it("구 옵션 → 경고 + 동작 불변 (기본 on 유지)", () => {
    const r = resolveAllowUnverified({ "fail-on-unverified": true });
    expect(r).toEqual({ allowUnverified: false, deprecatedWarned: true });
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false, unverified: 1, allowUnverified: r.allowUnverified })).toBe(1);
  });
});
