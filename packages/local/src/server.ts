import { join } from "node:path";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { NodeIdSchema, SessionIdSchema, ConstraintSchema } from "@procforge/shared/schema.js";
import { errorCodeOf, pfError, type ErrorCode, type ProcForgeError } from "@procforge/shared/errors.js";
import { collectCatalog } from "./catalog.js";
import { logger } from "./logger.js";
import type { FileStore } from "./filestore.js";
import { OUTPUT_SCHEMAS, nodeSummary } from "./views.js";
import { runSession } from "./runner/index.js";
import { runProcedureTest } from "./runner/procedure-run.js";
import { finalizeSession } from "./procedure.js";
import { logEvent } from "./trace.js";
import { ProcForgeApp, PROMPT_TEXT, DEFAULT_SESSION_TTL_MS } from "./app/app.js";

export { PROMPT_TEXT, DEFAULT_SESSION_TTL_MS };

export type ServerDeps = {
  client: CoreClient;
  store: FileStore;
  procforgeDir: string;
  projectRoot: string;
  sessionTtlMs?: number;
  readOnly?: boolean;
  /** artifacts를 sandbox/<sid>/로 제한 (M2.6-5, 기본 on) */
  strictSandbox?: boolean;
  /** artifact 읽기 상한 바이트 (M2.6-6, 기본 5MB) */
  maxArtifactBytes?: number;
};

/** 도구 등록 순서 (결정적, 스냅샷 테스트 대상) */
export const TOOL_NAMES = [
  "pf_start",
  "pf_next",
  "pf_report",
  "pf_split",
  "pf_confirm_leaf",
  "pf_retry",
  "pf_ask_human",
  "pf_approve",
  "pf_advise",
  "pf_tree",
  "pf_get_node",
  "pf_lock",
  "pf_reopen",
  "pf_refresh_catalog",
  "pf_test",
  "pf_finalize",
] as const;

export const READ_ONLY_TOOLS = ["pf_next", "pf_tree", "pf_get_node"] as const;

function err(code: ErrorCode, message: string, hint?: string): ProcForgeError {
  return pfError(code, message, hint);
}

const HINTS: Record<string, string> = {
  bad_request: "입력을 고쳐 재호출하라.",
  bad_args: "등록된 인자만 사용하라. 오타·유사 키를 확인하고 pf_confirm_leaf 재호출.",
  conflict: "pf_tree로 현재 상태를 확인하고 상태에 맞는 도구를 호출하라.",
  not_found: "pf_tree로 id를 확인하라.",
  session_not_found: "pf_start로 새 세션을 시작하라.",
  unimplemented: "해당 마일스톤 구현 후 사용하라.",
  internal: "다시 시도하라. 계속되면 pf_tree로 상태를 확인하라.",
};

function errResult(e: unknown) {
  const rawCode = errorCodeOf(e);
  const code = rawCode === "not_found" && /session/i.test(e instanceof Error ? e.message : "") ? "session_not_found" : rawCode;
  const hint = (e as { hint?: string } | null)?.hint ?? HINTS[code] ?? HINTS["internal"];
  const message = code === "internal" ? "내부 오류가 발생했다." : e instanceof Error ? e.message : String(e);
  if (code === "internal") logger.error("internal", e instanceof Error ? (e.stack ?? e.message) : String(e));
  const body = { error: { code, message, hint: `${hint}`.trim() } };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${code}: ${message} (힌트: ${body.error.hint})` }],
    structuredContent: body,
  };
}

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

const READ_ONLY_ANN = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const ToolRefShape = z.object({ server: z.string().min(1), name: z.string().min(1) });
const CatalogEntryShape = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  schemaHash: z.string().min(1),
});
const PathHintShape = z.enum(["in", "out"]).optional();
const ArgSpecShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.unknown(), path: PathHintShape }),
  z.object({ kind: z.literal("var"), ref: z.string().min(1), path: PathHintShape }),
  z.object({
    kind: z.literal("generated"),
    instruction: z.string().min(1),
    inputs: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    path: PathHintShape,
  }),
]);

function requireFresh(deps: ServerDeps, sessionId: string) {
  const s = deps.store.getSession(sessionId);
  if (!s) throw err("session_not_found", `세션 없음: ${sessionId}`, HINTS["session_not_found"]);
  const ttl = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const last = deps.store.getLastUsed(sessionId);
  if (last === undefined) {
    deps.store.touch(sessionId);
    return s;
  }
  if (Date.now() - last > ttl) throw err("session_not_found", `세션 만료: ${sessionId}`, "pf_start로 새 세션을 시작하라.");
  return s;
}

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "procforge-local", version: "0.2.0" });
  const { client } = deps;
  const app = new ProcForgeApp({
    core: deps.client,
    store: deps.store,
    procforgeDir: deps.procforgeDir,
    projectRoot: deps.projectRoot,
    sessionTtlMs: deps.sessionTtlMs,
    strictSandbox: deps.strictSandbox,
    maxArtifactBytes: deps.maxArtifactBytes,
  });
  const enabled = (name: string) => !deps.readOnly || (READ_ONLY_TOOLS as readonly string[]).includes(name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const R = (name: string, config: any, cb: any) => {
    if (enabled(name)) server.registerTool(name, config, logged(name, cb) as never);
  };
  // 쓰기 도구는 세션 lockfile로 프로세스 간 보호 (M2.6-7)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const W = (name: string, config: any, cb: any) => {
    if (!enabled(name)) return;
    server.registerTool(name, config as never, (async (a: any, extra: any) => {
      const release = deps.store.acquireLock(a.sessionId);
      try {
        return await logged(name, cb)(a, extra);
      } finally {
        release();
      }
    }) as never);
  };
  // pf_* 호출 기록 (trace용, M3.5)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logged = (name: string, cb: any) => async (a: any, extra: any) => {
    const r = (await cb(a, extra)) as { isError?: boolean; structuredContent?: { sessionId?: string } };
    try {
      const sid = (a.sessionId as string | undefined) ?? r.structuredContent?.sessionId ?? "";
      if (sid) {
        logEvent(deps.procforgeDir, {
          at: new Date().toISOString(),
          tool: name,
          sessionId: sid,
          nodeId: a.nodeId as string | undefined,
          ok: !r.isError,
        });
      }
    } catch {
      // 추적 실패 무시
    }
    return r;
  };
  const strictSandbox = deps.strictSandbox ?? true;
  const maxArtifactBytes = deps.maxArtifactBytes ?? 5 * 1024 * 1024;

  R(
    "pf_start",
    {
      title: "세션 시작",
      description: [
        "새 분해 세션을 시작한다.",
        "선수 호출: 없음. 요청 1건당 세션 1개.",
        "request(필수, 예: \"9월 월간보고서\"), params(선택, 예: {\"month\":\"2026-09\"}),",
        "toolCatalog(선택, 생략 시 자동 수집), seedFiles(선택, sandbox에 복사할 참조 파일),",
        "limits(선택, 예: {\"maxDepth\":5,\"maxRetries\":2,\"maxNodes\":50}).",
        "세션·루트 노드·수행 지침 반환. 세션은 30일 미사용 시 만료. 다음: pf_next.",
      ].join("\n"),
      inputSchema: {
        request: z.string().min(1),
        params: z.record(z.string()).optional(),
        toolCatalog: z.array(CatalogEntryShape).optional(),
        seedFiles: z.array(z.string()).optional(),
        limits: z.object({ maxDepth: z.number().int().min(1), maxRetries: z.number().int().min(0), maxNodes: z.number().int().min(1) }).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_start"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.start(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_next",
    {
      title: "다음 노드 조회",
      description: [
        "처리할 노드 1개를 의존성 순서로 받는다.",
        "선수: pf_start. 매 단계마다 호출.",
        "인자: sessionId.",
        "노드 요약과 지침 반환. done=true면 종료. 다음: 실행 후 pf_report, 크면 pf_split.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema },
      outputSchema: OUTPUT_SCHEMAS["pf_next"] as never,
      annotations: READ_ONLY_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.next(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_report",
    {
      title: "실행 결과 보고",
      description: [
        "leaf 후보 실행 결과를 보고한다.",
        "선수: pf_next. 실행은 호스트가 자기 도구로 수행.",
        "tool/args/resultSummary/selfVerdict(판정)/selfReason(사유, 필수),",
        "artifacts(sandbox 상대경로, 선택, 5MB 상한), rubricReasons(사람 판단 항목 사유, 선택).",
        "통과해도 자동 확정 없음. 다음: pf_confirm_leaf 또는 pf_split.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        tool: ToolRefShape,
        args: z.record(z.unknown()),
        resultSummary: z.string(),
        resultJson: z.unknown().optional(),
        artifacts: z.array(z.string()).optional(),
        selfVerdict: z.enum(["pass", "fail"]),
        selfReason: z.string().min(1),
        rubricReasons: z.record(z.string()).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_report"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.report(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_split",
    {
      title: "노드 분해",
      description: [
        "노드를 하위 작업으로 나눈다.",
        "선수: pf_next. 도구 1회로 안 될 때.",
        "children(필수, 최소 1개, 예: [{\"goal\":\"슬라이드 목록 읽기\"}]).",
        "부모와 생성된 자식 반환. 다음: pf_next로 자식 처리.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        children: z.array(z.object({ goal: z.string().min(1), dependsOn: z.array(z.string()).optional(), sideEffect: z.enum(["none", "local_write", "external"]).optional() })).min(1),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_split"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.split(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_confirm_leaf",
    {
      title: "leaf 확정",
      description: [
        "통과한 시도를 leaf로 확정한다.",
        "선수: pf_report(verdict=pass).",
        "tool(마지막 실행과 동일), argSpecs(필수, 실행 인자 키 전체를 fixed/var/generated로 분류,",
        "예: {\"month\":{\"kind\":\"var\",\"ref\":\"${params.month}\"}}), ignore(선택, 비교 제외 JSON 경로).",
        "leaf 확정과 golden 기록 반환. 다음: pf_next.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        tool: ToolRefShape,
        argSpecs: z.record(ArgSpecShape),
        sideEffect: z.enum(["none", "local_write", "external"]).optional(),
        ignore: z.array(z.string()).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_confirm_leaf"],
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.confirmLeaf(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_retry",
    {
      title: "재시도",
      description: [
        "실패한 노드를 다시 시도한다.",
        "선수: pf_report(verdict=fail) 또는 needs_human.",
        "reason(필수, 재시도 사유, 기록용).",
        "probing 복귀 또는 한도 초과 시 needs_human. 다음: 실행 후 pf_report.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema, nodeId: NodeIdSchema, reason: z.string().min(1) },
      outputSchema: OUTPUT_SCHEMAS["pf_retry"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.retry(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_ask_human",
    {
      title: "사람에게 질문",
      description: [
        "사람 판단이 필요해 질문을 남긴다.",
        "선수: pf_next(외부 영향 노드) 또는 막힌 노드.",
        "question(필수, 사람에게 물을 내용), plan(선택, {tool,args} dry-run 계획, 승인 대상).",
        "needs_human 전환. 계획이 있으면 pf_approve 대기, 없으면 pf_advise 대기.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        question: z.string().min(1),
        plan: z.object({ tool: ToolRefShape, args: z.record(z.unknown()) }).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_ask_human"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.askHuman(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_approve",
    {
      title: "계획 승인",
      description: [
        "dry-run 계획을 승인하거나 거부한다.",
        "선수: pf_ask_human(계획 포함) 이후 needs_human.",
        "approved(필수), note(선택, 거부 사유·승인 메모).",
        "승인 시 확정 가능 상태(probing)로, 거부 시 open으로. 다음: 승인 후 pf_confirm_leaf.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        approved: z.boolean(),
        note: z.string().optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_approve"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        return ok(await app.approve(a));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  W(
    "pf_advise",
    {
      title: "조언 등록",
      description: [
        "사람 조언을 조건으로 등록한다.",
        "선수: needs_human 노드.",
        "text(필수, 예: \"매출은 세전 기준\"), proposedConstraints(선택, 호스트 제안 조건 배열).",
        "제안은 최신 fixture로 평가해 채택/거부. needs_human이면 open 복귀. 다음: pf_next.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        nodeId: NodeIdSchema,
        text: z.string().min(1),
        proposedConstraints: z.array(ConstraintSchema).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_advise"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        const s = requireFresh(deps, sid);
        const nid = a.nodeId as string;
        // 최신 attempt의 fixture 내용을 읽어 core 평가에 전달 (M4)
        let fixtureContents: Record<string, string> | undefined;
        const cur = deps.store.getNode(sid, nid);
        const lastFx = cur?.attempts[cur.attempts.length - 1]?.artifacts ?? [];
        if (lastFx.length > 0) {
          fixtureContents = {};
          for (const fx of lastFx) {
            try {
              fixtureContents[fx] = readFileSync(join(deps.procforgeDir, "sessions", sid, fx), "utf8").slice(0, 200000);
            } catch {
              // 읽기 실패 파일은 제외
            }
          }
        }
        const out = await client.pfAdvise(sid, nid, a.text as string, {
          proposedConstraints: a.proposedConstraints as unknown[] | undefined,
          fixtureContents,
        });
        deps.store.touch(sid);
        return ok({
          constraints: out.constraints.map((c) => ({ id: c.id, kind: c.kind, summary: `${c.kind}` })),
          rejected: out.rejected,
          ...(out.note ? { note: out.note } : {}),
          node: nodeSummary(out.node, s.limits),
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_tree",
    {
      title: "트리 조회",
      description: [
        "트리 요약을 조회한다.",
        "선수: pf_start 이후 언제든.",
        "detail(summary|full, 기본 summary), nodeId(서브트리, 선택), limit(기본 50), cursor(기본 0).",
        "목록·상태별 개수·hasMore 반환. 상세가 필요하면 pf_get_node.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema,
        detail: z.enum(["summary", "full"]).optional(),
        nodeId: NodeIdSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.number().int().min(0).optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_tree"] as never,
      annotations: READ_ONLY_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        requireFresh(deps, sid);
        const { nodes } = await client.pfTree(sid);
        deps.store.touch(sid);
        const detail = (a.detail as string | undefined) ?? "summary";
        const limit = (a.limit as number | undefined) ?? 50;
        const cursor = (a.cursor as number | undefined) ?? 0;
        const root = a.nodeId as string | undefined;
        let set = nodes;
        if (root) {
          const keep = new Set<string>([root]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const n of nodes) {
              if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) {
                keep.add(n.id);
                grew = true;
              }
            }
          }
          set = nodes.filter((n) => keep.has(n.id));
        }
        const counts: Record<string, number> = {};
        for (const n of set) counts[n.status] = (counts[n.status] ?? 0) + 1;
        const page = set.slice(cursor, cursor + limit);
        return ok({
          entries: page.map((n) => ({
            id: n.id,
            parentId: n.parentId,
            goal: detail === "full" ? n.goal : n.goal.slice(0, 80),
            status: n.status,
            ...(detail === "full" ? { node: n } : {}),
          })),
          counts,
          hasMore: cursor + limit < set.length,
          nextCursor: cursor + limit < set.length ? cursor + limit : null,
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_get_node",
    {
      title: "노드 상세 조회",
      description: [
        "단일 노드 전체를 조회한다.",
        "선수: pf_tree로 id 확인 후.",
        "nodeId 지정. 전체 attempts·조건 포함. 다음: 상태에 맞는 도구 호출.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema, nodeId: NodeIdSchema },
      outputSchema: OUTPUT_SCHEMAS["pf_get_node"] as never,
      annotations: READ_ONLY_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        requireFresh(deps, sid);
        const { nodes } = await client.pfTree(sid);
        deps.store.touch(sid);
        const n = nodes.find((x) => x.id === (a.nodeId as string));
        if (!n) throw err("not_found", `노드 없음: ${a.nodeId}`, "pf_tree로 id를 확인하라.");
        return ok({ node: n });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  W(
    "pf_lock",
    {
      title: "노드 잠금",
      description: [
        "노드를 승인 잠금한다.",
        "선수: leaf 확정 후.",
        "잠긴 노드와 그 조상은 재분해 금지. 다음: pf_next 계속 또는 pf_reopen.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema, nodeId: NodeIdSchema },
      outputSchema: OUTPUT_SCHEMAS["pf_lock"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        const s = requireFresh(deps, sid);
        const n = await client.pfLock(sid, a.nodeId as string);
        deps.store.touch(sid);
        return ok({ node: nodeSummary(n, s.limits) });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  W(
    "pf_reopen",
    {
      title: "노드 재오픈",
      description: [
        "잠금을 풀고 노드를 다시 연다.",
        "선수: pf_lock 이후, 사람 판단으로만.",
        "reason(필수). 다음: pf_next.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema, nodeId: NodeIdSchema, reason: z.string().min(1) },
      outputSchema: OUTPUT_SCHEMAS["pf_reopen"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        const s = requireFresh(deps, sid);
        const n = await client.pfReopen(sid, a.nodeId as string, a.reason as string);
        deps.store.touch(sid);
        return ok({ node: nodeSummary(n, s.limits) });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_refresh_catalog",
    {
      title: "카탈로그 갱신",
      description: [
        "도구 목록을 다시 수집한다.",
        "선수: mcp 서버 추가/변경 후.",
        "인자 없음. 캐시 무시하고 수집.",
        "서버·이름·해시 목록과 warnings 반환.",
      ].join("\n"),
      inputSchema: {},
      outputSchema: OUTPUT_SCHEMAS["pf_refresh_catalog"] as never,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const c = await collectCatalog(deps.projectRoot, { cacheDir: join(deps.procforgeDir, "cache"), refresh: true });
        return ok({
          entries: c.entries.map((e) => ({ server: e.server, name: e.name, schemaHash: e.schemaHash })),
          warnings: c.warnings,
          cached: c.cached,
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_test",
    {
      title: "절차서 테스트",
      description: [
        "확정 트리를 LLM 없이 재실행한다.",
        "선수: 전 노드 leaf 확정 후 (세션) 또는 finalize 산출물 (절차서).",
        "sessionId 또는 procedure(둘 중 하나, 예: 'monthly-2026-09'), nodeId(서브트리, 선택),",
        "mode(record|replay|passthrough|live, 기본 replay), params(절차서 재바인딩),",
        "updateGolden(선택), allowProjectRead(선택), junitPath(선택).",
        "요약과 report 경로 반환. 다음: 실패 노드는 pf_tree로 확인.",
      ].join("\n"),
      inputSchema: {
        sessionId: SessionIdSchema.optional(),
        procedure: z.string().optional(),
        params: z.record(z.string()).optional(),
        mode: z.enum(["record", "replay", "passthrough", "live"]).optional(),
        updateGolden: z.boolean().optional(),
        allowProjectRead: z.boolean().optional(),
        junitPath: z.string().optional(),
      },
      outputSchema: OUTPUT_SCHEMAS["pf_test"] as never,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a: any) => {
      try {
        const { writeFileSync } = await import("node:fs");
        if (a.procedure) {
          const { report, sessionId: imported } = await runProcedureTest(deps.procforgeDir, deps.projectRoot, a.procedure as string, {
            procforgeDir: deps.procforgeDir,
            projectRoot: deps.projectRoot,
            mode: (a.mode as "record" | "replay" | "passthrough" | "live" | undefined) ?? "replay",
            params: (a.params as Record<string, string> | undefined) ?? {},
            updateGolden: (a.updateGolden as boolean | undefined) ?? false,
            allowProjectRead: (a.allowProjectRead as boolean | undefined) ?? false,
          });
          if (a.junitPath) {
            const { toJUnit } = await import("./runner/index.js");
            writeFileSync(a.junitPath as string, toJUnit(report));
          }
          return ok({
            runId: report.runId,
            mode: report.mode,
            passed: report.summary.pass,
            failed: report.summary.fail,
            unverified: report.summary.unverified,
            skipped: report.summary.skipped,
            blocked: report.summary.blocked,
            reportPath: join(deps.procforgeDir, "runs", report.runId, "report.json"),
            sessionId: imported,
          });
        }
        if (!a.sessionId) throw err("bad_request", "sessionId 또는 procedure 중 하나가 필요하다.");
        const sid = a.sessionId as string;
        requireFresh(deps, sid);
        const report = await runSession({
          procforgeDir: deps.procforgeDir,
          projectRoot: deps.projectRoot,
          sessionId: sid,
          nodeId: a.nodeId as string | undefined,
          mode: (a.mode as "record" | "replay" | "passthrough" | "live" | undefined) ?? "replay",
          updateGolden: (a.updateGolden as boolean | undefined) ?? false,
          allowProjectRead: (a.allowProjectRead as boolean | undefined) ?? false,
        });
        deps.store.touch(sid);
        const reportPath = join(deps.procforgeDir, "runs", report.runId, "report.json");
        if (a.junitPath) {
          const { toJUnit } = await import("./runner/index.js");
          writeFileSync(a.junitPath as string, toJUnit(report));
        }
        return ok({
          runId: report.runId,
          mode: report.mode,
          passed: report.summary.pass,
          failed: report.summary.fail,
          unverified: report.summary.unverified,
          skipped: report.summary.skipped,
          blocked: report.summary.blocked,
          reportPath,
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );

  R(
    "pf_finalize",
    {
      title: "절차서 확정",
      description: [
        "확정 트리를 절차서로 export한다.",
        "선수: 전 노드 resolved(leaf 또는 완성 split) 후.",
        "sessionId(필수), name(필수, 소문자·숫자·하이픈 1~64자).",
        "force(선택, 기존 명령 파일 덮어쓰기).",
        "procedure.json·PROCEDURE.md·SKILL.md·tests·command 반환. 다음: pf_test로 검증.",
      ].join("\n"),
      inputSchema: { sessionId: SessionIdSchema, name: z.string().min(1), force: z.boolean().optional() },
      outputSchema: OUTPUT_SCHEMAS["pf_finalize"] as never,
      annotations: WRITE_ANN,
    },
    async (a: any) => {
      try {
        const sid = a.sessionId as string;
        requireFresh(deps, sid);
        const out = finalizeSession(deps.procforgeDir, sid, a.name as string, {
          projectRoot: deps.projectRoot,
          force: (a.force as boolean | undefined) ?? false,
        });
        deps.store.touch(sid);
        return ok(out as unknown as Record<string, unknown>);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.registerPrompt(
    "procforge_decompose",
    {
      title: "분해 루프 안내",
      description: "ProcForge 분해 루프 안내를 받는다. 세션 시작 전 1회.",
      argsSchema: { request: z.string().optional(), params: z.string().optional() },
    },
    async (args) => {
      const r = (args as { request?: string; params?: string } | undefined)?.request;
      return {
        messages: [
          { role: "user", content: { type: "text", text: r ? `${PROMPT_TEXT}\n\n요청: ${r}` : PROMPT_TEXT } },
        ],
      };
    },
  );

  return server;
}

export async function runStdio(deps: ServerDeps): Promise<void> {
  const server = buildServer(deps);
  await server.connect(new StdioServerTransport());
  logger.info("procforge-local started", { projectRoot: deps.projectRoot, readOnly: deps.readOnly ?? false });
}
