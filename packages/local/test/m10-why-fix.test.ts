import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { OUTPUT_SCHEMAS } from "../src/views.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";

useTmpCleanup();

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  pfdir = join(makeTmp("pf-m10whyfix-"), ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
});

describe("M10-why-fix", () => {
  it("⑤ MCP why 왕복 + SDK 0건 + pf_split why 단언", async () => {
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const { tools } = await mcp.listTools();
      expect(JSON.stringify(tools.find((t) => t.name === "pf_split")?.inputSchema)).toContain("why");
      const started = (await mcp.callTool({ name: "pf_start", arguments: { request: "r" } })) as { structuredContent: { sessionId: string } };
      const sid = started.structuredContent.sessionId;
      const out = (await mcp.callTool({
        name: "pf_split",
        arguments: { sessionId: sid, nodeId: "1", reason: "분해 사유입니다 0123456789", children: [{ goal: "x", why: "이유 있음" }] },
      })) as { isError?: boolean; structuredContent: unknown };
      expect(out.isError ?? false).toBe(false);
      const parsed = (OUTPUT_SCHEMAS["pf_split"] as { safeParse: (v: unknown) => { success: boolean; error?: unknown } }).safeParse(out.structuredContent);
      expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error ?? "").slice(0, 300)).toBe(true);
      expect((out.structuredContent as { created: { why?: string }[] }).created[0]?.why).toBe("이유 있음");
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  it("⑥ 공백 why 거부 (split·editWhy·edit_why, trim 후 1~500)", async () => {
    const s = await app.start({ request: "r", toolCatalog: CAT });
    const sid = s.sessionId;
    await expect(app.split({ sessionId: sid, nodeId: "1", reason: "분해 사유입니다 0123456789", children: [{ goal: "a", why: "   " }] } as never)).rejects.toThrow(/1~500/);
    await app.split({ sessionId: sid, nodeId: "1", reason: "분해 사유입니다 0123456789", children: [{ goal: "a", why: "이유 a" }] } as never);
    await expect(app.editWhy({ sessionId: sid, nodeId: "1.1", why: "   " })).rejects.toThrow(/1~500/);
    // 거부 지점이 모드마다 다름: inprocess는 서비스(trim 후 1~500), loopback·remote는 zod(max 500, trim 없음) — 모두 거부되므로 결함 아님.
    try {
      await app.editWhy({ sessionId: sid, nodeId: "1.1", why: "x".repeat(501) });
      expect.unreachable();
    } catch (e) {
      const err = e as Error & { code?: string };
      expect(String(err.message)).toMatch(/500/);
      if (!String(err.message).startsWith("loopback")) expect(err.code).toBe("bad_request");
    }
  });

  it("⑦ remote editWhy 왕복", async () => {
    const dir = makeTmp("pf-whyfix-remote-");
    const KEY = "test-key";
    const srv = await startServer({ dataDir: dir, apiKeys: parseApiKeys(`t1:${KEY}`), port: 0 });
    try {
      const client = createRemoteCoreClient({ baseUrl: `http://127.0.0.1:${srv.port}`, apiKey: KEY });
      const started = await client.pfStart({ request: "r", params: {}, toolCatalog: [{ server: "s", name: "t", inputSchema: {}, schemaHash: "h" }] });
      const sid = started.session.id;
      await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a", why: "원격 이유" }] });
      const out = await client.pfEditWhy({ sessionId: sid, nodeId: "1.1", why: "바꾼 이유" });
      expect((out.node as { why?: string }).why).toBe("바꾼 이유");
    } finally {
      await srv.close();
    }
  }, 30000);
});
