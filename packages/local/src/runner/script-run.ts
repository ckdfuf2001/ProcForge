import { spawnSync } from "node:child_process";

// 스크립트 leaf 실행 (M5.2-2). runner가 run fs에서 호스트 스크립트를 실행.
// - stdin: 해석된 인자 JSON (script-kind 항목 제외).
// - stdout: JSON {"summary"?: string, "json"?: unknown} (BOM 허용, 앞뒤 공백 허용).
// - cwd=run fs. 프로젝트 경로는 전달하지 않음 (쓰기 금지 = 신뢰 경계, MCP 서버와 동일).
// - 타임아웃 초과·0이 아닌 종료·JSON 파싱 실패는 throw (호출자가 fail 처리).

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60000;

export type ScriptResult = {
  summary: string;
  json: unknown;
};

export function runScript(input: {
  runtime: string;
  scriptAbs: string;
  args: Record<string, unknown>;
  cwd: string;
  timeoutMs?: number;
}): ScriptResult {
  const timeout = input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const cmd = input.runtime === "node" ? process.execPath : "python";
  // Windows 로캘(cp949) stdio가 한글 JSON을 깨뜨려 서로게이트가 생기므로
  // python 실행 시 UTF-8로 고정 (M5-dogfood MCP 관측과 동일).
  const env = input.runtime === "python"
    ? { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    : process.env;
  const r = spawnSync(cmd, [input.scriptAbs], {
    cwd: input.cwd,
    input: JSON.stringify(input.args),
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  const errTail = (r.stderr ?? "").toString().slice(-2000);
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw Object.assign(
      new Error(timedOut ? `스크립트 타임아웃(${timeout}ms): ${input.scriptAbs}` : `스크립트 실행 실패: ${String(r.error)}${errTail ? ` | ${errTail}` : ""}`),
      { code: timedOut ? "timeout" : "bad_request" },
    );
  }
  if (r.status !== 0) {
    throw Object.assign(new Error(`스크립트 비정상 종료(${r.status}): ${input.scriptAbs}${errTail ? ` | ${errTail}` : ""}`), {
      code: "bad_request",
    });
  }
  const text = (r.stdout ?? "").toString().replace(/^\uFEFF/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`스크립트 출력이 JSON 아님: ${input.scriptAbs}: ${text.slice(0, 200)}`), {
      code: "bad_request",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`스크립트 출력은 객체여야 함: ${input.scriptAbs}`), { code: "bad_request" });
  }
  const o = parsed as { summary?: unknown; json?: unknown };
  return {
    summary: typeof o.summary === "string" ? o.summary : text.slice(0, 2000),
    json: o.json ?? parsed,
  };
}
