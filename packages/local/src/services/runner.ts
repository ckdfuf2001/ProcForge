import { writeFileSync } from "node:fs";
import { toJUnit, type RunReport } from "../runner/index.js";

// junit 산출물 기록 (M4.2-1, pf_test에서 이동). App 경유, 어댑터 직접 호출 금지.

export function writeJUnitFile(junitPath: string, report: RunReport): void {
  writeFileSync(junitPath, toJUnit(report));
}
