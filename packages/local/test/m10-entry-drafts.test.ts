import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-entry: POST /api/drafts 202 비동기 (가짜 OpenCode 서버).
// ① 202→ready+원본 무손상 ② tools 비활성 ③ URL 미설정 4xx+파일 없음
// ④ 토큰 없음 401 ⑤ session.error→failed+재시도 0회.

type FakeMode = { responseText: string } | { sessionError: string };

let fake: Server | null = null;
let fakeBase = "";
let mode: FakeMode = { responseText: '{"ops":[]}' };
let promptCount = 0;
let promptBodies: string[] = [];
let sseClients: ServerResponse[] = [];

function sendAll(payload: unknown): void {
  const line = `data: ${JSON.stringify({ id: "evt-1", type: (payload as { type: string }).type, properties: (payload as { properties: unknown }).properties })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      // 무시
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let t = "";
    req.on("data", (d) => {
      t += d;
    });
    req.on("end", () => resolve(t));
  });
}

async function startFake(): Promise<string> {
  sseClients = [];
  promptCount = 0;
  promptBodies = [];
  fake = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseClients.push(res);
      try {
        res.write(`data: ${JSON.stringify({ id: "evt-0", type: "server.connected", properties: {} })}\n\n`);
      } catch {
        // 무시
      }
      req.on("close", () => {
        sseClients = sseClients.filter((r) => r !== res);
      });
      return;
    }
    if (req.url === "/config/providers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ default: { t: "m" }, providers: {} }));
      return;
    }
    if (req.url === "/session" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses-test" }));
      return;
    }
    if (req.url === "/session/ses-test/prompt_async" && req.method === "POST") {
      promptCount += 1;
      promptBodies.push(body);
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        if ("sessionError" in mode) {
          sendAll({ type: "session.error", properties: { sessionID: "ses-test", error: { name: "X", message: mode.sessionError } } });
        } else {
          sendAll({ type: "session.status", properties: { sessionID: "ses-test", status: { type: "busy" } } });
          sendAll({ type: "session.idle", properties: { sessionID: "ses-test" } });
        }
      }, 20);
      return;
    }
    if (req.url === "/session/ses-test/message" && req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      if ("sessionError" in mode) {
        res.end(JSON.stringify([]));
      } else {
        res.end(JSON.stringify([
          { info: { role: "user" }, parts: [] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: (mode as { responseText: string }).responseText }] },
        ]));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", () => resolve()));
  const addr = fake.address();
  if (!addr || typeof addr === "string") throw new Error("fake listen 실패");
  fakeBase = `http://127.0.0.1:${addr.port}`;
  return fakeBase;
}

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;
let srv: UiServer;

function writeProcDoc(): string {
  const raw = JSON.stringify({
    format: "procforge-procedure",
    version: 1,
    name: "memo",
    sourceSession: "s",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: [],
    tree: { rootId: "1", nodes: [] },
    nodes: [{
      id: "1", parentId: null, goal: "분석 작업", depth: 0, children: [],
      dependsOn: [], sideEffect: "none", constraints: [],
    }],
  });
  mkdirSync(join(pfdir, "procedures", "memo"), { recursive: true });
  writeFileSync(join(pfdir, "procedures", "memo", "procedure.json"), raw);
  return raw;
}

function mkApp(withSignal: boolean): void {
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: root,
    ...(withSignal ? { signal: { baseUrl: fakeBase } } : {}),
  });
}

async function apiAuthed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${srv.url}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> ?? {}), "x-procforge-token": srv.token },
  });
}

async function waitDraft(draftId: string): Promise<{ status: string }> {
  for (let i = 0; i < 150; i++) {
    const r = await apiAuthed(`/api/drafts/${draftId}`);
    const d = (await r.json()) as { status: string };
    if (d.status !== "pending") return d;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  throw new Error("draft 대기 초과");
}

beforeEach(async () => {
  root = makeTmp("pf-m10entry-");
  pfdir = join(root, ".procforge");
  await startFake();
});

afterEach(async () => {
  await srv?.close().catch(() => {});
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = null;
});

async function startSrv(signal: boolean, readOnly = false): Promise<void> {
  mkApp(signal);
  srv = await createUiServer({
    app,
    staticDir: makeTmp("pf-m10entrye-"),
    ...(readOnly ? { readOnly: true as const } : {}),
  });
}

describe("M10-entry POST /api/drafts", () => {
  it("① 202→ready, 원본 hash 그대로", async () => {
    mode = { responseText: JSON.stringify({ ops: [{ op: "edit_goal", nodeId: "1", goal: "분석 작업 v2", reason: "다듬기" }] }) };
    await startSrv(true);
    const raw = writeProcDoc();
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    const r = await apiAuthed("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "memo", request: "합계 행 추가" }),
    });
    expect(r.status).toBe(202);
    const started = (await r.json()) as { draftId: string; status: string };
    expect(started.status).toBe("pending");
    const done = (await waitDraft(started.draftId)) as { status: string; ops: unknown[] };
    expect(done.status).toBe("ready");
    expect(done.ops.length).toBe(1);
    // 원본 무손상 (파일을 다시 읽어 hash 비교).
    const after = readFileSync(join(pfdir, "procedures", "memo", "procedure.json"), "utf8");
    expect(createHash("sha256").update(after, "utf8").digest("hex")).toBe(hash);
  }, 60000);

  it("② 가짜 서버가 받은 바디의 tools 비활성", async () => {
    mode = { responseText: JSON.stringify({ ops: [] }) };
    await startSrv(true);
    writeProcDoc();
    const r = await apiAuthed("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "memo", request: "req" }),
    });
    expect(r.status).toBe(202);
    const started = (await r.json()) as { draftId: string };
    await waitDraft(started.draftId);
    expect(promptCount).toBeGreaterThan(0);
    const sent = JSON.parse(promptBodies[promptBodies.length - 1]) as { tools?: unknown };
    expect(sent.tools).toEqual({ "*": false });
  }, 60000);

  it("③ URL 미설정이면 4xx, drafts/ 그대로", async () => {
    await startSrv(false);
    writeProcDoc();
    const before = existsSync(join(pfdir, "drafts")) ? readdirSync(join(pfdir, "drafts")).length : 0;
    const r = await apiAuthed("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "memo", request: "req" }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const after = existsSync(join(pfdir, "drafts")) ? readdirSync(join(pfdir, "drafts")).length : 0;
    expect(after).toBe(before);
  });

  it("④ 토큰이 없으면 거부", async () => {
    await startSrv(true);
    writeProcDoc();
    const r = await fetch(`${srv.url}/api/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "memo", request: "req" }),
    });
    expect(r.status).toBe(401);
  });

  it("⑤ session.error면 failed, 재시도 0회", async () => {
    mode = { sessionError: "boom" };
    await startSrv(true);
    writeProcDoc();
    const r = await apiAuthed("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "memo", request: "req" }),
    });
    expect(r.status).toBe(202);
    const started = (await r.json()) as { draftId: string };
    const done = await waitDraft(started.draftId);
    expect(done.status).toBe("failed");
    expect(promptCount).toBe(1);
  }, 60000);
});
