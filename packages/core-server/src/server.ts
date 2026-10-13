import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { CoreService } from "@procforge/core";
import { FileStore } from "@procforge/shared/filestore.js";
import { baseEvaluate } from "@procforge/shared/check.js";
import {
  WireMethods,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  checkProtocolVersion,
  toWireError,
  type WireMethodName,
} from "@procforge/shared/wire.js";

// M6-2: 원격 core HTTP 서버. CoreClient 1:1 엔드포인트 (shared/wire.ts 계약).
// 테넌트별 FileStore (dataDir/tenants/<tid>), Bearer API 키, 버전 헤더 검사.
// 평가는 fs 없는 shared 판정기 (local checker와 동일 로직, fs 2종은 deferred).

export type TenantKeys = Map<string, string>;

const TID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BODY_LIMIT = 32 * 1024 * 1024;

/** "tid:key,tid2:key2" 또는 bare "key"(= tenant "default") 파싱. */
export function parseApiKeys(raw: string | undefined): TenantKeys {
  const out = new Map<string, string>();
  for (const part of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const i = part.indexOf(":");
    const tid = i === -1 ? "default" : part.slice(0, i);
    const key = i === -1 ? part : part.slice(i + 1);
    if (!TID_RE.test(tid)) throw new Error(`bad tenant id: ${tid}`);
    if (key.length === 0) throw new Error(`empty api key for tenant: ${tid}`);
    if (out.has(key)) throw new Error("duplicate api key");
    out.set(key, tid);
  }
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(
          Object.assign(new Error("body too large"), { code: "bad_request" }),
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function statusFor(code: string): number {
  if (code === "unauthorized") return 401;
  if (code === "conflict") return 409;
  if (
    code === "bad_request" ||
    code === "bad_args" ||
    code === "not_found" ||
    code === "session_not_found"
  )
    return 400;
  return 500;
}

async function dispatch(
  svc: CoreService,
  name: WireMethodName,
  body: Record<string, unknown>,
): Promise<unknown> {
  const b = body;
  switch (name) {
    case "pfStart":
      return svc.pfStart(b as never);
    case "pfNext":
      return svc.pfNext(b as never);
    case "pfReport":
      return svc.pfReport(b as never);
    case "pfResolve":
      return svc.pfResolve(b as never);
    case "pfAdvise":
      return svc.pfAdvise(b as never);
    case "pfTree":
      return svc.pfTree((b as { sessionId: string }).sessionId);
    case "pfLock":
      return svc.pfLock(b as never);
    case "pfReopen":
      return svc.pfReopen(b as never);
    case "amendAttemptArtifacts":
      return svc.amendAttemptArtifacts(b as never);
    case "pfUpdateCatalog":
      return svc.pfUpdateCatalog(b as never);
    case "pfEditArgs":
      return svc.pfEditArgs(b as never);
    case "pfEditNode":
      return svc.pfEditNode(b as never);
    case "getEvents": {
      const g = b as { sessionId: string; sinceSeq?: number };
      return svc.getEvents(g.sessionId, g.sinceSeq);
    }
    case "getSession":
      return svc.getSession((b as { sessionId: string }).sessionId);
    case "getNode": {
      const g = b as { sessionId: string; nodeId: string };
      return svc.getNode(g.sessionId, g.nodeId);
    }
    case "pfBuildProcedure": {
      const g = b as { sessionId: string; name: string };
      return svc.pfBuildProcedure(g.sessionId, g.name);
    }
    case "pfApprove":
      return svc.pfApprove(b as never);
    default: {
      const _exhaustive: never = name;
      throw new Error(`unimplemented: ${_exhaustive}`);
    }
  }
}

export function createCoreServer(opts: {
  dataDir: string;
  apiKeys: TenantKeys;
}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, version: PROTOCOL_VERSION });
      }
      const name = (Object.keys(WireMethods) as WireMethodName[]).find(
        (k) => WireMethods[k].path === url.pathname,
      );
      if (req.method !== "POST" || !name) {
        return send(res, 404, {
          ok: false,
          error: {
            code: "not_found",
            message: `unknown endpoint: ${url.pathname}`,
          },
        });
      }
      try {
        checkProtocolVersion(
          req.headers[PROTOCOL_VERSION_HEADER] as string | undefined,
        );
      } catch (e) {
        const w = toWireError(e);
        return send(res, 409, { ok: false, error: w });
      }
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      const tid = m ? opts.apiKeys.get(m[1]) : undefined;
      if (!tid) {
        return send(res, 401, {
          ok: false,
          error: {
            code: "unauthorized",
            message: "API 키 필요 (Authorization: Bearer)",
            hint: "API 키 확인",
          },
        });
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e) {
        const w = toWireError(e);
        return send(res, statusFor(w.code), { ok: false, error: w });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, {
          ok: false,
          error: { code: "bad_request", message: "JSON 파싱 실패" },
        });
      }
      const def = WireMethods[name];
      const parsed = def.input.safeParse(body);
      if (!parsed.success) {
        return send(res, 400, {
          ok: false,
          error: {
            code: "bad_request",
            message: `입력 검증 실패: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          },
        });
      }
      const store = new FileStore(join(opts.dataDir, "tenants", tid));
      const svc = new CoreService(store, baseEvaluate);
      const out = await dispatch(
        svc,
        name,
        parsed.data as Record<string, unknown>,
      );
      const ovalid = def.output.safeParse(out);
      if (!ovalid.success) {
        return send(res, 500, {
          ok: false,
          error: toWireError(new Error("internal")),
        });
      }
      return send(res, 200, { ok: true, data: out });
    } catch (e) {
      const w = toWireError(e);
      return send(res, statusFor(w.code), { ok: false, error: w });
    }
  });
}

/** 테스트·CLI용 기동. 포트 0이면 자동 할당 후 실제 포트 반환.
 * Windows loopback 순간 고갈(EACCES)은 짧게 재시도 후 전달. */
export function startServer(opts: {
  dataDir: string;
  apiKeys: TenantKeys;
  port?: number;
  host?: string;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const attempt = (
    left: number,
  ): Promise<{ server: Server; port: number; close: () => Promise<void> }> => {
    const server = createCoreServer(opts);
    return new Promise((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e?.code === "EACCES" && left > 0) {
          setTimeout(() => attempt(left - 1).then(resolve, reject), 200);
        } else {
          reject(e);
        }
      });
      server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
        const addr = server.address();
        const port =
          typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
        resolve({
          server,
          port,
          close: () =>
            new Promise<void>((res2, rej2) =>
              server.close((e) => (e ? rej2(e) : res2())),
            ),
        });
      });
    });
  };
  return attempt(5);
}
