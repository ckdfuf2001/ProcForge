import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { ProcForgeApp } from "./app.js";
import { loadPairings } from "../services/pairings.js";
import { detectDuplicateStores } from "./store-dir.js";

// M7-1: `procforge ui` 로컬 서버 (어댑터. App 메서드만 호출).
// UI 배선은 M7-1에서 세션 목록+pairings까지, 화면 상호작용은 M7 2~5.

/** 전송계층 무관 (원격 core 모드 동일 동작. inprocess/remote 모두 App 뒤). */
export type UiApp = Pick<ProcForgeApp, "listSessions">;

export type UiServer = {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
};

function err(res: ServerResponse, code: number, msg: string): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message: msg } }));
}

function send(res: ServerResponse, v: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
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

const INDEX_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>ProcForge</title></head>
<body>
<h1>ProcForge</h1>
<div id="store"></div>
<h2>세션</h2>
<table border="1"><thead><tr><th>id</th><th>요청</th><th>rev</th><th>노드</th><th>root</th><th>연결</th><th>짝</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const token = (location.hash.match(/t=([^&]+)/) || [])[1] || "";
const headers = { "x-procforge-token": token };
async function j(p) {
  const r = await fetch(p, { headers });
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}
(async () => {
  try {
    const s = await j("/api/store");
    document.getElementById("store").textContent =
      "저장소: " + s.storeDir + (s.duplicateWarning ? " / 경고: " + s.duplicateWarning : "");
    const { sessions } = await j("/api/sessions");
    document.getElementById("rows").innerHTML = sessions.map((x) =>
      "<tr><td>" + x.sessionId.slice(0, 8) + "</td><td>" + x.request.slice(0, 60) +
      "</td><td>" + x.revision + "</td><td>" + x.nodeCount + "</td><td>" + x.rootStatus +
      "</td><td>" + (x.connectionIds.length > 1 ? "경고:" + x.connectionIds.length + "개" : x.connectionIds.length) +
      "</td><td>" + x.pairings.map((p) => p.openCodeSessionId.slice(0, 8)).join(",") + "</td></tr>",
    ).join("");
  } catch (e) {
    document.body.insertAdjacentHTML("beforeend", "<p>오류: " + e.message + " (URL #t=토큰 확인)</p>");
  }
})();
</script>
</body></html>`;

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
  procforgeDir: string;
  projectRoot: string;
  port?: number;
}): Promise<UiServer> {
  const token = randomBytes(32).toString("hex");
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
        // / 는 정적 골격만 (데이터 없음. 토큰 없이 서빙).
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(INDEX_HTML);
          return;
        }
        // 이후는 토큰 필수 (없음·불일치 401).
        if (!tokenOk(req.headers["x-procforge-token"], token)) {
          err(res, 401, "unauthorized");
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/store") {
          send(res, {
            storeDir: opts.procforgeDir,
            projectRoot: opts.projectRoot,
            duplicateWarning: detectDuplicateStores(
              opts.projectRoot,
              opts.procforgeDir,
            ),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/sessions") {
          send(res, await opts.app.listSessions());
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/pairings") {
          send(res, loadPairings(opts.procforgeDir));
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
