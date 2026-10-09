import { setupSandbox } from "../artifacts.js";

// sandbox 시드 복사 (M4.2-1, pf_start에서 이동). App 경유, 어댑터 직접 호출 금지.

export function seedSandbox(input: {
  procforgeDir: string;
  sessionId: string;
  projectRoot: string;
  seedFiles: string[] | undefined;
}): string {
  const seeds = input.seedFiles ?? [];
  if (seeds.length === 0) return "";
  const sb = setupSandbox({
    procforgeDir: input.procforgeDir,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    seedFiles: seeds,
  });
  return ` 참조 파일 ${sb.copied.length}개를 sandbox에 복사했다.`;
}
