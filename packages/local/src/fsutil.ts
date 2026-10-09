import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

// 원자적 파일 쓰기 (M3.4.2-3). Windows rename EPERM/EBUSY 대응 재시도 (최대 5회, 50ms).

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait (짧은 대기 전용)
  }
}

function isRetryable(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export function writeAtomicFile(path: string, data: string, warnBytes = 1_000_000): void {
  if (data.length > warnBytes) logger.warn(`large session file: ${path} (${data.length} bytes)`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      last = e;
      if (!isRetryable(e) || i === 4) throw e;
      sleepSync(50);
    }
  }
  throw last;
}
