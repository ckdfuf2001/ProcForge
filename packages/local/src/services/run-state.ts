import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomicFile } from "../fsutil.js";

// run 상태 저장소 (M5). runs/<runId>/state.json. App 경유, 어댑터 직접 호출 금지.

export type RunSuspendKind = "need_generated" | "need_approval";

export type RunState = {
  version: 1;
  runId: string;
  sessionId: string;
  procedure: string;
  params: Record<string, string>;
  /** 미실행 노드 (순서대로) */
  /** 절차서 디렉터리 (M5.5-3 state.json 위치. 미지정 시 procedures/<procedure>) */
  procedureDir?: string;
  pending: string[];
  /** 완료 노드 */
  done: string[];
  /**
   * M7-5-4: 노드별 **마지막 실행 결과** (runner 가 준 status 그대로).
   * UI 는 이 값을 해석하지 않고 그대로 표시한다(pass/fail/unverified/skipped/blocked/suspended).
   */
  results?: { nodeId: string; status: string }[];
  /** generated 공급값 (nodeId → 키→값) */
  supplied: Record<string, Record<string, unknown>>;
  /** 승인된 external 노드 */
  approved: string[];
  suspended?: { nodeId: string; kind: RunSuspendKind; missing?: string[] };
  /**
   * M7-5-b: 사람의 결정을 기다리는 중인지 (영속).
   * 메모리에만 두면 서버 재시작 후 재개할 수 없어서 **여기** 적는다 —
   * 이 상태가 잠금 보유의 근거다 (기억에만 두면 409 고착).
   */
  waiting?: { nodeId: string; kind: RunSuspendKind; at: string };
  status: "ready" | "running" | "suspended" | "done" | "failed" | "cancelled";
  failedNodeId?: string;
  failedDetail?: string;
  summary?: { pass: number; fail: number; unverified: number; skipped: number; blocked: number; suspended: number };
  updatedAt: string;
};

export function runStatePath(procforgeDir: string, runId: string): string {
  return join(procforgeDir, "runs", runId, "state.json");
}

/**
 * M7-5-2: 이 세션의 가장 최근 실행 기록 (승인 화면이 절차서 dir을 찾아야 한다).
 * runs/<runId>/ 아래를 훑는다 — 세션 수백 개가 쌓여도 디렉터리만 본다.
 */
export function readRunStateBySession(
  procforgeDir: string,
  sessionId: string,
): (RunState & { procedureDir?: string }) | undefined {
  const runsDir = join(procforgeDir, "runs");
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  let best: (RunState & { procedureDir?: string }) | undefined;
  for (const name of names) {
    const st = readRunState(procforgeDir, name) as
      | (RunState & { procedureDir?: string })
      | undefined;
    if (st?.sessionId !== sessionId) continue;
    if (!best || st.updatedAt > best.updatedAt) best = st;
  }
  return best;
}

export function readRunState(procforgeDir: string, runId: string): RunState | undefined {
  const p = runStatePath(procforgeDir, runId);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as RunState;
    if (!parsed || parsed.version !== 1 || typeof parsed.runId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeRunState(procforgeDir: string, state: RunState): void {
  const p = runStatePath(procforgeDir, state.runId);
  mkdirSync(dirname(p), { recursive: true });
  writeAtomicFile(p, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
