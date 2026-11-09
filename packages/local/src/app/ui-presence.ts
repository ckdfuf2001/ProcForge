import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// M11-ui-presence: 같은 저장소를 쓰는 다른 UI 인스턴스가 있으면 기동 시
// stderr에 경고 1줄만 남긴다 (막지 않는다).
// 기제는 drafts 잠금과 같은 모양 (wx 원자 생성·mtime 하트비트·stale 무시).
// 충돌 잠금과 달리 선점이 아니라 존재 알림이 목적이라 stale이어도 삭제하지
// 않는다 (삭제는 자기 파일만, close 시).

export const UI_PRESENCE_STALE_MS = 60000;
const UI_PRESENCE_BEAT_MS = 20000;

function presenceDir(procforgeDir: string): string {
  return join(procforgeDir, ".locks");
}

function presencePath(procforgeDir: string, pid: number): string {
  return join(presenceDir(procforgeDir), `ui.${pid}.json`);
}

function readOthers(procforgeDir: string, selfPid: number): { pid: number }[] {
  const out: { pid: number }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(presenceDir(procforgeDir));
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^ui\.(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid === selfPid) continue;
    try {
      if (Date.now() - statSync(join(presenceDir(procforgeDir), name)).mtimeMs > UI_PRESENCE_STALE_MS) continue;
    } catch {
      continue;
    }
    out.push({ pid });
  }
  return out;
}

/**
 * UI 기동 시 1회 호출. 다른 살아 있는 UI가 있으면 stderr에 경고 1줄,
 * 없으면 조용히 넘어간다. 자기 heartbeat 파일을 남기고 정리 함수를 돌려준다.
 */
export function startUiPresence(procforgeDir: string, pid: number = process.pid): () => void {
  try {
    mkdirSync(presenceDir(procforgeDir), { recursive: true });
  } catch {
    // 디렉터리 없으면 감시 불가 — 조용히 진행.
    return () => {};
  }
  const others = readOthers(procforgeDir, pid);
  for (const o of others) {
    console.error(
      `경고: 같은 저장소를 쓰는 다른 UI가 있습니다 (pid ${o.pid}). 동시 조작 시 고아 판정이 날 수 있습니다.`,
    );
  }
  const mine = presencePath(procforgeDir, pid);
  try {
    writeFileSync(mine, JSON.stringify({ pid, at: new Date().toISOString() }));
  } catch {
    return () => {};
  }
  const beat = setInterval(() => {
    try {
      utimesSync(mine, new Date(), new Date());
    } catch {
      // 무시 (다음 틱에 재시도).
    }
  }, UI_PRESENCE_BEAT_MS);
  if (typeof (beat as unknown as { unref?: unknown }).unref === "function") {
    (beat as unknown as { unref: () => void }).unref();
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    clearInterval(beat);
    try {
      unlinkSync(mine);
    } catch {
      // 무시.
    }
  };
}
