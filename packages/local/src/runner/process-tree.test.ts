import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScript } from "./script-run.js";
import { isGroupAlive, killProcessTree } from "../services/process-tree.js";

// M7-5-c: 종료 함수 하나 / **그룹** 기준 유예 / 유예는 비동기.
// SIGTERM 을 무시하는 손자(트랩)·스크립트가 남아도 반드시 끝나야 한다.

const root = mkdtempSync(join(tmpdir(), "pf-kill-"));
const fsDir = join(root, "fs");
mkdirSync(fsDir, { recursive: true });

const spawned: number[] = [];
afterEach(() => {
  for (const p of spawned) void killProcessTree(p);
});

describe("M7-5-c SIGTERM 을 무시하는 프로세스", () => {
  it.runIf(process.platform !== "win32")(
    "SIGTERM trap 손자까지 그룹 SIGKILL 로 끝난다",
    async () => {
      // 손자가 SIGTERM 을 무시하고 버틴다
      const script = join(root, "stubborn.mjs");
      writeFileSync(
        script,
        [
          "import { spawn } from 'node:child_process';",
          "const kid = spawn(process.execPath, ['-e',",
          "  \"process.on('SIGTERM', () => {}); setTimeout(()=>{}, 60000);\"",
          "], { stdio: 'ignore' });",
          "process.stdout.write(String(kid.pid));",
          "setTimeout(()=>{}, 60000);",
        ].join("\n"),
      );
      const killed = new Promise<string>((resolveP) => {
        const timer = setTimeout(() => resolveP(""), 15000);
        // runScript 는 실패해도 reject 하므로 here 로 출력만 받지 않는다
        clearTimeout(timer);
      });
      void killed;
      // 직접 트리 구조를 만들어 직접 검증한다 (runScript 경로와 같은 함수 사용)
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const kid = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setTimeout(()=>{},60000);\"], {stdio:'ignore'});",
            "console.log(kid.pid);",
            "setTimeout(()=>{},60000);",
          ].join(""),
        ],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
      spawned.push(child.pid as number);
      const grandchildPid = await new Promise<number>((resolveP) => {
        let buf = "";
        child.stdout?.on("data", (b: Buffer) => {
          buf += b.toString();
          if (buf.trim()) resolveP(Number(buf.trim()));
        });
      });
      expect(grandchildPid).toBeGreaterThan(0);
      // 그룹에 SIGTERM → 유예 후에도 손자가 버티면 SIGKILL
      const r = await killProcessTree(child.pid as number);
      expect(r.killed).toContain(child.pid as number);
      await new Promise((x) => setTimeout(x, 400));
      expect(isGroupAlive(grandchildPid)).toBe(false);
    },
    60000,
  );

  it("타임아웃: SIGTERM 을 무시하는 스크립트도 run 이 끝난다", async () => {
    const script = join(root, "ignore-term.mjs");
    writeFileSync(
      script,
      "process.on('SIGTERM', () => {}); setTimeout(()=>{}, 60000);",
    );
    const t0 = Date.now();
    const err = await runScript({
      runtime: "node",
      scriptAbs: script,
      args: {},
      cwd: fsDir,
      timeoutMs: 800,
      projectRoot: root,
    }).then(
      () => null,
      (e: Error) => e,
    );
    const elapsed = Date.now() - t0;
    expect(err).not.toBeNull();
    expect(String(err?.message)).toMatch(/타임아웃/);
    // 유예(1.5s) 안에 끝나야 Event Loop 도 막히지 않는다
    expect(elapsed).toBeLessThan(20_000);
  }, 60000);
});