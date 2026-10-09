import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isEscapeRel, ingestArtifacts } from "../artifacts.js";
import { inferPathRole, looksLikePath } from "../runner/paths.js";
import { toBaseRel, writeCaptureRecord } from "./snapshot.js";
import type { ArgSpec, PathRole, ToolCatalogEntry } from "@procforge/shared/schema.js";

// 산출물 수집·ingest orchestration (M3.6-2/3 입력·출력 자동 캡처, M4.1-7 판정).
// App 경유, 어댑터 직접 호출 금지. 존재하는 파일만, baseDir 밖 제외 (best-effort).

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

export type CapJob = { p: string; out: boolean };

/**
 * 보고 시 수집 목록 조립 (M4.1-7 판정).
 * - in/inout 인자 + 응답 JSON 파일: 스냅샷상 새로 생기거나 바뀌면 out, 아니면 in.
 * - out 인자: 항상 out. 호스트 제출분: 명시 입력(in).
 * - outRels 미지정(스냅샷 없음 폴백) 시 스냅샷 판정 없이 역할대로 분류.
 */
export function classifyReportPaths(input: {
  baseDir: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  catalogEntry?: ToolCatalogEntry;
  resultJson?: unknown;
  hostPaths?: string[];
  outRels?: Set<string>;
}): CapJob[] {
  const relOf = (p: string) => toBaseRel(input.baseDir, p);
  const jobs: CapJob[] = [];
  const pushUnique = (p: string, out: boolean) => {
    if (jobs.some((j) => j.p === p)) return;
    jobs.push({ p, out });
  };
  for (const p of collectExistingPaths({ baseDir: input.baseDir, tool: input.tool, args: input.args, catalogEntry: input.catalogEntry, roles: ["in", "inout"] })) {
    pushUnique(p, input.outRels?.has(relOf(p)) ?? false);
  }
  for (const p of collectExistingPaths({ baseDir: input.baseDir, tool: input.tool, args: input.args, catalogEntry: input.catalogEntry, roles: ["out"] })) {
    pushUnique(p, true);
  }
  if (input.resultJson !== undefined) {
    for (const p of collectResultFiles({ baseDir: input.baseDir, resultJson: input.resultJson })) {
      pushUnique(p, input.outRels?.has(relOf(p)) ?? false);
    }
  }
  for (const p of input.hostPaths ?? []) pushUnique(p, false);
  return jobs;
}

/** 확정 시도 fixture 내용 읽기 (M4, pf_advise 평가용. 텍스트 200KB 상한) */
export function readFixtureContents(input: {
  procforgeDir: string;
  sessionId: string;
  artifacts: string[];
}): Record<string, string> | undefined {
  if (input.artifacts.length === 0) return undefined;
  const contents: Record<string, string> = {};
  for (const fx of input.artifacts) {
    try {
      contents[fx] = readFileSync(join(input.procforgeDir, "sessions", input.sessionId, fx), "utf8").slice(0, 200000);
    } catch {
      // 읽기 실패 파일은 제외
    }
  }
  return contents;
}

/** 수집 목록 ingest + in/out 기록. 반환은 ingest 결과 그대로 */
export function ingestReportJobs(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  attemptId: string;
  baseDir: string;
  jobs: CapJob[];
  maxBytes: number;
}): { stored: string[]; contents: Record<string, string> } {
  if (input.jobs.length === 0) return { stored: [], contents: {} };
  const ing = ingestArtifacts({
    procforgeDir: input.procforgeDir,
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    baseDir: input.baseDir,
    paths: input.jobs.map((j) => j.p),
    maxBytes: input.maxBytes,
  });
  // in/out 기록 (확정 시 out은 golden에서 제외)
  writeCaptureRecord(input.procforgeDir, input.sessionId, input.nodeId, input.attemptId, {
    ins: ing.stored.filter((_, i) => !input.jobs[i].out),
    outs: ing.stored.filter((_, i) => input.jobs[i].out),
  });
  return ing;
}
