import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROCEDURE_NAME_RE } from "@proof/shared/procedure.js";
import { aggregate, readManualLessons, type ManualLesson } from "./lessons-agg.js";

// M10-1: 유사 분석 조회 (읽기 전용, 로컬 전용).
// procedures/<name>/procedure.json 목록 + by-procedure latest 요약.
// 어휘 1차 필터는 LLM 없이 동작한다 (M10-spec §5 판정 1 = A+B 혼합의 A).
// B(성공 이력·규모): 규모(metrics)는 순위에 쓰지 않는다 — 규모가 크다고
// 비슷하다는 뜻이 아니며, 성공 이력은 status(done)로 이미 반영되기 때문.

/** M10-1-fix: 어휘 점수 하한 (토큰 일치율·2-gram 겹침률 평균). */
export const SIMILARITY_THRESHOLD = 0.3;

export type SimilarProcedure = {
  name: string;
  goals: string[];
  latest: { runId: string; status: string; at: string } | null;
  /** metrics.json 요약 (파일 수·행 합). 순위에는 쓰지 않는다. */
  metrics: { files: number; rows: number } | null;
  /** M9-3-4: 수기 교훈 (최대 5개, 자동 구획 제외). 순위에는 쓰지 않는다. */
  lessons: ManualLesson[];
  /** M9-3-4: 집계 요약 (실행 수 + 실패 수 상위 노드 3개). 순위에는 쓰지 않는다. */
  stats: { runs: number; topFails: { nodeId: string; fails: number }[] };
};

function bigrams(s: string): string[] {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** 어휘 점수: 토큰 부분일치율·문자 2-gram 겹침률 평균 (0~1). 조사 사전 없음. */
export function similarityScore(query: string, hay: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 1;
  const h = hay.toLowerCase();
  const tokenRate =
    tokens.filter((t) => h.includes(t)).length / tokens.length;
  const qb = bigrams(query);
  if (qb.length === 0) return tokenRate;
  const hb = new Set(bigrams(hay));
  const bigramRate = qb.filter((b) => hb.has(b)).length / qb.length;
  return 0.5 * tokenRate + 0.5 * bigramRate;
}

function metricsSummary(
  procforgeDir: string,
  runId: string,
): SimilarProcedure["metrics"] {
  try {
    const m = JSON.parse(
      readFileSync(join(procforgeDir, "runs", runId, "metrics.json"), "utf8"),
    ) as { nodes?: { files?: { rows?: unknown }[] }[] };
    let files = 0;
    let rows = 0;
    for (const n of m.nodes ?? []) {
      for (const f of n.files ?? []) {
        files += 1;
        if (typeof f.rows === "number") rows += f.rows;
      }
    }
    return { files, rows };
  } catch {
    return null;
  }
}

/** M9-3-4: 집계 요약 (실행 수 + 실패 수 상위 노드 3개, 실패 없으면 빈 목록). */
function statsSummary(procforgeDir: string, name: string): SimilarProcedure["stats"] {
  const agg = aggregate(procforgeDir, name);
  const topFails = agg.nodes
    .filter((n) => n.fails > 0)
    .sort((a, b) => (b.fails !== a.fails ? b.fails - a.fails : a.nodeId < b.nodeId ? -1 : 1))
    .slice(0, 3)
    .map((n) => ({ nodeId: n.nodeId, fails: n.fails }));
  return { runs: agg.runs, topFails };
}

export function listProceduresWithLatest(
  procforgeDir: string,
): SimilarProcedure[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(procforgeDir, "procedures"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: SimilarProcedure[] = [];
  for (const name of names.sort()) {
    // M10-1-fix: swap 잔재(<name>.old) 등은 절차서가 아니다.
    // M10-lock-legacy: procedures/.locks 같은 내부 항목도 제외.
    // 판정은 procedure-latest.ts와 같은 공용 정규식으로 한다.
    if (name.startsWith(".")) continue;
    if (!PROCEDURE_NAME_RE.test(name)) continue;
    let goals: string[] = [];
    try {
      const doc = JSON.parse(
        readFileSync(join(procforgeDir, "procedures", name, "procedure.json"), "utf8"),
      ) as { nodes?: { goal?: unknown }[] };
      goals = (doc.nodes ?? [])
        .map((n) => n.goal)
        .filter((g): g is string => typeof g === "string");
    } catch {
      // 손상 절차서는 목표 없이도 목록에 둔다 (latest 판정에만 쓴다)
    }
    let latest: SimilarProcedure["latest"] = null;
    try {
      const l = JSON.parse(
        readFileSync(
          join(procforgeDir, "runs", "by-procedure", name, "latest.json"),
          "utf8",
        ),
      ) as { runId?: unknown; status?: unknown; at?: unknown };
      if (l && typeof l.runId === "string") {
        latest = {
          runId: l.runId,
          status: typeof l.status === "string" ? l.status : "unknown",
          at: typeof l.at === "string" ? l.at : "",
        };
      }
    } catch {
      // 실행 기록 없음
    }
    out.push({
      name,
      goals,
      latest,
      metrics: latest ? metricsSummary(procforgeDir, latest.runId) : null,
      // M9-3-4: lessons + stats는 표시용이다. 순위(filterProcedures)는
      // 어휘 점수·상태·시간·이름만 보고 이 필드들을 읽지 않는다.
      lessons: readManualLessons(join(procforgeDir, "procedures", name, "lessons.md")),
      stats: statsSummary(procforgeDir, name),
    });
  }
  return out;
}

/**
 * 어휘 필터 + 순위.
 * 정렬 키: ① 어휘 점수 내림차순 ② latest.status === "done" 우선
 * ③ 시간 내림차순 (없음은 맨 뒤) ④ 이름.
 * 기준치 미만은 탈락한다 (빈 쿼리는 전부 통과).
 */
export function filterProcedures(
  items: SimilarProcedure[],
  query: string,
  limit?: number,
): SimilarProcedure[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const scored = items.map((it) => ({
    it,
    score:
      tokens.length === 0
        ? 1
        : similarityScore(query, `${it.name} ${it.goals.join(" ")}`),
  }));
  const matched = scored.filter(
    (s) => tokens.length === 0 || s.score >= SIMILARITY_THRESHOLD,
  );
  matched.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ad = a.it.latest?.status === "done" ? 1 : 0;
    const bd = b.it.latest?.status === "done" ? 1 : 0;
    if (ad !== bd) return bd - ad;
    const at = a.it.latest?.at ?? "";
    const bt = b.it.latest?.at ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.it.name < b.it.name ? -1 : 1;
  });
  const out = matched.map((s) => s.it);
  if (typeof limit === "number" && limit >= 0) return out.slice(0, Math.floor(limit));
  return out;
}
