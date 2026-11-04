import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 보고 전용: tmpdir()의 pf-* 개수와 접두어별 증가분 출력 (L3 게이트 아님).
// 사용: node scripts/tmp-delta.mjs snap <파일>   (실행 전 스냅샷 저장)
//       node scripts/tmp-delta.mjs diff <파일>   (현재와 비교, 증가분 출력)
//       node scripts/tmp-delta.mjs now           (현재 접두어별 개수 출력)
// 접두어: 이름 앞 두 토막 (pf-remote-suite-xxx → pf-remote).

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
  return counts;
}

function printCounts(counts) {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, c]) => n + c, 0);
  for (const [p, c] of rows) console.log(`${p} ${c}`);
  console.log(`TOTAL ${total}`);
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
    const snap = Object.fromEntries(snapshot());
    await writeFile(file, JSON.stringify({ at: new Date().toISOString(), counts: snap }, null, 2));
    console.log(`snapshot 저장: ${file}`);
    return;
  }
  if (cmd === "diff") {
    if (!file) throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
    const saved = JSON.parse(await readFile(file, "utf8")).counts;
    const cur = snapshot();
    const keys = new Set([...Object.keys(saved), ...cur.keys()]);
    let total = 0;
    for (const k of [...keys].sort()) {
      const d = (cur.get(k) ?? 0) - (saved[k] ?? 0);
      if (d !== 0) {
        console.log(`${k} ${d > 0 ? "+" : ""}${d} (이전 ${saved[k] ?? 0} → 현재 ${cur.get(k) ?? 0})`);
        if (d > 0) total += d;
      }
    }
    console.log(`INCREASED_TOTAL ${total}`);
    return;
  }
  throw new Error("usage: tmp-delta.mjs snap <파일> | diff <파일> | now");
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
