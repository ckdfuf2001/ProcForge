import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { runRedraft } from "../src/services/redraft.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M9-tmp: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M10-why-2: editWhy (의견 경로와 같은 취급, MCP 도구 없음).

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  root = makeTmp("pf-m10why2-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
});

async function splitTree(): Promise<string> {
  const s = await app.start({ request: "r", toolCatalog: CAT });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "분해 사유입니다 0123456789",
    children: [
      { goal: "a", why: "이유 a" },
      { goal: "b" },
    ],
  } as never);
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1.1",
    reason: "더 잘게 나누는 사유입니다 0123",
    children: [{ goal: "a1" }, { goal: "a2" }],
  } as never);
  return s.sessionId;
}

describe("M10-why-2 editWhy", () => {
  it("① 대상 노드와 하위 노드만 변한다 (나머지 hash 불변)", async () => {
    const sid = await splitTree();
    const before = new Map<string, string>();
    for (const id of ["1", "1.1", "1.2", "1.1.1", "1.1.2"]) {
      before.set(id, (await app.getNode({ sessionId: sid, nodeId: id })).node.hash);
    }
    const r = await app.editWhy({ sessionId: sid, nodeId: "1.1", why: "바꾼 이유" });
    expect(r.node.why).toBe("바꾼 이유");
    expect(r.node.status).toBe("needs_reverify");
    const n11 = await app.getNode({ sessionId: sid, nodeId: "1.1" });
    expect(n11.node.why).toBe("바꾼 이유");
    const n111 = await app.getNode({ sessionId: sid, nodeId: "1.1.1" });
    expect(n111.node.staleSince).toEqual({ revision: expect.any(Number), causeNodeId: "1.1" });
    const n112 = await app.getNode({ sessionId: sid, nodeId: "1.1.2" });
    expect(n112.node.staleSince).toBeDefined();
    // 나머지는 그대로 (hash 포함).
    for (const id of ["1", "1.1", "1.2", "1.1.1", "1.1.2"]) {
      expect((await app.getNode({ sessionId: sid, nodeId: id })).node.hash, id).toBe(before.get(id));
    }
    expect((await app.getNode({ sessionId: sid, nodeId: "1.2" })).node.staleSince).toBeUndefined();
    expect((await app.getNode({ sessionId: sid, nodeId: "1" })).node.staleSince).toBeUndefined();
  });

  it("② 이벤트에 before/after가 남는다", async () => {
    const sid = await splitTree();
    await app.editWhy({ sessionId: sid, nodeId: "1.1", why: "바꾼 이유" });
    const events = await app.core.getEvents(sid);
    const e = events.find((x) => x.method === "pfEditWhy");
    expect(e).toBeDefined();
    expect(typeof e!.beforeHash).toBe("string");
    expect(typeof e!.afterHash).toBe("string");
    const after = (e!.detail as { nodesAfter?: { id: string; why?: string }[] } | undefined)?.nodesAfter;
    expect(after?.find((n) => n.id === "1.1")?.why).toBe("바꾼 이유");
  });

  it("③ 재분석이 보낸 edit_why op가 diff에 나타난다", async () => {
    const dir = join(pfdir, "procedures", "m10-rd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "procedure.json"),
      JSON.stringify({
        format: "procforge-procedure",
        version: 1,
        name: "m10-rd",
        sourceSession: "test",
        createdAt: new Date(0).toISOString(),
        params: {},
        toolCatalog: [],
        nodes: [
          { id: "1", parentId: null, goal: "root", depth: 0, dependsOn: [], children: ["1.1"], sideEffect: "none", constraints: [] },
          { id: "1.1", parentId: "1", goal: "그리기", why: "옛 이유", depth: 1, dependsOn: [], children: [], sideEffect: "none", constraints: [] },
        ],
      }),
    );
    let requests: { url?: string; body: string }[] = [];
    let sse: ServerResponse[] = [];
    const send = (t: string, p: unknown): void => {
      const line = `data: ${JSON.stringify({ id: "evt-1", type: t, properties: p })}\n\n`;
      for (const r of sse) {
        try {
          r.write(line);
        } catch {
          // 무시
        }
      }
    };
    const readBody = (req: IncomingMessage): Promise<string> =>
      new Promise((resolve) => {
        let t = "";
        req.on("data", (d) => { t += d; });
        req.on("end", () => resolve(t));
      });
    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      requests.push({ url: req.url, body });
      if (req.url === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        sse.push(res);
        res.write(`data: ${JSON.stringify({ id: "evt-0", type: "server.connected", properties: {} })}\n\n`);
        req.on("close", () => { sse = sse.filter((r) => r !== res); });
        return;
      }
      if (req.url === "/session" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses-t" }));
        return;
      }
      if (req.url === "/session/ses-t/prompt_async") {
        res.writeHead(204);
        res.end();
        setTimeout(() => {
          send("message.status", { sessionID: "ses-t", status: { type: "busy" } });
          send("session.idle", { sessionID: "ses-t" });
        }, 20);
        return;
      }
      if (req.url === "/session/ses-t/message") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
          { info: { role: "assistant" }, parts: [{ type: "text", text: JSON.stringify({ ops: [{ op: "edit_why", nodeId: "1.1", why: "새 이유", reason: "요청 반영" }] }) }] },
        ]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      const r = await runRedraft({
        procforgeDir: pfdir,
        procedure: "m10-rd",
        request: "이유를 바꿔라",
        openCode: { baseUrl: `http://127.0.0.1:${addr.port}`, model: { providerID: "t", modelID: "m" } },
        idleTimeoutMs: 10000,
      });
      expect(r.status).toBe("ready");
      expect(r.ops).toHaveLength(1);
      expect(r.ops[0]).toEqual({ op: "edit_why", nodeId: "1.1", why: "새 이유", reason: "요청 반영" });
      expect(r.diff).toEqual([{ nodeId: "1.1", kind: "why", before: "옛 이유", after: "새 이유" }]);
      const prompt = requests.find((x) => (x.url ?? "").endsWith("/prompt_async"));
      expect(JSON.parse(prompt?.body ?? "{}").tools).toEqual({ "*": false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
