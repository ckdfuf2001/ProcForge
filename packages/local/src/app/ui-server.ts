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
import { pfError } from "@procforge/shared/errors.js";
import type { ProcForgeApp } from "./app.js";
import { NODE_HISTORY_MAX } from "./app.js";
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
  | "getDecompositionHistory"
  | "getTreeAt"
  | "sessionTree"
  | "nodeDetail"
  | "artifactContent"
  | "previewEdit"
  | "uiEditArgs"
  | "uiEditNode"
  | "uiAdviseAndSignal"
  | "uiRun"
  | "uiRunCancel"
  | "uiRunLog"
  | "uiRunInfo"
  | "uiLatestRun"
  | "listProcedures"
  | "uiApprovalInfo"
  | "uiApprove"
  | "uiRunApprove"
>;

export type UiServer = {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
  /** 테스트용: 현재 구독 수 */
  subscriberCount: (sessionId: string) => number;
};

/** M7-ui1: 기본 CSP (M7-ui1. 인라인 금지·산출물 렌더 0 → 골격 'self') */
const CSP_BASE =
  "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

/**
 * M7-5-3: 요청별 nonce. style-src 만 nonce 로 연다.
 * - 'unsafe-inline' 은 넣지 않는다 (넣으면 nonce 를 무력화한다).
 * - CodeMirror 가 만든 <style> 태그에도 같은 nonce 를 심고,
 *   화면은 그 값을 EditorView.cspNonce 으로 넘긴다.
 */
function cspFor(nonce?: string): string {
  return nonce === undefined
    ? CSP_BASE
    : `${CSP_BASE}; style-src 'self' 'nonce-${nonce}'`;
}

function freshNonce(): string {
  return randomBytes(16).toString("base64");
}
/** M7-5-3: 응답 객체에 nonce 를 붙인다 (send/err 가 어디서 호출되든 같은 값) */
const NONCES = new WeakMap<ServerResponse, string>();

function cspOf(res: ServerResponse): string {
  return cspFor(NONCES.get(res));
}

/** M7-ui2: 빌드 산출물이 없을 때 (안내만. 스크립트 0 유지) */
const NO_BUILD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>ProcForge</title></head>
<body><main><h1>ProcForge</h1>
<p role="alert">화면 빌드가 없습니다. 저장소에서 <code>pnpm -r build</code> 를 실행한 뒤 다시 열어 주세요.</p>
</main></body></html>`;

function err(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "content-security-policy": cspOf(res),
    // M7-ui4-k: 본문 초과처럼 연결을 끊는 경우에도 헤더가 나가야 한다.
    ...(res.hasHeader("connection") ? { connection: "close" } : {}),
  });
  res.end(JSON.stringify({ error: { code, message: msg } }));
}

function send(res: ServerResponse, v: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "content-security-policy": cspOf(res),
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
  // M7-ui4: 여러 테스트 파일이 각자 서버를 띄우면 Windows loopback의
  // ephemeral 포트가 고갈돼 EACCES가 반복된다. 재시도 예산을 넉넉히 준다.
  left = 14,
): Promise<void> {
  // M7-ui4: 결정이 끝난 뒤 도착하는 late error(재시도 중 발생한 EACCES 등)가
  // unhandled exception으로 프로세스를 죽이지 않게 한다. 진짜 listen 실패는
  // 아래 onError가 reject로 알린다. 리스너는 **한 번만** 붙인다 (재시도마다
  // 쌓이면 MaxListenersExceeded + 새 listen이 붙잡고 있는 상태로 남는다).
  const marked = server as Server & { __pfLateGuard?: boolean };
  if (!marked.__pfLateGuard) {
    marked.__pfLateGuard = true;
    server.on("error", () => {});
    server.setMaxListeners(Math.max(server.getMaxListeners(), 64));
  }
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.removeListener("error", onError);
      if ((e?.code === "EACCES" || e?.code === "EADDRINUSE") && left > 0) {
        // 지수 백오프 (parallel fork에서 listen 경쟁이 잦다).
        const delay = Math.min(2000, 50 * 2 ** (14 - left));
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

/**
 * M7-ui3-a: 경로 파라미터 정규화.
 * 세션·노드·attempt id는 파일명 조각이다. `..`·구분자·빈 값은 **경로로 나오기 전에**
 * 400으로 막는다 — core 검증에 맡기면 client 모드별로 404/500이 갈린다.
 */
function pathId(raw: string, what: string): string {
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    throw pfError("bad_request", `${what} 형식이 잘못되었습니다.`);
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(v) || v.includes("..")) {
    throw pfError("bad_request", `${what} 형식이 잘못되었습니다.`);
  }
  return v;
}

/** M7-ui4: 쓰기 본문 (JSON만) */
/** M7-ui4-e: 쓰기 본문 상한 (1MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/** M7-5-d: 실행 로그 SSE 구독 상한 (run당) */
const RUN_STREAM_MAX_SUBS = 8;

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  // M7-ui4-e: media type을 **정확히** 비교한다 (subtype 불일치·문자열 포함 금지).
  const ct = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct !== "application/json") {
    err(res, 415, "content-type must be application/json");
    return null;
  }
  // M7-ui4-k: content-length로 **사전**에 413. 스트림을 끝까지 읽으면
  // 이미 버퍼에 넣은 만큼 쓰고 나서야 알 수 있다(상한을 넘긴 뒤 거절).
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    err(res, 413, `요청 본문 상한 초과 (${MAX_BODY_BYTES}B)`);
    // 아직 읽지 않은 바디를 버린다 — 버리지 않으면 연결이 붙는다.
    res.setHeader("connection", "close");
    req.resume();
    return null;
  }
  // M7-ui4-e/k: 단일 루프 + 바이트 상한.
  // 주의: `for await (const c of req)` 는 루프를 벗어나면 **스트림을 destroy**
  // 해서 아직 올리고 있는 클라이언트가 ECONNRESET 을 받는다(413 본문을 못 읽음).
  // 그래서 이벤트로 끝까지 소비한 뒤에 판정한다.
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        return; // 더 담지 않는다 (소비는 계속 → 클라이언트가 응답을 읽을 수 있다)
      }
      chunks.push(b);
    });
    req.on("end", () => resolveDrain());
    req.on("error", (e) => rejectDrain(e));
  });
  if (overflow) {
    // M7-ui4-k: 초과를 알렸으니 이 연결은 닫는다(요청은 이미 끝까지 소비했다).
    res.setHeader("connection", "close");
    err(res, 413, `요청 본문 상한 초과 (${MAX_BODY_BYTES}B)`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // M7-ui4-e: JSON 파싱 실패는 400 (조용히 넘어가지 않는다)
    err(res, 400, "요청 본문이 JSON이 아닙니다");
    return null;
  }
  // 배열·null·문자열 같은 비객체는 400 (객체 본문만 받는다)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    err(res, 400, "요청 본문은 JSON 객체여야 합니다");
    return null;
  }
  return parsed as Record<string, unknown>;
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
  const runSubs = new Map<string, number>();
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
    if (ext === ".html" && NONCES.get(res) !== undefined) {
      // M7-5-3: 화면이 <meta> 또는 전역에서 nonce 를 읽을 수 있게 심어준다.
      const html = readFileSync(p, "utf8").replace(
        /<head>/i,
        `<head><meta name="csp-nonce" content="${NONCES.get(res) as string}">`,
      );
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "content-security-policy": cspOf(res),
      });
      res.end(html);
      return true;
    }
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-security-policy": cspOf(res),
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
        // M7-5-3: 이 응답의 nonce (정적 HTML 요청마다 새로 발급)
        // M7-5-3: 이 응답의 nonce (JSON·정적 파일 전부 같은 값)
        NONCES.set(res, freshNonce());
        if (
          req.method === "GET" &&
          (url.pathname === "/" || url.pathname === "/index.html")
        ) {
          if (hasDist && serveFile(res, "index.html")) return;
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": cspOf(res),
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
        // M7-5-4: 실행 화면 — 절차서 목록
        if (req.method === "GET" && url.pathname === "/api/procedures") {
          send(res, await opts.app.listProcedures());
          return;
        }
        // M7-5-4: 실행 결과 (노드별 status 그대로)
        const mRunInfo = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && mRunInfo) {
          send(
            res,
            await opts.app.uiRunInfo({ runId: pathId(mRunInfo[1], "runId") }),
          );
          return;
        }
        // M7-5-4: 새로고침 복원용 — 절차서 또는 세션의 최근 run
        const mLatestRun = /^\/api\/sessions\/([^/]+)\/latest-run$/.exec(url.pathname);
        if (req.method === "GET" && (mLatestRun || url.pathname === "/api/latest-run")) {
          const procedure = url.searchParams.get("procedure") ?? undefined;
          const sessionId = mLatestRun
            ? pathId(mLatestRun[1], "sessionId")
            : (url.searchParams.get("sessionId") ?? undefined);
          send(res, await opts.app.uiLatestRun({ procedure, sessionId }));
          return;
        }
        // M7-ui3: 노드 상세
        const mNode = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && mNode) {
          const sid = pathId(mNode[1], "sessionId");
          const nid = pathId(mNode[2], "nodeId");
          const detail = await opts.app.nodeDetail({ sessionId: sid, nodeId: nid });
          // "왜 이 노드가 이렇게 됐나" — 이 노드 이벤트만 (core 필터).
          const evs = await opts.app.getEventsPage({
            sessionId: sid,
            nodeId: nid,
            afterRevision: 0,
            limit: NODE_HISTORY_MAX,
            // M7-ui4-g: **최신** 200건. 오래된 것부터 자르면 마지막 사건이 사라진다.
            tail: true,
          });
          send(res, { detail, events: evs.events });
          return;
        }
        // M7 5-2: 승인 정보 (스크립트 sha + diff + 현재 approvalHash)
        const mApproval = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)\/approval$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && mApproval) {
          send(
            res,
            await opts.app.uiApprovalInfo({
              sessionId: pathId(mApproval[1], "sessionId"),
              nodeId: pathId(mApproval[2], "nodeId"),
            }),
          );
          return;
        }
        // M8-ui2: 분해 라운드 이력 (읽기 전용)
        const mHistory = /^\/api\/sessions\/([^/]+)\/decomposition-history$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && mHistory) {
          send(
            res,
            await opts.app.getDecompositionHistory({
              sessionId: pathId(mHistory[1], "sessionId"),
            }),
          );
          return;
        }
        // M8-ui2: 특정 revision 시점 트리 (읽기 전용)
        const mTreeAt = /^\/api\/sessions\/([^/]+)\/tree-at$/.exec(url.pathname);
        if (req.method === "GET" && mTreeAt) {
          const revRaw = url.searchParams.get("revision");
          const revision = Number(revRaw);
          if (!Number.isInteger(revision) || revision < 0) {
            err(res, 400, "revision은 0 이상의 정수여야 한다");
            return;
          }
          send(
            res,
            await opts.app.getTreeAt({
              sessionId: pathId(mTreeAt[1], "sessionId"),
              revision,
            }),
          );
          return;
        }
        // M7-ui3-a: attempt 산출물 전문 (경로는 core가 정한다. 텍스트·nosniff·attachment)
        const mArt = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)\/artifacts\/([^/]+)\/(\d+)$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && mArt) {
          const sid = pathId(mArt[1], "sessionId");
          const nid = pathId(mArt[2], "nodeId");
          const aid = pathId(mArt[3], "attemptId");
          const content = await opts.app.artifactContent({
            sessionId: sid,
            nodeId: nid,
            attemptId: aid,
            index: Number(mArt[4]),
          });
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
            // basename + filename* (UTF-8). 경로는 절대 넣지 않는다.
            "content-disposition": `attachment; filename="${content.downloadName}"; filename*=UTF-8''${encodeURIComponent(content.downloadName)}`,
            "content-security-policy": cspOf(res),
          });
          res.end(content.bytes);
          return;
        }
        // M7-ui4: 쓰기 — POST + JSON만. expectedRevision 필수.
        if (req.method === "POST") {
          // M7 5-1: 실행 시작/취소는 세션 경로가 아니라 별도 경로다
          if (
            url.pathname === "/api/runs" ||
            /^\/api\/runs\/[^/]+\/(cancel|approve)$/.test(url.pathname)
          ) {
            const body = (await readJsonBody(req, res)) ?? {};
            if (url.pathname === "/api/runs") {
              // 원본 본문을 그대로 넘긴다 — App이 주입 키를 검증한다
              // (여기서 골라내면 400이 아니라 조용히 무시된다).
              send(res, await opts.app.uiRun(body as never));
              return;
            }
            const runId = pathId(url.pathname.split("/")[3] ?? "", "runId");
            if (url.pathname.endsWith("/cancel")) {
              send(res, await opts.app.uiRunCancel({ runId }));
              return;
            }
            // M7-close-a: 실행 external 승인
            if (typeof body.nodeId !== "string" || body.nodeId === "") {
              err(res, 400, "nodeId 필수");
              return;
            }
            if (typeof body.approvalHash !== "string" || body.approvalHash === "") {
              err(res, 400, "approvalHash 필수 (M7-5-2)");
              return;
            }
            if (!Number.isInteger(body.expectedRevision)) {
              err(res, 400, "expectedRevision 필수");
              return;
            }
            send(
              res,
              await opts.app.uiRunApprove({
                runId,
                nodeId: body.nodeId,
                approvalHash: body.approvalHash,
                ...(typeof body.approved === "boolean"
                  ? { approved: body.approved }
                  : { approved: undefined as unknown as boolean }),
                expectedRevision: body.expectedRevision as number,
                ...(body.note !== undefined ? { note: String(body.note) } : {}),
                ...(Array.isArray(body.allowWildcard)
                  ? {
                      allowWildcard: body.allowWildcard.filter(
                        (k): k is string => typeof k === "string",
                      ),
                    }
                  : {}),
              }),
            );
            return;
          }
          const mApprove = /^\/api\/sessions\/([^/]+)\/nodes\/([^/]+)\/approve$/.exec(
            url.pathname,
          );
          if (mApprove) {
            const body = (await readJsonBody(req, res)) ?? {};
            if (typeof body.approvalHash !== "string" || body.approvalHash === "") {
              err(res, 400, "approvalHash 필수 (M7-5-2)");
              return;
            }
            send(
              res,
              await opts.app.uiApprove({
                sessionId: pathId(mApprove[1], "sessionId"),
                nodeId: pathId(mApprove[2], "nodeId"),
                approvalHash: String(body.approvalHash),
                // M7-5-i: 생략을 승인으로 보지 않는다 — 필수 boolean, 없으면 400
                ...(typeof body.approved === "boolean"
                  ? { approved: body.approved }
                  : { approved: undefined as unknown as boolean }),
                ...(body.note !== undefined ? { note: String(body.note) } : {}),
                ...(Array.isArray(body.allowWildcard)
                  ? { allowWildcard: body.allowWildcard.map(String) }
                  : {}),
                expectedRevision: Number(body.expectedRevision),
              }),
            );
            return;
          }
          const sidFromPath = /^\/api\/sessions\/([^/]+)\/(preview-edit|advise-and-signal|edit-args|edit-node)$/.exec(
            url.pathname,
          );
          if (sidFromPath) {
            const sid = pathId(sidFromPath[1], "sessionId");
            const body = await readJsonBody(req, res);
            if (body === null) return;
            const expected = body.expectedRevision;
            if (!Number.isInteger(expected)) {
              err(res, 400, "expectedRevision 필수");
              return;
            }
            if (sidFromPath[2] === "preview-edit") {
              send(
                res,
                await opts.app.previewEdit({
                  sessionId: sid,
                  nodeId: String(body.nodeId ?? ""),
                  change: (body.change ?? {}) as never,
                }),
              );
              return;
            }
            if (sidFromPath[2] === "edit-args") {
              send(
                res,
                await opts.app.uiEditArgs({
                  sessionId: sid,
                  nodeId: String(body.nodeId ?? ""),
                  patch: (body.patch ?? {}) as never,
                  expectedRevision: expected as number,
                }),
              );
              return;
            }
            if (sidFromPath[2] === "edit-node") {
              send(
                res,
                await opts.app.uiEditNode({
                  sessionId: sid,
                  nodeId: String(body.nodeId ?? ""),
                  ...(body.goal !== undefined ? { goal: String(body.goal) } : {}),
                  ...(body.addConstraints !== undefined
                    ? { addConstraints: body.addConstraints as never }
                    : {}),
                  ...(body.removeConstraintIds !== undefined
                    ? { removeConstraintIds: (body.removeConstraintIds as string[]) }
                    : {}),
                  ...(body.dependsOn !== undefined
                    ? { dependsOn: body.dependsOn as string[] }
                    : {}),
                  expectedRevision: expected as number,
                }),
              );
              return;
            }
            // advise-and-signal
            // M7-ui4-b/i: 본문으로 신호 대상(baseUrl·mode·openCodeSessionId)이나
            // 버전·타임아웃을 지정하려 하면 400 — 무시하면 조용히 다른 주소로
            // 갈 수 있다.
            const forbidden = ["link", "baseUrl", "mode", "serverVersion", "timeoutMs"];
            const used = forbidden.filter((k) => body[k] !== undefined);
            if (used.length > 0) {
              err(res, 400, `${used.join(",")} 는 서버 설정에서만 결정됩니다`);
              return;
            }
            send(
              res,
              await opts.app.uiAdviseAndSignal({
                sessionId: sid,
                nodeId: String(body.nodeId ?? ""),
                text: String(body.text ?? ""),
                expectedRevision: expected as number,
                ...(body.signal === false ? { signal: false } : {}),
              }),
            );
            return;
          }
          err(res, 404, "not found");
          return;
        }
        // M7 5-1: 실행 로그 SSE (토큰 헤더 필수)
        const mRunStream = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
        if (req.method === "GET" && mRunStream) {
          const runId = pathId(mRunStream[1], "runId");
          // M7-5-d: SSE 규칙을 그대로 적용 — 구독 상한·heartbeat·id(재연결).
          // 상한은 **헤더를 쓰기 전에** 판정한다 (429가 200 뒤에 붙으면 안 된다).
          if ((runSubs.get(runId) ?? 0) >= RUN_STREAM_MAX_SUBS) {
            err(res, 429, `구독자 초과 (run당 ${RUN_STREAM_MAX_SUBS}명)`);
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-security-policy": cspOf(res),
          });
          res.flushHeaders();
          runSubs.set(runId, (runSubs.get(runId) ?? 0) + 1);
          let closed = false;
          let after = Number(req.headers["last-event-id"] ?? 0) || 0;
          const stop = (): void => {
            closed = true;
            runSubs.set(runId, Math.max(0, (runSubs.get(runId) ?? 1) - 1));
          };
          res.on("close", stop);
          const pollMs = opts.pollMs ?? 800;
          const beatMs = opts.heartbeatMs ?? 15000;
          let lastBeat = Date.now();
          const tick = async (): Promise<void> => {
            if (closed) return;
            try {
              const page = await opts.app.uiRunLog({ runId, afterSeq: after });
              for (const e of page.entries) {
                after = e.seq;
                // 로그 본문은 SSE 데이터로 — 화면은 textContent로만 렌더한다
                res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
              }
              // 종료 상태에서만 스트림을 닫는다. suspended/ready 는 아직
              // 진행 중(승인·생성값 대기)이므로 계속 구독한다 (M7-close-a).
              const terminal =
                page.status === "done" ||
                page.status === "failed" ||
                page.status === "cancelled";
              if (terminal) {
                res.write(
                  `event: end\ndata: ${JSON.stringify({ runId, status: page.status })}\n\n`,
                );
                res.end();
                return;
              }
              if (Date.now() - lastBeat > beatMs) {
                lastBeat = Date.now();
                res.write(`: heartbeat\n\n`);
              }
            } catch (e) {
              res.write(`event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`);
              res.end();
              return;
            }
            setTimeout(() => void tick(), pollMs);
          };
          void tick();
          return;
        }
        // M7-ui2: 세션 트리 (읽기 전용)
        const mTree = /^\/api\/sessions\/([^/]+)\/tree$/.exec(url.pathname);
        if (req.method === "GET" && mTree) {
          const sid = pathId(mTree[1], "sessionId");
          const nodes = await opts.app.sessionTree({ sessionId: sid });
          const blocked = await opts.app.getBlocked({ sessionId: sid });
          send(res, { nodes, blocked });
          return;
        }
        // M7-ui2: 세션 이벤트 SSE (토큰 헤더 필수. 쿼리 토큰 금지)
        const mEvents = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
        if (req.method === "GET" && mEvents) {
          const sid = pathId(mEvents[1], "sessionId");
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
            "content-security-policy": cspOf(res),
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
        // M7-ui4-k: 이미 응답을 보낸 경우(413 등)에는 다시 쓰지 않는다 —
        // "Cannot write headers after they are sent" unhandled rejection이 된다.
        if (res.headersSent || res.writableEnded) {
          res.end();
          return;
        }
        // pfError 코드는 HTTP로 매핑. M7-ui3-d: session_not_found도 404.
        const code = (e as { code?: unknown }).code;
        const status =
          code === "bad_request"
            ? 400
            : code === "not_found" || code === "session_not_found"
              ? 404
              : code === "conflict"
                ? 409
                : 500;
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
