import { mkdirSync, copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArgSpec, Constraint, Node, Session } from "@procforge/shared/schema.js";
import { computeNodeHash } from "@procforge/shared/schema.js";
import { isResolved } from "@procforge/shared/deps.js";
import { FileStore } from "./filestore.js";
import { constraintSummary } from "./views.js";

// 확정 트리 → 절차서 export/import (M4). procedure.json이 재실행 입력의 단일 원천.

export const ProcedureDocSchema = z.object({
  format: z.literal("procforge-procedure"),
  version: z.literal(1),
  name: z.string().min(1),
  sourceSession: z.string(),
  createdAt: z.string(),
  params: z.record(z.object({ type: z.string(), default: z.string(), description: z.string() })),
  toolCatalog: z.array(z.object({
    server: z.string(),
    name: z.string(),
    inputSchema: z.record(z.unknown()),
    schemaHash: z.string(),
  })),
  nodes: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    goal: z.string(),
    depth: z.number(),
    dependsOn: z.array(z.string()),
    children: z.array(z.string()),
    tool: z.object({ server: z.string(), name: z.string(), schemaHash: z.string() }).optional(),
    args: z.record(z.unknown()).optional(),
    sideEffect: z.enum(["none", "local_write", "external"]),
    constraints: z.array(z.unknown()),
    golden: z.object({
      fixtures: z.array(z.string()),
      output: z.string(),
      attemptId: z.string().optional(),
      ignore: z.array(z.string()).default([]),
    }).optional(),
    goldenArgs: z.record(z.unknown()).optional(),
  })),
});
export type ProcedureDoc = z.infer<typeof ProcedureDocSchema>;

export type FinalizeResult = {
  name: string;
  dir: string;
  warnings: string[];
  files: string[];
  /** 프로젝트 명령 파일 절대경로 (M4.1-1) */
  commandFile: string;
};

function procDir(procforgeDir: string, name: string): string {
  return join(procforgeDir, "procedures", name);
}

export type FinalizeOptions = {
  /** 명령 파일 출력 루트 (기본: procforgeDir의 부모 = projectRoot 가정) */
  projectRoot?: string;
  /** 기존 명령 파일 덮어쓰기 허용 */
  force?: boolean;
};

export function finalizeSession(
  procforgeDir: string,
  sessionId: string,
  name: string,
  opts: FinalizeOptions = {},
): FinalizeResult {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw Object.assign(new Error(`bad procedure name: ${name}`), { code: "bad_request" });
  }
  const store = new FileStore(procforgeDir);
  const session = store.getSession(sessionId);
  if (!session) throw Object.assign(new Error(`세션 없음: ${sessionId}`), { code: "session_not_found" });
  const nodes = [...store.getNodes(sessionId).values()];
  if (nodes.length === 0) throw Object.assign(new Error("빈 세션"), { code: "bad_request" });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 전 노드 resolved 확인
  const unresolved = nodes.filter((n) => !isResolved(n, byId)).map((n) => n.id);
  if (unresolved.length > 0) {
    throw Object.assign(new Error(`미해결 노드: ${unresolved.join(", ")}`), { code: "bad_request" });
  }
  // fixed == params 경고 (재사용 깨짐)
  const warnings: string[] = [];
  const paramValues = new Set(Object.values(session.params));
  for (const n of nodes) {
    if (!n.args) continue;
    for (const [k, spec] of Object.entries(n.args)) {
      const s = spec as ArgSpec;
      if (s.kind === "fixed" && typeof (s as { value: unknown }).value === "string" && paramValues.has((s as { value: string }).value)) {
        warnings.push(`${n.id}.${k}="${(s as { value: string }).value}": params 값과 동일한 fixed (var 후보)`);
      }
    }
  }

  const dir = procDir(procforgeDir, name);
  const doc: ProcedureDoc = {
    format: "procforge-procedure",
    version: 1,
    name,
    sourceSession: sessionId,
    createdAt: new Date().toISOString(),
    params: Object.fromEntries(
      Object.entries(session.params).map(([k, v]) => [k, { type: "string", default: v, description: "" }]),
    ),
    toolCatalog: session.toolCatalog as ProcedureDoc["toolCatalog"],
    nodes: nodes.map((n) => {
      const last = n.attempts[n.attempts.length - 1];
      return {
        id: n.id,
        parentId: n.parentId,
        goal: n.goal,
        depth: n.depth,
        dependsOn: n.dependsOn,
        children: n.children,
        tool: n.tool ? { ...n.tool } : undefined,
        args: n.args as Record<string, unknown> | undefined,
        sideEffect: n.sideEffect,
        constraints: n.constraints as unknown[],
        golden: n.golden ? { ...n.golden, ignore: n.golden.ignore ?? [] } : undefined,
        goldenArgs: last ? { ...last.args } : undefined,
      };
    }),
  };
  const files: string[] = [];
  const put = (rel: string, data: string | Buffer) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    files.push(rel.replace(/\\/g, "/"));
  };
  put("procedure.json", JSON.stringify(doc, null, 2));
  put("PROCEDURE.md", renderProcedureMd(doc));
  put("SKILL.md", renderSkillMd(doc));
  const commandMd = renderCommandMd(doc);
  // M4.1-1: 명령 파일은 프로젝트에 출력, procedures 안에는 사본만.
  // 기존 파일이 있고 force가 없으면 여기서 거부 (procedures 쓰기 전).
  const projectRoot = opts.projectRoot ?? dirname(procforgeDir);
  const commandFile = join(projectRoot, ".opencode", "command", `${name}.md`);
  if (!opts.force && existsSync(commandFile)) {
    throw Object.assign(
      new Error(`명령 파일이 이미 있음: ${commandFile} (--force로 덮어쓰기)`),
      { code: "bad_request" },
    );
  }
  put("command.md", commandMd);
  // tests/: golden + cassette 사본
  const sessDir = join(procforgeDir, "sessions", sessionId);
  const copyTree = (srcRel: string, dstRel: string) => {
    const abs = join(sessDir, srcRel);
    if (!existsSync(abs)) return;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        const rel = p.substring(abs.length + 1).replace(/\\/g, "/");
        mkdirSync(dirname(join(dir, dstRel, rel)), { recursive: true });
        copyFileSync(p, join(dir, dstRel, rel));
        files.push(`${dstRel}/${rel}`);
      }
    };
    walk(abs);
  };
  copyTree("fixtures", "tests/fixtures");
  copyTree("cassettes", "tests/cassettes");
  const mf = join(sessDir, "fixtures-manifest.json");
  if (existsSync(mf)) {
    copyFileSync(mf, join(dir, "tests", "fixtures-manifest.json"));
    files.push("tests/fixtures-manifest.json");
  }
  mkdirSync(dirname(commandFile), { recursive: true });
  writeFileSync(commandFile, commandMd);
  return { name, dir, warnings, files: files.sort(), commandFile };
}

function renderProcedureMd(doc: ProcedureDoc): string {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const order = [...doc.nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const roots = doc.nodes.filter((n) => n.parentId === null || !byId.has(n.parentId as string));
  const L: string[] = [];
  L.push(`# ${doc.name}`, ``, `원본 세션: ${doc.sourceSession} / 생성: ${doc.createdAt}`, ``);
  L.push(`## 파라미터`, ``);
  for (const [k, v] of Object.entries(doc.params)) L.push(`- \`${k}\` (기본값: \`${v.default}\`)`);
  L.push(``, `## 목차`, ``);
  const chapters = order.filter((n) => n.depth <= 1);
  chapters.forEach((c, i) => L.push(`${i + 1}. ${c.goal} (\`${c.id}\`)`));
  L.push(``, `## 단계`, ``);
  let step = 0;
  for (const n of order) {
    if (!n.tool) continue;
    step++;
    L.push(`### ${step}. ${n.goal} (\`${n.id}\`)`, ``);
    L.push(`- 도구: \`${n.tool.server}/${n.tool.name}\``);
    if (n.dependsOn.length > 0) L.push(`- 선행: ${n.dependsOn.map((d) => `\`${d}\``).join(", ")}`);
    L.push(`- 인자:`);
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as ArgSpec;
      if (s.kind === "fixed") L.push(`  - \`${k}\` = \`${JSON.stringify((s as { value: unknown }).value)}\``);
      else if (s.kind === "var") L.push(`  - \`${k}\` ← ${(s as { ref: string }).ref}`);
      else L.push(`  - \`${k}\` = 생성: ${(s as { instruction: string }).instruction}`);
    }
    if (n.constraints.length > 0) {
      L.push(`- 확인 조건:`);
      for (const c of n.constraints) {
        const cc = c as Constraint;
        L.push(`  - [${cc.kind}] ${constraintSummary(cc)}`);
      }
    }
    if (n.golden) L.push(`- 기대 출력: \`${n.golden.output.slice(0, 120)}\``);
    L.push(``);
  }
  void roots;
  return L.join("\n");
}

function renderSkillMd(doc: ProcedureDoc): string {
  const steps = doc.nodes.filter((n) => n.tool).length;
  return [
    "---",
    `name: ${doc.name}`,
    `description: ProcForge 확정 절차 (${steps}단계). params로 재실행 가능.`,
    "---",
    ``,
    `# ${doc.name}`,
    ``,
    `이 skill은 확정된 절차를 그대로 실행한다. 탐색 금지.`,
    `파라미터: ${Object.keys(doc.params).map((k) => `\`${k}\``).join(", ") || "없음"}`,
    ``,
    `실행: \`procforge test procedures/${doc.name} --param k=v ...\``,
    `상세 단계는 PROCEDURE.md 참조. 실패 시 단계 번호와 constraint를 보고하라.`,
    ``,
  ].join("\n");
}

function renderCommandMd(doc: ProcedureDoc): string {
  return [
    `# /${doc.name}`,
    ``,
    `이 절차를 그대로 실행, 탐색 금지, 실패 시 단계 번호 보고.`,
    ``,
    `파라미터: ${Object.entries(doc.params).map(([k, v]) => `${k}="${v.default}"`).join(" ") || "없음"}`,
    `실행: \`procforge test procedures/${doc.name}\` + --param 전달.`,
    ``,
  ].join("\n");
}

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
