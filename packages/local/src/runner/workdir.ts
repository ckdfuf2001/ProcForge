import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { FileStore } from "../filestore.js";
import { readManifest } from "../artifacts.js";

// 실행 환경 (M3): runs/<runId>/fs/ 에 golden fixtures를 source 상대경로로 펼침.
// 원본 프로젝트 파일 쓰기 금지 — 모든 쓰기는 run fs 안에서만.

export type RunFs = {
  runId: string;
  runDir: string;
  fsDir: string;
};

export function setupRunFs(procforgeDir: string, sessionId: string, runId: string): RunFs {
  const runDir = join(procforgeDir, "runs", runId);
  const fsDir = join(runDir, "fs");
  mkdirSync(fsDir, { recursive: true });
  const store = new FileStore(procforgeDir);
  const manifest = readManifest(procforgeDir, sessionId);
  // 노드 순서대로 복사 (같은 source면 뒤 노드가 덮어씀 — 최신 golden 우선)
  const nodes = [...store.getNodes(sessionId).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const n of nodes) {
    for (const fx of n.golden?.fixtures ?? []) {
      const src = manifest[fx];
      const abs = join(procforgeDir, "sessions", sessionId, fx);
      if (!existsSync(abs)) continue;
      const dest = src ? join(fsDir, src) : join(fsDir, "fx", fx);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
    }
  }
  return { runId, runDir, fsDir };
}

/** run fs 절대경로 → 정규화 상대 표기 (녹화 키용) */
export function relativizeRunPath(fsDir: string, abs: string): string {
  const rel = relative(resolve(fsDir), resolve(abs));
  return `RUNFS/${rel.replace(/\\/g, "/")}`;
}
