import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { withNetRetry } from "./net-retry.js";
import { testStack } from "./client-mode.js";

// M6-3: RemoteCoreClient 선택·재시도·degraded.

const KEY = "test-key";
let dir: string;
let base: string;
let close: (() => Promise<void>) | undefined;
let oldUrl: string | undefined;
let oldKey: string | undefined;

// 소켓 고갈(EACCES) 방지: 파일당 서버 1개 공유.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pf-remote-"));
  oldUrl = process.env.PROCFORGE_CORE_URL;
  oldKey = process.env.PROCFORGE_CORE_API_KEY;
  delete process.env.PROCFORGE_CORE_URL;
  delete process.env.PROCFORGE_CORE_API_KEY;
  const s = await startServer({
    dataDir: dir,
    apiKeys: parseApiKeys(`t1:${KEY}`),
    port: 0,
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  for (let i = 0; i < 20; i++) {
    try {
      const h = await fetch(`${base}/healthz`);
      if (h.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

afterAll(async () => {
  await close?.();
  if (oldUrl === undefined) delete process.env.PROCFORGE_CORE_URL;
  else process.env.PROCFORGE_CORE_URL = oldUrl;
  if (oldKey === undefined) delete process.env.PROCFORGE_CORE_API_KEY;
  else process.env.PROCFORGE_CORE_API_KEY = oldKey;
});

describe("remote-client", () => {
  it("왕복: start→split→report→confirm→tree", async () => {
    const client = withNetRetry(
      createRemoteCoreClient({ baseUrl: base, apiKey: KEY }),
    );
    const started = await client.pfStart({
      request: "r",
      params: {},
      toolCatalog: [
        { server: "s", name: "t", inputSchema: {}, schemaHash: "h" },
      ],
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }],
    });
    await client.pfReport({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "s", name: "t" },
      args: {},
      resultSummary: "ok",
      selfVerdict: "pass",
      selfReason: "ok",
    });
    const leaf = await client.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "s", name: "t" },
      argSpecs: {},
    });
    expect(leaf.node.status).toBe("leaf");
    const tree = await client.pfTree(sid);
    expect(tree.nodes.map((n) => n.id)).toEqual(["1", "1.1"]);
  }, 60000);

  it("degraded: 닫힌 포트 → io_error (읽기·쓰기 모두)", async () => {
    const dead = createRemoteCoreClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: KEY,
      timeoutMs: 2000,
    });
    for (const op of [
      () => dead.getSession("123e4567-e89b-42d3-a456-426614174000"),
      () => dead.pfStart({ request: "r", toolCatalog: [] }),
    ]) {
      try {
        await op();
        expect.unreachable();
      } catch (e) {
        expect((e as { code?: string }).code).toBe("io_error");
        expect(String((e as Error).message)).toMatch(/core 연결 실패/);
      }
    }
  }, 60000);

  it("onSend 탭에 송신 바이트", async () => {
    const sent: { method: string; bytes: number }[] = [];
    const client = withNetRetry(
      createRemoteCoreClient({
        baseUrl: base,
        apiKey: KEY,
        onSend: (m, b) => sent.push({ method: m, bytes: b }),
      }),
    );
    await client.pfStart({ request: "r", params: {}, toolCatalog: [] });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].method).toBe("pfStart");
    expect(sent[0].bytes).toBeGreaterThan(0);
  }, 60000);

  it("createLocalStack 선택: URL 있으면 remote", async () => {
    process.env.PROCFORGE_CORE_URL = base;
    process.env.PROCFORGE_CORE_API_KEY = KEY;
    const pfdir = join(dir, "local");
    const { client } = testStack(pfdir);
    const started = await withNetRetry(client).pfStart({
      request: "r",
      params: {},
      toolCatalog: [],
    });
    expect(started.session.id).toMatch(/^[0-9a-f-]{36}$/);
    // remote core의 세션 (로컬 store가 아님).
    const { FileStore } = await import("../src/filestore.js");
    expect(new FileStore(pfdir).getSession(started.session.id)).toBeUndefined();
  }, 60000);
});
