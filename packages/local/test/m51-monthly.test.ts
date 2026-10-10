import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcForgeApp } from "../src/app/app.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.1-C4: C2·C3의 CI E2E(fake 서버). dogfood(monthly-2026-10) 축소 미러.
// - 9월 params로 확정(strict 감사 0) → 10월 params live 실행 → var 치환 검증.
// - fixture 조작 → numeric fail + 하류 blocked → 복원 후 통과.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m51c4-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m51c4home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "template.j2"), "template {{month}}");
  writeFileSync(join(root, "data.json"), JSON.stringify({ total: 150 }));
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

const CAT = [
  { server: "fake-ppt", name: "read_json", inputSchema: {}, schemaHash: "h" },
  { server: "fake-ppt", name: "fill_template", inputSchema: {}, schemaHash: "h" },
] as never;

async function buildSept(): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({
    request: "월간보고서", params: { month: "2026-09" }, toolCatalog: CAT,
  });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [
      { goal: "data.json에서 합계를 읽는다" },
      { goal: "보고서 파일을 생성한다", dependsOn: ["1.1"], sideEffect: "local_write" },
    ],
  });
  const data = JSON.parse(readFileSync(join(root, "data.json"), "utf-8"));
  const a1 = randomUUID();
  const ing1 = ingestArtifacts({
    procforgeDir: pfdir, sessionId: sid, nodeId: "1.1", attemptId: a1, baseDir: root, paths: ["data.json"],
  });
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "read_json" },
    args: { path: "data.json" }, resultSummary: "합계 150", resultJson: data,
    artifacts: ing1.stored, artifactContents: ing1.contents,
    selfVerdict: "pass", selfReason: "합계 확인", attemptId: a1,
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.1",
    addConstraints: [{ id: "c-total", kind: "numeric_match", spec: { path: "total", expected: 150 }, source: "human" }],
  });
  const a2 = randomUUID();
  const ing2 = ingestArtifacts({
    procforgeDir: pfdir, sessionId: sid, nodeId: "1.1", attemptId: a2, baseDir: root, paths: ["data.json"],
  });
  const r11 = await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "read_json" },
    args: { path: "data.json" }, resultSummary: "합계 150", resultJson: data,
    artifacts: ing2.stored, artifactContents: ing2.contents,
    selfVerdict: "pass", selfReason: "합계 일치", attemptId: a2,
  });
  expect(r11.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "read_json" },
    argSpecs: { path: { kind: "fixed", value: "data.json", path: "in" } } as never,
  });
  const a3 = randomUUID();
  const ing3 = ingestArtifacts({
    procforgeDir: pfdir, sessionId: sid, nodeId: "1.2", attemptId: a3, baseDir: root, paths: ["template.j2"],
  });
  const r12 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "fill_template" },
    args: { template: "template.j2", month: "2026-09", output: "output/report.pptx", content: "보고서 2026-09" },
    resultSummary: "보고서 생성", resultJson: { output: "output/report.pptx", month: "2026-09", content: "보고서 2026-09" },
    artifacts: ing3.stored, artifactContents: ing3.contents,
    selfVerdict: "pass", selfReason: "생성 확인", attemptId: a3,
  });
  expect(r12.verdict).toBe("pass");
  await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "fake-ppt", name: "fill_template" },
    argSpecs: {
      template: { kind: "fixed", value: "template.j2", path: "in" },
      month: { kind: "var", ref: "${params.month}" },
      output: { kind: "fixed", value: "output/report.pptx", path: "out" },
      content: { kind: "var", ref: "보고서 ${params.month}" },
    } as never,
    goldenIgnore: ["output"],
  });
  const fin = await app.finalize({ sessionId: sid, name: "m51-monthly", strict: true });
  expect(fin.warnings).toEqual([]);
}

describe("M5.1-C4 월간보고서 재바인딩 E2E", () => {
  it("10월 live 실행: var 치환 + 통과", async () => {
    await buildSept();
    const { report } = await runProcedureTest(pfdir, root, "m51-monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(2);
    const out = readFileSync(join(pfdir, "runs", report.runId, "fs", "output", "report.pptx"), "utf8");
    expect(out.startsWith("filled:2026-10:")).toBe(true);
    expect(out).toContain("보고서 2026-10");
  }, 120000);

  it("fixture 조작: numeric fail + 하류 blocked, 복원 후 통과", async () => {
    await buildSept();
    const proc = JSON.parse(
      readFileSync(join(pfdir, "procedures", "m51-monthly", "procedure.json"), "utf-8"),
    );
    const fxRel = (proc.nodes as { id: string; golden?: { fixtures?: string[] } }[])
      .find((n) => n.id === "1.1")?.golden?.fixtures?.[0] as string;
    expect(fxRel).toMatch(/0-data\.json$/);
    const fx = join(pfdir, "procedures", "m51-monthly", "tests", fxRel);
    const backup = readFileSync(fx, "utf-8");
    writeFileSync(fx, JSON.stringify({ total: 999 }));
    try {
      const { report } = await runProcedureTest(pfdir, root, "m51-monthly", {
        procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
      });
      expect(report.summary.fail).toBeGreaterThanOrEqual(1);
      const byId = new Map(
        (report.results as { nodeId: string; status: string; failedConstraints: string[] }[]).map((r) => [r.nodeId, r]),
      );
      expect(byId.get("1.1")?.status).toBe("fail");
      expect(byId.get("1.1")?.failedConstraints).toContain("c-total");
      expect(byId.get("1.2")?.status).not.toBe("pass");
    } finally {
      writeFileSync(fx, backup);
    }
    const { report: ok } = await runProcedureTest(pfdir, root, "m51-monthly", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: { month: "2026-10" },
    });
    expect(ok.summary.fail).toBe(0);
    expect(ok.summary.pass).toBe(2);
  }, 180000);
});
