import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { toError } from "@procforge/shared/errors.js";
import { ingestArtifacts, setupSandbox } from "./artifacts.js";
import { collectCatalog } from "./catalog.js";

export type ServerDeps = {
  client: CoreClient;
  procforgeDir: string;
  projectRoot: string;
};

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

function errOf(e: unknown) {
  const code = (e as { code?: string } | null)?.code ?? "internal";
  const message = e instanceof Error ? e.message : String(e);
  return text(toError(code, message, "pf_tree로 상태를 확인하라"));
}

const ToolRefShape = z.object({ server: z.string().min(1), name: z.string().min(1) });
const CatalogEntryShape = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  schemaHash: z.string().min(1),
});
const ArgSpecShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.unknown() }),
  z.object({ kind: z.literal("var"), ref: z.string().min(1) }),
  z.object({
    kind: z.literal("generated"),
    instruction: z.string().min(1),
    inputs: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
  }),
]);

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "procforge-local", version: "0.2.0" });
  const { client } = deps;

  server.tool(
    "pf_start",
    "ProcForge 세션 시작",
    { request: z.string().min(1), params: z.record(z.string()).optional(), toolCatalog: z.array(CatalogEntryShape).optional(), seedFiles: z.array(z.string()).optional() },
    async (a) => {
      try {
        const collected = a.toolCatalog ? undefined : await collectCatalog(deps.projectRoot);
        const catalog = a.toolCatalog ?? collected!.entries;
        const warnings = collected?.warnings ?? [];
        const out = await client.pfStart({ request: a.request, params: a.params, toolCatalog: catalog });
        let sandboxNote = "";
        if (a.seedFiles && a.seedFiles.length > 0) {
          const sb = setupSandbox({ procforgeDir: deps.procforgeDir, sessionId: out.session.id, projectRoot: deps.projectRoot, seedFiles: a.seedFiles });
          sandboxNote = ` 참조 파일 ${sb.copied.length}개를 sandbox(${sb.sandboxDir})에 복사했다.`;
        }
        return text({ sessionId: out.session.id, node: out.node, instruction: out.instruction + sandboxNote, warnings });
      } catch (e) {
        return errOf(e);
      }
    },
  );

  server.tool("pf_next", "다음 작업 노드 조회", { sessionId: z.string().min(1) }, async (a) => {
    try {
      return text(await client.pfNext(a.sessionId));
    } catch (e) {
      return errOf(e);
    }
  });

  server.tool(
    "pf_report",
    "leaf 실행 결과 보고",
    {
      sessionId: z.string().min(1),
      nodeId: z.string().min(1),
      tool: ToolRefShape,
      args: z.record(z.unknown()),
      resultSummary: z.string(),
      resultJson: z.unknown().optional(),
      artifacts: z.array(z.string()).optional(),
      selfVerdict: z.enum(["pass", "fail"]),
      selfReason: z.string().min(1),
      rubricReasons: z.record(z.string()).optional(),
    },
    async (a) => {
      try {
        const attemptId = `a-${randomBytes(4).toString("hex")}`;
        let stored: string[] = [];
        let contents: Record<string, string> = {};
        if (a.artifacts && a.artifacts.length > 0) {
          const ing = ingestArtifacts({
            procforgeDir: deps.procforgeDir,
            sessionId: a.sessionId,
            nodeId: a.nodeId,
            attemptId,
            projectRoot: deps.projectRoot,
            paths: a.artifacts,
          });
          stored = ing.stored;
          contents = ing.contents;
        }
        const out = await client.pfReport({
          sessionId: a.sessionId,
          nodeId: a.nodeId,
          tool: a.tool,
          args: a.args as Record<string, unknown>,
          resultSummary: a.resultSummary,
          resultJson: a.resultJson,
          artifacts: stored,
          artifactContents: contents,
          selfVerdict: a.selfVerdict,
          selfReason: a.selfReason,
          rubricReasons: a.rubricReasons,
          attemptId,
        });
        return text(out);
      } catch (e) {
        return errOf(e);
      }
    },
  );

  server.tool(
    "pf_resolve",
    "노드 판정(leaf/split/retry/ask_human)",
    {
      sessionId: z.string().min(1),
      nodeId: z.string().min(1),
      decision: z.enum(["leaf", "split", "retry", "ask_human"]),
      children: z.array(z.object({ goal: z.string().min(1), dependsOn: z.array(z.string()).optional(), sideEffect: z.enum(["none", "local_write", "external"]).optional() })).optional(),
      argSpecs: z.record(ArgSpecShape).optional(),
      sideEffect: z.enum(["none", "local_write", "external"]).optional(),
      tool: ToolRefShape.optional(),
    },
    async (a) => {
      try {
        return text(
          await client.pfResolve({
            sessionId: a.sessionId,
            nodeId: a.nodeId,
            decision: a.decision,
            children: a.children as { goal: string; dependsOn?: string[]; sideEffect?: "none" | "local_write" | "external" }[] | undefined,
            argSpecs: a.argSpecs as Record<string, { kind: "fixed"; value: unknown } | { kind: "var"; ref: string } | { kind: "generated"; instruction: string; inputs: string[]; constraints: string[] }> | undefined,
            sideEffect: a.sideEffect,
            tool: a.tool,
          }),
        );
      } catch (e) {
        return errOf(e);
      }
    },
  );

  server.tool(
    "pf_advise",
    "사람 조언 등록(조건으로 변환)",
    { sessionId: z.string().min(1), nodeId: z.string().min(1), text: z.string().min(1) },
    async (a) => {
      try {
        return text(await client.pfAdvise(a.sessionId, a.nodeId, a.text));
      } catch (e) {
        return errOf(e);
      }
    },
  );

  server.tool("pf_tree", "트리 요약 조회", { sessionId: z.string().min(1) }, async (a) => {
    try {
      return text(await client.pfTree(a.sessionId));
    } catch (e) {
      return errOf(e);
    }
  });

  server.tool("pf_lock", "노드 승인 잠금", { sessionId: z.string().min(1), nodeId: z.string().min(1) }, async (a) => {
    try {
      return text(await client.pfLock(a.sessionId, a.nodeId));
    } catch (e) {
      return errOf(e);
    }
  });

  server.tool(
    "pf_reopen",
    "노드 재오픈",
    { sessionId: z.string().min(1), nodeId: z.string().min(1), reason: z.string().min(1) },
    async (a) => {
      try {
        return text(await client.pfReopen(a.sessionId, a.nodeId, a.reason));
      } catch (e) {
        return errOf(e);
      }
    },
  );

  server.tool(
    "pf_finalize",
    "절차서 export (M5 예정)",
    { sessionId: z.string().min(1), format: z.string().optional() },
    async (a) => {
      void a;
      return text(toError("unimplemented", "pf_finalize는 M5에서 구현", "절차서 export는 M5 마일스톤"));
    },
  );

  server.tool(
    "pf_test",
    "테스트 러너 (M3 예정)",
    { sessionId: z.string().optional(), procedurePath: z.string().optional(), nodeId: z.string().optional(), mode: z.string().optional() },
    async (a) => {
      void a;
      return text(toError("unimplemented", "pf_test는 M3에서 구현", "runner는 M3 마일스톤"));
    },
  );

  return server;
}

export async function runStdio(deps: ServerDeps): Promise<void> {
  const server = buildServer(deps);
  await server.connect(new StdioServerTransport());
}
