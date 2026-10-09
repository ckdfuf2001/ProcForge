import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// sandbox 스냅샷 기반 입출력 판정 (M4.1-7). App 경유, 어댑터 직접 호출 금지.

export type SnapshotEntry = { path: string; size: number; mtimeMs: number };

/** baseDir 기준 상대경로 (manifest·스냅샷 공용 표기) */
export function toBaseRel(baseDir: string, p: string): string {
  return relative(resolve(baseDir), resolve(resolve(baseDir), p)).split("\\").join("/");
}

/** 디렉터리 전체 {path,size,mtimeMs} 기록 (결정적 정렬) */
export function takeSandboxSnapshot(sandboxDir: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const st = statSync(p);
        if (!st.isDirectory()) out.push({ path: relative(resolve(sandboxDir), p).split("\\").join("/"), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // 무시
      }
    }
  };
  walk(resolve(sandboxDir));
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

export function preSnapshotPath(procforgeDir: string, sessionId: string, nodeId: string): string {
  return join(procforgeDir, "sessions", sessionId, "nodes", nodeId, "pre-snapshot.json");
}

export function writePreSnapshot(procforgeDir: string, sessionId: string, nodeId: string, entries: SnapshotEntry[]): void {
  const p = preSnapshotPath(procforgeDir, sessionId, nodeId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entries));
}

export function readPreSnapshot(procforgeDir: string, sessionId: string, nodeId: string): SnapshotEntry[] | undefined {
  const p = preSnapshotPath(procforgeDir, sessionId, nodeId);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as SnapshotEntry[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 스냅샷 대비 새로 생기거나 바뀐 파일 (sandbox 상대경로) */
export function diffSnapshot(pre: SnapshotEntry[], sandboxDir: string): { created: string[]; modified: string[] } {
  const before = new Map(pre.map((e) => [e.path, e]));
  const created: string[] = [];
  const modified: string[] = [];
  for (const cur of takeSandboxSnapshot(sandboxDir)) {
    const old = before.get(cur.path);
    if (!old) created.push(cur.path);
    else if (old.size !== cur.size || old.mtimeMs !== cur.mtimeMs) modified.push(cur.path);
  }
  return { created, modified };
}

export type CaptureRecord = { ins: string[]; outs: string[] };

export function captureRecordPath(procforgeDir: string, sessionId: string, nodeId: string, attemptId: string): string {
  return join(procforgeDir, "sessions", sessionId, "capture", nodeId, `${attemptId}.json`);
}

export function writeCaptureRecord(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  attemptId: string,
  record: CaptureRecord,
): void {
  const p = captureRecordPath(procforgeDir, sessionId, nodeId, attemptId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record));
}

export function readCaptureRecord(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  attemptId: string,
): CaptureRecord | undefined {
  const p = captureRecordPath(procforgeDir, sessionId, nodeId, attemptId);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CaptureRecord;
    if (!Array.isArray(parsed.ins) || !Array.isArray(parsed.outs)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
