import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { callWithRetry, isTransientToolError, isTransientResult, retryDelayMs, parseRetryAfterMs } from "../src/runner/run.js";
import { parseRetryOptions } from "../src/app/run-exit.js";
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

function stubPool(script: ("ok" | Error | { json: unknown })[]): { calls: number; call: () => Promise<{ resultText: string; resultJson: unknown }> } {
  const st = {
    calls: 0,
    async call(): Promise<{ resultText: string; resultJson: unknown }> {
      st.calls += 1;
      const s = script[Math.min(st.calls - 1, script.length - 1)];
      if (s instanceof Error) throw s;
      if (s !== "ok") return { resultText: JSON.stringify(s), resultJson: (s as { json: unknown }).json };
      return { resultText: "ok", resultJson: {} };
    },
  };
  return st;
}

describe("M5.6-f 재시도 단위", () => {
  it("일시 오류 판별", () => {
    for (const m of ["timeout after 30000ms", "ECONNRESET", "fetch failed: x", "status 503", "temporary failure"]) {
      expect(isTransientToolError(new Error(m))).toBe(true);
    }
    // M5.6.1-2: 10013은 기본 제외.
    expect(isTransientToolError(new Error("WinError 10013"))).toBe(false);
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

  it("M5.6.1-1: ok:false 일시 상태도 재시도", async () => {
    expect(isTransientResult({ resultText: "x", resultJson: { ok: false, status: 503 } })).toBe(true);
    expect(isTransientResult({ resultText: "x", resultJson: { ok: false, status: 400 } })).toBe(false);
    expect(isTransientResult({ resultText: "x", resultJson: { ok: true } })).toBe(false);
    expect(isTransientResult({ resultText: "x", resultJson: null })).toBe(false);
    const p = stubPool([{ json: { ok: false, status: 503 } }, { json: { ok: false, status: 503 } }, "ok"]);
    const r = await callWithRetry(p, "s", "t", {}, { retry: true, baseMs: 1 });
    expect(r.resp.resultText).toBe("ok");
    expect(r.attempts).toBe(3);
    // 소진 시 마지막 응답이 아니라 throw.
    const q = stubPool([{ json: { ok: false, status: 503 } }]);
    await expect(callWithRetry(q, "s", "t", {}, { retry: true, attempts: 2, baseMs: 1 })).rejects.toThrow(/일시 오류 응답 지속/);
    expect(q.calls).toBe(2);
  });

  it("M5.6.1-2: \\b 경계 + 10013 기본 제외", () => {
    expect(isTransientToolError(new Error("status 502"))).toBe(true);
    expect(isTransientToolError(new Error("code 15020"))).toBe(false);
    expect(isTransientToolError(new Error("WinError 10013"))).toBe(false);
    expect(isTransientToolError(new Error("WinError 10013"), [/\b10013\b/i])).toBe(true);
    expect(isTransientToolError(new Error("code 110013x"), [/\b10013\b/i])).toBe(false);
  });

  it("M5.6.1-2: 대기 상한·jitter·Retry-After", () => {
    expect(parseRetryAfterMs("429 Retry-After: 120")).toBe(120000);
    expect(parseRetryAfterMs("no header")).toBe(undefined);
    // 상한 30s, 하한 보장.
    expect(retryDelayMs(1e9, 5)).toBeLessThanOrEqual(30000);
    for (let i = 0; i < 20; i++) {
      const d = retryDelayMs(500, 2);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThan(2500);
    }
    expect(retryDelayMs(100, 0, 5000)).toBeGreaterThanOrEqual(5000);
    expect(retryDelayMs(100, 0, 5000)).toBeLessThanOrEqual(30000);
  });

  it("M5.6.1-2: attempts 상한 10 + Retry-After 존중", async () => {
    const p = stubPool([new Error("ECONNRESET")]);
    await expect(callWithRetry(p, "s", "t", {}, { retry: true, attempts: 99, baseMs: 1 })).rejects.toThrow();
    expect(p.calls).toBe(10);
    const q = stubPool([new Error("429 Retry-After: 2")]);
    const t0 = Date.now();
    await expect(callWithRetry(q, "s", "t", {}, { retry: true, attempts: 1, baseMs: 1 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
    const r = stubPool([new Error("429 Retry-After: 2"), "ok"]);
    const t1 = Date.now();
    const out = await callWithRetry(r, "s", "t", {}, { retry: true, baseMs: 1 });
    expect(out.resp.resultText).toBe("ok");
    expect(Date.now() - t1).toBeGreaterThanOrEqual(1500);
  });

  it("M5.6.1-2: parseRetryOptions 검증", () => {
    expect(parseRetryOptions(undefined, undefined)).toEqual({ attempts: 3, baseMs: 500 });
    expect(parseRetryOptions("2", "100")).toEqual({ attempts: 2, baseMs: 100 });
    for (const bad of [["0", undefined], ["11", undefined], ["abc", undefined], [undefined, "-1"]] as const) {
      expect(() => parseRetryOptions(bad[0] as string | undefined, bad[1] as string | undefined)).toThrow(/bad --retry/);
    }
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
