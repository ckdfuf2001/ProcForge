import { join } from "node:path";
import { writeAtomicFile } from "../fsutil.js";
import type { ProcedureLatest } from "../runner/types.js";

// M9-2-3: 절차서별 latest 인덱스
// (.procforge/runs/by-procedure/<name>/latest.json).
// 종료 상태(done/failed/cancelled)일 때만 원자 갱신. best-effort.

export function writeProcedureLatest(input: {
  procforgeDir: string;
  procedure: string;
  runId: string;
  status: ProcedureLatest["status"];
}): void {
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,64}$/.test(input.procedure)) return;
    const latest: ProcedureLatest = {
      runId: input.runId,
      status: input.status,
      at: new Date().toISOString(),
    };
    writeAtomicFile(
      join(input.procforgeDir, "runs", "by-procedure", input.procedure, "latest.json"),
      JSON.stringify(latest, null, 2),
    );
  } catch {
    // 인덱스 실패가 run을 깨뜨리지 않는다.
  }
}
