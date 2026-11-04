import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M9-tmp: 테스트 임시폴더 공용 헬퍼 (vitest 의존 없음. 제품 dist에 들어가도 안전).
// afterAll 등록(useTmpCleanup)은 테스트 쪽에 둔다 (local/test/tmp-hooks.ts,
// shared는 각 테스트 파일에 3줄). 이유: vitest는 devDependency라 제품 코드에서
// import하면 런타임에 깨진다.
// 사용법은 tmp-hooks.ts 주석 참조.

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
