import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { makeTmp, cleanRegisteredTmp, cleanRegisteredTmpUntil } from "../src/tmp.js";

// M14-1: registry 유지 회귀 (rm 실패 dir은 다음 호출이 다시 시도한다).
// shared는 모드 없음 (testStack 미사용) — 1줄 보고.

describe("tmp registry 유지", () => {
  afterAll(() => {
    cleanRegisteredTmp();
  });

  it("① 1회 실패 후 다음 호출에서 같은 dir을 다시 시도하고 폴더가 사라짐", () => {
    const dir = makeTmp("pf-reg-");
    expect(existsSync(dir)).toBe(true);
    let calls = 0;
    const flaky = (d: string): void => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      rmSync(d, { recursive: true, force: true });
    };
    const f1 = cleanRegisteredTmp(flaky);
    expect(f1).toContain(dir);
    expect(existsSync(dir)).toBe(true);
    const f2 = cleanRegisteredTmp();
    expect(f2).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    console.log(`M14-1-reg-① dir=${dir} retry-cleaned`);
  });

  it("② 성공한 dir은 다음 호출에서 다시 시도하지 않음", () => {
    const dir = makeTmp("pf-reg-");
    let calls = 0;
    const counting = (d: string): void => {
      calls += 1;
      rmSync(d, { recursive: true, force: true });
    };
    expect(cleanRegisteredTmp(counting)).toEqual([]);
    expect(calls).toBe(1);
    expect(cleanRegisteredTmp(counting)).toEqual([]);
    expect(calls).toBe(1);
    expect(existsSync(dir)).toBe(false);
    console.log(`M14-1-reg-② calls=${calls}`);
  });

  it("③ KEEP이면 삭제하지 않고 registry에서 제거됨", () => {
    process.env.PROOF_KEEP_TMP = "1";
    try {
      const dir = makeTmp("pf-reg-");
      let calls = 0;
      const counting = (): void => {
        calls += 1;
      };
      expect(cleanRegisteredTmp(counting)).toEqual([]);
      expect(calls).toBe(0);
      expect(existsSync(dir)).toBe(true);
      // registry에서 제거됐으므로 KEEP 해제 후 호출도 건드리지 않음
      delete process.env.PROOF_KEEP_TMP;
      expect(cleanRegisteredTmp(counting)).toEqual([]);
      expect(calls).toBe(0);
      // 직접 치운다 (증거로 남기지 않음)
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
      console.log(`M14-1-reg-③ kept-then-removed`);
    } finally {
      delete process.env.PROOF_KEEP_TMP;
    }
  });

  it("④ 실패 stderr에 code=가 들어 있음", () => {
    const dir = makeTmp("pf-reg-");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      const boom = (): void => {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      };
      cleanRegisteredTmp(boom);
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes("code=EPERM"))).toBe(true);
    // 잔재 직접 정리
    rmSync(dir, { recursive: true, force: true });
    console.log(`M14-1-reg-④ stderr-code-ok`);
  });

  it("⑤ 항상 실패하면 마감 안에 돌아오고 남은 dir을 반환함", async () => {
    const dir = makeTmp("pf-reg-");
    const t0 = Date.now();
    const remain = await cleanRegisteredTmpUntil(2000, 100, () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    });
    const elapsed = Date.now() - t0;
    expect(remain).toContain(dir);
    expect(elapsed).toBeLessThanOrEqual(3000);
    // 잔재 직접 정리 (레지스트리 항목은 afterAll 정리에서 제거됨)
    rmSync(dir, { recursive: true, force: true });
    console.log(`M14-1-reg-⑤ elapsed=${elapsed} remain=1`);
  }, 15000);
});
