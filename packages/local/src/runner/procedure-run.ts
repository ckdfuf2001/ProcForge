import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProcedureDocSchema, type ProcedureDoc } from "@procforge/shared/procedure.js";
import { importProcedure } from "../procedure.js";
import { runSession } from "./run.js";
import type { RunReport } from "./types.js";
import type { RunMode } from "./types.js";

// procedure.json → import → 실행 (M4). 재실행 입력의 단일 원천은 procedure.json.

export type ProcedureRunOptions = {
  procforgeDir: string;
  projectRoot: string;
  mode?: RunMode;
  params?: Record<string, string>;
  updateGolden?: boolean;
  allowBash?: boolean;
  allowProjectRead?: boolean;
  nodeId?: string;
  changed?: boolean;
  /** 무인 실행 (M5.5-4. external은 approvals.json 일치 시에만 실행) */
  unattended?: boolean;
  /** 도구 호출 재시도 (M5.6-f) */
  toolRetry?: { attempts?: number; baseMs?: number };
};

export function resolveProcedureRef(procforgeDir: string, ref: string): { dir: string; file: string } {
  // M5.6-a: 3형식 통일 (.json 파일 / bare name·procedures/ 접두 / 디렉터리).
  // 모두 같은 {dir, file}로 수렴. win32 역슬래시 정규화.
  const norm = (ref ?? "").split("\\").join("/");
  // 1. .json 파일 (절대·상대).
  if (norm.endsWith(".json")) {
    const abs = resolve(norm);
    if (existsSync(abs) && statSync(abs).isFile()) return { dir: dirname(abs), file: abs };
    throw Object.assign(new Error(`procedure 없음: ${ref}`), { code: "not_found" });
  }
  // 2. 존재하는 디렉터리 (절대·상대) → 안의 procedure.json.
  const absDir = resolve(norm);
  if (existsSync(absDir) && statSync(absDir).isDirectory()) {
    const f = join(absDir, "procedure.json");
    if (existsSync(f)) return { dir: absDir, file: f };
    throw Object.assign(new Error(`procedure 없음: ${ref}`), { code: "not_found" });
  }
  // 3. bare name ("procedures/" 접두 허용) → procforgeDir 아래.
  const name = norm.startsWith("procedures/") ? norm.slice("procedures/".length) : norm;
  const byName = join(procforgeDir, "procedures", name, "procedure.json");
  if (name !== "" && existsSync(byName)) {
    return { dir: join(procforgeDir, "procedures", name), file: byName };
  }
  throw Object.assign(new Error(`procedure 없음: ${ref}`), { code: "not_found" });
}

export function loadProcedureDoc(procforgeDir: string, ref: string): { doc: ProcedureDoc; dir: string } {
  const { dir, file } = resolveProcedureRef(procforgeDir, ref);
  try {
    return { doc: ProcedureDocSchema.parse(JSON.parse(readFileSync(file, "utf8"))), dir };
  } catch (e) {
    throw Object.assign(new Error(`procedure 파싱 실패: ${ref} (${e instanceof Error ? e.message : String(e)})`), {
      code: "bad_request",
    });
  }
}

export async function runProcedureTest(
  procforgeDir: string,
  projectRoot: string,
  ref: string,
  opts: ProcedureRunOptions = {} as ProcedureRunOptions,
): Promise<{ report: RunReport; sessionId: string; procedureDir: string }> {
  const o = opts ?? {};
  const { doc, dir } = loadProcedureDoc(procforgeDir, ref);
  const { sessionId } = importProcedure(procforgeDir, doc, o.params ?? {});
  const report = await runSession({
    procforgeDir,
    projectRoot,
    sessionId,
    nodeId: o.nodeId,
    mode: o.mode ?? "replay",
    updateGolden: o.updateGolden ?? false,
    allowBash: o.allowBash ?? false,
    allowProjectRead: o.allowProjectRead ?? false,
    changed: o.changed ?? false,
    procedureDir: dir,
    unattended: o.unattended ?? false,
    ...(o.toolRetry ? { toolRetry: o.toolRetry } : {}),
  });
  return { report, sessionId, procedureDir: dir };
}
