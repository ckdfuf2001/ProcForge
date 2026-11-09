import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runRedraft } from "../src/services/redraft.js";
import { fakeProvidersBody } from "./fake-providers.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

// M9-tmp: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();

// M10-2: 재분석 초안 (fake OpenCode 서버, 네트워크 0 — 127.0.0.1 루프백만).

let root: string;
let pfdir: string;
let docJson: string;

const DOC = {
  format: "procforge-procedure",
  version: 1,
  name: "m10-rd",
  sourceSession: "test",
  createdAt: new Date(0).toISOString(),
  params: { month: { type: "string", default: "2026-09", description: "" } },
  toolCatalog: [],
  nodes: [
    {
      id: "1",
      parentId: null,
      goal: "월간 보고",
      depth: 0,
      dependsOn: [],
      children: ["1.1"],
      sideEffect: "none",
      constraints: [],
    },
    {
      id: "1.1",
      parentId: "1",
      goal: "표 그리기",
      depth: 1,
      dependsOn: [],
      children: [],
      sideEffect: "none",
      constraints: [],
      args: { month: { kind: "fixed", value: "2026-09" } },
    },
  ],
};

type FakeMode = { responseText: string; foreignError?: string } | { sessionError: string };

let server: Server | null = null;
let baseUrl = "";
let mode: FakeMode = { responseText: '{"ops":[]}' };
const requests: { method?: string; url?: string; body: string }[] = [];
let sseClients: ServerResponse[] = [];

function sendAll(payload: unknown): void {
  const line = `data: ${JSON.stringify({ id: "evt-1", type: (payload as { type: string }).type, properties: (payload as { properties: unknown }).properties })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      // 끊긴 클라이언트 무시
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
    requests.push({ method: req.method, url: req.url, body });
    if (req.url === "/config/providers") {
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
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        if ("sessionError" in mode) {
          sendAll({
            type: "session.error",
            properties: { sessionID: "ses-test", error: { name: "X", message: mode.sessionError } },
          });
        } else {
          if (mode.foreignError !== undefined) {
            sendAll({
              type: "session.error",
              properties: { sessionID: "ses-other", error: { name: "X", message: mode.foreignError } },
            });
          }
          sendAll({ type: "session.status", properties: { sessionID: "ses-test", status: { type: "busy" } } });
          sendAll({ type: "session.idle", properties: { sessionID: "ses-test" } });
        }
      }, 20);
      return;
    }
    if (req.url === "/session/ses-test/message" && (!req.method || req.method === "GET")) {
      res.writeHead(200, { "content-type": "application/json" });
      if ("sessionError" in mode) {
        res.end(JSON.stringify([]));
      } else {
        res.end(
          JSON.stringify([
            { info: { role: "user" }, parts: [] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: mode.responseText }] },
          ]),
        );
      }
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

beforeEach(() => {
  root = makeTmp("pf-m10rd-");
  pfdir = join(root, ".procforge");
  const dir = join(pfdir, "procedures", "m10-rd");
  mkdirSync(dir, { recursive: true });
  docJson = JSON.stringify(DOC, null, 2);
  writeFileSync(join(dir, "procedure.json"), docJson);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    sseClients = [];
  }
});

async function runOnce() {
  return runRedraft({
    procforgeDir: pfdir,
    procedure: "m10-rd",
    request: "표에 합계 행 추가",
    openCode: { baseUrl, model: { providerID: "t", modelID: "m" }, source: "default" },
    idleTimeoutMs: 10000,
  });
}

describe("M10-2 재분석 초안 (fake OpenCode)", () => {
  it("① 원본 procedure.json 바이트 무손상", async () => {
    baseUrl = await startFake();
    mode = {
      responseText: JSON.stringify({ ops: [{ op: "edit_goal", nodeId: "1.1", goal: "표 그리기+합계", reason: "합계 필요" }] }),
    };
    const r = await runOnce();
    expect(r.status).toBe("ready");
    const copied = readFileSync(join(r.dir, "procedure.json"), "utf8");
    expect(copied).toBe(docJson);
    const hash = createHash("sha256").update(docJson, "utf8").digest("hex");
    expect(r.sourceHash).toBe(hash);
  });

  it("② ops 수와 diff 항목 수 일치", async () => {
    baseUrl = await startFake();
    mode = {
      responseText: JSON.stringify({
        ops: [
          { op: "edit_goal", nodeId: "1.1", goal: "표 그리기+합계", reason: "합계 필요" },
          { op: "edit_arg", nodeId: "1.1", arg: "month", value: "2026-10", reason: "10월분" },
        ],
      }),
    };
    const r = await runOnce();
    expect(r.status).toBe("ready");
    expect(r.ops).toHaveLength(2);
    expect(r.diff).toHaveLength(r.ops.length);
    expect(r.diff[0]).toEqual({ nodeId: "1.1", kind: "goal", before: "표 그리기", after: "표 그리기+합계" });
  });

  it("③ 노드 추가 op는 rejected (새 분해 필요)", async () => {
    baseUrl = await startFake();
    mode = {
      responseText: JSON.stringify({ ops: [{ op: "add_node", nodeId: "1.2", goal: "새 단계", reason: "분해 필요" }] }),
    };
    const r = await runOnce();
    expect(r.status).toBe("rejected");
    expect(r.reason ?? "").toContain("새 분해 필요");
  });

  it("④ session.error면 failed, 요청은 1회", async () => {
    baseUrl = await startFake();
    mode = { sessionError: "boom" };
    requests.length = 0;
    const r = await runOnce();
    expect(r.status).toBe("failed");
    expect(r.reason ?? "").toContain("boom");
    const prompts = requests.filter((x) => x.url === "/session/ses-test/prompt_async");
    expect(prompts).toHaveLength(1);
  });

  it("⑤ 요청 바디에 도구 비활성, 권한 요청 0회", async () => {
    baseUrl = await startFake();
    mode = { responseText: JSON.stringify({ ops: [] }) };
    requests.length = 0;
    const r = await runOnce();
    expect(r.status).toBe("ready");
    const prompt = requests.find((x) => x.url === "/session/ses-test/prompt_async");
    const body = JSON.parse(prompt?.body ?? "{}") as { tools?: Record<string, boolean> };
    expect(body.tools).toEqual({ "*": false });
    expect(requests.filter((x) => (x.url ?? "").includes("/permissions/"))).toHaveLength(0);
  });

  it("⑥ 프롬프트 바디에 모든 nodeId와 goal이 들어 있다", async () => {
    baseUrl = await startFake();
    mode = { responseText: JSON.stringify({ ops: [] }) };
    requests.length = 0;
    await runOnce();
    const prompt = requests.find((x) => x.url === "/session/ses-test/prompt_async");
    const body = JSON.parse(prompt?.body ?? "{}") as { parts?: { text?: string }[] };
    const text = body.parts?.map((p) => p.text ?? "").join("\n") ?? "";
    expect(text).toContain("1.1");
    expect(text).toContain("표 그리기");
    expect(text).toContain("월간 보고");
  });

  it("⑦ reason이 없는 op가 오면 rejected", async () => {
    baseUrl = await startFake();
    mode = {
      responseText: JSON.stringify({ ops: [{ op: "edit_goal", nodeId: "1.1", goal: "표 그리기+합계" }] }),
    };
    const r = await runOnce();
    expect(r.status).toBe("rejected");
    expect(r.reason ?? "").toContain("reason");
  });

  it("⑧ 다른 세션의 session.error는 무시한다", async () => {
    baseUrl = await startFake();
    mode = {
      responseText: JSON.stringify({ ops: [{ op: "edit_goal", nodeId: "1.1", goal: "표 그리기+합계", reason: "합계 필요" }] }),
      foreignError: "남의 세션 오류",
    };
    const r = await runOnce();
    expect(r.status).toBe("ready");
    expect(r.ops).toHaveLength(1);
  });

  it("⑨ 코드 블록으로 감싼 JSON은 ready", async () => {
    baseUrl = await startFake();
    mode = {
      responseText:
        "```json\n" +
        JSON.stringify({ ops: [{ op: "edit_goal", nodeId: "1.1", goal: "표 그리기+합계", reason: "합계 필요" }] }) +
        "\n```",
    };
    const r = await runOnce();
    expect(r.status).toBe("ready");
    expect(r.ops).toHaveLength(1);
  });
});
