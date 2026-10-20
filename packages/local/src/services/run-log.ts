import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// M7 5-1: 실행(run) 제어 — 실행 로그. runner/app 양쪽에서 쓰므로 services에 둔다.

export type RunLogEntry = {
  seq: number;
  at: string;
  level: "info" | "error" | "result";
  nodeId?: string;
  message: string;
};

export function runDir(procforgeDir: string, runId: string): string {
  return join(procforgeDir, "runs", runId);
}

export function runLogPath(procforgeDir: string, runId: string): string {
  return join(runDir(procforgeDir, runId), "log.ndjson");
}

/** 로그 1줄 추가 (동시 쓰기 대비 append). 실패를 삼키지 않는다. */
export function appendRunLog(
  procforgeDir: string,
  runId: string,
  entry: Omit<RunLogEntry, "seq" | "at"> & { seq?: number; at?: string },
): RunLogEntry {
  mkdirSync(runDir(procforgeDir, runId), { recursive: true });
  const prev = readRunLog(procforgeDir, runId);
  const full: RunLogEntry = {
    seq: entry.seq ?? prev.length + 1,
    at: entry.at ?? new Date().toISOString(),
    level: entry.level,
    ...(entry.nodeId !== undefined ? { nodeId: entry.nodeId } : {}),
    message: entry.message,
  };
  appendFileSync(runLogPath(procforgeDir, runId), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** afterSeq 뒤 로그만 (SSE 증분). */
export function readRunLog(
  procforgeDir: string,
  runId: string,
  afterSeq = 0,
): RunLogEntry[] {
  const p = runLogPath(procforgeDir, runId);
  if (!existsSync(p)) return [];
  const out: RunLogEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RunLogEntry;
      if (e.seq > afterSeq) out.push(e);
    } catch {
      // 깨진 줄은 건너뛴다 (로그가 실행을 막지 않게)
    }
  }
  return out;
}
