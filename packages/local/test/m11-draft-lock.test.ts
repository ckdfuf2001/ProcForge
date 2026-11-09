import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-draft-lock: 멀티프로세스 고아 오판 방지 (drafts/<id>.lock).
// 같은 pfdir의 App 2개로 검증한다 (서브프로세스 없음).
// ① A 진행 중 → B는 pending, 파일 불변.
// ② 잠금 stale → B가 failed로 기록.
// ③ A 종료 후 잠금 파일 0개.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let server: Server | null = null;
let baseUrl = "";
let hang = false;
const sseClients: ServerResponse[] = [];

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
    await readBody(req);
    if (req.url === "/config/providers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ default: { t: "m" }, providers: [{ id: "t", models: { m: {} } }] }));
      return;
    }
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseClients.push(res);
      try {
        res.write(`data: ${JSON.stringify({ id: "evt-0", type: "server.connected", properties: {} })}\n\n`);
      } catch {}
      req.on("close", () => {
        const i = sseClients.indexOf(res);
        if (i >= 0) sseClients.splice(i, 1);
      });
      return;
    }
    if (req.url === "/session" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses-dl" }));
      return;
    }
    if (req.url === "/session/ses-dl/prompt_async" && req.method === "POST") {
      res.writeHead(204);
      res.end();
      if (!hang) {
        setTimeout(() => {
          for (const r of [...sseClients]) {
            try {
              r.write(`data: ${JSON.stringify({ id: "evt-1", type: "session.idle", properties: { sessionID: "ses-dl" } })}\n\n`);
            } catch {}
          }
        }, 20);
      }
      return;
    }
    if (req.url === "/session/ses-dl/message") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: '{"ops":[]}' }] },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake 리슨 실패");
  return `http://127.0.0.1:${(addr as { port: number }).port}`;
}

let oldOpenCodeUrl: string | undefined;
let oldRedraftModel: string | undefined;

beforeEach(() => {
  root = makeTmp("pf-m11dl-");
  pfdir = join(root, ".procforge");
  const dir = join(pfdir, "procedures", "dl");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name: "dl", sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id: "1", parentId: null, goal: "g", depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
  }));
  hang = false;
  oldOpenCodeUrl = process.env.PROOF_OPENCODE_URL;
  oldRedraftModel = process.env.PROOF_REDRAFT_MODEL;
  delete process.env.PROOF_REDRAFT_MODEL;
});

afterEach(async () => {
  if (oldOpenCodeUrl === undefined) delete process.env.PROOF_OPENCODE_URL;
  else process.env.PROOF_OPENCODE_URL = oldOpenCodeUrl;
  if (oldRedraftModel === undefined) delete process.env.PROOF_REDRAFT_MODEL;
  else process.env.PROOF_REDRAFT_MODEL = oldRedraftModel;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    sseClients.length = 0;
  }
});

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

function lockFiles(): string[] {
  return readdirSync(join(pfdir, "drafts")).filter((f) => f.endsWith(".lock"));
}

describe("M11 draft lock (2 App, 동일 폴더)", () => {
  it("① A 진행 중이면 B는 pending, 파일 불변", async () => {
    baseUrl = await startFake();
    hang = true;
    process.env.PROOF_OPENCODE_URL = baseUrl;
    const a = newApp();
    const { draftId } = await a.requestRedraft({ procedure: "dl", request: "바꿔" });
    const b = newApp();
    const before = readFileSync(join(pfdir, "drafts", draftId, "draft.json"), "utf8");
    const got = await b.getDraft({ draftId });
    expect(got.status).toBe("pending");
    expect(readFileSync(join(pfdir, "drafts", draftId, "draft.json"), "utf8")).toBe(before);
    expect(lockFiles()).toHaveLength(1);
  }, 60000);

  it("② 잠금 stale이면 B가 failed로 기록", async () => {
    baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    const draftId = "stale-draft-1";
    const dir = join(pfdir, "drafts", draftId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "procedure.json"), "{}");
    writeFileSync(join(dir, "draft.json"), JSON.stringify({
      draftId, procedure: "dl", request: "x", sourceHash: "s", openCodeSessionId: null,
      model: { providerID: "t", modelID: "m", source: "default" },
      status: "pending", ops: [], diff: [], at: new Date(0).toISOString(),
    }));
    const lockPath = join(pfdir, "drafts", `${draftId}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: 1, token: "old", at: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, old, old);
    const b = newApp();
    const got = await b.getDraft({ draftId });
    expect(got.status).toBe("failed");
    const saved = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as { status: string };
    expect(saved.status).toBe("failed");
  }, 60000);

  it("③ A 종료 후 잠금 파일 0개", async () => {
    baseUrl = await startFake();
    hang = false;
    process.env.PROOF_OPENCODE_URL = baseUrl;
    const a = newApp();
    const { draftId } = await a.requestRedraft({ procedure: "dl", request: "바꿔" });
    for (let i = 0; i < 40; i++) {
      const d = await a.getDraft({ draftId });
      if (d.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const fin = await a.getDraft({ draftId });
    expect(fin.status).toBe("ready");
    expect(lockFiles()).toHaveLength(0);
  }, 60000);
});
