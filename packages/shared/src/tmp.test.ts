import { describe, it, expect, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { makeTmp, cleanRegisteredTmp } from "./tmp.js";

// M9-tmp-fix: useTmpCleanup 3줄 (vitest는 테스트 파일에서만 import).
function useTmpCleanup(): void {
  afterAll(() => {
    cleanRegisteredTmp();
  });
}

// M9-tmp: 헬퍼 단위 테스트 (생성→정리 후 없음, KEEP이면 남음).

describe("tmp helper", () => {
  useTmpCleanup(); // 안전망 (명시적 정리 후에는 no-op)

  it("생성→정리 후 폴더가 없다", () => {
    const dir = makeTmp("pf-tmp-test-");
    expect(existsSync(dir)).toBe(true);
    const failed = cleanRegisteredTmp();
    expect(failed).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("PROOF_KEEP_TMP=1이면 남긴다", () => {
    process.env.PROOF_KEEP_TMP = "1";
    try {
      const dir = makeTmp("pf-tmp-test-");
      cleanRegisteredTmp();
      expect(existsSync(dir)).toBe(true);
      // 직접 치운다 (증거로 남기지 않음)
      delete process.env.PROOF_KEEP_TMP;
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    } finally {
      delete process.env.PROOF_KEEP_TMP;
    }
  });
});
