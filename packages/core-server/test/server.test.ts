import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, parseApiKeys } from "../src/server.js";
import {
  PROTOCOL_VERSION_HEADER,
  PROTOCOL_VERSION,
} from "@procforge/shared/wire.js";

// M6-2: 인증·테넌트 격리·버전·E2E 흐름.

let dir: string;
let base: string;
const KEY1 = "k1";
const KEY2 = "k2";
let close: (() => Promise<void>) | undefined;

const H1 = {
  "content-type": "application/json",
  authorization: `Bearer ${KEY1}`,
  [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
};
const H2 = { ...H1, authorization: `Bearer ${KEY2}` };

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = H1,
) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    },
  };
}

async function ready(base: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const h = await fetch(`${base}/healthz`);
      if (h.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// 소켓 고갈(EACCES) 방지: 파일당 서버 1개 공유 (세션 id는 uuid라 충돌 없음).
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pf-core-srv-"));
  const keys = parseApiKeys(`t1:${KEY1},t2:${KEY2}`);
  const s = await startServer({ dataDir: dir, apiKeys: keys, port: 0 });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await ready(base);
});

afterAll(async () => {
  await close?.();
});

describe("core-server", () => {
  it("parseApiKeys: bare 키는 default 테넌트", () => {
    expect([...parseApiKeys("abc").entries()]).toEqual([["abc", "default"]]);
    expect(() => parseApiKeys("bad tid!:k")).toThrow();
    expect(() => parseApiKeys("t1:k,t1:k")).toThrow();
  });

  it("healthz + 키 없음 401 + 버전 불일치 409", async () => {
    const h = (await (await fetch(`${base}/healthz`)).json()) as {
      ok: boolean;
      version: number;
    };
    expect(h).toEqual({ ok: true, version: PROTOCOL_VERSION });
    const noKey = await post(
      "/v1/pfTree",
      { sessionId: "x" },
      { "content-type": "application/json", [PROTOCOL_VERSION_HEADER]: "1" },
    );
    expect(noKey.status).toBe(401);
    expect(noKey.json.error?.code).toBe("unauthorized");
    const badKey = await post(
      "/v1/pfTree",
      { sessionId: "x" },
      { ...H1, authorization: "Bearer nope" },
    );
    expect(badKey.status).toBe(401);
    const badVer = await post(
      "/v1/pfTree",
      { sessionId: "x" },
      { ...H1, [PROTOCOL_VERSION_HEADER]: "999" },
    );
    expect(badVer.status).toBe(409);
    expect(badVer.json.error?.code).toBe("conflict");
  });

  it("입력 검증 실패 400 + 미지정 경로 404", async () => {
    const bad = await post("/v1/pfNext", {});
    expect(bad.status).toBe(400);
    expect(bad.json.error?.code).toBe("bad_request");
    const nope = await post("/v1/nope", {});
    expect(nope.status).toBe(404);
  });

  it("테넌트 격리: 타 테넌트 sessionId → session_not_found", async () => {
    const started = await post("/v1/pfStart", {
      request: "r",
      params: {},
      toolCatalog: [],
    });
    expect(started.status).toBe(200);
    const sid = (started.json.data as { session: { id: string } }).session.id;
    const mine = await fetch(`${base}/v1/getSession`, {
      method: "POST",
      headers: H1,
      body: JSON.stringify({ sessionId: sid }),
    });
    expect(mine.status).toBe(200);
    const other = await post("/v1/getSession", { sessionId: sid }, H2);
    expect(other.status).toBe(400);
    expect(other.json.error?.code).toBe("session_not_found");
  });

  it("E2E 흐름: split→report→confirm leaf", async () => {
    const started = await post("/v1/pfStart", {
      request: "r",
      params: {},
      toolCatalog: [
        { server: "s", name: "t", inputSchema: {}, schemaHash: "h" },
      ],
    });
    const sid = (started.json.data as { session: { id: string } }).session.id;
    await post("/v1/pfResolve", {
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }],
    });
    await post("/v1/pfReport", {
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "s", name: "t" },
      args: {},
      resultSummary: "ok",
      selfVerdict: "pass",
      selfReason: "ok",
    });
    const leaf2 = await post("/v1/pfResolve", {
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "s", name: "t" },
      argSpecs: {},
    });
    expect(leaf2.status).toBe(200);
    expect((leaf2.json.data as { node: { status: string } }).node.status).toBe(
      "leaf",
    );
  }, 60000);
});
