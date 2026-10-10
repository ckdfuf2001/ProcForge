import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { compareNormalized, maskParamsValues, restoreParamsPlaceholders, type NormalizedDiff } from "@procforge/shared/normalize.js";
import { relativizeRunPath } from "./workdir.js";
import { replacePathForms } from "./pathnorm.js";
import { logger } from "../logger.js";
import { writeAtomicFile } from "../fsutil.js";
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
  /** 녹화 당시 session params (M3.5.1-2 재바인딩 비교용) */
  params?: Record<string, string>;
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
    writeAtomicFile(p, JSON.stringify({ version: CASSETTE_VERSION, entries }, null, 2));
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
  writeAtomicFile(p, JSON.stringify({ version: CASSETTE_VERSION, entries }, null, 2));
}

export function toToolResponse(rec: Recording, fsDir: string): ToolResponse {
  const restored = restoreResponseForRun(rec.response, fsDir);
  return { resultText: restored.summary, resultJson: restored.json };
}

function shaHex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * 바이너리(\0 포함) 문자열 → sha/size 지문 (M3.5.1-2).
 * drift 비교 시 원문 바이트 유출 없이 동등성만 판정한다.
 */
export function fingerprintResponse(v: unknown): unknown {
  if (typeof v === "string") {
    return v.includes("\0") ? `bin:${shaHex(v)}:${Buffer.byteLength(v, "utf8")}` : v;
  }
  if (Array.isArray(v)) return v.map(fingerprintResponse);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fingerprintResponse(x);
    return out;
  }
  return v;
}

/**
 * 도구 응답 비교 (M3.5.1-2, passthrough drift용).
 * 호스트 resultSummary(golden)는 비교하지 않고, 정규화된 도구 응답만 비교한다.
 * 양쪽 json이 있으면 구조 비교 (ignore 제거), 아니면 텍스트 비교.
 * 각 측은 해당 시점 params로 마스킹 후 현재 params로 복원해 재바인딩에도 equal.
 */
export function compareToolResponses(
  expected: { summary: string; json?: unknown },
  actual: { summary: string; json?: unknown },
  opts: { ignore?: string[]; fsDir?: string; params?: Record<string, string>; expectedParams?: Record<string, string> } = {},
): NormalizedDiff {
  // 기준은 기록 시점 params로 마스킹, 실제는 현재 params로 복원 (재바인딩에도 equal)
  const mask = (t: string, p?: Record<string, string>) => maskParamsValues(t, p ?? {});
  const restore = (t: string) => restoreParamsPlaceholders(t, opts.params ?? {});
  const expParams = opts.expectedParams ?? opts.params;
  const ej = fingerprintResponse(expected.json);
  const aj = fingerprintResponse(actual.json);
  if (ej !== undefined && aj !== undefined) {
    return compareNormalized(mask(JSON.stringify(ej), expParams), restore(JSON.stringify(aj)), opts.ignore ?? [], opts.fsDir, opts.params);
  }
  const str = (v: unknown): string => {
    const f = fingerprintResponse(v);
    return typeof f === "string" ? f : JSON.stringify(f);
  };
  return compareNormalized(mask(str(expected.summary), expParams), restore(str(actual.summary)), opts.ignore ?? [], opts.fsDir, opts.params);
}
