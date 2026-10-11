import { spawnSync, execSync } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// L3 묶음 검증 (DEV-GUIDE 0.2).
// 순서: clean 확인 → dist 삭제 → 빌드 → 전체 테스트 양 모드 → 클린 클론 → 푸시.
// - 자식 환경: NODE_ENV 해제, NODE_OPTIONS에 --dns-result-order=ipv4first.
// - 재시도는 git push/clone만 3회(백오프). 테스트 재시도 금지.
// - 외부 네트워크를 쓰는 테스트는 정책 실패로 간주한다 (스위트는 hermetic 유지).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_ENV;
  const prev = env.NODE_OPTIONS ?? "";
  env.NODE_OPTIONS = `${prev} --dns-result-order=ipv4first`.trim();
  return env;
}

function run(bin, args, opts = {}) {
  // pnpm은 Windows에서 .CMD shim이라 shell 필요.
  const r = spawnSync(bin, args, {
    cwd: ROOT,
    env: baseEnv(opts.env),
    stdio: "inherit",
    shell: true,
    ...opts.spawn,
  });
  if (r.status !== 0) {
    throw new Error(`명령 실패(${r.status}): ${bin} ${args.join(" ")}`);
  }
}

function out(bin, args, opts = {}) {
  return execSync([bin, ...args].join(" "), {
    cwd: ROOT,
    env: baseEnv(opts.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function retry(label, fn, attempts = 3) {
  let wait = 5000;
  for (let i = 1; i <= attempts; i++) {
    try {
      fn();
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.error(`[dev-verify] ${label} 실패 (${i}/${attempts}), ${wait / 1000}s 후 재시도`);
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

const step = (n, msg) => console.log(`\n[dev-verify ${n}] ${msg}`);

async function main() {
  step(1, "작업 트리 clean 확인");
  if (out("git", ["status", "--porcelain"]) !== "") {
    throw new Error("커밋되지 않은 변경이 있다 (git status --porcelain 비어 있어야 함)");
  }
  const head = out("git", ["rev-parse", "HEAD"]);
  console.log(`HEAD=${head}`);

  step(2, "dist 삭제 + 클린 빌드 + check:env");
  for (const p of ["shared", "core", "local"]) {
    rmSync(join(ROOT, "packages", p, "dist"), { recursive: true, force: true });
  }
  run("pnpm", ["-r", "run", "build"]);
  run("pnpm", ["check:env"]);

  step(3, "전체 테스트 양 모드 (재시도 없음)");
  const testArgs = ["-r", "run", "test", "--", "--run", "--testTimeout=20000", "--hookTimeout=20000"];
  run("pnpm", testArgs, { env: {} });
  run("pnpm", testArgs, { env: { PROCFORGE_CLIENT: "loopback" } });

  step(4, "클린 클론 (NODE_ENV 미설정)");
  const remote = out("git", ["config", "--get", "remote.origin.url"]);
  const dir = mkdtempSync(join(tmpdir(), "pf-verify-"));
  await retry("git clone", () => {
    execSync(`git clone ${remote} "${dir}"`, { cwd: tmpdir(), env: baseEnv(), stdio: "inherit" });
  });
  const cenv = baseEnv();
  const crun = (bin, args) => {
    const r = spawnSync(bin, args, { cwd: dir, env: cenv, stdio: "inherit", shell: true });
    if (r.status !== 0) throw new Error(`클린 클론 실패(${r.status}): ${bin} ${args.join(" ")}`);
  };
  crun("pnpm", ["install", "--frozen-lockfile"]);
  crun("pnpm", ["-r", "run", "build"]);
  crun("pnpm", ["-r", "run", "test", "--", "--run", "--testTimeout=20000", "--hookTimeout=20000"]);

  step(5, "푸시 (재시도 3회)");
  await retry("git push", () => {
    execSync("git push origin master", { cwd: ROOT, env: baseEnv(), stdio: "inherit" });
  });

  console.log(`\n[dev-verify] L3 로컬 green. HEAD=${head} 푸시됨.`);
  console.log("[dev-verify] API로 head_sha 일치 CI success 확인 후 묶음 완료 선언.");
}

main().catch((e) => {
  console.error(`[dev-verify] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
