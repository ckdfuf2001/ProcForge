import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { OUTPUT_SCHEMAS } from "../src/views.js";
import { testStack } from "./client-mode.js";

// M8-1-close2 a: advice(id·revision 포함) 있는 노드를 돌려주는 모든 도구가
// MCP 출력 스키마(-32602)를 통과하는지 실제 SDK Client로 확인한다.
// (기존 전체 플로우는 advice 없이 돌려서 이 결함을 못 잡았다.)

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m8c2-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m8c2home-"));
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
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "m8-close2", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  return { mcp, close: async () => { await mcp.close(); await server.close(); } };
}

/**
 * 발행 JSON 스키마는 모든 object에 additionalProperties:false를 붙인다
 * (zz-probe 확인). SDK Client는 관대하지만 실서버 상대(OpenCode)는 엄격해서
 * -32602가 났다. 여기서 엄격 판정으로 재현한다.
 */
function deepStrict<T extends z.ZodTypeAny>(s: T): T {
  if (!s || typeof (s as unknown as { _def?: unknown })._def !== "object") return s;
  const anyS = s as unknown as {
    _def: { typeName: string; options?: z.ZodTypeAny[]; innerType?: z.ZodTypeAny; valueType?: z.ZodTypeAny };
    shape?: Record<string, z.ZodTypeAny>;
    element?: z.ZodTypeAny;
    unwrap?: () => z.ZodTypeAny;
  };
  switch (anyS._def.typeName) {
    case "ZodObject": {
      const shape = Object.fromEntries(
        Object.entries(anyS.shape ?? {}).map(([k, v]) => [k, deepStrict(v)]),
      );
      return z.object(shape).strict() as unknown as T;
    }
    case "ZodArray":
      return (anyS.element ? z.array(deepStrict(anyS.element)) : s) as unknown as T;
    case "ZodOptional":
    case "ZodDefault": {
      const inner = (anyS as { innerType?: z.ZodTypeAny }).innerType ?? (anyS.unwrap ? anyS.unwrap() : undefined);
      return (inner ? deepStrict(inner).optional() : s) as unknown as T;
    }
    case "ZodNullable": {
      const inner = (anyS as { innerType?: z.ZodTypeAny }).innerType ?? (anyS.unwrap ? anyS.unwrap() : undefined);
      return (inner ? deepStrict(inner).nullable() : s) as unknown as T;
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = anyS.options as z.ZodTypeAny[] | undefined;
      if (!options) return s;
      return z.union(
        options.map((o) => deepStrict(o)) as [z.ZodTypeAny, ...z.ZodTypeAny[]],
      ) as unknown as T;
    }
    case "ZodRecord": {
      const valueType = (anyS as { valueType?: z.ZodTypeAny }).valueType;
      return (valueType ? z.record(deepStrict(valueType)) : s) as unknown as T;
    }
    default:
      return s;
  }
}

function makeCall(mcp: Client, done: string[]) {
  return async (name: string, args: Record<string, unknown>) => {
    let r: Awaited<ReturnType<Client["callTool"]>>;
    try {
      r = await mcp.callTool({ name, arguments: args });
    } catch (e) {
      expect(false, `${name} threw: ${e instanceof Error ? e.message : String(e)}`).toBe(true);
      throw e;
    }
    if (r.isError) {
      const t = (r.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(false, `${name} should succeed, got: ${t.slice(0, 300)}`).toBe(true);
    }
    // 엄격 클라이언트 재현: 여분 키가 있으면 여기서 실패한다 (실측 -32602).
    const strictParsed = deepStrict(
      OUTPUT_SCHEMAS[name] as z.ZodTypeAny,
    ).safeParse((r as { structuredContent?: unknown }).structuredContent);
    expect(
      strictParsed.success,
      `${name} strict outputSchema (extra keys?): ${strictParsed.success ? "" : String((strictParsed as { error?: unknown }).error).slice(0, 400)}`,
    ).toBe(true);
    const schema = OUTPUT_SCHEMAS[name] as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema, `${name} schema`).toBeTruthy();
    const parsed = schema.safeParse(
      (r as { structuredContent?: unknown }).structuredContent,
    );
    expect(parsed.success, `${name} outputSchema`).toBe(true);
    done.push(name);
    return (r as { structuredContent: Record<string, unknown> }).structuredContent;
  };
}

const READ = { server: "opencode", name: "read" };

describe("M8-1-close2 a: advice-bearing node output contract", () => {
  it("advice 반환 전 도구 호출 오류 0 (실측 -32602 재현)", async () => {
    const { mcp, close } = await linked();
    try {
      const done: string[] = [];
      const call = makeCall(mcp, done);
      const started = await call("pf_start", { request: "M8-1-close2 advice 계약" });
      const sid = started["sessionId"] as string;
      await call("pf_split", {
        sessionId: sid,
        nodeId: "1",
        reason: "M8-1-close2 분해 사유입니다.",
        children: [{ goal: "첫째" }, { goal: "둘째" }],
      });
      await call("pf_advise", { sessionId: sid, nodeId: "1.1", text: "상위 30개로 제한" });
      await call("pf_advise", { sessionId: sid, nodeId: "1.2", text: "출처 URL 기록" });
      const nxt = await call("pf_next", { sessionId: sid });
      const nid = (nxt["node"] as { id: string }).id;
      // 조언 "30개"는 count 제약(items exact 30)이 되므로 resultJson을 맞춘다.
      await call("pf_report", {
        sessionId: sid,
        nodeId: nid,
        tool: READ,
        args: { path: "x" },
        resultJson: { items: Array.from({ length: 30 }, (_, i) => i) },
        resultSummary: "ok",
        selfVerdict: "pass",
        selfReason: "ok",
      });
      // 실측에서 -32602가 난 자리 (advice 1건 있는 노드 확정).
      await call("pf_confirm_leaf", {
        sessionId: sid,
        nodeId: nid,
        tool: READ,
        argSpecs: { path: { kind: "fixed", value: "x" } },
      });
      await call("pf_lock", { sessionId: sid, nodeId: nid });
      await call("pf_reopen", { sessionId: sid, nodeId: nid, reason: "test" });
      await call("pf_ask_human", {
        sessionId: sid,
        nodeId: nid,
        question: "go?",
        plan: { tool: READ, args: { path: "x" } },
      });
      await call("pf_approve", { sessionId: sid, nodeId: nid, approved: true });
      await call("pf_edit_node", { sessionId: sid, nodeId: "1.2", goal: "둘째 고침" });
      await call("pf_split", {
        sessionId: sid,
        nodeId: "1.2",
        reason: "M8-1-close2 추가 분해 사유입니다.",
        children: [{ goal: "셋째" }],
      });
      await call("pf_edit_args", {
        sessionId: sid,
        nodeId: nid,
        patch: { set: { path: { kind: "fixed", value: "y" } } },
      });
      await call("pf_retry", { sessionId: sid, nodeId: "1.2.1", reason: "test" });
      await call("pf_tree", { sessionId: sid });
      await call("pf_get_node", { sessionId: sid, nodeId: nid });
      await call("pf_test", { sessionId: sid, mode: "replay" });
      await call("pf_refresh_catalog", {});
      expect(done).toEqual([
        "pf_start",
        "pf_split",
        "pf_advise",
        "pf_advise",
        "pf_next",
        "pf_report",
        "pf_confirm_leaf",
        "pf_lock",
        "pf_reopen",
        "pf_ask_human",
        "pf_approve",
        "pf_edit_node",
        "pf_split",
        "pf_edit_args",
        "pf_retry",
        "pf_tree",
        "pf_get_node",
        "pf_test",
        "pf_refresh_catalog",
      ]);
    } finally {
      await close();
    }
  }, 120000);
});
