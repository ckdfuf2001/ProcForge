import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relativizeRunPath } from "./workdir.js";
import { replacePathForms } from "./pathnorm.js";
import { logger } from "../logger.js";
import type { ToolResponse } from "./types.js";

// VCR 방식 녹화 (M3). 매칭 키 = server+tool+정규화 args(키 정렬, runs 경로 → 상대경로) 해시.

export const CASSETTE_VERSION = 2;

export type Recording = {
  key: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  response: { summary: string; json?: unknown };
  at: string;
  /** 녹화 당시 run 정보 (M3.4.1-1 마이그레이션용) */
  runId?: string;
  fsDir?: string;
};

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function normalizeArgs(fsDir: string, projectRoot: string | undefined, args: Record<string, unknown>): unknown {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") {
      const run = replacePathForms(v, fsDir, "RUNFS");
      if (run !== v) {
        try {
          return relativizeRunPath(fsDir, v);
        } catch {
          return run;
        }
      }
      if (projectRoot) return replacePathForms(v, projectRoot, "PROJECT");
      return v;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = norm(val);
      return out;
    }
    return v;
  };
  return stable(norm(args));
}

export function recordKey(
  fsDir: string,
  projectRoot: string | undefined,
  server: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return createHash("sha256").update(JSON.stringify({ server, tool, args: normalizeArgs(fsDir, projectRoot, args) })).digest("hex").slice(0, 16);
}

function cassetteFile(procforgeDir: string, sessionId: string, nodeId: string): string {
  return join(procforgeDir, "sessions", sessionId, "cassettes", `${nodeId}.json`);
}

// 공백 허용 개선 정규식 (M3.4.1-1): 접두 공백 허용, runId는 공백 없음
const LEGACY_RUNS_RE = /(?:[A-Za-z]:)?[^"'`|\n]*?runs[/\\]{1,2}[^"'`/\s\\]+[/\\]{1,2}fs(?=[/\\]|["'`\s]|$)/g;

function migrateEntry(rec: Recording): Recording {
  // runId/fsDir 리터럴 우선, 없으면 정규식 + 경고 (M3.4.1-1)
  if (rec.fsDir) {
    return {
      ...rec,
      response: {
        summary: replacePathForms(rec.response.summary, rec.fsDir, "{RUNFS}"),
        json: mapStrings(rec.response.json, (s) => replacePathForms(s, rec.fsDir!, "{RUNFS}")) as unknown,
      },
    };
  }
  logger.warn("cassette v1 migration (regex fallback)", { key: rec.key });
  const fallback = (s: string) => s.replace(LEGACY_RUNS_RE, "{RUNFS}");
  return {
    ...rec,
    response: { summary: fallback(rec.response.summary), json: mapStrings(rec.response.json, fallback) as unknown },
  };
}

function corruptPath(p: string): string {
  return `${p}.corrupt-${Date.now()}`;
}

export function loadCassette(procforgeDir: string, sessionId: string, nodeId: string): Recording[] {
  const p = cassetteFile(procforgeDir, sessionId, nodeId);
  if (!existsSync(p)) return [];
  let parsed: { version?: number; entries?: Recording[] };
  try {
    parsed = JSON.parse(readFileSync(p, "utf8")) as { version?: number; entries?: Recording[] };
  } catch {
    // M3.4.1-4: 원본 보존 후 bad_request
    try {
      renameSync(p, corruptPath(p));
    } catch {
      // 이동 실패해도 에러는 반환
    }
    throw Object.assign(new Error(`cassette 손상: ${nodeId}`), { code: "bad_request" });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    try {
      renameSync(p, corruptPath(p));
    } catch {
      // 무시
    }
    throw Object.assign(new Error(`cassette 손상: ${nodeId}`), { code: "bad_request" });
  }
  if (parsed.version === CASSETTE_VERSION) return parsed.entries;
  // v1 → 1회 마이그레이션 후 v2로 저장 (M3.4.1-1)
  const entries = parsed.entries.map(migrateEntry);
  try {
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: CASSETTE_VERSION, entries }, null, 2));
    renameSync(tmp, p);
  } catch {
    // 저장 실패해도 읽기는 진행
  }
  return entries;
}

export function findRecording(entries: Recording[], key: string): Recording | undefined {
  return entries.find((e) => e.key === key);
}

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = mapStrings(val, fn);
    return out;
  }
  return v;
}

/** record 시 응답 내 runFs 절대경로 → "{RUNFS}" (M3.4-6/M3.4.1-2, Windows 구분자·이스케이프 포함) */
export function normalizeResponseForStore(
  resp: { summary: string; json?: unknown },
  fsDir: string,
): { summary: string; json?: unknown } {
  const norm = (s: string) => replacePathForms(s, fsDir, "{RUNFS}");
  return { summary: norm(resp.summary), json: mapStrings(resp.json, norm) as unknown };
}

/** replay 시 "{RUNFS}" → 현재 runFs 복원만 수행 (M3.4.1-1) */
export function restoreResponseForRun(
  resp: { summary: string; json?: unknown },
  fsDir: string,
): { summary: string; json?: unknown } {
  const restore = (s: string) => s.split("{RUNFS}").join(fsDir);
  return { summary: restore(resp.summary), json: mapStrings(resp.json, restore) as unknown };
}

export function saveRecording(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  rec: Recording,
  fsDir: string,
  runId?: string,
): void {
  const normalized: Recording = {
    ...rec,
    response: normalizeResponseForStore(rec.response, fsDir),
    ...(runId ? { runId } : {}),
    fsDir,
  };
  const entries = loadCassette(procforgeDir, sessionId, nodeId).filter((e) => e.key !== rec.key);
  entries.push(normalized);
  const p = cassetteFile(procforgeDir, sessionId, nodeId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: CASSETTE_VERSION, entries }, null, 2));
  renameSync(tmp, p);
}

export function toToolResponse(rec: Recording, fsDir: string): ToolResponse {
  const restored = restoreResponseForRun(rec.response, fsDir);
  return { resultText: restored.summary, resultJson: restored.json };
}
