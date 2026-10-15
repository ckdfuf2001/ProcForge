import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { recordCall, buildTrace, formatTraceMarkdown } from "../src/trace.js";
import { testStack } from "./client-mode.js";

// M7-1-7: 호출 귀속. MCP 연결마다 connectionId, UI는 actor:"ui".

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m71a-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m71ahome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function linkedPair(connectionId: string) {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
  });
  const server = buildServer({ app, procforgeDir: pfdir, connectionId });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError)
    throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
  return r.structuredContent as Record<string, unknown>;
}

describe("M7-1-7 호출 귀속", () => {
  it("연결 2개가 같은 세션에 끼어들면 calls.jsonl에 id 2개 + trace 표시", async () => {
    const a = await linkedPair("conn-a");
    const b = await linkedPair("conn-b");
    try {
      const started = await call(a.mcp, "pf_start", { request: "r" });
      const sid = started["sessionId"] as string;
      await call(a.mcp, "pf_next", { sessionId: sid });
      await call(b.mcp, "pf_tree", { sessionId: sid });
      // UI 직접 호출 흉내 (MCP 미경유, actor:"ui").
      recordCall(pfdir, {
        tool: "pf_tree",
        sessionId: sid,
        ok: true,
        actor: "ui",
        connectionId: "ui-1",
      });
      const rows = readFileSync(
        join(pfdir, "sessions", sid, "calls.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as {
              connectionId?: string;
              actor?: string;
              tool?: string;
            },
        );
      const ids = new Set(rows.map((r) => r.connectionId));
      expect(ids.has("conn-a")).toBe(true);
      expect(ids.has("conn-b")).toBe(true);
      expect(ids.has("ui-1")).toBe(true);
      expect(rows.some((r) => r.actor === "ui")).toBe(true);
      const md = formatTraceMarkdown(buildTrace(pfdir, sid));
      expect(md).toMatch(/연결 3개/);
    } finally {
      await a.close();
      await b.close();
    }
  }, 60000);

  it("연결 1개면 연결 표시 없음", async () => {
    const a = await linkedPair("only-one");
    try {
      const started = await call(a.mcp, "pf_start", { request: "r" });
      const sid = started["sessionId"] as string;
      const md = formatTraceMarkdown(buildTrace(pfdir, sid));
      expect(md).not.toMatch(/연결 \d+개/);
    } finally {
      await a.close();
    }
  }, 60000);
});
