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

  it("CLI positional UUID는 세션으로 해석", async () => {
    const sid = await scriptedSession();
    const cli = resolve(__dirname, "..", "dist", "cli.js");
    const env = { ...process.env, PROCFORGE_DIR: pfdir, PROCFORGE_PROJECT_ROOT: root };
    // 존재하지 않는 UUID → 세션 경로로 실행되어 session_not_found (절차서 경로 아님)
    const r = spawnSync(process.execPath, [cli, "test", "123e4567-e89b-42d3-a456-426614174000", "--mode", "replay"], {
      env, encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/세션 없음/);
    // 존재하는 세션 → replay 실행 (녹화 없어 1.1 fail + 하류 blocked, 세션 경로로 동작)
    const r2 = spawnSync(process.execPath, [cli, "test", sid, "--mode", "replay"], { env, encoding: "utf8" });
    expect(r2.status).toBe(1);
    expect(r2.stdout).toMatch(/run .*fail=1/);
  }, 60000);
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

  it("폴백 off: 확정 in + fixture 없으면 재녹화 에러", async () => {
    const started = await client.pfStart({
      request: "off", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "x" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "nofile.txt" },
      resultSummary: JSON.stringify({ title: "nofile.txt" }), resultJson: { title: "nofile.txt" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "fixed", value: "nofile.txt", path: "in" } } as never,
    });
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record", nodeId: "1.1" });
    expect(rep.summary.fail).toBe(1);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.detail).toMatch(/fixture 없음/);
  }, 30000);
});

describe("M3.3 runner", () => {
  async function leafDirect(
    sid: string,
    nodeId: string,
    tool: string,
    args: Record<string, unknown>,
    resultJson: unknown,
    argSpecs: Record<string, never>,
  ) {
    const summary = JSON.stringify(resultJson);
    await client.pfReport({
      sessionId: sid, nodeId, tool: { server: "fake-ppt", name: tool }, args,
      resultSummary: summary, resultJson,
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({ sessionId: sid, nodeId, decision: "leaf", tool: { server: "fake-ppt", name: tool }, argSpecs: argSpecs as never });
  }

  it("weakIn save: runFs에만 생성되고 replay 통과", async () => {
    await collectCatalog(root);
    const started = await client.pfStart({
      request: "저장", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "저장" }] });
    await leafDirect(sid, "1.1", "save", { file_path: "output/new.pptx", content: "hi" }, { saved: "output/new.pptx" }, {
      file_path: { kind: "fixed", value: "output/new.pptx" },
      content: { kind: "fixed", value: "hi" },
    });
    const rec = await runSession({
      procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record", runId: "m33-save",
    });
    expect(rec.summary.fail).toBe(0);
    expect(existsSync(join(pfdir, "runs", "m33-save", "fs", "output", "new.pptx"))).toBe(true);
    expect(existsSync(join(root, "output", "new.pptx"))).toBe(false);
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(0);
  }, 30000);

  it("미확정 인자(url/title/note)는 그대로 유지", async () => {
    const started = await client.pfStart({
      request: "echo", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "echo" }] });
    const args = { url: "https://a.b/c", title: "1/2분기", note: "보고서.v2" };
    await leafDirect(sid, "1.1", "echo", args, args, {
      url: { kind: "fixed", value: args.url },
      title: { kind: "fixed", value: args.title },
      note: { kind: "fixed", value: args.note },
    });
    const rec = await runSession({
      procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record",
    });
    expect(rec.summary.fail).toBe(0);
    const cas = JSON.parse(readFileSync(join(pfdir, "sessions", sid, "cassettes", "1.1.json"), "utf8")) as {
      entries: { args: Record<string, unknown> }[];
    };
    expect(cas.entries[0].args).toEqual(args);
  }, 30000);

  it("inout 미존재 → fixture 에러", async () => {
    const { BUILTIN_TOOLS } = await import("../src/catalog.js");
    const started = await client.pfStart({
      request: "편집", toolCatalog: BUILTIN_TOOLS,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "편집" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "edit" },
      args: { path: "missing.txt", oldString: "a", newString: "b" },
      resultSummary: "{}", resultJson: {},
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "opencode", name: "edit" },
      argSpecs: {
        path: { kind: "fixed", value: "missing.txt" },
        oldString: { kind: "fixed", value: "a" },
        newString: { kind: "fixed", value: "b" },
      } as never,
    });
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rep.summary.fail).toBe(1);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.detail).toMatch(/fixture 없음/);
  }, 30000);

  it("lastPassHash: (a) 실패 노드 재실행 (b) 서브트리 범위 밖 보존", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    const readLastPass = () =>
      (JSON.parse(readFileSync(join(pfdir, "runs", "by-session", sid, "latest.json"), "utf8")) as { lastPassHash: Record<string, string> }).lastPassHash;
    // (b) 서브트리 실행은 범위 밖 기록을 덮지 않음
    await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(Object.keys(readLastPass()).sort()).toEqual(["1.1", "1.2", "1.3"]);
    // 1.2 녹화 삭제 → replay에서 1.2 실패
    rmSync(join(pfdir, "sessions", sid, "cassettes", "1.2.json"));
    const bad = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay" });
    expect(bad.results.find((r) => r.nodeId === "1.2")?.status).toBe("fail");
    // (a) 다음 --changed에서 1.2 재실행, 1.1은 제외
    const ch = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "replay", changed: true });
    const execIds = ch.results.filter((r) => r.status !== "skipped").map((r) => r.nodeId);
    expect(execIds).toContain("1.2");
    expect(execIds).not.toContain("1.1");
  }, 60000);

  it("split 의존 펼침: dependsOn ['1.2'] 노드가 실행됨", async () => {
    const started = await client.pfStart({
      request: "펼침", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 4, maxRetries: 2, maxNodes: 20 },
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "단일" }, { goal: "묶음" }, { goal: "합치기", dependsOn: ["1.2"] }],
    });
    await client.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    await leafDirect(sid, "1.1", "echo", { title: "a" }, { title: "a" }, { title: { kind: "fixed", value: "a" } });
    await leafDirect(sid, "1.2.1", "echo", { title: "b1" }, { title: "b1" }, { title: { kind: "fixed", value: "b1" } });
    await leafDirect(sid, "1.2.2", "echo", { title: "b2" }, { title: "b2" }, { title: { kind: "fixed", value: "b2" } });
    await leafDirect(sid, "1.3", "echo", { snapshot: "placeholder" }, { snapshot: {} }, {
      snapshot: { kind: "var", ref: "$1.2" },
    });
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    expect(rec.results.find((r) => r.nodeId === "1.3")?.status).toBe("pass");
    const cas = JSON.parse(readFileSync(join(pfdir, "sessions", sid, "cassettes", "1.3.json"), "utf8")) as {
      entries: { args: Record<string, unknown> }[];
    };
    const snap = (cas.entries[0].args["snapshot"] ?? {}) as Record<string, unknown>;
    expect(Object.keys(snap).sort()).toEqual(["1.2.1", "1.2.2"]);
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(0);
  }, 60000);
});

describe("M3.4 runner", () => {
  it("readOnly 툴 인자는 확정 없이 유지, replay 통과", async () => {
    const collected = await collectCatalog(root);
    const entries = collected.entries.map((e) =>
      e.name === "search" ? { ...e, annotations: { readOnlyHint: true } } : e,
    );
    const started = await client.pfStart({
      request: "검색", toolCatalog: entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "검색" }] });
    const args = { query: "부가세", title: "1/2분기" };
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "search" }, args,
      resultSummary: JSON.stringify({ hits: ["부가세", "1/2분기"] }),
      resultJson: { hits: ["부가세", "1/2분기"] },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "search" },
      argSpecs: {
        query: { kind: "fixed", value: "부가세" },
        title: { kind: "fixed", value: "1/2분기" },
      } as never,
    });
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    const cas = JSON.parse(readFileSync(join(pfdir, "sessions", sid, "cassettes", "1.1.json"), "utf8")) as {
      entries: { args: Record<string, unknown> }[];
    };
    expect(cas.entries[0].args).toEqual(args);
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(0);
  }, 30000);

  it("draft stale: 2.1 변경 → core draft open + --changed 재실행", async () => {
    const collected = await collectCatalog(root);
    const started = await client.pfStart({
      request: "draft", toolCatalog: collected.entries,
      limits: { maxDepth: 4, maxRetries: 2, maxNodes: 20 },
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "draft", dependsOn: ["1.2"] }],
    });
    await client.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    const leaf = async (id: string, v: string) => {
      await client.pfReport({
        sessionId: sid, nodeId: id,
        tool: { server: "fake-ppt", name: "echo" }, args: { title: v },
        resultSummary: JSON.stringify({ title: v }), resultJson: { title: v },
        selfVerdict: "pass", selfReason: "ok",
      });
      await client.pfResolve({
        sessionId: sid, nodeId: id, decision: "leaf",
        tool: { server: "fake-ppt", name: "echo" },
        argSpecs: { title: { kind: "fixed", value: v } } as never,
      });
    };
    await leaf("1.1", "a");
    await leaf("1.2.1", "b1");
    await leaf("1.2.2", "b2");
    await leaf("1.3", "d");
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    // 1.2.1 argSpec 변경 → draft(1.3) stale
    await client.pfReopen(sid, "1.2.1", "change");
    await client.pfReport({
      sessionId: sid, nodeId: "1.2.1",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "b1-new" },
      resultSummary: JSON.stringify({ title: "b1-new" }), resultJson: { title: "b1-new" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "fixed", value: "b1-new" } } as never,
    });
    // core: draft open, 무관 노드 유지
    const tree = await client.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.3")?.status).toBe("open");
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("leaf");
    // draft 재확정 후 record --changed → 1.2.1 + 1.3만 재실행
    await client.pfReport({
      sessionId: sid, nodeId: "1.3",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "d" },
      resultSummary: JSON.stringify({ title: "d" }), resultJson: { title: "d" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.3", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "fixed", value: "d" } } as never,
    });
    const chRec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record", changed: true });
    const execIds = chRec.results.filter((r) => r.status !== "skipped").map((r) => r.nodeId);
    expect(execIds).toContain("1.2.1");
    expect(execIds).toContain("1.3");
    expect(execIds).not.toContain("1.1");
    expect(chRec.summary.fail).toBe(0);
  }, 60000);
});

describe("M3.4.1 runner", () => {
  it("쓰기 툴 비경로 인자는 원문 보존 (profile/xpath/file_type/input_language)", async () => {
    const started = await client.pfStart({
      request: "쓰기", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "쓰기" }] });
    const args = {
      path: "out.txt",
      content: "hi",
      profile: "admin",
      xpath: "//title",
      file_type: "pptx",
      input_language: "ko",
    };
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "write" }, args,
      resultSummary: "wrote out.txt", resultJson: { wrote: "out.txt" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "opencode", name: "write" },
      argSpecs: {
        path: { kind: "fixed", value: "out.txt" },
        content: { kind: "fixed", value: "hi" },
        profile: { kind: "fixed", value: "admin" },
        xpath: { kind: "fixed", value: "//title" },
        file_type: { kind: "fixed", value: "pptx" },
        input_language: { kind: "fixed", value: "ko" },
      } as never,
    });
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    expect(existsSync(join(pfdir, "runs", rec.runId, "fs", "out.txt"))).toBe(true);
  }, 30000);

  it("빈 펼침 의존은 blocked (자식 id 부재) + isResolved 일치", async () => {
    const { isResolved } = await import("@procforge/shared/deps.js");
    const started = await client.pfStart({
      request: "빈펼침", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 4, maxRetries: 2, maxNodes: 20 },
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "묶음" }, { goal: "대기", dependsOn: ["1.1"] }],
    });
    await client.pfResolve({ sessionId: sid, nodeId: "1.1", decision: "split", children: [{ goal: "b1" }] });
    // 1.2를 leaf로 확정 (의존은 1.1)
    await client.pfReport({
      sessionId: sid, nodeId: "1.2",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "w" },
      resultSummary: JSON.stringify({ title: "w" }), resultJson: { title: "w" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "fixed", value: "w" } } as never,
    });
    // 자식 id를 부재 id로 바꿈 (손상 시뮬레이션)
    const store = new FileStore(pfdir);
    const b = store.getNode(sid, "1.1")!;
    store.saveNode(sid, { ...b, children: ["9.9"] });
    const byId = new Map([...store.getNodes(sid).values()].map((n) => [n.id, n]));
    expect(isResolved(byId.get("1.1")!, byId)).toBe(false);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    const waiting = rep.results.find((r) => r.nodeId === "1.2")!;
    expect(waiting.status).toBe("blocked");
    expect(waiting.detail).toMatch(/1\.1/);
  }, 30000);
});

describe("M3.4.4 runner", () => {
  it("(c) var 전용 의존도 순서 보장: 1.1 이후 1.2 실행", async () => {
    const started = await client.pfStart({
      request: "varorder", toolCatalog: (await collectCatalog(root)).entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "a" },
      resultSummary: JSON.stringify({ title: "a" }), resultJson: { title: "a" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "fixed", value: "a" } } as never,
    });
    await client.pfReport({
      sessionId: sid, nodeId: "1.2",
      tool: { server: "fake-ppt", name: "echo" }, args: { title: "b" },
      resultSummary: JSON.stringify({ title: "b" }), resultJson: { title: "b" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { title: { kind: "var", ref: "$1.1.output.title" } } as never,
    });
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    const order = rec.results.map((r) => r.nodeId);
    expect(order.indexOf("1.1")).toBeLessThan(order.indexOf("1.2"));
  }, 30000);
});
