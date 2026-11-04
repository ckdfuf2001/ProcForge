import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

// M9-1-2: 새 bin `proof`(dist/cli.js) + 옛 bin 별칭 `procforge`(dist/cli-legacy.js).
// legacy는 stderr 경고 1회 후 같은 본체 main()을 호출하므로 stdout은 바이트 단위로 같다.
// procforge-local(MCP stdio)에는 경고를 넣지 않는다 (stdout이 JSON-RPC 채널).
// 자식 실행은 반드시 비동기 spawn (m9-exit 규칙).

const DIST = resolve(__dirname, "..", "dist");
const CLI = join(DIST, "cli.js");
const LEGACY = join(DIST, "cli-legacy.js");
const WARNING = "warning: 'procforge' 명령은 옛 이름이다.";

// 모듈 평가 시점에 링크를 만든다 (skipIf는 수집 시점에 값이 확정되어야 한다).
let LINK: string | undefined;
try {
  const dir = mkdtempSync(join(tmpdir(), "pf-binlink-"));
  LINK = join(dir, "proof");
  symlinkSync(CLI, LINK);
} catch {
  LINK = undefined;
}

function runChild(file: string, args: string[], ms: number): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: process.env,
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

describe("M9-1-2 bin 별칭", () => {
  it("package.json bin 맵: proof=cli.js, procforge=cli-legacy.js, procforge-local 유지", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { bin: Record<string, string> };
    expect(pkg.bin["proof"]).toBe("./dist/cli.js");
    expect(pkg.bin["procforge"]).toBe("./dist/cli-legacy.js");
    expect(pkg.bin["procforge-local"]).toBe("./dist/main.js");
  });

  it("--help: legacy stdout이 proof와 바이트 단위로 같고 stderr 경고 1회", async () => {
    const [a, b] = await Promise.all([
      runChild(CLI, ["--help"], 15000),
      runChild(LEGACY, ["--help"], 15000),
    ]);
    expect(a.timedOut).toBe(false);
    expect(b.timedOut).toBe(false);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stderr).toBe("");
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr.trim().split("\n")).toHaveLength(1);
    expect(b.stderr).toContain(WARNING);
  }, 30000);

  it("--version: legacy stdout이 proof와 바이트 단위로 같고 stderr 경고 1회", async () => {
    const [a, b] = await Promise.all([
      runChild(CLI, ["--version"], 15000),
      runChild(LEGACY, ["--version"], 15000),
    ]);
    expect(a.timedOut).toBe(false);
    expect(b.timedOut).toBe(false);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stderr).toBe("");
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr.trim().split("\n")).toHaveLength(1);
    expect(b.stderr).toContain(WARNING);
  }, 30000);

  it("procforge-local 진입(dist/main.js)에 경고 문구가 없다", () => {
    const mainJs = readFileSync(join(DIST, "main.js"), "utf8");
    expect(mainJs).not.toContain(WARNING);
  });

  // M9-1-2-fix: Unix 전역 설치(npm -g/npx)는 bin 심볼릭 링크로 깔린다.
  // 링크 경로로 실행해도 main이 동작해야 한다 (argv 경로 판단 방식의 결함 회귀 방지).
  // Windows는 링크 생성 권한이 없으면 건너뛴다 (ubuntu CI에서 실행됨).
  it.skipIf(!LINK)("심볼릭 링크 이름(proof)으로 --version 실행: exit 0, stdout 비어 있지 않음", async () => {
    const r = await runChild(LINK as string, ["--version"], 15000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe("");
  }, 30000);
});
