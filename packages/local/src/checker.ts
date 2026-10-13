import type { Constraint } from "@procforge/shared/schema.js";
import type { EvaluateFn } from "@procforge/shared/core-client.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isEscapeRel } from "./artifacts.js";
import { extractPptxTables } from "./services/audit-content.js";
import { substituteParams } from "./runner/resolve.js";
import {
  evaluateAllWith,
  evaluateBaseConstraint,
  resolveNumericExpected,
  type CheckContext,
  type CheckResult,
  type Verdict,
} from "@procforge/shared/check.js";

// M6-2: fs 없는 판정은 shared로 이동. 여기서는 fs 필요 2종(pptx_table_sum,
// csv_rows)만 직접 실행하고 나머지는 shared에 위임한다.
export type { CheckContext, CheckResult, Verdict };
export {
  deepEqual,
  getByDotPath,
  getByJsonPointer,
  matchesJsonSchema,
  resolveNodeRef,
  resolveParamsRef,
  resolveNumericExpected,
  resolvePath,
} from "@procforge/shared/check.js";

function evaluateFsConstraint(c: Constraint, ctx: CheckContext): CheckResult {
  if (c.kind === "pptx_table_sum") {
    // M5.5-0: 산출 pptx 표를 직접 합산 (보고값이 아닌 그려진 값 검증).
    if (!ctx.fsDir) return { pass: false, reason: "deferred to runner (no fs)", deferred: true };
    const raw = typeof c.spec.path === "string" ? c.spec.path : "";
    const rel = substituteParams(raw, ctx.params ?? {}).split("\\").join("/");
    if (rel === "" || isEscapeRel(rel, "/") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      return { pass: false, reason: `bad table path: ${raw}` };
    }
    const abs = join(ctx.fsDir, rel);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return { pass: false, reason: `table file not found: ${rel}` };
    }
    const tables = extractPptxTables(buf);
    const pick = typeof c.spec.slide === "number"
      ? tables.find((t) => t.slide === c.spec.slide)
      : tables.find((t) => t.rows.length > 0);
    if (!pick) return { pass: false, reason: `no table in ${rel}` };
    const col = typeof c.spec.column === "number" ? c.spec.column : pick.rows[0].length - 1;
    const body = (c.spec.skipHeader ?? true) ? pick.rows.slice(1) : pick.rows;
    if (body.length === 0) return { pass: false, reason: `empty table in ${rel}` };
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const cell = body[i][col];
      if (cell === undefined) return { pass: false, reason: `no column ${col} at row ${i} in ${rel}` };
      const num = Number(cell.replace(/,/g, "").trim());
      if (!Number.isFinite(num)) return { pass: false, reason: `not a number at row ${i}: "${cell}"` };
      sum += num;
    }
    const re2 = resolveNumericExpected(c.spec as { expected?: unknown; expectedRef?: unknown }, ctx);
    if (re2.deferred) return { pass: false, reason: re2.reason, deferred: true };
    if (re2.reason) return { pass: false, reason: re2.reason };
    if (re2.expected === undefined) return { pass: false, reason: "no expected given" };
    const tol = typeof c.spec.tolerance === "number" ? c.spec.tolerance : 0;
    if (Math.abs(sum - re2.expected) > tol)
      return { pass: false, reason: `table sum ${sum} != ${re2.expected}±${tol} (${rel})` };
    return { pass: true };
  }
  // csv_rows (M5.8.2-4)
  if (!ctx.fsDir) return { pass: false, reason: "deferred to runner (no fs)", deferred: true };
  const raw = typeof (c.spec as { path?: unknown }).path === "string"
    ? (c.spec as { path: string }).path
    : "";
  const rel = substituteParams(raw, ctx.params ?? {}).split("\\").join("/");
  if (rel === "" || isEscapeRel(rel, "/") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return { pass: false, reason: `bad csv path: ${raw}` };
  }
  let text: string;
  try {
    text = readFileSync(join(ctx.fsDir, rel), "utf8");
  } catch {
    return { pass: false, reason: `csv file not found: ${rel}` };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rows = lines.length - (((c.spec as { skipHeader?: unknown }).skipHeader ?? true) && lines.length > 0 ? 1 : 0);
  let expected: number | undefined;
  if (typeof (c.spec as { value?: unknown }).value === "number") {
    expected = (c.spec as { value: number }).value;
  } else {
    const re = resolveNumericExpected(c.spec as { expected?: unknown; expectedRef?: unknown }, ctx);
    if (re.deferred) return { pass: false, reason: re.reason, deferred: true };
    if (re.reason) return { pass: false, reason: re.reason };
    expected = re.expected;
  }
  if (expected === undefined) return { pass: false, reason: "no expected given" };
  const tol = typeof (c.spec as { tolerance?: unknown }).tolerance === "number"
    ? (c.spec as { tolerance: number }).tolerance
    : 0;
  const op = (c.spec as { op?: unknown }).op;
  const ok =
    op === "eq" ? Math.abs(rows - expected) <= tol :
    op === "ne" ? Math.abs(rows - expected) > tol :
    op === "gt" ? rows > expected :
    op === "ge" ? rows >= expected :
    op === "lt" ? rows < expected :
    op === "le" ? rows <= expected :
    false;
  if (!ok) return { pass: false, reason: `csv rows ${rows} ${op} ${expected} failed (${rel})` };
  return { pass: true };
}

export function evaluateConstraint(c: Constraint, ctx: CheckContext): CheckResult {
  if ((c.kind === "pptx_table_sum" || c.kind === "csv_rows") && ctx.fsDir) {
    return evaluateFsConstraint(c, ctx);
  }
  return evaluateBaseConstraint(c, ctx);
}

export function evaluateAll(
  constraints: Constraint[],
  ctx: CheckContext,
): { verdict: Verdict; failedConstraints: string[]; unverified: string[]; details: Record<string, CheckResult> } {
  return evaluateAllWith(evaluateConstraint, constraints, ctx);
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
