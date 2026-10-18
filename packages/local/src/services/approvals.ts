import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pfError } from "@procforge/shared/errors.js";
import { computeNodeHash, type ArgSpec, type Constraint } from "@procforge/shared/schema.js";
import { writeAtomicFile } from "../fsutil.js";
import { logger } from "../logger.js";
import { collectRefNodeIds } from "../runner/resolve.js";
import { saveApprovedSnapshot } from "./approval-scripts.js";

// M5.5-4: 무인 실행 사전 승인 (procedures/<name>/approvals.json).
// M5.5-4.3-1: v2 형식 {version:2, entries}. 패턴 명시화:
// 문자열은 항상 정확 일치. 와일드카드는 {"$any":true}, 접두는 {"$prefix":"..."}만.
// args가 있으면 실제 호출 인자와 키 집합 정확히 일치 (M5.5-4.1-2).
// M5.5-4.2-1: 매칭 기준은 논리 경로 (rewritePaths 전 해석 인자).

export type ApprovalEntry = {
  node: { id: string; hash: string };
  /** M5.5-4.3-3: 승인 해시 (nodeHash + tool + sideEffect + map/until + 상류 재귀). */
  approvalHash: string;
  tool: { server: string; name: string };
  args?: Record<string, unknown>;
};

export type ApprovalPin = { id: string; hash: string; approvalHash: string };
// M5.5-4.3-3: 승인 해시.
// nodeHash(기존 공식 유지) + tool + sideEffect + map/until 전체 스펙 +
// var-kind 인자가 참조하는 상류 노드 approvalHash (재귀, $self·${item}·params 제외).
// 단계마다 sha256으로 접어 크기를 묶는다. doc/세션 양쪽에서 동일 공식.
export type HashableNode = {
  id: string;
  goal: string;
  tool?: { server: string; name: string };
  args?: Record<string, unknown>;
  constraints?: unknown[];
  sideEffect?: string;
  map?: unknown;
  until?: unknown;
};

// M5.5-4.4-5: doc·세션 노드 단일 변환 (호출자 캐스팅 제거).
export function toHashable(n: {
  id: string;
  goal?: unknown;
  tool?: { server: string; name: string } | undefined;
  args?: Record<string, unknown> | undefined;
  constraints?: unknown[] | undefined;
  sideEffect?: unknown;
  map?: unknown;
  until?: unknown;
}): HashableNode {
  return {
    id: n.id,
    goal: typeof n.goal === "string" ? n.goal : "",
    ...(n.tool ? { tool: { server: n.tool.server, name: n.tool.name } } : {}),
    ...(n.args ? { args: n.args } : {}),
    ...(n.constraints ? { constraints: n.constraints } : {}),
    ...(typeof n.sideEffect === "string" ? { sideEffect: n.sideEffect } : {}),
    ...(n.map !== undefined ? { map: n.map } : {}),
    ...(n.until !== undefined ? { until: n.until } : {}),
  };
}

export function toHashableMap(byId: Map<string, Parameters<typeof toHashable>[0]>): Map<string, HashableNode> {
  return new Map([...byId.entries()].map(([id, n]) => [id, toHashable(n)] as const));
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function collectArgNodeRefs(specs: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const s of Object.values(specs ?? {})) {
    if (typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "var") {
      const ref = (s as { ref?: unknown }).ref;
      // M5.5-4.4-2: 템플릿 resolver와 같은 파서 (resolve.ts collectRefNodeIds).
      if (typeof ref === "string") out.push(...collectRefNodeIds(ref));
    }
  }
  return out;
}

function collectScriptFiles(specs: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const s of Object.values(specs ?? {})) {
    if (typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "script") {
      const f = (s as { file?: unknown }).file;
      if (typeof f === "string") out.push(f);
    }
  }
  return out;
}

export type ApprovalHashOpts = {
  /** script-kind 파일 내용 읽기 (rel → 내용. 없으면 undefined). */
  readScript?: (rel: string) => string | undefined;
};

export function computeApprovalHash(
  n: HashableNode,
  byId: Map<string, HashableNode>,
  seen: Set<string> = new Set(),
  opts: ApprovalHashOpts = {},
): string {
  const base = computeNodeHash({
    goal: n.goal,
    args: (n.args ?? {}) as Record<string, ArgSpec>,
    constraints: (n.constraints ?? []) as Constraint[],
    dependsOn: [],
  });
  const tool = n.tool ? `${n.tool.server}/${n.tool.name}` : "";
  const se = n.sideEffect ?? "";
  const specs = [n.map !== undefined ? stable(n.map) : "", n.until !== undefined ? stable(n.until) : ""];
  // M5.5-4.4-1: script-kind 파일 내용 sha256 (인자 + map/until 템플릿).
  const scriptRels: string[] = [...collectScriptFiles(n.args as Record<string, unknown> | undefined)];
  for (const k of ["map", "until"] as const) {
    const spec = n[k] as { template?: { args?: Record<string, unknown> } } | undefined;
    scriptRels.push(...collectScriptFiles(spec?.template?.args));
  }
  const scripts = [...new Set(scriptRels)].sort().map((rel) => {
    const content = opts.readScript?.(rel);
    return content === undefined ? `missing:${rel}` : createHash("sha256").update(content, "utf8").digest("hex");
  });
  const fold = (up: string[]): string =>
    createHash("sha256").update(stable({ base, tool, se, specs, scripts, up })).digest("hex").slice(0, 32);
  if (seen.has(n.id)) return fold([`cycle:${n.id}`]);
  seen.add(n.id);
  const refs: string[] = [...collectArgNodeRefs(n.args as Record<string, unknown> | undefined)];
  for (const k of ["map", "until"] as const) {
    const spec = n[k] as { over?: unknown; template?: { args?: Record<string, unknown> } } | undefined;
    if (typeof spec?.over === "string") refs.push(...collectRefNodeIds(spec.over));
    refs.push(...collectArgNodeRefs(spec?.template?.args));
  }
  const up = [...new Set(refs)]
    .filter((id) => id !== n.id && byId.has(id))
    .map((id) => computeApprovalHash(byId.get(id) as HashableNode, byId, seen, opts))
    .sort();
  seen.delete(n.id);
  return fold(up);
}

export function approvalsPath(procedureDir: string): string {
  return join(procedureDir, "approvals.json");
}

function isEntry(x: unknown): x is ApprovalEntry {
  if (typeof x !== "object" || x === null) return false;
  const nd = (x as { node?: unknown }).node;
  if (typeof nd !== "object" || nd === null) return false;
  if (typeof (nd as { id?: unknown }).id !== "string") return false;
  if (typeof (nd as { hash?: unknown }).hash !== "string") return false;
  // approvalHash는 v2 approve 생성분에만 존재 (v1 변환분은 node.hash로만 판정).
  const ah = (x as { approvalHash?: unknown }).approvalHash;
  if (ah !== undefined && typeof ah !== "string") return false;
  const t = (x as { tool?: unknown }).tool;
  if (typeof t !== "object" || t === null) return false;
  const s = (t as { server?: unknown }).server;
  const n = (t as { name?: unknown }).name;
  if (typeof s !== "string" || typeof n !== "string") return false;
  const a = (x as { args?: unknown }).args;
  if (a === undefined) return true;
  if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
  return Object.values(a as Record<string, unknown>).every(isValidPatternValue);
}

// M5.5-4.3-1: 패턴 값 검증. 문자열·원시값은 그대로, 객체는 $any/$prefix
// 단일 키 또는 중첩 패턴 객체만 허용.
function isValidPatternValue(v: unknown): boolean {
  if (typeof v === "string") return true;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return true;
  if (Array.isArray(v)) return v.every(isValidPatternValue);
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "$any") {
      return (v as { $any?: unknown }).$any === true;
    }
    if (keys.length === 1 && keys[0] === "$prefix") {
      const pv = (v as { $prefix?: unknown }).$prefix;
      if (typeof pv !== "string") return false;
      // M5.5-4.3-2: scheme:// 시작이면 origin 뒤 "/" 필수.
      // M5.5-4.4-4: query/fragment 포함이면 로드 거부.
      if (SCHEME_RE.test(pv)) {
        if (!URL_PREFIX_RE.test(pv)) return false;
        try {
          const u = new URL(pv);
          if (u.search !== "" || u.hash !== "") return false;
        } catch {
          return false;
        }
      }
      return true;
    }
    return Object.values(v as Record<string, unknown>).every(isValidPatternValue);
  }
  return false;
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
  // M5.5-4.3-1: v1(배열)은 1회 변환 후 경고. node pin 없는 v1은 재생성 요구.
  if (Array.isArray(raw)) {
    if (!raw.every(isV1Entry)) {
      throw pfError("bad_request", `approvals.json 형식 오류: {version:2, entries:[...]} 필요 (${p})`);
    }
    const missing = raw.filter((e) => typeof (e as { node?: unknown }).node !== "object");
    if (missing.length > 0) {
      throw pfError("bad_request", `approvals.json v1에 node pin 없음: procforge approve로 재생성 (${p})`);
    }
    const entries = (raw as { node: { id: string; hash: string }; tool: { server: string; name: string }; args?: Record<string, unknown> }[]).map(
      (e) => ({
        node: e.node,
        tool: e.tool,
        ...(e.args !== undefined ? { args: migrateV1Args(e.args) } : {}),
      }),
    );
    if (!entries.every(isEntry)) {
      throw pfError("bad_request", `approvals.json v1 변환 실패: {version:2, entries:[...]} 필요 (${p})`);
    }
    logger.warn("approvals.json v1 → v2 변환 (문자열 와일드카드 → $any/$prefix)", { path: p });
    return entries;
  }
  const ver = (raw as { version?: unknown }).version;
  const list = (raw as { entries?: unknown }).entries;
  if ((raw as object) && ver === 2 && Array.isArray(list) && (list as unknown[]).every(isEntry)) {
    return list as ApprovalEntry[];
  }
  throw pfError("bad_request", `approvals.json 형식 오류: {version:2, entries:[...]} 필요 (${p})`);
}

function isV1Entry(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { tool?: unknown }).tool;
  if (typeof t !== "object" || t === null) return false;
  if (typeof (t as { server?: unknown }).server !== "string") return false;
  if (typeof (t as { name?: unknown }).name !== "string") return false;
  const a = (x as { args?: unknown }).args;
  return a === undefined || (typeof a === "object" && a !== null && !Array.isArray(a));
}

// M5.5-4.3-1: v1 문자열 와일드카드 → 명시 패턴. "*" → $any, 끝 "*" → $prefix.
export function migrateV1Args(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = migrateV1Value(v);
  return out;
}

export function migrateV1Value(v: unknown): unknown {
  if (typeof v === "string") {
    if (v === "*") return { $any: true };
    if (v.length > 1 && v.endsWith("*") && !v.slice(0, -1).includes("*")) return { $prefix: v.slice(0, -1) };
    return v;
  }
  if (Array.isArray(v)) return v.map(migrateV1Value);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, migrateV1Value(x)]));
  }
  return v;
}

// M5.5-4.3-1: $prefix 비교. scheme:// 시작이면 URL 모드 (4.3-2),
// "/" 포함이면 경로 모드 (4.4-3), 아니면 문자열 접두.
export function matchPrefix(prefix: unknown, actual: unknown): boolean {
  if (typeof prefix !== "string") return false;
  if (typeof actual !== "string") return false;
  if (SCHEME_RE.test(prefix)) return matchUrlPrefix(prefix, actual);
  if (prefix.includes("/")) return matchPathPrefix(prefix, actual);
  return actual.startsWith(prefix);
}

// M5.5-4.4-3: 경로 모드. posix 정규화 후 ".."·절대경로를 패턴·실제 모두 거부,
// 세그먼트 접두로 비교.
export function matchPathPrefix(prefix: string, actual: string): boolean {
  const toPosix = (p: string): string => p.split("\\").join("/");
  for (const raw of [prefix, actual]) {
    const p = toPosix(raw);
    if (p.startsWith("/") || /^[a-zA-Z]:(\/|$)/.test(p)) return false;
    if (p.split("/").some((s) => s === "..")) return false;
  }
  const segs = (p: string): string[] => toPosix(p).split("/").filter((s) => s !== "" && s !== ".");
  const pp = segs(prefix);
  const ap = segs(actual);
  // 끝 "/"는 하위만 (자기 자신 불일치). "/" 자체는 origin 전체.
  if (toPosix(prefix).endsWith("/") && toPosix(prefix) !== "/" && ap.length <= pp.length) return false;
  if (pp.length > ap.length) return false;
  // M5.6.1-4: 마지막 패턴 세그먼트는 문자열 접두, 나머지는 정확 일치.
  for (let i = 0; i < pp.length - 1; i++) {
    if (pp[i] !== ap[i]) return false;
  }
  if (pp.length === 0) return true;
  return ap[pp.length - 1].startsWith(pp[pp.length - 1]);
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
// URL 패턴은 origin 뒤 "/" 필수 (없으면 로드 시 bad_request).
const URL_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\//;

// M5.5-4.3-2: URL 모드. 실제 값을 new URL()로 정규화 (호스트 소문자·기본 포트·
// dot 세그먼트 해소) 후 origin 정확 일치 + path 세그먼트 접두 비교.
export function matchUrlPrefix(prefix: string, actual: string): boolean {
  let p: URL;
  let a: URL;
  try {
    p = new URL(prefix);
    a = new URL(actual);
  } catch {
    return false;
  }
  if (a.origin !== p.origin) return false;
  // M5.5-4.4-4: 실제 값에 자격(username/password)이 있으면 거부.
  if (a.username !== "" || a.password !== "") return false;
  // M5.6.1-4: 마지막 패턴 세그먼트는 문자열 접두로 비교 (나머지는 정확 일치).
  if (prefix.endsWith("/") && p.pathname !== "/") {
    const segs = (s: string): string[] => s.split("/").filter((x) => x !== "");
    if (segs(a.pathname).length <= segs(p.pathname).length) return false;
  }
  return segmentPrefix(p.pathname, a.pathname);
}

// M5.6.1-4: 세그먼트 접두 비교. 마지막 패턴 세그먼트만 문자열 접두 허용.
function segmentPrefix(patternPath: string, actualPath: string): boolean {
  const segs = (p: string): string[] => p.split("/").filter((s) => s !== "");
  const pp = segs(patternPath);
  const ap = segs(actualPath);
  if (pp.length === 0) return true;
  if (pp.length > ap.length) return false;
  for (let i = 0; i < pp.length - 1; i++) {
    if (pp[i] !== ap[i]) return false;
  }
  return ap[pp.length - 1].startsWith(pp[pp.length - 1]);
}

function matchValue(pattern: unknown, actual: unknown): boolean {
  // M5.5-4.3-1: 문자열은 항상 정확 일치. 와일드카드는 $any, 접두는 $prefix만.
  if (typeof pattern === "object" && pattern !== null && !Array.isArray(pattern)) {
    const keys = Object.keys(pattern as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "$any") return true;
    if (keys.length === 1 && keys[0] === "$prefix") {
      return matchPrefix((pattern as { $prefix: unknown }).$prefix, actual);
    }
  }
  if (typeof pattern === "string") return actual === pattern;
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

// M5.5-4.3-4: pin 없는 isApproved 삭제 (node pin 없는 매칭 금지).
// 외부 호출은 checkApproval만 사용.

// M5.6-b: fixed 템플릿 값 → $prefix 생성. 리터럴 앞부분을 사용.
// URL이면 URL 모드 규칙 적용 (origin 뒤 "/" 없으면 bad_request).
// 리터럴이 비어 있으면 $any.
export function fixedTemplatePrefix(key: string, value: string): { $prefix: string } | { $any: true } {
  const literal = value.split("${")[0];
  if (literal === "") return { $any: true };
  if (SCHEME_RE.test(literal) && !URL_PREFIX_RE.test(literal)) {
    throw pfError("bad_request", `승인 불가: $prefix 무효 (${key} 리터럴 "${literal}"). URL은 origin 뒤 "/" 필요 — $prefix 수기 작성`);
  }
  return { $prefix: literal };
}

// M5.6.1-4: ${} 2개 이상 fixed 템플릿 범위 경고 (앞부분만으로 승인됨).
export function scopeWarnings(docNode: { id: string; args?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const [k, s] of Object.entries(docNode.args ?? {})) {
    if (typeof s !== "object" || s === null || (s as { kind?: unknown }).kind !== "fixed") continue;
    const v = (s as { value?: unknown }).value;
    if (typeof v !== "string") continue;
    const n = (v.match(/\$\{/g) ?? []).length;
    if (n >= 2) {
      out.push(
        `범위 경고: ${docNode.id}.${k}에 \${} ${n}개 — 앞부분 "${v.split("${")[0]}"만으로 승인됨. 의도한 범위인지 확인하라.`,
      );
    }
  }
  return out;
}

// 해시는 importProcedure와 동일 공식 (goal·args·constraints·dependsOn []).
// 패턴: fixed 값 그대로, script-kind는 제외 (tool 인자 아님).
// M5.5-4.2-2: var/generated 키는 allowWildcardKeys에 명시된 것만 와일드카드 생성.
// 미지정은 bad_request + 키 목록 (암묵적 전체 허용 금지).
// M5.5-4.3-1: 와일드카드는 {"$any":true}로 생성.
export function buildApprovalEntry(
  docNode: {
    id: string;
    goal: string;
    tool?: { server: string; name: string };
    args?: Record<string, unknown>;
    constraints?: unknown[];
    sideEffect?: string;
    map?: unknown;
    until?: unknown;
  },
  allowWildcardKeys: string[] = [],
  docById: Map<string, HashableNode> = new Map(),
  readScript?: (rel: string) => string | undefined,
): ApprovalEntry {
  if (!docNode.tool) throw pfError("bad_request", `승인은 tool 노드만 가능: ${docNode.id}`);
  // M5.8.2-3: script 노드도 승인 대상 (sideEffect 무관). 스크립트는 임의 코드
  // 실행이라 무인 실행에 명시적 승인이 필요 (기본 요구, opt-out 없음).
  const hasScript = Object.values(docNode.args ?? {}).some((s) => (s as { kind?: unknown }).kind === "script");
  if (!hasScript && docNode.sideEffect !== undefined && docNode.sideEffect !== "external") {
    throw pfError("bad_request", `승인은 external·script 노드만: ${docNode.id} (sideEffect=${docNode.sideEffect})`);
  }
  const allowed = new Set(allowWildcardKeys);
  const denied: string[] = [];
  const pattern: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(docNode.args ?? {})) {
    const kind = (s as { kind?: unknown }).kind;
    if (kind === "script") continue;
    // M5.6-b: fixed 값에 ${...}가 있으면 리터럴 앞부분을 $prefix로 생성.
    if (kind === "fixed") {
      const v = (s as { value?: unknown }).value;
      if (typeof v === "string" && v.includes("${")) {
        pattern[k] = fixedTemplatePrefix(k, v);
        continue;
      }
      pattern[k] = v;
    } else if (allowed.has(k)) {
      pattern[k] = { $any: true };
    } else {
      denied.push(k);
    }
  }
  if (denied.length > 0) {
    throw pfError("bad_request", `승인 불가: 와일드카드 미지정 키 (${denied.join(",")}). --allow-wildcard <key>로 명시`);
  }
  // M5.5-4.4-5: toHashable 단일 변환.
  const hashable = toHashable(docNode);
  const nodes = new Map(docById);
  nodes.set(hashable.id, hashable);
  const hashOpts = readScript ? { readScript } : {};
  return {
    node: {
      id: docNode.id,
      hash: computeNodeHash({
        goal: docNode.goal,
        args: (docNode.args ?? {}) as Record<string, ArgSpec>,
        constraints: (docNode.constraints ?? []) as Constraint[],
        dependsOn: [],
      }),
    },
    approvalHash: computeApprovalHash(hashable, nodes, new Set(), hashOpts),
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
  // M5.5-4.3-1: v2 단일 파일.
  writeAtomicFile(path, JSON.stringify({ version: 2, entries: list }, null, 2));
  return { path, replaced };
}

/**
 * M7-5-e: **공통 승인 저장**.
 * UI(uiApprove)·MCP(pf_approve)·CLI(approveProcedureNode) 가 모두 이 길로만 적는다.
 * 이전엔 uiApprove 안에서만 스냅샷을 남겨서, 모델/CLI 로 승인한 스크립트는 diff 가 계속 null 이었다.
 * (스냅샷이 없으면 "무엇이 승인됐는지"를 나중에 알 수 없다)
 */
export function commitApproval(
  procedureDir: string,
  entry: ApprovalEntry,
  script?: { nodeId: string; rel: string; content: string },
): { path: string; replaced: boolean } {
  if (!script) return saveApproval(procedureDir, entry);
  const snap = saveApprovedSnapshot(procedureDir, script.nodeId, script.content);
  return saveApproval(procedureDir, {
    ...entry,
    args: { ...(entry.args ?? {}), script: { file: script.rel, snapshot: snap.snapshotRel } },
  });
}

// M5.5-4.1-3: node pin 판정. ok(실행) | stale(해시 변경·갱신 필요) | denied(미승인).
export type ApprovalVerdict = "ok" | "stale" | "denied";

export function approvalPins(
  node: { id: string; hash?: string; parentId?: string | null },
  parent?: { id: string; hash?: string; kind?: string },
  byId?: Map<string, HashableNode>,
  readScript?: (rel: string) => string | undefined,
): ApprovalPin[] {
  const nodes = byId ?? new Map<string, HashableNode>();
  const opts = readScript ? { readScript } : {};
  const pin = (id: string, hash: string): ApprovalPin => {
    const full = nodes.get(id);
    return {
      id,
      hash,
      approvalHash: full ? computeApprovalHash(full, nodes, new Set(), opts) : computeApprovalHash({ id, goal: "", args: {} }, nodes, new Set(), opts),
    };
  };
  const pins: ApprovalPin[] = [pin(node.id, node.hash ?? "")];
  // map/until 인스턴스(1.2.1)는 부모 노드 pin으로 승인 (항목별 해시는 불안정).
  if (node.parentId && parent && (parent.kind === "map" || parent.kind === "until")) {
    pins.push(pin(parent.id, parent.hash ?? ""));
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
  const pinned = (e: ApprovalEntry): boolean =>
    pins.some(
      (p) =>
        p.id === e.node.id &&
        p.hash === e.node.hash &&
        (e.approvalHash === undefined || e.approvalHash === p.approvalHash) &&
        matchApproval(e, server, name, args),
    );
  if (approvals.some(pinned)) return "ok";
  // id는 맞는데 hash 또는 approvalHash가 다르면 stale (갱신 필요).
  // approvalHash 없는 v1 변환분은 node.hash로만 판정.
  if (
    approvals.some((e) =>
      pins.some(
        (p) =>
          p.id === e.node.id &&
          (p.hash !== e.node.hash || (e.approvalHash !== undefined && e.approvalHash !== p.approvalHash)),
      ),
    )
  ) {
    return "stale";
  }
  return "denied";
}
