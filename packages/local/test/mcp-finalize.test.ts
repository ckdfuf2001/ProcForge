import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { createLocalStack } from "../src/core-inprocess.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-mcpfin-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-mcpfinhome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "data.pptx"), "x");
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

describe("M4 MCP finalize/procedure", () => {
  it("pf_finalize → pf_test(procedure) 통과", async () => {
    const { client } = createLocalStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "보고서", params: { month: "2026-09" } });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "목록" }] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: JSON.stringify({ slides: ["a"] }), resultJson: { slides: ["a"] },
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      const rec = await call("pf_test", { sessionId: sid, mode: "record", allowProjectRead: true });
      expect(rec["failed"]).toBe(0);
      const fin = await call("pf_finalize", { sessionId: sid, name: "mcp-proc" });
      expect((fin["files"] as string[]).some((f) => f === "procedure.json")).toBe(true);
      const tested = await call("pf_test", { procedure: "mcp-proc", allowProjectRead: true });
      expect(tested["failed"]).toBe(0);
      expect(tested["passed"]).toBe(1);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);

  it("M4.1.1-2 junitPath: 기본 runs/<runId>/junit.xml·지정·탈출 거부", async () => {
    const { client } = createLocalStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "보고서", params: { month: "2026-09" } });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "목록" }] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: JSON.stringify({ slides: ["a"] }), resultJson: { slides: ["a"] },
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      await call("pf_test", { sessionId: sid, mode: "record", allowProjectRead: true });
      // 기본 경로
      const rep = await call("pf_test", { sessionId: sid, mode: "replay", allowProjectRead: true });
      const junitDefault = join(pfdir, "runs", rep["runId"] as string, "junit.xml");
      expect(rep["junitPath"]).toBe(junitDefault);
      const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(junitDefault)).toBe(true);
      expect(readFileSync(junitDefault, "utf8")).toContain("<testsuite");
      // 지정 경로 (프로젝트 안 중첩)
      const rep2 = await call("pf_test", { sessionId: sid, mode: "replay", allowProjectRead: true, junitPath: "reports/j.xml" });
      expect(rep2["junitPath"]).toBe(join(root, "reports", "j.xml"));
      expect(existsSync(join(root, "reports", "j.xml"))).toBe(true);
      // 탈출 거부
      await expect(app.test({ sessionId: sid, mode: "replay", junitPath: "../evil.xml" } as never)).rejects.toThrow(/escapes project root/);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 60000);

  it("M4.1.1-3 procedure 이름 규칙: '../' 거부", async () => {
    const { client } = createLocalStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      for (const bad of ["../evil", "..", "a/b", "UPPER", ""]) {
        const r = await mcp.callTool({ name: "pf_test", arguments: { procedure: bad, mode: "replay" } });
        expect(r.isError).toBe(true);
      }
      // 정상 이름은 스키마 통과 (세션 없음은 not_found, 스키마 오류 아님)
      const r = await mcp.callTool({ name: "pf_test", arguments: { procedure: "no-such-proc", mode: "replay" } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/procedure 없음/);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);

  it("pf_advise 제안 채택/거부 (MCP)", async () => {
    const { client } = createLocalStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "조언" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }] });
      await call("pf_ask_human", { sessionId: sid, nodeId: "1.1", question: "?" });
      const adv = await call("pf_advise", {
        sessionId: sid, nodeId: "1.1", text: "개수는 세 개",
        proposedConstraints: [
          { id: "c1", kind: "count", spec: { path: "items", exact: 3 }, source: "human" },
          { id: "c2", kind: "llm_rubric", spec: { rubric: "느낌" }, source: "human" },
        ],
      });
      expect((adv["constraints"] as { id: string }[]).map((c) => c.id)).toEqual(["c1"]);
      expect((adv["rejected"] as unknown[])).toHaveLength(1);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);
});


