import { spawnSync, execSync } from "node:child_process";
import { rmSync, mkdtempSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// L3 묶음 검증 (DEV-GUIDE 0.2).
// 순서: clean 확인 → dist 삭제 → 빌드 → 전체 테스트 양 모드 → 클린 클론 → 푸시.
// - 자식 환경: NODE_ENV 해제, NODE_OPTIONS에 --dns-result-order=ipv4first.
// - 재시도는 git push/clone만 3회(백오프). 테스트 재시도 금지.
// - 외부 네트워크를 쓰는 테스트는 정책 실패로 간주한다 (스위트는 hermetic 유지).
// - M5.8.1-5: 단계별 로그 분리(.verify/<단계>.log, *.log라 ignore됨) +
//   --from <n> 재개 (끊긴 단계부터 이어서. 앞 단계 산출물(dist 등)이 있어야 함).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = join(ROOT, ".verify");

const STEPS = ["1-clean", "2-build", "3-test", "4-clone", "5-push"];

function usage() {
  console.log("usage: node scripts/dev-verify.mjs [--from 1|2|3|4|5]");
  console.log("  단계별 로그: .verify/<단계>.log (끊기면 꼬리 30줄 출력)");
}

function parseFrom(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }
  const i = argv.indexOf("--from");
  if (i === -1) return 1;
  const n = Number(argv[i + 1]);
  if (![1, 2, 3, 4, 5].includes(n)) throw new Error(`--from 은 1~5 (받은 값: ${argv[i + 1] ?? "없음"})`);
  return n;
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_ENV;
  const prev = env.NODE_OPTIONS ?? "";
  env.NODE_OPTIONS = `${prev} --dns-result-order=ipv4first`.trim();
  return env;
}

function logPath(stepName) {
  mkdirSync(LOGDIR, { recursive: true });
  return join(LOGDIR, `${stepName}.log`);
}

function run(bin, args, opts = {}) {
  // pnpm은 Windows에서 .CMD shim이라 shell 필요.
  const r = spawnSync(bin, args, {
    cwd: opts.cwd ?? ROOT,
    env: baseEnv(opts.env),
    stdio: opts.log ? "pipe" : "inherit",
    shell: true,
  });
  if (opts.log) {
    appendFileSync(opts.log, `$ ${bin} ${args.join(" ")}\n`);
    if (r.stdout && r.stdout.length > 0) appendFileSync(opts.log, r.stdout);
    if (r.stderr && r.stderr.length > 0) appendFileSync(opts.log, r.stderr);
  }
  if (r.status !== 0) {
    if (opts.log) {
      try {
        const tail = readFileSync(opts.log, "utf8").split("\n").slice(-30).join("\n");
        console.error(`--- ${opts.log} 꼬리 ---\n${tail}`);
      } catch {
        // 로그 읽기 실패 무시
      }
    }
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
  const from = parseFrom(process.argv.slice(2));
  if (from > 1) console.log(`[dev-verify] --from ${from}: 앞 단계 생략 (산출물 재사용)`);
  step(1, "작업 트리 clean 확인");
  if (out("git", ["status", "--porcelain"]) !== "") {
    throw new Error("커밋되지 않은 변경이 있다 (git status --porcelain 비어 있어야 함)");
  }
  const head = out("git", ["rev-parse", "HEAD"]);
  console.log(`HEAD=${head}`);

  if (from <= 2) {
    step(2, "dist 삭제 + 클린 빌드 + check:env");
    const log = logPath("2-build");
    for (const p of ["shared", "core", "local"]) {
      rmSync(join(ROOT, "packages", p, "dist"), { recursive: true, force: true });
    }
    run("pnpm", ["-r", "run", "build"], { log });
    run("pnpm", ["check:env"], { log });
  } else {
    step(2, "생략 (--from)");
  }

  if (from <= 3) {
    step(3, "전체 테스트 양 모드 (재시도 없음)");
    const log = logPath("3-test");
    const testArgs = ["-r", "run", "test", "--", "--run", "--testTimeout=20000", "--hookTimeout=20000"];
    run("pnpm", testArgs, { env: {}, log });
    run("pnpm", testArgs, { env: { PROCFORGE_CLIENT: "loopback" }, log });
  } else {
    step(3, "생략 (--from)");
  }

  if (from <= 4) {
    step(4, "클린 클론 (NODE_ENV 미설정)");
    const log = logPath("4-clone");
    const remote = out("git", ["config", "--get", "remote.origin.url"]);
    const dir = mkdtempSync(join(tmpdir(), "pf-verify-"));
    await retry("git clone", () => {
      execSync(`git clone ${remote} "${dir}"`, { cwd: tmpdir(), env: baseEnv(), stdio: "inherit" });
    });
    const cenv = baseEnv();
    const crun = (bin, args) => {
      const r = spawnSync(bin, args, { cwd: dir, env: cenv, stdio: "pipe", shell: true });
      appendFileSync(log, `$ ${bin} ${args.join(" ")}\n`);
      if (r.stdout && r.stdout.length > 0) appendFileSync(log, r.stdout);
      if (r.stderr && r.stderr.length > 0) appendFileSync(log, r.stderr);
      if (r.status !== 0) throw new Error(`클린 클론 실패(${r.status}): ${bin} ${args.join(" ")}`);
    };
    crun("pnpm", ["install", "--frozen-lockfile"]);
    crun("pnpm", ["-r", "run", "build"]);
    crun("pnpm", ["-r", "run", "test", "--", "--run", "--testTimeout=20000", "--hookTimeout=20000"]);
  } else {
    step(4, "생략 (--from)");
  }

  if (from <= 5) {
    step(5, "푸시 (재시도 3회)");
    const log = logPath("5-push");
    await retry("git push", () => {
      const r = spawnSync("git push origin master", { cwd: ROOT, env: baseEnv(), stdio: "pipe", shell: true });
      appendFileSync(log, "$ git push origin master\n");
      if (r.stdout && r.stdout.length > 0) appendFileSync(log, r.stdout);
      if (r.stderr && r.stderr.length > 0) appendFileSync(log, r.stderr);
      if (r.status !== 0) throw new Error(`git push 실패(${r.status})`);
    });
  } else {
    step(5, "생략 (--from)");
  }

  console.log(`\n[dev-verify] L3 로컬 green. HEAD=${head} 푸시됨.`);
  console.log("[dev-verify] API로 head_sha 일치 CI success 확인 후 묶음 완료 선언.");
}

main().catch((e) => {
  console.error(`[dev-verify] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
