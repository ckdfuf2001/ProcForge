import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiServer } from "../src/app/ui-server.js";
import { savePairing, loadPairings } from "../src/services/pairings.js";
import { detectDuplicateStores } from "../src/app/store-dir.js";
import { createApp } from "../src/app/bootstrap.js";
import type { ProcForgeApp } from "../src/app/app.js";

// M7-1/ui2: ui 서버 — 보안 3종·세션 목록 계약·pairings·저장소 경고·정적 서빙·
// SSE(순서·재개·heartbeat·구독 정리·상한 429·쿼리 토큰 401)·React 빌드 XSS.

let root: string;
let pfdir: string;
let emptyDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m71ui-"));
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m71uip-")), ".procforge");
  emptyDir = mkdtempSync(join(tmpdir(), "pf-m71uie-"));
});

/** 인라인 골격 강제 (실제 packages/ui/dist 무시) */
function noDist() {
  return { staticDir: emptyDir };
}

const row = {
  sessionId: "11111111-2222-4333-8444-555555555555",
  request: "월간보고서 써줘",
  revision: 3,
  createdAt: "2026-10-16T00:00:00.000Z",
  lastUsedAt: 123,
  nodeCount: 5,
  rootStatus: "needs_human",
  connectionIds: ["c1", "c2"],
  pairings: [{ openCodeSessionId: "oc-1", at: "2026-10-16T00:01:00.000Z" }],
};

type Ev = {
  seq: number;
  revision: number;
  at: string;
  actor: string;
  method: string;
  nodeIds: string[];
  beforeHash: string;
  afterHash: string;
  summary: string;
};

const mkEvent = (revision: number, nodeId: string): Ev => ({
  seq: revision,
  revision,
  at: "2026-10-16T00:00:00.000Z",
  actor: "model",
  method: "pfNext",
  nodeIds: [nodeId],
  beforeHash: "b",
  afterHash: "a",
  summary: `next ${nodeId}`,
});

/** 이벤트 큐를 가진 stub */
function makeStubApp(events: Ev[] = []) {
  const queue = [...events];
  return {
    listSessions: async () => ({ sessions: [row] }),
    listPairings: async () => loadPairings(pfdir),
    storeInfo: async () => ({
      storeDir: pfdir,
      projectRoot: root,
      duplicateWarning: detectDuplicateStores(root, pfdir),
    }),
    getEventsPage: async (i: {
      sessionId: string;
      afterRevision: number;
      limit: number;
    }) => {
      const picked = queue.filter((e) => e.revision > i.afterRevision).slice(0, i.limit);
      const last = queue.length === 0 ? 0 : Math.max(...queue.map((e) => e.revision));
      return { events: picked, lastRevision: last };
    },
    getBlocked: async () => ({
      blocked: [{ nodeId: "1.2", waitingOn: [], reason: "dep_failed" as const }],
      needsHuman: ["1.2"],
      // M7-ui2-e: Last-Event-ID 없는 구독은 현재 revision(=0)부터 시작한다.
      revision: 0,
    }),
    sessionTree: async () => ({
      nodes: [
        {
          id: "1",
          goal: "루트",
          status: "split",
          depth: 0,
          dependsOn: [],
          attempts: 0,
          retriesLeft: 3,
          locked: false,
          sideEffect: "none",
        },
        {
          id: "1.1",
          goal: "가져오기",
          status: "probing",
          depth: 1,
          dependsOn: ["1"],
          attempts: 2,
          retriesLeft: 1,
          locked: false,
          sideEffect: "none",
          staleSince: { revision: 3, causeNodeId: "1" },
        },
      ],
      revision: 4,
    }),
  };
}

function stubServer(events: Ev[] = []) {
  return createUiServer({
    app: makeStubApp(events) as unknown as ProcForgeApp,
    ...noDist(),
    pollMs: 20,
    heartbeatMs: 60,
  });
}

/**
 * SSE 스트림 열기. 반환 객체의 text로 지금까지 받은 바이트를 본다.
 * fetch 스트리밍이라 EventSource를 쓰지 않는다 (M7-ui2 결정).
 */
type SseStream = {
  status: number;
  text: () => string;
  ready: Promise<void>;
  stop: () => void;
};

function openSse(
  url: string,
  opts: { token?: string; lastEventId?: number } = {},
): SseStream {
  const ctrl = new AbortController();
  const stream: SseStream = {
    status: 0,
    text: () => buf,
    ready: Promise.resolve(),
    stop: () => ctrl.abort(),
  };
  let buf = "";
  // ready는 **헤더 수신까지만** resolve 한다 (본문 루프는 백그라운드).
  stream.ready = (async () => {
    const res = await fetch(url, {
      headers: {
        ...(opts.token ? { "x-procforge-token": opts.token } : {}),
        ...(opts.lastEventId !== undefined
          ? { "last-event-id": String(opts.lastEventId) }
          : {}),
      },
      signal: ctrl.signal,
    });
    stream.status = res.status;
    if (!res.ok || !res.body) return;
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch {
        // abort
      }
    })();
  })();
  return stream;
}

async function readSse(
  url: string,
  opts: { token?: string; lastEventId?: number; ms?: number } = {},
): Promise<{ status: number; text: string }> {
  const s = openSse(url, opts);
  await s.ready;
  await new Promise((r) => setTimeout(r, opts.ms ?? 300));
  const out = { status: s.status, text: s.text() };
  s.stop();
  return out;
}

describe("M7-1 ui-server 보안", () => {
  it("토큰 없음·불일치 → 401, 정상 토큰 → 200", async () => {
    const srv = await stubServer();
    try {
      expect((await fetch(`${srv.url}/api/sessions`)).status).toBe(401);
      expect(
        (await fetch(`${srv.url}/api/sessions`, { headers: { "x-procforge-token": "x" } }))
          .status,
      ).toBe(401);
      const r = await fetch(`${srv.url}/api/sessions`, {
        headers: { "x-procforge-token": srv.token },
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it("SSE도 쿼리 토큰으로는 안 된다 (헤더 필수)", async () => {
    const srv = await stubServer([mkEvent(1, "1.1")]);
    try {
      const noToken = await readSse(`${srv.url}/api/sessions/ses/events`, { ms: 150 });
      expect(noToken.status).toBe(401);
      // ?t= 쿼리로 시도해도 401 (쿼리 토큰 금지).
      const query = await readSse(`${srv.url}/api/sessions/ses/events?t=${srv.token}`, {
        ms: 150,
      });
      expect(query.status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});

describe("M7-ui2 SSE", () => {
  it("이벤트 순서·heartbeat·id=revision", async () => {
    const srv = await stubServer([mkEvent(1, "1.1"), mkEvent(2, "1.2")]);
    try {
      const r = await readSse(`${srv.url}/api/sessions/ses/events`, {
        token: srv.token,
        ms: 1200,
      });
      expect(r.status).toBe(200);
      expect(r.text).toContain("id: 1");
      expect(r.text).toContain("id: 2");
      expect(r.text.indexOf('"revision":1')).toBeLessThan(
        r.text.indexOf('"revision":2'),
      );
      expect(r.text).toContain(": hb");
    } finally {
      await srv.close();
    }
  });

  it("Last-Event-ID 재개: 그 뒤 이벤트만", async () => {
    const srv = await stubServer([mkEvent(1, "1.1"), mkEvent(2, "1.2"), mkEvent(3, "1.3")]);
    try {
      const r = await readSse(`${srv.url}/api/sessions/ses/events`, {
        token: srv.token,
        lastEventId: 2,
        ms: 1200,
      });
      expect(r.text).toContain("id: 3");
      expect(r.text).not.toContain('"revision":1');
      expect(r.text).not.toContain('"revision":2');
    } finally {
      await srv.close();
    }
  });

  it("세션당 폴러 1개·구독자 공유, 끊기면 정리", async () => {
    const srv = await stubServer([mkEvent(1, "1.1")]);
    try {
      const a = openSse(`${srv.url}/api/sessions/ses/events`, {
        token: srv.token,
      });
      const b = openSse(`${srv.url}/api/sessions/ses/events`, {
        token: srv.token,
      });
      await Promise.all([a.ready, b.ready]);
      for (let i = 0; i < 40 && srv.subscriberCount("ses") < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(srv.subscriberCount("ses")).toBe(2);
      await new Promise((r) => setTimeout(r, 1200));
      expect(a.text()).toContain("id: 1");
      expect(b.text()).toContain("id: 1");
      a.stop();
      b.stop();
      await new Promise((r) => setTimeout(r, 300));
      expect(srv.subscriberCount("ses")).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("동시 구독 8 초과 → 429", async () => {
    const srv = await stubServer([]);
    try {
      const open: SseStream[] = [];
      for (let i = 0; i < 8; i++) {
        const s = openSse(`${srv.url}/api/sessions/ses/events`, {
          token: srv.token,
        });
        open.push(s);
        await s.ready;
      }
      // 평행 실행에서 ready가 늦을 수 있어 상한까지 대기.
      for (let i = 0; i < 40 && srv.subscriberCount("ses") < 8; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(srv.subscriberCount("ses")).toBe(8);
      const over = await readSse(`${srv.url}/api/sessions/ses/events`, {
        token: srv.token,
        ms: 50,
      });
      expect(over.status).toBe(429);
      for (const s of open) s.stop();
    } finally {
      await srv.close();
    }
  });
});

describe("M7-ui2 트리 API", () => {
  it("노드 요약 + staleSince + blocked (읽기 전용)", async () => {
    const srv = await stubServer();
    try {
      const r = await fetch(`${srv.url}/api/sessions/ses1/tree`, {
        headers: { "x-procforge-token": srv.token },
      });
      const body = (await r.json()) as {
        nodes: {
          nodes: {
            id: string;
            attempts: number;
            staleSince?: { revision: number };
          }[];
        };
        blocked: { needsHuman: string[] };
      };
      expect(body.nodes.nodes[1].attempts).toBe(2);
      expect(body.nodes.nodes[1].staleSince?.revision).toBe(3);
      expect(body.blocked.needsHuman).toEqual(["1.2"]);
    } finally {
      await srv.close();
    }
  });
});

describe("M7-1 ui-server API", () => {
  it("빈 저장소·pairings·저장소 경고", async () => {
    const srv = await stubServer();
    try {
      const store = (await (
        await fetch(`${srv.url}/api/store`, {
          headers: { "x-procforge-token": srv.token },
        })
      ).json()) as { storeDir: string; duplicateWarning: string | null };
      expect(store.storeDir).toBe(pfdir);
      expect(store.duplicateWarning).toBeNull();
      mkdirSync(join(root, ".procforge", "sessions", "s1"), { recursive: true });
      const store2 = (await (
        await fetch(`${srv.url}/api/store`, {
          headers: { "x-procforge-token": srv.token },
        })
      ).json()) as { duplicateWarning: string | null };
      expect(typeof store2.duplicateWarning).toBe("string");
      savePairing(pfdir, "oc-9", "pf-9");
      const p = (await (
        await fetch(`${srv.url}/api/pairings`, {
          headers: { "x-procforge-token": srv.token },
        })
      ).json()) as { pairs: Record<string, { pfSessionId: string }> };
      expect(p.pairs["oc-9"].pfSessionId).toBe("pf-9");
    } finally {
      await srv.close();
    }
  });
});

describe("M7-1 정적 서빙 (React 빌드)", () => {
  /** 실제 packages/ui/dist 가 있으면 그것을, 없으면 모사 빌드를 쓴다 */
  function dist(): string {
    const real = join(import.meta.dirname ?? ".", "..", "..", "ui", "dist");
    try {
      const html = readFileSync(join(real, "index.html"), "utf8");
      if (html.includes("<div id=") || html.includes("root")) return real;
    } catch {
      // 미빌드 → 모사
    }
    const d = mkdtempSync(join(tmpdir(), "pf-m71uid2-"));
    mkdirSync(join(d, "assets"), { recursive: true });
    writeFileSync(join(d, "index.html"), "<html><body><div id=root></div></body></html>");
    writeFileSync(join(d, "assets", "index-abc.js"), 'console.log("built")');
    return d;
  }

  it("빌드 산출물 서빙 + API는 토큰 필요 + 상위 탈출 차단", async () => {
    const d = dist();
    const srv = await createUiServer({
      app: makeStubApp() as unknown as ProcForgeApp,
      staticDir: d,
    });
    try {
      const idx = await fetch(`${srv.url}/`);
      expect(idx.status).toBe(200);
      const html = await idx.text();
      expect(html).toContain('<div id="root"></div>');
      expect(idx.headers.get("content-security-policy")).toContain("script-src 'self'");
      // 스크립트는 토큰 없이 서빙되지만 데이터는 안 나간다.
      const trav = await fetch(`${srv.url}/..%2f..%2fsecret`);
      expect(await trav.text()).toContain("root");
      expect((await fetch(`${srv.url}/api/sessions`)).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("XSS: 요청문 페이로드가 실행 요소로 들어가지 않는다", async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const evilApp = {
      ...makeStubApp(),
      listSessions: async () => ({ sessions: [{ ...row, request: evil }] }),
    };
    const srv = await createUiServer({
      app: evilApp as unknown as ProcForgeApp,
      ...noDist(),
    });
    try {
      const idx = await fetch(`${srv.url}/`);
      const html = await idx.text();
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("<script>");
      // 골격 폴백에도 innerHTML 없음 (React 빌드 전환 후 제거됨).
      const js = await fetch(`${srv.url}/app.js`);
      if (js.status === 200) {
        expect(await js.text()).not.toContain("innerHTML");
      }
      const r = await fetch(`${srv.url}/api/sessions`, {
        headers: { "x-procforge-token": srv.token },
      });
      expect(r.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      const body = (await r.json()) as { sessions: { request: string }[] };
      expect(body.sessions[0].request).toBe(evil);
    } finally {
      await srv.close();
    }
  });
});

describe("M7-1 App.listSessions", () => {
  it("빈 저장소 → []", async () => {
    const { app } = createApp({ procforgeDir: pfdir, projectRoot: root });
    expect(await app.listSessions()).toEqual({ sessions: [] });
  });
});
