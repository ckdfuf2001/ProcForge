import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
// Windows에서만 실행 (이름 주의: true면 스킵. M9-1-2에서 WIN_ONLY → NOT_WINDOWS 개명).
const NOT_WINDOWS = process.platform !== "win32";

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

describe.skipIf(NOT_WINDOWS)("M9-1-exit 종료 크래시", () => {
  it("remote 자식 CLI 10회 연속: 3221226505 0건", async () => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9exit-cli-"));
    // M9-1-2: 반복 안에서는 결과만 모으고, 로그를 먼저 쓴 뒤 마지막에 단언한다.
    // (이전 구조는 expect가 루프 안에서 던져져 실패 시 로그가 절대 기록되지 않았음)
    const failures: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await runChild(
        [join(DIST, "cli.js"), "test", sid, "--mode", "replay"],
        childEnv(pfdir),
        30000,
      );
      if (r.timedOut) {
        failures.push(`run ${i}: timeout. stderr=${r.stderr.slice(0, 300)}`);
      } else if (r.status === 3221226505) {
        failures.push(`run ${i}: crash 3221226505. stderr=${r.stderr.slice(0, 300)}`);
      } else if (![0, 1].includes(r.status as number)) {
        failures.push(`run ${i}: status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      }
    }
    if (failures.length > 0) {
      try {
        writeFileSync(
          join(tmpdir(), "m9exit-failures.log"),
          `${new Date().toISOString()} 10x failures (${failures.length}):\n${failures.join("\n")}\n`,
          { flag: "a" },
        );
      } catch { /* 로그 기록 실패는 무시 (단언이 실패를 보고함) */ }
    }
    expect(failures, failures.join("\n")).toEqual([]);
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

// M9-1-fix: 종료 대기는 명령 공통 경로라 run/repair/trace/export도 같은 가드로 확인한다.
// finalize는 CLI 명령이 없고 (App API만 존재), adviseAndSignal 호출은 상주 UI 서버 전담이라
// 한 번 실행 후 끝나는 CLI의 hang 범위가 아니다. 둘 다 제외 사유를 여기에 남긴다.
// procforge ui 역시 상주 서버라 제외한다.
describe("M9-1 exit hang 방지 (명령별)", () => {
  it.each([
    ["run", ["run", "__m9-missing-proc__"]],
    ["repair", ["repair", "123e4567-e89b-42d3-a456-426614174000", "--discard", "5"]],
    ["trace", ["trace", "123e4567-e89b-42d3-a456-426614174000"]],
    ["export", ["export", "123e4567-e89b-42d3-a456-426614174000", "--out", "m9-out"]],
  ])("hang 방지: %s", async (_name, args) => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9exit-hang-"));
    const r = await runChild([join(DIST, "cli.js"), ...args], childEnv(pfdir), 5000);
    expect(r.timedOut, `stderr=${r.stderr.slice(0, 300)}`).toBe(false);
    expect([0, 1, 2]).toContain(r.status);
    expect(r.status).not.toBe(3221226505);
  }, 60000);
});

// M9-1-exit: 카탈로그 수집 타이머 정리 회귀 테스트.
// listServerTools의 timeout 타이머를 clear하지 않으면, MCP 설정이 있는 CLI가
// 성공 후에도 timeoutMs(기본 15s)까지 종료하지 않는다. 즉시 응답하는 가짜 MCP를
// 두고 3초 안에 끝나야 한다.
describe("M9-1-exit 카탈로그 타이머 정리", () => {
  it("가짜 MCP 카탈로그 수집 후 CLI가 3초 안에 끝난다", async () => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9exit-cat-"));
    const root = mkdtempSync(join(tmpdir(), "pf-m9exit-catroot-"));
    const serverMjs = resolve(__dirname, "fixtures", "fake-ppt-mcp", "server.mjs");
    writeFileSync(
      join(root, "opencode.json"),
      JSON.stringify({ mcp: { "fake-cat": { type: "local", command: ["node", serverMjs] } } }),
    );
    const env = harnessedSpawnEnv({
      ...bothNames("DIR", pfdir),
      ...bothNames("PROJECT_ROOT", root),
    });
    const started = Date.now();
    const r = await runChild(
      [join(DIST, "cli.js"), "test", "123e4567-e89b-42d3-a456-426614174000", "--mode", "replay"],
      env as NodeJS.ProcessEnv,
      30000,
    );
    expect(r.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 30000);
});
