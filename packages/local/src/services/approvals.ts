import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pfError } from "@procforge/shared/errors.js";
import { computeNodeHash, type ArgSpec, type Constraint } from "@procforge/shared/schema.js";
import { writeAtomicFile } from "../fsutil.js";

// M5.5-4: 무인 실행 사전 승인 (procedures/<name>/approvals.json).
// M5.5-4.1-3: 항목에 node pin 필수. 형식:
// [{ node: { id, hash }, tool: { server, name }, args?: { 키: 값 패턴 } }]
// args 생략 = tool 전체 승인. 패턴 값 "*" = 임의 값 허용 (문자열 비교는 해석된 인자 기준).
// args가 있으면 실제 호출 인자와 키 집합 정확히 일치 (M5.5-4.1-2).

export type ApprovalEntry = {
  node: { id: string; hash: string };
  tool: { server: string; name: string };
  args?: Record<string, unknown>;
};

export type ApprovalPin = { id: string; hash: string };

export function approvalsPath(procedureDir: string): string {
  return join(procedureDir, "approvals.json");
}

function isEntry(x: unknown): x is ApprovalEntry {
  if (typeof x !== "object" || x === null) return false;
  const nd = (x as { node?: unknown }).node;
  if (typeof nd !== "object" || nd === null) return false;
  if (typeof (nd as { id?: unknown }).id !== "string") return false;
  if (typeof (nd as { hash?: unknown }).hash !== "string") return false;
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
    throw pfError("bad_request", `approvals.json 형식 오류: [{ node: { id, hash }, tool: { server, name }, args? }] 필요 (${p})`);
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

// M5.5-4.1-3: 절차서 노드에서 승인 항목 생성.
// 해시는 importProcedure와 동일 공식 (goal·args·constraints·dependsOn []).
// 패턴: fixed 값 그대로, var/generated은 "*", script-kind는 제외 (tool 인자 아님).
export function buildApprovalEntry(docNode: {
  id: string;
  goal: string;
  tool?: { server: string; name: string };
  args?: Record<string, ArgSpec>;
  constraints?: Constraint[];
  sideEffect?: string;
}): ApprovalEntry {
  if (!docNode.tool) throw pfError("bad_request", `승인은 tool 노드만 가능: ${docNode.id}`);
  if (docNode.sideEffect !== undefined && docNode.sideEffect !== "external") {
    throw pfError("bad_request", `승인은 external 노드만: ${docNode.id} (sideEffect=${docNode.sideEffect})`);
  }
  const pattern: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(docNode.args ?? {})) {
    if ((s as { kind?: string }).kind === "script") continue;
    pattern[k] = (s as { kind?: string }).kind === "fixed" ? (s as { value?: unknown }).value : "*";
  }
  return {
    node: {
      id: docNode.id,
      hash: computeNodeHash({
        goal: docNode.goal,
        args: docNode.args,
        constraints: docNode.constraints ?? [],
        dependsOn: [],
      }),
    },
    tool: { server: docNode.tool.server, name: docNode.tool.name },
    args: pattern,
  };
}

export function saveApproval(procedureDir: string, entry: ApprovalEntry): { path: string; replaced: boolean } {
  const path = approvalsPath(procedureDir);
  const list = loadApprovals(procedureDir);
  const ix = list.findIndex((e) => e.node.id === entry.node.id);
  const replaced = ix !== -1;
  if (replaced) list[ix] = entry;
  else list.push(entry);
  writeAtomicFile(path, JSON.stringify(list, null, 2));
  return { path, replaced };
}

// M5.5-4.1-3: node pin 판정. ok(실행) | stale(해시 변경·갱신 필요) | denied(미승인).
export type ApprovalVerdict = "ok" | "stale" | "denied";

export function approvalPins(
  node: { id: string; hash?: string; parentId?: string | null },
  parent?: { id: string; hash?: string; kind?: string },
): ApprovalPin[] {
  const pins: ApprovalPin[] = [{ id: node.id, hash: node.hash ?? "" }];
  // map/until 인스턴스(1.2.1)는 부모 노드 pin으로 승인 (항목별 해시는 불안정).
  if (node.parentId && parent && (parent.kind === "map" || parent.kind === "until")) {
    pins.push({ id: parent.id, hash: parent.hash ?? "" });
  }
  return pins;
}

export function checkApproval(
  approvals: ApprovalEntry[],
  pins: ApprovalPin[],
  server: string,
  name: string,
  args: Record<string, unknown>,
): ApprovalVerdict {
  if (approvals.some((e) => pins.some((p) => p.id === e.node.id && p.hash === e.node.hash) && matchApproval(e, server, name, args))) {
    return "ok";
  }
  if (approvals.some((e) => pins.some((p) => p.id === e.node.id && p.hash !== e.node.hash))) {
    return "stale";
  }
  return "denied";
}
