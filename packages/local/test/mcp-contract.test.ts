import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, TOOL_NAMES, READ_ONLY_TOOLS, PROMPT_TEXT } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { OUTPUT_SCHEMAS, ErrorEnvelopeShape } from "../src/views.js";
import { testStack } from "./client-mode.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-mcp-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-mcphome-"));
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

async function linked() {
  const { client, store } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  return { mcp, close: async () => { await mcp.close(); await server.close(); } };
}

const EXPECTED_ORDER = [...TOOL_NAMES];

const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  pf_start: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_next: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_report: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_split: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_confirm_leaf: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_retry: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_ask_human: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_approve: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_test: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_advise: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_tree: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  pf_get_node: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  pf_lock: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_reopen: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_edit_args: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_edit_node: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_refresh_catalog: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_finalize: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_run_start: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_run_next: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  pf_run_supply: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

describe("tools/list 스냅샷 (결정적 순서·annotations)", () => {
  it("이름·순서·annotations·스키마 유무", async () => {
    const { mcp, close } = await linked();
    try {
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toEqual(EXPECTED_ORDER);
      for (const t of tools) {
        expect(t.description, `${t.name} description`).toBeTruthy();
        expect(t.inputSchema, `${t.name} inputSchema`).toBeTruthy();
        expect(t.outputSchema, `${t.name} outputSchema`).toBeTruthy();
        expect(t.annotations, `${t.name} annotations`).toEqual(EXPECTED_ANNOTATIONS[t.name]);
      }
    } finally {
      await close();
    }
  });

  it("READ_ONLY 모드: 읽기 2종만", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir, readOnly: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOLS]);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});

describe("도구 응답 계약 (outputSchema 통과)", () => {
  it("전체 플로우", async () => {
    const { mcp, close } = await linked();
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, `${name} should succeed`).toBeFalsy();
        const parsed = (OUTPUT_SCHEMAS[name] as { safeParse: (v: unknown) => { success: boolean } }).safeParse(r.structuredContent);
        expect(parsed.success, `${name} outputSchema`).toBe(true);
        // text 하위호환: 같은 JSON
        const text = (r.content as { type: string; text: string }[])[0].text;
        expect(JSON.parse(text)).toEqual(r.structuredContent);
        return r.structuredContent as Record<string, unknown>;
      };

      const started = await call("pf_start", { request: "계약 테스트" });
      const sid = started["sessionId"] as string;
      expect(typeof sid).toBe("string");
      expect((started["instruction"] as string)).toContain(PROMPT_TEXT.slice(0, 20));

      await call("pf_next", { sessionId: sid });
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }, { goal: "b" }] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, args: { path: "x" },
        resultSummary: "ok", selfVerdict: "pass", selfReason: " fine",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, argSpecs: { path: { kind: "fixed", value: "x" } },
      });
      await call("pf_retry", { sessionId: sid, nodeId: "1.2", reason: "test" });
      await call("pf_ask_human", { sessionId: sid, nodeId: "1.2", question: "test?" });
      await call("pf_advise", { sessionId: sid, nodeId: "1.2", text: "문체를 다듬어라" });
      await call("pf_tree", { sessionId: sid });
      await call("pf_tree", { sessionId: sid, detail: "full", limit: 1, cursor: 1 });
      await call("pf_get_node", { sessionId: sid, nodeId: "1.1" });
      await call("pf_lock", { sessionId: sid, nodeId: "1.1" });
      await call("pf_reopen", { sessionId: sid, nodeId: "1.1", reason: "test" });
      await call("pf_ask_human", {
        sessionId: sid, nodeId: "1.2", question: "go?",
        plan: { tool: { server: "opencode", name: "read" }, args: { path: "x" } },
      });
      await call("pf_approve", { sessionId: sid, nodeId: "1.2", approved: true, note: "ok" });
      await call("pf_test", { sessionId: sid, mode: "replay" });
      await call("pf_refresh_catalog", {});
    } finally {
      await close();
    }
  });

  it("M4.1.1-4 pf_test nodeId 서브트리만 실행 (계약)", async () => {
    const { mcp, close } = await linked();
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, `${name} should succeed`).toBeFalsy();
        const parsed = (OUTPUT_SCHEMAS[name] as { safeParse: (v: unknown) => { success: boolean } }).safeParse(r.structuredContent);
        expect(parsed.success, `${name} outputSchema`).toBe(true);
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "서브트리" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }, { goal: "b" }] });
      for (const nid of ["1.1", "1.2"]) {
        await call("pf_report", {
          sessionId: sid, nodeId: nid,
          tool: { server: "opencode", name: "read" }, args: { path: "x" },
          resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
        });
        await call("pf_confirm_leaf", {
          sessionId: sid, nodeId: nid,
          tool: { server: "opencode", name: "read" }, argSpecs: { path: { kind: "fixed", value: "x" } },
        });
      }
      // 서브트리 실행: 1.1만 결과에 포함
      const sub = await call("pf_test", { sessionId: sid, mode: "replay", nodeId: "1.1" });
      const { readFileSync } = await import("node:fs");
      const subReport = JSON.parse(readFileSync(sub["reportPath"] as string, "utf8")) as {
        results: { nodeId: string }[];
      };
      expect(subReport.results.map((r) => r.nodeId).sort()).toEqual(["1.1"]);
      // 전체 실행: 부모(비leaf 스킵) + 둘 다 포함
      const full = await call("pf_test", { sessionId: sid, mode: "replay" });
      const fullReport = JSON.parse(readFileSync(full["reportPath"] as string, "utf8")) as {
        results: { nodeId: string }[];
      };
      expect(fullReport.results.map((r) => r.nodeId).sort()).toEqual(["1", "1.1", "1.2"]);
      // 없는 노드 → 오류
      const bad = await mcp.callTool({ name: "pf_test", arguments: { sessionId: sid, mode: "replay", nodeId: "9.9" } });
      expect(bad.isError).toBe(true);
    } finally {
      await close();
    }
  }, 60000);

  it("M4.2-2 pf_edit_args/node E2E", async () => {
    const { mcp, close } = await linked();
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, `${name} should succeed`).toBeFalsy();
        const parsed = (OUTPUT_SCHEMAS[name] as { safeParse: (v: unknown) => { success: boolean } }).safeParse(r.structuredContent);
        expect(parsed.success, `${name} outputSchema`).toBe(true);
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "편집" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, args: { path: "x" },
        resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, argSpecs: { path: { kind: "fixed", value: "x" } },
      });
      // 인자 수정 → open + suggestedArgs 고지
      const edited = await call("pf_edit_args", {
        sessionId: sid, nodeId: "1.1", patch: { set: { path: { kind: "fixed", value: "y" } } },
      });
      expect((edited["node"] as { status: string }).status).toBe("open");
      const nxt = await call("pf_next", { sessionId: sid });
      expect((nxt["instruction"] as string)).toMatch(/사람이 인자를 수정함/);
      // 목표 수정
      const renamed = await call("pf_edit_node", { sessionId: sid, nodeId: "1.1", goal: "b" });
      expect((renamed["node"] as { goal: string }).goal).toBe("b");
      // 빈 패치 거부
      const bad = await mcp.callTool({ name: "pf_edit_args", arguments: { sessionId: sid, nodeId: "1.1", patch: {} } });
      expect(bad.isError).toBe(true);
    } finally {
      await close();
    }
  }, 30000);

  it("M4.2-2.5-6 wire 경유 revision 전달", async () => {
    const { mcp, close } = await linked();
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, `${name} should succeed`).toBeFalsy();
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "rev" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }] });
      const rep = await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, args: { path: "x" },
        resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
        expectedRevision: 1, actor: "human",
      });
      // 변경 응답에 revision/changedNodeIds 포함
      expect(rep["revision"]).toBe(2);
      expect(rep["changedNodeIds"]).toEqual(["1.1"]);
      // stale revision → conflict 봉투
      const stale = await mcp.callTool({
        name: "pf_report",
        arguments: {
          sessionId: sid, nodeId: "1.1",
          tool: { server: "opencode", name: "read" }, args: { path: "x" },
          resultSummary: "ok", selfVerdict: "pass", selfReason: "ok",
          expectedRevision: 1,
        },
      });
      expect(stale.isError).toBe(true);
      expect((stale.structuredContent as { error: { code: string } }).error.code).toBe("conflict");
    } finally {
      await close();
    }
  }, 30000);

  it("에러 봉투: session_not_found", async () => {
    const { mcp, close } = await linked();
    try {
      const r = await mcp.callTool({ name: "pf_next", arguments: { sessionId: "123e4567-e89b-42d3-a456-426614174000" } });
      expect(r.isError).toBe(true);
      const parsed = ErrorEnvelopeShape.safeParse(r.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.code).toBe("session_not_found");
        expect(parsed.data.error.hint.length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });

  it("pf_split 미지정 의존 거부 (dep_missing)", async () => {
    const { mcp, close } = await linked();
    try {
      const started = (await mcp.callTool({ name: "pf_start", arguments: { request: "deadlock" } })).structuredContent as { sessionId: string };
      const sid = started.sessionId;
      const r = await mcp.callTool({ name: "pf_split", arguments: { sessionId: sid, nodeId: "1", children: [{ goal: "x", dependsOn: ["9.9"] }] } });
      expect(r.isError).toBe(true);
      const body = r.structuredContent as { error: { code: string; message: string; hint: string } };
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toMatch(/dep_missing/);
    } finally {
      await close();
    }
  });

  it("에러 봉투: bad_request 힌트 (빈 children)", async () => {
    const { mcp, close } = await linked();
    try {
      const started = (await mcp.callTool({ name: "pf_start", arguments: { request: "x" } })).structuredContent as { sessionId: string };
      const r = await mcp.callTool({ name: "pf_split", arguments: { sessionId: started.sessionId, nodeId: "1", children: [] } });
      expect(r.isError).toBe(true);
      const text = (r.content as { type: string; text: string }[])[0].text;
      expect(text).toMatch(/pf_split/);
    } finally {
      await close();
    }
  });
});

describe("M2.5-6 세션 TTL", () => {
  it("만료 세션은 session_not_found", async () => {
    const { client } = testStack(pfdir, { sessionTtlMs: -1 });
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const started = (await mcp.callTool({ name: "pf_start", arguments: { request: "x" } })).structuredContent as { sessionId: string };
      const r = await mcp.callTool({ name: "pf_next", arguments: { sessionId: started.sessionId } });
      expect(r.isError).toBe(true);
      expect((r.structuredContent as { error: { code: string } }).error.code).toBe("session_not_found");
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});

describe("M2.5-5 응답 크기", () => {
  it("200노드 트리 기본 응답 바이트 한도", async () => {
    const { client } = testStack(pfdir);
    const started = await client.pfStart({
      request: "big",
      toolCatalog: [],
      limits: { maxDepth: 3, maxRetries: 1, maxNodes: 500 },
    });
    const kids = Array.from({ length: 200 }, (_, i) => ({ goal: `작업 ${i}번 항목에 대한 설명 텍스트` }));
    await client.pfResolve({ sessionId: started.session.id, nodeId: "1", decision: "split", children: kids });

    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const r = await mcp.callTool({ name: "pf_tree", arguments: { sessionId: started.session.id } });
      const bytes = Buffer.byteLength(JSON.stringify(r.structuredContent), "utf8");
      expect(bytes).toBeLessThan(32768);
      const body = r.structuredContent as { entries: unknown[]; hasMore: boolean; nextCursor: number };
      expect(body.entries).toHaveLength(50);
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBe(50);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);
});

describe("M2.5-7 prompt", () => {
  it("procforge_decompose 조회", async () => {
    const { mcp, close } = await linked();
    try {
      const { prompts } = await mcp.listPrompts();
      expect(prompts.map((p) => p.name)).toContain("procforge_decompose");
      const got = await mcp.getPrompt({ name: "procforge_decompose", arguments: { request: "월간보고서" } });
      const text = got.messages.map((m) => (m.content as { type: string; text?: string }).text ?? "").join("\n");
      expect(text).toContain("pf_next");
      expect(text).toContain("sandbox");
    } finally {
      await close();
    }
  });
});


