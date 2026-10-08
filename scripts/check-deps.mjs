import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// CI: local 패키지가 core 서버 전용 로직을 직접 import하지 못하도록 검사.
// 허용: @procforge/shared, 상대경로, 외부 라이브러리.
// 금지: "@procforge/core", "packages/core" 문자열 포함 import.
// 예외(M0-6 개정, M1.5): 합성 루트 packages/local/src/core-inprocess.ts 1파일만 허용.
// M6에서 이 파일만 HTTP CoreClient로 교체한다.

const LOCAL_SRC = new URL("../packages/local/src/", import.meta.url).pathname;

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
