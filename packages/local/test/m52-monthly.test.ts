import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.2-5 수락 테스트 CI E2E (a~d). 절차서 "monthly" (기간 없음).
// - 1.1 script agg.py: sales-${params.month}.xlsx 집계 → {rows, total, period}.
// - 1.2 script render.mjs: template + $1.1.rows → output/report.txt.
// 값 흐름: 표 값은 전부 ref, 고정 숫자 없음. period == ${params.month}.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const SEPT_XLSX = resolve(__dirname, "../../../examples/dogfood/sales-2026-09.xlsx");
const OCT_XLSX = resolve(__dirname, "../../../examples/dogfood/sales-2026-10.xlsx");

const AGG_PY = `import json,sys
import openpyxl
a=json.load(sys.stdin)
wb=openpyxl.load_workbook(a["xlsx"], data_only=True)
ws=wb["sales"]
agg={}
period=None
for r in list(ws.rows)[1:]:
    d,p,q,amt=r[0].value,r[1].value,r[2].value,r[4].value
    ds=str(d)[:7]
    period=period or ds
    e=agg.setdefault(p,{"qty":0,"incl":0})
    e["qty"]+=q; e["incl"]+=amt
rows=[{"item":k,"qty":v["qty"],"ex":round(v["incl"]/1.1)} for k,v in sorted(agg.items())]
total=sum(r["ex"] for r in rows)
print(json.dumps({"summary":"agg %s total %d"%(period,total),"json":{"rows":rows,"total":total,"period":period}}))`;

const RENDER_MJS = `import fs from "node:fs";
import path from "node:path";
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const a=JSON.parse(s);
const tpl=fs.readFileSync(a.template,"utf8");
const body=a.rows.map(r=>r.item+" "+r.qty+" "+r.ex).join("\\n");
const text=tpl.replace("{month}",a.month).replace("{body}",body);
fs.mkdirSync(path.dirname(a.output),{recursive:true});
fs.writeFileSync(a.output,text);
const total=a.rows.reduce((x,r)=>x+r.ex,0);
console.log(JSON.stringify({summary:"render "+a.month,json:{total:total,lines:a.rows.length,month:a.month}}));});`;

const HOST_CAT = [{ server: "host", name: "script", inputSchema: {}, schemaHash: "script" }] as never;

type Agg = { rows: { item: string; qty: number; ex: number }[]; total: number; period: string };

function aggOf(xlsx: string): Agg {
  const script = join(root, "scripts", "agg.py");
  const raw = execFileSync("python", [script], { input: JSON.stringify({ xlsx }), encoding: "utf-8" });
  return (JSON.parse(raw) as { json: Agg }).json;
}

function renderHost(rows: Agg["rows"], month: string): void {
  mkdirSync(join(root, "output"), { recursive: true });
  const input = {
    template: join(root, "template.j2"), rows, month, output: join(root, "output", "report.txt"),
  };
  execFileSync(process.execPath, [join(root, "scripts", "render.mjs")], { input: JSON.stringify(input) });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m52-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m52home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // a: 9월 xlsx만
  copyFileSync(SEPT_XLSX, join(root, "sales-2026-09.xlsx"));
  writeFileSync(join(root, "template.j2"), "월간보고서 {month}\n{body}\n");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "agg.py"), AGG_PY);
  writeFileSync(join(root, "scripts", "render.mjs"), RENDER_MJS);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildMonthly(): Promise<void> {
  const { client, app } = (() => {
    const { client } = testStack(pfdir);
    return { client, app: new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root }) };
  })();
  try {
    execFileSync("python", ["-c", "import openpyxl"], { timeout: 15000 });
  } catch {
    throw new Error("openpyxl 필요: pip install openpyxl");
  }
  const started = await client.pfStart({ request: "월간보고서", params: { month: "2026-09" }, toolCatalog: HOST_CAT });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [
      { goal: "월별 xlsx를 집계한다" },
      { goal: "보고서 텍스트를 생성한다", dependsOn: ["1.1"], sideEffect: "local_write" },
    ],
  });
  // ---- 1.1: 9월 실측 앵커 (A 120/1200000, B 80/800000, 합계 2000000) ----
  const agg = aggOf(join(root, "sales-2026-09.xlsx"));
  expect(agg.period).toBe("2026-09");
  expect(agg.total).toBe(2000000);
  expect(agg.rows).toEqual([
    { item: "A", qty: 120, ex: 1200000 },
    { item: "B", qty: 80, ex: 800000 },
  ]);
  const sum11 = `agg ${agg.period} total ${agg.total}`;
  for (let round = 0; round < 2; round++) {
    const attemptId = randomUUID();
    const ing = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId: "1.1", attemptId, baseDir: root, paths: ["sales-2026-09.xlsx"] });
    if (round === 0) {
      await client.pfReport({
        sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
        args: { xlsx: "sales-2026-09.xlsx" }, resultSummary: sum11, resultJson: agg,
        artifacts: ing.stored, artifactContents: ing.contents,
        selfVerdict: "pass", selfReason: "집계 확인", attemptId,
      });
      await client.pfEditNode({
        sessionId: sid, nodeId: "1.1",
        addConstraints: [{ id: "c-period", kind: "equals", spec: { path: "period", expected: "${params.month}" }, source: "human" }],
      });
    } else {
      const r = await client.pfReport({
        sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
        args: { xlsx: "sales-2026-09.xlsx" }, resultSummary: sum11, resultJson: agg,
        artifacts: ing.stored, artifactContents: ing.contents,
        selfVerdict: "pass", selfReason: "period 일치", attemptId,
      });
      expect(r.verdict).toBe("pass");
    }
  }
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "host", name: "script" },
    argSpecs: {
      xlsx: { kind: "var", ref: "sales-${params.month}.xlsx", path: "in" },
      agg: { kind: "script", file: "scripts/agg.py" },
    } as never,
  });
  // ---- 1.2 ----
  renderHost(agg.rows, "2026-09");
  const reportTxt = readFileSync(join(root, "output", "report.txt"), "utf-8");
  expect(reportTxt).toContain("2026-09");
  const args12 = { template: "template.j2", rows: agg.rows, month: "2026-09", output: "output/report.txt" };
  const json12 = { total: agg.total, lines: agg.rows.length, month: "2026-09" };
  const r12 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: args12, resultSummary: `render 2026-09 total ${agg.total}`, resultJson: json12,
    artifacts: [], artifactContents: {},
    selfVerdict: "pass", selfReason: "생성 확인", attemptId: randomUUID(),
  });
  expect(r12.verdict).toBe("pass");
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    addConstraints: [{ id: "c-sum", kind: "numeric_match", spec: { path: "total", expected: "$1.1.total" }, source: "human" }],
  });
  const attempt2 = randomUUID();
  const ing2 = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId: "1.2", attemptId: attempt2, baseDir: root, paths: ["template.j2", "output/report.txt"] });
  const r12b = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: args12, resultSummary: `render 2026-09 total ${agg.total}`, resultJson: json12,
    artifacts: ing2.stored, artifactContents: ing2.contents,
    selfVerdict: "pass", selfReason: "합계 일치", attemptId: attempt2,
  });
  expect(r12b.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "host", name: "script" },
    argSpecs: {
      template: { kind: "fixed", value: "template.j2", path: "in" },
      rows: { kind: "var", ref: "$1.1.rows" },
      month: { kind: "var", ref: "${params.month}" },
      output: { kind: "fixed", value: "output/report.txt", path: "out" },
      render: { kind: "script", file: "scripts/render.mjs", runtime: "node" },
    } as never,
    goldenIgnore: ["output"],
  });
  const fin = await app.finalize({ sessionId: sid, name: "monthly", strict: true });
  expect(fin.warnings).toEqual([]);
}

describe("M5.2-5 수락 테스트", () => {
  it("a: 9월만 분해·strict finalize 감사 0 + b: 10월 실행·독립 계산 일치", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    const want = aggOf(join(root, "sales-2026-10.xlsx"));
    expect(want.period).toBe("2026-10");
    const { report } = await runProcedureTest(pfdir, root, "monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(2);
    const out = readFileSync(join(pfdir, "runs", report.runId, "fs", "output", "report.txt"), "utf8");
    expect(out).toContain("2026-10");
    expect(out).not.toContain("2026-09");
    for (const r of want.rows) {
      expect(out).toContain(`${r.item} ${r.qty} ${r.ex}`);
    }
  }, 180000);

  it("c: 11월 파일 없음 → 실행 전 bad_request", async () => {
    await buildMonthly();
    expect(existsSync(join(root, "sales-2026-11.xlsx"))).toBe(false);
    await expect(runProcedureTest(pfdir, root, "monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-11" },
    })).rejects.toThrow(/입력 바인딩 실패/);
  }, 120000);

  it("d: 10월 파일에 9월 데이터 → period fail + 하류 blocked", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    copyFileSync(SEPT_XLSX, join(root, "sales-2026-10.xlsx"));
    try {
      const { report } = await runProcedureTest(pfdir, root, "monthly", {
        procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
      });
      expect(report.summary.fail).toBeGreaterThanOrEqual(1);
      const byId = new Map(
        (report.results as { nodeId: string; status: string; failedConstraints: string[] }[]).map((r) => [r.nodeId, r]),
      );
      expect(byId.get("1.1")?.status).toBe("fail");
      expect(byId.get("1.1")?.failedConstraints).toContain("c-period");
      expect(byId.get("1.2")?.status).not.toBe("pass");
    } finally {
      copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    }
  }, 120000);
});
