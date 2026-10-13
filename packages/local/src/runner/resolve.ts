import { existsSync } from "node:fs";
import type { ArgSpec, Attempt } from "@procforge/shared/schema.js";

// 인자 해석 (M3): fixed 그대로, var는 params+이전 출력, generated는 replay 기록값/live 에러.
// M5: supplied 값이 있으면 우선 사용.

export type OutputTopo = {
  isSplit: (id: string) => boolean;
  childrenOf: (id: string) => string[];
};

/** map 항목 컨텍스트 (M5.5-1): ${as} / ${as.path} 해결용 */
export type ItemContext = {
  name: string;
  value: unknown;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ${as} / ${as.path} 치환 (M5.5-1).
 * 전체가 단일 참조면 원시값(객체 포함) 반환, 임베디드는 문자열 치환.
 * 경로 없음 → throw (호출자가 항목 fail 처리).
 */
export function substituteItemVars(text: string, as: string, item: unknown): unknown {
  const full = new RegExp(`^\\$\\{${escapeRegExp(as)}(\\.[A-Za-z0-9_.-]+)?\\}$`).exec(text);
  if (full) {
    if (!full[1]) return item;
    return getByDot(item, full[1].slice(1));
  }
  if (!text.includes("${")) return text;
  return text.replace(
    new RegExp(`\\$\\{${escapeRegExp(as)}(\\.[A-Za-z0-9_.-]+)?\\}`, "g"),
    (_m: string, p?: string) => {
      const v = !p ? item : getByDot(item, p.slice(1));
      return typeof v === "string" ? v : JSON.stringify(v) ?? "";
    },
  );
}

/** argSpecs 깊은 복사 + 모든 문자열 리프에 ${as} 치환 (M5.5-1).
 * 치환 후 참조가 남지 않은 var는 fixed로 전환 (실행 시점 값 확정). */
export function substituteItemSpecs(
  specs: Record<string, ArgSpec>,
  as: string,
  item: unknown,
): Record<string, ArgSpec> {
  const deep = (v: unknown): unknown => {
    if (typeof v === "string") return substituteItemVars(v, as, item);
    if (Array.isArray(v)) return v.map(deep);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deep(x);
      return out;
    }
    return v;
  };
  const out: Record<string, ArgSpec> = {};
  for (const [k, spec] of Object.entries(specs)) {
    if (spec.kind === "var" && typeof (spec as { ref?: unknown }).ref === "string") {
      const r = substituteItemVars((spec as unknown as { ref: string }).ref, as, item);
      if (typeof r !== "string" || (!r.includes("${") && !r.startsWith("$"))) {
        const s = spec as unknown as { path?: unknown };
        out[k] = { kind: "fixed", value: r, ...(s.path !== undefined ? { path: s.path as never } : {}) } as ArgSpec;
        continue;
      }
      out[k] = { ...spec, ref: r } as ArgSpec;
      continue;
    }
    out[k] = deep(spec) as ArgSpec;
  }
  return out;
}

export function resolveArgs(input: {
  specs: Record<string, ArgSpec>;
  params: Record<string, string>;
  outputs: Map<string, unknown>;
  /** generated 인자 출처 탐색용 (M3.1-5) */
  attempts: Attempt[];
  /** golden.attemptId (없으면 마지막 pass attempt로 마이그레이션) */
  goldenAttemptId?: string;
  live: boolean;
  /** split 출력 조립용 토폴로지 (M3.3-6) */
  topo?: OutputTopo;
  /** M5 공급값 (이 노드 키→값, generated 우선) */
  supplied?: Record<string, unknown>;
  /** M5.5-2 until 전달값 */
  selfCarry?: { present: boolean; value: unknown };
  /** M5.5-3 실행 간 상태 */
  state?: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(input.specs)) {
    if (spec.kind === "fixed") {
      out[k] = (spec as { value: unknown }).value;
    } else if (spec.kind === "var") {
      out[k] = resolveVar((spec as { ref: string }).ref, input.params, input.outputs, input.topo, undefined, input.selfCarry, input.state);
    } else if (spec.kind === "script") {
      // M5.2-2: 스크립트 지정은 해석 대상 아님. 파일 위치는 finalize/import가
      // 절차서 기준으로 재작성하므로 여기서는 원문 유지 (execNode가 처리).
      out[k] = (spec as { file: string }).file;
    } else {
      if (input.supplied && Object.prototype.hasOwnProperty.call(input.supplied, k)) {
        out[k] = input.supplied[k];
        continue;
      }
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

export function getByDot(root: unknown, path: string): unknown {
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

/**
 * M5.5-4.4-2: 참조 문자열에서 상류 노드 id 수집 (resolveVar와 같은 문법).
 * $N... 전체 참조 → [N]. ${params.*}·${state.*}·${item*}·$self →
 * 실행 시점 값이라 내용 고정이 아니므로 []. resolveVar가 throw하는 형식도 [].
 */
export function collectRefNodeIds(ref: string): string[] {
  if (typeof ref !== "string") return [];
  if (ref === "$self") return [];
  if (ref.includes("${state.")) return [];
  if (/^\$\{params\.[A-Za-z0-9_.-]+\}$/.test(ref)) return [];
  if (ref.includes("${params.")) return [];
  if (ref.startsWith("${")) return [];
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) return [];
  return [m[1]];
}

export function resolveVar(
  ref: string,
  params: Record<string, string>,
  outputs: Map<string, unknown>,
  topo?: OutputTopo,
  itemCtx?: ItemContext,
  selfCarry?: { present: boolean; value: unknown },
  /** M5.5-3 실행 간 상태 */
  state?: Record<string, unknown>,
): unknown {
  const pm = /^\$\{params\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
  if (pm) {
    if (!(pm[1] in params)) throw new Error(`params 참조 없음: ${pm[1]}`);
    return params[pm[1]];
  }
  // M5.5-1: map 항목 참조 (${as} / ${as.path}). 항목 컨텍스트가 있을 때만.
  if (itemCtx) {
    const im = new RegExp(`^\\$\\{${escapeRegExp(itemCtx.name)}(\\.[A-Za-z0-9_.-]+)?\\}$`).exec(ref);
    if (im) {
      if (!im[1]) return itemCtx.value;
      return getByDot(itemCtx.value, im[1].slice(1));
    }
  }
  // M5.5-2: until 전달값 ($self bare). 전달 없으면 undefined (첫 페이지 관례).
  if (ref === "$self") {
    return selfCarry && selfCarry.present ? selfCarry.value : undefined;
  }
  // M5.5-3: 실행 간 상태 (${state.k} 전체, 임베디드 치환)
  if (ref.includes("${state.")) {
    if (!state) throw new Error("state 없음 (run 시작 시 로드 실패 또는 미지원 경로)");
    const missing: string[] = [];
    const out = ref.replace(/\$\{state\.([A-Za-z0-9_.-]+)\}/g, (_m: string, k: string) => {
      if (!Object.prototype.hasOwnProperty.call(state, k)) {
        missing.push(k);
        return "";
      }
      const v = (state as Record<string, unknown>)[k];
      return typeof v === "string" ? v : JSON.stringify(v) ?? "";
    });
    if (missing.length > 0) throw new Error(`state 키 없음: ${missing.join(",")}`);
    // 전체 참조면 원시값 유지
    const full = /^\$\{state\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
    if (full && Object.prototype.hasOwnProperty.call(state, full[1])) {
      return (state as Record<string, unknown>)[full[1]];
    }
    return out;
  }
  // M5.1-B3: 문자열 내 템플릿 치환 ("sales-${params.month}.xlsx" 등)
  if (ref.includes("${params.")) {
    return ref.replace(/\$\{params\.([A-Za-z0-9_.-]+)\}/g, (m, k: string) => {
      if (!(k in params)) throw new Error(`params 참조 없음: ${k}`);
      return params[k];
    });
  }
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) throw new Error(`지원하지 않는 참조: ${ref}`);
  const [, nid, rest] = m;
  // split 노드 출력 = { [childId]: output } 객체 (M3.3-6)
  if (topo?.isSplit(nid)) {
    const obj: Record<string, unknown> = {};
    for (const c of topo.childrenOf(nid)) {
      if (!outputs.has(c)) throw new Error(`split 자식 출력 없음: ${c}`);
      obj[c] = outputs.get(c);
    }
    if (rest === "") return obj;
    if (rest.startsWith(".output.")) return getByDot(obj, rest.slice(".output.".length));
    // M5.2-4 약식 + M5.8.2-1: ".output" 단독도 필드 ("$N.output"은 output 필드).
    if (/^\.[A-Za-z][A-Za-z0-9_.-]*$/.test(rest)) return getByDot(obj, rest.slice(1));
    throw new Error(`지원하지 않는 참조: ${ref}`);
  }
  if (!outputs.has(nid)) throw new Error(`노드 출력 없음: ${nid}`);
  const base = outputs.get(nid);
  // M5.8.2-1: "$N"만 전체. ".output" 단독은 output 필드.
  if (rest === "") return base;
  if (rest.startsWith(".output.")) return getByDot(base, rest.slice(".output.".length));
  if (/^\.[A-Za-z][A-Za-z0-9_.-]*$/.test(rest)) return getByDot(base, rest.slice(1));
  throw new Error(`지원하지 않는 참조: ${ref}`);
}

/**
 * M5.3.1-1: ${params.k} 치환 (알려진 키만, 나머지는 원문 유지, throw 없음).
 * file_exists 등 경로 스펙의 실행 시점 해석용.
 */
export function substituteParams(text: string, params: Record<string, string>): string {
  if (!text.includes("${params.")) return text;
  return text.replace(/\$\{params\.([A-Za-z0-9_.-]+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(params, k) ? (params[k] as string) : m,
  );
}
