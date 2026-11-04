import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

// M9-gates: ci.yml에 직접 적혀 있던 grep 게이트를 같은 내용으로 옮김.
// CI와 dev-verify가 같은 스크립트를 부른다 (L3에서 CI 실패를 사전에 잡기 위함).
// 검사 내용은 ci.yml에서 그대로 가져옴. 유일한 변경: console.log 게이트에서
// cli.ts 예외를 뺌 (cli.ts에 console.log가 없어서. cli-main.ts 예외는 유지).

const SRC = join("packages", "local", "src");

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
function check(name, hits) {
  if (hits.length > 0) {
    console.error(`GATE VIOLATION (${name}):`);
    for (const h of hits) console.error("  " + h);
  } else {
    console.log(`check-gates: OK (${name})`);
  }
}

// 1. no policy strings in local bundle (grep -ri, *.test.ts 제외)
{
  const pats = ["분해 정책", "멈춤 판단", "argSpec 분류 휴리스틱"];
  const hits = [];
  for (const f of walk(SRC)) {
    if (f.endsWith(".test.ts")) continue;
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
  check("no policy strings in local bundle", hits);
}

// 2. no policy strings in MCP surface (server.ts 1파일, 대소문자 구분)
{
  const pats = ["부가세", "llm_rubric", "numeric_match", "json_path_exists", "file_exists", "auto constraint", "휴리스틱"];
  const f = join(SRC, "server.ts");
  const hits = [];
  read(f)
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
  check("no policy strings in MCP surface", hits);
}

// 3. no console.log in local src (stderr logger only, cli-main.ts excepted)
{
  const hits = [];
  for (const f of walk(SRC)) {
    if (f.endsWith(".test.ts")) continue;
    const base = basename(f);
    if (base === "cli-main.ts") continue;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("console.log")) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  violations.push(...hits.map((h) => "console-log: " + h));
  check("no console.log in local src", hits);
}

// 4a. no direct approval matching (matchApproval, services/approvals.ts 제외)
{
  const hits = [];
  for (const f of walk(SRC)) {
    if (extname(f) !== ".ts" || f.endsWith(".test.ts")) continue;
    if (f.replace(/\\/g, "/").includes("services/approvals.ts")) continue;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("matchApproval")) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  violations.push(...hits.map((h) => "matchApproval: " + h));
  check("no direct approval matching", hits);
}

// 4b. isApproved 제거 확인 (*.ts, test 포함, \< 단어 경계)
{
  const re = /(?<![A-Za-z0-9_])isApproved\(/;
  const dirs = [join("packages", "local", "src"), join("packages", "local", "test"), join("packages", "shared", "src"), join("packages", "core", "src")];
  const hits = [];
  for (const d of dirs) {
    for (const f of walk(d)) {
      if (extname(f) !== ".ts") continue;
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
  }
  violations.push(...hits.map((h) => "isApproved: " + h));
  check("isApproved removed", hits);
}

if (violations.length > 0) {
  console.error(`check-gates: FAIL (${violations.length}건)`);
  process.exit(1);
} else {
  console.log("check-gates: ALL OK");
}
