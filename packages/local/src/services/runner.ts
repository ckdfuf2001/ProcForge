import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isEscapeRel } from "../artifacts.js";
import { pfError } from "@procforge/shared/errors.js";
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
    const root = resolve(projectRoot);
    abs = resolve(root, junitPath);
    if (isEscapeRel(relative(root, abs).split("\\").join("/"), "/")) {
      throw pfError("bad_request", `path escapes project root: ${junitPath}`);
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

export function writeJUnitFile(junitPath: string, report: RunReport): void {
  mkdirSync(dirname(junitPath), { recursive: true });
  writeFileSync(junitPath, toJUnit(report));
}
