import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcForgeApp } from "./app.js";

// M7-1: `procforge ui` 로컬 서버 (어댑터. App 메서드만 호출).
// UI 배선은 M7-1에서 세션 목록+pairings까지, 화면 상호작용은 M7 2~5.

/** M7-ui1: 어댑터는 App 메서드만 (services/filestore 직접 import 금지) */
export type UiApp = Pick<ProcForgeApp, "listSessions" | "listPairings" | "storeInfo">;

export type UiServer = {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
};

function err(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "content-security-policy": CSP,
  });
  res.end(JSON.stringify({ error: { code, message: msg } }));
}

function send(res: ServerResponse, v: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "content-security-policy": CSP,
  });
  res.end(JSON.stringify(v));
}

/** 토큰 비교 (길이 달라도 timingSafeEqual. 실패는 false) */
function tokenOk(got: unknown, want: string): boolean {
  if (typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** 전 응답 CSP (M7-ui1. 인라인 스크립트 0 — /app.js만 'self') */
const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

const INDEX_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>ProcForge</title></head>
<body>
<h1>ProcForge</h1>
<div id="store"></div>
<h2>세션</h2>
<table border="1"><thead><tr><th>id</th><th>요청</th><th>rev</th><th>노드</th><th>root</th><th>연결</th><th>짝</th></tr></thead>
<tbody id="rows"></tbody></table>
<script src="/app.js"></script>
</body></html>`;

/** 요청문은 textContent로만 (innerHTML 금지 — 요청문 XSS 경로) */
const APP_JS = `(() => {
const token = (location.hash.match(/t=([^&]+)/) || [])[1] || "";
// 토큰은 읽자마자 주소창에서 삭제 (XSS 시 유출 방지).
history.replaceState(null, "", location.pathname);
const headers = { "x-procforge-token": token };
async function j(p) {
  const r = await fetch(p, { headers });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}
function td(text) {
  const el = document.createElement("td");
  el.textContent = text;
  return el;
}
(async () => {
  try {
    const s = await j("/api/store");
    const store = document.getElementById("store");
    store.textContent =
      "store: " + s.storeDir + (s.duplicateWarning ? " / warn: " + s.duplicateWarning : "");
    const { sessions } = await j("/api/sessions");
    const rows = document.getElementById("rows");
    rows.replaceChildren();
    for (const x of sessions) {
      const tr = document.createElement("tr");
      tr.append(
        td(x.sessionId.slice(0, 8)),
        td(x.request.slice(0, 60)),
        td(String(x.revision)),
        td(String(x.nodeCount)),
        td(x.rootStatus),
        td(x.connectionIds.length > 1 ? "warn:" + x.connectionIds.length : String(x.connectionIds.length)),
        td(x.pairings.map((p) => p.openCodeSessionId.slice(0, 8)).join(",")),
      );
      rows.append(tr);
    }
  } catch (e) {
    const p = document.createElement("p");
    p.textContent = "error: " + e.message + " (URL #t=token)";
    document.body.append(p);
  }
})();
})();`;

/** 브라우저 열기 (best-effort. 실패해도 서버는 유지) */
export function openUrl(url: string): void {
  try {
    const cmd =
      process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    spawn(cmd[0], [...cmd[1]], { stdio: "ignore", detached: true }).unref();
  } catch {
    // 무시
  }
}

export async function createUiServer(opts: {
  app: UiApp;
  port?: number;
  /** 테스트용 정적 디렉터리 (미지정 시 packages/ui/dist, 없으면 인라인 골격) */
  staticDir?: string;
}): Promise<UiServer> {
  const token = randomBytes(32).toString("hex");
  // M7-ui1: 빌드 산출물만 정적 서빙 (없으면 인라인 골격 폴백).
  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = opts.staticDir ?? join(here, "..", "..", "..", "ui", "dist");
  const distIndex = join(distDir, "index.html");
  const hasDist = existsSync(distIndex);
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const serveFile = (res: ServerResponse, rel: string): boolean => {
    const p = normalize(join(distDir, rel));
    if (p !== distIndex && !p.startsWith(distDir + sep)) return false;
    try {
      if (!statSync(p).isFile()) return false;
    } catch {
      return false;
    }
    const dot = p.lastIndexOf(".");
    const ext = dot === -1 ? "" : p.slice(dot);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-security-policy": CSP,
    });
    res.end(readFileSync(p));
    return true;
  };
  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const port = (server.address() as { port: number }).port;
        // M7-0 명세: Host/Origin 검사 (DNS rebinding 차단).
        const host = String(req.headers.host ?? "");
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
          err(res, 403, `forbidden host: ${host}`);
          return;
        }
        const origin = req.headers.origin;
        if (
          typeof origin === "string" &&
          origin !== `http://127.0.0.1:${port}` &&
          origin !== `http://localhost:${port}`
        ) {
          err(res, 403, `forbidden origin: ${origin}`);
          return;
        }
        const url = new URL(req.url ?? "/", "http://x");
        // / 는 정적 산출물 (없으면 인라인 골격). 데이터 없음. 토큰 없이 서빙.
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          if (hasDist && serveFile(res, "index.html")) return;
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CSP,
          });
          res.end(INDEX_HTML);
          return;
        }
        // 빌드 에셋 (/assets/* 등. 없으면 폴백 없이 404 — 아래 API 분기 전 처리).
        if (hasDist && req.method === "GET" && !url.pathname.startsWith("/api/")) {
          if (serveFile(res, url.pathname.replace(/^\//, ""))) return;
          if (serveFile(res, "index.html")) return;
          err(res, 404, "not found");
          return;
        }
        if (!hasDist && req.method === "GET" && url.pathname === "/app.js") {
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "content-security-policy": CSP,
          });
          res.end(APP_JS);
          return;
        }
        // 이후는 토큰 필수 (없음·불일치 401).
        if (!tokenOk(req.headers["x-procforge-token"], token)) {
          err(res, 401, "unauthorized");
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/store") {
          send(res, await opts.app.storeInfo());
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/sessions") {
          send(res, await opts.app.listSessions());
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/pairings") {
          send(res, await opts.app.listPairings());
          return;
        }
        err(res, 404, "not found");
      } catch (e) {
        err(res, 500, e instanceof Error ? e.message : String(e));
      }
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
