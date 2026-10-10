import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CI: local 패키지가 core 서버 전용 로직을 직접 import하지 못하도록 검사.
// 허용: @procforge/shared, 상대경로, 외부 라이브러리.
// 금지: "@procforge/core", "packages/core" 문자열 포함 import.
// 예외(M0-6 개정, M1.5): 합성 루트 packages/local/src/core-inprocess.ts 1파일만 허용.
// M6에서 이 파일만 HTTP CoreClient로 교체한다.

const LOCAL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "local", "src");

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, out);
    else if (/\.(ts|js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

const files = listFiles(LOCAL_SRC);
const violations = [];
const EXCEPTION = "core-inprocess.ts";
for (const f of files) {
  if (f.endsWith(EXCEPTION)) continue;
  const content = readFileSync(f, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    const stripped = line.trim();
    if (stripped.startsWith("//")) return;
    if (
      stripped.includes("@procforge/core") ||
      stripped.includes("packages/core") ||
      stripped.includes("packages/core-server") ||
      stripped.includes("@procforge/core-server")
    ) {
      violations.push(`${f}:${i + 1}: ${stripped}`);
    }
  });
}

if (violations.length > 0) {
  console.error("DEP VIOLATION: packages/local must not import core server logic directly.");
  console.error("Use CoreClient interface (@procforge/shared/core-client) only.");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
} else {
  console.log("check-deps: OK (no local->core imports)");
}

// M4.2-4-1: 어댑터(server.ts, cli.ts, ui/**) import 허용 목록.
// 허용: app/, shared의 schema·dto·errors, logger, MCP SDK, zod.
// 금지: filestore, services/**, runner/**, node:fs 등 나머지 local 내부·node 내장.
const ADAPTER_RES = [/[/\\]server\.ts$/, /[/\\]cli\.ts$/, /[/\\]ui[/\\]/];
const ADAPTER_ALLOW_RES = [
  /from\s+["']\.\/app\/[^"']*["']/,
  /from\s+["']\.\.\/app\/[^"']*["']/,
  /from\s+["']@procforge\/shared\/(schema|dto|errors)\.js["']/,
  /from\s+["']\.\/logger\.js["']/,
  /from\s+["']\.\.\/logger\.js["']/,
  /from\s+["']@modelcontextprotocol\/[^"']*["']/,
  /from\s+["']zod["']/,
];
const adapterViolations = [];
for (const f of files) {
  if (!ADAPTER_RES.some((re) => re.test(f))) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const stripped = line.trim();
    if (stripped.startsWith("//")) return;
    // 모듈 식별자가 있는 행만 검사 (멀티라인 import 여는 행 `import {` 제외,
    // 닫는 행 `} from "x"`·한 줄 import·require 포함).
    const isImportLine = /from\s+["']/.test(stripped) || stripped.includes("require(") || /^import\s+["']/.test(stripped);
    if (!isImportLine) return;
    if (!ADAPTER_ALLOW_RES.some((re) => re.test(stripped))) {
      adapterViolations.push(`${f}:${i + 1}: ${stripped}`);
    }
  });
}

if (adapterViolations.length > 0) {
  console.error("DEP VIOLATION (M4.2-4-1): adapters may import only app/, shared schema/dto/errors, logger, MCP SDK, zod.");
  for (const v of adapterViolations) console.error("  " + v);
  process.exit(1);
} else {
  console.log("check-deps: OK (adapter imports)");
}

// M4.2-4-2: 어댑터 fs 직접 사용 금지 (saveNode|writeFileSync|readFileSync|existsSync|mkdirSync).
const FS_BANNED_RES = [/saveNode/, /writeFileSync/, /readFileSync/, /existsSync/, /mkdirSync/];
const fsViolations = [];
for (const f of files) {
  if (!ADAPTER_RES.some((re) => re.test(f))) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return;
    if (FS_BANNED_RES.some((re) => re.test(stripped))) {
      fsViolations.push(`${f}:${i + 1}: ${stripped}`);
    }
  });
}

if (fsViolations.length > 0) {
  console.error("DEP VIOLATION (M4.2-4-2): adapters must not use fs directly.");
  for (const v of fsViolations) console.error("  " + v);
  process.exit(1);
} else {
  console.log("check-deps: OK (no adapter fs)");
}

// M4.2-4-2: FileStore 저장 계열은 core in-process 구현 파일에서만 허용.
// 허용: packages/core/src/**, core-inprocess.ts, filestore.ts(내부),
// app/**, services/**, runner/**, procedure.ts(App 경로 import).
// 제외: *.test.ts (저장소 직접 검증이 목적).
const SAVE_ALLOW_RES = [
  /packages[/\\]core[/\\]src[/\\]/,
  /[/\\]core-inprocess\.ts$/,
  /[/\\]filestore\.ts$/,
  /[/\\]app[/\\]/,
  /[/\\]services[/\\]/,
  /[/\\]runner[/\\]/,
  /[/\\]procedure\.ts$/,
];
const SAVE_CALL_RES = [/\.saveSession\s*\(/, /\.saveNode\s*\(/, /\.appendEvents\s*\(/, /\.commitChange\s*\(/, /\.touchSession\s*\(/, /\.repairDiscard\s*\(/];
const saveViolations = [];
for (const f of files) {
  if (f.endsWith(".test.ts")) continue;
  if (SAVE_ALLOW_RES.some((re) => re.test(f))) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const stripped = line.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*")) return;
    if (SAVE_CALL_RES.some((re) => re.test(stripped))) {
      saveViolations.push(`${f}:${i + 1}: ${stripped}`);
    }
  });
}

if (saveViolations.length > 0) {
  console.error("DEP VIOLATION (M4.2-4-2): FileStore saves allowed only in core in-process files.");
  for (const v of saveViolations) console.error("  " + v);
  process.exit(1);
} else {
  console.log("check-deps: OK (saves in core in-process files)");
}
