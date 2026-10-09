import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProcedureDocSchema, importProcedure, type ProcedureDoc } from "../procedure.js";
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
};

export function resolveProcedureRef(procforgeDir: string, ref: string): { dir: string; file: string } {
  const abs = resolve(ref);
  if (ref.endsWith(".json") && existsSync(abs)) {
    return { dir: resolve(abs, "..", ".."), file: abs };
  }
  const byName = join(procforgeDir, "procedures", ref, "procedure.json");
  if (existsSync(byName)) return { dir: join(procforgeDir, "procedures", ref), file: byName };
  if (existsSync(abs)) return { dir: resolve(abs, ".."), file: abs };
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
  });
  return { report, sessionId, procedureDir: dir };
}
