import { mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ProcedureDocSchema,
  buildImportSession,
  type ProcedureDoc,
} from "@procforge/shared/procedure.js";
import { FileStore } from "./filestore.js";

export { ProcedureDocSchema, type ProcedureDoc };
export { PROCEDURE_NAME_RE } from "@procforge/shared/procedure.js";

// 확정 트리 → 절차서 import (M4). procedure.json이 재실행 입력의 단일 원천.
// 세션·노드 조립은 shared buildImportSession (core pfImportProcedure와 공유).
// NOTE: 세션 직접 저장 (R1 예외 — DECISIONS 참조).

/** procedure.json → 실행용 세션 import (테스트·재실행용) */
export function importProcedure(
  procforgeDir: string,
  doc: ProcedureDoc,
  params: Record<string, string> = {},
): { sessionId: string } {
  const { session, nodes } = buildImportSession(doc, params);
  const parsed = ProcedureDocSchema.parse(doc);
  const store = new FileStore(procforgeDir);
  const sessionId = session.id;
  store.saveSession(session);
  for (const node of nodes) {
    store.saveNode(sessionId, node);
  }
  // tests/ 사본 → 세션으로 복사
  copyImportFiles(procforgeDir, parsed.name, sessionId);
  return { sessionId };
}

/** 절차서 tests·scripts → 세션 dir 파일 복사 (M6.1-2. remote import도 병행) */
export function copyImportFiles(
  procforgeDir: string,
  procName: string,
  sessionId: string,
): void {
  const procTests = join(procforgeDir, "procedures", procName, "tests");
  const sessDir = join(procforgeDir, "sessions", sessionId);
  const copyTree = (src: string, dst: string) => {
    if (!existsSync(src)) return;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        const rel = p.substring(src.length + 1);
        mkdirSync(dirname(join(dst, rel)), { recursive: true });
        copyFileSync(p, join(dst, rel));
      }
    };
    walk(src);
  };
  copyTree(join(procTests, "fixtures"), join(sessDir, "fixtures"));
  copyTree(join(procTests, "cassettes"), join(sessDir, "cassettes"));
  // M5.2-2: 절차서 scripts/ → 세션 scripts/ (run fs 실행용)
  copyTree(
    join(procforgeDir, "procedures", procName, "scripts"),
    join(sessDir, "scripts"),
  );
  const mf = join(procTests, "fixtures-manifest.json");
  if (existsSync(mf)) copyFileSync(mf, join(sessDir, "fixtures-manifest.json"));
}
