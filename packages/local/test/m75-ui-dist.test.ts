import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// M7-5-3: **빌드 산출물** 기준 CSP 검증 (정적 검사).
// 브라우저 실측은 Playwright(6번)에서 한다 — 여기는 dist 에 인라인이 없는지만 본다.

const here = fileURLToPath(new URL(".", import.meta.url));
const uiDist = resolve(here, "..", "..", "ui", "dist");
const hasDist = existsSync(join(uiDist, "index.html"));

describe.skipIf(!hasDist)("M7-5-3 dist 인라인 없음", () => {
  const html = readFileSync(join(uiDist, "index.html"), "utf8");

  it("HTML 에 인라인 style 속성이 없다", () => {
    expect(html).not.toMatch(/\sstyle="/i);
  });

  it("HTML 에 인라인 <script> 가 없다 (src 없는 것)", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    for (const attrs of scripts) {
      expect(attrs).toMatch(/\bsrc=/i);
      expect(attrs).not.toMatch(/nonce/i); // nonce 는 서버가 meta 로만 넣는다
    }
  });

  it("dist 전체에 'unsafe-inline' 문자열이 없다", () => {
    const files = [
      join(uiDist, "index.html"),
      ...readdirSync(join(uiDist, "assets")).map((f) => join(uiDist, "assets", f)),
    ];
    for (const f of files) {
      expect(readFileSync(f, "utf8")).not.toContain("unsafe-inline");
    }
  });

  it("CM6 는 external 파일로만 로드된다 (인라인 주입 없음)", () => {
    expect(html).toMatch(/<script type="module"[^>]+src="\/assets\//i);
  });
});