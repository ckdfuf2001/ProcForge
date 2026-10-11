import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 로컬 검증 환경 점검 (M5.3.1-5, 0.2 규칙).
// node_modules에 깔린 @types/node가 lockfile 버전과 같은지 확인.
// 다르면 tsc 결과가 클린 클론/CI와 달라진다 (Dirent 제네릭 사례).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`check:env FAIL: ${msg}`);
  process.exit(1);
}

let lock;
try {
  const { readFileSync } = await import("node:fs");
  lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
} catch {
  fail("pnpm-lock.yaml 없음");
}
const m = lock.match(/@types\/node@(\d+\.\d+\.\d+)/);
if (!m) fail("lockfile에 @types/node 없음");
const want = m[1];

let dirs;
try {
  dirs = readdirSync(join(ROOT, "node_modules", ".pnpm"));
} catch {
  fail("node_modules 없음 (pnpm install 먼저)");
}
const hit = dirs.find((d) => d.startsWith("@types+node@"));
if (!hit) fail("@types/node 미설치");
const got = hit.slice("@types+node@".length).split("_")[0];
if (got !== want) fail(`@types/node 불일치: 설치됨 ${got}, lockfile ${want} (pnpm install --frozen-lockfile 다시 실행)`);
console.log(`check:env ok (@types/node ${got})`);
