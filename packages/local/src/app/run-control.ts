import { spawn, spawnSync } from "node:child_process";
import {
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runDir } from "../services/run-log.js";

// M7 5-1: 실행(run) 제어 — 취소·자식 프로세스 기록.
// 실행 기록은 `.procforge/runs/<runId>/` 아래에 있고 **세션 TTL과 무관**하다
// (세션이 만료돼도 실행 기록·로그는 남는다).
// 로그는 runner도 쓰므로 services/run-log.ts에 있다 (여기서는 재-export).

export {
  appendRunLog,
  readRunLog,
  runDir,
  runLogPath,
  type RunLogEntry,
} from "../services/run-log.js";

function cancelPath(procforgeDir: string, runId: string): string {
  return join(runDir(procforgeDir, runId), "cancel.json");
}

export function writeCancelFlag(
  procforgeDir: string,
  runId: string,
  reason = "사용자 취소",
): void {
  mkdirSync(runDir(procforgeDir, runId), { recursive: true });
  writeFileSync(
    cancelPath(procforgeDir, runId),
    JSON.stringify({ at: new Date().toISOString(), reason }),
    "utf8",
  );
}

export function readCancelFlag(
  procforgeDir: string,
  runId: string,
): { at: string; reason: string } | undefined {
  const p = cancelPath(procforgeDir, runId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { at: string; reason: string };
  } catch {
    return undefined;
  }
}

/** M7-5-d: 취소 플래그 정리 (ESM — require 는 항상 ReferenceError) */
export function clearCancelFlag(procforgeDir: string, runId: string): void {
  const p = cancelPath(procforgeDir, runId);
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // 지우지 못해도 실행 재개 판정에는 영향 없다
  }
}

// ---------- 자식 프로세스 트리 ----------

function childrenPath(procforgeDir: string, runId: string): string {
  return join(runDir(procforgeDir, runId), "children.json");
}

/** 실행 중 자식 pid 기록 (취소 때 트리 전체를 죽인다). */
export function registerChild(
  procforgeDir: string,
  runId: string,
  pid: number,
): void {
  mkdirSync(runDir(procforgeDir, runId), { recursive: true });
  const p = childrenPath(procforgeDir, runId);
  const cur = existsSync(p)
    ? (JSON.parse(readFileSync(p, "utf8")) as number[])
    : [];
  if (!cur.includes(pid)) {
    writeFileSync(p, JSON.stringify([...cur, pid]), "utf8");
  }
}

export function unregisterChild(procforgeDir: string, runId: string, pid: number): void {
  const p = childrenPath(procforgeDir, runId);
  if (!existsSync(p)) return;
  try {
    const cur = JSON.parse(readFileSync(p, "utf8")) as number[];
    writeFileSync(
      p,
      JSON.stringify(cur.filter((x) => x !== pid)),
      "utf8",
    );
  } catch {
    // 실패해도 취소에는 영향 없다
  }
}

export function listChildren(procforgeDir: string, runId: string): number[] {
  const p = childrenPath(procforgeDir, runId);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as number[];
  } catch {
    return [];
  }
}

// M7-5-c: 트리 종료 구현은 services/process-tree.ts **하나**다 (여기서 재구현하지 않는다).
import { killProcessTree } from "../services/process-tree.js";
export { killProcessTree, isAlive, isGroupAlive } from "../services/process-tree.js";
/** 취소: 플래그 + 등록된 자식 트리 종료 */
export async function cancelRun(
  procforgeDir: string,
  runId: string,
  reason = "사용자 취소",
): Promise<{ flag: true; killed: number[]; failed: number[]; children: number[] }> {
  writeCancelFlag(procforgeDir, runId, reason);
  const children = listChildren(procforgeDir, runId);
  const killed: number[] = [];
  const failed: number[] = [];
  for (const pid of children) {
    const r = await killProcessTree(pid);
    killed.push(...r.killed);
    failed.push(...r.failed);
  }
  return { flag: true, killed, failed, children };
}

/** 테스트용: 자식 프로세스를 직접 띄우고 pid 등록 */
export function spawnTrackedChild(
  procforgeDir: string,
  runId: string,
  cmd: string,
  args: string[],
): { pid: number; wait: Promise<number | null> } {
  const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
  registerChild(procforgeDir, runId, child.pid as number);
  const wait = new Promise<number | null>((res) => {
    child.on("exit", (code) => {
      unregisterChild(procforgeDir, runId, child.pid as number);
      res(code);
    });
  });
  return { pid: child.pid as number, wait };
}

