import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isEscapeRel } from "../artifacts.js";

// 경로 역할 판정 + run fs 재작성 (M3.1-3). path 인자만 재작성.

export type PathRole = "in" | "out";

const OUT_EXACT = new Set(["output", "outfile", "out_file", "dest", "destination"]);
const IN_EXACT = new Set([
  "path", "file", "filepath", "file_path", "input", "infile", "in_file",
  "src", "source", "template", "dir", "directory", "folder", "cwd",
]);

/**
 * 추정 규칙 (DECISIONS M3.1-3):
 * 1. ArgSpec.path 명시 우선 (호출자가 전달)
 * 2. 인자명: output/outfile/dest 계열 → out. path/file/input/src/template/dir 계열 → in
 * 3. inputSchema properties[name].format in {uri,file,file-path,path,directory} → in
 * 4. 그 외 undefined (재작성 안 함)
 */
export function inferPathRole(
  argName: string,
  inputSchema?: Record<string, unknown>,
): PathRole | undefined {
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

/**
 * path 역할 인자만 run fs 기준으로 재작성.
 * - in: run fs 우선, 없으면 projectRoot(읽기 전용 폴백). 둘 다 없으면 에러
 * - out: 존재 무관, run fs 아래로 매핑. fs 밖 절대경로는 거부
 * - 경계 검사는 isEscapeRel (prefix startsWith 금지)
 */
export function rewritePaths(
  args: Record<string, unknown>,
  roles: Record<string, PathRole | undefined>,
  fsDir: string,
  projectRoot?: string,
): Record<string, unknown> {
  const base = resolve(fsDir);
  const proot = projectRoot ? resolve(projectRoot) : undefined;
  const mapOne = (v: string, role: PathRole, argName: string): string => {
    if (isAbsolute(v)) {
      const inside = posixRel(base, resolve(v));
      if (!isEscapeRel(inside, "/")) return resolve(v);
      if (role === "out") throw new Error(`출력 경로가 run fs 밖: ${argName}=${v}`);
      return v; // in + fs 밖 절대경로: 도구가 실패하도록 원문 유지
    }
    const rel = v.split("\\").join("/");
    if (isEscapeRel(rel, "/")) throw new Error(`경로 탈출: ${argName}=${v}`);
    if (role === "out") return resolve(base, rel);
    const fsAbs = resolve(base, rel);
    if (existsSync(fsAbs)) return fsAbs;
    if (proot) {
      const pAbs = resolve(proot, rel);
      if (existsSync(pAbs)) return pAbs;
    }
    throw new Error(`입력 없음: ${argName}=${v}`);
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const role = roles[k];
    if (role === undefined || typeof v !== "string") {
      out[k] = v;
      continue;
    }
    out[k] = mapOne(v, role, k);
  }
  return out;
}
