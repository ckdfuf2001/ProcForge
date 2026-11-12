import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-1: 재분석 프롬프트에 수기 교훈 포함 (testStack 사용 → 3모드).
// ① lessons가 있으면 prompt_async 본문에 구획과 그 줄이 들어간다.
// ② lessons가 없으면 본문에 `참고 교훈` 문자열이 0건이다.
// ③ 자동 구획 줄은 들어가지 않는다.
// ④ draft.json의 lessonsUsed가 실제 줄 수와 같다.
// ⑤ 교훈을 넣어 한도를 넘기면 줄을 빼서 맞추고, lessonsUsed가 실제 넣은 줄 수와 같다.
// ⑥ 교훈이 있어도 없어도 원본 procedure.json의 hash와 approvals.json 바이트가 변하지 않는다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let server: Server | null = null;
let promptBody = "";
const sseClients: ServerResponse[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let t = "";
    req.on("data", (d) => { t += d; });
    req.on("end", () => resolve(t));
  });
}

async function startFake(): Promise<string> {
  promptBody = "";
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (req.url === "/config/providers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ default: { t: "m" }, providers: [{ id: "t", models: { m: {} } }] }));
      return;
    }
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseClients.push(res);
      try { res.write(`data: ${JSON.stringify({ id: "e0", type: "server.connected", properties: {} })}\n\n`); } catch {}
      req.on("close", () => { const i = sseClients.indexOf(res); if (i >= 0) sseClients.splice(i, 1); });
      return;
    }
    if (req.url === "/session" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses-lp" }));
      return;
    }
    if (req.url === "/session/ses-lp/prompt_async" && req.method === "POST") {
      promptBody = body;
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        for (const r of [...sseClients]) {
          try { r.write(`data: ${JSON.stringify({ id: "e1", type: "session.idle", properties: { sessionID: "ses-lp" } })}\n\n`); } catch {}
        }
      }, 20);
      return;
    }
    if (req.url === "/session/ses-lp/message") {
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

let oldUrl: string | undefined;
let oldModel: string | undefined;

beforeEach(() => {
  root = makeTmp("pf-m11lp-");
  pfdir = join(root, ".procforge");
  oldUrl = process.env.PROOF_OPENCODE_URL;
  oldModel = process.env.PROOF_REDRAFT_MODEL;
  delete process.env.PROOF_REDRAFT_MODEL;
});

afterEach(async () => {
  if (oldUrl === undefined) delete process.env.PROOF_OPENCODE_URL;
  else process.env.PROOF_OPENCODE_URL = oldUrl;
  if (oldModel === undefined) delete process.env.PROOF_REDRAFT_MODEL;
  else process.env.PROOF_REDRAFT_MODEL = oldModel;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    sseClients.length = 0;
  }
});

function writeProc(name: string, id: string, goal: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(join(dir, "procedure.json"), JSON.stringify({
    format: "procforge-procedure", version: 1, name, sourceSession: "s",
    createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id, parentId: null, goal, depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] }],
  }));
}

function newApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
}

function promptText(): string {
  const parsed = JSON.parse(promptBody) as { parts: { text: string }[] };
  return parsed.parts.map((p) => p.text).join("");
}

async function runOnce(app: ProcForgeApp, procedure: string, request: string): Promise<{ draftId: string }> {
  const { draftId } = await app.requestRedraft({ procedure, request });
  for (let i = 0; i < 40; i++) {
    const d = await app.getDraft({ draftId });
    if (d.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { draftId };
}

describe("M11-1 재분석 프롬프트 교훈", () => {
  it("① lessons가 있으면 구획과 그 줄이 들어간다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    writeProc("lp1", "1", "밤 집계");
    writeFileSync(join(pfdir, "procedures", "lp1", "lessons.md"), "# 교훈\n- 먼저 한다.\n- 나중에 한다.\n", "utf8");
    const app = newApp();
    const { draftId } = await runOnce(app, "lp1", "바꿔");
    const t = promptText();
    expect(t).toContain("참고 교훈:\n- 먼저 한다.\n- 나중에 한다.\n");
    const d = await app.getDraft({ draftId });
    expect(d.status).toBe("ready");
    expect((d as unknown as { lessonsUsed: number }).lessonsUsed).toBe(2);
  }, 120000);

  it("② lessons가 없으면 참고 교훈 문자열이 0건이다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    writeProc("lp2", "1", "밤 집계");
    const app = newApp();
    const { draftId } = await runOnce(app, "lp2", "바꿔");
    expect(promptText().split("참고 교훈").length - 1).toBe(0);
    const d = await app.getDraft({ draftId });
    expect(d.status).toBe("ready");
    expect((d as unknown as { lessonsUsed: number }).lessonsUsed).toBe(0);
  }, 120000);

  it("③ 자동 구획 줄은 들어가지 않는다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    writeProc("lp3", "1", "밤 집계");
    writeFileSync(
      join(pfdir, "procedures", "lp3", "lessons.md"),
      "<!-- proof:auto -->\n- 자동1\n<!-- /proof:auto -->\n- 수기1\n",
      "utf8",
    );
    const app = newApp();
    const { draftId } = await runOnce(app, "lp3", "바꿔");
    const t = promptText();
    expect(t).toContain("- 수기1");
    expect(t).not.toContain("자동1");
    expect(t).not.toContain("proof:auto");
    const d = await app.getDraft({ draftId });
    expect((d as unknown as { lessonsUsed: number }).lessonsUsed).toBe(1);
  }, 120000);

  it("④ draft.json의 lessonsUsed가 실제 줄 수와 같다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    writeProc("lp4", "1", "밤 집계");
    writeFileSync(join(pfdir, "procedures", "lp4", "lessons.md"), "# 교훈\n- a\n- b\n- c\n", "utf8");
    const app = newApp();
    const { draftId } = await runOnce(app, "lp4", "바꿔");
    const saved = JSON.parse(readFileSync(join(pfdir, "drafts", draftId, "draft.json"), "utf8")) as { lessonsUsed: unknown };
    expect(saved.lessonsUsed).toBe(3);
    expect(promptText().split("참고 교훈").length - 1).toBe(1);
  }, 120000);

  it("⑤ 한도 초과 시 줄을 빼서 맞추고 lessonsUsed가 실제 넣은 줄 수와 같다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    // 노드 목록만으로 한도 가까이 채운다 (노드 98개 × goal 100자 ≈ 18.2KB).
    // 교훈 5줄(약 2.4KB)을 더하면 20000을 넘겨 뒤에서 2줄이 잘린다.
    const dir = join(pfdir, "procedures", "lp5");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
    const nodes = [];
    for (let i = 1; i <= 98; i++) {
      nodes.push({ id: `n${i}`, parentId: null, goal: "g".repeat(100), depth: 0, children: [], tool: { server: "t", name: "echo", schemaHash: "h" }, args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } }, sideEffect: "external", dependsOn: [], constraints: [] });
    }
    writeFileSync(join(dir, "procedure.json"), JSON.stringify({
      format: "procforge-procedure", version: 1, name: "lp5", sourceSession: "s",
      createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] }, nodes,
    }));
    writeFileSync(join(dir, "lessons.md"), ["# 교훈", "- " + "L".repeat(480), "- " + "M".repeat(480), "- " + "N".repeat(480), "- " + "O".repeat(480), "- " + "P".repeat(480)].join("\n") + "\n", "utf8");
    const app = newApp();
    const { draftId } = await runOnce(app, "lp5", "바꿔");
    const t = promptText();
    expect(t.length).toBeLessThanOrEqual(20000);
    expect(t).toContain("참고 교훈");
    const saved = JSON.parse(readFileSync(join(pfdir, "drafts", draftId, "draft.json"), "utf8")) as { lessonsUsed: unknown; status: string };
    expect(saved.status).toBe("ready");
    expect(typeof saved.lessonsUsed).toBe("number");
    expect(saved.lessonsUsed as number).toBeLessThan(5);
    expect(saved.lessonsUsed as number).toBeGreaterThanOrEqual(1);
    // 구획 안 실제 줄 수와 draft.json 값이 같다 (노드 목록 앞까지만 센다).
    const section = t.slice(t.indexOf("참고 교훈:"), t.indexOf("절차서 노드:"));
    const sectionLines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(sectionLines).toHaveLength(saved.lessonsUsed as number);
  }, 180000);

  it("⑥ 교훈이 있어도 없어도 원본 hash와 approvals.json이 변하지 않는다", async () => {
    const baseUrl = await startFake();
    process.env.PROOF_OPENCODE_URL = baseUrl;
    writeProc("lp6", "1", "밤 집계");
    writeFileSync(join(pfdir, "procedures", "lp6", "lessons.md"), "# 교훈\n- 먼저 한다.\n", "utf8");
    const app = newApp();
    await app.approveProcedureNode({ procedure: "lp6", nodeId: "1", allowWildcard: [] });
    const { createHash } = await import("node:crypto");
    const beforeProc = readFileSync(join(pfdir, "procedures", "lp6", "procedure.json"), "utf8");
    const beforeApprovals = readFileSync(join(pfdir, "procedures", "lp6", "approvals.json"), "utf8");
    const { draftId } = await runOnce(app, "lp6", "바꿔");
    const d = await app.getDraft({ draftId });
    expect(d.status).toBe("ready");
    expect(createHash("sha256").update(readFileSync(join(pfdir, "procedures", "lp6", "procedure.json"), "utf8")).digest("hex"))
      .toBe(createHash("sha256").update(beforeProc).digest("hex"));
    expect(readFileSync(join(pfdir, "procedures", "lp6", "approvals.json"), "utf8")).toBe(beforeApprovals);
  }, 120000);
});
