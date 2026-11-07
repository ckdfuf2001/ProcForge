import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * 현행 경로를 잡고, 구 경로 파일이 남아 있으면 그것도 잡는다
 * (구 코드 실행 중이면 conflict — 이행기 호환, 잔재는 release 때 정리).
 */
export function acquireProcRunLock(
  store: FileStore,
  procforgeDir: string,
  name: string,
  conflictMessage: string,
  staleMs = 60000,
): () => void {
  const releaseNew = store.acquireFileLock(
    procRunLockPath(procforgeDir, name),
    conflictMessage,
    staleMs,
  );
  let releaseOld: (() => void) | undefined;
  try {
    if (existsSync(legacyProcRunLockPath(procforgeDir, name))) {
      releaseOld = store.acquireFileLock(
        legacyProcRunLockPath(procforgeDir, name),
        conflictMessage,
        staleMs,
      );
    }
  } catch (e) {
    try {
      releaseNew();
    } catch {
      // 해제 실패 무시 (아래 throw가 우선)
    }
    throw e;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      releaseOld?.();
    } finally {
      releaseNew();
    }
  };
}
