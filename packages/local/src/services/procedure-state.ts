import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicFile } from "../fsutil.js";

// 실행 간 상태 (M5.5-3). procedures/<name>/state.json.
// run 성공 종료 시에만 원자 저장. 실패 run은 불변.

export function procedureStatePath(procedureDir: string): string {
  return join(procedureDir, "state.json");
}

export function procedureStatePathByName(procforgeDir: string, procedure: string): string {
  return join(procforgeDir, "procedures", procedure, "state.json");
}

/** 상태 로드: 파일 → params.stateDefaults(JSON) → 없으면 throw (bad_request) */
export function loadProcedureState(
  stateFile: string,
  params: Record<string, string>,
): Record<string, unknown> {
  if (existsSync(stateFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 손상 시 아래 기본값 경로로 (없으면 거부)
    }
  }
  const raw = params.stateDefaults;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fallthrough
    }
    throw Object.assign(new Error("params.stateDefaults 파싱 실패 (JSON 객체 필요)"), { code: "bad_request" });
  }
  throw Object.assign(new Error("state 없음: 첫 실행은 params.stateDefaults 필요"), { code: "bad_request" });
}

/** 상태 원자 저장 */
export function saveProcedureState(stateFile: string, state: Record<string, unknown>): void {
  writeAtomicFile(stateFile, JSON.stringify(state, null, 2));
}
