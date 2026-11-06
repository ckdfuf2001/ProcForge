import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";
import { computeApprovalHash, toHashable } from "../src/services/approvals.js";
import { OUTPUT_SCHEMAS } from "../src/views.js";
import { buildServer } from "../src/server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// M9-tmp: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M10-why-1: 분해 사유 `why` (pf_split 선택 필드).

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  pfdir = join(makeTmp("pf-m10why1-"), ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
});

async function startSplit(children: { goal: string; why?: string }[]): Promise<string> {
  const s = await app.start({ request: "r", toolCatalog: CAT });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "분해 사유입니다 0123456789",
    children,
  } as never);
  return s.sessionId;
}

describe("M10-why-1 분해 사유 why", () => {
  it("① why 없이 호출해도 기존 동작한다", async () => {
    const sid = await startSplit([{ goal: "a" }]);
    const n = await app.core.getNode(sid, "1.1");
    expect((n as { why?: unknown }).why).toBeUndefined();
    expect(n.status).toBe("open");
  });

  it("② why가 procedure.json까지 왕복한다", async () => {
    const sid = await startSplit([{ goal: "a", why: "나누는 이유다" }]);
    await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "echo" },
      args: { note: "hi" },
      resultSummary: "echo hi",
      resultJson: { note: "hi" },
      selfVerdict: "pass",
      selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "m10-why" });
    const doc = JSON.parse(
      readFileSync(join(pfdir, "procedures", "m10-why", "procedure.json"), "utf8"),
    ) as { nodes: { id: string; why?: string }[] };
    expect(doc.nodes.find((n) => n.id === "1.1")?.why).toBe("나누는 이유다");
  });

  it("③ SDK 출력 스키마로 검증 시 오류 0건", async () => {
    const { client } = testStack(pfdir);
    const server = buildServer({ app: new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir }), procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const started = (await mcp.callTool({ name: "pf_start", arguments: { request: "r" } })) as { structuredContent: { sessionId: string } };
      const sid = started.structuredContent.sessionId;
      const out = (await mcp.callTool({
        name: "pf_split",
        arguments: {
          sessionId: sid,
          nodeId: "1",
          reason: "분해 사유입니다 0123456789",
          children: [{ goal: "x", why: "이유 있음" }],
        },
      })) as { isError?: boolean; structuredContent: unknown };
      expect(out.isError ?? false).toBe(false);
      const parsed = (OUTPUT_SCHEMAS["pf_split"] as { safeParse: (v: unknown) => { success: boolean; error?: unknown } }).safeParse(out.structuredContent);
      expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error ?? "").slice(0, 300)).toBe(true);
      const created = (out.structuredContent as { created: { why?: string }[] }).created;
      expect(created[0]?.why).toBe("이유 있음");
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  it("④ why를 바꿔도 승인 hash가 변하지 않는다", () => {
    const base = { id: "1.1", goal: "g", args: {}, constraints: [], dependsOn: [] };
    const byId = new Map(Object.entries({ "1.1": toHashable(base) }));
    const h1 = computeApprovalHash(toHashable(base), byId, new Set(), {});
    const withWhy = { ...base, why: "이유다" } as unknown as Parameters<typeof toHashable>[0];
    const byId2 = new Map(Object.entries({ "1.1": toHashable(withWhy) }));
    const h2 = computeApprovalHash(toHashable(withWhy), byId2, new Set(), {});
    expect(h2).toBe(h1);
  });
});
