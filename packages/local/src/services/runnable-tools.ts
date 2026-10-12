import { RUNNER_BUILTINS } from "../runner/connections.js";

// M5.8.1-1: runner 실행 가능 도구 집합 계산 (R2: 상태 변경 없이 계산만,
// 판단(if)은 core가 한다. App은 이 집합을 core confirmLeaf 입력에 넘긴다).
// - catalog의 MCP 도구(server !== "opencode")는 전부 실행 가능.
// - 내장(opencode/*)은 runner 지원(RUNNER_BUILTINS)만 실행 가능.
// - bash는 allowBash가 꺼져 있으면 제외 (기본 거부, 절차서 단위 opt-in은
//   confirm 입력 allowBash + DECISIONS M5.8.1-1).
export function runnableTools(
  catalog: { server: string; name: string }[],
  opts: { allowBash?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const t of catalog) {
    if (t.server === "opencode") {
      if (!(RUNNER_BUILTINS as readonly string[]).includes(t.name)) continue;
      if (t.name === "bash" && opts.allowBash !== true) continue;
    }
    out.push(`${t.server}/${t.name}`);
  }
  return out;
}
