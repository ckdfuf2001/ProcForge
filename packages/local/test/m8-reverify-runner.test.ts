import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { runTestSession as runSession } from "./client-mode.js";
import { runExitCode } from "../src/app/run-exit.js";

// M8-1-0 보정: 재검증 대기(needs_reverify) 노드는 러너가 실행하지 않는다.
// + finalize 이 approvals.json(무인 실행이 실제로 쓰는 승인 목록) 불일치를 안내한다.

const CATALOG = [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }] as never;
const TOOL = { server: "opencode", name: "read" };

let root: string;
let pfdir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m8rv-run-"));
  pfdir = join(root, ".procforge");
});

async function leafSession(): Promise<{ app: ProcForgeApp; sid: string }> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
  });
  const started = await client.pfStart({ request: "재검증", toolCatalog: CATALOG });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "split",
    children: [{ goal: "a" }],
  });
  await client.pfReport({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    args: { path: "x.txt" },
    resultSummary: "ok",
    resultJson: { ok: true },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await client.pfResolve({
    sessionId: sid,
    nodeId: "1.1",
    decision: "leaf",
    tool: TOOL,
    argSpecs: { path: { kind: "fixed", value: "x.txt" } } as never,
  });
  return { app, sid };
}

describe("M8-1-0 보정: 러너는 재검증 대기 노드를 실행하지 않는다", () => {
  it("status 'needs_reverify'로 보고하고 pass에 세지 않는다", async () => {
    const { sid } = await leafSession();
    // 의견 → 제약 추가 → hash 변경 → needs_reverify
    const { client } = testStack(pfdir);
    await client.pfAdvise({
      sessionId: sid,
      nodeId: "1.1",
      text: "보고서 문장을 다듬어라",
    });
    const n = await client.getNode(sid, "1.1");
    expect(n.status).toBe("needs_reverify");

    const rep = await runSession({
      procforgeDir: pfdir,
      projectRoot: root,
      sessionId: sid,
      mode: "record",
    });
    const r = rep.results.find((x) => x.nodeId === "1.1");
    expect(r?.status).toBe("needs_reverify");
    expect(rep.summary.needsReverify).toBe(1);
    expect(rep.summary.pass).toBe(0);
    expect(r?.detail).toMatch(/재검증 대기/);
  }, 60000);

  it("종료 코드는 0이 아니다 (success 아님)", () => {
    expect(
      runExitCode({
        failed: 0,
        suspended: 0,
        approvalBlocked: false,
        unverified: 0,
        needsReverify: 1,
      }),
    ).toBe(1);
    expect(
      runExitCode({
        failed: 0,
        suspended: 0,
        approvalBlocked: false,
        unverified: 0,
        needsReverify: 0,
      }),
    ).toBe(0);
  });
});

describe("M8-1-0 보정: finalize 승인 불일치 안내", () => {
  it("approvals.json의 고정값이 현재와 다르면 '재승인 필요'", async () => {
    const { app, sid } = await leafSession();
    // 절차서 승인 목록(무인 실행이 실제로 쓰는 approvals.json)을 만든다.
    const procDir = join(pfdir, "procedures", "rv-proc");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(
      join(procDir, "approvals.json"),
      JSON.stringify({
        version: 2,
        entries: [
          {
            node: { id: "1.1", hash: "old-hash" },
            approvalHash: "stale-approval-hash",
            tool: TOOL,
            args: { path: "x.txt" },
          },
        ],
      }),
      "utf8",
    );
    // 이 세션의 최근 실행이 위 절차서를 가리키게 한다.
    const runDir = join(pfdir, "runs", "rv-run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        version: 1,
        runId: "rv-run",
        sessionId: sid,
        procedure: "rv-proc",
        procedureDir: procDir,
        params: {},
        pending: [],
        done: [],
        supplied: {},
        approved: [],
        status: "done",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const out = await app.finalize({ sessionId: sid, name: "rv-proc" });
    expect(
      out.warnings.some((w) => w.includes("재승인 필요") && w.includes("1.1")),
    ).toBe(true);
  }, 60000);
});
