import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Node } from "@procforge/shared/schema.js";
import { FileStore } from "../filestore.js";
import { isEscapeRel, readManifest } from "../artifacts.js";
import { resolveVar } from "./resolve.js";

// 실행 환경 (M3): runs/<runId>/fs/ 에 golden fixtures를 source 상대경로로 펼침.
// 원본 프로젝트 파일 쓰기 금지 — 모든 쓰기는 run fs 안에서만.

export type RunFs = {
  runId: string;
  runDir: string;
  fsDir: string;
};

export function setupRunFs(
  procforgeDir: string,
  sessionId: string,
  runId: string,
  bound?: { projectRoot?: string; params?: Record<string, string> },
): RunFs {
  const runDir = join(procforgeDir, "runs", runId);
  const fsDir = join(runDir, "fs");
  mkdirSync(fsDir, { recursive: true });
  const store = new FileStore(procforgeDir);
  const manifest = readManifest(procforgeDir, sessionId);
  // 노드 순서대로 복사 (같은 source면 뒤 노드가 덮어씀 — 최신 golden 우선)
  const nodes = [...store.getNodes(sessionId).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const n of nodes) {
    for (const fx of n.golden?.fixtures ?? []) {
      const src = manifest[fx];
      const abs = join(procforgeDir, "sessions", sessionId, fx);
      if (!existsSync(abs)) continue;
      const dest = src ? join(fsDir, src) : join(fsDir, "fx", fx);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
    }
  }
  // M5.2-1 입력 바인딩: in/inout + var/템플릿 경로는 projectRoot에서 해석해
  // run fs로 복사 (fixture 아님). 부재·탈출·미등록 키는 실행 전 bad_request.
  if (bound?.projectRoot && bound?.params) {
    seedBoundInputs(nodes, bound.projectRoot, bound.params, fsDir);
  }
  // M5.2-2: 세션 scripts/ → runs/<runId>/scripts/ (fs와 분리, cwd는 fs).
  copyTree(join(procforgeDir, "sessions", sessionId, "scripts"), join(runDir, "scripts"));
  return { runId, runDir, fsDir };
}

/** 디렉토리 트리 복사 (없으면 무시) */
export function copyTree(src: string, dst: string): void {
  if (!existsSync(src)) return;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(src, p);
      mkdirSync(dirname(join(dst, rel)), { recursive: true });
      copyFileSync(p, join(dst, rel));
    }
  };
  walk(src);
}

/**
 * M5.2-1: 파라미터 바인딩 입력 시딩. bound 대상:
 * - path 역할 in/inout + 값이 "${params." 포함 (전체 참조·임베디드 템플릿).
 * - fixed 리터럴·$노드 참조는 제외 (전자는 fixture 시딩, 후자는 실행 시 해결).
 */
export function seedBoundInputs(
  nodes: Node[],
  projectRoot: string,
  params: Record<string, string>,
  fsDir: string,
): { nodeId: string; arg: string; rel: string }[] {
  const seeded: { nodeId: string; arg: string; rel: string }[] = [];
  const proot = resolve(projectRoot);
  const base = resolve(fsDir);
  for (const n of nodes) {
    if (!n.tool) continue;
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as { kind?: string; path?: string; ref?: unknown; value?: unknown };
      if (s.path !== "in" && s.path !== "inout") continue;
      const raw = s.kind === "var" ? s.ref : s.kind === "fixed" ? s.value : undefined;
      if (typeof raw !== "string" || !raw.includes("${params.")) continue;
      let resolved: unknown;
      try {
        resolved = resolveVar(raw, params, new Map());
      } catch (e) {
        throw Object.assign(
          new Error(`입력 바인딩 실패: ${n.id}.${k}="${raw}" (${e instanceof Error ? e.message : String(e)})`),
          { code: "bad_request" },
        );
      }
      if (typeof resolved !== "string" || resolved.length === 0 || resolved.length > 512) {
        throw Object.assign(new Error(`입력 바인딩 실패: ${n.id}.${k} 해석 결과가 경로 아님`), {
          code: "bad_request",
        });
      }
      // M5.5-3: 절대경로는 바인딩 대상 아님 (실행 시 rewritePaths가 처리)
      if (resolved.startsWith("/") || /^[a-zA-Z]:/.test(resolved)) continue;
      const rel = resolved.split("\\").join("/");
      if (isEscapeRel(rel, "/")) {
        throw Object.assign(new Error(`입력 바인딩 경로 탈출: ${n.id}.${k}=${resolved}`), { code: "bad_request" });
      }
      const src = join(proot, rel);
      if (!existsSync(src)) {
        throw Object.assign(new Error(`입력 바인딩 실패: ${n.id}.${k}=${resolved}, 파일 없음 (projectRoot 기준)`), {
          code: "bad_request",
        });
      }
      const dest = join(base, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      seeded.push({ nodeId: n.id, arg: k, rel });
    }
  }
  return seeded;
}

/** run fs 절대경로 → 정규화 상대 표기 (녹화 키용) */
export function relativizeRunPath(fsDir: string, abs: string): string {
  const rel = relative(resolve(fsDir), resolve(abs));
  return `RUNFS/${rel.replace(/\\/g, "/")}`;
}
