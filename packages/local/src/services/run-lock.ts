import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pfError } from "@proof/shared/errors.js";
import { FileStore } from "../filestore.js";

// M10-lock: 절차서 run 잠금 위치.
// swapDir이 폴더째 옮기므로 폴더 안(`procedures/<name>/.run.lock`)에 두면
// 잠금이 `.old`로 함께 옮겨가 실행 중 보호가 깨진다.
// 위치: `procedures/.locks/<name>.run.lock`. 경로는 이 함수 하나로만 만든다.

/** 현행 잠금 경로. */
export function procRunLockPath(procforgeDir: string, name: string): string {
  return join(procforgeDir, "procedures", ".locks", `${name}.run.lock`);
}

/** 구 잠금 경로 (이행기 1개 마일스톤 동안 run 시작 시 함께 검사). */
export function legacyProcRunLockPath(
  procforgeDir: string,
  name: string,
): string {
  return join(procforgeDir, "procedures", name, ".run.lock");
}

/**
 * 절차서 run 잠금 획득 (runner·finalize·applyDraft 공용).
 * 현행 경로를 잡고, 구 경로 파일이 남아 있으면 검사만 한다:
 * 살아 있는 pid·fresh면 conflict, stale이면 삭제만 하고 새로 만들지 않는다
 * (다음 finalize 때 .old로 쓸려 나가는 동작 방지, M10-lock-legacy).
 */
export const PROC_RUN_LOCK_STALE_MS = 60000;

export function acquireProcRunLock(
  store: FileStore,
  procforgeDir: string,
  name: string,
  conflictMessage: string,
  staleMs = PROC_RUN_LOCK_STALE_MS,
): () => void {
  const releaseNew = store.acquireFileLock(
    procRunLockPath(procforgeDir, name),
    conflictMessage,
    staleMs,
  );
  let newDropped = false;
  const dropNew = (): void => {
    if (newDropped) return;
    newDropped = true;
    try {
      releaseNew();
    } catch {
      // 해제 실패 무시 (throw가 우선)
    }
  };
  try {
    const oldPath = legacyProcRunLockPath(procforgeDir, name);
    if (existsSync(oldPath)) {
      // M5.1-A1: 살아 있는 pid의 잠금은 절대 회수 금지 (FileStore와 같은 규칙).
      let pid: unknown;
      try {
        pid = (JSON.parse(readFileSync(oldPath, "utf8")) as { pid?: unknown } | null)?.pid;
      } catch {
        pid = undefined;
      }
      let alive = false;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as { code?: string }).code !== "ESRCH";
        }
      }
      if (alive) {
        dropNew();
        throw pfError("conflict", conflictMessage);
      }
      let stale = true;
      try {
        stale = Date.now() - statSync(oldPath).mtimeMs > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) {
        dropNew();
        throw pfError("conflict", conflictMessage);
      }
      // stale이면 삭제만 (새로 만들지 않음).
      try {
        unlinkSync(oldPath);
      } catch {
        // 이미 없음 — 무시
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "conflict") dropNew();
    throw e;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    newDropped = true;
    releaseNew();
  };
}
