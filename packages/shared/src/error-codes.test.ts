import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODE_LIST } from "../src/errors.js";

// 저장소에서 던지는 code는 전부 ERROR_CODE_LIST에 있어야 한다 (M4.2-0.5-4).
// 범위: packages/*/src/**/*.ts (테스트 제외).
// throw문 근처 400자에서 code를 찾는다. 반환용 코드(validator 10종 등)는 대상 아님.
// pfError()/err() 호출은 ErrorCode 타입이 컴파일 타임에 보장하므로 throw 패턴으로 충분.

const PACKAGES = ["shared", "core", "local"];
const CODE_RE = /(?:pfError|err)\(\s*["']([^"']+)["']|code:\s*["']([^"']+)["']/;

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
          if (m && !(ERROR_CODE_LIST as readonly string[]).includes(m[1] ?? m[2])) {
            bad.push(`${f}: ${m[1] ?? m[2]}`);
          }
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(throws).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
