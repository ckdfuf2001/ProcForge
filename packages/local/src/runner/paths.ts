import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isEscapeRel } from "../artifacts.js";
import { logger } from "../logger.js";
import type { PathRole } from "@procforge/shared/schema.js";

export type { PathRole };

/** 이름 규칙 추론 결과. weakIn은 존재 여부로 in/out 확정 (M3.3-1) */
export type InferredRole = "in" | "out" | "weakIn" | undefined;

// 경로 역할 판정 + run fs 재작성 (M3.1-3, M3.2-3). path 인자만 재작성.

const OUT_EXACT = new Set(["output", "outfile", "out_file", "dest", "destination"]);
const IN_EXACT = new Set([
  "path", "file", "filepath", "file_path", "input", "infile", "in_file",
  "src", "source", "template", "dir", "directory", "folder", "cwd",
]);

/**
 * 인자명 규칙 (추정 순서 3단계, DECISIONS M3.1-3/M3.2-3/M3.3-1).
 * output 계열 → out. 이름 규칙의 in은 약한 추정(weakIn).
 */
export function inferPathRole(
  argName: string,
  inputSchema?: Record<string, unknown>,
): "in" | "out" | "weakIn" | undefined {
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
    return "weakIn";
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

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 확정된 역할의 인자만 run fs 기준으로 재작성 (M3.3-2).
 * 역할 확정 순서: 명시 roles → readOnly면 in → 인자명 규칙 → weakIn 존재 판정.
 * looksLikePath만으로는 재작성 금지(경고 로그만). URL 형태는 항상 제외.
 * - in: run fs 우선, allowProjectRead 시 projectRoot 폴백. 없으면 에러.
 *   in + fs 밖 절대경로 + 폴백 off → bad_request (M3.3-3).
 * - out: 존재 무관, run fs 아래로 매핑. fs 밖 절대경로는 거부.
 * - inout: run fs 안에 존재해야 함. 미존재 → bad_request (M3.3-4).
 * - weakIn: 존재 → in. 미존재 + 비-readOnly → out. 미존재 + readOnly → in(실패).
 * - 경계 검사는 isEscapeRel (prefix startsWith 금지).
 */
export function rewritePaths(
  args: Record<string, unknown>,
  roles: Record<string, PathRole | InferredRole | undefined>,
  opts: RewriteOpts,
): Record<string, unknown> {
  const base = resolve(opts.fsDir);
  const proot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
  const existsInScope = (v: string): boolean => {
    // M3.4-2: 폴백 off면 run fs만 검사
    if (isAbsolute(v)) return existsSync(v);
    const rel = v.split("\\").join("/");
    if (isEscapeRel(rel, "/")) return false;
    if (existsSync(resolve(base, rel))) return true;
    if (!opts.allowProjectRead) return false;
    return proot ? existsSync(resolve(proot, rel)) : false;
  };
  const fixtureError = (argName: string, v: string): Error =>
    Object.assign(new Error(`fixture 없음: ${argName}=${v}, record 모드로 재녹화`), { code: "bad_request" });
  const mapOne = (v: string, role: PathRole | InferredRole | undefined, argName: string): string => {
    let r: PathRole | undefined;
    if (role === "weakIn") {
      if (existsInScope(v)) r = "in";
      else if (!opts.toolReadOnly) r = "out";
      else r = "in";
    } else {
      r = role as PathRole | undefined;
    }
    if (!r) return v;
    // M3.4-3 절대경로 일원화
    if (isAbsolute(v)) {
      const abs = resolve(v);
      if (!isEscapeRel(posixRel(base, abs), "/")) {
        // run fs 안: 상대경로와 동일 규칙
        return mapRel(posixRel(base, abs), r, argName);
      }
      // run fs 밖: in + 폴백 on + 프로젝트 안 + 존재만 허용. 나머지 전부 거부
      if (
        r === "in" &&
        proot &&
        opts.allowProjectRead &&
        !isEscapeRel(posixRel(proot, abs), "/") &&
        existsSync(abs)
      ) {
        return abs;
      }
      if (r === "out") throw new Error(`출력 경로가 run fs 밖: ${argName}=${v}`);
      throw fixtureError(argName, v);
    }
    const rel = v.split("\\").join("/");
    if (isEscapeRel(rel, "/")) throw new Error(`경로 탈출: ${argName}=${v}`);
    return mapRel(rel, r, argName);
  };
  const mapRel = (rel: string, r: PathRole, argName: string): string => {
    if (r === "out") return resolve(base, rel);
    if (r === "inout") {
      const abs = resolve(base, rel);
      if (existsSync(abs)) return abs;
      throw fixtureError(argName, rel);
    }
    const fsAbs = resolve(base, rel);
    if (existsSync(fsAbs)) return fsAbs;
    if (proot && opts.allowProjectRead) {
      const pAbs = resolve(proot, rel);
      if (existsSync(pAbs)) return pAbs;
    }
    if (proot && !opts.allowProjectRead) throw fixtureError(argName, rel);
    throw new Error(`입력 없음: ${argName}=${rel}`);
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string" || URL_RE.test(v)) {
      out[k] = v; // URL 형태는 항상 제외 (M3.3-2)
      continue;
    }
    const role = roles[k];
    if (role === undefined) {
      // M3.4-1: readOnly는 확정 아님. 미확정은 경고 후 원문 유지.
      if (looksLikePath(v)) logger.warn("unconfirmed path kept", { arg: k, value: v });
      out[k] = v;
      continue;
    }
    out[k] = mapOne(v, role, k);
  }
  return out;
}
