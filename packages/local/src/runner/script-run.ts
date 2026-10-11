import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

// 스크립트 leaf 실행 (M5.2-2). runner가 run fs에서 호스트 스크립트를 실행.
// - stdin: 해석된 인자 JSON (script-kind 항목 제외).
// - stdout: JSON {"summary"?: string, "json"?: unknown} (BOM 허용, 앞뒤 공백 허용).
// - cwd=run fs. 프로젝트 경로는 전달하지 않음 (쓰기 금지 = 신뢰 경계, MCP 서버와 동일).
// - 타임아웃 초과·0이 아닌 종료·JSON 파싱 실패는 throw (호출자가 fail 처리).
// - M5.3-3 실행 제한: 자식 환경은 화이트리스트만, python은 절대경로로 해석,
//   실행 전후 projectRoot 스냅샷 비교로 run fs 밖 변경 감지 → throw.
//   OS 수준 sandbox가 아니다 (네트워크·프로세스 격리 없음, DECISIONS 참조).

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60000;

/** 자식 프로세스에 넘기는 환경변수 화이트리스트 (M5.3-3) */
const ENV_ALLOW = new Set([
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
  "LANG",
  "LC_ALL",
]);

/** 스냅샷 제외 디렉터리 (run fs·스토어·의존성·버전관리) */
const SNAPSHOT_SKIP = new Set([".procforge", "node_modules", ".git"]);

const SNAPSHOT_FILE_CAP = 100000;

export type ScriptResult = {
  summary: string;
  json: unknown;
};

let cachedPython: string | undefined;

function findPython(): string {
  if (cachedPython) return cachedPython;
  const names = process.platform === "win32" ? ["python.exe"] : ["python3", "python"];
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    for (const n of names) {
      const cand = join(dir, n);
      if (existsSync(cand)) {
        cachedPython = cand;
        return cand;
      }
    }
  }
  throw Object.assign(new Error("python 없음 (PATH에 없음)"), { code: "bad_request" });
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW.has(k) && v !== undefined) out[k] = v;
  }
  // Windows 로캘(cp949) stdio가 한글 JSON을 깨뜨려 서로게이트가 생기므로 UTF-8 고정.
  out.PYTHONUTF8 = "1";
  out.PYTHONIOENCODING = "utf-8";
  return out;
}

export type Snapshot = {
  files: Map<string, string>;
  skipped: boolean;
};

/** projectRoot 스냅샷 (rel → "size:mtimeMs"). .procforge/node_modules/.git 제외. */
export function snapshotProject(projectRoot: string): Snapshot {
  const files = new Map<string, string>();
  let count = 0;
  let skipped = false;
  const walk = (dir: string, rel: string): void => {
    if (skipped) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipped) return;
      if (rel === "" && SNAPSHOT_SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(p, r);
      } else if (e.isFile()) {
        try {
          const st = statSync(p);
          files.set(r, `${st.size}:${Math.floor(st.mtimeMs)}`);
          if (++count > SNAPSHOT_FILE_CAP) skipped = true;
        } catch {
          // 소멸·권한: 무시
        }
      }
    }
  };
  walk(resolve(projectRoot), "");
  return { files, skipped };
}

/** 스냅샷 비교. 변경 목록 (최대 10건). 비어 있으면 변경 없음. */
export function diffSnapshot(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [rel, sig] of after.files) {
    if (!before.files.has(rel)) out.push(`+${rel}`);
    else if (before.files.get(rel) !== sig) out.push(`~${rel}`);
    if (out.length >= 10) break;
  }
  if (out.length < 10) {
    for (const rel of before.files.keys()) {
      if (!after.files.has(rel)) out.push(`-${rel}`);
      if (out.length >= 10) break;
    }
  }
  return out;
}

export function runScript(input: {
  runtime: string;
  scriptAbs: string;
  args: Record<string, unknown>;
  cwd: string;
  timeoutMs?: number;
  /** run fs 밖 변경 감지 기준. 없으면 스냅샷 생략. */
  projectRoot?: string;
}): ScriptResult {
  const timeout = input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const cmd = input.runtime === "node" ? process.execPath : findPython();
  const before = input.projectRoot ? snapshotProject(input.projectRoot) : null;
  const r = spawnSync(cmd, [input.scriptAbs], {
    cwd: input.cwd,
    input: JSON.stringify(input.args),
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: childEnv(),
  });
  // M5.3-3: run fs 밖 변경 감지 (성공·실패 무관)
  if (before && input.projectRoot) {
    const diff = diffSnapshot(before, snapshotProject(input.projectRoot));
    if (diff.length > 0) {
      throw Object.assign(
        new Error(`run fs 밖 변경 감지 (${diff.length}건+): ${diff.join(", ")} — 스크립트는 run fs 안에서만 쓰라`),
        { code: "bad_request" },
      );
    }
  }
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
