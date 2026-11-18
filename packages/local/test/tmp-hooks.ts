import { afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

// M9-tmp2-fix2: settle 예산 20초. f4395f7의 100회×100ms(최대 10초+cancel)가
// afterEach 기본 hookTimeout 10초를 넘을 수 있어 L3에서 hook timeout이 났다
// (ledger 2026-11-06행). afterEach timeout 30초와 함께 예산을 역전한다
// (hook 30s > settle 20s). 시간 초과해도 throw하지 않는다.
export const SETTLE_BUDGET_MS = 20000;
export async function settleRun(
  app: { uiRunCancel(input: { runId: string }): Promise<unknown> },
  procforgeDir: string,
  runId: string,
): Promise<void> {
  try {
    await app.uiRunCancel({ runId });
  } catch (e) {
    // M14-1-fix2(a): 삼키지 않고 기록한다 (호출자는 그대로 대기 확인을 계속한다).
    process.stderr.write(
      `[settle] cancel 실패 runId=${runId} err=${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  for (;;) {
    const kids = listChildren(procforgeDir, runId);
    const alive = kids.filter((pid) => isAlive(pid));
    const st = readRunState(procforgeDir, runId);
    const active = !!st && (st.status === "running" || st.status === "ready");
    if (alive.length === 0 && !active) return;
    if (Date.now() >= deadline) {
      const info = { runId, status: st?.status ?? "none", alivePids: alive };
      // M14-1-fix2(b): cancel.json 유무를 rm 이전 시점(settle 안)에서 기록한다.
      // 부분 삭제 폴더에서는 파일 부재가 근거가 되지 않으므로 여기서 찍는다.
      const cancelJson = existsSync(join(procforgeDir, "runs", runId, "cancel.json"))
        ? "있음"
        : "없음";
      process.stderr.write(
        `[settle] timeout runId=${info.runId} status=${info.status} alivePids=${info.alivePids.join(",")} cancelJson=${cancelJson}\n`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
