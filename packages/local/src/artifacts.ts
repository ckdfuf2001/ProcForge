import { copyFileSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, basename, dirname } from "node:path";

// 호스트는 경로만 제출, 실제 읽기·복사는 local이 수행 (M2).
// - 프로젝트 루트 밖 경로 거부, 심볼릭 링크 탈출 거부
// - fixtures/<nodeId>/<attemptId>/ 로 복사, Attempt.artifacts에는 fixture 상대경로 기록

export function assertSafePath(projectRoot: string, p: string): string {
  const root = resolve(projectRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || abs === root) {
    // rel === "" means p == root (디렉터리) — 파일만 허용
    throw Object.assign(new Error(`path escapes project root: ${p}`), { code: "bad_request" });
  }
  if (!existsSync(abs)) throw Object.assign(new Error(`artifact not found: ${p}`), { code: "bad_request" });
  // 심볼릭 링크 탈출 검사: 실체도 루트 안이어야 함
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw Object.assign(new Error(`cannot resolve: ${p}`), { code: "bad_request" });
  }
  if (relative(root, real).startsWith("..")) {
    throw Object.assign(new Error(`symlink escapes project root: ${p}`), { code: "bad_request" });
  }
  return abs;
}

export type Ingested = {
  /** Attempt.artifacts에 기록할 fixture 상대경로들 */
  stored: string[];
  /** checker에 전달할 내용 맵 (stored 경로 → utf8 텍스트) */
  contents: Record<string, string>;
};

export function ingestArtifacts(input: {
  procforgeDir: string;
  sessionId: string;
  nodeId: string;
  attemptId: string;
  projectRoot: string;
  paths: string[];
}): Ingested {
  const stored: string[] = [];
  const contents: Record<string, string> = {};
  input.paths.forEach((p, i) => {
    const abs = assertSafePath(input.projectRoot, p);
    const buf = readFileSync(abs);
    const destRel = join("fixtures", input.nodeId, input.attemptId, `${i}-${basename(abs)}`);
    const destAbs = join(input.procforgeDir, "sessions", input.sessionId, destRel);
    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(abs, destAbs);
    stored.push(destRel.replace(/\\/g, "/"));
    contents[destRel.replace(/\\/g, "/")] = buf.toString("utf8");
  });
  return { stored, contents };
}

export function setupSandbox(input: {
  procforgeDir: string;
  sessionId: string;
  projectRoot: string;
  seedFiles: string[];
}): { sandboxDir: string; copied: string[] } {
  const sandboxDir = join(input.procforgeDir, "sandbox", input.sessionId);
  const copied: string[] = [];
  for (const f of input.seedFiles) {
    const abs = assertSafePath(input.projectRoot, f);
    const rel = relative(resolve(input.projectRoot), abs);
    const dest = join(sandboxDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    copied.push(rel);
  }
  return { sandboxDir, copied };
}
