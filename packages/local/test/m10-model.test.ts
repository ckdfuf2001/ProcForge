import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { runRedraft } from "../src/services/redraft.js";
import { fakeProvidersBody } from "./fake-providers.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-model: PROOF_REDRAFT_MODEL (형식 providerID/modelID, 대체 이름 없음).
// 가짜 OpenCode 서버 — 네트워크 0 (127.0.0.1 루프백만).

const DOC = {
  format: "procforge-procedure",
  version: 1,
  name: "m10-md",
  sourceSession: "test",
  createdAt: new Date(0).toISOString(),
  params: {},
  toolCatalog: [],
  nodes: [
    {
      id: "1", parentId: null, goal: "밤 집계", depth: 0,
      dependsOn: [], children: [], sideEffect: "none", constraints: [],
    },
  ],
};

type FakeMode = { responseText: string; hang?: boolean; providersStatus?: number };

let server: Server | null = null;
let baseUrl = "";
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
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (req.url === "/config/providers") {
      if (mode.providersStatus !== undefined && mode.providersStatus !== 200) {
        res.writeHead(mode.providersStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "down" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fakeProvidersBody()));
      return;
    }
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
      if (!mode.hang) {
        setTimeout(() => {
          sendAll({ type: "session.status", properties: { sessionID: "ses-test", status: { type: "busy" } } });
          sendAll({ type: "session.idle", properties: { sessionID: "ses-test" } });
        }, 20);
      }
      return;
    }
    if (req.url === "/session/ses-test/message" && (!req.method || req.method === "GET")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: mode.responseText }] },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake 서버 리슨 실패");
  return `http://127.0.0.1:${addr.port}`;
}

let root: string;
let pfdir: string;
let oldOpenCodeUrl: string | undefined;
let oldRedraftModel: string | undefined;

beforeEach(() => {
  root = makeTmp("pf-m10mdl-");
  pfdir = join(root, ".procforge");
  const dir = join(pfdir, "procedures", "m10-md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "procedure.json"), JSON.stringify(DOC, null, 2));
  promptCount = 0;
  promptBodies = [];
  mode = { responseText: '{"ops":[]}' };
  oldOpenCodeUrl = process.env.PROOF_OPENCODE_URL;
  oldRedraftModel = process.env.PROOF_REDRAFT_MODEL;
});

afterEach(async () => {
  if (oldOpenCodeUrl === undefined) delete process.env.PROOF_OPENCODE_URL;
  else process.env.PROOF_OPENCODE_URL = oldOpenCodeUrl;
  if (oldRedraftModel === undefined) delete process.env.PROOF_REDRAFT_MODEL;
  else process.env.PROOF_REDRAFT_MODEL = oldRedraftModel;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    sseClients = [];
  }
});

function makeApp(): ProcForgeApp {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

function draftsCount(): number {
  try {
    return readdirSync(join(pfdir, "drafts")).length;
  } catch {
    return 0;
  }
}

describe("M10-model PROOF_REDRAFT_MODEL (가짜 OpenCode)", () => {
  it("① env 지정이면 prompt_async 본문 model이 일치한다", async () => {
    baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    process.env.PROOF_REDRAFT_MODEL = "t/m";
    const app = makeApp();
    const r = await app.createRedraft({ procedure: "m10-md", request: "표에 합계 행 추가" });
    expect(r.status).toBe("ready");
    expect(promptCount).toBe(1);
    expect(JSON.parse(promptBodies[0]).model).toEqual({ providerID: "t", modelID: "m" });
    expect(r.model).toEqual({ providerID: "t", modelID: "m", source: "env" });
  }, 60000);

  it("② 없는 모델이면 bad_request, prompt_async 0회, drafts/ 증가 없음", async () => {
    baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    process.env.PROOF_REDRAFT_MODEL = "t/nope";
    const app = makeApp();
    const before = draftsCount();
    let code = "";
    let message = "";
    try {
      await app.createRedraft({ procedure: "m10-md", request: "표에 합계 행 추가" });
    } catch (e) {
      code = String((e as { code?: unknown }).code ?? e);
      message = e instanceof Error ? e.message : String(e);
    }
    expect(code).toBe("bad_request");
    expect(message).toContain("모델 없음: t/nope (PROOF_REDRAFT_MODEL)");
    expect(promptCount).toBe(0);
    expect(draftsCount()).toBe(before);
  }, 60000);

  it("③ env 없으면 draft.json model.source가 default이고 첫 default와 같다", async () => {
    baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    delete process.env.PROOF_REDRAFT_MODEL;
    const app = makeApp();
    const r = await app.createRedraft({ procedure: "m10-md", request: "표에 합계 행 추가" });
    expect(r.status).toBe("ready");
    expect(r.model.source).toBe("default");
    expect(`${r.model.providerID}/${r.model.modelID}`).toBe("t/m");
    const saved = JSON.parse(readFileSync(join(pfdir, "drafts", r.draftId, "draft.json"), "utf8")) as typeof r;
    expect(saved.model).toEqual(r.model);
  }, 60000);

  it("④ idle 실패면 reason에 모델 id와 지정 권장이 든다", async () => {
    baseUrl = await startFake();
    mode = { responseText: '{"ops":[]}', hang: true };
    const r = await runRedraft({
      procforgeDir: pfdir,
      procedure: "m10-md",
      request: "표에 합계 행 추가",
      openCode: { baseUrl, model: { providerID: "t", modelID: "m" }, source: "default" },
      idleTimeoutMs: 300,
    });
    expect(r.status).toBe("failed");
    expect(r.reason ?? "").toContain("model=t/m");
    expect(r.reason ?? "").toContain("지정 권장");
  }, 60000);

  it("⑤ 형식 오류 기동 (자식 CLI, stderr 변수명, exit≠0)", async () => {
    const cli = resolve(__dirname, "..", "dist", "cli.js");
    const r = spawnSync(process.execPath, [cli, "ui"], {
      env: { ...process.env, PROOF_REDRAFT_MODEL: "badvalue" },
      encoding: "utf8",
      timeout: 60000,
    });
    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain("PROOF_REDRAFT_MODEL");
  }, 120000);

  it("⑥ POST /api/drafts: 없는 모델이면 400, prompt_async 0회, drafts/ 그대로", async () => {
    baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    process.env.PROOF_REDRAFT_MODEL = "t/nope";
    const app = makeApp();
    const srv: UiServer = await createUiServer({ app, staticDir: makeTmp("pf-m10mdl-ui-") });
    try {
      const before = draftsCount();
      const r = await fetch(`${srv.url}/api/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({ procedure: "m10-md", request: "표에 합계 행 추가" }),
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).toContain("모델 없음: t/nope (PROOF_REDRAFT_MODEL)");
      expect(promptCount).toBe(0);
      expect(draftsCount()).toBe(before);
    } finally {
      await srv.close();
    }
  }, 60000);

  it("⑦ providers 500이면 조회 실패 문구 (모델 없음 아님)", async () => {
    baseUrl = await startFake();
    mode.providersStatus = 500;
    process.env.PROOF_OPENCODE_URL = baseUrl;
    process.env.PROOF_REDRAFT_MODEL = "t/m";
    const app = makeApp();
    let message = "";
    try {
      await app.createRedraft({ procedure: "m10-md", request: "표에 합계 행 추가" });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("조회 실패");
    expect(message).not.toContain("모델 없음");
  }, 60000);
});
