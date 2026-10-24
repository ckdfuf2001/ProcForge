import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { readEvents } from "../src/trace.js";
import { savePairing, getPairing } from "../src/services/pairings.js";
import { clampTimeoutMs, SIGNAL_TIMEOUT_CAP_MS, fetchServerVersion } from "../src/services/opencode-link.js";

// M7-ui4-i/j: 신호 대상·버전·타임아웃은 서버 설정/조회값만. 짝이 없으면 미전송.

const catalog = [{ server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" }];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-link2-")), ".procforge");
});

/** 요청을 전부 기록하는 가짜 OpenCode */
function fakeServer(version: string | null = "1.18.18") {
  const seen: string[] = [];
  return {
    seen,
    impl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(new URL(String(input)).pathname);
      if (String(input).endsWith("/version") || String(input).endsWith("/config")) {
        if (version === null) return new Response("nope", { status: 404 });
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(init?.method) === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function app(
  signal?: Partial<{ baseUrl: string; mode: "b" | "a" | "c"; serverVersion: string; timeoutMs: number }>,
  fetchImpl?: typeof fetch,
) {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({
    core: client,
    procforgeDir: pfdir,
    projectRoot: pfdir,
    ...(signal ? { signal } : {}),
    ...(fetchImpl ? { linkFetchImpl: fetchImpl } : {}),
  });
}

async function oneSession(a: ProcForgeApp) {
  const s = await a.start({ request: "r", toolCatalog: catalog as never });
  return s.sessionId;
}

describe("M7-ui4-j 짝 없음 + openCodeSessionId 없음 → 미전송", () => {
  it("가짜 서버 요청 0건 + C 문구", async () => {
    const fake = fakeServer();
    // M8-1 d 보정: fetch 를 주입해 실제 네트워크 요청이 나가지 않게 한다.
    const a = await app({ baseUrl: "http://127.0.0.1:1", mode: "b" }, fake.impl);
    // linkFetchImpl 주입으로 실제 요청이 가짜 서버로 가지 않도록 baseUrl은 미사용
    const sid = await oneSession(a);
    const r = await a.signalOnly({ sessionId: sid, nodeId: "1" });
    expect(r.delivered).toBe(false);
    if (!r.delivered) {
      expect(r.degraded).toBe("OpenCode 세션 짝이 없음. 전송하지 않음");
      // M8-1: C 문구는 서버가 만든 신호 문구(세션·노드·pf_start 금지 포함).
      expect(r.copyText).toContain(sid);
      expect(r.copyText).toContain("pf_start 금지");
    }
    expect(fake.seen).toEqual([]);
  });

  it("문구 우선순위: 미설정 주소가 짝보다 먼저", async () => {
    const a = await app(); // baseUrl 미설정
    const sid = await oneSession(a);
    const r = await a.signalOnly({ sessionId: sid, nodeId: "1" });
    expect(r.delivered).toBe(false);
    if (!r.delivered) expect(r.degraded).toMatch(/^OpenCode 주소 미설정/);
  });

  it("다른 세션과 짝 → 그 다음 문구", async () => {
    const fake = fakeServer();
    // M8-1 d 보정: 실제 네트워크 대신 주입 fetch (역방향 짝 어긋남 → GET 전에 끊긴다)
    const a = await app({ baseUrl: "http://127.0.0.1:1", mode: "b" }, fake.impl);
    const sid = await oneSession(a);
    savePairing(pfdir, "ses-x", "pf-other");
    const r = await a.signalOnly({
      sessionId: sid,
      nodeId: "1",
      openCodeSessionId: "ses-x",
    });
    expect(r.delivered).toBe(false);
    if (!r.delivered) expect(r.degraded).toBe("다른 세션과 짝(pf-other). 전송하지 않음");
    // ②(로컬 역방향)가 어긋났지만 생존 확인은 문구 우선순위를 위해 먼저 나간다 →
    // 주입된 가짜 서버가 GET 에 답하고, 신호 전송은 없다.
    expect(fake.seen).toEqual(["/session/ses-x"]);
  });

  it("짝이 있으면 전송 시도한다 (기존 동작 유지)", async () => {
    const fake = fakeServer();
    const { client } = testStack(pfdir);
    const a = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
      linkFetchImpl: fake.impl,
      // 가짜 서버는 pf_* 응답을 만들지 않는다 → 짧은 타임아웃으로 빨리 포기한다
      signal: { baseUrl: "http://127.0.0.1:9999", mode: "b", timeoutMs: 1_500 },
    });
    const sid = await oneSession(a);
    savePairing(pfdir, "ses-y", sid);
    const r = await a.signalOnly({ sessionId: sid, nodeId: "1" });
    // 짝이 있으면 버전 조회부터 시도한다 (요청이 나갔다는 증거)
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(r.delivered === true || r.delivered === false).toBe(true);
  });
});

describe("M7-ui4-i serverVersion·timeoutMs는 서버 설정/조회값만", () => {
  it("클라이언트가 지정하면 400 (MCP 경로)", async () => {
    const a = await app({ baseUrl: "http://127.0.0.1:1", mode: "b" });
    const sid = await oneSession(a);
    for (const link of [
      { serverVersion: "9.9.9" },
      { timeoutMs: 1 },
      { baseUrl: "http://169.254.169.254", mode: "b" as const },
      { mode: "c" as const },
    ]) {
      await expect(
        a.adviseAndSignal({ sessionId: sid, nodeId: "1", text: "x", link }),
      ).rejects.toThrow(/서버 설정에서만/);
    }
  });

  it("UI 본문으로 지정하면 400", async () => {
    const a = await app({ baseUrl: "http://127.0.0.1:1", mode: "b" });
    const sid = await oneSession(a);
    const srv = await createUiServer({ app: a as never });
    try {
      for (const extra of [
        { serverVersion: "9.9.9" },
        { timeoutMs: 5 },
        { link: { baseUrl: "http://x" } },
      ]) {
        const r = await fetch(`${srv.url}/api/sessions/${sid}/advise-and-signal`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-procforge-token": srv.token },
          body: JSON.stringify({
            nodeId: "1",
            text: "x",
            expectedRevision: (await a.readSession(sid)).revision,
            ...extra,
          }),
        });
        expect(r.status).toBe(400);
      }
    } finally {
      srv.close();
    }
  });

  it("버전 미확인 → default-deny(전송 0)", async () => {
    const fake = fakeServer(null);
    const { client } = testStack(pfdir);
    const a = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
      linkFetchImpl: fake.impl,
      signal: { baseUrl: "http://127.0.0.1:9999", mode: "b" },
    });
    const sid = await oneSession(a);
    savePairing(pfdir, "ses-z", sid);
    const r = await a.signalOnly({ sessionId: sid });
    expect(r.delivered).toBe(false);
    if (!r.delivered) expect(r.degraded).toMatch(/버전 미확인/);
    // 버전 조회만 했고 전송(POST)은 하지 않았다
    expect(fake.seen.some((p) => p === "/message")).toBe(false);
  });

  it("timeoutMs 상한 120s", async () => {
    expect(SIGNAL_TIMEOUT_CAP_MS).toBe(120_000);
    expect(clampTimeoutMs(10_000_000)).toBe(120_000);
    expect(clampTimeoutMs(undefined)).toBe(60_000);
    expect(clampTimeoutMs(5_000)).toBe(5_000);
  });

  it("web UI fallback: /version HTML이어도 /global/health에서 버전을 읽는다", async () => {
    const seen: string[] = [];
    const impl = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      seen.push(path);
      if (path === "/global/health") {
        return new Response(JSON.stringify({ healthy: true, version: "1.18.18" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/version") {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    expect(await fetchServerVersion("http://x", { fetchImpl: impl })).toBe("1.18.18");
    expect(seen).toEqual(["/global/health"]);
  });

  it("버전 조회는 서버가 밝힌 값만 쓴다", async () => {
    const fake = fakeServer("1.18.18");
    expect(await fetchServerVersion("http://x", { fetchImpl: fake.impl })).toBe("1.18.18");
    const none = fakeServer(null);
    expect(await fetchServerVersion("http://x", { fetchImpl: none.impl })).toBeUndefined();
  });
});

describe("M7-ui4 저장 보존 (신호 실패와 무관)", () => {
  it("미전송이어도 의견·조건은 남고 actor ui 로 기록된다", async () => {
    const a = await app({ baseUrl: "http://127.0.0.1:1", mode: "b" });
    const sid = await oneSession(a);
    const srv = await createUiServer({ app: a as never });
    try {
      const r = await fetch(`${srv.url}/api/sessions/${sid}/advise-and-signal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({
          nodeId: "1",
          text: "HN 제목 빼라",
          expectedRevision: (await a.readSession(sid)).revision,
        }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { signal: { delivered: boolean; degraded: string } };
      expect(body.signal.delivered).toBe(false);
      const node = await a.readNode(sid, "1");
      expect(node.constraints.length).toBeGreaterThan(0);
      const ui = readEvents(pfdir, sid).filter((e) => e.actor === "ui");
      expect(ui.length).toBeGreaterThan(0);
      expect(ui.every((e) => e.ok)).toBe(true);
    } finally {
      srv.close();
    }
  });
});