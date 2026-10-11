import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { isApproved, loadApprovals, matchApproval } from "../src/services/approvals.js";
import { runExitCode, cliErrorExit } from "../src/app/run-exit.js";
import { testStack } from "./client-mode.js";

// M5.5-4 무인 실행 + approvals.json + 종료 코드 E2E (fake echo, external 노드).

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m554-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m554home-"));
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

async function buildUnatt(): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "echo", params: {}, toolCatalog: ECHO_CAT });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [{ goal: "외부 에코" }],
  });
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
    args: { note: "hi" }, resultSummary: "echo hi", resultJson: { note: "hi" },
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.1",
    addConstraints: [{ id: "c-note", kind: "equals", spec: { path: "note", expected: "hi" }, source: "human" }],
  });
  const rr = await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
    args: { note: "hi" }, resultSummary: "echo hi", resultJson: { note: "hi" },
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(rr.verdict).toBe("pass");
  const c = await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    sideEffect: "external",
  });
  expect((c.node as { status?: string }).status).toBe("leaf");
  expect((c.node as { sideEffect?: string }).sideEffect).toBe("external");
  const fin = await app.finalize({ sessionId: sid, name: "m55-unatt" });
  expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
}

function writeApprovals(entries: unknown): void {
  writeFileSync(join(pfdir, "procedures", "m55-unatt", "approvals.json"), JSON.stringify(entries));
}

describe("M5.5-4 approvals 매칭", () => {
  it("일치·와일드카드·불일치", () => {
    const e = { tool: { server: "s", name: "t" }, args: { a: "x", b: "*" } };
    expect(matchApproval(e, "s", "t", { a: "x", b: "anything" })).toBe(true);
    expect(matchApproval(e, "s", "t", { a: "x", b: "z" })).toBe(true);
    expect(matchApproval(e, "s", "t", { a: "y", b: "z" })).toBe(false);
    expect(matchApproval(e, "s", "other", { a: "x", b: "z" })).toBe(false);
    expect(matchApproval(e, "s", "t", { a: "x" })).toBe(false);
    // M5.5-4.1-2: 추가 키 → 거부 (키 집합 정확히 일치).
    expect(matchApproval(e, "s", "t", { a: "x", b: "z", c: 1 })).toBe(false);
    expect(matchApproval(
      { tool: { server: "s", name: "t" }, args: { o: { x: 1 } } },
      "s", "t", { o: { x: 1, y: 2 } },
    )).toBe(false);
    expect(matchApproval({ tool: { server: "s", name: "t" } }, "s", "t", { whatever: 1 })).toBe(true);
    expect(isApproved([e], "s", "t", { a: "x", b: 1 })).toBe(true);
    expect(isApproved([], "s", "t", { a: "x", b: 1 })).toBe(false);
  });

  it("loadApprovals: 없음→빈 목록", () => {
    expect(loadApprovals(join(root, "nope"))).toEqual([]);
  });
});

describe("M5.5-4 종료 코드", () => {
  it("0 성공 / 1 실패·중단 / 3 승인 / 2 입력 오류", () => {
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false })).toBe(0);
    expect(runExitCode({ failed: 1, suspended: 0, approvalBlocked: false })).toBe(1);
    expect(runExitCode({ failed: 0, suspended: 1, approvalBlocked: false })).toBe(1);
    expect(runExitCode({ failed: 1, suspended: 0, approvalBlocked: true })).toBe(3);
    // M5.5-4.1-1: scheduling.md 표와 일치 (입력 오류 4종 → 2, 그 외 → 1).
    for (const code of ["bad_request", "bad_args", "not_found", "session_not_found"]) {
      expect(cliErrorExit(Object.assign(new Error("x"), { code }))).toBe(2);
    }
    for (const code of ["conflict", "internal", "unimplemented"]) {
      expect(cliErrorExit(Object.assign(new Error("x"), { code }))).toBe(1);
    }
    expect(cliErrorExit(new Error("x"))).toBe(1);
  });
});

describe("M5.5-4 무인 실행 E2E", () => {
  it("승인 일치 → 실행·통과", async () => {
    await buildUnatt();
    writeApprovals([{ tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" } }]);
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
  }, 120000);

  it("승인 없음 → fail [approval]", async () => {
    await buildUnatt();
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(1);
    const n = report.results.find((r) => r.nodeId === "1.1")!;
    expect(n.status).toBe("fail");
    expect(n.failedConstraints).toContain("approval");
  }, 120000);

  it("인자 불일치 → fail [approval]", async () => {
    await buildUnatt();
    writeApprovals([{ tool: { server: "fake-ppt", name: "echo" }, args: { note: "other" } }]);
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(1);
    expect(report.results.find((r) => r.nodeId === "1.1")?.failedConstraints).toContain("approval");
    rmSync(join(pfdir, "procedures", "m55-unatt", "approvals.json"));
  }, 120000);

  it("일반 live(대화형) → suspended 유지", async () => {
    await buildUnatt();
    writeApprovals([{ tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" } }]);
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.suspended).toBe(1);
    expect(report.results.find((r) => r.nodeId === "1.1")?.detail).toBe("need_approval");
  }, 120000);
});
