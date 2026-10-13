import { mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * M5.8.1-3: Windows 파일 잠금(AV 스캔 등) 경합에 EPERM/EBUSY/ENOTEMPTY면
 * 재시도. 그래도 실패하면 coded 에러 (internal 금지).
 */
export function swapDir(tmpDir: string, finalDir: string): void {
  try {
    if (!existsSync(finalDir)) {
      renameWithRetry(tmpDir, finalDir);
      return;
    }
    const oldDir = `${finalDir}.old`;
    if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
    renameWithRetry(finalDir, oldDir);
    try {
      renameWithRetry(tmpDir, finalDir);
    } catch (e) {
      try {
        renameWithRetry(oldDir, finalDir);
      } catch {
        // 롤백 best-effort
      }
      throw e;
    }
    rmSync(oldDir, { recursive: true, force: true });
  } catch (e) {
    throw codedFs(e, `디렉터리 교체 실패(${tmpDir} → ${finalDir})`);
  }
}

/** 코드 없는 fs 예외를 io_error로 (internal 금지). coded는 그대로. */
export function codedFs(e: unknown, what: string): Error {
  const code = (e as { code?: string } | null)?.code;
  if (typeof code === "string" && ["bad_request", "conflict", "not_found", "bad_args", "io_error"].includes(code)) {
    return e as Error;
  }
  return Object.assign(new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`), { code: "io_error" });
}

const RETRYABLE_FS = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
  }
}

/** Windows 잠금 경합 시 재시도 후 rename (M5.8.1-3) */
function renameWithRetry(from: string, to: string, tries = 3): void {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      last = e;
      if (!(e instanceof Error) || !RETRYABLE_FS.has((e as { code?: string }).code ?? "")) throw e;
      if (i + 1 < tries) sleepSync(100 * (i + 1));
    }
  }
  throw last;
}

export type WriteProcedureResult = {
  dir: string;
  files: string[];
  commandFile: string;
};

/**
 * M5.3.1-1: auto file_exists 경로를 논리 경로로 변환.
 * fixtures/<id>/<attempt>/ 형태 → manifest 역조회(source rel). source가
 * 바인딩 인자(var 템플릿)의 확정값과 같으면 템플릿 문자열로, 아니면 source rel.
 * 변환 후에도 fixtures/ 형태가 남으면 finalize 실패(bad_request).
 */
export function rewriteAutoFileExists(doc: ProcedureDoc, manifestFile: string): ProcedureDoc {
  let manifest: Record<string, string> = {};
  try {
    if (existsSync(manifestFile)) manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, string>;
  } catch {
    manifest = {};
  }
  for (const n of doc.nodes as (ProcedureDoc["nodes"][number] & {
    args?: Record<string, ArgSpec>;
    goldenArgs?: Record<string, unknown>;
  })[]) {
    for (const c of (n.constraints ?? []) as (Constraint & { source?: string })[]) {
      if (c.kind !== "file_exists" || (c as { source?: string }).source !== "auto") continue;
      const spec = (c as unknown as { spec?: { path?: unknown } }).spec;
      const p = typeof spec?.path === "string" ? spec.path : null;
      if (!p || !p.startsWith("fixtures/")) continue;
      const src = manifest[p];
      if (!src) continue; // 매핑 없음 → 게이트에서 거부
      const goldenArgs = n.goldenArgs ?? {};
      const boundKey = Object.keys(goldenArgs).find((k) => {
        if ((goldenArgs as Record<string, unknown>)[k] !== src) return false;
        const s = (n.args ?? {})[k] as ArgSpec | undefined;
        return !!s && s.kind === "var" && typeof (s as { ref?: unknown }).ref === "string" &&
          ((s as { ref: string }).ref.includes("${params."));
      });
      (spec as { path: string }).path = boundKey
        ? ((n.args as Record<string, ArgSpec>)[boundKey] as unknown as { ref: string }).ref
        : src;
    }
  }
  const leftover: string[] = [];
  for (const n of doc.nodes) {
    for (const c of (n.constraints ?? []) as (Constraint & { source?: string })[]) {
      if (c.kind !== "file_exists" || (c as { source?: string }).source !== "auto") continue;
      const p = (c as unknown as { spec?: { path?: unknown } }).spec?.path;
      if (typeof p === "string" && p.startsWith("fixtures/")) leftover.push(`${n.id}:${p}`);
    }
  }
  if (leftover.length > 0) {
    throw Object.assign(
      new Error(`procedure.json에 시스템 fixture 경로 잔류: ${leftover.join(", ")}`),
      { code: "bad_request" },
    );
  }
  return doc;
}

/**
 * M5.2-2: script-kind 인자의 호스트 스크립트 수집.
 * procedures/<name>/scripts/<nodeId>.<ext>로 복사하고 doc의 file 값을
 * 수집 경로로 재작성. 노드당 스크립트 1개 초과·미존재·범위 밖·확장자 불가는
 * finalize 실패(bad_request). doc을 변형해 반환 (호출자가 procedure.json 기록).
 */
export function collectScripts(
  doc: ProcedureDoc,
  projectRoot: string,
  buildDir: string,
  files: string[],
): ProcedureDoc {
  const normRoot = projectRoot.split("\\").join("/").replace(/\/$/, "");
  for (const n of doc.nodes as (ProcedureDoc["nodes"][number] & { args?: Record<string, ArgSpec> })[]) {
    const entries = Object.entries(n.args ?? {}).filter(([, s]) => (s as ArgSpec).kind === "script");
    if (entries.length > 1) {
      throw Object.assign(new Error(`스크립트는 노드당 1개: ${n.id}`), { code: "bad_request" });
    }
    for (const [k, s] of entries) {
      const spec = s as unknown as { file: string };
      const rel = String(spec.file ?? "").split("\\").join("/");
      const m = /^(.*)\.(py|mjs)$/.exec(rel);
      if (!m || rel.includes("..") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
        throw Object.assign(new Error(`스크립트 경로 볼 수 없음: ${n.id}.${k}=${spec.file} (작업공간 상대 .py/.mjs만)`), {
          code: "bad_request",
        });
      }
      const abs = join(projectRoot, rel);
      if (!existsSync(abs)) {
        throw Object.assign(new Error(`스크립트 없음: ${n.id}.${k}=${spec.file}`), { code: "bad_request" });
      }
      const normAbs = abs.split("\\").join("/");
      if (!(normAbs === normRoot || normAbs.startsWith(`${normRoot}/`))) {
        throw Object.assign(new Error(`스크립트가 작업공간 밖: ${n.id}.${k}=${spec.file}`), {
          code: "bad_request",
        });
      }
      const destRel = `scripts/${n.id.split(".").join("_")}.${rel.split(".").pop()}`;
      mkdirSync(dirname(join(buildDir, destRel)), { recursive: true });
      copyFileSync(abs, join(buildDir, destRel));
      spec.file = destRel;
      files.push(destRel);
    }
  }
  return doc;
}

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
  // M5.8.1-3: export 경로 무명 fs 예외 금지. coded는 그대로, 나머지는 bad_request.
  try {
    put(
      "procedure.json",
      JSON.stringify(
        rewriteAutoFileExists(
          collectScripts(doc, projectRoot, buildDir, files),
          join(procforgeDir, "sessions", input.sessionId, "fixtures-manifest.json"),
        ),
        null,
        2,
      ),
    );
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
    // M5.8.1-3: 복사 전 tests/ 생성 (미생성 시 copyFileSync ENOENT → internal.
    // E2E 4회 internal 원인: 보고 경로가 manifest를 만들고 fixtures/가 없어
    // copyTree가 tests/를 안 만들면 여기서 죽었다).
    mkdirSync(join(buildDir, "tests"), { recursive: true });
    copyFileSync(mf, join(buildDir, "tests", "fixtures-manifest.json"));
    files.push("tests/fixtures-manifest.json");
  }
  // M4.1-5: tmp에 빌드 후 원자 교체 (실패 시 tmp 정리)
  // 정리 실패는 본 에러를 가리면 안 되므로 best-effort (M5.8.1-5:
  // force도 ENOTDIR 등은 못 삼킨다).
  try {
    swapDir(buildDir, dir);
  } catch (e) {
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // 정리 실패 무시
    }
    throw e;
  }
  mkdirSync(dirname(commandFile), { recursive: true });
  writeFileSync(commandFile, commandMd);
  return { dir, files: files.sort(), commandFile };
  } catch (e) {
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // 정리 실패 무시
    }
    throw codedFs(e, "export 실패");
  }
}

function renderProcedureMd(doc: ProcedureDoc, auditFindings: string[] = []): string {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  // M4.1-2: 노드 id 숫자 정렬 (1.2 < 1.10)
  const order = [...doc.nodes].sort((a, b) => compareNodeIds(a.id, b.id));
  const roots = doc.nodes.filter((n) => n.parentId === null || !byId.has(n.parentId as string));
  const L: string[] = [];
  L.push(`# ${doc.name}`, ``, `원본 세션: ${doc.sourceSession} / 생성: ${doc.createdAt}`, ``);
  L.push(`## 파라미터`, ``);
  for (const [k, v] of Object.entries(doc.params)) {
    const vv = v as { default?: string; required?: boolean };
    L.push(`- \`${k}\`${vv.required === true ? " (필수, --param 지정)" : ` (기본값: \`${vv.default}\`)`}`);
  }
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
    const nmap = (n as unknown as { kind?: string; map?: { over?: unknown; as?: unknown; maxItems?: unknown; policy?: unknown } }).map;
    if ((n as unknown as { kind?: string }).kind === "map" && nmap) {
      L.push(`- 반복(map): over=\`${nmap.over}\` as=\`${nmap.as}\` maxItems=${(nmap.maxItems as number | undefined) ?? "기본 100"} policy=${JSON.stringify(nmap.policy)}`);
    }
    const nsw = (n as unknown as { stateWrites?: { key: string; from: string }[] }).stateWrites;
    if (Array.isArray(nsw) && nsw.length > 0) {
      L.push(`- 상태 기록: ${nsw.map((e) => `\`${e.key}\` ← \`${e.from}\``).join(", ")}`);
    }
    L.push(`- 인자:`);
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as ArgSpec;
      if (s.kind === "fixed") L.push(`  - \`${k}\` = \`${JSON.stringify((s as { value: unknown }).value)}\``);
      else if (s.kind === "var") L.push(`  - \`${k}\` ← ${(s as { ref: string }).ref}`);
      else if (s.kind === "script") L.push(`  - \`${k}\` = 스크립트: \`${(s as { file: string }).file}\``);
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
    `입력 파일 경로·표지 문구처럼 기간이 들어간 값은 var로 분류한다.`,
    `예: "sales-\${params.month}.xlsx", "월간보고서 \${params.month} (최종)".`,
    `앞 노드 출력과 같은 값은 fixed로 박지 말고 ref로 받아온다. 예: "$1.1.rows".`,
    `스크립트 leaf는 OS 수준 sandbox가 아니다. 자식 환경은 화이트리스트만,`,
    `run fs 밖 쓰기는 실행 전후 스냅샷으로 감지해 실패 처리한다.`,
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
    `파라미터: ${Object.entries(doc.params).map(([k, v]) => {
      const vv = v as { default?: string; required?: boolean };
      return vv.required === true ? `${k}=(필수)` : `${k}="${vv.default}"`;
    }).join(" ") || "없음"}`,
    `검증: \`procforge test procedures/${doc.name}\` + --param 전달.`,
    `실행: \`procforge run procedures/${doc.name}\` + --param 전달.`,
    ``,
  ].join("\n");
}
