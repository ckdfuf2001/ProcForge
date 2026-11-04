import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// M9-gates: ci.yml에 직접 적혀 있던 게이트를 같은 내용으로 옮김.
// CI와 dev-verify가 같은 스크립트를 부른다 (L3에서 CI 실패를 사전에 잡기 위함).
// 검사 내용은 ci.yml에서 그대로 가져옴. 유일한 변경: console.log 게이트에서
// cli.ts 예외를 뺌 (cli.ts에 console.log가 없어서. cli-main.ts 예외는 유지).
// M9-gates-fix: 경로는 cwd가 아니라 스크립트 위치 기준. 검사마다 대상 파일 수를
// 세어 0개면 FAIL (server.ts가 없어지는 등의 이동이 조용히 통과하지 않도록).
// isApproved 원본 패턴 `"\<isApproved>(`은 BRE에서 `>`가 리터럴이라
// `isApproved>(`만 찾아 항상 통과하는 무효 검사였음. 이번에 `isApproved(`로 바로잡음.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages", "local", "src");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function read(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const violations = [];
function check(name, hits, targets) {
  if (targets === 0) {
    console.error(`GATE VIOLATION (${name}): 대상 파일 0개`);
    violations.push(`${name}: 대상 파일 0개`);
  }
  if (hits.length > 0) {
    console.error(`GATE VIOLATION (${name}):`);
    for (const h of hits) console.error("  " + h);
  } else if (targets > 0) {
    console.log(`check-gates: OK (${name}, 대상 ${targets}파일)`);
  }
}

// 1. no policy strings in local bundle (grep -ri, *.test.ts 제외)
{
  const pats = ["분해 정책", "멈춤 판단", "argSpec 분류 휴리스틱"];
  const hits = [];
  let targets = 0;
  for (const f of walk(SRC)) {
    if (f.endsWith(".test.ts")) continue;
    targets++;
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      const low = line.toLowerCase();
      for (const p of pats) {
        if (low.includes(p.toLowerCase())) {
          hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
          break;
        }
      }
    });
  }
  violations.push(...hits.map((h) => "policy-local: " + h));
  check("no policy strings in local bundle", hits, targets);
}

// 2. no policy strings in MCP surface (server.ts 1파일, 대소문자 구분)
{
  const pats = ["부가세", "llm_rubric", "numeric_match", "json_path_exists", "file_exists", "auto constraint", "휴리스틱"];
  const f = join(SRC, "server.ts");
  const hits = [];
  const content = read(f);
  const targets = existsSync(f) ? 1 : 0;
  content
    .split("\n")
    .forEach((line, i) => {
      for (const p of pats) {
        if (line.includes(p)) {
          hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
          break;
        }
      }
    });
  violations.push(...hits.map((h) => "policy-mcp: " + h));
  check("no policy strings in MCP surface", hits, targets);
}

// 3. no console.log in local src (stderr logger only, cli-main.ts excepted)
{
  const hits = [];
  let targets = 0;
  for (const f of walk(SRC)) {
    if (f.endsWith(".test.ts")) continue;
    const base = basename(f);
    if (base === "cli-main.ts") continue;
    targets++;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("console.log")) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  violations.push(...hits.map((h) => "console-log: " + h));
  check("no console.log in local src", hits, targets);
}

// 4a. no direct approval matching (matchApproval, services/approvals.ts 제외)
{
  const hits = [];
  let targets = 0;
  for (const f of walk(SRC)) {
    if (extname(f) !== ".ts" || f.endsWith(".test.ts")) continue;
    if (f.replace(/\\/g, "/").includes("services/approvals.ts")) continue;
    targets++;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("matchApproval")) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  violations.push(...hits.map((h) => "matchApproval: " + h));
  check("no direct approval matching", hits, targets);
}

// 4b. isApproved 제거 확인 (*.ts, test 포함, \< 단어 경계)
{
  const re = /(?<![A-Za-z0-9_])isApproved\(/;
  const dirs = [join(ROOT, "packages", "local", "src"), join(ROOT, "packages", "local", "test"), join(ROOT, "packages", "shared", "src"), join(ROOT, "packages", "core", "src")];
  const hits = [];
  let targets = 0;
  for (const d of dirs) {
    for (const f of walk(d)) {
      if (extname(f) !== ".ts") continue;
      targets++;
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
  }
  violations.push(...hits.map((h) => "isApproved: " + h));
  check("isApproved removed", hits, targets);
}

if (violations.length > 0) {
  console.error(`check-gates: FAIL (${violations.length}건)`);
  process.exit(1);
} else {
  console.log("check-gates: ALL OK");
}
