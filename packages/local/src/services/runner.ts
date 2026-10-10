import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pfError } from "@procforge/shared/errors.js";
import { assertProjectPath } from "../artifacts.js";
import { toJUnit, type RunReport } from "../runner/index.js";

// junit 산출물 기록 (M4.2-1, pf_test에서 이동). App 경유, 어댑터 직접 호출 금지.

/**
 * junit 경로 결정 (M4.1.1-2): 지정 시 프로젝트 안만 허용, 생략 시 runs/<runId>/junit.xml.
 * 부모 디렉터리까지 생성한다.
 */
export function resolveJUnitPath(
  projectRoot: string,
  procforgeDir: string,
  junitPath: string | undefined,
  runId: string,
): string {
  let abs: string;
  if (junitPath === undefined || junitPath === "") {
    abs = join(procforgeDir, "runs", runId, "junit.xml");
  } else {
    abs = assertProjectPath(projectRoot, junitPath);
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

export function writeJUnitFile(junitPath: string, report: RunReport): void {
  mkdirSync(dirname(junitPath), { recursive: true });
  writeFileSync(junitPath, toJUnit(report));
}

/**
 * run fs 산출물을 프로젝트 안으로 복사 (M5, CLI run --out).
 * 기존 파일은 force 없이 거부.
 */
export function copyRunFsToOut(
  procforgeDir: string,
  runId: string,
  outDir: string,
  force: boolean,
): { outDir: string; files: number } {
  const fsDir = join(procforgeDir, "runs", runId, "fs");
  if (!existsSync(fsDir)) throw pfError("not_found", `run fs 없음: ${runId}`);
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(fsDir, p).split("\\").join("/");
      const dest = join(outDir, rel);
      if (!force && existsSync(dest)) {
        throw pfError("bad_request", `출력 파일이 이미 있음: ${rel} (--force로 덮어쓰기)`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(p, dest);
      files++;
    }
  };
  walk(fsDir);
  return { outDir, files };
}
