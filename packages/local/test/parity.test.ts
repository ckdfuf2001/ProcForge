import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M4.2-4-5: 같은 시나리오를 App 직접 호출과 MCP 전송으로 실행.
// uuid·시각 정규화 후 최종 session·nodes 동일.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-parity-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-parityhome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: {} }));
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

const CATALOG = [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }];

function norm(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<T>"),
  );
}

describe("App 직접 호출 ↔ MCP parity", () => {
  it("동일 시나리오 최종 session·nodes 일치", async () => {
    const { client } = testStack(pfdir);
    const appDirect = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const appMcp = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app: appMcp, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "parity-host", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
        return r.structuredContent as Record<string, unknown>;
      };
      // A: 직접 호출
      const a0 = await appDirect.start({ request: "parity", toolCatalog: CATALOG as never });
      const sidA = a0.sessionId as string;
      await appDirect.split({ sessionId: sidA, nodeId: "1", children: [{ goal: "a" }, { goal: "b" }] });
      for (const nid of ["1.1", "1.2"]) {
        await appDirect.report({
          sessionId: sidA, nodeId: nid,
          tool: { server: "opencode", name: "read" }, args: { path: "x" },
          resultSummary: "ok", resultJson: { ok: true }, selfVerdict: "pass", selfReason: "ok",
        });
      }
      const confirmA = await appDirect.confirmLeaf({
        sessionId: sidA, nodeId: "1.1",
        tool: { server: "opencode", name: "read" },
        argSpecs: { path: { kind: "fixed", value: "x" } },
      });
      const treeA = await client.pfTree(sidA);
      // B: MCP 전송
      const b0 = await call("pf_start", { request: "parity", toolCatalog: CATALOG });
      const sidB = b0["sessionId"] as string;
      await call("pf_split", { sessionId: sidB, nodeId: "1", children: [{ goal: "a" }, { goal: "b" }] });
      for (const nid of ["1.1", "1.2"]) {
        await call("pf_report", {
          sessionId: sidB, nodeId: nid,
          tool: { server: "opencode", name: "read" }, args: { path: "x" },
          resultSummary: "ok", resultJson: { ok: true }, selfVerdict: "pass", selfReason: "ok",
        });
      }
      const confirmB = await call("pf_confirm_leaf", {
        sessionId: sidB, nodeId: "1.1",
        tool: { server: "opencode", name: "read" },
        argSpecs: { path: { kind: "fixed", value: "x" } },
      });
      const treeB = await client.pfTree(sidB);
      expect(norm(treeB)).toEqual(norm(treeA));
      expect(norm(confirmB)).toEqual(norm(confirmA));
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);
});
