import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pfError } from "@proof/shared/errors.js";
import { writeFileAtomic } from "./procedureWriter.js";

// M10-4: 순차 자동 실행 가이드 상태 (guides/<guideId>.json).
// 판정 C: 초안 경로 + runId 목록을 참조로 기록한다 (run 생전부터 존재).
// App 경유, 어댑터 직접 호출 금지. 원자 쓰기.

export type GuideStepState = {
  status: "pending" | "running" | "waiting" | "done" | "failed" | "cancelled";
  runId?: string;
  /** 실행 세션 (lane.*·run.phase 조회용. 재시작 후에도 파일에서 복원) */
  sessionId?: string;
  updatedAt: string;
};

export type GuideFile = {
  version: 1;
  guideId: string;
  steps: { procedure: string; params: Record<string, string> }[];
  state: GuideStepState[];
  createdAt: string;
  updatedAt: string;
};

export function guideDir(procforgeDir: string): string {
  return join(procforgeDir, "guides");
}

export function guidePath(procforgeDir: string, guideId: string): string {
  return join(guideDir(procforgeDir), `${guideId}.json`);
}

/** guideId는 파일명 조각 (ui-server pathId와 같은 규칙). */
export function assertGuideId(id: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.includes("..")) {
    throw pfError("bad_request", "guideId 형식이 잘못되었습니다.");
  }
}

export function newGuideId(): string {
  return randomUUID();
}

export function readGuide(procforgeDir: string, guideId: string): GuideFile {
  assertGuideId(guideId);
  let raw: string;
  try {
    raw = readFileSync(guidePath(procforgeDir, guideId), "utf8");
  } catch {
    throw pfError("not_found", `가이드 없음: ${guideId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw pfError("bad_request", `가이드 파싱 실패: ${guideId}`);
  }
  const g = parsed as Partial<GuideFile>;
  if (
    !g ||
    typeof g !== "object" ||
    g.version !== 1 ||
    typeof g.guideId !== "string" ||
    !Array.isArray(g.steps) ||
    !Array.isArray(g.state) ||
    g.steps.length === 0 ||
    g.state.length !== g.steps.length
  ) {
    throw pfError("bad_request", `가이드 형식 오류: ${guideId}`);
  }
  return parsed as GuideFile;
}

export function writeGuide(procforgeDir: string, guide: GuideFile): void {
  assertGuideId(guide.guideId);
  mkdirSync(guideDir(procforgeDir), { recursive: true });
  writeFileAtomic(
    guidePath(procforgeDir, guide.guideId),
    JSON.stringify(guide, null, 2),
  );
}

/** 다음 차례 (done이 아닌 첫 단계, 없으면 -1). 완료 단계는 건너뛴다. */
export function nextStepIndex(guide: GuideFile): number {
  return guide.state.findIndex((s) => s.status !== "done");
}

export function touchGuide(guide: GuideFile): GuideFile {
  return { ...guide, updatedAt: new Date().toISOString() };
}

/** guides/ 목록 (id만, 재시작 후 이력 확인용). */
export function listGuides(procforgeDir: string): string[] {
  const dir = guideDir(procforgeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => e.endsWith(".json"))
    .map((e) => e.slice(0, -5))
    .sort();
}
