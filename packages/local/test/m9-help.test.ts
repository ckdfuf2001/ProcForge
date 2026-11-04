import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// M9-1-2: --help/-h/--version + 모르는 옵션 처리.
// 자식 실행은 반드시 비동기 spawn (m9-exit 규칙: spawnSync는 워커 루프 교착).

const CLI = resolve(__dirname, "..", "dist", "cli.js");

function runChild(args: string[], ms: number): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, {
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

describe("M9-1-2 --help/--version", () => {
  it("--help: exit 0, stdout에 usage, stderr 비어 있음", async () => {
    const r = await runChild([CLI, "--help"], 15000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("usage:");
    expect(r.stderr).toBe("");
  }, 30000);

  it("-h 출력이 --help와 바이트 단위로 같다", async () => {
    const a = await runChild([CLI, "--help"], 15000);
    const b = await runChild([CLI, "-h"], 15000);
    expect(a.timedOut).toBe(false);
    expect(b.timedOut).toBe(false);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe("");
  }, 30000);

  it("--version: exit 0, package.json 버전과 일치, stderr 비어 있음", async () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    const r = await runChild([CLI, "--version"], 15000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
    expect(r.stderr).toBe("");
  }, 30000);

  it("모르는 옵션: exit 2, stdout 비어 있음, stderr 한 줄, 스택 없음", async () => {
    const r = await runChild([CLI, "--nope-xyz-unknown"], 15000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).not.toContain("node:internal");
  }, 30000);
});
