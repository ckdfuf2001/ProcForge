import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// M10-1: 유사 분석 조회 (읽기 전용, 로컬 전용).
// procedures/<name>/procedure.json 목록 + by-procedure latest 요약.
// 어휘 1차 필터는 LLM 없이 동작한다 (M10-spec §5 판정 1 = A+B 혼합의 A).

export type SimilarProcedure = {
  name: string;
  goals: string[];
  latest: { runId: string; status: string; at: string } | null;
};

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
    out.push({ name, goals, latest });
  }
  return out;
}

/** 어휘 필터: 모든 토큰이 (이름+목표) 안에 있어야 한다. latest 내림차순, 없음은 뒤. */
export function filterProcedures(
  items: SimilarProcedure[],
  query: string,
  limit?: number,
): SimilarProcedure[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const matched = items.filter((it) => {
    if (tokens.length === 0) return true;
    const hay = `${it.name} ${it.goals.join(" ")}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  matched.sort((a, b) => {
    if (!a.latest && !b.latest) return a.name < b.name ? -1 : 1;
    if (!a.latest) return 1;
    if (!b.latest) return -1;
    if (a.latest.at !== b.latest.at) return a.latest.at < b.latest.at ? 1 : -1;
    return a.name < b.name ? -1 : 1;
  });
  if (typeof limit === "number" && limit >= 0) return matched.slice(0, Math.floor(limit));
  return matched;
}
