import { existsSync } from "node:fs";
import type { ArgSpec, Attempt } from "@procforge/shared/schema.js";

// 인자 해석 (M3): fixed 그대로, var는 params+이전 출력, generated는 replay 기록값/live 에러.

export function resolveArgs(input: {
  specs: Record<string, ArgSpec>;
  params: Record<string, string>;
  outputs: Map<string, unknown>;
  /** generated 인자 출처 탐색용 (M3.1-5) */
  attempts: Attempt[];
  /** golden.attemptId (없으면 마지막 pass attempt로 마이그레이션) */
  goldenAttemptId?: string;
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
      out[k] = resolveGenerated(k, input.attempts, input.goldenAttemptId);
    }
  }
  return out;
}

/** generated 인자는 golden.attemptId attempt의 args에서만 (M3.1-5) */
export function resolveGenerated(k: string, attempts: Attempt[], goldenAttemptId?: string): unknown {
  if (goldenAttemptId) {
    const a = attempts.find((x) => x.id === goldenAttemptId);
    if (!a) throw new Error(`golden attempt 없음: ${goldenAttemptId}`);
    if (!(k in a.args)) throw new Error(`golden attempt에 인자 없음: ${k}`);
    return a.args[k];
  }
  const last = [...attempts].reverse().find((x) => x.verdict === "pass");
  if (!last) throw new Error(`pass attempt 없음: generated '${k}' 해석 불가`);
  if (!(k in last.args)) throw new Error(`generated 인자 '${k}'의 기록값 없음`);
  return last.args[k];
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
