import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { delimiter, join, resolve } from "node:path";

// 스크립트 leaf 실행 (M5.2-2). runner가 run fs에서 호스트 스크립트를 실행.
// - stdin: 해석된 인자 JSON (script-kind 항목 제외).
// - stdout: JSON {"summary"?: string, "json"?: unknown} (BOM 허용, 앞뒤 공백 허용).
// - cwd=run fs. 프로젝트 경로는 전달하지 않음 (쓰기 금지 = 신뢰 경계, MCP 서버와 동일).
// - 타임아웃 초과·0이 아닌 종료·JSON 파싱 실패는 throw (호출자가 fail 처리).
// - M5.3-3 실행 제한: 자식 환경은 화이트리스트만, python은 절대경로로 해석,
//   실행 전후 projectRoot 스냅샷 비교로 run fs 밖 변경 감지 → throw.
//   OS 수준 sandbox가 아니다 (네트워크·프로세스 격리 없음, DECISIONS 참조).
// - M7-5-a: **비동기** 실행. spawnSync 옛에는 실행이 이벤트 루프를 막아
//   취소가 중간에 도달하지 못했다(길게 걸린 스크립트는 끝까지 돈다).

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60000;

/** M7-5-b: 트리 종료 (POSIX 는 그룹, Windows 는 taskkill /T) */
export function killScriptTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 이미 종료됨
    }
  }
}

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
type Snapshot = { files: Map<string, string>; skipped?: boolean };
const MAX_BUF = 10 * 1024 * 1024;

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
  // Windows 로캘(cp949) stdio가 한글 JSON 을 깨뜨릴 수 있어 무조건 UTF-8 고정.
  out.PYTHONUTF8 = "1";
  out.PYTHONIOENCODING = "utf-8";
  return out;
}

export function snapshotProject(projectRoot: string): Snapshot {
  const files = new Map<string, string>();
  let count = 0;
  let skipped = false;
  const walk = (dir: string, rel: string): void => {
    if (skipped) return;
    let entries: Dirent<string>[];
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
  /**
   * M7-5-a: 자식 pid 통보 (registerChild/unregisterChild로 연결).
   * 실행이 비동기라 취소가 중간에 끼어들 수 있고, 그 신호가 이 콜백으로 나간다.
   */
  onChild?: (pid: number, proc: ChildProcess) => void;
  /** M7-5-a: 취소 확인. 참이면 트리를 죽이고 cancelled로 끝낸다. */
  isCancelled?: () => boolean;
}): Promise<ScriptResult> {
  const timeout = input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const cmd = input.runtime === "node" ? process.execPath : findPython();
  const before = input.projectRoot ? snapshotProject(input.projectRoot) : null;
  // M7-5-b: POSIX 는 detached 로 띄워 프로세스 **그룹 리더**로 만든다.
  // 그래야 그룹 시그널이 손자까지 닿는다.
  const child = spawn(cmd, [input.scriptAbs], {
    cwd: input.cwd,
    env: childEnv(),
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid !== undefined) input.onChild?.(pid, child);
  const cancelWatch = input.isCancelled
    ? setInterval(() => {
        if (input.isCancelled?.() && pid !== undefined) killScriptTree(pid);
      }, 200)
    : undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid !== undefined) killScriptTree(pid);
  }, timeout);

  return new Promise<ScriptResult>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelWatch) clearInterval(cancelWatch);
      fn();
    };
    child.stdout?.on("data", (b: Buffer) => {
      outLen += b.length;
      if (outLen <= MAX_BUF) out.push(b);
    });
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) =>
      done(() =>
        reject(
          Object.assign(new Error(`스크립트 실행 실패: ${String(e)}`), {
            code: "bad_request",
          }),
        ),
      ),
    );
    child.on("close", (code, signal) => {
      done(() => {
        if (input.isCancelled?.()) {
          reject(Object.assign(new Error("취소됨"), { code: "cancelled" }));
          return;
        }
        // 타임아웃은 트리를 죽였기 때문에 종료코드가 1 이 된다 — 원인(타임아웃)을
        // 잃지 않게 먼저 판정한다.
        if (timedOut) {
          reject(
            Object.assign(
              new Error(`스크립트 타임아웃(${timeout}ms): ${input.scriptAbs}`),
              { code: "timeout" },
            ),
          );
          return;
        }
        // M5.3-3: 바깥 변경 감지를 **종료 코드보다 먼저** 한다 — 실패한 스크립트가
        // 바깥을 망가뜨려도 (exit 1 + 흔적 없음) 흔적이 남아야 한다.
        const escaped = outsideChanges(input, before);
        // 바깥 변경은 **성공 여부와 무관하게** 거부한다 (M5.3-3).
        if (escaped !== null) {
          reject(
            Object.assign(
              new Error(
                `run fs 밖 변경 감지 (${escaped.length}건+): ${escaped.join(", ")} — 스크립트는 run fs 안에서만 쓰라`,
              ),
              { code: "bad_request", escapedChanges: escaped },
            ),
          );
          return;
        }
        try {
          if (code !== 0 && code !== null) {
            throw Object.assign(
              new Error(`스크립트 비정상 종료(${code}): ${input.scriptAbs}${tail(err)}`),
              { code: "bad_request" },
            );
          }
          if (code === null && signal) {
            throw Object.assign(
              new Error(`스크립트 종료 신호(${signal}): ${input.scriptAbs}${tail(err)}`),
              { code: "bad_request" },
            );
          }
          resolve(parseOutput(Buffer.concat(out).toString("utf8"), input.scriptAbs));
        } catch (e) {
          // 원래 오류를 유지한 채 바깥 변경 사실을 **같이** 알린다 (어느 쪽이든 잃지 않는다)
          const err = escaped !== null
            ? Object.assign(e as Error, {
                escapedChanges: escaped,
                message: describeRunError(e),
              })
            : (e as Error);
          reject(err);
          return;
        }
      });
    });
    try {
      child.stdin?.end(JSON.stringify(input.args));
    } catch {
      // 이미 종료된 경우 무시
    }
  });
}

/**
 * M5.3-3: run fs 밖에서 일어난 변경 목록 (없으면 null).
 * 성공·실패 무관하게 **먼저** 호출해야 한다 — 실패한 스크립트가 흔적 없이
 * 바깥을 망가뜨리면 아무도 모른다.
 */
function outsideChanges(
  input: { projectRoot?: string },
  before: Snapshot | null,
): string[] | null {
  if (!before || !input.projectRoot) return null;
  const after = snapshotProject(input.projectRoot);
  const diff = diffSnapshot(before, after);
  if (after.skipped || before.skipped) {
    // 스냅샷이 불완전하면 "없음"이 아니라 "판단 불가"를 함께 알린다
    return [...diff, "(스냅샷 상한 초과: 일부만 비교됨)"];
  }
  return diff.length > 0 ? diff : null;
}

/** 바깥 변경 사실까지 붙인 오류 메시지 (사용자에게 보이는 문자열) */
export function describeRunError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const escaped = (e as { escapedChanges?: string[] }).escapedChanges;
  if (!escaped || escaped.length === 0) return msg;
  return `${msg} | run fs 밖 변경 감지 (${escaped.length}건): ${escaped.join(", ")}`;
}

function tail(err: Buffer[]): string {
  const t = Buffer.concat(err).toString("utf8").slice(-2000);
  return t ? ` | ${t}` : "";
}

function parseOutput(raw: string, scriptAbs: string): ScriptResult {
  const text = raw.replace(/^\uFEFF/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(
      new Error(`스크립트 출력이 JSON 아님: ${scriptAbs}: ${text.slice(0, 200)}`),
      { code: "bad_request" },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(
      new Error(`스크립트 출력은 객체여야 함: ${scriptAbs}`),
      { code: "bad_request" },
    );
  }
  const o = parsed as { summary?: unknown; json?: unknown };
  return {
    summary: typeof o.summary === "string" ? o.summary : text.slice(0, 2000),
    json: o.json ?? parsed,
  };
}
