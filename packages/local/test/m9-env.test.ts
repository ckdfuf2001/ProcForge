import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveStoreDir } from "../src/app/store-dir.js";
import {
  readEnvPair,
  resetEnvCompatWarnings,
  harnessedSpawnEnv,
  bothNames,
} from "@proof/shared/env-compat.js";
import { isDefaultTenantAllowed } from "../../core-server/dist/server.js";

// M9-1-1-d: §2.3 신규 테스트 전부 (기존 파괴 기대 0).

const DIST = resolve(__dirname, "..", "dist");

/** process.stderr.write 가로채기 (경고 단언용, finally 복원). */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = (
    ...args: unknown[]
  ) => {
    lines.push(String(args[0]));
    return true;
  };
  return { lines, restore: () => void (process.stderr.write = orig) };
}

beforeEach(() => resetEnvCompatWarnings());

describe("M9-1-1 env 호환 (통합)", () => {
  it("PROOF_*만 설정 → 신 값, 경고 없음", () => {
    const cap = captureStderr();
    try {
      const dir = mkdtempSync(join(tmpdir(), "pf-m9-proof-"));
      const got = resolveStoreDir({
        cwd: tmpdir(),
        env: { PROOF_DIR: dir } as NodeJS.ProcessEnv,
      });
      expect(got).toBe(dir);
      expect(cap.lines.join("")).not.toContain("PROOF_DIR");
      expect(cap.lines.join("")).not.toContain("PROCFORGE_DIR");
    } finally {
      cap.restore();
    }
  });

  it("PROCFORGE_*만 설정 → 옛 값 + stderr 경고 1회", () => {
    const cap = captureStderr();
    try {
      const dir = mkdtempSync(join(tmpdir(), "pf-m9-legacy-"));
      const got = resolveStoreDir({
        cwd: tmpdir(),
        env: { PROCFORGE_DIR: dir } as NodeJS.ProcessEnv,
      });
      expect(got).toBe(dir);
      const warnLines = cap.lines.filter((l) => l.includes("PROCFORGE_DIR"));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain("PROOF_DIR");
    } finally {
      cap.restore();
    }
  });

  it("둘 다 다르면 PROOF_* + 충돌 경고에 절대경로", () => {
    const cap = captureStderr();
    try {
      const dir = mkdtempSync(join(tmpdir(), "pf-m9-both-"));
      const got = resolveStoreDir({
        cwd: tmpdir(),
        env: { PROOF_DIR: dir, PROCFORGE_DIR: join(tmpdir(), "other") } as NodeJS.ProcessEnv,
      });
      expect(got).toBe(dir);
      const warnLines = cap.lines.filter((l) => l.includes("대신 PROOF_DIR"));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain(dir);
    } finally {
      cap.restore();
    }
  });

  it("보안 5종 불일치 → 기동 오류 종료 (READ_ONLY, 값 미포함)", () => {
    const root = mkdtempSync(join(tmpdir(), "pf-m9-sec-"));
    const r = spawnSync(
      process.execPath,
      [join(DIST, "main.js"), root],
      {
        env: harnessedSpawnEnv({
          ...bothNames("DIR", root),
          PROOF_READ_ONLY: "1",
          PROCFORGE_READ_ONLY: "0",
        }) as NodeJS.ProcessEnv,
        encoding: "utf8",
      },
    );
    expect(r.status).not.toBe(0);
    const err = String(r.stderr ?? "");
    expect(err).toContain("PROOF_READ_ONLY");
    expect(err).toContain("PROCFORGE_READ_ONLY");
    expect(err).not.toContain("세션 없음");
  });

  it("DEV_AUTH 옛 이름으로 켜짐 → 인증 우회 경고가 이름 변경 경고와 별도", () => {
    const cap = captureStderr();
    try {
      expect(isDefaultTenantAllowed({ PROCFORGE_DEV_AUTH: "1" } as NodeJS.ProcessEnv)).toBe(true);
      const legacy = cap.lines.filter((l) => l.includes("옛 이름"));
      const bypass = cap.lines.filter((l) => l.includes("인증 우회"));
      expect(legacy).toHaveLength(1);
      expect(bypass).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  it("DEV_AUTH 신 이름 → 허용 + 우회 경고 없음", () => {
    const cap = captureStderr();
    try {
      expect(isDefaultTenantAllowed({ PROOF_DEV_AUTH: "1" } as NodeJS.ProcessEnv)).toBe(true);
      expect(cap.lines.join("")).not.toContain("인증 우회");
    } finally {
      cap.restore();
    }
  });

  it("셸 오염: PROOF_DIR=<다른 폴더>여도 그리로 기록 안 됨", async () => {
    const evil = mkdtempSync(join(tmpdir(), "pf-m9-evil-"));
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9-clean-"));
    const old = process.env.PROOF_DIR;
    process.env.PROOF_DIR = evil;
    try {
      const env = harnessedSpawnEnv({
        ...bothNames("DIR", pfdir),
      });
      expect(env.PROOF_DIR).toBe(pfdir);
      expect(env.PROCFORGE_DIR).toBe(pfdir);
      // 자식에서 해결해도 확정값이 나온다 (쉘 오염 제거됨)
      const storeDirJs = pathToFileURL(join(DIST, "app", "store-dir.js")).href;
      const out = await new Promise<string>((resolveP, reject) => {
        const child = spawn(
          process.execPath,
          ["-e", `import(${JSON.stringify(storeDirJs)}).then((m)=>console.log(m.resolveStoreDir({})))`],
          { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        const done = () => {
          if (timer) clearTimeout(timer);
          resolveP(stdout.trim());
        };
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 15000);
        child.on("close", done);
        child.on("error", reject);
      });
      expect(out).toBe(pfdir);
      expect(existsSync(join(evil, "sessions"))).toBe(false);
    } finally {
      if (old === undefined) delete process.env.PROOF_DIR;
      else process.env.PROOF_DIR = old;
    }
  }, 30000);

  it("하네스 env 메커니즘: spawn 자식은 부모 값을 두 이름으로 받는다", async () => {
    // §2.3 메커니즘 테스트 (전 모드 공통, CI matrix가 remote 커버).
    const saved: Record<string, string | undefined> = {};
    for (const k of ["PROOF_DIR", "PROCFORGE_DIR", "PROOF_CORE_URL", "PROCFORGE_CORE_URL", "PROCFORGE_CLIENT", "PROOF_CORE_API_KEY", "PROOF_BOGUS"]) {
      saved[k] = process.env[k];
    }
    process.env.PROOF_DIR = mkdtempSync(join(tmpdir(), "pf-m9-evil-"));
    process.env.PROCFORGE_DIR = mkdtempSync(join(tmpdir(), "pf-m9-old-"));
    process.env.PROOF_CORE_URL = "http://127.0.0.1:9";
    process.env.PROCFORGE_CORE_URL = "http://127.0.0.1:8";
    process.env.PROCFORGE_CLIENT = "remote";
    process.env.PROOF_CORE_API_KEY = "K-m9test-dummy";
    process.env.PROOF_BOGUS = "1";
    try {
      const pfdir = mkdtempSync(join(tmpdir(), "pf-m9-harness-"));
      const env = harnessedSpawnEnv({
        ...bothNames("DIR", pfdir),
        ...bothNames("PROJECT_ROOT", pfdir),
      });
      const out = await new Promise<string>((resolveP, reject) => {
        const child = spawn(
          process.execPath,
          ["-e", "console.log(JSON.stringify({d:process.env.PROOF_DIR,p:process.env.PROCFORGE_DIR,c:process.env.PROOF_CORE_URL,ak:process.env.PROOF_CORE_API_KEY,ak2:process.env.PROCFORGE_CORE_API_KEY,client:process.env.PROCFORGE_CLIENT,bogus:process.env.PROOF_BOGUS}))"],
          { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("자식 응답 없음"));
        }, 15000);
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolveP(stdout.trim());
        });
        child.on("error", reject);
      });
      const got = JSON.parse(out) as Record<string, string | undefined>;
      // 확정값(DIR)은 주입값, 스냅샷값(CORE_URL/CORE_API_KEY)은 proof 값, CLIENT는 유지, 오염 제거
      expect(got.d).toBe(pfdir);
      expect(got.p).toBe(pfdir);
      expect(got.c).toBe("http://127.0.0.1:9");
      expect(got.ak).toBe("K-m9test-dummy");
      expect(got.ak2).toBe("K-m9test-dummy");
      expect(got.client).toBe("remote");
      expect(got.bogus).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30000);

  it("stdio 순수성: stdout JSON-RPC + stderr 경고 1회", async () => {
    const pfdir = mkdtempSync(join(tmpdir(), "pf-m9-stdio-"));
    const root = mkdtempSync(join(tmpdir(), "pf-m9-stdio-root-"));
    // 셸 오염과 무관하게 legacy-only로 고정 (결정적 1회 경고).
    const clean: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("PROOF_") || k.startsWith("PROCFORGE_")) continue;
      clean[k] = v;
    }
    clean.PROCFORGE_DIR = pfdir;
    const child = spawn(process.execPath, [join(DIST, "main.js"), root], {
      env: clean as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "m9test", version: "0" },
          },
        }) + "\n",
      );
      const first = await new Promise<string>((resolveP, reject) => {
        const timer = setTimeout(() => reject(new Error("stdio 응답 없음")), 20000);
        const check = () => {
          const line = stdout.split("\n").find((l) => l.trim().length > 0);
          if (line !== undefined) {
            clearTimeout(timer);
            resolveP(line);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
      const parsed = JSON.parse(first) as { jsonrpc?: string; id?: number };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(1);
      expect(stdout).not.toContain("PROCFORGE_DIR");
      const warnLines = stderr.split("\n").filter((l) => l.includes("PROCFORGE_DIR"));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain("PROOF_DIR");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);
});
