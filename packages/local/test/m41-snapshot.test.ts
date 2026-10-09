import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { FileStore } from "../src/filestore.js";
import { readCaptureRecord } from "../src/services/snapshot.js";
import { runSession } from "../src/runner/index.js";
import { setupRunFs } from "../src/runner/workdir.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m41-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m41home-"));
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
  const { client, store } = createLocalStack(pfdir);
  const app = new ProcForgeApp({ core: client, store, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "m41-host", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${(r.content as { text: string }[])[0].text}`);
    return r.structuredContent as Record<string, unknown>;
  };
  return { call, close: async () => { await mcp.close(); await server.close(); } };
}

describe("M4.1-7 스냅샷 입출력 판정", () => {
  it("새로 생긴 파일은 out: golden 제외·run fs 미복사", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "스냅샷" });
      const sid = started["sessionId"] as string;
      // pf_next가 스냅샷 기록
      const nxt = await call("pf_next", { sessionId: sid });
      expect((nxt["node"] as { id: string }).id).toBe("1");
      expect(existsSync(join(pfdir, "sessions", sid, "nodes", "1", "pre-snapshot.json"))).toBe(true);
      // 스냅샷 이후 도구가 새 파일 생성 (save 시뮬레이션)
      mkdirSync(join(pfdir, "sandbox", sid, "output"), { recursive: true });
      writeFileSync(join(pfdir, "sandbox", sid, "output", "new.pptx"), "NEWBYTES");
      const rep = await call("pf_report", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "save" },
        args: { file_path: "output/new.pptx", content: "NEWBYTES" },
        resultSummary: JSON.stringify({ saved: "output/new.pptx" }),
        resultJson: { saved: "output/new.pptx" },
        selfVerdict: "pass", selfReason: "ok",
      });
      expect(rep["verdict"]).toBe("pass");
      expect(rep["warnings"] as string[]).toEqual([]);
      const store = new FileStore(pfdir);
      const attempt = store.getNode(sid, "1")!.attempts[0];
      expect(attempt.artifacts.length).toBe(1);
      // sidecar에 out으로 기록
      const rec = readCaptureRecord(pfdir, sid, "1", attempt.id)!;
      expect(rec.outs).toEqual(attempt.artifacts);
      expect(rec.ins).toEqual([]);
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "save" },
        argSpecs: {
          file_path: { kind: "fixed", value: "output/new.pptx" },
          content: { kind: "fixed", value: "NEWBYTES" },
        },
      });
      const n = new FileStore(pfdir).getNode(sid, "1")!;
      // out은 golden에 없음 (in fixture로 잡히지 않음)
      expect(n.golden?.fixtures ?? []).toEqual([]);
      // file_exists는 증거 파일 기준으로 통과 (replay에서 확인)
      expect(n.constraints.some((c) => c.kind === "file_exists")).toBe(true);
      // run fs에 미리 복사되지 않음
      const probe = setupRunFs(pfdir, sid, "probe-fs");
      expect(existsSync(join(probe.fsDir, "output", "new.pptx"))).toBe(false);
      // record → replay 통과
      await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
      const replay = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: false, sessionId: sid, mode: "replay" });
      expect(replay.summary.fail).toBe(0);
      expect(replay.summary.pass).toBe(1);
    } finally {
      await close();
    }
  }, 60000);

  it("그대로인 기존 파일은 in fixture 유지", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "그대로", seedFiles: ["data.pptx"] });
      const sid = started["sessionId"] as string;
      await call("pf_next", { sessionId: sid });
      const slides = JSON.stringify({ slides: ["표지", "실적", "전망"] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: slides, resultJson: JSON.parse(slides),
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      const n = new FileStore(pfdir).getNode(sid, "1")!;
      expect(n.golden?.fixtures.length).toBe(1);
      expect(readFileSync(join(pfdir, "sessions", sid, n.golden!.fixtures[0]), "utf8")).toBe("PPTX-DATA");
    } finally {
      await close();
    }
  }, 30000);

  it("스냅샷 없으면 폴백 + 경고", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "폴백", seedFiles: ["data.pptx"] });
      const sid = started["sessionId"] as string;
      // pf_next 없이 보고 → 폴백
      const slides = JSON.stringify({ slides: ["표지", "실적", "전망"] });
      const rep = await call("pf_report", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: slides, resultJson: JSON.parse(slides),
        selfVerdict: "pass", selfReason: "ok",
      });
      expect((rep["warnings"] as string[]).join()).toMatch(/스냅샷 없음/);
      expect(new FileStore(pfdir).getNode(sid, "1")!.attempts[0].artifacts.length).toBe(1);
    } finally {
      await close();
    }
  }, 30000);
});


