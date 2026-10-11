import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findDateSample } from "../src/services/finalize-audit.js";

// M5.3.1-2: examples/procedures/monthly 정의부에 기간 하드코딩 0건.
// golden/goldenArgs(증거 데이터)와 createdAt(빌드 메타)은 제외.

const PROC = resolve(__dirname, "../../../examples/procedures/monthly/procedure.json");

type Hit = { path: string; value: string };

function walk(v: unknown, path: string, skip: boolean, hits: Hit[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${path}[${i}]`, skip));
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "golden" || k === "goldenArgs") continue;
      if (path === "" && k === "createdAt") continue;
      walk(x, path === "" ? k : `${path}.${k}`, skip, hits);
    }
    return;
  }
  if (typeof v === "string") {
    if (v.includes("2026-09")) hits.push({ path, value: `literal:${v.slice(0, 60)}` });
    const sample = findDateSample(v);
    if (sample) hits.push({ path, value: `date:${sample}` });
  }
}

describe("M5.3.1-2 committed monthly 정의부 기간 0건", () => {
  it("2026-09 리터럴·날짜 표현 없음", () => {
    const doc = JSON.parse(readFileSync(PROC, "utf-8")) as unknown;
    const hits: Hit[] = [];
    walk(doc, "", false, hits);
    expect(hits).toEqual([]);
  });
});
