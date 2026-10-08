import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArgSpec } from "@procforge/shared/schema.js";

// 인자 해석 (M3): fixed 그대로, var는 params+이전 출력, generated는 replay 기록값/live 에러.

export function resolveArgs(input: {
  specs: Record<string, ArgSpec>;
  params: Record<string, string>;
  outputs: Map<string, unknown>;
  lastAttemptArgs: Record<string, unknown>;
  live: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(input.specs)) {
    if (spec.kind === "fixed") {
      out[k] = (spec as { value: unknown }).value;
    } else if (spec.kind === "var") {
      out[k] = resolveVar((spec as { ref: string }).ref, input.params, input.outputs);
    } else {
      if (input.live) throw new Error(`generated 인자 '${k}'는 live 모드 미지원 (M5 이후)`);
      if (!(k in input.lastAttemptArgs)) throw new Error(`generated 인자 '${k}'의 기록값 없음 (golden/attempt 부재)`);
      out[k] = input.lastAttemptArgs[k];
    }
  }
  return out;
}

function getByDot(root: unknown, path: string): unknown {
  let cur = root;
  for (const p of path.split(".")) {
    if (cur === null || cur === undefined) throw new Error(`참조 경로 없음: ${path}`);
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) throw new Error(`참조 경로 없음: ${path}`);
      cur = cur[i];
    } else if (typeof cur === "object") {
      if (!(p in (cur as Record<string, unknown>))) throw new Error(`참조 경로 없음: ${path}`);
      cur = (cur as Record<string, unknown>)[p];
    } else {
      throw new Error(`참조 경로 없음: ${path}`);
    }
  }
  return cur;
}

export function resolveVar(ref: string, params: Record<string, string>, outputs: Map<string, unknown>): unknown {
  const pm = /^\$\{params\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
  if (pm) {
    if (!(pm[1] in params)) throw new Error(`params 참조 없음: ${pm[1]}`);
    return params[pm[1]];
  }
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) throw new Error(`지원하지 않는 참조: ${ref}`);
  const [, nid, rest] = m;
  if (!outputs.has(nid)) throw new Error(`노드 출력 없음: ${nid}`);
  const base = outputs.get(nid);
  if (rest === "" || rest === ".output") return base;
  if (rest.startsWith(".output.")) return getByDot(base, rest.slice(".output.".length));
  throw new Error(`지원하지 않는 참조: ${ref}`);
}

/**
 * 실행 인자의 프로젝트 상대경로 문자열을 run fs 절대경로로 재작성.
 * run fs에 해당 파일이 있을 때만 재작성 (없으면 원문 유지 → 도구가 실패).
 */
export function rewritePaths(args: Record<string, unknown>, fsDir: string): Record<string, unknown> {
  const rw = (v: unknown): unknown => {
    if (typeof v === "string" && v.length > 0 && v.length < 512 && !v.includes("\n") && !v.startsWith("RUNFS/")) {
      const cand = resolve(fsDir, v);
      if (existsSync(cand) && cand.startsWith(resolve(fsDir))) return cand;
      return v;
    }
    if (Array.isArray(v)) return v.map(rw);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = rw(val);
      return out;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = rw(v);
  return out;
}
