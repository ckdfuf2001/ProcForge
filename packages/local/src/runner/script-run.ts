import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * M7-5-c: 트리 종료는 **run-control 의 killProcessTree 하나**만 쓴다.
 * (이전에 여기 따로 두었다가 SIGTERM 만 보내, SIGTERM 을 무시하는 스크립트가
 *  영원히 안 끝났다 — 유예 후 SIGKILL 은 run-control 이 그룹 기준으로 처리)
 */
async function killScriptTree(pid: number): Promise<void> {
  const { killProcessTree } = await import("../services/process-tree.js");
  await killProcessTree(pid);
}
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
/** M7-5-a: 내용 해시를 붙일 파일 크기 상한 (이하만 해시한다) */
const SNAPSHOT_HASH_MAX_BYTES = 1024 * 1024;
/** M7-5 보정3-a: 해시 **총량** 예산 (파일당 한도와 달리 이 한도 안에서만 읽는다) */
const SNAPSHOT_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
/** 해시를 붙일 파일 수 상한 */
const SNAPSHOT_HASH_FILE_CAP = 10000;

export type ScriptResult = {
  summary: string;
  json: unknown;
};

let cachedPython: string | undefined;
type Snapshot = {
  files: Map<string, string>;
  /** 파일 수 상한에 걸려 **일부만** 비교했다는 표시 (조용히 절반만 보면 안 된다) */
  skipped?: boolean;
  /** 해시 총량 예산을 소진해 이후 파일은 stat 만 기록했다는 표시 */
  hashPartial?: boolean;
};
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

/**
 * 실행 디렉터리 스냅샷.
 * `limits` 는 테스트에서만 한도를 낮춰 **규칙 자체**를 확인하기 위해 넣는다
 * (실제 상한 10만 파일을 채우는 테스트는 불가능하다).
 */
export function snapshotProject(
  projectRoot: string,
  limits?: { fileCap?: number; hashTotalBytes?: number; hashFileCap?: number },
): Snapshot {
  const fileCap = limits?.fileCap ?? SNAPSHOT_FILE_CAP;
  const hashTotal = limits?.hashTotalBytes ?? SNAPSHOT_HASH_TOTAL_BYTES;
  const hashFileCap = limits?.hashFileCap ?? SNAPSHOT_HASH_FILE_CAP;
  const files = new Map<string, string>();
  let count = 0;
  let skipped = false;
  let hashPartial = false;
  let hashedBytes = 0;
  let hashedFiles = 0;
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
          // 서명 = size : mtimeMs : ctimeMs [ : hash ]
          //  - size:mtime 만으로는 같은 초 안의 같은 크기 덮어쓰기를 못 잡는다
          //    (mtime 해상도가 1초인 파일시스템 — CI 컨테이너 등).
          //  - ctime 은 "mtime 을 되돌려 놓은" 덮어쓰기를 잡는다 (파일당 최대 1MB 밖에서도).
          //  - hash 는 위 둘로도 안 잡히는 경우를 막는다. **총량 예산**이 있다 —
          //    파일당 1MB × 10만 파일이면 실행 한 번에 수십 GB 를 읽을 뻔했다.
          let hash = "";
          if (
            st.size <= SNAPSHOT_HASH_MAX_BYTES &&
            hashedFiles < hashFileCap &&
            hashedBytes + st.size <= hashTotal
          ) {
            hash = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
            hashedBytes += st.size;
            hashedFiles += 1;
          } else if (st.size <= SNAPSHOT_HASH_MAX_BYTES) {
            hashPartial = true;
          }
          files.set(r, `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${hash}`);
          if (++count > fileCap) skipped = true;
        } catch {
          // 소멸·권한: 무시
        }
      }
    }
  };
  walk(resolve(projectRoot), "");
  const snap: Snapshot = { files, skipped };
  if (hashPartial) snap.hashPartial = true;
  return snap;
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
  // M7-5-c: 종료는 **한 번만**. 취소 감시(200ms)가랑 타임아웃이 동시에 걸리면
  // taskkill/SIGTERM 이 겹쳐 계속 쌓인다 (Windows 는 프로세스 생성 자체가 비싸다).
  let terminating: Promise<unknown> | null = null;
  const terminate = (): void => {
    if (pid === undefined) return;
    terminating ??= killScriptTree(pid).catch(() => undefined);
  };
  const cancelWatch = input.isCancelled
    ? setInterval(() => {
        if (input.isCancelled?.()) terminate();
      }, 200)
    : undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
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
      // close 가 왔는데 종료가 아직 진행 중일 수 있다 (SIGTERM 유예 대기).
      // 그대로 끝내면 프로세스가 아직 살아 있다.
      void Promise.resolve(terminating).then(fn);
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
export function outsideChanges(
  input: { projectRoot?: string },
  before: Snapshot | null,
  limits?: { fileCap?: number; hashTotalBytes?: number; hashFileCap?: number },
): string[] | null {
  if (!before || !input.projectRoot) return null;
  const after = snapshotProject(input.projectRoot, limits);
  const diff = diffSnapshot(before, after);
  if (after.skipped || before.skipped) {
    // 스냅샷이 불완전하면 "없음"이 아니라 "판단 불가"를 함께 알린다
    return [...diff, "(스냅샷 상한 초과: 일부만 비교됨)"];
  }
  // 해시 예산 소진은 **감지 민감도 저하**일 뿐 비교 실패는 아니다.
  // 변경이 있을 때만 알린다 — 변경 0건인 대형 저장소를 매번 거부하지 않기 위해서.
  if (diff.length > 0 && (after.hashPartial || before.hashPartial)) {
    return [...diff, "(내용 해시 예산 초과: 일부 파일은 크기/시각만 비교됨)"];
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
