import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODE_LIST } from "../src/errors.js";

// 저장소에서 던지는 code는 전부 ERROR_CODE_LIST에 있어야 한다 (M4.2-0.5-4).
// 범위: packages/*/src/**/*.ts (테스트 제외).
// throw문 근처 400자에서 code를 찾는다. 반환용 코드(validator 10종 등)는 대상 아님.
// pfError()/err() 호출은 ErrorCode 타입이 컴파일 타임에 보장하므로 throw 패턴으로 충분.

const PACKAGES = ["shared", "core", "local", "core-server"];
const CODE_RE = /(?:pfError|err)\(\s*["']([^"']+)["']|code:\s*["']([^"']+)["']/;

// M9-1-2-fix: 내부 마커 허용 목록 (파일명 → 코드 집합).
// 가드를 우회하지 않고 여기에 파일·사유를 명시한다.
// - UNKNOWN_OPTION (cli-args.ts): CLI 인자 파싱 실패 마커. cli-main.ts에서
//   exit 2로만 쓰고 외부(wire·JSON)로 나가지 않으므로 ERROR_CODE_LIST에 등록하지 않는다.
const ALLOWED_INTERNAL = new Map<string, Set<string>>([
  ["cli-args.ts", new Set(["UNKNOWN_OPTION"])],
]);

function isAllowed(file: string, code: string): boolean {
  const base = file.split(/[/\\]/).pop() ?? file;
  return ALLOWED_INTERNAL.get(base)?.has(code) ?? false;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      yield p;
    }
  }
}

describe("error codes", () => {
  it("M4.2-0.5-4 던지는 code 전부 등록됨", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const bad: string[] = [];
    let files = 0;
    let throws = 0;
    for (const pkg of PACKAGES) {
      const root = join(repo, "packages", pkg, "src");
      if (!existsSync(root)) continue;
      for (const f of walk(root)) {
        files++;
        const src = readFileSync(f, "utf8");
        let idx = 0;
        for (;;) {
          const t = src.indexOf("throw", idx);
          if (t === -1) break;
          idx = t + 5;
          // 식별자 일부(throws/throwable) 제외
          if (/[A-Za-z0-9_$]/.test(src[t + 5] ?? "")) continue;
          throws++;
        const m = CODE_RE.exec(src.slice(t, t + 400));
        const code = m?.[1] ?? m?.[2];
        if (code && !(ERROR_CODE_LIST as readonly string[]).includes(code) && !isAllowed(f, code)) {
          bad.push(`${f}: ${code}`);
        }
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(throws).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
