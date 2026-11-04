import { readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 잔존 임시폴더 정리 (수동 실행용).
// 기본은 dry-run: 접두어별 개수와 용량만 출력한다.
// --apply일 때만 삭제한다. 대상은 os.tmpdir() 바로 아래의 pf-* 중
// mtime이 2일 지난 디렉터리만이며, 심볼릭 링크는 따라가지 않고 건드리지 않는다.
//
// 사용: node scripts/tmp-clean.mjs [--apply]
//
// 주의: 서버·자식이 폴더를 쥐고 있으면 Windows에서 EBUSY가 날 수 있다.
// 테스트·서버가 모두 끝난 상태에서 사람이 직접 실행할 것.

const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;

function dirSize(p) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const q = join(p, e.name);
    let st;
    try {
      st = lstatSync(q);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) total += dirSize(q);
    else total += st.size;
  }
  return total;
}

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const cutoff = Date.now() - TWO_DAYS_MS;
  const entries = readdirSync(tmpdir(), { withFileTypes: true });
  const groups = new Map();
  let skippedFresh = 0;
  let skippedLink = 0;
  for (const e of entries) {
    if (!e.name.startsWith("pf-")) continue;
    const p = join(tmpdir(), e.name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      skippedLink++;
      continue;
    }
    if (!st.isDirectory()) continue;
    if (st.mtimeMs >= cutoff) {
      skippedFresh++;
      continue;
    }
    const prefix = e.name.split("-").slice(0, 2).join("-");
    const g = groups.get(prefix) ?? { count: 0, bytes: 0, paths: [] };
    g.count++;
    g.bytes += dirSize(p);
    g.paths.push(p);
    groups.set(prefix, g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  let totalN = 0;
  let totalB = 0;
  for (const [prefix, g] of rows) {
    console.log(`${prefix} ${g.count} ${fmtMB(g.bytes)}`);
    totalN += g.count;
    totalB += g.bytes;
  }
  console.log(`TOTAL ${totalN} ${fmtMB(totalB)} (2일 이내 ${skippedFresh}건·링크 ${skippedLink}건 제외)`);
  if (!apply) {
    console.log("dry-run (삭제 안 함). 삭제하려면 --apply");
    return;
  }
  let removed = 0;
  for (const [, g] of rows) {
    for (const p of g.paths) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        removed++;
      } catch (e) {
        console.error(`[tmp-clean] 삭제 실패(남김): ${p} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  console.log(`REMOVED ${removed}/${totalN}`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
