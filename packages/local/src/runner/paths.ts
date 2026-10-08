import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isEscapeRel } from "../artifacts.js";
import type { PathRole } from "@procforge/shared/schema.js";

export type { PathRole };

// 경로 역할 판정 + run fs 재작성 (M3.1-3, M3.2-3). path 인자만 재작성.

const OUT_EXACT = new Set(["output", "outfile", "out_file", "dest", "destination"]);
const IN_EXACT = new Set([
  "path", "file", "filepath", "file_path", "input", "infile", "in_file",
  "src", "source", "template", "dir", "directory", "folder", "cwd",
]);

/**
 * 인자명 규칙 (추정 순서 3단계, DECISIONS M3.1-3/M3.2-3).
 * output/outfile/dest 계열 → out. path/file/input/src/template/dir 계열 → in.
 */
export function inferPathRole(
  argName: string,
  inputSchema?: Record<string, unknown>,
): "in" | "out" | undefined {
  const lower = argName.toLowerCase();
  if (
    OUT_EXACT.has(lower) ||
    lower.startsWith("out_") ||
    lower.startsWith("output") ||
    lower.startsWith("dest_") ||
    /^(out|output|dest)[_-]?(path|file|dir|folder)$/.test(lower)
  ) {
    return "out";
  }
  if (
    IN_EXACT.has(lower) ||
    lower.includes("template") ||
    lower.includes("file") ||
    lower.includes("path") ||
    lower.includes("input") ||
    lower.startsWith("in_") ||
    lower.startsWith("src_")
  ) {
    return "in";
  }
  const props = (inputSchema?.["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const fmt = props[argName]?.["format"];
  if (typeof fmt === "string" && ["uri", "file", "path", "file-path", "directory"].includes(fmt)) return "in";
  return undefined;
}

function posixRel(fsDir: string, abs: string): string {
  return relative(fsDir, abs).split(sep).join("/");
}

function looksLikePath(v: string): boolean {
  if (v.length === 0 || v.length > 512 || v.includes("\n")) return false;
  return /[/\\]/.test(v) || /\.[A-Za-z0-9]{1,5}$/.test(v);
}

export type RewriteOpts = {
  fsDir: string;
  projectRoot?: string;
  /** projectRoot 읽기 폴백 (기본 false, M3.2-4) */
  allowProjectRead?: boolean;
  /** 도구 readOnlyHint (M3.2-3 추정 2·4단계용) */
  toolReadOnly?: boolean;
};

/**
 * path 역할 인자만 run fs 기준으로 재작성.
 * 역할 확정 순서: 명시 roles → readOnly면 in → 인자명 규칙 → 파일 미존재 & 비-readOnly면 out.
 * - in: run fs 우선, allowProjectRead 시 projectRoot 폴백. 없으면 에러.
 * - out/inout: 존재 무관, run fs 아래로 매핑. fs 밖 절대경로는 거부.
 * - 경계 검사는 isEscapeRel (prefix startsWith 금지).
 */
export function rewritePaths(
  args: Record<string, unknown>,
  roles: Record<string, PathRole | undefined>,
  opts: RewriteOpts,
): Record<string, unknown> {
  const base = resolve(opts.fsDir);
  const proot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
  const existsInScope = (v: string): boolean => {
    if (isAbsolute(v)) return existsSync(v);
    const rel = v.split("\\").join("/");
    if (isEscapeRel(rel, "/")) return false;
    if (existsSync(resolve(base, rel))) return true;
    return proot ? existsSync(resolve(proot, rel)) : false;
  };
  const mapOne = (v: string, role: PathRole | undefined, argName: string): string => {
    let r: PathRole | undefined = role;
    if (!r && opts.toolReadOnly) r = "in";
    if (!r && !opts.toolReadOnly && looksLikePath(v) && !existsInScope(v)) r = "out";
    if (!r && existsInScope(v)) r = "in";
    if (!r) return v;
    if (isAbsolute(v)) {
      if (!isEscapeRel(posixRel(base, resolve(v)), "/")) return resolve(v);
      if (r === "out" || r === "inout") throw new Error(`출력 경로가 run fs 밖: ${argName}=${v}`);
      return v;
    }
    const rel = v.split("\\").join("/");
    if (isEscapeRel(rel, "/")) throw new Error(`경로 탈출: ${argName}=${v}`);
    if (r === "out" || r === "inout") {
      const abs = resolve(base, rel);
      if (r === "out" || existsSync(abs)) return abs;
      return abs; // inout 미존재: 생성 대상으로 매핑
    }
    const fsAbs = resolve(base, rel);
    if (existsSync(fsAbs)) return fsAbs;
    if (proot && opts.allowProjectRead) {
      const pAbs = resolve(proot, rel);
      if (existsSync(pAbs)) return pAbs;
    }
    if (proot && !opts.allowProjectRead) {
      throw Object.assign(new Error(`fixture 없음: ${argName}=${v}, record 모드로 재녹화`), { code: "bad_request" });
    }
    throw new Error(`입력 없음: ${argName}=${v}`);
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const role = roles[k];
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    if (role === undefined && !looksLikePath(v)) {
      out[k] = v; // 경로처럼 보이지 않으면 손대지 않음
      continue;
    }
    out[k] = mapOne(v, role, k);
  }
  return out;
}
