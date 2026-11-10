import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

// M9-3-1: 교훈 사실 기록 append-only 로그.
// 경로: runs/by-procedure/<name>/events.ndjson (M9-3-spec §2a).
// 이 파일의 appendEvent가 유일한 쓰기 경로다.

/** events.ndjson 경로 (읽기 집계도 이 함수로 위치를 구한다). */
export function eventsLogPath(procforgeDir: string, procedure: string): string {
  return join(procforgeDir, "runs", "by-procedure", procedure, "events.ndjson");
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
  try {
    const p = eventsLogPath(procforgeDir, procedure);
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj, procedure });
    appendFileSync(p, line + "\n", "utf8");
  } catch (e) {
    try {
      // stderr 접두어는 logger 형식과 통일 (`[procforge:warn]`, shared/logger.ts).
      logger.warn(`events append 실패: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // stderr마저 막히면 조용히 포기 (실행 결과는 바꾸지 않는다)
    }
  }
}
