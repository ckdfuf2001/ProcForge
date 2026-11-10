import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate, readManualLessons } from "../src/services/lessons-agg.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M9-3-2: 읽을 때 계산하는 집계 + 수기 구획 파서.
// 집계 테스트 5종: replay 제외, 평균은 성공한 run만, 같은 hash 재승인 제외,
// 깨진 줄은 skipped로 세기, 파일 없음이면 빈 결과.
// 파서 테스트 5종: 정상, 줄 없음, 파일 없음, 500자 초과, 자동 구획 제외.

let root: string;
let pfdir: string;

function eventsPath(name: string): string {
  return join(pfdir, "runs", "by-procedure", name, "events.ndjson");
}

function writeEvents(name: string, lines: string[]): void {
  mkdirSync(join(pfdir, "runs", "by-procedure", name), { recursive: true });
  writeFileSync(eventsPath(name), lines.join("\n") + "\n", "utf8");
}

function runEnd(runId: string, mode: string, status: string, nodes: unknown[]): string {
  return JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "run_end", procedure: "p", runId, status, mode, nodes });
}

function approve(nodeId: string, hash12: string): string {
  return JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", kind: "approve", procedure: "p", nodeId, hash12 });
}

beforeEach(() => {
  root = makeTmp("pf-m93ag-");
  pfdir = join(root, ".procforge");
});

describe("M9-3-2 집계 읽기", () => {
  it("① replay는 제외한다", () => {
    writeEvents("p1", [
      runEnd("r1", "live", "done", [{ nodeId: "1", status: "pass", durationMs: 100 }]),
      runEnd("r2", "replay", "done", [{ nodeId: "1", status: "pass", durationMs: 900 }]),
    ]);
    const a = aggregate(pfdir, "p1");
    expect(a.runs).toBe(1);
    expect(a.nodes).toHaveLength(1);
    expect(a.nodes[0]).toEqual({ nodeId: "1", fails: 0, avgMs: 100, reapprovals: 0 });
  });

  it("② 평균은 성공한 run만으로 계산한다", () => {
    writeEvents("p2", [
      runEnd("r1", "live", "done", [{ nodeId: "1", status: "pass", durationMs: 100 }]),
      runEnd("r2", "live", "failed", [
        { nodeId: "1", status: "pass", durationMs: 300 },
        { nodeId: "2", status: "fail", durationMs: 50 },
      ]),
    ]);
    const a = aggregate(pfdir, "p2");
    expect(a.runs).toBe(2);
    const n1 = a.nodes.find((n) => n.nodeId === "1")!;
    const n2 = a.nodes.find((n) => n.nodeId === "2")!;
    expect(n1.avgMs).toBe(100);
    expect(n1.fails).toBe(0);
    expect(n2.fails).toBe(1);
    expect(n2.avgMs).toBe(0);
  });

  it("③ 같은 hash 재승인은 제외한다", () => {
    writeEvents("p3", [
      approve("1", "aaaaaaaaaaaa"),
      approve("1", "aaaaaaaaaaaa"),
      approve("1", "bbbbbbbbbbbb"),
    ]);
    const a = aggregate(pfdir, "p3");
    expect(a.runs).toBe(0);
    expect(a.nodes).toEqual([{ nodeId: "1", fails: 0, avgMs: 0, reapprovals: 1 }]);
  });

  it("④ 깨진 줄은 skipped로 센다", () => {
    writeEvents("p4", [
      runEnd("r1", "live", "done", [{ nodeId: "1", status: "pass", durationMs: 100 }]),
      "{broken",
      JSON.stringify({ kind: "unknown_kind" }),
    ]);
    const a = aggregate(pfdir, "p4");
    expect(a.runs).toBe(1);
    expect(a.skipped).toBe(2);
    expect(a.nodes[0].avgMs).toBe(100);
  });

  it("⑤ 파일 없음이면 빈 결과", () => {
    expect(aggregate(pfdir, "nope")).toEqual({ runs: 0, nodes: [], skipped: 0 });
  });
});

describe("M9-3-2 수기 구획 파서", () => {
  it("① 정상: - 줄 3개", () => {
    const p = join(root, "lessons.md");
    writeFileSync(p, "# 교훈\n- 첫째\n- 둘째\n- 셋째\n", "utf8");
    expect(readManualLessons(p)).toEqual([
      { text: "첫째", truncated: false },
      { text: "둘째", truncated: false },
      { text: "셋째", truncated: false },
    ]);
  });

  it("② 줄 없음: - 줄이 없으면 빈 목록", () => {
    const p = join(root, "lessons.md");
    writeFileSync(p, "# 교훈\n그냥 문장만 있다.\n", "utf8");
    expect(readManualLessons(p)).toEqual([]);
  });

  it("③ 파일 없음이면 빈 목록", () => {
    expect(readManualLessons(join(root, "없음.md"))).toEqual([]);
  });

  it("④ 500자 초과는 잘라내고 truncated", () => {
    const p = join(root, "lessons.md");
    writeFileSync(p, `- ${"가".repeat(600)}\n- 짧음\n`, "utf8");
    const out = readManualLessons(p);
    expect(out).toHaveLength(2);
    expect(out[0].text).toHaveLength(500);
    expect(out[0].truncated).toBe(true);
    expect(out[1]).toEqual({ text: "짧음", truncated: false });
  });

  it("⑤ 자동 구획은 제외한다", () => {
    const p = join(root, "lessons.md");
    writeFileSync(p, "<!-- proof:auto -->\n- 자동1\n<!-- /proof:auto -->\n- 수기1\n", "utf8");
    expect(readManualLessons(p)).toEqual([{ text: "수기1", truncated: false }]);
  });
});
