import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { collectCatalog } from "../src/catalog.js";
import { createLocalStack } from "../src/core-inprocess.js";
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
  const leaf = async (nodeId: string, tool: string, args: Record<string, unknown>, resultJson: unknown, argSpecs: Record<string, never>) => {
    await client.pfReport({
      sessionId: sid, nodeId, tool: { server: "fake-ppt", name: tool }, args,
      resultSummary: JSON.stringify(resultJson), resultJson,
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({ sessionId: sid, nodeId, decision: "leaf", tool: { server: "fake-ppt", name: tool }, argSpecs: argSpecs as never });
  };
  await leaf("1.1", "list_slides", { file: "data.pptx" }, { slides: ["표지", "실적", "전망"] }, { file: { kind: "fixed", value: "data.pptx" } });
  await leaf("1.2", "read_slide", { file: "data.pptx", index: 1 }, { title: "슬라이드1", body: "본문" }, {
    file: { kind: "fixed", value: "data.pptx" },
    index: { kind: "fixed", value: 1 },
  });
  await leaf("1.3", "fill_template", { template: "t.j2", month: "2026-09" }, { output: "report-2026-09.pptx" }, {
    template: { kind: "fixed", value: "t.j2" },
    month: { kind: "var", ref: "${params.month}" },
  });
  return sid;
}

describe("M3 runner", () => {
  it("record → replay 왕복 (fake 서버 없이 replay 전부 pass)", async () => {
    const sid = await scriptedSession();
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    expect(rec.summary.pass).toBe(3);
    expect(existsSync(join(pfdir, "sessions", sid, "cassettes", "1.1.json"))).toBe(true);

    // 서버 연결을 끊어도 replay는 통과 (녹화본만 사용)
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(0);
    expect(rep.summary.pass).toBe(3);
    expect(existsSync(join(pfdir, "runs", rep.runId, "report.json"))).toBe(true);
  }, 30000);

  it("녹화 누락 시 replay 즉시 실패", async () => {
    const sid = await scriptedSession();
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    expect(rep.summary.fail).toBe(3);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.detail).toMatch(/녹화 없음/);
  }, 30000);

  it("서브트리 실행: 1.1만, 1.2 녹화 삭제해도 통과", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    rmSync(join(pfdir, "sessions", sid, "cassettes", "1.2.json"));
    rmSync(join(pfdir, "sessions", sid, "cassettes", "1.3.json"));
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(rep.results.map((r) => r.nodeId)).toEqual(["1.1"]);
    expect(rep.summary.fail).toBe(0);
  }, 30000);

  it("golden 불일치 → fail+diff, --update-golden으로만 갱신", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    // golden 변조
    const store = new FileStore(pfdir);
    const n = store.getNode(sid, "1.1")!;
    store.saveNode(sid, { ...n, golden: { fixtures: [], output: "tampered" } });
    const bad = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(bad.summary.fail).toBe(1);
    expect(bad.results[0].detail).toMatch(/golden 불일치/);
    // 갱신 없음 확인 (여전히 변조 상태)
    expect(store.getNode(sid, "1.1")!.golden?.output).toBe("tampered");
    // --update-golden으로 갱신 → 다음 replay 통과
    const upd = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay", nodeId: "1.1", updateGolden: true });
    expect(upd.summary.fail).toBe(0);
    expect(store.getNode(sid, "1.1")!.golden?.output).not.toBe("tampered");
    const again = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay", nodeId: "1.1" });
    expect(again.summary.fail).toBe(0);
  }, 30000);

  it("--changed: 조언받은 노드+하류만 실행", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    // 1.2에 조언 추가 (hash 변경, 1.3은 하류 stale로 open 복귀)
    await client.pfAdvise(sid, "1.2", "문체를 다듬어라");
    // 1.3 재확정 (stale open → report → leaf)
    await client.pfReport({
      sessionId: sid, nodeId: "1.3",
      tool: { server: "fake-ppt", name: "fill_template" },
      args: { template: "t.j2", month: "2026-09" },
      resultSummary: JSON.stringify({ output: "report-2026-09.pptx" }),
      resultJson: { output: "report-2026-09.pptx" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: "1.3", decision: "leaf",
      tool: { server: "fake-ppt", name: "fill_template" },
      argSpecs: {
        template: { kind: "fixed", value: "t.j2" },
        month: { kind: "var", ref: "${params.month}" },
      } as never,
    });
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay", changed: true });
    const ids = rep.results.filter((r) => r.status !== "skipped").map((r) => r.nodeId).sort();
    expect(ids).toEqual(["1.2", "1.3"]);
    expect(rep.results.find((r) => r.nodeId === "1.2")?.status).toBe("unverified");
    expect(rep.results.find((r) => r.nodeId === "1.3")?.status).toBe("pass");
  }, 30000);

  it("JUnit XML 출력", async () => {
    const sid = await scriptedSession();
    await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    writeOpencodeConfig(BROKEN_CMD);
    const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "replay" });
    const xml = toJUnit(rep);
    expect(xml).toContain("<testsuite");
    expect(xml).toContain('name="1.1"');
    const out = join(root, "junit.xml");
    writeFileSync(out, xml);
    expect(readFileSync(out, "utf8")).toContain("testcase");
  }, 30000);
});
