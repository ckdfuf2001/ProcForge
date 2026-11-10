import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { readRunState } from "../src/services/run-state.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M9-3-1: 사실 기록 events.ndjson 쓰기 (3 kind + 쓰기 실패 불변).
// testStack 사용 → inprocess/loopback/remote 3모드에서 동일 검증.
// ① live run 1회 후 run_end 1줄, 필드 6개.
// ② replay run 후 mode 값 확인.
// ③ approve 2회 후 approve 2줄.
// ④ applyDraft로 리셋 발생 시 approval_reset 1줄.
// ⑤ events 경로를 디렉터리로 막아 쓰기 실패를 만들어도 run status와 report.json 그대로.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;

function writeProc(name: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id: "1", parentId: null, goal: "g", depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
  }));
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

function eventsLines(name: string): Record<string, unknown>[] {
  const p = join(pfdir, "runs", "by-procedure", name, "events.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitDone(app: ProcForgeApp, runId: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    const info = await app.uiRunInfo({ runId });
    last = info.status;
    if (last === "done" || last === "failed" || last === "cancelled") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

// ④용 최소 fake OpenCode (m11-draft-lock 패턴).
let server: Server | null = null;
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
      res.end(JSON.stringify({ id: "ses-ev" }));
      return;
    }
    if (req.url === "/session/ses-ev/prompt_async" && req.method === "POST") {
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        for (const r of [...sseClients]) {
          try {
            r.write(`data: ${JSON.stringify({ id: "evt-1", type: "session.idle", properties: { sessionID: "ses-ev" } })}\n\n`);
          } catch {}
        }
      }, 20);
      return;
    }
    if (req.url === "/session/ses-ev/message") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: '{"ops":[{"op":"edit_goal","nodeId":"1","goal":"바꾼 목표","reason":"교훈 반영"}]}' }] },
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
  root = makeTmp("pf-m93ev-");
  pfdir = join(root, ".procforge");
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

describe("M9-3-1 events 쓰기", () => {
  it("① live run 1회 후 run_end 1줄, 필드 6개", async () => {
    writeProc("ev1");
    const app = newApp();
    await app.approveProcedureNode({ procedure: "ev1", nodeId: "1", allowWildcard: [] });
    const started = await app.uiRun({ procedure: "ev1", params: {} });
    expect(await waitDone(app, started.runId)).toBe("done");
    const runs = eventsLines("ev1").filter((l) => l.kind === "run_end");
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0]).sort()).toEqual(
      ["kind", "mode", "nodes", "procedure", "runId", "status", "ts", "v"].sort(),
    );
    expect(runs[0].mode).toBe("live");
    expect(runs[0].status).toBe("done");
    expect(runs[0].procedure).toBe("ev1");
    const nodes = runs[0].nodes as { nodeId: string; status: string; durationMs: unknown }[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeId).toBe("1");
    expect(nodes[0].status).toBe("pass");
    expect(typeof nodes[0].durationMs).toBe("number");
  }, 120000);

  it("② replay run 후 mode 값 확인", async () => {
    writeProc("ev2");
    const { report } = await runProcedureTest(pfdir, root, "ev2", {});
    expect(report.mode).toBe("replay");
    const runs = eventsLines("ev2").filter((l) => l.kind === "run_end");
    expect(runs).toHaveLength(1);
    expect(runs[0].mode).toBe("replay");
  }, 120000);

  it("③ approve 2회 후 approve 2줄", async () => {
    writeProc("ev3");
    const app = newApp();
    await app.approveProcedureNode({ procedure: "ev3", nodeId: "1", allowWildcard: [] });
    await app.approveProcedureNode({ procedure: "ev3", nodeId: "1", allowWildcard: [] });
    const lines = eventsLines("ev3").filter((l) => l.kind === "approve");
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.nodeId).toBe("1");
      expect(typeof l.hash12).toBe("string");
      expect((l.hash12 as string)).toHaveLength(12);
    }
  }, 120000);

  it("④ applyDraft로 리셋 발생 시 approval_reset 1줄", async () => {
    writeProc("ev4");
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    const app = newApp();
    await app.approveProcedureNode({ procedure: "ev4", nodeId: "1", allowWildcard: [] });
    const { draftId } = await app.requestRedraft({ procedure: "ev4", request: "바꿔" });
    for (let i = 0; i < 40; i++) {
      const d = await app.getDraft({ draftId });
      if (d.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect((await app.getDraft({ draftId })).status).toBe("ready");
    const applied = await app.applyDraft({ draftId, opIds: [0] });
    expect(applied.approvalReset).toEqual(["1"]);
    const lines = eventsLines("ev4").filter((l) => l.kind === "approval_reset");
    expect(lines).toHaveLength(1);
    expect(lines[0].nodeIds).toEqual(["1"]);
    expect(lines[0].cause).toBe("apply");
  }, 120000);

  it("⑤ events 경로를 디렉터리로 막아도 run status와 report.json 그대로", async () => {
    writeProc("ev5");
    const app = newApp();
    await app.approveProcedureNode({ procedure: "ev5", nodeId: "1", allowWildcard: [] });
    // 쓰기 경로를 디렉터리로 막는다 (append 실패 유도).
    // approve가 파일을 먼저 만들므로 지운 뒤 디렉터리로 막는다.
    const blockPath = join(pfdir, "runs", "by-procedure", "ev5", "events.ndjson");
    rmSync(blockPath, { force: true });
    mkdirSync(blockPath, { recursive: true });
    const started = await app.uiRun({ procedure: "ev5", params: {} });
    expect(await waitDone(app, started.runId)).toBe("done");
    expect(readRunState(pfdir, started.runId)?.status).toBe("done");
    expect(existsSync(join(pfdir, "runs", started.runId, "report.json"))).toBe(true);
  }, 120000);
});
