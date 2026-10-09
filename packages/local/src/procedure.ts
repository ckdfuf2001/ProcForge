import { mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArgSpec, Constraint, Node, Session } from "@procforge/shared/schema.js";
import { computeNodeHash } from "@procforge/shared/schema.js";
import { ProcedureDocSchema, type ProcedureDoc } from "@procforge/shared/procedure.js";
import { FileStore } from "./filestore.js";

export { ProcedureDocSchema, type ProcedureDoc };
export { PROCEDURE_NAME_RE } from "@procforge/shared/procedure.js";

// 확정 트리 → 절차서 import (M4). procedure.json이 재실행 입력의 단일 원천.
// NOTE: 세션 직접 저장 (R1 예외 — core import 경로가 생기면 이동, DECISIONS 참조).

/** procedure.json → 실행용 세션 import (테스트·재실행용) */
export function importProcedure(
  procforgeDir: string,
  doc: ProcedureDoc,
  params: Record<string, string> = {},
): { sessionId: string } {
  const parsed = ProcedureDocSchema.parse(doc);
  const store = new FileStore(procforgeDir);
  const sessionId = randomUUID();
  const session: Session = {
    id: sessionId,
    request: `import:${parsed.name}`,
    params: { ...Object.fromEntries(Object.entries(parsed.params).map(([k, v]) => [k, v.default])), ...params },
    toolCatalog: parsed.toolCatalog as Session["toolCatalog"],
    rootId: parsed.nodes.find((n) => n.parentId === null)?.id ?? parsed.nodes[0]?.id ?? "1",
    limits: { maxDepth: 20, maxRetries: 2, maxNodes: 500 },
    createdAt: new Date().toISOString(),
    revision: 0,
  };
  store.saveSession(session);
  for (const n of parsed.nodes) {
    const lastArgs = (n.goldenArgs ?? {}) as Record<string, unknown>;
    const attemptId = n.golden?.attemptId ?? randomUUID();
    const node: Node = {
      id: n.id,
      parentId: n.parentId,
      goal: n.goal,
      status: n.tool ? "leaf" : n.children.length > 0 ? "split" : "open",
      depth: n.depth,
      dependsOn: n.dependsOn,
      children: n.children,
      tool: n.tool ? { ...n.tool } : undefined,
      args: (n.args ?? {}) as Record<string, ArgSpec>,
      sideEffect: n.sideEffect,
      constraints: (n.constraints ?? []) as Constraint[],
      advice: [],
      attempts: n.tool
        ? [{
          id: attemptId,
          at: parsed.createdAt,
          tool: { server: n.tool.server, name: n.tool.name },
          args: lastArgs,
          resultSummary: n.golden?.output ?? "",
          artifacts: n.golden?.fixtures ?? [],
          verdict: "pass" as const,
          failedConstraints: [],
        }]
        : [],
      golden: n.golden ? { fixtures: [...n.golden.fixtures], output: n.golden.output, attemptId, ignore: n.golden.ignore ?? [] } : undefined,
      retries: 0,
      hash: computeNodeHash({ goal: n.goal, args: (n.args ?? {}) as Record<string, ArgSpec>, constraints: (n.constraints ?? []) as Constraint[], dependsOn: [] }),
      locked: false,
    };
    store.saveNode(sessionId, node);
  }
  // tests/ 사본 → 세션으로 복사
  const procTests = join(procforgeDir, "procedures", parsed.name, "tests");
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
  const mf = join(procTests, "fixtures-manifest.json");
  if (existsSync(mf)) copyFileSync(mf, join(sessDir, "fixtures-manifest.json"));
  return { sessionId };
}
