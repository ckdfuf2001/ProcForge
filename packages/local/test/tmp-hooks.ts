import { afterAll } from "vitest";
import { cleanRegisteredTmp } from "@proof/shared/tmp.js";

// M9-tmp: tmp 정리 등록. 테스트 파일 맨 위(다른 afterAll 등록보다 먼저)에서
// useTmpCleanup() 1회 호출. afterAll은 등록 역순(sequence.hooks=stack)으로
// 실행되므로 tmp 정리가 서버 close·자식 종료보다 나중에 돈다.
export function useTmpCleanup(): void {
  afterAll(() => {
    cleanRegisteredTmp();
  });
}
