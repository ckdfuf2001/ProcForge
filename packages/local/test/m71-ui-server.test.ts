import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { createUiServer } from "../src/app/ui-server.js";
import { savePairing, loadPairings } from "../src/services/pairings.js";
import { detectDuplicateStores } from "../src/app/store-dir.js";
import { createApp } from "../src/app/bootstrap.js";

// M7-1: `procforge ui` 서버 — 보안 3종·세션 목록 계약·pairings·저장소 경고.

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m71ui-"));
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m71uip-")), ".procforge");
});

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

const stubApp = {
  listSessions: async () => ({ sessions: [row] }),
  listPairings: async () => loadPairings(pfdir),
  storeInfo: async () => ({
    storeDir: pfdir,
    projectRoot: root,
    duplicateWarning: detectDuplicateStores(root, pfdir),
  }),
};

/** Host/Origin을 직접 제어하는 raw HTTP (fetch는 Host伪造 불가) */
function raw(
  port: number,
  opts: { host?: string; origin?: string; token?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  const path = opts.path ?? "/api/sessions";
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
        "Connection: close",
      ];
      if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
      if (opts.token !== undefined) lines.push(`x-procforge-token: ${opts.token}`);
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let buf = "";
    s.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
    });
    s.on("end", () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      const body = buf.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      resolve({ status: m ? Number(m[1]) : 0, body });
    });
    s.on("error", reject);
  });
}

describe("M7-1 ui-server 보안", () => {
  it("토큰 없음·불일치 → 401, 정상 토큰 → 200", async () => {
    const srv = await createUiServer({ app: stubApp });
    try {
      expect((await raw(srv.port)).status).toBe(401);
      expect((await raw(srv.port, { token: "wrong" })).status).toBe(401);
      const r = await fetch(`${srv.url}/api/sessions`, {
        headers: { "x-procforge-token": srv.token },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sessions: unknown[] };
      expect(body.sessions).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it("Host 불일치 → 403 (DNS rebinding 차단)", async () => {
    const srv = await createUiServer({ app: stubApp });
    try {
      const r = await raw(srv.port, { host: "evil.com", token: srv.token });
      expect(r.status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it("Origin 불일치 → 403, 정상 Origin → 200", async () => {
    const srv = await createUiServer({ app: stubApp });
    try {
      const bad = await raw(srv.port, {
        token: srv.token,
        origin: "http://evil.com",
      });
      expect(bad.status).toBe(403);
      const ok = await raw(srv.port, {
        token: srv.token,
        origin: `http://127.0.0.1:${srv.port}`,
      });
      expect(ok.status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("/ 는 토큰 없이 정적 골격만 (데이터 없음)", async () => {
    const srv = await createUiServer({ app: stubApp });
    try {
      const r = await raw(srv.port, { path: "/" });
      expect(r.status).toBe(200);
      expect(r.body).toContain("ProcForge");
      expect(r.body).not.toContain("월간보고서");
    } finally {
      await srv.close();
    }
  });

  it("XSS: 요청문 페이로드가 실행 요소로 들어가지 않음 + CSP", async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const evilApp = {
      listSessions: async () => ({ sessions: [{ ...row, request: evil }] }),
    };
    const srv = await createUiServer({ app: evilApp });
    try {
      // / : 인라인 스크립트 0 (/app.js만), 페이로드 없음, CSP 있음.
      const idx = await fetch(`${srv.url}/`);
      expect(idx.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = await idx.text();
      expect(html).not.toContain("<script>");
      expect(html).toContain('<script src="/app.js"></script>');
      expect(html).not.toContain("onerror");
      // /app.js: innerHTML 0, 토큰 fragment 즉시 삭제.
      const js = await (await fetch(`${srv.url}/app.js`)).text();
      expect(js).not.toContain("innerHTML");
      expect(js).toContain("textContent");
      expect(js).toContain("history.replaceState");
      // /api/sessions: JSON 데이터로만 전달 (문서 문맥 아님).
      const r = await fetch(`${srv.url}/api/sessions`, {
        headers: { "x-procforge-token": srv.token },
      });
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const body = (await r.json()) as { sessions: { request: string }[] };
      expect(body.sessions[0].request).toBe(evil);
    } finally {
      await srv.close();
    }
  });
});

describe("M7-1 ui-server API", () => {
  async function authed(srv: { url: string; token: string }, path: string) {
    const r = await fetch(`${srv.url}${path}`, {
      headers: { "x-procforge-token": srv.token },
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<Record<string, unknown>>;
  }

  it("세션 목록 계약 + 저장소 경로 + 경고 없음", async () => {
    const srv = await createUiServer({ app: stubApp });
    try {
      const body = await authed(srv, "/api/sessions");
      expect(body.sessions).toEqual([row]);
      const store = await authed(srv, "/api/store");
      expect(store.storeDir).toBe(pfdir);
      expect(store.duplicateWarning).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("저장소 2개 감지 시 경고", async () => {
    mkdirSync(join(root, ".procforge", "sessions", "s1"), { recursive: true });
    const srv = await createUiServer({ app: stubApp });
    try {
      const store = await authed(srv, "/api/store");
      expect(typeof store.duplicateWarning).toBe("string");
    } finally {
      await srv.close();
    }
  });

  it("pairings 원본 반환", async () => {
    savePairing(pfdir, "oc-9", "pf-9");
    const srv = await createUiServer({ app: stubApp });
    try {
      const body = await authed(srv, "/api/pairings");
      const pairs = body.pairs as Record<string, { pfSessionId: string }>;
      expect(pairs["oc-9"].pfSessionId).toBe("pf-9");
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

  it("start 후 1행 (요청문·revision·노드 수·짝)", async () => {
    const { app } = createApp({ procforgeDir: pfdir, projectRoot: root });
    const started = await app.start({ request: "ui-test", toolCatalog: [] });
    savePairing(pfdir, "oc-1", started.sessionId);
    const { sessions } = await app.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(started.sessionId);
    expect(sessions[0].request).toBe("ui-test");
    expect(sessions[0].revision).toBe(0);
    expect(sessions[0].nodeCount).toBeGreaterThan(0);
    expect(sessions[0].connectionIds).toEqual([]);
    expect(sessions[0].pairings.map((p) => p.openCodeSessionId)).toEqual(["oc-1"]);
  });
});
