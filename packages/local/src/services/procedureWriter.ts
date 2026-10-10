import { mkdirSync, copyFileSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { compareNodeIds } from "@procforge/shared/ids.js";
import type { ArgSpec, Constraint } from "@procforge/shared/schema.js";
import type { ProcedureDoc } from "@procforge/shared/procedure.js";
import { constraintSummary } from "../views.js";

// 절차서 파일 기록 (M4.2-1, finalize에서 이동). App 경유, 어댑터 직접 호출 금지.

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

export type WriteProcedureResult = {
  dir: string;
  files: string[];
  commandFile: string;
};

export function writeProcedure(input: {
  procforgeDir: string;
  projectRoot?: string;
  sessionId: string;
  doc: ProcedureDoc;
  force?: boolean;
  /** 고정값 감사 결과 (M5.1-B1, PROCEDURE.md 기록용) */
  auditFindings?: string[];
}): WriteProcedureResult {
  const { procforgeDir, doc } = input;
  const name = doc.name;
  const dir = procDir(procforgeDir, name);
  // M4.1-1 force 게이트 (쓰기 전 거부). M4.1-5: tmp 빌드 후 원자 교체.
  const projectRoot = input.projectRoot ?? dirname(procforgeDir);
  const commandFile = join(projectRoot, ".opencode", "command", `${name}.md`);
  if (!input.force && existsSync(commandFile)) {
    throw Object.assign(
      new Error(`명령 파일이 이미 있음: ${commandFile} (--force로 덮어쓰기)`),
      { code: "bad_request" },
    );
  }
  const buildDir = `${dir}.tmp-${randomUUID()}`;
  const files: string[] = [];
  const put = (rel: string, data: string | Buffer) => {
    const p = join(buildDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    files.push(rel.replace(/\\/g, "/"));
  };
  put("procedure.json", JSON.stringify(doc, null, 2));
  put("PROCEDURE.md", renderProcedureMd(doc, input.auditFindings ?? []));
  put("SKILL.md", renderSkillMd(doc));
  const commandMd = renderCommandMd(doc);
  put("command.md", commandMd);
  // tests/: golden + cassette 사본
  const sessDir = join(procforgeDir, "sessions", input.sessionId);
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
  return { dir, files: files.sort(), commandFile };
}

function renderProcedureMd(doc: ProcedureDoc, auditFindings: string[] = []): string {
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
  L.push(`## 고정값 감사 (M5.1-B1)`, ``);
  if (auditFindings.length === 0) {
    L.push(`- 발견 없음. 고정 인자·제약에 params 값·날짜 표현·녹화 수치 하드코딩이 없다.`, ``);
  } else {
    for (const f of auditFindings) L.push(`- ${f}`);
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
    `description: ProcForge 확정 절차 (${steps}단계). 검증(replay) + 새 데이터 실행(run) 가능.`,
    "---",
    ``,
    `# ${doc.name}`,
    ``,
    `이 skill은 확정된 절차를 검증(replay)하거나 새 데이터로 실행(run)한다. 탐색 금지.`,
    `파라미터: ${Object.keys(doc.params).map((k) => `\`${k}\``).join(", ") || "없음"}`,
    ``,
    `검증: \`procforge test procedures/${doc.name} --param k=v ...\``,
    `실행: \`procforge run procedures/${doc.name} --param k=v ... [--out dir]\``,
    `상세 단계는 PROCEDURE.md 참조. 실패 시 단계 번호와 constraint를 보고하라.`,
    ``,
  ].join("\n");
}

function renderCommandMd(doc: ProcedureDoc): string {
  return [
    `# /${doc.name}`,
    ``,
    `이 절차를 검증(replay)하거나 새 데이터로 실행(run)한다. 탐색 금지, 실패 시 단계 번호 보고.`,
    ``,
    `파라미터: ${Object.entries(doc.params).map(([k, v]) => `${k}="${v.default}"`).join(" ") || "없음"}`,
    `검증: \`procforge test procedures/${doc.name}\` + --param 전달.`,
    `실행: \`procforge run procedures/${doc.name}\` + --param 전달.`,
    ``,
  ].join("\n");
}
