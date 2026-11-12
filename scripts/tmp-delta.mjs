import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 보고 전용: tmpdir()의 pf-* 개수와 접두어별 증가분 출력 (L3 게이트 아님).
// 사용: node scripts/tmp-delta.mjs snap <파일>   (실행 전 스냅샷 저장)
//       node scripts/tmp-delta.mjs diff <파일>   (현재와 비교, 증가분 출력)
//       node scripts/tmp-delta.mjs now           (현재 접두어별 개수 출력)
// 접두어: 이름 앞 두 토막 (pf-remote-suite-xxx → pf-remote).
// M11-tmp-watch: TEMP 바로 아래 항목 개수는 항상 출력한다 (readdir 1회).
// 바이트만 시간 예산 안에서 재고, 넘기면 `?`로 표시한다.
// 출력: TEMP_TOTAL before=<n>/<bytes|?> after=<n>/<bytes|?> delta=<n>/<bytes|?>.

// TEMP 전체 바이트 측정 상한 (파일이 274만 개였던 때를 대비).
const TEMP_TOTAL_TIMEOUT_MS = 30000;

/** 바로 아래 항목 개수 (빠름 — 재귀 없음). */
function measureTempCount() {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true }).length;
  } catch {
    return null;
  }
}

/**
 * 바로 아래 항목 바이트 합 (재귀). 상한을 넘기면 null.
 * 파일 stat 실패(사라짐·권한)는 건너뛴다.
 */
function measureTempBytes() {
  const deadline = Date.now() + TEMP_TOTAL_TIMEOUT_MS;
  let bytes = 0;
  let checked = 0;
  const stack = [tmpdir()];
  while (stack.length > 0) {
    const dir = stack.pop();
    let kids;
    try {
      kids = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of kids) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          bytes += statSync(p).size;
        } catch {
          // 사라진 파일 무시
        }
      }
      if (++checked % 1024 === 0 && Date.now() > deadline) return null;
    }
  }
  return bytes;
}

function prefixOf(name) {
  const parts = name.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : name;
}

function snapshot() {
  const counts = new Map();
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch (e) {
    throw new Error(`tmpdir 읽기 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("pf-")) continue;
    const p = prefixOf(e.name);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return { counts, tempN: measureTempCount(), tempBytes: measureTempBytes() };
}

/** 구 스냅샷 호환: tempTotal {n, bytes} | tempN/tempBytes | 없음 → 정규화. */
function normTempTotal(saved, cur) {
  const norm = (v) => {
    if (v == null) return null;
    if (typeof v === "object" && v !== null && ("n" in v || "bytes" in v)) {
      return {
        n: typeof v.n === "number" ? v.n : null,
        bytes: typeof v.bytes === "number" ? v.bytes : null,
      };
    }
    return null;
  };
  const fromCounts = (c) => (c && typeof c.tempN === "number" ? { n: c.tempN, bytes: typeof c.tempBytes === "number" ? c.tempBytes : null } : norm(c.tempTotal));
  return { before: fromCounts(saved), after: { n: cur.tempN, bytes: cur.tempBytes } };
}

function printCounts(snapshot) {
  const rows = [...snapshot.counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, c]) => n + c, 0);
  for (const [p, c] of rows) console.log(`${p} ${c}`);
  console.log(`TOTAL ${total}`);
  console.log(`TEMP_TOTAL ${numOrQ(snapshot.tempN)}/${numOrQ(snapshot.tempBytes)}`);
}

/** 숫자 아니면 "?" (M11-tmp-watch: 바이트 시간 초과 시). */
function numOrQ(v) {
  return typeof v === "number" ? String(v) : "?";
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "now") {
    printCounts(snapshot());
    return;
  }
  if (cmd === "snap") {
    if (!file) throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
    const snap = snapshot();
    await writeFile(file, JSON.stringify({ at: new Date().toISOString(), counts: Object.fromEntries(snap.counts), tempN: snap.tempN, tempBytes: snap.tempBytes }, null, 2));
    console.log(`snapshot 저장: ${file}`);
    return;
  }
  if (cmd === "diff") {
    if (!file) throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
    const saved = JSON.parse(await readFile(file, "utf8"));
    const savedCounts = saved.counts ?? {};
    const cur = snapshot();
    const keys = new Set([...Object.keys(savedCounts), ...cur.counts.keys()]);
    let total = 0;
    for (const k of [...keys].sort()) {
      const d = (cur.counts.get(k) ?? 0) - (savedCounts[k] ?? 0);
      if (d !== 0) {
        console.log(`${k} ${d > 0 ? "+" : ""}${d} (이전 ${savedCounts[k] ?? 0} → 현재 ${cur.counts.get(k) ?? 0})`);
        if (d > 0) total += d;
      }
    }
    console.log(`INCREASED_TOTAL ${total}`);
    // M11-tmp-watch: 보고만 하고 판정하지 않는다 (게이트는 INCREASED_TOTAL).
    // 바이트가 ?면 delta 바이트도 ?다.
    const t = normTempTotal(saved, cur);
    const dn =
      t.before && t.after && typeof t.before.n === "number" && typeof t.after.n === "number"
        ? String(t.after.n - t.before.n)
        : "?";
    const db =
      t.before && t.after && typeof t.before.bytes === "number" && typeof t.after.bytes === "number"
        ? String(t.after.bytes - t.before.bytes)
        : "?";
    const bn = t.before && typeof t.before.n === "number" ? String(t.before.n) : "?";
    const bb = t.before && typeof t.before.bytes === "number" ? String(t.before.bytes) : "?";
    const an = t.after && typeof t.after.n === "number" ? String(t.after.n) : "?";
    const ab = t.after && typeof t.after.bytes === "number" ? String(t.after.bytes) : "?";
    console.log(`TEMP_TOTAL before=${bn}/${bb} after=${an}/${ab} delta=${dn}/${db}`);
    return;
  }
  throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
