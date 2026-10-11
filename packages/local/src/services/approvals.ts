import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pfError } from "@procforge/shared/errors.js";

// M5.5-4: 무인 실행 사전 승인 (procedures/<name>/approvals.json).
// 형식: [{ tool: { server, name }, args?: { 키: 값 패턴 } }]
// args 생략 = tool 전체 승인. 패턴 값 "*" = 임의 값 허용 (문자열 비교는 해석된 인자 기준).

export type ApprovalEntry = {
  tool: { server: string; name: string };
  args?: Record<string, unknown>;
};

export function approvalsPath(procedureDir: string): string {
  return join(procedureDir, "approvals.json");
}

function isEntry(x: unknown): x is ApprovalEntry {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { tool?: unknown }).tool;
  if (typeof t !== "object" || t === null) return false;
  const s = (t as { server?: unknown }).server;
  const n = (t as { name?: unknown }).name;
  if (typeof s !== "string" || typeof n !== "string") return false;
  const a = (x as { args?: unknown }).args;
  return a === undefined || (typeof a === "object" && a !== null && !Array.isArray(a));
}

export function loadApprovals(procedureDir: string): ApprovalEntry[] {
  const p = approvalsPath(procedureDir);
  if (!existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw pfError("bad_request", `approvals.json 파싱 실패: ${p} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(raw) || !raw.every(isEntry)) {
    throw pfError("bad_request", `approvals.json 형식 오류: [{ tool: { server, name }, args? }] 필요 (${p})`);
  }
  return raw as ApprovalEntry[];
}

function matchValue(pattern: unknown, actual: unknown): boolean {
  if (pattern === "*") return true;
  if (typeof pattern !== "object" || pattern === null || typeof actual !== "object" || actual === null) {
    return JSON.stringify(pattern) === JSON.stringify(actual);
  }
  if (Array.isArray(pattern) || Array.isArray(actual)) {
    return JSON.stringify(pattern) === JSON.stringify(actual);
  }
  // M5.5-4.1-2: 키 집합 정확히 일치 (실제 인자에 추가 키가 있으면 거부).
  const p = pattern as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const pk = Object.keys(p);
  if (pk.length !== Object.keys(a).length) return false;
  return pk.every((k) => Object.prototype.hasOwnProperty.call(a, k) && matchValue(p[k], a[k]));
}

export function matchApproval(
  entry: ApprovalEntry,
  server: string,
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (entry.tool.server !== server || entry.tool.name !== name) return false;
  if (entry.args === undefined) return true;
  return matchValue(entry.args, args);
}

export function isApproved(
  approvals: ApprovalEntry[],
  server: string,
  name: string,
  args: Record<string, unknown>,
): boolean {
  return approvals.some((e) => matchApproval(e, server, name, args));
}
