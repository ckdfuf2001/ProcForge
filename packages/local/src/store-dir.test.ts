import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStoreDir, detectDuplicateStores } from "./store-dir.js";
import { createApp } from "./app/bootstrap.js";

// M7-1-6: 저장소 위치 단일화.

describe("store-dir", () => {
  it("우선순위: flag > PROCFORGE_HOME > PROCFORGE_DIR > 기본값", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pf-sd-"));
    const home = mkdtempSync(join(tmpdir(), "pf-sdhome-"));
    expect(resolveStoreDir({ cwd })).toBe(join(cwd, ".procforge"));
    expect(
      resolveStoreDir({
        cwd,
        env: { PROCFORGE_DIR: join(home, "custom") } as NodeJS.ProcessEnv,
      }),
    ).toBe(join(home, "custom"));
    expect(
      resolveStoreDir({
        cwd,
        env: {
          PROCFORGE_HOME: home,
          PROCFORGE_DIR: join(home, "custom"),
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(join(home, ".procforge"));
    expect(
      resolveStoreDir({
        flag: join(home, "flag"),
        cwd,
        env: { PROCFORGE_HOME: home } as NodeJS.ProcessEnv,
      }),
    ).toBe(join(home, "flag"));
  });

  it("cwd가 달라도 PROCFORGE_HOME이면 같은 저장소", () => {
    const home = mkdtempSync(join(tmpdir(), "pf-sdhome-"));
    const a = mkdtempSync(join(tmpdir(), "pf-sda-"));
    const b = mkdtempSync(join(tmpdir(), "pf-sdb-"));
    const env = { PROCFORGE_HOME: home } as NodeJS.ProcessEnv;
    expect(resolveStoreDir({ cwd: a, env })).toBe(
      resolveStoreDir({ cwd: b, env }),
    );
    expect(resolveStoreDir({ cwd: a, env })).toBe(join(home, ".procforge"));
  });

  it("기본값이면 경고 없음, 다른 곳 + 기본값에 세션 있으면 경고", () => {
    const root = mkdtempSync(join(tmpdir(), "pf-sdroot-"));
    const other = mkdtempSync(join(tmpdir(), "pf-sdother-"));
    expect(detectDuplicateStores(root, join(root, ".procforge"))).toBeNull();
    expect(detectDuplicateStores(root, other)).toBeNull();
    mkdirSync(join(root, ".procforge", "sessions", "s1"), { recursive: true });
    const w = detectDuplicateStores(root, other);
    expect(w).toMatch(/저장소가 2곳/);
    expect(w).toContain(other);
  });

  it("pf_start 응답에 실제 저장소 경로", async () => {
    const root = mkdtempSync(join(tmpdir(), "pf-sdapp-"));
    const pfdir = join(root, ".procforge");
    const { app } = createApp({ procforgeDir: pfdir, projectRoot: root });
    const out = await app.start({ request: "r", toolCatalog: [] });
    expect(out.storeDir).toBe(pfdir);
  }, 30000);
});
