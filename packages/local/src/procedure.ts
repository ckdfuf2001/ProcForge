import { mkdirSync, copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArgSpec, Constraint, Node, Session } from "@procforge/shared/schema.js";
import { computeNodeHash } from "@procforge/shared/schema.js";
import { isResolved } from "@procforge/shared/deps.js";
import { compareNodeIds } from "@procforge/shared/ids.js";
import { restoreParamsPlaceholders } from "@procforge/shared/normalize.js";
import { FileStore } from "./filestore.js";
import { validateTree } from "@procforge/shared/validator.js";
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

/**
 * 원자 디렉터리 교체 (M4.1-5). Windows는 rename 덮어쓰기가 안 되므로
 * 기존 폴더를 .old로 이동 후 교체·삭제. 실패 시 롤백 시도.
 */
export function swapDir(tmpDir: string, finalDir: string): void {
  if (!existsSync(finalDir)) {
    renameSync(tmpDir, finalDir);
    return;
  }
  const oldDir = `${finalDir}.old`;
  if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  renameSync(finalDir, oldDir);
  try {
    renameSync(tmpDir, finalDir);
  } catch (e) {
    try {
      renameSync(oldDir, finalDir);
    } catch {
      // 롤백 best-effort
    }
    throw e;
  }
  rmSync(oldDir, { recursive: true, force: true });
}

/** 절차 이름 규칙 (M4.1-6, skill 호환): 소문자·숫자·하이픈, 1~64자 */
export const PROCEDURE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  if (!PROCEDURE_NAME_RE.test(name)) {
    throw Object.assign(new Error(`bad procedure name: ${name} (소문자·숫자·하이픈, 1~64자)`), { code: "bad_request" });
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
  // M4.1-4: 구조 검증 (10종). 오류 있으면 목록과 함께 거부.
  const violations = validateTree(session, nodes);
  if (violations.length > 0) {
    throw Object.assign(
      new Error(`검증 오류 ${violations.length}건: ${violations.map((v) => `[${v.code}]${v.nodeId ? ` ${v.nodeId}` : ""} ${v.message}`).join("; ")}`),
      { code: "bad_request" },
    );
  }
  // fixed == params 경고 (재사용 깨짐). M4.1-3: 부분 문자열 포함까지 확대
  // (짧은 값 오경보 방지: 길이 3 이상만). golden은 자리표시자 복원 후 검사.
  const warnings: string[] = [];
  const paramEntries = Object.entries(session.params).filter(([, v]) => v.length >= 3);
  for (const n of nodes) {
    if (n.args) {
      for (const [k, spec] of Object.entries(n.args)) {
        const s = spec as ArgSpec;
        if (s.kind !== "fixed" || typeof (s as { value: unknown }).value !== "string") continue;
        const v = (s as { value: string }).value;
        for (const [pk, pv] of paramEntries) {
          if (v === pv) warnings.push(`${n.id}.${k}="${v}": params 값과 동일한 fixed (var 후보)`);
          else if (v.includes(pv)) warnings.push(`${n.id}.${k}="${v}": params "${pk}" 값을 부분 포함 (var 후보)`);
        }
      }
    }
    if (n.golden) {
      const restored = restoreParamsPlaceholders(n.golden.output, session.params);
      for (const [pk, pv] of paramEntries) {
        if (restored.includes(pv)) warnings.push(`${n.id}.golden.output: params "${pk}" 값을 포함 (재바인딩 확인)`);
      }
    }
  }

  const dir = procDir(procforgeDir, name);
  // M4.1-1 force 게이트 (쓰기 전 거부). M4.1-5: tmp 빌드 후 원자 교체.
  const projectRoot = opts.projectRoot ?? dirname(procforgeDir);
  const commandFile = join(projectRoot, ".opencode", "command", `${name}.md`);
  if (!opts.force && existsSync(commandFile)) {
    throw Object.assign(
      new Error(`명령 파일이 이미 있음: ${commandFile} (--force로 덮어쓰기)`),
      { code: "bad_request" },
    );
  }
  const buildDir = `${dir}.tmp-${randomUUID()}`;
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
    const p = join(buildDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    files.push(rel.replace(/\\/g, "/"));
  };
  put("procedure.json", JSON.stringify(doc, null, 2));
  put("PROCEDURE.md", renderProcedureMd(doc));
  put("SKILL.md", renderSkillMd(doc));
  const commandMd = renderCommandMd(doc);
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
        mkdirSync(dirname(join(buildDir, dstRel, rel)), { recursive: true });
        copyFileSync(p, join(buildDir, dstRel, rel));
        files.push(`${dstRel}/${rel}`);
      }
    };
    walk(abs);
  };
  copyTree("fixtures", "tests/fixtures");
  copyTree("cassettes", "tests/cassettes");
  const mf = join(sessDir, "fixtures-manifest.json");
  if (existsSync(mf)) {
    copyFileSync(mf, join(buildDir, "tests", "fixtures-manifest.json"));
    files.push("tests/fixtures-manifest.json");
  }
  // M4.1-5: tmp에 빌드 후 원자 교체 (실패 시 tmp 정리)
  try {
    swapDir(buildDir, dir);
  } catch (e) {
    rmSync(buildDir, { recursive: true, force: true });
    throw e;
  }
  mkdirSync(dirname(commandFile), { recursive: true });
  writeFileSync(commandFile, commandMd);
  return { name, dir, warnings, files: files.sort(), commandFile };
}

function renderProcedureMd(doc: ProcedureDoc): string {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  // M4.1-2: 노드 id 숫자 정렬 (1.2 < 1.10)
  const order = [...doc.nodes].sort((a, b) => compareNodeIds(a.id, b.id));
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
    `description: ProcForge 확정 절차 (${steps}단계). 검증(replay)만 가능, 새 데이터 실행은 미지원(M5).`,
    "---",
    ``,
    `# ${doc.name}`,
    ``,
    `이 skill은 확정된 절차를 검증(replay)한다. 탐색 금지.`,
    `새 데이터 실행(live)은 미지원(M5 예정). params 변경 시 passthrough drift로 검출된다.`,
    `파라미터: ${Object.keys(doc.params).map((k) => `\`${k}\``).join(", ") || "없음"}`,
    ``,
    `검증: \`procforge test procedures/${doc.name} --param k=v ...\``,
    `상세 단계는 PROCEDURE.md 참조. 실패 시 단계 번호와 constraint를 보고하라.`,
    ``,
  ].join("\n");
}

function renderCommandMd(doc: ProcedureDoc): string {
  return [
    `# /${doc.name}`,
    ``,
    `이 절차를 검증(replay)한다. 탐색 금지, 실패 시 단계 번호 보고.`,
    `새 데이터 실행(live)은 미지원(M5 예정).`,
    ``,
    `파라미터: ${Object.entries(doc.params).map(([k, v]) => `${k}="${v.default}"`).join(" ") || "없음"}`,
    `검증: \`procforge test procedures/${doc.name}\` + --param 전달.`,
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
