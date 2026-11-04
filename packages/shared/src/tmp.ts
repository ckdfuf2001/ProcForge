import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// M9-tmp: 테스트 임시폴더 공용 헬퍼. 만든 폴더를 등록해 두고 afterAll에서 지운다.
//
// 사용법: 테스트 파일 맨 위(다른 afterAll 등록보다 먼저)에서 useTmpCleanup() 1회 호출.
// afterAll은 등록 역순으로 실행되므로 tmp 정리가 서버 close·자식 종료보다 나중에 돈다.
// mkdtempSync 호출은 전부 makeTmp(prefix)로 교체한다 (등록 누락 방지).
//
// - Windows EBUSY 대비 rmSync(recursive, force, maxRetries: 5, retryDelay: 100).
// - PROOF_KEEP_TMP=1이면 지우지 않고 경로만 stderr에 출력한다 (증거 보존용).
// - 정리가 실패해도 테스트를 실패시키지 않는다. stderr에 경로를 남겨 증가분 표에 잡히게 한다.
//
// 위치: local 테스트에서도 쓰므로 shared에 둔다 (shared→local import는 check-deps 금지).

const registry = new Set<string>();

export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.add(dir);
  return dir;
}

/** 등록된 폴더를 전부 정리한다. 실패한 경로 목록을 돌려준다. */
export function cleanRegisteredTmp(): string[] {
  const failed: string[] = [];
  for (const dir of registry) {
    registry.delete(dir);
    if (process.env.PROOF_KEEP_TMP === "1") {
      console.error(`[tmp] KEEP(삭제 안 함): ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      failed.push(dir);
      console.error(`[tmp] 정리 실패(남김): ${dir}`);
    }
  }
  return failed;
}

export function useTmpCleanup(): void {
  afterAll(() => {
    cleanRegisteredTmp();
  });
}
