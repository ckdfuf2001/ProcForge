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
      // 부모가 손자를 띄우고 버티는 구조 (runScript 와 같은 killProcessTree 을 쓴다)
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
    // 800ms 타임아웃 + 1.5s 유예 = 3초 남짓. 이보다 길면 이벤트 루프가 막힌 것이다.
    expect(elapsed).toBeLessThan(5000);
  }, 60000);
});