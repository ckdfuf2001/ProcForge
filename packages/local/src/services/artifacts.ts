import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { isEscapeRel, appendManifestEntries, ingestArtifacts } from "../artifacts.js";
import { inferPathRole, looksLikePath } from "../runner/paths.js";
import { readCaptureRecord, readPreCopy, readSeedOriginal, toBaseRel, writeCaptureRecord } from "./snapshot.js";
import type { ArgSpec, Node, PathRole, ToolCatalogEntry } from "@procforge/shared/schema.js";
import { pfError } from "@procforge/shared/errors.js";

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
 * 인자 중 경로형 문자열을 baseDir 기준 절대경로로 (M3.5.1-3, 카세트 키 대조용).
 * URL·탈출·비경로는 원문 유지.
 */
export function absolutizePathArgs(baseDir: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    out[k] = toAbs(baseDir, v) ?? v;
  }
  return out;
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

export type CapJob = { p: string; kind: "in" | "inout" | "out" };

/**
 * 보고 시 수집 목록 조립 (M4.1-7 판정, M4.1.1-1 inout).
 * - 새로 생긴 파일(created) → out. 바뀐 파일(modified) → inout.
 * - 스냅샷이 있으면 둘 다 아닌 파일은 변경 없음 → in.
 * - 스냅샷 없으면 역할 기반 (in/inout 인자·응답 파일 → in, out 인자 → out).
 *   App이 폴백 판정분(원본 대비 변경)을 modifiedRels에 미리 넣어 호출한다.
 * - 호스트 제출분: 명시 입력(in).
 */
export function classifyReportPaths(input: {
  baseDir: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  catalogEntry?: ToolCatalogEntry;
  resultJson?: unknown;
  hostPaths?: string[];
  createdRels?: Set<string>;
  modifiedRels?: Set<string>;
}): CapJob[] {
  const relOf = (p: string) => toBaseRel(input.baseDir, p);
  const jobs: CapJob[] = [];
  const pushUnique = (p: string, kind: CapJob["kind"]) => {
    if (jobs.some((j) => j.p === p)) return;
    jobs.push({ p, kind });
  };
  const kindFor = (p: string): CapJob["kind"] => {
    const rel = relOf(p);
    if (input.createdRels?.has(rel)) return "out";
    if (input.modifiedRels?.has(rel)) return "inout";
    return "in";
  };
  for (const p of collectExistingPaths({ baseDir: input.baseDir, tool: input.tool, args: input.args, catalogEntry: input.catalogEntry, roles: ["in", "inout"] })) {
    pushUnique(p, kindFor(p));
  }
  for (const p of collectExistingPaths({ baseDir: input.baseDir, tool: input.tool, args: input.args, catalogEntry: input.catalogEntry, roles: ["out"] })) {
    pushUnique(p, "out");
  }
  if (input.resultJson !== undefined) {
    for (const p of collectResultFiles({ baseDir: input.baseDir, resultJson: input.resultJson })) {
      pushUnique(p, kindFor(p));
    }
  }
  for (const p of input.hostPaths ?? []) pushUnique(p, "in");
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

/** 수집 목록 ingest + in/out/inout 기록. 반환은 ingest 결과 그대로 */
export function ingestReportJobs(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  attemptId: string;
  baseDir: string;
  jobs: CapJob[];
  maxBytes: number;
  startIndex?: number;
  /** inout 원본 탐색 (M4.1.1-1). 없으면 unresolved로 기록 */
  resolveOriginal: (rel: string) => { buf: Buffer } | undefined;
}): { stored: string[]; contents: Record<string, string> } {
  const base = input.startIndex ?? 0;
  const relOf = (p: string) => toBaseRel(input.baseDir, p);
  const inPaths: string[] = [];
  const evidencePaths: string[] = [];
  const outPaths: string[] = [];
  for (const j of input.jobs) {
    if (j.kind === "inout") evidencePaths.push(j.p);
    else if (j.kind === "out") outPaths.push(j.p);
    else inPaths.push(j.p);
  }
  // 증거(수정본) 먼저, 원본은 마지막 (run fs 오버레이에서 원본이 이김)
  const ing = ingestArtifacts({
    procforgeDir: input.procforgeDir,
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    baseDir: input.baseDir,
    paths: [...inPaths, ...evidencePaths, ...outPaths],
    maxBytes: input.maxBytes,
    startIndex: base,
  });
  const storedIns = ing.stored.slice(0, inPaths.length);
  const storedEvidence = ing.stored.slice(inPaths.length, inPaths.length + evidencePaths.length);
  const storedOuts = ing.stored.slice(inPaths.length + evidencePaths.length);
  const contents = { ...ing.contents };
  const inouts: string[] = [];
  const unresolved: string[] = [];
  let idx = base + inPaths.length + evidencePaths.length + outPaths.length;
  for (const p of evidencePaths) {
    const rel = relOf(p);
    const orig = input.resolveOriginal(rel);
    if (!orig) {
      unresolved.push(rel);
      continue;
    }
    const o = ingestOriginalFixture({
      procforgeDir: input.procforgeDir,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      rel,
      buf: orig.buf,
      index: idx++,
      maxBytes: input.maxBytes,
    });
    storedIns.push(o.stored);
    inouts.push(o.stored);
    Object.assign(contents, o.contents);
  }
  const stored = [...storedIns, ...storedEvidence, ...storedOuts];
  // in/out 기록 (확정 시 out은 golden에서 제외, inout 원본은 유지)
  appendCaptureRecord(input.procforgeDir, input.sessionId, input.nodeId, input.attemptId, {
    ins: storedIns,
    outs: [...storedEvidence, ...storedOuts],
    inouts,
    ...(unresolved.length > 0 ? { unresolvedInouts: unresolved } : {}),
  });
  return { stored, contents };
}

/** 캡처 기록 추가 (M4.1.1-1, 확정 시 추캡처분 병합용) */
export function appendCaptureRecord(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  attemptId: string,
  add: { ins: string[]; outs: string[]; inouts: string[]; unresolvedInouts?: string[] },
): void {
  const cur = readCaptureRecord(procforgeDir, sessionId, nodeId, attemptId);
  writeCaptureRecord(procforgeDir, sessionId, nodeId, attemptId, {
    ins: [...(cur?.ins ?? []), ...add.ins],
    outs: [...(cur?.outs ?? []), ...add.outs],
    inouts: [...(cur?.inouts ?? []), ...add.inouts],
    ...((cur?.unresolvedInouts?.length ?? 0) > 0 || (add.unresolvedInouts?.length ?? 0) > 0
      ? { unresolvedInouts: [...(cur?.unresolvedInouts ?? []), ...(add.unresolvedInouts ?? [])] }
      : {}),
  });
}

/**
 * inout 원본 탐색 (M4.1.1-1): seed → 앞 노드 캡처 기록 → pf_next 시점 사본.
 * 앞 노드는 id 문자열 순(생성 순서 근사), 같은 파일은 증거(outs) 우선(종료 상태).
 */
export function resolveOriginal(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  rel: string;
  nodes: Node[];
  manifest: Record<string, string>;
}): { buf: Buffer; from: "seed" | "capture" | "precopy" } | undefined {
  const seed = readSeedOriginal(input.procforgeDir, input.sessionId, input.rel);
  if (seed) return { buf: seed, from: "seed" };
  const earlier = input.nodes
    .filter((n) => n.id !== input.nodeId && n.id < input.nodeId)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  for (const n of earlier) {
    for (const att of [...n.attempts].reverse()) {
      const rec = readCaptureRecord(input.procforgeDir, input.sessionId, n.id, att.id);
      if (!rec) continue;
      for (const fx of [...rec.outs, ...rec.ins, ...rec.inouts]) {
        if (input.manifest[fx] !== input.rel) continue;
        try {
          const p = join(input.procforgeDir, "sessions", input.sessionId, fx);
          if (!existsSync(p)) continue;
          return { buf: readFileSync(p), from: "capture" };
        } catch {
          // 다음 후보
        }
      }
    }
  }
  const pre = readPreCopy(input.procforgeDir, input.sessionId, input.nodeId, input.rel);
  if (pre) return { buf: pre, from: "precopy" };
  return undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * 메모리 원본 fixture 저장 (M4.1.1-1, inout replay 입력).
 * ingestArtifacts와 같은 fixtures/<node>/<attempt>/ 레이아웃 + manifest.
 */
export function ingestOriginalFixture(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  attemptId: string;
  /** 원본 기준 상대경로 (manifest 값) */
  rel: string;
  buf: Buffer;
  index: number;
  maxBytes: number;
}): { stored: string; contents: Record<string, string> } {
  if (input.buf.length > input.maxBytes) {
    throw pfError("bad_request", `artifact too large: ${input.rel} (${input.buf.length} > ${input.maxBytes})`);
  }
  const base = input.rel.split("/").pop() ?? "file";
  const destRel = join("fixtures", input.nodeId, input.attemptId, `${input.index}-${base}`);
  const destAbs = join(input.procforgeDir, "sessions", input.sessionId, destRel);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, input.buf);
  const key = destRel.replace(/\\/g, "/");
  appendManifestEntries(input.procforgeDir, input.sessionId, { [key]: input.rel });
  const contents: Record<string, string> = {};
  if (input.buf.includes(0)) {
    const mime = MIME_BY_EXT[extname(input.rel).toLowerCase()] ?? "application/octet-stream";
    contents[key] = JSON.stringify({
      nonText: true,
      sha256: createHash("sha256").update(input.buf).digest("hex"),
      size: input.buf.length,
      mime,
    });
  } else {
    contents[key] = input.buf.toString("utf8");
  }
  return { stored: key, contents };
}
