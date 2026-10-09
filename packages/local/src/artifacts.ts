import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative, basename, dirname, sep, isAbsolute, extname } from "node:path";
import type { ArgSpec } from "@procforge/shared/schema.js";
import { writeAtomicFile } from "./fsutil.js";

// 호스트는 경로만 제출, 실제 읽기·복사는 local이 수행 (M2).
// - 프로젝트 루트 밖 경로 거부, 심볼릭 링크 탈출 거부
// - fixtures/<nodeId>/<attemptId>/ 로 복사, Attempt.artifacts에는 fixture 상대경로 기록

/** 상대경로 탈출 판정 순수 함수 (M2.6-3). "..data.json"은 허용, ".." 상위는 거부. */
export function isEscapeRel(rel: string, pathSep: string = sep): boolean {
  if (isAbsolute(rel)) return true;
  let depth = 0;
  for (const part of rel.split(pathSep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

export function assertSafePath(projectRoot: string, p: string): string {
  const root = resolve(projectRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  // rel === "" (루트 자체)도 파일이 아니므로 거부
  if (rel === "" || isEscapeRel(rel)) {
    throw Object.assign(new Error(`path escapes project root: ${p}`), { code: "bad_request" });
  }
  if (!existsSync(abs)) throw Object.assign(new Error(`artifact not found: ${p}`), { code: "bad_request" });
  // 심볼릭 링크 탈출 검사: 실체도 루트 안이어야 함
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw Object.assign(new Error(`cannot resolve: ${p}`), { code: "bad_request" });
  }
  if (isEscapeRel(relative(root, real))) {
    throw Object.assign(new Error(`symlink escapes project root: ${p}`), { code: "bad_request" });
  }
  return abs;
}

/** fixtures-manifest.json 실제 경로 (stored → 원본 기준 상대경로, runner가 run fs 구성에 사용) */
export function manifestFile(procforgeDir: string, sessionId: string): string {
  return join(procforgeDir, "sessions", sessionId, "fixtures-manifest.json");
}

export function readManifest(procforgeDir: string, sessionId: string): Record<string, string> {
  const p = manifestFile(procforgeDir, sessionId);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function appendManifest(procforgeDir: string, sessionId: string, entries: Record<string, string>): void {
  const p = manifestFile(procforgeDir, sessionId);
  const cur = readManifest(procforgeDir, sessionId);
  Object.assign(cur, entries);
  writeAtomicFile(p, JSON.stringify(cur, null, 2));
}

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".j2": "text/plain",
  ".xml": "application/xml",
  ".html": "text/html",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type Ingested = {
  /** Attempt.artifacts에 기록할 fixture 상대경로들 */
  stored: string[];
  /** checker에 전달할 내용 맵 (stored 경로 → utf8 텍스트 또는 바이너리 메타 JSON) */
  contents: Record<string, string>;
};

export function ingestArtifacts(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  attemptId: string;
  /** 경로 기준 디렉터리 (strict sandbox on이면 sandbox/<sid>, off면 projectRoot) */
  baseDir: string;
  paths: string[];
  maxBytes?: number;
}): Ingested {
  const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
  const stored: string[] = [];
  const contents: Record<string, string> = {};
  const manifestEntries: Record<string, string> = {};
  const base = resolve(input.baseDir);
  input.paths.forEach((p, i) => {
    const abs = assertSafePath(input.baseDir, p);
    const size = statSync(abs).size;
    if (size > maxBytes) {
      throw Object.assign(new Error(`artifact too large: ${p} (${size} > ${maxBytes})`), { code: "bad_request" });
    }
    const buf = readFileSync(abs);
    const destRel = join("fixtures", input.nodeId, input.attemptId, `${i}-${basename(abs)}`);
    const destAbs = join(input.procforgeDir, "sessions", input.sessionId, destRel);
    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(abs, destAbs);
    const key = destRel.replace(/\\/g, "/");
    stored.push(key);
    manifestEntries[key] = relative(base, abs).replace(/\\/g, "/");
    if (buf.includes(0)) {
      // 바이너리: 내용 대신 메타만 전달 (M2.6-6)
      const mime = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "application/octet-stream";
      contents[key] = JSON.stringify({
        nonText: true,
        sha256: createHash("sha256").update(buf).digest("hex"),
        size,
        mime,
      });
    } else {
      contents[key] = buf.toString("utf8");
    }
  });
  appendManifest(input.procforgeDir, input.sessionId, manifestEntries);
  return { stored, contents };
}

/**
 * confirm_leaf fixed 인자 정규화 (M3.2-2): sandbox/<sid>/·프로젝트 루트 아래 절대경로 → 상대경로.
 * 그 외 절대경로는 유지 + warnings. 기존 세션 마이그레이션에도 재사용 (runner).
 */
export function normalizeArgSpecs(
  specs: Record<string, ArgSpec>,
  opts: { sandboxDir: string; projectRoot: string },
): { specs: Record<string, ArgSpec>; warnings: string[] } {
  const sb = resolve(opts.sandboxDir);
  const proot = resolve(opts.projectRoot);
  const warnings: string[] = [];
  const out: Record<string, ArgSpec> = {};
  for (const [k, spec] of Object.entries(specs)) {
    if (spec.kind !== "fixed" || typeof (spec as { value: unknown }).value !== "string") {
      out[k] = spec;
      continue;
    }
    const v = (spec as { value: string }).value;
    if (!isAbsolute(v)) {
      out[k] = spec;
      continue;
    }
    const norm = (s: string) => s.replace(/\\/g, "/");
    if (!isEscapeRel(relative(sb, v).split(sep).join("/"), "/")) {
      out[k] = { ...spec, value: norm(relative(sb, v)) };
    } else if (!isEscapeRel(relative(proot, v).split(sep).join("/"), "/")) {
      out[k] = { ...spec, value: norm(relative(proot, v)) };
    } else {
      warnings.push(`절대경로 유지: ${k}=${v} (sandbox·프로젝트 밖)`);
      out[k] = spec;
    }
  }
  return { specs: out, warnings };
}

export function setupSandbox(input: {
  procforgeDir: string;
  sessionId: string;
  projectRoot: string;
  seedFiles: string[];
}): { sandboxDir: string; copied: string[] } {
  const sandboxDir = join(input.procforgeDir, "sandbox", input.sessionId);
  const copied: string[] = [];
  for (const f of input.seedFiles) {
    const abs = assertSafePath(input.projectRoot, f);
    const rel = relative(resolve(input.projectRoot), abs);
    const dest = join(sandboxDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    copied.push(rel);
  }
  return { sandboxDir, copied };
}
