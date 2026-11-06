import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M9-tmp: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M10-1: 유사 분석 조회 (읽기 전용, 로컬 전용).

let pfdir: string;
let app: ProcForgeApp;

function writeProcedure(name: string, goals: string[]): void {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name,
      sourceSession: "test",
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: [],
      nodes: goals.map((goal, i) => ({
        id: `${i + 1}`,
        parentId: i === 0 ? null : "1",
        goal,
        depth: i === 0 ? 0 : 1,
        dependsOn: [],
        children: [],
        sideEffect: "none",
        constraints: [],
      })),
    }),
  );
}

function writeLatest(name: string, runId: string, at: string): void {
  const dir = join(pfdir, "runs", "by-procedure", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({ runId, status: "done", at }),
  );
}

beforeEach(() => {
  pfdir = join(makeTmp("pf-m10sim-"), ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
});

describe("M10-1 유사 분석 조회", () => {
  it("① 빈 저장소는 빈 목록", async () => {
    const r = await app.similarProcedures({});
    expect(r.procedures).toEqual([]);
    const q = await app.similarProcedures({ query: "월간" });
    expect(q.procedures).toEqual([]);
  });

  it("② 2회 실행 절차서가 latest 기준 정렬", async () => {
    writeProcedure("old-monthly", ["월간 집계"]);
    writeProcedure("new-monthly", ["월간 집계"]);
    writeProcedure("unused", ["연간 결산"]);
    writeLatest("old-monthly", "run-old", "2026-11-01T00:00:00.000Z");
    writeLatest("new-monthly", "run-2", "2026-11-03T00:00:00.000Z");
    const r = await app.similarProcedures({});
    expect(r.procedures.map((p) => p.name)).toEqual([
      "new-monthly",
      "old-monthly",
      "unused",
    ]);
    expect(r.procedures[0].latest?.runId).toBe("run-2");
    // 읽은 원문과 같은 파일인지 확인
    const raw = JSON.parse(
      readFileSync(join(pfdir, "runs", "by-procedure", "new-monthly", "latest.json"), "utf8"),
    ) as { runId: string };
    expect(raw.runId).toBe("run-2");
  });

  it("③ 텍스트 후보 필터 (이름+목표 어휘)", async () => {
    writeProcedure("monthly-sales", ["월간 매출 집계", "표 그리기"]);
    writeProcedure("daily-crawl", ["일간 수집", "CSV 누적"]);
    const r = await app.similarProcedures({ query: "월간 집계" });
    expect(r.procedures.map((p) => p.name)).toEqual(["monthly-sales"]);
    const all = await app.similarProcedures({ query: "" });
    expect(all.procedures.map((p) => p.name).sort()).toEqual([
      "daily-crawl",
      "monthly-sales",
    ]);
    const limited = await app.similarProcedures({ query: "", limit: 1 });
    expect(limited.procedures).toHaveLength(1);
  });
});
