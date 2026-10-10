import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  pending: string[];
  /** 완료 노드 */
  done: string[];
  /** generated 공급값 (nodeId → 키→값) */
  supplied: Record<string, Record<string, unknown>>;
  /** 승인된 external 노드 */
  approved: string[];
  suspended?: { nodeId: string; kind: RunSuspendKind; missing?: string[] };
  status: "ready" | "running" | "suspended" | "done" | "failed";
  failedNodeId?: string;
  failedDetail?: string;
  summary?: { pass: number; fail: number; unverified: number; skipped: number; blocked: number; suspended: number };
  updatedAt: string;
};

export function runStatePath(procforgeDir: string, runId: string): string {
  return join(procforgeDir, "runs", runId, "state.json");
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
