import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { runSession } from "../src/runner/index.js";
import { FileStore } from "../src/filestore.js";
import { writeCaptureRecord } from "../src/services/snapshot.js";
import { classifyReportPaths, resolveOriginal } from "../src/services/artifacts.js";
import type { Node } from "@procforge/shared/schema.js";

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

describe("M4.1.1-1 inout 원본 탐색 단위", () => {
  let pfdir: string;
  const sid = "11111111-1111-4111-8111-111111111111";
  const sessDir = () => join(pfdir, "sessions", sid);

  beforeEach(() => {
    pfdir = mkdtempSync(join(tmpdir(), "pf-311u-"));
    mkdirSync(sessDir(), { recursive: true });
  });

  function node(id: string, attemptId: string | undefined): Node {
    return { id, attempts: attemptId ? [{ id: attemptId }] : [] } as unknown as Node;
  }

  it("seed → 캡처 → precopy 순서, 없으면 undefined", () => {
    mkdirSync(join(sessDir(), "seed"), { recursive: true });
    writeFileSync(join(sessDir(), "seed", "a.txt"), "from-seed");
    // 앞 노드 캡처 (다른 내용)
    mkdirSync(join(sessDir(), "fixtures", "1.1", "a1"), { recursive: true });
    writeFileSync(join(sessDir(), "fixtures", "1.1", "a1", "0-a.txt"), "from-capture");
    writeFileSync(join(sessDir(), "fixtures-manifest.json"), JSON.stringify({ "fixtures/1.1/a1/0-a.txt": "a.txt" }));
    writeCaptureRecord(pfdir, sid, "1.1", "a1", { ins: [], outs: ["fixtures/1.1/a1/0-a.txt"], inouts: [] });
    // precopy (또 다른 내용)
    mkdirSync(join(sessDir(), "nodes", "1.2", "pre"), { recursive: true });
    writeFileSync(join(sessDir(), "nodes", "1.2", "pre", "a.txt"), "from-precopy");
    const base = {
      procforgeDir: pfdir, sessionId: sid, nodeId: "1.2", rel: "a.txt",
      nodes: [node("1.1", "a1")], manifest: { "fixtures/1.1/a1/0-a.txt": "a.txt" },
    };
    // seed 우선
    expect(resolveOriginal(base)!.buf.toString()).toBe("from-seed");
    // seed 제거 → 캡처
    rmSync(join(sessDir(), "seed", "a.txt"));
    expect(resolveOriginal(base)).toMatchObject({ from: "capture" });
    expect(resolveOriginal(base)!.buf.toString()).toBe("from-capture");
    // 캡처 fixture 소실 → precopy
    rmSync(join(sessDir(), "fixtures", "1.1", "a1", "0-a.txt"));
    expect(resolveOriginal(base)).toMatchObject({ from: "precopy" });
    // 전부 제거 → undefined
    rmSync(join(sessDir(), "nodes", "1.2", "pre", "a.txt"));
    expect(resolveOriginal(base)).toBeUndefined();
  });

  it("classify: 생성→out, 수정→inout, 그 외→in", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-311c-"));
    writeFileSync(join(dir, "new.txt"), "n");
    writeFileSync(join(dir, "mod.txt"), "m");
    writeFileSync(join(dir, "same.txt"), "s");
    const tool = { server: "opencode", name: "read" };
    const jobs = classifyReportPaths({
      baseDir: dir, tool, args: { path: "new.txt" },
      resultJson: { f1: "mod.txt", f2: "same.txt" },
      createdRels: new Set(["new.txt"]),
      modifiedRels: new Set(["mod.txt"]),
    });
    const kindOf = (p: string) => jobs.find((j) => j.p === p)?.kind;
    expect(kindOf("new.txt")).toBe("out");
    expect(kindOf("mod.txt")).toBe("inout");
    expect(kindOf("same.txt")).toBe("in");
  });
});

describe("M4.1.1-1 수정 노드 확정·replay (E2E)", () => {
  let root: string;
  let pfdir: string;
  let home: string;
  let oldHome: string | undefined;
  let oldProfile: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pf-311-"));
    pfdir = join(root, ".procforge");
    home = mkdtempSync(join(tmpdir(), "pf-311home-"));
    oldHome = process.env.HOME;
    oldProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    writeFileSync(join(root, "data.pptx"), "PPTX-DATA");
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }));
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  });

  async function linked() {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "m311-host", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await mcp.callTool({ name, arguments: args });
      if (r.isError) throw new Error(`${name} failed: ${(r.content as { text: string }[])[0].text}`);
      return r.structuredContent as Record<string, unknown>;
    };
    const callRaw = async (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });
    return { call, callRaw, close: async () => { await mcp.close(); await server.close(); } };
  }

  const slidesSummary = JSON.stringify({ slides: ["표지", "실적", "전망"] });

  it("seed 수정 노드: 확정 후 replay 통과, 원본 fixture 보존", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", {
        request: "월간보고서", params: { month: "2026-09" }, seedFiles: ["data.pptx"],
      });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "수정" }] });
      await call("pf_next", { sessionId: sid });
      // 에이전트가 sandbox 사본 수정
      writeFileSync(join(pfdir, "sandbox", sid, "data.pptx"), "PPTX-MODIFIED");
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: slidesSummary, resultJson: JSON.parse(slidesSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      const n = new FileStore(pfdir).getNode(sid, "1.1")!;
      expect(n.status).toBe("leaf");
      // 원본 fixture가 golden에 유지
      const bodies = n.golden!.fixtures.map((fx) => readFileSync(join(pfdir, "sessions", sid, fx), "utf8"));
      expect(bodies).toContain("PPTX-DATA");
      await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
      const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: false, sessionId: sid, mode: "replay" });
      expect(rep.summary.fail).toBe(0);
      expect(rep.summary.pass).toBe(1);
    } finally {
      await close();
    }
  }, 60000);

  it("pre-copy 원본: seed 없이도 확정, 수정 전 내용 보존", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "작업본 수정" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "수정" }] });
      mkdirSync(join(pfdir, "sandbox", sid), { recursive: true });
      writeFileSync(join(pfdir, "sandbox", sid, "work.txt"), "V1");
      await call("pf_next", { sessionId: sid });
      writeFileSync(join(pfdir, "sandbox", sid, "work.txt"), "V2");
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "work.txt" },
        resultSummary: slidesSummary, resultJson: JSON.parse(slidesSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "work.txt" } },
      });
      const n = new FileStore(pfdir).getNode(sid, "1.1")!;
      expect(n.status).toBe("leaf");
      const bodies = n.golden!.fixtures.map((fx) => readFileSync(join(pfdir, "sessions", sid, fx), "utf8"));
      expect(bodies).toContain("V1");
    } finally {
      await close();
    }
  }, 60000);

  it("원본 없으면 confirm 거부", async () => {
    const { call, callRaw, close } = await linked();
    try {
      const started = await call("pf_start", { request: "원본 소실" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "수정" }] });
      mkdirSync(join(pfdir, "sandbox", sid), { recursive: true });
      writeFileSync(join(pfdir, "sandbox", sid, "ghost.txt"), "G1");
      await call("pf_next", { sessionId: sid });
      // pre-copy 소실 시뮬레이션 (원본 탐색 불가)
      for (const f of readdirSync(join(pfdir, "sessions", sid, "nodes", "1.1", "pre"))) {
        rmSync(join(pfdir, "sessions", sid, "nodes", "1.1", "pre", f));
      }
      writeFileSync(join(pfdir, "sandbox", sid, "ghost.txt"), "G2");
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "ghost.txt" },
        resultSummary: slidesSummary, resultJson: JSON.parse(slidesSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      const r = await callRaw("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "ghost.txt" } },
      });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/원본 없음/);
      expect(new FileStore(pfdir).getNode(sid, "1.1")!.status).not.toBe("leaf");
    } finally {
      await close();
    }
  }, 60000);
});
