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
import { SessionEventHub, MAX_SUBS_PER_SESSION } from "./events-hub.js";

// M7-1: `procforge ui` 로컬 서버 (어댑터. App 메서드만 호출).
// M7-ui1: 보안·세션 목록·pairings·정적 서빙. M7-ui2: 세션 트리 + SSE.

/** M7-ui1: 어댑터는 App 메서드만 (services/filestore 직접 import 금지) */
export type UiApp = Pick<
  ProcForgeApp,
  | "listSessions"
  | "listPairings"
  | "storeInfo"
  | "getEventsPage"
  | "getBlocked"
  | "sessionTree"
  | "nodeDetail"
  | "artifactContent"
>;

export type UiServer = {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
  /** 테스트용: 현재 구독 수 */
  subscriberCount: (sessionId: string) => number;
};

/** 전 응답 CSP (M7-ui1. 인라인 스크립트 0 — 번들만 'self') */
const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

/** M7-ui2: 빌드 산출물이 없을 때 (안내만. 스크립트 0 유지) */
const NO_BUILD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>ProcForge</title></head>
<body><main><h1>ProcForge</h1>
<p role="alert">화면 빌드가 없습니다. 저장소에서 <code>pnpm -r build</code> 를 실행한 뒤 다시 열어 주세요.</p>
</main></body></html>`;

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

/**
 * listen. M6.1-3과 같은 이유로 Windows loopback listen EACCES가 재현된다
 * (ephemeral 포트 재사용 + TIME_WAIT). bind는 멱등이라 listen만 재시도.
 */
function listenWithRetry(
  server: Server,
  port: number,
  left = 8,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.removeListener("error", onError);
      if ((e?.code === "EACCES" || e?.code === "EADDRINUSE") && left > 0) {
        // 지수 백오프 (parallel fork에서 listen 경쟁이 잦다).
        const delay = Math.min(1000, 50 * 2 ** (8 - left));
        setTimeout(
          () => listenWithRetry(server, port, left - 1).then(resolve, reject),
          delay,
        );
      } else {
        reject(e);
      }
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

export async function createUiServer(opts: {
  app: UiApp;
  port?: number;
  /** 테스트용 정적 디렉터리 (미지정 시 packages/ui/dist) */
  staticDir?: string;
  /** SSE 폴러 주기·heartbeat (테스트 단축용) */
  pollMs?: number;
  heartbeatMs?: number;
}): Promise<UiServer> {
  const token = randomBytes(32).toString("hex");
  // M7-ui2: 세션 이벤트 hub (App.getEventsPage 폴러 1개를 구독자들에 공유).
  const hub = new SessionEventHub({
    fetchEvents: (i) => opts.app.getEventsPage(i),
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  // M7-ui1: 빌드 산출물만 정적 서빙 (없으면 안내만).
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
        // 화면 = React 빌드 산출물만 (골격 경로 제거). 데이터 없음.
        if (
          req.method === "GET" &&
          (url.pathname === "/" || url.pathname === "/index.html")
        ) {
          if (hasDist && serveFile(res, "index.html")) return;
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CSP,
          });
          res.end(NO_BUILD_HTML);
          return;
        }
        // 빌드 에셋 (/assets/* 등).
        if (hasDist && req.method === "GET" && !url.pathname.startsWith("/api/")) {
          if (serveFile(res, url.pathname.replace(/^\//, ""))) return;
          if (serveFile(res, "index.html")) return;
          err(res, 404, "not found");
          return;
        }
        // 이후는 토큰 필수 (없음·불일치 401). 쿼리 토큰은 받지 않는다.
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
        // M7-ui3: 노드 상세
        const mNode = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && mNode) {
          const sid = decodeURIComponent(mNode[1]);
          const nid = decodeURIComponent(mNode[2]);
          const detail = await opts.app.nodeDetail({ sessionId: sid, nodeId: nid });
          // "왜 이 노드가 이렇게 됐나" — 이 노드 이벤트만 (core 필터).
          const evs = await opts.app.getEventsPage({
            sessionId: sid,
            nodeId: nid,
            afterRevision: 0,
            limit: 200,
          });
          send(res, { detail, events: evs.events });
          return;
        }
        // M7-ui3: 산출물 전문 (로컬 전용. text/plain + nosniff + attachment)
        const mArt = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)\/artifacts\/(.+)$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && mArt) {
          const sid = decodeURIComponent(mArt[1]);
          const rel = decodeURIComponent(mArt[3]);
          const content = await opts.app.artifactContent({
            sessionId: sid,
            rel,
          });
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
            "content-disposition": `attachment; filename="${rel.replace(/["\\]/g, "_")}"`,
            "content-security-policy": CSP,
          });
          res.end(content.bytes);
          return;
        }
        // M7-ui2: 세션 트리 (읽기 전용)
        const mTree = /^\/api\/sessions\/([^/]+)\/tree$/.exec(url.pathname);
        if (req.method === "GET" && mTree) {
          const sid = decodeURIComponent(mTree[1]);
          const nodes = await opts.app.sessionTree({ sessionId: sid });
          const blocked = await opts.app.getBlocked({ sessionId: sid });
          send(res, { nodes, blocked });
          return;
        }
        // M7-ui2: 세션 이벤트 SSE (토큰 헤더 필수. 쿼리 토큰 금지)
        const mEvents = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
        if (req.method === "GET" && mEvents) {
          const sid = decodeURIComponent(mEvents[1]);
          // M7-ui2-e: Last-Event-ID가 없으면 **현재 revision부터** (전체 이력 재전송 금지).
          let startRevision: number;
          const raw = req.headers["last-event-id"];
          if (raw === undefined) {
            try {
              startRevision = (await opts.app.getBlocked({ sessionId: sid })).revision;
            } catch {
              startRevision = 0;
            }
          } else {
            const n = Number(raw);
            startRevision = Number.isFinite(n) && n > 0 ? n : 0;
          }
          // 상한은 헤더를 쓰기 전에 판정한다 (429가 200 뒤에 붙으면 안 됨).
          if (hub.atCapacity(sid)) {
            err(res, 429, `구독자 초과 (세션당 ${MAX_SUBS_PER_SESSION}명)`);
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-security-policy": CSP,
          });
          // 헤더를 즉시 내보내야 클라 fetch가 resolve 된다 (버퍼에 갇히면 hang).
          res.flushHeaders();
          const sub = hub.subscribe(
            sid,
            startRevision,
            (chunk) => res.write(chunk),
            () => res.end(),
          );
          if (!sub.ok) {
            res.end();
            return;
          }
          // NOTE: req("close")는 요청 스트림 종료 시점에 바로 난다 (GET 본문 없음).
          // 응답 연결이 끊길 때 정리하려면 res("close")를 봐야 한다.
          let cleaned = false;
          const drop = () => {
            if (cleaned) return;
            cleaned = true;
            hub.unsubscribe(sid, sub.id);
          };
          res.on("close", drop);
          res.on("error", drop);
          res.on("finish", drop);
          return;
        }
        err(res, 404, "not found");
      } catch (e) {
        // pfError 코드는 HTTP로 매핑 (bad_request 400 · not_found 404).
        const code = (e as { code?: unknown }).code;
        const status =
          code === "bad_request" ? 400 : code === "not_found" ? 404 : 500;
        err(res, status, e instanceof Error ? e.message : String(e));
      }
    },
  );
  await listenWithRetry(server, opts.port ?? 0);
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    subscriberCount: (sid) => hub.count(sid),
    close: () =>
      new Promise<void>((r) => {
        hub.stopAll();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}