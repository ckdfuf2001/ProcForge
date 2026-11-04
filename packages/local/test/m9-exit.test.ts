import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { harnessedSpawnEnv, bothNames } from "@procforge/shared/env-compat.js";

// M9-1-exit: Windows Node 24 종료 크래시 (libuv async.c assertion, 3221226505) 회귀 방지.
// remote 자식 CLI가 fetch 후 종료하는 경로를 반복 실행한다.
// 주의: 반드시 비동기 spawn을 쓴다. spawnSync는 워커 루프를 막아 in-worker
// 테스트 서버가 응답하지 못하고 자식이 영원히 기다리는 교착이 된다.

const DIST = resolve(__dirname, "..", "dist");
const KEY = "m9exit-key";
const WIN_ONLY = process.platform !== "win32";

let dir: string;
let base: string;
let close: (() => Promise<void>) | undefined;
let sid: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pf-m9exit-"));
  const s = await startServer({
    dataDir: dir,
    apiKeys: parseApiKeys(`t1:${KEY}`),
    port: 0,
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  const client = createRemoteCoreClient({ baseUrl: base, apiKey: KEY });
  const started = await client.pfStart({
    request: "exit-repro",
    params: {},
    toolCatalog: [
      { server: "s", name: "t", inputSchema: {}, schemaHash: "h" },
    ] as never,
  });
  sid = started.session.id;
}, 60000);

afterAll(async () => {
  await close?.();
});

function childEnv(pfdir: string): NodeJS.ProcessEnv {
  // 카탈로그 격리: tmp root에 빈 opencode.json을 두어 전역 MCP 스폰을 막는다.
  const root = mkdtempSync(join(tmpdir(), "pf-m9exit-root-"));
  writeFileSync(join(root, "opencode.json"), "{}");
  return harnessedSpawnEnv({
    ...bothNames("DIR", pfdir),
    ...bothNames("PROJECT_ROOT", root),
    ...bothNames("CORE_URL", base),
    ...bothNames("CORE_API_KEY", KEY),
  }) as NodeJS.ProcessEnv;
}

/** 비동기 spawn + 타임아웃 kill. 타임아웃이면 { timedOut: true }로 실패시킨다. */
async function runChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  ms: number,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* 무시 */ }
      resolveP({ status: null, stdout, stderr, timedOut: true });
    }, ms);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveP({ status, stdout, stderr, timedOut: false });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ status: null, stdout, stderr: stderr + String(e), timedOut: true });
    });
  });
}

describe.skipIf(WIN_ONLY)("M9-1-exit 종료 크래시", () => {
  it("remote 자식 CLI 10회 연속: 3221226505 0건", async () => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9exit-cli-"));
    for (let i = 0; i < 10; i++) {
      const r = await runChild(
        [join(DIST, "cli.js"), "test", sid, "--mode", "replay"],
        childEnv(pfdir),
        30000,
      );
      expect(r.timedOut, `run ${i}: timeout. stderr=${r.stderr.slice(0, 300)}`).toBe(false);
      expect([0, 1], `run ${i}: status=${r.status} stderr=${r.stderr.slice(0, 300)}`).toContain(
        r.status,
      );
      expect(r.status).not.toBe(3221226505);
    }
  }, 400000);
});

describe("M9-1-exit hang 방지", () => {
  it("CLI가 5초 안에 끝난다", async () => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9exit-hang-"));
    const r = await runChild(
      [join(DIST, "cli.js"), "test", sid, "--mode", "replay"],
      childEnv(pfdir),
      5000,
    );
    // 타임아웃이면 killed (hang). 강제 exit 타이머를 넣지 않으므로 hang은 실패다.
    expect(r.timedOut, `stderr=${r.stderr.slice(0, 300)}`).toBe(false);
    expect([0, 1]).toContain(r.status);
  }, 30000);
});
