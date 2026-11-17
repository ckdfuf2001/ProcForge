import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

// M9-3-1: 교훈 사실 기록 append-only 로그.
// 경로: runs/by-procedure/<name>/events.ndjson (M9-3-spec §2a).
// 이 파일의 appendEvent가 유일한 쓰기 경로다.

/**
 * M12-1: 회전 상한 (바이트). 상수 하나로 두고 새 env는 만들지 않는다.
 * 테스트는 내부 함수 인자로 작은 값을 주입한다.
 */
export const EVENTS_ROTATE_BYTES = 1048576;

/** events.ndjson 경로 (읽기 집계도 이 함수로 위치를 구한다). */
export function eventsLogPath(procforgeDir: string, procedure: string): string {
  return join(procforgeDir, "runs", "by-procedure", procedure, "events.ndjson");
}

/** 회전 보관본 경로 (1세대만 유지한다). */
export function eventsLogBackupPath(procforgeDir: string, procedure: string): string {
  return eventsLogPath(procforgeDir, procedure) + ".1";
}

/**
 * 이어 읽기 공용 함수 (M12-1: 읽는 쪽 중복 구현 금지).
 * 보관본(.1)이 있으면 먼저, 현재 파일을 나중에 이어 붙인다.
 * 파일이 없으면 빈 문자열 (호출자의 관대 읽기 로직은 그대로 둔다).
 */
export function readEventsText(procforgeDir: string, procedure: string): string {
  let out = "";
  for (const p of [eventsLogBackupPath(procforgeDir, procedure), eventsLogPath(procforgeDir, procedure)]) {
    let t: string;
    try {
      t = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (t.length === 0) continue;
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += t;
  }
  return out;
}

/**
 * 사실 1줄 추가. `{v:1, ts}`는 이 함수가 채운다.
 * 호출자는 `{kind, ...kind별 필드}`만 넘긴다 (procedure는 인자로 고정 —
 * 본문이 덮어쓰지 못한다).
 * 쓰기 실패는 stderr 1줄만 남기고 throw하지 않는다 (실행 결과 불변).
 */
export function appendEvent(
  procforgeDir: string,
  procedure: string,
  obj: Record<string, unknown>,
): void {
  appendEventWithLimit(procforgeDir, procedure, obj, EVENTS_ROTATE_BYTES);
}

/**
 * M12-1: 회전 포함 쓰기. 쓰기 전 크기가 상한 이상이면 rename 1세대 보존
 * (`events.ndjson` → `events.ndjson.1`, 기존 `.1`은 덮어씀) 후 append한다.
 * rename이 실패하면(읽기·다른 프로세스 잠금 등) 회전을 건너뛰고 append는
 * 계속하며 warn 1줄을 남긴다. 테스트는 limitBytes로 작은 상한을 주입한다.
 */
export function appendEventWithLimit(
  procforgeDir: string,
  procedure: string,
  obj: Record<string, unknown>,
  limitBytes: number,
  renameFn: (oldPath: string, newPath: string) => void = renameSync,
): void {
  try {
    const p = eventsLogPath(procforgeDir, procedure);
    mkdirSync(dirname(p), { recursive: true });
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      size = 0;
    }
    if (size >= limitBytes) {
      const bak = eventsLogBackupPath(procforgeDir, procedure);
      try {
        // M12-1-fix: rename 1회만 쓴다 (대상 파일이면 POSIX·Windows 모두 덮어씀 —
        // Windows는 libuv가 MOVEFILE_REPLACE_EXISTING 사용). 기존 `.1`을
        // 먼저 지우면 rename 실패 시 보관본이 사라지므로 unlink는 쓰지 않는다.
        renameFn(p, bak);
      } catch (e) {
        logger.warn(`events rotate 실패(건너뜀): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj, procedure });
    appendFileSync(p, line + "\n", "utf8");
  } catch (e) {
    try {
      // stderr 접두어는 logger 형식과 통일 (shared/logger.ts).
      logger.warn(`events append 실패: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // stderr마저 막히면 조용히 포기 (실행 결과는 바꾸지 않는다)
    }
  }
}
