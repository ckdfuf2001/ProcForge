import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** pf_next 시점 사본 디렉터리 (M4.1.1-1, inout 원본 탐색용) */
export function preCopyDir(procforgeDir: string, sessionId: string, nodeId: string): string {
  return join(procforgeDir, "sessions", sessionId, "nodes", nodeId, "pre");
}

/** seed 원본 보존 디렉터리 (M4.1.1-1, inout 원본 탐색 1순위) */
export function seedOriginalDir(procforgeDir: string, sessionId: string): string {
  return join(procforgeDir, "sessions", sessionId, "seed");
}

/**
 * sandbox 파일 사본 저장 (M4.1.1-1). 개당 maxBytes 이하만, 초과분은 건너뜀.
 * 반환은 복사된 sandbox 상대경로들.
 */
export function writePreCopies(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  sandboxDir: string,
  maxBytes = 5 * 1024 * 1024,
): string[] {
  const copied: string[] = [];
  const dest = preCopyDir(procforgeDir, sessionId, nodeId);
  for (const e of takeSandboxSnapshot(sandboxDir)) {
    if (e.size > maxBytes) continue;
    try {
      const src = join(resolve(sandboxDir), e.path);
      const d = join(dest, e.path);
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(src, d);
      copied.push(e.path);
    } catch {
      // 개별 실패 무시 (best-effort)
    }
  }
  return copied;
}

/** pf_next 시점 사본 읽기 (없으면 undefined) */
export function readPreCopy(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  rel: string,
): Buffer | undefined {
  try {
    const p = join(preCopyDir(procforgeDir, sessionId, nodeId), rel);
    if (!existsSync(p)) return undefined;
    return readFileSync(p);
  } catch {
    return undefined;
  }
}

/** seed 원본 읽기 (없으면 undefined) */
export function readSeedOriginal(procforgeDir: string, sessionId: string, rel: string): Buffer | undefined {
  try {
    const p = join(seedOriginalDir(procforgeDir, sessionId), rel);
    if (!existsSync(p)) return undefined;
    return readFileSync(p);
  } catch {
    return undefined;
  }
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

export type CaptureRecord = {
  ins: string[];
  outs: string[];
  /** inout 원본 fixture들 (M4.1.1-1, replay 입력·golden 유지) */
  inouts: string[];
  /** 원본을 찾지 못한 inout 상대경로들 (M4.1.1-1, confirm 거부용) */
  unresolvedInouts?: string[];
};

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
    return { ins: parsed.ins, outs: parsed.outs, inouts: Array.isArray(parsed.inouts) ? parsed.inouts : [], ...(parsed.unresolvedInouts ? { unresolvedInouts: parsed.unresolvedInouts } : {}) };
  } catch {
    return undefined;
  }
}
