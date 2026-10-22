import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { createLocalStack } from "../dist/core-inprocess.js";
import { ProcForgeApp } from "../dist/app/app.js";
import { createUiServer } from "../dist/app/ui-server.js";
import { savePairing } from "../dist/services/pairings.js";

// M7-5-6: E2E 하네스 — 임시 저장소 + 가짜 OpenCode + UI 서버(실제 dist).
// 런타임은 **빌드 산출물(dist)** 을 쓴다 (pretest:e2e 가 먼저 빌드).

// M7-close-a: 실행(E2E) 시나리오는 실제 러너가 MCP 서버를 띄우므로
// 가짜 ppt MCP(test 픽스처)를 opencode.json 에 등록해 둔다.
const FAKE_MCP = fileURLToPath(
  new URL("../test/fixtures/fake-ppt-mcp/server.mjs", import.meta.url),
);

export const CATALOG = [
  {
    server: "fake-ppt",
    name: "echo",
    inputSchema: { type: "object" },
    schemaHash: "h",
  },
];
export const TOOL = { server: "fake-ppt", name: "echo" };

export type FakeMode = "ok" | "plan" | "unknown-version";

type Part = Record<string, unknown>;

export type FakeOpenCode = {
  baseUrl: string;
  requests: string[];
  /** POST /session/:id/message 본문들 */
  sent: unknown[];
  close: () => Promise<void>;
};

/** M7-0.1 / M7-1.1 실측형 가짜 서버. /event 는 404 → 폴링 폴백. */
export async function startFakeOpenCode(mode: FakeMode): Promise<FakeOpenCode> {
  const parts = new Map<string, Part[]>();
  const requests: string[] = [];
  const sent: unknown[] = [];
  const push = (sid: string, p: Part) => {
    parts.set(sid, [...(parts.get(sid) ?? []), p]);
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    await new Promise<void>((r) => req.on("end", () => r()));
    requests.push(`${req.method} ${url.pathname}`);
    const send = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method === "GET" && url.pathname === "/version") {
      send(200, {
        version: mode === "unknown-version" ? "9.9.9" : "1.18.18",
      });
      return;
    }
    const mMsg = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (mMsg && req.method === "POST") {
      let parsed: { parts?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        send(400, { error: "bad body" });
        return;
      }
      if (!Array.isArray(parsed.parts)) {
        send(400, { error: "parts required" });
        return;
      }
      sent.push(parsed);
      const sid = mMsg[1];
      // 실서버는 비동기. 폴링이 잡도록 약간 뒤에 붙인다.
      setTimeout(() => {
        if (mode === "plan") {
          push(sid, { type: "text", text: "검토했습니다." });
          return;
        }
        push(sid, {
          type: "tool",
          tool: "procforge_pf_report",
          part: { sessionID: sid, tool: "procforge_pf_report" },
          state: { status: "completed", output: "{}" },
        });
      }, 30);
      send(200, { data: { admittedSeq: 1 } });
      return;
    }
    if (mMsg && req.method === "GET") {
      send(200, { data: parts.get(mMsg[1]) ?? [] });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/tui/")) {
      send(200, true);
      return;
    }
    // SSE 는 쓰지 않는다 → 빠르게 폴링 폴백.
    send(404, { error: "nope" });
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  return {
    baseUrl,
    requests,
    sent,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export type Harness = {
  root: string;
  pfdir: string;
  app: ProcForgeApp;
  fake: FakeOpenCode;
  ui: { url: string; token: string; close: () => Promise<void> };
  close: () => Promise<void>;
};

export async function setup(opts: { fakeMode?: FakeMode } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "pf-e2e-"));
  const pfdir = join(root, ".procforge");
  mkdirSync(pfdir, { recursive: true });
  // 러너가 MCP 도구를 실제로 실행할 수 있게 가짜 ppt 서버를 등록한다.
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", FAKE_MCP] } } }),
    "utf8",
  );
  const fake = await startFakeOpenCode(opts.fakeMode ?? "ok");
  const { client } = createLocalStack(pfdir);
  const app = new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
    signal: { baseUrl: fake.baseUrl, mode: "b", timeoutMs: 2500 },
  });
  const ui = await createUiServer({ app, pollMs: 40, heartbeatMs: 5000 });
  return {
    root,
    pfdir,
    app,
    fake,
    ui,
    close: async () => {
      await ui.close();
      await fake.close();
    },
  };
}

/** 1 → 1.1, 1.2 두 leaf 세션을 만든다 (모델 실행 없이 core 로만). */
export async function seedTwoLeaves(
  h: Harness,
  opts: { request?: string; params?: Record<string, string>; dep12?: boolean } = {},
): Promise<string> {
  const s = await h.app.start({
    request: opts.request ?? "월간보고서 만들어줘",
    toolCatalog: CATALOG as never,
    params: opts.params ?? { month: "2026-10" },
  });
  const sid = s.sessionId;
  await h.app.split({
    sessionId: sid,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [
      { goal: "데이터 수집" },
      { goal: "보고서 작성", ...(opts.dep12 ? { dependsOn: ["1.1"] } : {}) },
    ],
    expectedRevision: 0,
  });
  for (const nid of ["1.1", "1.2"]) {
    await h.app.report({
      sessionId: sid,
      nodeId: nid,
      tool: TOOL,
      args: { note: "hi" },
      resultSummary: "ok",
      resultJson: { note: "hi" },
      selfVerdict: "pass",
      selfReason: "ok",
    });
    await h.app.confirmLeaf({
      sessionId: sid,
      nodeId: nid,
      tool: TOOL,
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
  }
  return sid;
}

/** 모델이 재보고한 상황을 core 로 재현 (MCP pf_report/confirm_leaf 대응). */
export async function simulateReport(
  h: Harness,
  sid: string,
  nid: string,
  args: Record<string, unknown>,
): Promise<void> {
  const n = await h.app.core.getNode(sid, nid);
  const rubricReasons = Object.fromEntries(
    n.constraints
      .filter((c) => c.kind === "llm_rubric")
      .map((c) => [c.id, "확인됨"]),
  );
  await h.app.report({
    sessionId: sid,
    nodeId: nid,
    tool: TOOL,
    args,
    resultSummary: "ok",
    resultJson: args,
    selfVerdict: "pass",
    selfReason: "ok",
    ...(Object.keys(rubricReasons).length > 0 ? { rubricReasons } : {}),
  } as never);
  await h.app.confirmLeaf({
    sessionId: sid,
    nodeId: nid,
    tool: TOOL,
    argSpecs: Object.fromEntries(
      Object.entries(args).map(([k, v]) => [
        k,
        { kind: "fixed", value: String(v) },
      ]),
    ) as never,
  });
}

export function pair(h: Harness, ocSid: string, sid: string): void {
  savePairing(h.pfdir, ocSid, sid);
}

/**
 * M7-close-a: external(승인 필요) leaf 하나짜리 절차서. uiRun 하면 runner 가
 * 승인 대기(suspended/waiting)에서 멈춘다 — UI 승인 흐름용.
 */
export async function seedExternalProcedure(
  h: Harness,
  name = "ext-proc",
): Promise<string> {
  const s = await h.app.start({ request: "ext", toolCatalog: CATALOG as never });
  const sid = s.sessionId;
  await h.app.split({
    sessionId: sid,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "x" }],
    expectedRevision: 0,
  });
  await h.app.report({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    args: { note: "hi" },
    resultSummary: "ok",
    resultJson: { note: "hi" },
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await h.app.confirmLeaf({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    sideEffect: "external",
  });
  await h.app.finalize({ sessionId: sid, name });
  return name;
}

/**
 * M7-close-a: 취소를 관찰할 수 있게 오래 도는 python 스크립트 leaf 절차서.
 */
export async function seedSlowProcedure(
  h: Harness,
  name = "slow-proc",
): Promise<string> {
  const script = ["import time", "time.sleep(120)"].join("\n");
  const s = await h.app.start({ request: "run", toolCatalog: CATALOG as never });
  const sid = s.sessionId;
  await h.app.split({
    sessionId: sid,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "run script" }],
    expectedRevision: 0,
  });
  // M7-close-c: finalize 의 collectScripts 는 **projectRoot 아래** 스크립트만 읽어
  // procedures/<name>/scripts/ 로 복사하고, 실행은 그 절차서 사본을 쓴다.
  // 즉 실제 해석 경로는 여기 한 곳뿐이다 — 다른 경로에도 써 두면 경로 버그를 가린다.
  writeFileSync(join(h.root, "slow.py"), script, "utf8");
  await h.app.report({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    args: {},
    resultSummary: "ok",
    selfVerdict: "pass",
    selfReason: "ok",
  });
  await h.app.confirmLeaf({
    sessionId: sid,
    nodeId: "1.1",
    tool: TOOL,
    argSpecs: {
      script: { kind: "script", file: "slow.py", runtime: "python" },
    } as never,
  });
  await h.app.finalize({ sessionId: sid, name });
  return name;
}

export const OC_SID = "ses-h";
