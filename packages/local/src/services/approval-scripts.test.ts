import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSandboxed, SCRIPT_READ_MAX_BYTES } from "./approval-scripts.js";

// M7-5-d: 이전 공회전 테스트를 **직접 함수** 단위로 교체.
// "../"·심링크 탈출·NUL·5MB+1 이 **진짜로** 오류 코드를 내는지 assert 한다.
// (이전 테스트는 이미 확정된 노드에 confirmLeaf 를 다시 걸어 인자가 안 바뀌었고,
//  5MB 테스트는 인자를 받지 않는 헬퍼를 인자로 불러 big.py 를 읽지도 않았다)

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-sandbox-"));
  mkdirSync(join(root, "inner"), { recursive: true });
  writeFileSync(join(root, "inner", "ok.py"), "print(1)\n", "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 에러 코드를 뽑는다 (pfError 는 code 를 가진다) */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("M7-5-d readSandboxed 경계", () => {
  it("정상 경로는 읽힌다", () => {
    expect(readSandboxed(root, "inner/ok.py")).toContain("print(1)");
  });

  it("../ 탈출 → bad_request", () => {
    // root/ 바깥(형제 디렉터리)에 있는 비밀 파일 — "../" 로 접근하면 나가야 한다
    const base = mkdtempSync(join(tmpdir(), "pf-escape-"));
    const inside = join(base, "inside");
    mkdirSync(join(inside, "inner"), { recursive: true });
    writeFileSync(join(base, "secret.txt"), "secret\n", "utf8");
    expect(codeOf(() => readSandboxed(inside, "../secret.txt"))).toBe("bad_request");
    // 파일이 없어도 탈출 경로는 bad_request (not_found 로 새지 않는다)
    expect(codeOf(() => readSandboxed(inside, "../../nope.txt"))).toBe("bad_request");
    // sandbox 안에 머무는 "../" 는 허용 (정규화 결과가 안이면 통과)
    writeFileSync(join(inside, "ok.py"), "print(1)\n", "utf8");
    expect(readSandboxed(inside, "inner/../ok.py")).toContain("print(1)");
    rmSync(base, { recursive: true, force: true });
  });

  it("루트 밖 절대 경로 → bad_request", () => {
    const outside = mkdtempSync(join(tmpdir(), "pf-outside-"));
    writeFileSync(join(outside, "s.txt"), "secret\n", "utf8");
    const code = codeOf(() => readSandboxed(root, join(outside, "s.txt")));
    expect(code).toBe("bad_request");
    rmSync(outside, { recursive: true, force: true });
  });

  it("심링크로 sandbox 밖 탈출 → bad_request", () => {
    const outside = mkdtempSync(join(tmpdir(), "pf-outside-"));
    writeFileSync(join(outside, "s.txt"), "secret\n", "utf8");
    const link = join(root, "inner", "escape.txt");
    let linked = false;
    try {
      symlinkSync(join(outside, "s.txt"), link);
      linked = true;
    } catch {
      // Windows 는 개발자 모드/관리자 없이 심링크를 못 만든다 → 건너뛴다
    }
    if (linked) {
      expect(codeOf(() => readSandboxed(root, "inner/escape.txt"))).toBe("bad_request");
    }
    rmSync(outside, { recursive: true, force: true });
  });

  it("NUL 바이트 → bad_request", () => {
    expect(codeOf(() => readSandboxed(root, "inner/o\0k.py"))).toBe("bad_request");
  });

  it("5MB+1 바이트 → bad_request", () => {
    writeFileSync(join(root, "inner", "big.py"), "x".repeat(SCRIPT_READ_MAX_BYTES + 1), "utf8");
    const code = codeOf(() => readSandboxed(root, "inner/big.py"));
    expect(code).toBe("bad_request");
  });

  it("정확히 5MB 는 읽힌다 (경계값)", () => {
    writeFileSync(join(root, "inner", "exact.py"), "x".repeat(SCRIPT_READ_MAX_BYTES), "utf8");
    expect(readSandboxed(root, "inner/exact.py").length).toBe(SCRIPT_READ_MAX_BYTES);
  });

  it("없는 파일 → not_found", () => {
    expect(codeOf(() => readSandboxed(root, "inner/nope.py"))).toBe("not_found");
  });
});