import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomicFile } from "../fsutil.js";
import { eventsLogPath } from "./events-log.js";

// M9-3-2: 읽을 때 계산하는 집계 (인덱스 파일 없음, M9-3-spec §2b).
// 집계 대상 모드 (판정 [M9-3-1] — record/replay/passthrough는 테스트 경로라
// 성공 이력·소요 시간에 섞지 않는다. 나중에 바꾸면 여기만 고친다).
export const AGG_MODES = ["live"];

/** 수기 교훈 1줄 상한 (M9-3-spec §2c). 넘으면 잘라내고 truncated를 붙인다. */
export const LESSON_LINE_LIMIT = 500;

export type AggNode = {
  nodeId: string;
  fails: number;
  /** done인 run의 pass 노드 소요 시간 산술평균 (해당 없음이면 0). */
  avgMs: number;
  reapprovals: number;
};
export type AggResult = { runs: number; nodes: AggNode[]; skipped: number };

type RawNode = { nodeId?: unknown; status?: unknown; durationMs?: unknown };
type RawEvent = {
  kind?: unknown;
  mode?: unknown;
  runId?: unknown;
  status?: unknown;
  nodes?: unknown;
  nodeId?: unknown;
  hash12?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 절차서별 집계. 파일 없으면 빈 결과 (정상). 깨진 줄·형식 오류 줄은
 * 건너뛰고 `skipped`로 센다. 쓰기는 하지 않는다 (읽기 전용).
 */
export function aggregate(procforgeDir: string, procedure: string): AggResult {
  let raw: string;
  try {
    raw = readFileSync(eventsLogPath(procforgeDir, procedure), "utf8");
  } catch {
    return { runs: 0, nodes: [], skipped: 0 };
  }
  let skipped = 0;
  let runs = 0;
  const fails = new Map<string, number>();
  const durations = new Map<string, number[]>();
  const lastHash = new Map<string, string>();
  const reapprovals = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let e: RawEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        skipped++;
        continue;
      }
      e = parsed as RawEvent;
    } catch {
      skipped++;
      continue;
    }
    if (e.kind === "run_end") {
      // 집계 대상 모드만 센다 (M9-3-spec-fix2 결함 3).
      if (typeof e.mode !== "string" || !AGG_MODES.includes(e.mode)) continue;
      if (typeof e.status !== "string") {
        skipped++;
        continue;
      }
      runs++;
      const nodes: unknown[] = Array.isArray(e.nodes) ? e.nodes : [];
      for (const n of nodes) {
        if (!isRecord(n)) continue;
        const rn = n as RawNode;
        if (typeof rn.nodeId !== "string") continue;
        if (rn.status === "fail") fails.set(rn.nodeId, (fails.get(rn.nodeId) ?? 0) + 1);
        // 평균은 done인 run의 pass 노드만으로 계산한다.
        if (e.status === "done" && rn.status === "pass" && typeof rn.durationMs === "number") {
          const arr = durations.get(rn.nodeId) ?? [];
          arr.push(rn.durationMs);
          durations.set(rn.nodeId, arr);
        }
      }
    } else if (e.kind === "approve") {
      if (typeof e.nodeId !== "string" || typeof e.hash12 !== "string") {
        skipped++;
        continue;
      }
      // 재승인: 같은 nodeId에서 직전과 hash12가 다를 때만 센다 (M9-3-spec §2b).
      const prev = lastHash.get(e.nodeId);
      if (prev !== undefined && prev !== e.hash12) {
        reapprovals.set(e.nodeId, (reapprovals.get(e.nodeId) ?? 0) + 1);
      }
      lastHash.set(e.nodeId, e.hash12);
    } else if (e.kind === "approval_reset") {
      // 집계 입력 아님 (재승인 수는 approve 줄에서 센다) — 무시.
      continue;
    } else {
      skipped++;
    }
  }
  const ids = new Set<string>([...fails.keys(), ...durations.keys(), ...reapprovals.keys()]);
  const nodes: AggNode[] = [...ids].sort().map((nodeId) => {
    const ds = durations.get(nodeId) ?? [];
    return {
      nodeId,
      fails: fails.get(nodeId) ?? 0,
      avgMs: ds.length === 0 ? 0 : ds.reduce((a, b) => a + b, 0) / ds.length,
      reapprovals: reapprovals.get(nodeId) ?? 0,
    };
  });
  return { runs, nodes, skipped };
}

export type ManualLesson = { text: string; truncated: boolean };

const AUTO_OPEN = "<!-- proof:auto -->";
const AUTO_CLOSE = "<!-- /proof:auto -->";

/**
 * lessons.md 수기 구획 읽기. 자동 구획 안은 제외하고, `- `로 시작하는 줄 중
 * 앞에서부터 최대 5개. 500자를 넘으면 잘라내고 `truncated:true`를 붙인다.
 * 파일이 없으면 빈 목록 (정상).
 */
export function readManualLessons(path: string): ManualLesson[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let inAuto = false;
  for (const l of raw.split("\n")) {
    if (l.includes(AUTO_OPEN)) {
      inAuto = true;
      continue;
    }
    if (l.includes(AUTO_CLOSE)) {
      inAuto = false;
      continue;
    }
    if (inAuto) continue;
    if (l.startsWith("- ")) out.push(l.slice(2));
  }
  return out.slice(0, 5).map((t) =>
    t.length > LESSON_LINE_LIMIT
      ? { text: t.slice(0, LESSON_LINE_LIMIT), truncated: true }
      : { text: t, truncated: false },
  );
}

/**
 * M9-3-3: 자동 구획만 다시 쓰고 수기 구획은 바이트 단위로 보존한다.
 * 파일이 없으면 새로 만든다. 집계 숫자만 담고 문장 요약은 넣지 않는다.
 * 쓰기는 원자 교체 (실패해도 기존 파일은 그대로).
 */
export function refreshLessons(
  procforgeDir: string,
  procedure: string,
): { procedure: string; lines: number } {
  const agg = aggregate(procforgeDir, procedure);
  const body = agg.nodes.map(
    (n) => `- ${n.nodeId}: 실패 ${n.fails}회, 평균 ${n.avgMs}ms, 재승인 ${n.reapprovals}회`,
  );
  const section = [AUTO_OPEN, ...body, AUTO_CLOSE].join("\n");
  const p = join(procforgeDir, "procedures", procedure, "lessons.md");
  let cur = "";
  try {
    cur = readFileSync(p, "utf8");
  } catch {
    cur = "";
  }
  let next: string;
  // 구획 앞뒤로 개행을 덧붙이지 않는다 — 바이트 보존이 우선이다.
  // (끝 개행이 있으면 다음 갱신 때 "구획 밖"으로 남아 어긋난다.)
  if (cur === "") {
    next = section;
  } else {
    const oi = cur.indexOf(AUTO_OPEN);
    const ci = cur.indexOf(AUTO_CLOSE);
    if (oi !== -1 && ci !== -1 && ci > oi) {
      next = cur.slice(0, oi) + section + cur.slice(ci + AUTO_CLOSE.length);
    } else {
      next = cur + (cur.endsWith("\n") ? "" : "\n") + section;
    }
  }
  mkdirSync(dirname(p), { recursive: true });
  writeAtomicFile(p, next);
  return { procedure, lines: body.length };
}
