import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import {
  runProcedureTest,
  loadProcedureDoc,
} from "../src/runner/procedure-run.js";
import { buildImportSession } from "@proof/shared/procedure.js";
import {
  approvalPins,
  checkApproval,
  saveApproval,
  loadApprovals,
  toHashableMap,
} from "../src/services/approvals.js";
import { FileStore } from "../src/filestore.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M9-tmp: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M9-2-1: 재finalize 안전 (state/approvals/approved 보존, 실행 중 거부).
// finalize → UI·MCP·CLI 공통(app.finalize), run 잠금과 같은 기제 재사용.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const ECHO_CAT = [
  { server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;
const TOOL = { server: "fake-ppt", name: "echo" } as never;
const NAME = "m92-rf";

beforeEach(() => {
  root = makeTmp("pf-m92-");
  pfdir = join(root, ".procforge");
  home = makeTmp("pf-m92home-");
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({
      mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } },
    }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildSession(note: string): Promise<{ app: ProcForgeApp; sid: string }> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
  });
  const started = await client.pfStart({
    request: "echo",
    params: {},
    toolCatalog: ECHO_CAT,
  });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "split",
    children: [{ goal: "외부 에코" }],
  });
  await client.pfReport({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    args: { note },
    resultSummary: "echo",
    resultJson: { note },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await client.pfResolve({
    sessionId: sid,
    nodeId: "1.1",
    decision: "leaf",
    tool: TOOL,
    argSpecs: { note: { kind: "fixed", value: note } } as never,
    sideEffect: "external",
  });
  return { app, sid };
}

function procDir(): string {
  return join(pfdir, "procedures", NAME);
}

/** 현 doc(1.1)의 pins와 일치하는 유효 승인 1건을 기록한다. */
function approveCurrent(): void {
  const { doc } = loadProcedureDoc(pfdir, NAME);
  const found = doc.nodes.find((n) => n.id === "1.1");
  if (!found) throw new Error("doc에 1.1 없음");
  const { nodes } = buildImportSession(doc);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const target = byId.get("1.1");
  if (!target) throw new Error("세션에 1.1 없음");
  const pins = approvalPins(target, undefined, toHashableMap(byId), undefined, undefined);
  if (pins.length === 0) throw new Error("pin 없음");
  const fixed = (found.args as Record<string, { value?: unknown }> | undefined)?.note
    ?.value;
  saveApproval(procDir(), {
    node: { id: "1.1", hash: pins[0].hash },
    approvalHash: pins[0].approvalHash,
    tool: { server: "fake-ppt", name: "echo" },
    args: { note: fixed },
  } as never);
}

async function runUnattended() {
  return runProcedureTest(pfdir, root, NAME, {
    procforgeDir: pfdir,
    projectRoot: root,
    mode: "live",
    params: {},
    unattended: true,
  });
}

describe("M9-2-1 재finalize 안전", () => {
  it("① 재finalize 후 state.json·approvals.json·approved/ 내용이 같다", async () => {
    const { app, sid } = await buildSession("hi");
    await app.finalize({ sessionId: sid, name: NAME });
    const dir = procDir();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ seen: ["a"] }));
    writeFileSync(
      join(dir, "approvals.json"),
      JSON.stringify({ version: 2, entries: [] }),
    );
    mkdirSync(join(dir, "approved"), { recursive: true });
    writeFileSync(join(dir, "approved", "index.json"), "{}");
    const before = ["state.json", "approvals.json", "approved/index.json"].map(
      (f) => readFileSync(join(dir, f), "utf8"),
    );
    await app.finalize({ sessionId: sid, name: NAME, force: true });
    const after = ["state.json", "approvals.json", "approved/index.json"].map(
      (f) => readFileSync(join(dir, f), "utf8"),
    );
    expect(after).toEqual(before);
    // lock 검사용 임시 파일이 남지 않는다.
    expect(existsSync(join(dir, ".run.lock"))).toBe(false);
  }, 120000);

  it("② 내용 안 바뀐 노드는 재finalize 후에도 승인이 유효하다", async () => {
    const { app, sid } = await buildSession("hi");
    await app.finalize({ sessionId: sid, name: NAME });
    approveCurrent();
    await app.finalize({ sessionId: sid, name: NAME, force: true });
    const rep = await runUnattended();
    const r = rep.report.results.find((x) => x.nodeId === "1.1");
    expect(r?.status).toBe("pass");
    expect(r?.failedConstraints ?? []).not.toContain("approval");
  }, 120000);

  it("③ args 바꿔 재finalize → 그 노드 승인 무효, 무인 실행 거부", async () => {
    const { app, sid } = await buildSession("hi");
    await app.finalize({ sessionId: sid, name: NAME });
    approveCurrent();
    const second = await buildSession("bye");
    await second.app.finalize({ sessionId: second.sid, name: NAME, force: true });
    // pins 직접 판정: stale이어야 한다.
    const { doc } = loadProcedureDoc(pfdir, NAME);
    const found = doc.nodes.find((n) => n.id === "1.1");
    if (!found) throw new Error("doc에 1.1 없음");
    const { nodes } = buildImportSession(doc);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const target = byId.get("1.1");
    if (!target) throw new Error("세션에 1.1 없음");
    const pins = approvalPins(target, undefined, toHashableMap(byId), undefined, undefined);
    expect(
      checkApproval(loadApprovals(procDir()), pins, "fake-ppt", "echo", {
        note: "bye",
      }),
    ).toBe("stale");
    // 무인 실행은 approval 실패로 거부된다.
    const rep = await runUnattended();
    const r = rep.report.results.find((x) => x.nodeId === "1.1");
    expect(r?.status).toBe("fail");
    expect(r?.failedConstraints ?? []).toContain("approval");
  }, 120000);

  it("④ .run.lock 보유 중 재finalize → 거부, 기존 폴더 무손상", async () => {
    const { app, sid } = await buildSession("hi");
    await app.finalize({ sessionId: sid, name: NAME });
    const dir = procDir();
    const before = readFileSync(join(dir, "procedure.json"), "utf8");
    const release = new FileStore(pfdir).acquireFileLock(
      join(dir, ".run.lock"),
      `procedure finalize locked: ${NAME}`,
      60000,
    );
    try {
      await expect(
        app.finalize({ sessionId: sid, name: NAME, force: true }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(readFileSync(join(dir, "procedure.json"), "utf8")).toBe(before);
    } finally {
      release();
    }
    // 락 해제 후에는 확정된다.
    await app.finalize({ sessionId: sid, name: NAME, force: true });
  }, 120000);

  it("⑤ stale lock(죽은 pid)이면 finalize 허용", async () => {
    const { app, sid } = await buildSession("hi");
    await app.finalize({ sessionId: sid, name: NAME });
    const dir = procDir();
    writeFileSync(
      join(dir, ".run.lock"),
      JSON.stringify({ pid: 99999999, token: "stale", at: new Date(0).toISOString() }),
    );
    utimesSync(join(dir, ".run.lock"), new Date(0), new Date(0));
    await app.finalize({ sessionId: sid, name: NAME, force: true });
    expect(existsSync(join(dir, "procedure.json"))).toBe(true);
  }, 120000);
});
