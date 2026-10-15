import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// M7-1-6: 저장소 위치 단일화. MCP 서버가 실행 위치(cwd) 기준으로
// `.procforge/`를 찾아 TUI와 webui가 서로 다른 저장소에 쓰는 사고가 났다.
// PROCFORGE_HOME(opencode.json MCP env)으로 저장소를 한 곳에 고정한다.

/**
 * procforgeDir 결정. 우선순위:
 * 명시 플래그 > PROCFORGE_HOME(프로젝트 루트, 그 안 .procforge 사용)
 * > PROCFORGE_DIR(호환, 저장소 직접 지정) > <cwd>/.procforge (기본값 규칙 1개).
 */
export function resolveStoreDir(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  if (opts.flag) return resolve(opts.flag);
  const home = env.PROCFORGE_HOME;
  if (home) return resolve(join(home, ".procforge"));
  if (env.PROCFORGE_DIR) return resolve(env.PROCFORGE_DIR);
  return resolve(join(cwd, ".procforge"));
}

/** 연결 id 발급 (M7-1-7. 어댑터는 node: 직접 import 금지라 여기서 제공) */
export function newConnectionId(): string {
  return randomUUID();
}

/** 세션 존재 여부 (저장소 판별용) */
function hasSessions(dir: string): boolean {
  try {
    const s = join(dir, "sessions");
    if (!existsSync(s)) return false;
    return readdirSync(s, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/**
 * 같은 프로젝트에 저장소 2개 감지 시 경고문.
 * resolved가 기본값(<projectRoot>/.procforge)이 아닌데 기본값 쪽에도
 * 세션이 있으면, 예전 실행분이 다른 저장소에 있다는 뜻이다.
 */
export function detectDuplicateStores(
  projectRoot: string,
  resolved: string,
): string | null {
  const def = resolve(join(projectRoot, ".procforge"));
  if (resolve(resolved) === def) return null;
  if (!hasSessions(def)) return null;
  return (
    `저장소가 2곳에 있음: 사용 중=${resolved}, 기존=${def}. ` +
    `PROCFORGE_HOME으로 한 곳으로 고정하라. 기존 세션은 ${def}에 있다.`
  );
}
