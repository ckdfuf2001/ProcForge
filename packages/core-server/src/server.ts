import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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

export type TenantKeys = { tid: string; hash: Buffer }[];

const TID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BODY_LIMIT = 32 * 1024 * 1024;

function keyHash(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** "tid:key,tid2:key2" 또는 bare "key"(= tenant "default") 파싱. 키는 해시만 보관. */
export function parseApiKeys(raw: string | undefined): TenantKeys {
  const out: TenantKeys = [];
  for (const part of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const i = part.indexOf(":");
    const tid = i === -1 ? "default" : part.slice(0, i);
    const key = i === -1 ? part : part.slice(i + 1);
    if (!TID_RE.test(tid)) throw new Error(`bad tenant id: ${tid}`);
    if (key.length === 0) throw new Error(`empty api key for tenant: ${tid}`);
    const hash = keyHash(key);
    if (
      out.some(
        (e) => e.hash.length === hash.length && timingSafeEqual(e.hash, hash),
      )
    )
      throw new Error("duplicate api key");
    out.push({ tid, hash });
  }
  return out;
}

/**
 * Bearer 키 → 테넌트. 해시 비교는 timingSafeEqual.
 * default 테넌트(bare 키 포함)는 PROCFORGE_DEV_AUTH=1에서만 허용.
 */
export function findTenant(
  keys: TenantKeys,
  presented: string,
): string | undefined {
  const h = keyHash(presented);
  for (const e of keys) {
    if (e.hash.length !== h.length) continue;
    if (!timingSafeEqual(e.hash, h)) continue;
    if (e.tid === "default" && process.env.PROCFORGE_DEV_AUTH !== "1")
      return undefined;
    return e.tid;
  }
  return undefined;
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
    case "getSessions":
      return svc.getSessions();
    case "getEventsPage":
      return svc.getEventsPage(b as never);
    case "getBlocked":
      return svc.getBlocked(b as never);
    case "previewEdit":
      return svc.previewEdit(b as never);
    case "pfBuildProcedure": {
      const g = b as { sessionId: string; name: string };
      return svc.pfBuildProcedure(g.sessionId, g.name);
    }
    case "pfApprove":
      return svc.pfApprove(b as never);
    case "pfImportProcedure":
      return svc.pfImportProcedure(b as never);
    case "pfWriteGolden":
      return svc.pfWriteGolden(b as never);
    default: {
      const _exhaustive: never = name;
      throw new Error(`unimplemented: ${_exhaustive}`);
    }
  }
}

export function createCoreServer(opts: {
  dataDir: string;
  apiKeys: TenantKeys;
  sessionTtlMs?: number;
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
      const tid = m ? findTenant(opts.apiKeys, m[1]) : undefined;
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
      const svc = new CoreService(store, baseEvaluate, {
        sessionTtlMs: opts.sessionTtlMs,
      });
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
 * M6.1-3 실험: 포트 0만으로 부족하다. Windows에서 listen EACCES가 재현
 * 되므로 listen만 재시도한다 (bind는 멱등·안전).
 * 어서션 재시도(withNetRetry·fetchRetry)는 제거 유지.
 * EACCES 정체는 SO_EXCLUSIVEADDRUSE + TIME_WAIT 충돌이 유력
 * (ephemeral 재사용 시 EACCES가 EADDRINUSE 대신 나온다). loopback
 * 테스트 서버라 exclusive:false로 TIME_WAIT 충돌을 허용한다. */
export function startServer(opts: {
  dataDir: string;
  apiKeys: TenantKeys;
  port?: number;
  host?: string;
  sessionTtlMs?: number;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const attempt = (
    left: number,
  ): Promise<{ server: Server; port: number; close: () => Promise<void> }> => {
    const server = createCoreServer(opts);
    // loopback 풀 재사용 중 stale socket 방지. 서버가 먼저 끊으면
    // 클라이언트 풀에 죽은 소켓이 남아 fetch failed가 된다 (기본 5s < 클라 30s).
    // loopback 전용 서버라 길게 잡는다.
    server.keepAliveTimeout = 120000;
    server.headersTimeout = 180000;
    return new Promise((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e?.code === "EACCES" && left > 0) {
          setTimeout(() => attempt(left - 1).then(resolve, reject), 200);
        } else {
          reject(e);
        }
      });
      server.listen(
        {
          port: opts.port ?? 0,
          host: opts.host ?? "127.0.0.1",
          exclusive: false,
        },
        () => {
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
        },
      );
    });
  };
  return attempt(10);
}
