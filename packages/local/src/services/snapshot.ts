import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isEscapeRel } from "../artifacts.js";
import { inferPathRole, looksLikePath } from "../runner/paths.js";
import type { ArgSpec, PathRole, ToolCatalogEntry } from "@procforge/shared/schema.js";

// 산출물 자동 캡처 (M3.6-2 입력, M3.6-3 출력). local이 수행, 호스트 제출 불필요.
// - 역할: 명시 path → 내장 고정(write.path=out, edit.path=inout) → paths.ts 추정.
// - 존재하는 파일만, baseDir(sandbox 엄격 시) 밖은 제외. 실패 금지(best-effort).

export type CaptureRole = "in" | "inout" | "out";

export function roleForCapture(
  argName: string,
  tool: { server: string; name: string },
  explicitPath?: PathRole,
  catalogEntry?: ToolCatalogEntry,
): CaptureRole | undefined {
  if (explicitPath) return explicitPath;
  if (tool.server === "opencode" && tool.name === "write" && argName === "path") return "out";
  if (tool.server === "opencode" && tool.name === "edit" && argName === "path") return "inout";
  const inferred = inferPathRole(argName, catalogEntry?.inputSchema as Record<string, unknown> | undefined);
  if (inferred === "in" || inferred === "weakIn") return "in";
  if (inferred === "out") return "out";
  return undefined;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function toAbs(baseDir: string, v: string): string | undefined {
  if (URL_RE.test(v)) return undefined;
  const base = resolve(baseDir);
  if (isAbsolute(v)) {
    const abs = resolve(v);
    if (isEscapeRel(relative(base, abs).split("\\").join("/"), "/")) return undefined;
    return abs;
  }
  const rel = v.split("\\").join("/");
  if (rel.length === 0 || rel.length > 512 || isEscapeRel(rel, "/")) return undefined;
  return resolve(base, rel);
}

function isFile(abs: string): boolean {
  try {
    return existsSync(abs) && !statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 인자 중 지정 역할(in/inout/out)의 기존 파일을 수집 (ingest용 원문 경로 목록).
 * - 명시 path가 있으면 looksLikePath 관문 생략 (호스트가 경로임을 확정한 것).
 * - 그 외는 경로처럼 보이는 문자열만.
 */
export function collectExistingPaths(input: {
  baseDir: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  specs?: Record<string, ArgSpec>;
  catalogEntry?: ToolCatalogEntry;
  roles?: CaptureRole[];
}): string[] {
  const roles = input.roles ?? ["in", "inout"];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(input.args)) {
    if (typeof v !== "string") continue;
    const spec = input.specs?.[k];
    const role = roleForCapture(k, input.tool, spec?.path, input.catalogEntry);
    if (!role || !roles.includes(role)) continue;
    // M3.4-1 계열: 미확정 역할은 경로처럼 보일 때만. 명시는 항상 후보.
    if (!spec?.path && !looksLikePath(v)) continue;
    const abs = toAbs(input.baseDir, v);
    if (!abs || !isFile(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(v);
  }
  return out;
}

/** 응답 JSON 안의 문자열 값 중 baseDir에 실제 존재하는 파일 (M3.6-3). 최대 10개. */
export function collectResultFiles(input: { baseDir: string; resultJson: unknown; maxFiles?: number }): string[] {
  const max = input.maxFiles ?? 10;
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (found.length >= max) return;
    if (typeof v === "string") {
      if (!looksLikePath(v)) return;
      const abs = toAbs(input.baseDir, v);
      if (!abs || !isFile(abs) || seen.has(abs)) return;
      seen.add(abs);
      found.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(input.resultJson);
  return found;
}

// ---------- sandbox 스냅샷 기반 입출력 판정 (M4.1-7) ----------

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
