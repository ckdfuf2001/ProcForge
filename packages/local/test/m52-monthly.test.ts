import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.3-2 수락 테스트 CI E2E (a~d). 절차서 "monthly" (기간 없음).
// - 1.1 script agg.py: sales-${params.month}.xlsx 집계 → {rows, total, period}.
// - 1.2 script render_pptx.py: 빈 껍데기 shell.pptx + $1.1.rows → output/rendered.pptx.
//   표지·S2 제목은 var 템플릿. 10월 산출 전체 텍스트에 "9월"·"2026-09" 0건.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const SEPT_XLSX = resolve(__dirname, "../../../examples/dogfood/sales-2026-09.xlsx");
const OCT_XLSX = resolve(__dirname, "../../../examples/dogfood/sales-2026-10.xlsx");
const PY_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

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

const RENDER_PY = `import json,sys,shutil
from pptx import Presentation
from pptx.util import Inches
a=json.load(sys.stdin)
shutil.copyfile(a["template"],a["output"])
prs=Presentation(a["output"])
prs.slides[0].shapes.title.text=a["cover"]
s=prs.slides[a["slide"]]
s.shapes.title.text=a["tableTitle"]
old=next(sh for sh in s.shapes if sh.has_table)
left,top,width,height=old.left,old.top,old.width,old.height
old._element.getparent().remove(old._element)
rows=[["\\uc81c\\ud488","\\uc218\\ub7c9","\\ub9e4\\ucd9c(\\uc138\\uc804)"]]+[[r["item"],str(r["qty"]),"{:,}".format(r["ex"])] for r in a["rows"]]
newtbl=s.shapes.add_table(len(rows),len(rows[0]),left,top,width,height).table
for i,r in enumerate(rows):
    for j,v in enumerate(r): newtbl.cell(i,j).text=v
prs.save(a["output"])
total=sum(r["ex"] for r in a["rows"])
print(json.dumps({"summary":"render %s total %d"%(a["cover"],total),"json":{"total":total,"title":a["cover"]}}))`;

const BLANK_PY = `from pptx import Presentation
from pptx.util import Inches
prs=Presentation()
prs.slide_width=Inches(13.33)
prs.slide_height=Inches(7.5)
prs.slides.add_slide(prs.slide_layouts[5])
s2=prs.slides.add_slide(prs.slide_layouts[5])
tbl=s2.shapes.add_table(1,3,Inches(1),Inches(1.5),Inches(8),Inches(1)).table
tbl.cell(0,0).text=""
tbl.cell(0,1).text=""
tbl.cell(0,2).text=""
prs.slides.add_slide(prs.slide_layouts[5])
prs.save("shell.pptx")`;

const DUMP_PY = `from pptx import Presentation
import json,sys
prs=Presentation(sys.argv[1])
texts=[]
for s in prs.slides:
    for sh in s.shapes:
        if sh.has_text_frame: texts.append(sh.text_frame.text)
        if sh.has_table:
            for r in sh.table.rows:
                for c in r.cells: texts.append(c.text)
print(json.dumps({"texts":texts}))`;

const HOST_CAT = [{ server: "host", name: "script", inputSchema: {}, schemaHash: "script" }] as never;

type Agg = { rows: { item: string; qty: number; ex: number }[]; total: number; period: string };

function aggOf(xlsx: string): Agg {
  const script = join(root, "scripts", "agg.py");
  const raw = execFileSync("python", [script], { input: JSON.stringify({ xlsx }), encoding: "utf-8", env: PY_ENV });
  return (JSON.parse(raw) as { json: Agg }).json;
}

function renderPptx(month: string, rows: Agg["rows"]): void {
  mkdirSync(join(root, "output"), { recursive: true });
  execFileSync("python", [join(root, "scripts", "render_pptx.py")], {
    input: JSON.stringify({
      template: join(root, "shell.pptx"), output: join(root, "output", "rendered.pptx"),
      cover: `월간보고서 ${month} (최종)`, tableTitle: `${month} 실적 요약`, rows, slide: 1,
    }),
    encoding: "utf-8", env: PY_ENV,
  });
}

function fullText(abs: string): string[] {
  const raw = execFileSync("python", ["-c", DUMP_PY, abs], { encoding: "utf-8", env: PY_ENV });
  return (JSON.parse(raw) as { texts: string[] }).texts;
}

function requirePyLibs(): void {
  for (const lib of ["openpyxl", "pptx"]) {
    try {
      execFileSync("python", ["-c", `import ${lib}`], { timeout: 15000, env: PY_ENV });
    } catch {
      throw new Error(`${lib} 필요: pip install ${lib}`);
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m53-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m53home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // a: 9월 xlsx만 + 빈 껍데기 템플릿
  copyFileSync(SEPT_XLSX, join(root, "sales-2026-09.xlsx"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "agg.py"), AGG_PY);
  writeFileSync(join(root, "scripts", "render_pptx.py"), RENDER_PY);
  execFileSync("python", ["-c", BLANK_PY], { cwd: root, env: PY_ENV });
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildMonthly(): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  requirePyLibs();
  const started = await client.pfStart({ request: "월간보고서", params: { month: "2026-09" }, toolCatalog: HOST_CAT });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [
      { goal: "월별 xlsx를 집계한다" },
      { goal: "보고서 pptx를 생성한다", dependsOn: ["1.1"], sideEffect: "local_write" },
    ],
  });
  // ---- 1.1: 9월 실측 앵커 ----
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
  renderPptx("2026-09", agg.rows);
  const args12 = {
    template: "shell.pptx", output: "output/rendered.pptx",
    cover: "월간보고서 2026-09 (최종)", tableTitle: "2026-09 실적 요약",
    rows: agg.rows, slide: 1,
  };
  const json12 = { total: agg.total, title: "월간보고서 2026-09 (최종)" };
  const r12 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
    args: args12, resultSummary: `render 2026-09 total ${agg.total}`, resultJson: json12,
    artifacts: [], artifactContents: {},
    selfVerdict: "pass", selfReason: "생성 확인", attemptId: randomUUID(),
  });
  expect(r12.verdict).toBe("pass");
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    addConstraints: [{ id: "c-sum", kind: "pptx_table_sum", spec: { path: "output/rendered.pptx", slide: 1, column: 2, expected: "$1.1.total" }, source: "human" }],
  });
  const attempt2 = randomUUID();
  const ing2 = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId: "1.2", attemptId: attempt2, baseDir: root, paths: ["shell.pptx", "output/rendered.pptx"] });
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
      template: { kind: "fixed", value: "shell.pptx", path: "in" },
      output: { kind: "fixed", value: "output/rendered.pptx", path: "out" },
      cover: { kind: "var", ref: "월간보고서 ${params.month} (최종)" },
      tableTitle: { kind: "var", ref: "${params.month} 실적 요약" },
      rows: { kind: "var", ref: "$1.1.rows" },
      slide: { kind: "fixed", value: 1 },
      render: { kind: "script", file: "scripts/render_pptx.py" },
    } as never,
    goldenIgnore: ["title"],
  });
  const fin = await app.finalize({ sessionId: sid, name: "monthly", strict: true });
  expect(fin.warnings).toEqual([]);
  // M5.3.1-1: auto file_exists는 논리 경로 (fixtures/ 잔류 없음)
  const doc = JSON.parse(readFileSync(join(pfdir, "procedures", "monthly", "procedure.json"), "utf-8")) as {
    nodes: { id: string; constraints: { kind: string; source: string; spec: { path: string } }[] }[];
  };
  const autoPaths = doc.nodes.flatMap((n) =>
    n.constraints.filter((c) => c.kind === "file_exists" && c.source === "auto").map((c) => `${n.id}:${c.spec.path}`),
  );
  expect(autoPaths.length).toBeGreaterThan(0);
  expect(autoPaths.every((p) => !p.includes("fixtures/"))).toBe(true);
  expect(autoPaths).toContain("1.1:sales-${params.month}.xlsx");
  expect(autoPaths).toContain("1.2:shell.pptx");
  expect(autoPaths).toContain("1.2:output/rendered.pptx");
  // M5.3.1-3: 기간성 params는 default 금지 → required
  const params = (doc as { params: Record<string, { default?: string; required?: boolean }> }).params;
  expect(params["month"].default).toBe(undefined);
  expect(params["month"].required).toBe(true);
}

describe("M5.3-2 수락 테스트", () => {
  it("a: 9월만 분해·strict 0 + b: 10월 실행·9월 잔재 0건", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    const want = aggOf(join(root, "sales-2026-10.xlsx"));
    expect(want.period).toBe("2026-10");
    const { report } = await runProcedureTest(pfdir, root, "monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(2);
    const texts = fullText(join(pfdir, "runs", report.runId, "fs", "output", "rendered.pptx"));
    const all = texts.join("\n");
    expect(all).not.toContain("9월");
    expect(all).not.toContain("2026-09");
    expect(all).toContain("월간보고서 2026-10 (최종)");
    expect(all).toContain("2026-10 실적 요약");
    for (const r of want.rows) {
      expect(all).toContain(`${r.item}`);
      expect(all).toContain(`${r.qty}`);
      expect(all).toContain(r.ex.toLocaleString("en-US"));
    }
  }, 180000);

  it("M5.3.1-3 month 미지정 run → bad_request", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    await expect(runProcedureTest(pfdir, root, "monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    })).rejects.toThrow(/필수 params 누락: month/);
  }, 120000);

  it("M5.5-0 total만 맞고 표가 틀리면 c-sum fail", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    // 거짓 렌더: JSON total은 맞게 보고하되 표 금액은 절반으로 그림
    const procDir = join(pfdir, "procedures", "monthly");
    const scriptP = join(procDir, "scripts", "1_2.py");
    const scriptBackup = readFileSync(scriptP, "utf-8");
    expect(scriptBackup).toContain('"{:,}".format(r["ex"])');
    writeFileSync(scriptP, scriptBackup.replace('"{:,}".format(r["ex"])', '"{:,}".format(r["ex"]//2)'));
    try {
      const { report } = await runProcedureTest(pfdir, root, "monthly", {
        procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
      });
      expect(report.summary.fail).toBeGreaterThanOrEqual(1);
      const n12 = (report.results as { nodeId: string; status: string; failedConstraints: string[] }[]).find(
        (r) => r.nodeId === "1.2",
      );
      expect(n12?.status).toBe("fail");
      expect(n12?.failedConstraints).toContain("c-sum");
    } finally {
      writeFileSync(scriptP, scriptBackup);
    }
  }, 180000);

  it("c: 11월 파일 없음 → 실행 전 bad_request", async () => {
    await buildMonthly();
    expect(existsSync(join(root, "sales-2026-11.xlsx"))).toBe(false);
    await expect(runProcedureTest(pfdir, root, "monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-11" },
    })).rejects.toThrow(/입력 바인딩 실패/);
  }, 120000);

  it("M5.3.1-1 출력 미생성 시 file_exists fail (10월 출력 부재와 동등)", async () => {
    await buildMonthly();
    copyFileSync(OCT_XLSX, join(root, "sales-2026-10.xlsx"));
    const procDir = join(pfdir, "procedures", "monthly");
    const proc = JSON.parse(readFileSync(join(procDir, "procedure.json"), "utf-8")) as {
      nodes: { id: string; golden?: { fixtures?: string[] } }[];
    };
    const fxRel = proc.nodes.find((n) => n.id === "1.2")?.golden?.fixtures?.find((f) => f.endsWith("rendered.pptx")) as string;
    expect(fxRel).toBeTruthy();
    const fx = join(procDir, "tests", fxRel);
    const scriptP = join(procDir, "scripts", "1_2.py");
    const fxBackup = readFileSync(fx);
    const scriptBackup = readFileSync(scriptP, "utf-8");
    const { rmSync } = await import("node:fs");
    rmSync(fx);
    writeFileSync(scriptP, 'import json\nprint(json.dumps({"summary":"noop","json":{"total":1500000,"title":"x"}}))');
    try {
      const { report } = await runProcedureTest(pfdir, root, "monthly", {
        procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
      });
      expect(report.summary.fail).toBeGreaterThanOrEqual(1);
      const n12 = (report.results as { nodeId: string; status: string; failedConstraints: string[] }[]).find(
        (r) => r.nodeId === "1.2",
      );
      expect(n12?.status).toBe("fail");
      // 출력 파일이 없으면 c-sum(표 읽기)이 실패한다
      expect(n12?.failedConstraints).toContain("c-sum");
    } finally {
      writeFileSync(fx, fxBackup);
      writeFileSync(scriptP, scriptBackup);
    }
  }, 180000);

  it("d: 10월 파일에 9월 데이터 → period fail + 하류 blocked", async () => {    await buildMonthly();
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
