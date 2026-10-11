import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { loadApprovals, matchApproval, approvalPins, checkApproval, buildApprovalEntry, migrateV1Value, computeApprovalHash } from "../src/services/approvals.js";
import { runExitCode, cliErrorExit, runErrorExit } from "../src/app/run-exit.js";
import { testStack } from "./client-mode.js";
import { computeNodeHash } from "@procforge/shared/schema.js";
import { FileStore } from "../src/filestore.js";
import { loadProcedureDoc } from "../src/runner/procedure-run.js";
import { importProcedure } from "../src/procedure.js";
import { runSession, startRunHeartbeat } from "../src/runner/run.js";

// M5.5-4 무인 실행 + approvals.json + 종료 코드 E2E (fake echo, external 노드).

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;
const SAVE_CAT = [{ server: "fake-ppt", name: "save", inputSchema: {}, schemaHash: "h" }] as never;

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

async function buildUnatt(): Promise<ProcForgeApp> {
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
  return app;
}

function writeApprovals(entries: unknown): void {
  // M5.5-4.3-1: v2 형식으로 기록.
  writeFileSync(
    join(pfdir, "procedures", "m55-unatt", "approvals.json"),
    JSON.stringify({ version: 2, entries }),
  );
}

describe("M5.5-4 approvals 매칭", () => {
  it("일치·와일드카드·불일치", () => {
    const e = { node: { id: "1.1", hash: "h1" }, tool: { server: "s", name: "t" }, args: { a: "x", b: { $any: true } } };
    expect(matchApproval(e, "s", "t", { a: "x", b: "anything" })).toBe(true);
    expect(matchApproval(e, "s", "t", { a: "x", b: "z" })).toBe(true);
    expect(matchApproval(e, "s", "t", { a: "y", b: "z" })).toBe(false);
    expect(matchApproval(e, "s", "other", { a: "x", b: "z" })).toBe(false);
    expect(matchApproval(e, "s", "t", { a: "x" })).toBe(false);
    // M5.5-4.1-2: 추가 키 → 거부 (키 집합 정확히 일치).
    expect(matchApproval(e, "s", "t", { a: "x", b: "z", c: 1 })).toBe(false);
    expect(matchApproval(
      { node: { id: "1.1", hash: "h1" }, tool: { server: "s", name: "t" }, args: { o: { x: 1 } } },
      "s", "t", { o: { x: 1, y: 2 } },
    )).toBe(false);
    expect(matchApproval({ node: { id: "1.1", hash: "h1" }, tool: { server: "s", name: "t" } }, "s", "t", { whatever: 1 })).toBe(true);
    // M5.5-4.3-4: pin 없는 isApproved 삭제 → checkApproval으로 판정.
    expect(checkApproval([e], approvalPins({ id: "1.1", hash: "h1" }), "s", "t", { a: "x", b: 1 })).toBe("ok");
    expect(checkApproval([], approvalPins({ id: "1.1", hash: "h1" }), "s", "t", { a: "x", b: 1 })).toBe("denied");
  });

  it("pin 판정 ok·stale·denied + map 부모 pin", () => {
    const e = { node: { id: "1.1", hash: "h1" }, tool: { server: "s", name: "t" }, args: { a: "x" } };
    expect(checkApproval([e], approvalPins({ id: "1.1", hash: "h1" }), "s", "t", { a: "x" })).toBe("ok");
    expect(checkApproval([e], approvalPins({ id: "1.1", hash: "h2" }), "s", "t", { a: "x" })).toBe("stale");
    expect(checkApproval([e], approvalPins({ id: "9.9", hash: "h1" }), "s", "t", { a: "x" })).toBe("denied");
    expect(checkApproval([e], approvalPins({ id: "1.1", hash: "h1" }), "s", "t", { a: "y" })).toBe("denied");
    // map 인스턴스(1.2.1)는 부모 pin으로 판정.
    const me = { node: { id: "1.2", hash: "mh" }, tool: { server: "s", name: "t" }, args: { f: { $any: true } } };
    const pins = approvalPins(
      { id: "1.2.1", hash: "1.2-hash#0", parentId: "1.2" },
      { id: "1.2", hash: "mh", kind: "map" },
    );
    expect(checkApproval([me], pins, "s", "t", { f: "a.csv" })).toBe("ok");
    expect(checkApproval([me], [{ id: "1.2.1", hash: "1.2-hash#0" }], "s", "t", { f: "a.csv" })).toBe("denied");
  });

  it("buildApprovalEntry: fixed 값·var *·script 제외", () => {
    const built = buildApprovalEntry({
      id: "1.1", goal: "g", tool: { server: "s", name: "t" }, sideEffect: "external",
      args: {
        a: { kind: "fixed", value: "x" },
        b: { kind: "var", ref: "${params.p}" },
        c: { kind: "script", file: "scripts/s.py", runtime: "python" },
      } as never,
      constraints: [],
    }, ["b"]);
    expect(built.node.id).toBe("1.1");
    expect(built.node.hash.length).toBeGreaterThan(0);
    expect(built.args).toEqual({ a: "x", b: { $any: true } });
    expect(() => buildApprovalEntry({ id: "1", goal: "g", sideEffect: "none" })).toThrow();
  });

  it("M5.5-4.2-2: var 미지정 → bad_request + 키 목록 / 접두 와일드카드", () => {
    const doc = {
      id: "1.1", goal: "g", tool: { server: "s", name: "t" }, sideEffect: "external",
      args: { u: { kind: "var", ref: "${params.u}" } }, constraints: [],
    } as never;
    let code = "";
    try {
      buildApprovalEntry(doc);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      expect(String(e instanceof Error ? e.message : e)).toContain("u");
    }
    expect(code).toBe("bad_request");
    expect(buildApprovalEntry(doc, ["u"]).args).toEqual({ u: { $any: true } });
    // 접두 와일드카드 매칭.
    const e = { node: { id: "1.1", hash: "h" }, tool: { server: "s", name: "t" }, args: { url: { $prefix: "https://a.com/" } } };
    expect(matchApproval(e, "s", "t", { url: "https://a.com/list" })).toBe(true);
    expect(matchApproval(e, "s", "t", { url: "https://evil.com/list" })).toBe(false);
    expect(matchApproval(e, "s", "t", { url: "https://a.com.evil.com/" })).toBe(false);
    expect(matchApproval(e, "s", "t", { url: 123 })).toBe(false);
    // "*"가 중간이면 리터럴.
    const lit = { node: { id: "1.1", hash: "h" }, tool: { server: "s", name: "t" }, args: { v: "a*b" } };
    expect(matchApproval(lit, "s", "t", { v: "a*b" })).toBe(true);
    expect(matchApproval(lit, "s", "t", { v: "aXb" })).toBe(false);
  });

  it("loadApprovals: 없음→빈 목록", () => {
    expect(loadApprovals(join(root, "nope"))).toEqual([]);
  });

  it("M5.5-4.3-1: 문자열은 항상 정확 일치 (SELECT */*)", () => {
    const sel = { node: { id: "1", hash: "h" }, tool: { server: "s", name: "t" }, args: { q: "SELECT *" } };
    expect(matchApproval(sel, "s", "t", { q: "SELECT *" })).toBe(true);
    expect(matchApproval(sel, "s", "t", { q: "SELECT x" })).toBe(false);
    const star = { node: { id: "1", hash: "h" }, tool: { server: "s", name: "t" }, args: { q: "*" } };
    expect(matchApproval(star, "s", "t", { q: "*" })).toBe(true);
    expect(matchApproval(star, "s", "t", { q: "other" })).toBe(false);
  });

  it("M5.5-4.3-2: URL 모드 (origin+세그먼트)", () => {
    const e = (prefix: string) => ({
      node: { id: "1", hash: "h" }, tool: { server: "s", name: "t" }, args: { url: { $prefix: prefix } },
    });
    const pub = e("https://a.com/public/");
    expect(matchApproval(pub, "s", "t", { url: "https://a.com/public/x" })).toBe(true);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com.evil.com/public/x" })).toBe(false);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com@evil.com/public/x" })).toBe(false);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com/public/../admin" })).toBe(false);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com/%2e%2e/admin" })).toBe(false);
    expect(matchApproval(pub, "s", "t", { url: "https://A.COM/public/x" })).toBe(true);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com:443/public/x" })).toBe(true);
    expect(matchApproval(pub, "s", "t", { url: "https://a.com/private" })).toBe(false);
    expect(matchApproval(pub, "s", "t", { url: "not a url" })).toBe(false);
    // origin 뒤 "/" 없는 패턴은 로드 거부.
    const d = mkdtempSync(join(tmpdir(), "pf-m543u-"));
    writeFileSync(join(d, "approvals.json"), JSON.stringify({
      version: 2,
      entries: [{ node: { id: "1", hash: "h" }, tool: { server: "s", name: "t" }, args: { url: { $prefix: "https://a.com" } } }],
    }));
    expect(() => loadApprovals(d)).toThrow(/bad_request|형식 오류/);
  });

  it("M5.5-4.3-1: v1 변환 (*→$any, 끝*→$prefix)", () => {
    expect(migrateV1Value("*")).toEqual({ $any: true });
    expect(migrateV1Value("https://a.com/*")).toEqual({ $prefix: "https://a.com/" });
    // 끝 *는 규칙대로 $prefix로 변환된다 (v1의 "SELECT *"는 변환 후 검토 대상).
    expect(migrateV1Value("SELECT *")).toEqual({ $prefix: "SELECT " });
    expect(migrateV1Value("a*b")).toBe("a*b");
    expect(migrateV1Value({ u: "*", p: { x: "a/*" }, n: 1 })).toEqual({ u: { $any: true }, p: { x: { $prefix: "a/" } }, n: 1 });
    // v1 파일 로드 → 변환 적용.
    const d = mkdtempSync(join(tmpdir(), "pf-m543v1-"));
    writeFileSync(join(d, "approvals.json"), JSON.stringify([
      { node: { id: "1.1", hash: "h" }, tool: { server: "s", name: "t" }, args: { u: "*", p: "https://a.com/*" } },
    ]));
    expect(loadApprovals(d)).toEqual([
      { node: { id: "1.1", hash: "h" }, tool: { server: "s", name: "t" }, args: { u: { $any: true }, p: { $prefix: "https://a.com/" } } },
    ]);
    // node pin 없는 v1 → bad_request.
    const d2 = mkdtempSync(join(tmpdir(), "pf-m543v1b-"));
    writeFileSync(join(d2, "approvals.json"), JSON.stringify([{ tool: { server: "s", name: "t" } }]));
    expect(() => loadApprovals(d2)).toThrow(/재생성/);
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
    // M5.5-4.1-5: run 명령은 겹친 실행(conflict)만 4.
    expect(runErrorExit(Object.assign(new Error("locked"), { code: "conflict" }))).toBe(4);
    expect(runErrorExit(Object.assign(new Error("x"), { code: "bad_request" }))).toBe(2);
    expect(runErrorExit(new Error("x"))).toBe(1);
  });
});

describe("M5.5-4 무인 실행 E2E", () => {
  it("승인 일치 → 실행·통과", async () => {
    const app = await buildUnatt();
    // M5.5-4.1-3: approve 명령과 같은 경로로 항목 생성 (node pin 포함).
    const ap = await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    expect(ap.nodeId).toBe("1.1");
    expect(ap.replaced).toBe(false);
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
    expect(n.detail ?? "").not.toContain("갱신");
  }, 120000);

  it("해시 불일치 → fail [approval] + 갱신 안내", async () => {
    const app = await buildUnatt();
    const ap = await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    expect(ap.hash.length).toBeGreaterThan(0);
    writeApprovals([{ node: { id: "1.1", hash: "stale-hash" }, tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" } }]);
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(1);
    const n = report.results.find((r) => r.nodeId === "1.1")!;
    expect(n.failedConstraints).toContain("approval");
    expect(n.detail ?? "").toContain("갱신");
  }, 120000);

  it("인자 불일치 → fail [approval]", async () => {
    const app = await buildUnatt();
    const ap = await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    writeApprovals([{ node: { id: "1.1", hash: ap.hash }, tool: { server: "fake-ppt", name: "echo" }, args: { note: "other" } }]);
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(1);
    expect(report.results.find((r) => r.nodeId === "1.1")?.failedConstraints).toContain("approval");
    rmSync(join(pfdir, "procedures", "m55-unatt", "approvals.json"));
  }, 120000);

  it("일반 live(대화형) → suspended 유지", async () => {
    const app = await buildUnatt();
    await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    const { report } = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.suspended).toBe(1);
    expect(report.results.find((r) => r.nodeId === "1.1")?.detail).toBe("need_approval");
  }, 120000);

  it("approve 오류: 없는 노드·비external", async () => {
    const app = await buildUnatt();
    await expect(app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "9.9" })).rejects.toThrow();
    await expect(app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1" })).rejects.toThrow();
  }, 120000);

  it("겹친 실행 → 두 번째 conflict (exit 4)", async () => {
    const app = await buildUnatt();
    await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    const runOpts = {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    } as const;
    const [a, b] = await Promise.allSettled([
      runProcedureTest(pfdir, root, "m55-unatt", { ...runOpts }),
      runProcedureTest(pfdir, root, "m55-unatt", { ...runOpts }),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled");
    const ng = [a, b].filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(ng.length).toBe(1);
    const err = (ng[0] as PromiseRejectedResult).reason as { code?: string; message?: string };
    expect(err.code).toBe("conflict");
    expect(String(err.message ?? "")).toContain("procedure run locked");
    // M5.5-4.1-5: conflict → exit 4.
    expect(runErrorExit(err)).toBe(4);
  }, 120000);
});

describe("M5.5-4.2-2 접두 와일드카드 E2E", () => {
  async function buildUrlEcho(): Promise<ProcForgeApp> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({
      request: "fetch", params: { url: "https://a.com/list" }, toolCatalog: ECHO_CAT,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "가져오기" }],
    });
    const r1 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { url: "https://a.com/list" }, resultSummary: "fetch",
      resultJson: { url: "https://a.com/list" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r1.verdict).toBe("pass");
    await client.pfEditNode({
      sessionId: sid, nodeId: "1.1",
      addConstraints: [{ id: "c-u", kind: "json_path_exists", spec: { path: "url" }, source: "human" }],
    });
    const r2 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { url: "https://a.com/list" }, resultSummary: "fetch",
      resultJson: { url: "https://a.com/list" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r2.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { url: { kind: "var", ref: "${params.url}" } } as never,
      sideEffect: "external",
    });
    const fin = await app.finalize({ sessionId: sid, name: "m55-url" });
    expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
    return app;
  }

  function prefixApprovals(): void {
    const p = join(pfdir, "procedures", "m55-url", "approvals.json");
    const file = JSON.parse(readFileSync(p, "utf8")) as {
      version: number; entries: { args?: Record<string, unknown> }[];
    };
    expect(file.version).toBe(2);
    expect(file.entries[0].args).toEqual({ url: { $any: true } });
    file.entries[0].args = { url: { $prefix: "https://a.com/" } };
    writeFileSync(p, JSON.stringify(file));
  }

  function urlOpts(url: string) {
    return {
      procforgeDir: pfdir, projectRoot: root, mode: "live" as const,
      params: { url }, unattended: true,
    };
  }

  it("같은 호스트 → 통과, 다른 호스트 → exit 3", async () => {
    const app = await buildUrlEcho();
    await app.approveProcedureNode({ procedure: "m55-url", nodeId: "1.1", allowWildcard: ["url"] });
    prefixApprovals();
    const same = await runProcedureTest(pfdir, root, "m55-url", urlOpts("https://a.com/other"));
    expect(same.report.summary.fail).toBe(0);
    const evil = await runProcedureTest(pfdir, root, "m55-url", urlOpts("https://evil.com/"));
    expect(evil.report.summary.fail).toBe(1);
    expect(evil.report.results.find((r) => r.nodeId === "1.1")?.failedConstraints).toContain("approval");
    expect(runExitCode({ failed: evil.report.summary.fail, suspended: 0, approvalBlocked: true })).toBe(3);
  }, 180000);
});

describe("M5.5-4.2-3 procedure.json 직접 수정", () => {
  it("args 1글자 수정 → stale + 갱신 안내 + exit 3, 해시는 파일 재계산", async () => {
    const app = await buildUnatt();
    const ap = await app.approveProcedureNode({ procedure: "m55-unatt", nodeId: "1.1" });
    const procFile = join(pfdir, "procedures", "m55-unatt", "procedure.json");
    const text = readFileSync(procFile, "utf8");
    expect(text).toContain('"value": "hi"');
    writeFileSync(procFile, text.replace('"value": "hi"', '"value": "ho"'));
    // 런타임 hash는 수정된 파일 내용에서 재계산 (importProcedure computeNodeHash).
    const doc = JSON.parse(readFileSync(procFile, "utf8")) as {
      nodes: { id: string; goal: string; args: Record<string, never>; constraints: never[] }[];
    };
    const n11 = doc.nodes.find((n) => n.id === "1.1")!;
    const recomputed = computeNodeHash({ goal: n11.goal, args: n11.args, constraints: n11.constraints, dependsOn: [] });
    expect(recomputed).not.toBe(ap.hash);
    const r = await runProcedureTest(pfdir, root, "m55-unatt", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    const sessNode = JSON.parse(
      readFileSync(join(pfdir, "sessions", r.sessionId, "nodes", "1.1.json"), "utf8"),
    ) as { hash: string };
    expect(sessNode.hash).toBe(recomputed);
    const n = r.report.results.find((x) => x.nodeId === "1.1")!;
    expect(n.status).toBe("fail");
    expect(n.failedConstraints).toContain("approval");
    expect(n.detail ?? "").toContain("갱신");
    expect(runExitCode({ failed: r.report.summary.fail, suspended: 0, approvalBlocked: true })).toBe(3);
  }, 120000);
});

describe("M5.5-4.2-1 논리 경로 매칭", () => {
  async function buildPathSave(): Promise<ProcForgeApp> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "save", params: {}, toolCatalog: SAVE_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "파일 저장" }],
    });
    const r1 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "save" },
      args: { file_path: "output/n.txt", content: "hi" },
      resultSummary: "saved", resultJson: { saved: "output/n.txt" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r1.verdict).toBe("pass");
    await client.pfEditNode({
      sessionId: sid, nodeId: "1.1",
      addConstraints: [{ id: "c-s", kind: "json_path_exists", spec: { path: "saved" }, source: "human" }],
    });
    const r2 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "save" },
      args: { file_path: "output/n.txt", content: "hi" },
      resultSummary: "saved", resultJson: { saved: "output/n.txt" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r2.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "save" },
      argSpecs: {
        file_path: { kind: "fixed", value: "output/n.txt", path: "out" },
        content: { kind: "fixed", value: "hi" },
      } as never,
      sideEffect: "external",
    });
    const fin = await app.finalize({ sessionId: sid, name: "m55-pathsave" });
    expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
    return app;
  }

  it("approve 생성 → 수정 없이 run --unattended → exit 0", async () => {
    const app = await buildPathSave();
    await app.approveProcedureNode({ procedure: "m55-pathsave", nodeId: "1.1" });
    const { report } = await runProcedureTest(pfdir, root, "m55-pathsave", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
    // 실제 파일은 run fs 안에 기록 (논리 경로 그대로 승인됐어도 실행은 절대경로).
    const out = join(pfdir, "runs", report.runId, "fs", "output", "n.txt");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("hi");
    expect(runExitCode({ failed: 0, suspended: 0, approvalBlocked: false })).toBe(0);
  }, 120000);
});

describe("M5.5-4.1-4 unattended generated 사전 거부", () => {
  async function buildGen(): Promise<void> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "gen", params: {}, toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "생성값 에코" }],
    });
    const r1 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "probe" }, resultSummary: "probe", resultJson: { note: "probe" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r1.verdict).toBe("pass");
    const c = await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "generated", inputs: [], instruction: "메모 생성" } } as never,
    });
    expect((c.node as { status?: string }).status).toBe("leaf");
    await app.finalize({ sessionId: sid, name: "m55-gen" });
  }

  it("무인 실행 → bad_request 즉시 거부", async () => {
    await buildGen();
    let code = "";
    try {
      await runProcedureTest(pfdir, root, "m55-gen", {
        procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      expect(String(e instanceof Error ? e.message : e)).toContain("무인 실행 불가");
    }
    // M5.5-4.1-1: bad_request → exit 2.
    expect(code).toBe("bad_request");
  }, 120000);

  it("일반 live → suspended 유지 (기존 동작)", async () => {
    await buildGen();
    const { report } = await runProcedureTest(pfdir, root, "m55-gen", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.suspended).toBe(1);
  }, 120000);
});

describe("M5.5-4.2-5 절차서 잠금", () => {
  const PROC = "m55-unatt";
  function procDir(): string {
    return join(pfdir, "procedures", PROC);
  }
  async function directSession(): Promise<{ sessionId: string; store: FileStore }> {
    const store = new FileStore(pfdir);
    const { doc } = loadProcedureDoc(pfdir, PROC);
    const { sessionId } = importProcedure(pfdir, doc, {});
    return { sessionId, store };
  }
  function sessOpts(sessionId: string) {
    return {
      procforgeDir: pfdir, projectRoot: root, sessionId, mode: "live" as const,
      params: {}, unattended: true, procedureDir: procDir(),
    };
  }

  it("절차서 잠금 실패 → conflict + 세션 잠금 해제", async () => {
    const app = await buildUnatt();
    await app.approveProcedureNode({ procedure: PROC, nodeId: "1.1" });
    const { sessionId, store } = await directSession();
    const held = store.acquireFileLock(join(procDir(), ".run.lock"), `procedure run locked: ${PROC}`, 60000);
    let code = "";
    try {
      await runSession(sessOpts(sessionId));
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("conflict");
    // finally에서 세션 잠금이 해제되어 재획득 가능.
    store.acquireLock(sessionId)();
    held();
    // 절차서 잠금 해제 후에는 실행 성공.
    const report = await runSession(sessOpts(sessionId));
    expect(report.summary.fail).toBe(0);
  }, 120000);

  it("staleMs 60s 문서 일치: 45초 잠금은 fresh(conflict), 61초는 회수", async () => {
    const app = await buildUnatt();
    await app.approveProcedureNode({ procedure: PROC, nodeId: "1.1" });
    const lockPath = join(procDir(), ".run.lock");
    const plant = (secAgo: number): void => {
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: "dead", at: new Date().toISOString() }));
      const t = new Date(Date.now() - secAgo * 1000);
      utimesSync(lockPath, t, t);
    };
    const { sessionId } = await directSession();
    plant(45);
    await expect(runSession(sessOpts(sessionId))).rejects.toThrow(/procedure run locked/);
    plant(61);
    const { sessionId: sid2 } = await directSession();
    const report = await runSession(sessOpts(sid2));
    expect(report.summary.fail).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 180000);

  it("하트비트가 세션+절차서 잠금을 갱신", async () => {
    vi.useFakeTimers();
    try {
      const store = new FileStore(pfdir);
      const lockSpy = vi.spyOn(store, "refreshLock").mockImplementation(() => {});
      const fileSpy = vi.spyOn(store, "refreshFileLock").mockImplementation(() => {});
      const stop = startRunHeartbeat(store, "sid-x", "/proc/.run.lock");
      expect(lockSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20000);
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(fileSpy).toHaveBeenCalledTimes(1);
      expect(fileSpy).toHaveBeenCalledWith("/proc/.run.lock");
      stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(lockSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("M5.5-4.3-3 approvalHash", () => {
  const A = {
    id: "1.1", goal: "g", tool: { server: "s", name: "t" },
    args: { a: { kind: "fixed", value: "x" } }, constraints: [], sideEffect: "none",
  };
  const B = {
    id: "1.2", goal: "h", tool: { server: "s", name: "t" },
    args: { b: { kind: "var", ref: "$1.1" } }, constraints: [], sideEffect: "external",
  };
  const byIdOf = (...nodes: { id: string }[]) =>
    new Map(nodes.map((n) => [n.id, n as never]));

  it("단위: 상류·tool·sideEffect·템플릿 변경에 민감, params 무영향", () => {
    const base = computeApprovalHash(B as never, byIdOf(A as never, B as never));
    expect(computeApprovalHash(B as never, byIdOf(A as never, B as never))).toBe(base);
    const A2 = { ...A, args: { a: { kind: "fixed", value: "y" } } };
    expect(computeApprovalHash(B as never, byIdOf(A2 as never, B as never))).not.toBe(base);
    const Btool = { ...B, tool: { server: "s", name: "u" } };
    expect(computeApprovalHash(Btool as never, byIdOf(A as never, Btool as never))).not.toBe(base);
    const Bse = { ...B, sideEffect: "none" };
    expect(computeApprovalHash(Bse as never, byIdOf(A as never, Bse as never))).not.toBe(base);
    const M = { ...B, map: { over: "$1.1", template: { tool: { server: "s", name: "t" }, args: {} } } };
    const M2 = { ...B, map: { over: "$1.1", template: { tool: { server: "s", name: "u" }, args: {} } } };
    expect(computeApprovalHash(M2 as never, byIdOf(A as never, M2 as never))).not.toBe(
      computeApprovalHash(M as never, byIdOf(A as never, M as never)),
    );
    const P1 = { ...B, args: {} };
    const P2 = { ...B, args: { p: { kind: "var", ref: "${params.p}" } } };
    // params 참조는 상류를 끌고 오지 않지만 내용은 바뀌므로 해시는 달라진다.
    expect(computeApprovalHash(P2 as never, byIdOf(A as never, P2 as never))).not.toBe(
      computeApprovalHash(P1 as never, byIdOf(A as never, P1 as never)),
    );
    // 상류가 byId에 없으면 무시하고 결정적으로 계산.
    expect(computeApprovalHash(B as never, new Map())).toBe(
      computeApprovalHash(B as never, new Map()),
    );
  });

  async function buildChain(): Promise<ProcForgeApp> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "chain", params: {}, toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "원본" }, { goal: "전달", dependsOn: ["1.1"] }],
    });
    const r1 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "hi" }, resultSummary: "hi", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r1.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
    const r2 = await client.pfReport({
      sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "hi" }, resultSummary: "fwd", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r2.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "var", ref: "$1.1.note" } } as never,
      sideEffect: "external",
    });
    const fin = await app.finalize({ sessionId: sid, name: "m55-chain" });
    expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
    return app;
  }

  it("M5.5-4.4-1 단위: script 내용 변경에 민감, 부재 시 결정적", () => {
    const S = {
      id: "1.4", goal: "s", tool: { server: "host", name: "script" },
      args: { acc: { kind: "script", file: "scripts/acc.py" } }, constraints: [], sideEffect: "none",
    };
    const byId = new Map([[S.id, S as never]]);
    const r1 = () => computeApprovalHash(S as never, byId, new Set(), { readScript: () => "v1" });
    const r2 = () => computeApprovalHash(S as never, byId, new Set(), { readScript: () => "v2" });
    const r3 = () => computeApprovalHash(S as never, byId, new Set(), {});
    expect(r1()).toBe(r1());
    expect(r2()).not.toBe(r1());
    expect(r3()).toBe(r3());
    expect(r3()).not.toBe(r1());
  });

  it("상류 1.1 수정 → 1.2 stale exit 3 (1.2 자체 hash 불변)", async () => {
    const app = await buildChain();
    const ap = await app.approveProcedureNode({ procedure: "m55-chain", nodeId: "1.2", allowWildcard: ["note"] });
    const first = await runProcedureTest(pfdir, root, "m55-chain", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(first.report.summary.fail).toBe(0);
    const procFile = join(pfdir, "procedures", "m55-chain", "procedure.json");
    const text = readFileSync(procFile, "utf8");
    expect(text).toContain('"value": "hi"');
    writeFileSync(procFile, text.replace('"value": "hi"', '"value": "ho"'));
    // 1.2 자체 내용은 불변 → node.hash는 승인값과 동일해야 한다.
    const doc = JSON.parse(readFileSync(procFile, "utf8")) as {
      nodes: { id: string; goal: string; args: Record<string, never>; constraints: never[] }[];
    };
    const n12 = doc.nodes.find((n) => n.id === "1.2")!;
    expect(computeNodeHash({ goal: n12.goal, args: n12.args, constraints: n12.constraints, dependsOn: [] })).toBe(ap.hash);
    const r = await runProcedureTest(pfdir, root, "m55-chain", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    const n = r.report.results.find((x) => x.nodeId === "1.2")!;
    expect(n.status).toBe("fail");
    expect(n.failedConstraints).toContain("approval");
    expect(n.detail ?? "").toContain("갱신");
    expect(runExitCode({ failed: r.report.summary.fail, suspended: 0, approvalBlocked: true })).toBe(3);
  }, 180000);
});

describe("M5.5-4.4-2 url 템플릿 상류 참조", () => {
  async function buildUrlChain(): Promise<ProcForgeApp> {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "urlchain", params: {}, toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "원본" }, { goal: "가져오기", dependsOn: ["1.1"] }],
    });
    const r1 = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "https://a.com/list" }, resultSummary: "url",
      resultJson: { note: "https://a.com/list" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r1.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "https://a.com/list" } } as never,
    });
    const r2 = await client.pfReport({
      sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
      args: { url: "https://a.com/list" }, resultSummary: "fetch",
      resultJson: { url: "https://a.com/list" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(r2.verdict).toBe("pass");
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { url: { kind: "var", ref: "$1.1.note" } } as never,
      sideEffect: "external",
    });
    const fin = await app.finalize({ sessionId: sid, name: "m55-urlchain" });
    expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
    return app;
  }

  it("url 템플릿이 $1.1 참조 → 1.1 수정 시 stale exit 3", async () => {
    const app = await buildUrlChain();
    await app.approveProcedureNode({ procedure: "m55-urlchain", nodeId: "1.2", allowWildcard: ["url"] });
    const first = await runProcedureTest(pfdir, root, "m55-urlchain", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    expect(first.report.summary.fail).toBe(0);
    const procFile = join(pfdir, "procedures", "m55-urlchain", "procedure.json");
    const text = readFileSync(procFile, "utf8");
    expect(text).toContain("https://a.com/list");
    writeFileSync(procFile, text.replace("https://a.com/list", "https://a.com/other"));
    const r = await runProcedureTest(pfdir, root, "m55-urlchain", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {}, unattended: true,
    });
    const n = r.report.results.find((x) => x.nodeId === "1.2")!;
    expect(n.status).toBe("fail");
    expect(n.failedConstraints).toContain("approval");
    expect(n.detail ?? "").toContain("갱신");
    expect(runExitCode({ failed: r.report.summary.fail, suspended: 0, approvalBlocked: true })).toBe(3);
  }, 180000);
});
