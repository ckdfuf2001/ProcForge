import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runScript } from "../src/runner/script-run.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M9-3-epipe: stdin을 읽지 않고 바로 끝나는 스크립트에 1MB 인자를 넘긴다.
// pipe 버퍼를 넘는 크기라 EPIPE가 거의 확실하게 난다.
// 단언: 처리되지 않은 오류 0건, 결과는 기존 판정대로(비JSON 출력 거부).
// 5회 반복 (경합 재현).

let root: string;

beforeEach(() => {
  root = makeTmp("pf-m93ep-");
  mkdirSync(root, { recursive: true });
});

describe("M9-3-epipe stdin EPIPE 무시", () => {
  it("바로 끝나는 스크립트에 1MB 인자 ×5회", async () => {
    const scriptAbs = join(root, "bye.js");
    writeFileSync(scriptAbs, "process.exit(0);\n", "utf8");
    const big = "x".repeat(1024 * 1024);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on("uncaughtException", onUncaught);
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          runScript({ runtime: "node", scriptAbs, args: { blob: big }, cwd: root }),
        ).rejects.toThrow();
      }
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
    expect(uncaught).toHaveLength(0);
  }, 120000);
});
