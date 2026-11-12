import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 보고 전용: tmpdir()의 pf-* 개수와 접두어별 증가분 출력 (L3 게이트 아님).
// 사용: node scripts/tmp-delta.mjs snap <파일>   (실행 전 스냅샷 저장)
//       node scripts/tmp-delta.mjs diff <파일>   (현재와 비교, 증가분 출력)
//       node scripts/tmp-delta.mjs now           (현재 접두어별 개수 출력)
// 접두어: 이름 앞 두 토막 (pf-remote-suite-xxx → pf-remote).
// M11-tmp-watch: TEMP 바로 아래 항목 전체 개수·바이트 증감을 TEMP_TOTAL 1줄로
// 추가 보고한다 (판정 없음 — INCREASED_TOTAL만 게이트).

// TEMP 전체 측정 상한 (파일이 274만 개였던 때를 대비).
const TEMP_TOTAL_TIMEOUT_MS = 30000;

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
  return { counts, tempTotal: measureTempTotal() };
}

/**
 * M11-tmp-watch: %TEMP% 바로 아래 항목 전체 개수·바이트 합.
 * 시간 상한을 넘기면 null (호출자가 skipped(timeout) 출력).
 */
function measureTempTotal() {
  const deadline = Date.now() + TEMP_TOTAL_TIMEOUT_MS;
  let n = 0;
  let bytes = 0;
  let checked = 0;
  const stack = [];
  let top;
  try {
    top = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of top) {
    n++;
    if (e.isDirectory()) stack.push(join(tmpdir(), e.name));
    else {
      try {
        bytes += statSync(join(tmpdir(), e.name)).size;
      } catch {
        // 사라진 파일 무시
      }
    }
    if (++checked % 256 === 0 && Date.now() > deadline) return null;
  }
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
  return { n, bytes };
}

function printCounts(snapshot) {
  const rows = [...snapshot.counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, c]) => n + c, 0);
  for (const [p, c] of rows) console.log(`${p} ${c}`);
  console.log(`TOTAL ${total}`);
  const t = snapshot.tempTotal;
  if (t) console.log(`TEMP_TOTAL ${t.n}/${t.bytes}`);
  else console.log(`TEMP_TOTAL skipped(timeout)`);
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
    await writeFile(file, JSON.stringify({ at: new Date().toISOString(), counts: Object.fromEntries(snap.counts), tempTotal: snap.tempTotal }, null, 2));
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
    const b = saved.tempTotal ?? null;
    const a = cur.tempTotal;
    if (b && a) {
      console.log(`TEMP_TOTAL before=${b.n}/${b.bytes} after=${a.n}/${a.bytes} delta=${a.n - b.n}/${a.bytes - b.bytes}`);
    } else {
      console.log(`TEMP_TOTAL skipped(timeout)`);
    }
    return;
  }
  throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
