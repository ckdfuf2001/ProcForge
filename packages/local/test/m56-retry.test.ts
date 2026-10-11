import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { callWithRetry, isTransientToolError } from "../src/runner/run.js";
import { testStack } from "./client-mode.js";

// M5.6-f: readOnly 도구 호출만 재시도 (지수 백오프, 설정화). external 재시도 금지.

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const UNSTABLE_CAT = [{
  server: "fake-ppt", name: "unstable", inputSchema: {}, schemaHash: "h",
  annotations: { readOnlyHint: true },
}] as never;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m56f-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m56fhome-"));
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

function stubPool(script: ("ok" | Error)[]): { calls: number; call: () => Promise<{ resultText: string; resultJson: unknown }> } {
  const st = {
    calls: 0,
    async call(): Promise<{ resultText: string; resultJson: unknown }> {
      st.calls += 1;
      const s = script[Math.min(st.calls - 1, script.length - 1)];
      if (s instanceof Error) throw s;
      return { resultText: "ok", resultJson: {} };
    },
  };
  return st;
}

describe("M5.6-f 재시도 단위", () => {
  it("일시 오류 판별", () => {
    for (const m of ["timeout after 30000ms", "ECONNRESET", "fetch failed: x", "status 503", "WinError 10013", "temporary failure"]) {
      expect(isTransientToolError(new Error(m))).toBe(true);
    }
    for (const m of ["bad_request: x", "tool error: MCP error -32602: Invalid", "unknown MCP server: x", "oldString not found"]) {
      expect(isTransientToolError(new Error(m))).toBe(false);
    }
  });

  it("성공까지 재시도 + 시도 횟수", async () => {
    const p = stubPool([new Error("ECONNRESET"), new Error("timeout"), "ok"]);
    const r = await callWithRetry(p, "s", "t", {}, { retry: true, baseMs: 1 });
    expect(r.resp.resultText).toBe("ok");
    expect(r.attempts).toBe(3);
    expect(p.calls).toBe(3);
  });

  it("retry:false·영구 오류·소진 시 1회/즉시 실패", async () => {
    const p1 = stubPool([new Error("ECONNRESET")]);
    await expect(callWithRetry(p1, "s", "t", {}, { retry: false, baseMs: 1 })).rejects.toThrow(/ECONNRESET/);
    expect(p1.calls).toBe(1);
    const p2 = stubPool([new Error("tool error: MCP error -32602: bad")]);
    await expect(callWithRetry(p2, "s", "t", {}, { retry: true, baseMs: 1 })).rejects.toThrow(/-32602/);
    expect(p2.calls).toBe(1);
    const p3 = stubPool([new Error("ECONNRESET")]);
    await expect(callWithRetry(p3, "s", "t", {}, { retry: true, attempts: 2, baseMs: 1 })).rejects.toThrow(/ECONNRESET/);
    expect(p3.calls).toBe(2);
  });
});

describe("M5.6-f readOnly E2E (unstable 첫 호출 실패 → 재시도 통과)", () => {
  it("live run pass", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "retry", params: {}, toolCatalog: UNSTABLE_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "읽기" }],
    });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "unstable" },
      args: { note: "k" }, resultSummary: "ok", resultJson: { note: "k", calls: 2 },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "unstable" },
      argSpecs: { note: { kind: "fixed", value: "k" } } as never,
    });
    const fin = await app.finalize({ sessionId: sid, name: "m56-retry" });
    expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
    const { report } = await runProcedureTest(pfdir, root, "m56-retry", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.fail).toBe(0);
    expect(report.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
  }, 120000);
});
