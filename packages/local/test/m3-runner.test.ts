import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { collectCatalog } from "../src/catalog.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { runSession, toJUnit } from "../src/runner/index.js";
import { FileStore } from "../src/filestore.js";
import type { CoreClient } from "@procforge/shared/core-client.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;
let client: CoreClient;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const BROKEN_CMD = ["nonexistent-procforge-tool-xyz"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m3-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m3home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "data.pptx"), "x");
  writeFileSync(join(root, "template.j2"), "template {{month}}");
  writeOpencodeConfig(["node", serverMjs]);
  client = createLocalStack(pfdir).client;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

function writeOpencodeConfig(cmd: string[]) {
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: cmd } } }));
}

async function scriptedSession(): Promise<string> {
  const collected = await collectCatalog(root);
  const started = await client.pfStart({
    request: "월간보고서",
    params: { month: "2026-09" },
    toolCatalog: collected.entries,
    limits: { maxDepth: 3, maxRetries: 2, maxNodes: 20 },
  });
  const sid = started.session.id;
  await client.pfResolve({
    sessionId: sid, nodeId: "1", decision: "split",
    children: [{ goal: "목록" }, { goal: "읽기", dependsOn: ["1.1"] }, { goal: "채우기", dependsOn: ["1.1", "1.2"] }],
  });
  const leaf = async (
    nodeId: string,
    tool: string,
    args: Record<string, unknown>,
    resultJson: unknown,
    argSpecs: Record<string, never>,
    artifactPaths: string[] = [],
    goldenIgnore: string[] = [],
  ) => {
    const summary = JSON.stringify(resultJson);
    const attemptId = randomUUID();
    let stored: string[] = [];
    let contents: Record<string, string> = {};
    if (artifactPaths.length > 0) {
      const ing = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId, attemptId, baseDir: root, paths: artifactPaths });
      stored = ing.stored;
      contents = ing.contents;
    }
    await client.pfReport({
      sessionId: sid, nodeId, tool: { server: "fake-ppt", name: tool }, args,
      resultSummary: summary, resultJson,
      artifacts: stored, artifactContents: contents,
      selfVerdict: "pass", selfReason: "ok", attemptId,
    });
    await client.pfResolve({
      sessionId: sid, nodeId, decision: "leaf",
      tool: { server: "fake-ppt", name: tool }, argSpecs: argSpecs as never, goldenIgnore,
    });
  };
  await leaf("1.1", "list_slides", { file: "data.pptx" }, { slides: ["표지", "실적", "전망"] }, { file: { kind: "fixed", value: "data.pptx" } });
  await leaf("1.2", "read_slide", { file: "data.pptx", index: 1 }, { title: "슬라이드1", body: "본문" }, {
    file: { kind: "fixed", value: "data.pptx" },
    index: { kind: "fixed", value: 1 },
  });
  await leaf(
    "1.3", "fill_template",
    { template: "template.j2", month: "2026-09", output: "output/report.pptx" },
    { output: "output/report.pptx", month: "2026-09" },
    {
      template: { kind: "fixed", value: "template.j2" },
      month: { kind: "var", ref: "${params.month}" },
      output: { kind: "fixed", value: "output/report.pptx", path: "out" },
    },
    ["template.j2"],
    ["output"],
  );
  return sid;
}

describe("M3 runner", () => {
  it("record → replay 왕복 (fake 서버 없이 replay 전부 pass)", async () => {
    const sid = await scriptedSession();
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record", runId: "m3-out" });
    expect(rec.summary.fail).toBe(0);
    expect(rec.summary.pass).toBe(3);
    expect(existsSync(join(pfdir, "sessions", sid, "cassettes", "1.1.json"))).toBe(true);
    // M3.1-3: 출력은 runFs에만, 원본 프로젝트에는 없음
    expect(existsSync(join(pfdir, "runs", "m3-out", "fs", "output", "report.pptx"))).toBe(true);
    expect(existsSync(join(root, "output", "report.pptx"))).toBe(false);
    expect(readFileSync(join(pfdir, "runs", "m3-out", "fs", "template.j2"), "utf8")).toContain("template");

    // 서버 연결을 끊어도 replay는 통과 (녹화본만 사용)
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(0);
    expect(rep.summary.pass).toBe(3);
    expect(existsSync(join(pfdir, "runs", rep.runId, "report.json"))).toBe(true);
  }, 30000);

  it("녹화 누락 시 replay 즉시 실패", async () => {
    const sid = await scriptedSession();
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(1);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.detail).toMatch(/녹화 없음/);
    // 하류는 blocked (실행 안 함)
    expect(rep.results.find((r) => r.nodeId === "1.2")?.status).toBe("blocked");
  }, 30000);

  it("서브트리 실행: 1.1만, 1.2 녹화 삭제해도 통과", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    rmSync(join(pfdir, "sessions", sid, "cassettes", "1.2.json"));
    rmSync(join(pfdir, "sessions", sid, "cassettes", "1.3.json"));
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(rep.results.map((r) => r.nodeId)).toEqual(["1.1"]);
    expect(rep.summary.fail).toBe(0);
  }, 30000);

  it("passthrough drift: golden 변조 → fail+diff, record+update로만 갱신", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    // golden 변조
    const store = new FileStore(pfdir);
    const n = store.getNode(sid, "1.1")!;
    store.saveNode(sid, { ...n, golden: { fixtures: [], output: "tampered", attemptId: n.golden?.attemptId, ignore: [] } });
    // passthrough는 실제 호출 → drift 검출 fail
    const drift = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "passthrough", nodeId: "1.1" });
    expect(drift.summary.fail).toBe(1);
    expect(drift.results[0].detail).toMatch(/golden drift/);
    // 갱신 없음 확인
    expect(store.getNode(sid, "1.1")!.golden?.output).toBe("tampered");
    // record+update-golden으로 갱신 → replay 통과
    const upd = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record", nodeId: "1.1", updateGolden: true });
    expect(upd.summary.fail).toBe(0);
    expect(store.getNode(sid, "1.1")!.golden?.output).not.toBe("tampered");
    writeOpencodeConfig(BROKEN_CMD);
    const again = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    expect(again.summary.fail).toBe(0);
  }, 30000);

  it("실패 전파: 상류 실패 → 하류 blocked", async () => {
    const collected = await collectCatalog(root);
    const builtin = collected.entries.filter((e) => e.server === "opencode");
    const started = await client.pfStart({
      request: "blocked",
      toolCatalog: [...builtin, ...collected.entries.filter((e) => e.server === "fake-ppt")],
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "읽기" }, { goal: "후속", dependsOn: ["1.1"] }] });
    for (const nid of ["1.1", "1.2"]) {
      await client.pfReport({
        sessionId: sid, nodeId: nid,
        tool: { server: "opencode", name: "read" }, args: { path: nid === "1.1" ? "missing.txt" : "also-missing.txt" },
        resultSummary: "{}", resultJson: {},
        selfVerdict: "pass", selfReason: "ok",
      });
      await client.pfResolve({
        sessionId: sid, nodeId: nid, decision: "leaf",
        tool: { server: "opencode", name: "read" },
        argSpecs: { path: { kind: "fixed", value: nid === "1.1" ? "missing.txt" : "also-missing.txt" } } as never,
      });
    }
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "passthrough" });
    expect(rep.results.find((r) => r.nodeId === "1.1")?.status).toBe("fail");
    const downstream = rep.results.find((r) => r.nodeId === "1.2")!;
    expect(downstream.status).toBe("blocked");
    expect(downstream.detail).toMatch(/1\.1/);
    expect(rep.summary.pass).toBe(0);
  }, 30000);

  it("--changed: 조언받은 노드+하류만 실행", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    await client.pfAdvise(sid, "1.2", "문체를 다듬어라");
    // 1.3 재확정 (stale open → report → leaf). 기존 fixture 내용을 함께 제출해 file_exists 통과
    const store13 = new FileStore(pfdir);
    const n13 = store13.getNode(sid, "1.3")!;
    const contents13: Record<string, string> = {};
    for (const fx of n13.golden?.fixtures ?? []) {
      contents13[fx] = readFileSync(join(pfdir, "sessions", sid, fx), "utf8");
    }
    await client.pfReport({
      sessionId: sid, nodeId: "1.3",
      tool: { server: "fake-ppt", name: "fill_template" },
      args: { template: "template.j2", month: "2026-09", output: "output/report.pptx" },
      resultSummary: JSON.stringify({ output: "output/report.pptx", month: "2026-09" }),
      resultJson: { output: "output/report.pptx", month: "2026-09" },
      artifacts: [...(n13.golden?.fixtures ?? [])],
      artifactContents: contents13,
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.3", decision: "leaf",
      tool: { server: "fake-ppt", name: "fill_template" },
      argSpecs: {
        template: { kind: "fixed", value: "template.j2" },
        month: { kind: "var", ref: "${params.month}" },
        output: { kind: "fixed", value: "output/report.pptx", path: "out" },
      } as never,
      goldenIgnore: ["output"],
    });
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", changed: true });
    const ids = rep.results.filter((r) => r.status !== "skipped").map((r) => r.nodeId).sort();
    expect(ids).toEqual(["1.2", "1.3"]);
    expect(rep.results.find((r) => r.nodeId === "1.2")?.status).toBe("unverified");
    expect(rep.results.find((r) => r.nodeId === "1.3")?.status).toBe("pass");
  }, 30000);

  it("JUnit XML 출력 (skipped 매핑 포함)", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    const xml = toJUnit(rep);
    expect(xml).toContain("<testsuite");
    expect(xml).toContain('name="1.1"');
    const out = join(root, "junit.xml");
    writeFileSync(out, xml);
    expect(readFileSync(out, "utf8")).toContain("testcase");
  }, 30000);

  it("replay+update-golden은 bad_request, CLI는 exit 2", async () => {
    const sid = await scriptedSession();
    await expect(
      runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", updateGolden: true }),
    ).rejects.toThrow(/update-golden.*record\/passthrough/);
    const cli = resolve(__dirname, "..", "dist", "cli.js");
    const r = spawnSync(process.execPath, [cli, "test", "--session", sid, "--mode", "replay", "--update-golden"], {
      env: { ...process.env, PROCFORGE_DIR: pfdir, PROCFORGE_PROJECT_ROOT: root },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  }, 30000);
});

describe("M3.2 runner", () => {
  it("generated 인자는 passthrough에서 기록값으로 실제 호출, live는 미지원", async () => {
    const collected = await collectCatalog(root);
    const started = await client.pfStart({
      request: "생성",
      params: { month: "2026-09" },
      toolCatalog: collected.entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "채우기" }] });
    const attemptId = randomUUID();
    const ing = ingestArtifacts({ procforgeDir: pfdir, sessionId: sid, nodeId: "1.1", attemptId, baseDir: root, paths: ["template.j2"] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "fill_template" },
      args: { template: "template.j2", month: "2026-09", output: "output/g.pptx" },
      resultSummary: JSON.stringify({ output: "output/g.pptx", month: "2026-09" }),
      resultJson: { output: "output/g.pptx", month: "2026-09" },
      artifacts: ing.stored, artifactContents: ing.contents,
      selfVerdict: "pass", selfReason: "ok", attemptId,
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "fill_template" },
      argSpecs: {
        template: { kind: "fixed", value: "template.j2" },
        month: { kind: "generated", instruction: "params.month 사용", inputs: [], constraints: [] },
        output: { kind: "fixed", value: "output/g.pptx", path: "out" },
      } as never,
      goldenIgnore: ["output"],
    });
    const rep = await runSession({
      procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "passthrough", nodeId: "1.1",
    });
    expect(rep.summary.fail).toBe(0);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
    await expect(
      runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "live", nodeId: "1.1" }),
    ).rejects.toThrow(/M5/);
  }, 30000);

  it("내장 write로 새 파일 생성 (runFs에만)", async () => {
    const { BUILTIN_TOOLS } = await import("../src/catalog.js");
    const started = await client.pfStart({
      request: "쓰기",
      toolCatalog: BUILTIN_TOOLS,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "쓰기" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "write" }, args: { path: "new/out.txt", content: "hi" },
      resultSummary: "wrote new/out.txt", resultJson: { wrote: "new/out.txt" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "opencode", name: "write" },
      argSpecs: { path: { kind: "fixed", value: "new/out.txt" }, content: { kind: "fixed", value: "hi" } } as never,
    });
    const rec = await runSession({
      procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record", runId: "m3-write",
    });
    expect(rec.summary.fail).toBe(0);
    expect(existsSync(join(pfdir, "runs", "m3-write", "fs", "new", "out.txt"))).toBe(true);
    expect(existsSync(join(root, "new", "out.txt"))).toBe(false);
  }, 30000);

  it("절대경로 확정 노드도 replay에서 run fs로 매핑 (마이그레이션)", async () => {
    const sid = await scriptedSession();
    // 구 세션 흉내: 1.1을 프로젝트 절대경로로 재확정 (서버 정규화 우회 = client 직접 호출)
    const abs = join(root, "data.pptx");
    await client.pfReopen(sid, "1.1", "migration test");
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "list_slides" }, args: { file: abs },
      resultSummary: JSON.stringify({ slides: ["표지", "실적", "전망"] }),
      resultJson: { slides: ["표지", "실적", "전망"] },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "list_slides" },
      argSpecs: { file: { kind: "fixed", value: abs } } as never,
    });
    const store = new FileStore(pfdir);
    expect(store.getNode(sid, "1.1")!.args!["file"]).toEqual({ kind: "fixed", value: abs });
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record", nodeId: "1.1" });
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(rep.summary.fail).toBe(0);
  }, 30000);

  it("폴백 off: fixture 없으면 재녹화 에러", async () => {
    const sid = await scriptedSession();
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record", nodeId: "1.1" });
    expect(rep.summary.fail).toBe(1);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.detail).toMatch(/fixture 없음/);
  }, 30000);
});
