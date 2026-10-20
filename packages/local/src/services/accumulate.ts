import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { pfError } from "@procforge/shared/errors.js";
import {
  AccumulateSpecSchema,
  type AccumulateSpec,
} from "@procforge/shared/procedure.js";
import { writeAtomicFile } from "../fsutil.js";
import { appendRunLog, runDir } from "./run-log.js";

// M7-close-i: run 사이에 유지해야 하는 산출물(누적 CSV 등)을 procedure 단위
// 상태 폴더에 보존한다. run fs는 매 실행 fixture/상태로 새로 만들고,
// 전 노드 pass일 때만 write-back 한다 (실패 실행이 상태를 오염시키지 않게).

export function normalizeAccumulate(
  specs: AccumulateSpec[] | undefined,
): AccumulateSpec[] | undefined {
  if (!specs || specs.length === 0) return undefined;
  const seen = new Set<string>();
  const out = specs.map((s) => {
    const path = String(s.path ?? "").split("\\").join("/");
    const node = String(s.node ?? "");
    if (!isSafeRel(path)) {
      throw pfError("bad_request", `accumulate 경로가 안전하지 않음: ${s.path}`);
    }
    if (!node) throw pfError("bad_request", `accumulate node 누락: ${path}`);
    if (seen.has(path)) {
      throw pfError("bad_request", `accumulate 경로 중복: ${path}`);
    }
    seen.add(path);
    return { path, node };
  });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function validateAccumulate(
  specs: AccumulateSpec[] | undefined,
  nodeIds: Set<string>,
): void {
  for (const s of specs ?? []) {
    if (!nodeIds.has(s.node)) {
      throw pfError(
        "bad_request",
        `accumulate node 없음: ${s.node} (${s.path})`,
      );
    }
  }
}

export function loadAccumulateFromProcedure(
  procedureDir: string,
): AccumulateSpec[] | undefined {
  const file = join(procedureDir, "procedure.json");
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw pfError(
      "bad_request",
      `procedure.json 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const field = (raw as { accumulate?: unknown }).accumulate;
  const parsed = z.array(AccumulateSpecSchema).optional().safeParse(field);
  if (!parsed.success) {
    throw pfError(
      "bad_request",
      `accumulate 선언 오류: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return normalizeAccumulate(parsed.data);
}

export function resolveStateDir(
  procforgeDir: string,
  procedure: string,
  stateRoot?: string,
): string {
  const base =
    stateRoot && stateRoot.trim() !== ""
      ? resolve(stateRoot)
      : join(procforgeDir, "state");
  return join(base, procedure);
}

export type AccumulateStateEntry = AccumulateSpec & {
  /** run 시작 시점 상태 파일 sha (없으면 null) */
  startSha: string | null;
};

export type AccumulateState = {
  version: 1;
  specs: AccumulateStateEntry[];
  applied: boolean;
};

export function accumulateMarkerPath(
  procforgeDir: string,
  runId: string,
): string {
  return join(runDir(procforgeDir, runId), "accumulate.json");
}

function readMarker(
  procforgeDir: string,
  runId: string,
): AccumulateState | undefined {
  const p = accumulateMarkerPath(procforgeDir, runId);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as AccumulateState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.specs)) {
      throw new Error("marker 형식 오류");
    }
    return parsed;
  } catch (e) {
    throw pfError(
      "bad_request",
      `accumulate marker 파싱 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function writeMarker(
  procforgeDir: string,
  runId: string,
  state: AccumulateState,
): void {
  writeAtomicFile(
    accumulateMarkerPath(procforgeDir, runId),
    JSON.stringify(state, null, 2),
  );
}

function isSafeRel(p: string): boolean {
  if (p === "" || p === ".") return false;
  const n = p.split("\\").join("/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split("/").some((part) => part === ".." || part === "");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function log(
  procforgeDir: string,
  runId: string,
  message: string,
): void {
  try {
    appendRunLog(procforgeDir, runId, { level: "info", message });
  } catch {
    // 로그 실패가 누적/실행을 막지 않게 한다.
  }
}

/**
 * run 시작 시 상태 폴더 → run fs overlay. runId 당 1회만 수행한다
 * (UI는 runSession을 단계별로 여러 번 호출하므로 marker가 필요).
 */
export function seedAccumulate(input: {
  procforgeDir: string;
  runId: string;
  stateDir: string;
  fsDir: string;
  specs: AccumulateSpec[];
}): AccumulateState {
  const existing = readMarker(input.procforgeDir, input.runId);
  if (existing) return existing;
  const entries: AccumulateStateEntry[] = [];
  for (const spec of input.specs) {
    const stateFile = join(input.stateDir, spec.path);
    const fsFile = join(input.fsDir, spec.path);
    let startSha: string | null = null;
    if (existsSync(stateFile)) {
      if (!statSync(stateFile).isFile()) {
        throw pfError(
          "bad_request",
          `accumulate 상태가 파일 아님: ${stateFile}`,
        );
      }
      mkdirSync(dirname(fsFile), { recursive: true });
      copyFileSync(stateFile, fsFile);
      startSha = sha256File(stateFile);
      log(input.procforgeDir, input.runId, `누적 상태 로드: ${spec.path}`);
    } else {
      // 상태 파일이 없는 것이 시작점이다. fixture 내용을 startSha로 쓰면
      // 첫 write-back이 "현재 상태 없음"과 충돌하므로 null로 둔다.
      startSha = null;
      const hasFixture = existsSync(fsFile);
      log(
        input.procforgeDir,
        input.runId,
        `초기화: ${spec.path} (누적 상태 없음${hasFixture ? " — fixture 사용" : ""})`,
      );
    }
    entries.push({ ...spec, startSha });
  }
  const state: AccumulateState = { version: 1, specs: entries, applied: false };
  writeMarker(input.procforgeDir, input.runId, state);
  return state;
}

export function markAccumulateApplied(
  procforgeDir: string,
  runId: string,
  state: AccumulateState,
): void {
  state.applied = true;
  writeMarker(procforgeDir, runId, state);
}

function accumulateError(
  code: "conflict" | "not_found" | "bad_request",
  path: string,
  node: string,
  message: string,
): Error {
  return Object.assign(new Error(message), { code, path, node });
}

function replaceFile(dest: string, data: Buffer): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "EPERM" || code === "EEXIST" || code === "EACCES") {
      rmSync(dest, { force: true });
      renameSync(tmp, dest);
      return;
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * 전 노드 pass 후 run fs → 상태 폴더 write-back.
 * 시작 sha와 현재 상태 sha가 다르면 conflict (다른 실행/수동 변경).
 */
export function writeBackAccumulate(input: {
  state: AccumulateState;
  stateDir: string;
  fsDir: string;
}): { written: string[] } {
  const staged: {
    path: string;
    node: string;
    src: string;
    dest: string;
    data: Buffer;
  }[] = [];
  for (const spec of input.state.specs) {
    const src = join(input.fsDir, spec.path);
    const dest = join(input.stateDir, spec.path);
    if (!existsSync(src) || !statSync(src).isFile()) {
      throw accumulateError(
        "not_found",
        spec.path,
        spec.node,
        `accumulate 결과 파일 없음: ${spec.path}`,
      );
    }
    const current = existsSync(dest) ? sha256File(dest) : null;
    if (current !== spec.startSha) {
      throw accumulateError(
        "conflict",
        spec.path,
        spec.node,
        `accumulate 상태 충돌: ${spec.path} (시작 ${spec.startSha ?? "없음"} ≠ 현재 ${current ?? "없음"})`,
      );
    }
    staged.push({ ...spec, src, dest, data: readFileSync(src) });
  }
  const written: string[] = [];
  for (const item of staged) {
    if (existsSync(item.dest)) {
      mkdirSync(dirname(item.dest), { recursive: true });
      copyFileSync(item.dest, `${item.dest}.bak`);
    }
    replaceFile(item.dest, item.data);
    written.push(item.path);
  }
  return { written };
}

/** 테스트/진단용: 상태 파일 경로 */
export function accumulateStatePath(
  stateDir: string,
  rel: string,
): string {
  return join(stateDir, rel);
}
