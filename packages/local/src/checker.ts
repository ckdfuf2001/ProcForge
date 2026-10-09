import type { Constraint } from "@procforge/shared/schema.js";
import type { EvaluateFn } from "@procforge/shared/core-client.js";

export type CheckContext = {
  resultSummary?: string;
  resultJson?: unknown;
  artifacts?: Record<string, string>;
  fileExists?: (path: string) => boolean;
  /** 다른 노드 출력 (numeric expectedRef 해결용, M4. runner만 제공) */
  nodeOutputs?: Record<string, unknown>;
};

export type CheckResult = {
  pass: boolean;
  reason?: string;
  needsHuman?: boolean;
  /** core가 아닌 runner에서 판정 (M4) */
  deferred?: boolean;
};

/** "$<id>.output[.path]" 참조 해결 */
export function resolveNodeRef(ref: string, outputs: Record<string, unknown>): { found: boolean; value: unknown } {
  const m = /^\$(\d+(?:\.\d+)*)\.output\.?(.*)$/.exec(ref);
  if (!m) return { found: false, value: undefined };
  if (!(m[1] in outputs)) return { found: false, value: undefined };
  const base = outputs[m[1]];
  if (!m[2]) return { found: true, value: base };
  return getByDotPath(base, m[2]);
}

export function getByDotPath(root: unknown, path: string): { found: boolean; value: unknown } {
  if (!path) return { found: true, value: root };
  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (typeof cur === "object") {
      if (!(p in (cur as Record<string, unknown>))) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

export function getByJsonPointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  // RFC6901: "" -> whole doc, "/a/0/b", "~0"->"~", "~1"->"/"
  if (pointer === "" || pointer === "/") return { found: true, value: pointer === "" ? root : root };
  if (!pointer.startsWith("/")) return { found: false, value: undefined };
  const parts = pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const p of parts) {
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!(p in (cur as Record<string, unknown>))) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/** 검사 컨텍스트에서 path 문자열을 해석한다.
 *  - "summary" -> resultSummary
 *  - "artifacts.<name>..." -> artifacts 맵
 *  - "result.<dot>" / "resultJson.<dot>" -> resultJson
 *  - 그 외: resultJson에 대한 dot 경로로 시도, 실패 시 artifacts 키로 시도
 */
export function resolvePath(ctx: CheckContext, path: string): { found: boolean; value: unknown } {
  if (path === "summary") return { found: ctx.resultSummary !== undefined, value: ctx.resultSummary };
  if (path.startsWith("artifacts.")) {
    const rest = path.slice("artifacts.".length);
    const firstDot = rest.indexOf(".");
    const key = firstDot === -1 ? rest : rest.slice(0, firstDot);
    const sub = firstDot === -1 ? "" : rest.slice(firstDot + 1);
    const raw = ctx.artifacts?.[key];
    if (raw === undefined) return { found: false, value: undefined };
    if (!sub) return { found: true, value: raw };
    // 아티팩트 내용이 JSON이면 파싱 후 탐색 시도
    try {
      const parsed: unknown = JSON.parse(raw);
      return getByDotPath(parsed, sub);
    } catch {
      return { found: false, value: undefined };
    }
  }
  if (path.startsWith("result.")) return getByDotPath(ctx.resultJson, path.slice("result.".length));
  if (path.startsWith("resultJson.")) return getByDotPath(ctx.resultJson, path.slice("resultJson.".length));
  // 기본: resultJson dot 경로
  if (ctx.resultJson !== undefined) {
    const r = getByDotPath(ctx.resultJson, path);
    if (r.found) return r;
  }
  // artifacts 직접 키
  if (ctx.artifacts && path in ctx.artifacts) return { found: true, value: ctx.artifacts[path] };
  return { found: false, value: undefined };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao).sort();
    const kb = Object.keys(bo).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

function lengthOf(v: unknown): number | null {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  return null;
}

/** JSON Schema 최소 서브셋 검증: type/required/properties/enum/minimum/maximum/pattern/items */
export function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): { pass: boolean; reason?: string } {
  const t = schema["type"] as string | undefined;
  if (t) {
    const ok =
      (t === "string" && typeof value === "string") ||
      (t === "number" && typeof value === "number") ||
      (t === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "array" && Array.isArray(value)) ||
      (t === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) ||
      (t === "null" && value === null);
    if (!ok) return { pass: false, reason: `type mismatch: expected ${t}` };
  }
  if (schema["enum"] !== undefined) {
    const en = schema["enum"] as unknown[];
    if (!en.some((e) => deepEqual(e, value))) return { pass: false, reason: "not in enum" };
  }
  if (typeof value === "string") {
    if (schema["minLength"] !== undefined && value.length < (schema["minLength"] as number))
      return { pass: false, reason: "minLength" };
    if (schema["maxLength"] !== undefined && value.length > (schema["maxLength"] as number))
      return { pass: false, reason: "maxLength" };
    if (schema["pattern"] !== undefined && !new RegExp(schema["pattern"] as string).test(value))
      return { pass: false, reason: "pattern" };
  }
  if (typeof value === "number") {
    if (schema["minimum"] !== undefined && value < (schema["minimum"] as number))
      return { pass: false, reason: "minimum" };
    if (schema["maximum"] !== undefined && value > (schema["maximum"] as number))
      return { pass: false, reason: "maximum" };
  }
  if (Array.isArray(value) && schema["items"] !== undefined) {
    const itemSchema = schema["items"] as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      const r = matchesJsonSchema(value[i], itemSchema);
      if (!r.pass) return { pass: false, reason: `items[${i}]: ${r.reason}` };
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = (schema["required"] as string[] | undefined) ?? [];
    for (const k of required) {
      if (!(k in obj)) return { pass: false, reason: `missing required: ${k}` };
    }
    const props = (schema["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) {
        const r = matchesJsonSchema(obj[k], sub);
        if (!r.pass) return { pass: false, reason: `property ${k}: ${r.reason}` };
      }
    }
  }
  return { pass: true };
}

export function evaluateConstraint(c: Constraint, ctx: CheckContext): CheckResult {
  switch (c.kind) {
    case "file_exists": {
      const p = c.spec.path;
      if (ctx.artifacts && p in ctx.artifacts) return { pass: true };
      if (ctx.fileExists?.(p)) return { pass: true };
      return { pass: false, reason: `file not found: ${p}` };
    }
    case "json_path_exists": {
      const target: unknown = ctx.resultJson;
      if (c.spec.jsonPointer) {
        const r = getByJsonPointer(target, c.spec.jsonPointer);
        return r.found ? { pass: true } : { pass: false, reason: `jsonPointer not found: ${c.spec.jsonPointer}` };
      }
      if (c.spec.jsonPath) {
        const r = getByDotPath(target, c.spec.jsonPath);
        return r.found ? { pass: true } : { pass: false, reason: `jsonPath not found: ${c.spec.jsonPath}` };
      }
      // path는 결과 내 경로
      const r = resolvePath(ctx, c.spec.path);
      return r.found ? { pass: true } : { pass: false, reason: `path not found: ${c.spec.path}` };
    }
    case "equals": {
      if (c.spec.path) {
        const r = resolvePath(ctx, c.spec.path);
        if (!r.found) return { pass: false, reason: `path not found: ${c.spec.path}` };
        return deepEqual(r.value, c.spec.expected)
          ? { pass: true }
          : { pass: false, reason: `not equal at ${c.spec.path}` };
      }
      return deepEqual(c.spec.actual, c.spec.expected)
        ? { pass: true }
        : { pass: false, reason: "not equal" };
    }
    case "regex": {
      let v: unknown = c.spec.value;
      if (c.spec.path) {
        const r = resolvePath(ctx, c.spec.path);
        if (!r.found) return { pass: false, reason: `path not found: ${c.spec.path}` };
        v = r.value;
      }
      if (typeof v !== "string") return { pass: false, reason: "regex target is not a string" };
      let re: RegExp;
      try {
        re = new RegExp(c.spec.pattern, c.spec.flags);
      } catch {
        return { pass: false, reason: `invalid pattern: ${c.spec.pattern}` };
      }
      return re.test(v) ? { pass: true } : { pass: false, reason: `regex mismatch: ${c.spec.pattern}` };
    }
    case "count": {
      const r = resolvePath(ctx, c.spec.path);
      if (!r.found) return { pass: false, reason: `path not found: ${c.spec.path}` };
      const len = lengthOf(r.value);
      if (len === null) return { pass: false, reason: "count target has no length" };
      if (c.spec.exact !== undefined && len !== c.spec.exact)
        return { pass: false, reason: `count ${len} != exact ${c.spec.exact}` };
      if (c.spec.min !== undefined && len < c.spec.min)
        return { pass: false, reason: `count ${len} < min ${c.spec.min}` };
      if (c.spec.max !== undefined && len > c.spec.max)
        return { pass: false, reason: `count ${len} > max ${c.spec.max}` };
      return { pass: true };
    }
    case "numeric_match": {
      let v: unknown = c.spec.value;
      if (c.spec.path) {
        const r = resolvePath(ctx, c.spec.path);
        if (!r.found) return { pass: false, reason: `path not found: ${c.spec.path}` };
        v = r.value;
      }
      if (typeof v !== "number" || Number.isNaN(v)) return { pass: false, reason: "target is not a number" };
      // expectedRef는 runner에서만 판정 (M4). core에는 nodeOutputs이 없어 deferred.
      let expected = c.spec.expected;
      if (c.spec.expectedRef !== undefined) {
        if (ctx.nodeOutputs === undefined) {
          return { pass: false, reason: "deferred to runner (expectedRef)", deferred: true };
        }
        const r = resolveNodeRef(c.spec.expectedRef, ctx.nodeOutputs);
        if (!r.found) return { pass: false, reason: `ref not found: ${c.spec.expectedRef}`, deferred: true };
        if (typeof r.value !== "number" || Number.isNaN(r.value as number)) {
          return { pass: false, reason: `ref is not a number: ${c.spec.expectedRef}` };
        }
        expected = r.value as number;
      }
      if (expected !== undefined) {
        const tol = c.spec.tolerance ?? 0;
        if (Math.abs(v - expected) > tol)
          return { pass: false, reason: `${v} != ${expected}±${tol}` };
        return { pass: true };
      }
      if (c.spec.min !== undefined && v < c.spec.min) return { pass: false, reason: `${v} < min ${c.spec.min}` };
      if (c.spec.max !== undefined && v > c.spec.max) return { pass: false, reason: `${v} > max ${c.spec.max}` };
      if (expected === undefined && c.spec.min === undefined && c.spec.max === undefined)
        return { pass: false, reason: "no expected/min/max given" };
      return { pass: true };
    }
    case "schema": {
      const target = ctx.resultJson;
      const r = matchesJsonSchema(target, c.spec.jsonSchema);
      return r.pass ? { pass: true } : { pass: false, reason: r.reason };
    }
    case "llm_rubric": {
      return { pass: false, reason: "llm_rubric requires human review", needsHuman: true };
    }
  }
}

export type Verdict = "pass" | "fail" | "unverifiable";

export function evaluateAll(
  constraints: Constraint[],
  ctx: CheckContext,
): { verdict: Verdict; failedConstraints: string[]; unverified: string[]; details: Record<string, CheckResult> } {
  const failed: string[] = [];
  const unverified: string[] = [];
  const details: Record<string, CheckResult> = {};
  for (const c of constraints) {
    if (c.kind === "llm_rubric") {
      const r = evaluateConstraint(c, ctx);
      details[c.id] = r;
      unverified.push(c.id);
      continue;
    }
    const r = evaluateConstraint(c, ctx);
    details[c.id] = r;
    // runner 위임(deferred)은 실패가 아님 (M4)
    if (r.deferred) {
      unverified.push(c.id);
      continue;
    }
    if (!r.pass) failed.push(c.id);
  }
  const verdict: Verdict = failed.length > 0 ? "fail" : unverified.length > 0 && constraints.length === unverified.length && constraints.length > 0 ? "unverifiable" : failed.length === 0 ? "pass" : "fail";
  // llm_rubric만 있고 나머지가 통과면 pass가 아니라 unverifiable? M0-1: verdict 계산에서 제외.
  // 결정: 결정적 constraint가 전부 pass면 pass, llm_rubric은 unverified로만 보고.
  const deterministicFailed = failed.length > 0;
  const finalVerdict: Verdict = deterministicFailed ? "fail" : "pass";
  // 전체가 llm_rubric뿐이면 unverifiable (호출자가 판단)
  if (constraints.length > 0 && constraints.every((c) => c.kind === "llm_rubric")) {
    return { verdict: "unverifiable", failedConstraints: [], unverified, details };
  }
  return { verdict: finalVerdict, failedConstraints: failed, unverified, details };
}

/** core CoreService에 주입하는 EvaluateFn 구현 (local 소유, M1.5-1/M2). */
export const checkerEvaluate: EvaluateFn = (constraints, ctx) => {
  const r = evaluateAll(constraints, {
    resultSummary: ctx.resultSummary,
    resultJson: ctx.resultJson,
    artifacts: ctx.artifacts,
    fileExists: ctx.fileExists,
  });
  return { verdict: r.verdict === "fail" ? "fail" : "pass", failedConstraints: r.failedConstraints, unverified: r.unverified };
};
