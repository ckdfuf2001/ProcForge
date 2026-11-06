import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isEscapeRel } from "../artifacts.js";
import { countCsvDataRows } from "../checker.js";
import { substituteParams } from "../runner/resolve.js";
import { writeAtomicFile } from "../fsutil.js";
import type { RunMetrics } from "../runner/types.js";

// M9-2-2: 실행 종료 시 노드 산출 CSV 행 수 기록 (runs/<runId>/metrics.json).
// csv_rows와 같은 계산(countCsvDataRows) 재사용. 계산 실패는 rows 생략+사유,
// run 결과에 영향 주지 않는다 (best-effort — throw하지 않음).

export function writeRunMetrics(input: {
  procforgeDir: string;
  runId: string;
  procedure: string;
  fsDir: string;
  params: Record<string, string>;
  nodes: { id: string; constraints?: unknown[] }[];
  accumulate?: { path: string; node: string }[];
}): void {
  try {
    writeRunMetricsInner(input);
  } catch {
    // metrics 실패가 run을 깨뜨리지 않는다 (기록 없음).
  }
}

function csvCandidates(
  nodeId: string,
  constraints: unknown[] | undefined,
  accumulate: { path: string; node: string }[] | undefined,
  params: Record<string, string>,
): { path: string; skipHeader: boolean }[] {
  const out: { path: string; skipHeader: boolean }[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown, skipHeader: unknown): void => {
    if (typeof raw !== "string") return;
    const rel = substituteParams(raw, params).split("\\").join("/");
    if (rel === "" || isEscapeRel(rel, "/") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return;
    if (!rel.toLowerCase().endsWith(".csv")) return;
    if (seen.has(`${rel}`)) return;
    seen.add(rel);
    out.push({ path: rel, skipHeader: (skipHeader ?? true) === true });
  };
  for (const c of constraints ?? []) {
    const cc = c as { kind?: unknown; spec?: { path?: unknown; skipHeader?: unknown } };
    if (cc.kind !== "csv_rows") continue;
    push(cc.spec?.path, cc.spec?.skipHeader);
  }
  for (const s of accumulate ?? []) {
    if (s.node !== nodeId) continue;
    push(s.path, true);
  }
  return out;
}

function writeRunMetricsInner(input: {
  procforgeDir: string;
  runId: string;
  procedure: string;
  fsDir: string;
  params: Record<string, string>;
  nodes: { id: string; constraints?: unknown[] }[];
  accumulate?: { path: string; node: string }[];
}): void {
  const metrics: RunMetrics = {
    runId: input.runId,
    procedure: input.procedure,
    at: new Date().toISOString(),
    nodes: input.nodes.map((n) => {
      const files: { path: string; rows?: number; reason?: string }[] = [];
      for (const c of csvCandidates(n.id, n.constraints, input.accumulate, input.params)) {
        const abs = join(input.fsDir, c.path);
        if (!existsSync(abs)) {
          files.push({ path: c.path, reason: "csv file not found" });
          continue;
        }
        try {
          files.push({
            path: c.path,
            rows: countCsvDataRows(readFileSync(abs, "utf8"), c.skipHeader),
          });
        } catch (e) {
          files.push({
            path: c.path,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return { nodeId: n.id, files };
    }),
  };
  writeAtomicFile(
    join(input.procforgeDir, "runs", input.runId, "metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
}
