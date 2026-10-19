import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path, { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { readRunState } from "../src/services/run-state.js";

// M7-5-4: 실행 결과 화면 계약 — 절차서 목록 / 노드별 결과(그대로) / wildcard 명시 선택.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_CAT = [
  { server: "fake-ppt", name: "echo", inputSchema: { type: "object" }, schemaHash: "h" },
];

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-runinfo-"));
  pfdir = join(root, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
    "utf8",
  );
});

async function mkApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

/** echo leaf 하나짜리 절차서를 만들어 저장한다. sideEffect=external 이면 승인 대기로 만든다. */
async function mkProcedure(opts: {
  name?: string;
  argSpecs?: Record<string, unknown>;
  external?: boolean;
  finalize?: boolean;
}) {
  const name = opts.name ?? "simple-proc";
  const app = await mkApp();
  const started = await app.core.pfStart({
    request: "r",
    toolCatalog: ECHO_CAT as never,
    params: { who: "alice" },
  });
  const sid = started.session.id;
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "split",
    children: [{ goal: "x" }],
  });
  await app.core.pfReport({
    sessionId: sid,
    nodeId: "1.1",
    tool: { server: "fake-ppt", name: "echo" },
    args: { note: "hi" },
    resultSummary: "ok",
    resultJson: { note: "hi" },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await app.core.pfResolve({
    sessionId: sid,
    nodeId: "1.1",
    decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: (opts.argSpecs ?? { note: { kind: "fixed", value: "hi" } }) as never,
    ...(opts.external ? { sideEffect: "external" } : {}),
  });
  if (opts.external) {
    await app.askHuman({
      sessionId: sid,
      nodeId: "1.1",
      question: "실행할까요?",
      plan: { tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" } },
    });
  }
  // 승인 대기(needs_human)는 미해결이므로 finalize 할 수 없다 — 승인 계약만 볼 때는 생략한다.
  if (opts.finalize !== false) await app.finalize({ sessionId: sid, name });
  return { app, sid };
}

async function waitStatus(runId: string, want: string) {
  for (let i = 0; i < 400; i++) {
    const st = readRunState(pfdir, runId);
    if (st?.status === want) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readRunState(pfdir, runId);
}

describe("M7-5-4 실행 결과 API", () => {
  it("절차서 목록에 이름과 param 스키마가 온다", async () => {
    const { app } = await mkProcedure({});
    const list = await app.listProcedures();
    expect(list.procedures.map((p) => p.name)).toContain("simple-proc");
    const p = list.procedures.find((x) => x.name === "simple-proc");
    expect(p?.params).toContainEqual({
      name: "who",
      type: "string",
      required: false,
      default: "alice",
      description: "",
    });
  }, 30000);

  it("노드별 결과를 runner status 그대로 준다 (pass)", async () => {
    const { app } = await mkProcedure({});
    const run = await app.uiRun({ procedure: "simple-proc", params: { who: "x" } });
    const st = await waitStatus(run.runId, "done");
    expect(st?.status).toBe("done");
    const info = await app.uiRunInfo({ runId: run.runId });
    expect(info.results).toContainEqual({ nodeId: "1.1", status: "pass" });
    expect(info.summary?.pass).toBeGreaterThan(0);
    expect(info.procedure).toBe("simple-proc");
  }, 60000);

  it("최근 runId 는 새로고침 복원에 쓸 수 있다", async () => {
    const { app } = await mkProcedure({});
    const run = await app.uiRun({ procedure: "simple-proc", params: { who: "x" } });
    await waitStatus(run.runId, "done");
    expect(await app.uiLatestRun({ procedure: "simple-proc" })).toEqual({
      runId: run.runId,
    });
  }, 60000);

  it("HTTP: /api/procedures 와 /api/runs/:id", async () => {
    const { app } = await mkProcedure({});
    const run = await app.uiRun({ procedure: "simple-proc", params: { who: "x" } });
    await waitStatus(run.runId, "done");
    const srv = await createUiServer({ app });
    try {
      const h = { "x-procforge-token": srv.token };
      const p = (await (await fetch(`${srv.url}/api/procedures`, { headers: h })).json()) as {
        procedures: { name: string }[];
      };
      expect(p.procedures.map((x) => x.name)).toContain("simple-proc");
      const info = (await (
        await fetch(`${srv.url}/api/runs/${run.runId}`, { headers: h })
      ).json()) as { results: { nodeId: string; status: string }[] };
      expect(info.results).toContainEqual({ nodeId: "1.1", status: "pass" });
    } finally {
      await srv.close();
    }
  }, 60000);
});

describe("M7-5-4 승인 wildcard 명시 선택", () => {
  it("generated 키는 wildcardKeys 로 오고, 선택 없이는 승인 400", async () => {
    const { app, sid } = await mkProcedure({
      argSpecs: { note: { kind: "generated", instruction: "값 생성" } },
      external: true,
      finalize: false,
    });
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.wildcardKeys).toEqual(["note"]);
    const rev = (await app.readSession(sid)).revision;
    await expect(
      app.uiApprove({
        sessionId: sid,
        nodeId: "1.1",
        approvalHash: info.approvalHash,
        approved: true,
        expectedRevision: rev,
      }),
    ).rejects.toThrow(/와일드카드 미지정/);
    const ok = await app.uiApprove({
      sessionId: sid,
      nodeId: "1.1",
      approvalHash: info.approvalHash,
      approved: true,
      expectedRevision: rev,
      allowWildcard: ["note"],
    });
    expect(ok.approved).toBe(true);
  }, 30000);

  it("fixed 만 있으면 wildcardKeys 는 비고 선택 없이 승인된다", async () => {
    const { app, sid } = await mkProcedure({ external: true, finalize: false });
    const info = await app.uiApprovalInfo({ sessionId: sid, nodeId: "1.1" });
    expect(info.wildcardKeys).toEqual([]);
    const rev = (await app.readSession(sid)).revision;
    const ok = await app.uiApprove({
      sessionId: sid,
      nodeId: "1.1",
      approvalHash: info.approvalHash,
      approved: true,
      expectedRevision: rev,
    });
    expect(ok.approved).toBe(true);
  }, 30000);
});