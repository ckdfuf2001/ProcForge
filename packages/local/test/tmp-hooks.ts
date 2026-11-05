import { afterAll } from "vitest";
import { isAlive, listChildren } from "../src/app/run-control.js";
import { readRunState } from "../src/services/run-state.js";
import { cleanRegisteredTmp } from "@proof/shared/tmp.js";

// M9-tmp: tmp 정리 등록. 테스트 파일 맨 위(다른 afterAll 등록보다 먼저)에서
// useTmpCleanup() 1회 호출. afterAll은 등록 역순(sequence.hooks=stack)으로
// 실행되므로 tmp 정리가 서버 close·자식 종료보다 나중에 돈다.
export function useTmpCleanup(): void {
  afterAll(() => {
    cleanRegisteredTmp();
  });
}

// M9-tmp2-fix: 테스트 종료 후에도 실행이 살아 있으면 afterAll rmSync가
// Windows EBUSY로 중간에 던지고 디렉터리 일부가 고아로 남는다.
// 각 테스트가 만든 실행은 afterEach에서 여기서 수습한다 (취소 요청 +
// 자식 사망 + run-state.ts status가 running/ready가 아닐 때까지 대기).
// 대기는 최선형이다 — 시간 초과해도 throw하지 않는다 (정리 실패를
// 테스트 실패로 바꾸지 않는다. 잔존은 tmp-delta로 측정한다).
export async function settleRun(
  app: { uiRunCancel(input: { runId: string }): Promise<unknown> },
  procforgeDir: string,
  runId: string,
): Promise<void> {
  try {
    await app.uiRunCancel({ runId });
  } catch {
    // 이미 끝났거나 기록 없음 — 아래 대기로 확인한다
  }
  for (let i = 0; i < 100; i++) {
    const alive = listChildren(procforgeDir, runId).some((pid) => isAlive(pid));
    const st = readRunState(procforgeDir, runId);
    const active = !!st && (st.status === "running" || st.status === "ready");
    if (!alive && !active) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
