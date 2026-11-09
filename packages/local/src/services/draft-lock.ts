import { existsSync, openSync, closeSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pfError } from "@proof/shared/errors.js";
import { PROC_RUN_LOCK_STALE_MS } from "./run-lock.js";

// M11-draft-lock: 재분석 실행 중 표시 (멀티프로세스 고아 오판 방지).
// procedures run 잠금과 같은 기제 (wx 원자 생성·stale 회수·token release) +
// 하트비트. stale 기준은 run 잠금과 같은 공용값.

/** run 잠금과 같은 stale 기준 (services/run-lock.ts 공용값). */
export const DRAFT_LOCK_STALE_MS = PROC_RUN_LOCK_STALE_MS;

/** drafts/<id>.lock 경로. */
export function draftLockPath(procforgeDir: string, draftId: string): string {
  return join(procforgeDir, "drafts", `${draftId}.lock`);
}

function readToken(p: string): string | undefined {
  try {
    const cur = JSON.parse(readFileSync(p, "utf8")) as { token?: unknown } | null;
    return typeof cur?.token === "string" ? cur.token : undefined;
  } catch {
    return undefined;
  }
}

/** 잠금이 살아 있는지 (있고 stale 아님). 토큰은 따지지 않는다. */
export function isDraftLockAlive(procforgeDir: string, draftId: string): boolean {
  const p = draftLockPath(procforgeDir, draftId);
  let mtime: number;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    return false;
  }
  return Date.now() - mtime <= DRAFT_LOCK_STALE_MS;
}

/**
 * 재분석 실행 중 잠금 획득. 같은 draftId로 동시에 잡으면 conflict.
 * stale이면 회수하고 잡는다. 하트비트(20초)로 mtime을 갱신한다.
 * 반환된 release를 호출하면 하트비트를 멈추고 잠금을 푼다 (본인 것만).
 */
export function acquireDraftLock(
  procforgeDir: string,
  draftId: string,
  conflictMessage = `draft locked: ${draftId}`,
): () => void {
  const p = draftLockPath(procforgeDir, draftId);
  mkdirSync(dirname(p), { recursive: true });
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
  const tryCreate = (): boolean => {
    let fd = -1;
    try {
      fd = openSync(p, "wx");
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "EACCES") return false;
      throw e;
    }
    try {
      writeSync(fd, payload);
      return true;
    } catch (e) {
      try {
        unlinkSync(p);
      } catch {
        // 무시
      }
      throw e;
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // 무시
        }
      }
    }
  };
  if (!tryCreate()) {
    let stale = true;
    try {
      stale = Date.now() - statSync(p).mtimeMs > DRAFT_LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (stale) {
      try {
        unlinkSync(p);
      } catch {
        // 다른 쪽이 먼저 치움
      }
      if (!tryCreate()) throw pfError("conflict", conflictMessage);
    } else {
      throw pfError("conflict", conflictMessage);
    }
  }
  let done = false;
  const timer = setInterval(() => {
    try {
      if (readToken(p) === token) utimesSync(p, new Date(), new Date());
    } catch {
      // 무시 (다음 틱에 재시도)
    }
  }, DRAFT_LOCK_STALE_MS / 3);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    try {
      if (readToken(p) === token) unlinkSync(p);
    } catch {
      // 무시
    }
  };
}
