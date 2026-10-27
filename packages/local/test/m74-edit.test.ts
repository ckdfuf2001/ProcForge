import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createUiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { readEvents } from "../src/trace.js";

// M7-ui4: previewEdit 무쓰기·409 흐름·actor:"ui"·신호 실패에도 저장 유지.

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-ui4-")), ".procforge");
});

async function started() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: 0,
  });
  // 1.1 → 1.2 의존을 만든다 (편집 전파 확인용)
  await app.editNode({
    sessionId: s.sessionId,
    nodeId: "1.1",
    dependsOn: ["1.2"],
    expectedRevision: (await app.readSession(s.sessionId)).revision,
  });
  return { app, sid: s.sessionId };
}

function json(srv: { url: string; token: string }, path: string, body: unknown) {
  return fetch(`${srv.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-procforge-token": srv.token,
    },
    body: JSON.stringify(body),
  });
}

/**
 * M7-ui4: 파일당 서버 1개 (Windows loopback ephemeral 포트 고갈 방지).
 * 테스트마다 App이 다르므로 **위임 프록시**를 服务器에 심어 두고, 요청 시점에
 * 현재 테스트의 App으로 넘긴다 (ui-server는 opts.app를 요청마다 읽는다).
 */
let currentApp: Record<string, unknown> | null = null;
const appProxy = new Proxy(
  {},
  {
    get: (_t, k) => {
      const app = currentApp;
      if (!app) throw new Error("currentApp 미설정");
      const v = app[k as string];
      return typeof v === "function" ? v.bind(app) : v;
    },
  },
) as unknown as { close: () => void };
let sharedPromise: Promise<{ url: string; token: string }> | null = null;
let sharedClose: (() => void) | null = null;
function sharedServer(app: unknown): Promise<{ url: string; token: string }> {
  currentApp = app as Record<string, unknown>;
  sharedPromise ??= createUiServer({ app: appProxy }).then((s) => {
    sharedClose = s.close;
    return { url: s.url, token: s.token };
  });
  return sharedPromise;
}
afterAll(() => {
  sharedClose?.();
  sharedClose = null;
  sharedPromise = null;
  currentApp = null;
});
/** content-length 없이 chunked로 보내고 상태줄을 그대로 받는 원시 POST */
function rawPost(opts: {
  host: string;
  port: string;
  path: string;
  headers: Record<string, string>;
  chunks: number;
  chunkBytes: number;
}): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: opts.host,
        port: Number(opts.port),
        path: opts.path,
        method: "POST",
        headers: opts.headers,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const headers = res.headers as Record<string, unknown>;
        res.resume();
        res.on("end", () => resolve({ statusCode, headers }));
      },
    );
    req.on("error", (e) => reject(e));
    req.write("-".repeat(opts.chunkBytes));
    let sent = 1;
    const tick = () => {
      if (sent >= opts.chunks) {
        req.end();
        return;
      }
      // 서버가 413 으로 응답하면 더 보내지 않는다 (리셋 회피)
      if (req.writableEnded || req.destroyed) return;
      req.write("-".repeat(opts.chunkBytes));
      sent++;
      setImmediate(tick);
    };
    setImmediate(tick);
  });
}

describe("M7-ui4 core.previewEdit", () => {
  it("무쓰기: 저장소 바이트 불변 + wouldStale 계산", async () => {
    const { app, sid } = await started();
    const sf = join(pfdir, "sessions", sid, "session.json");
    const before = existsSync(sf) ? readFileSync(sf, "utf8") : "";
    const mt = existsSync(sf) ? statSync(sf).mtimeMs : 0;
    const r = await app.previewEdit({
      sessionId: sid,
      nodeId: "1.2",
      change: { goal: "b 바뀜" },
    });
    // 1.2 를 dependsOn 하는 하류 = 1.1
    expect(r.wouldStale).toContain("1.1");
    expect(r.newHash).toMatch(/^[0-9a-f]/);
    // 저장소는 그대로
    if (existsSync(sf)) {
      expect(readFileSync(sf, "utf8")).toBe(before);
      expect(statSync(sf).mtimeMs).toBe(mt);
    }
    // 실제 저장 후에는 동일 노드가 stale 표시된다
    const rev = (await app.readSession(sid)).revision;
    await app.uiEditNode({
      sessionId: sid,
      nodeId: "1.2",
      goal: "b 바뀜",
      expectedRevision: rev,
    });
    expect((await app.readNode(sid, "1.1")).staleSince).toBeDefined();
  }, 30000);

  it("잠긴 노드·빈 변경 거부", async () => {
    const { app, sid } = await started();
    await expect(
      app.previewEdit({ sessionId: sid, nodeId: "1.1", change: {} }),
    ).rejects.toThrow();
    await app.lock({ sessionId: sid, nodeId: "1.1" });
    await expect(
      app.previewEdit({
        sessionId: sid,
        nodeId: "1.1",
        change: { goal: "x" },
      }),
    ).rejects.toThrow();
  }, 30000);
});

describe("M7-ui4 UI 쓰기 API", () => {
  it("POST+JSON만·expectedRevision 필수·actor ui", async () => {
    const { app, sid } = await started();
    const srv = await sharedServer(app);
    try {
      const rev = (await app.readSession(sid)).revision;
      // 1) GET으로는 못 쓴다
      expect(
        (await fetch(`${srv.url}/api/sessions/${sid}/edit-node`, {
          headers: { "x-procforge-token": srv.token },
        })).status,
      ).toBe(404);
      // 2) content-type 없으면 415
      const noCt = await fetch(`${srv.url}/api/sessions/${sid}/edit-node`, {
        method: "POST",
        headers: { "x-procforge-token": srv.token },
        body: "{}",
      });
      expect(noCt.status).toBe(415);
      // 3) expectedRevision 없으면 400
      const noRev = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1",
        goal: "x",
      });
      expect(noRev.status).toBe(400);
      // 4) 정상 저장 → calls.jsonl 에 actor "ui"
      const ok = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1.1",
        goal: "a 새 목표",
        expectedRevision: rev,
      });
      expect(ok.status).toBe(200);
      const calls = readEvents(pfdir, sid).filter((e) => e.actor === "ui");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((c) => c.tool === "pf_edit_node")).toBe(true);
      expect(calls.some((c) => (c.connectionId ?? "").startsWith("ui-"))).toBe(true);
    } finally {
    }
  }, 30000);

  it("409: 초안 유지 (자동 재시도 없음)", async () => {
    const { app, sid } = await started();
    const srv = await sharedServer(app);
    try {
      const stale = 0; // 실제 revision보다 오래된 값
      const r = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1.1",
        goal: "옛 값",
        expectedRevision: stale,
      });
      expect(r.status).toBe(409);
      // 상태는 그대로 (goal 미변경)
      expect((await app.readNode(sid, "1.1")).goal).toBe("a");
    } finally {
    }
  }, 30000);

  it("의견 저장 후 신호 실패 → 저장분은 유지", async () => {
    const { client } = testStack(pfdir);
    // M7-ui4-b: 신호 대상은 서버 설정 (연결 불가한 주소)
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
      signal: { baseUrl: "http://127.0.0.1:1", mode: "b" },
    });
    const s = await app.start({ request: "r", toolCatalog: catalog as never });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: "M8 테스트용 분해 사유입니다.",
      children: [{ goal: "a" }, { goal: "b" }],
      expectedRevision: 0,
    });
    const srv = await sharedServer(app);
    try {
      const rev = (await app.readSession(sid)).revision;
      const r = await json(srv, `/api/sessions/${sid}/advise-and-signal`, {
        nodeId: "1.1",
        text: "Show HN 제외",
        expectedRevision: rev,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        advise: { constraints: unknown[] };
        signal: { delivered: boolean; degraded: string } | null;
      };
      // 신호는 실패하지만 저장은 됐다
      expect(body.signal?.delivered).toBe(false);
      // M8-1-pair: 짝이 없으면 찾기(연결 실패 = 확인 불가)로 먼저 간다
      expect(body.signal?.degraded).toMatch(/버전 미확인|전송 실패|미확인|연결 없음|짝이 없음|짝 확인 불가|짝 세션 못 찾음/);
      const node = await app.readNode(sid, "1.1");
      expect(node.advice.length).toBeGreaterThan(0);
      expect(node.constraints.length).toBeGreaterThan(0);
      const calls = readEvents(pfdir, sid).filter(
        (e) => e.actor === "ui" && e.tool === "pf_advise",
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.ok)).toBe(true);
    } finally {
    }
  }, 30000);

  it("M7-ui4-b: 본문으로 link/baseUrl 지정 → 400 (서버 설정만)", async () => {
    const { app, sid } = await started();
    const srv = await sharedServer(app);
    try {
      const rev = (await app.readSession(sid)).revision;
      for (const body of [
        { link: { baseUrl: "http://169.254.169.254" } },
        { baseUrl: "http://169.254.169.254" },
        { mode: "c" },
      ]) {
        const r = await json(srv, `/api/sessions/${sid}/advise-and-signal`, {
          nodeId: "1.1",
          text: "x",
          expectedRevision: rev,
          ...body,
        });
        expect(r.status).toBe(400);
      }
    } finally {
    }
  }, 30000);

  it("M7-ui4-k: 2MB 본문 → 413 (content-length 사전 판정)", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      const url = `${srv.url}/api/sessions/${sid}/edit-node`;
      const big = JSON.stringify({
        nodeId: "1.1",
        goal: "x".repeat(2 * 1024 * 1024),
        expectedRevision: 0,
      });
      expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
      // content-length가 있는 요청: 서버가 본문을 읽기 전에 거절한다
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-procforge-token": srv.token,
        },
        body: big,
      });
      expect(r.status).toBe(413);
      const body = (await r.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(413);
      // 상태는 그대로 (본문은 반영되지 않았다)
      expect((await app.readNode(sid, "1.1")).goal).toBe("a");
    } finally {
      srv.close();
    }
  }, 30000);

  it("M7-ui4-k: chunked(길이 미고지) 2MB → 413 + connection close", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      // fetch(undici)는 스트리밍 업로드 중 조기 응답을 리셋으로 받는다.
      // "클라이언트가 413을 실제로 받는지"를 보려면 원시 HTTP로 확인한다.
      const { statusCode, headers } = await rawPost({
        host: "127.0.0.1",
        port: new URL(srv.url).port,
        path: `/api/sessions/${sid}/edit-node`,
        headers: {
          "content-type": "application/json",
          "x-procforge-token": srv.token,
        },
        // content-length 없이 2.5MB 를 쪼개서 보낸다 (chunked)
        chunks: 40,
        chunkBytes: 64 * 1024,
      });
      expect(statusCode).toBe(413);
      expect(headers.connection).toBe("close");
      // 상태는 그대로 (본문은 반영되지 않았다)
      expect((await app.readNode(sid, "1.1")).goal).toBe("a");
    } finally {
      srv.close();
    }
  }, 30000);

  it("M7-ui4-e: media type 정확 비교·비객체·깨진 JSON 400", async () => {
    const { app, sid } = await started();
    const srv = await sharedServer(app);
    try {
      const url = `${srv.url}/api/sessions/${sid}/edit-node`;
      const tok = { "x-procforge-token": srv.token };
      const body = JSON.stringify({ nodeId: "1.1", goal: "g", expectedRevision: 0 });
      // application/json 뒤에 매개변수가 붙어도 허용 (charset 등)
      const withParam = await fetch(url, {
        method: "POST",
        headers: { ...tok, "content-type": "application/json; charset=utf-8" },
        body,
      });
      expect(withParam.status).not.toBe(415);
      // 대문자도 받아야 한다 (media type은 대소문자 무관)
      const upper = await fetch(url, {
        method: "POST",
        headers: { ...tok, "content-type": "APPLICATION/JSON" },
        body,
      });
      expect(upper.status).not.toBe(415);
      // application/json을 "포함"만 하는 타입은 415
      for (const ct of ["text/json", "application/jsonx", "application/json-patch+json"]) {
        const r = await fetch(url, { method: "POST", headers: { ...tok, "content-type": ct }, body });
        expect(r.status).toBe(415);
      }
      // 배열·문자열·깨진 JSON은 400
      for (const raw of ["[]", '"x"', "not json", "{"]) {
        const r = await fetch(url, {
          method: "POST",
          headers: { ...tok, "content-type": "application/json" },
          body: raw,
        });
        expect(r.status).toBe(400);
      }
    } finally {
    }
  }, 30000);
});
