import type { CoreClient } from "@procforge/shared/core-client.js";
import {
  WireMethods,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  throwWireError,
  type WireMethodName,
  type WireError,
} from "@procforge/shared/wire.js";
import { guardEgress } from "./services/egress.js";
import { convertReportForRemote } from "./report-convert.js";

// M6-3: HTTP CoreClient 구현. 기본 inprocess, 설정(PROCFORGE_CORE_URL)으로 remote.
// - 읽기는 재시도. 쓰기는 연결 단계 실패(EACCES·ECONNREFUSED: 서버가 요청을
//   못 봐서 재시도 안전)만 재시도, 그 외 fetch 실패는 즉시 degraded (정확히 1회).
//   (M6.1-2: Windows loopback 순간 EACCES 대응)
// - 네트워크 실패 → io_error (degraded). 로컬 파일 상태는 건드리지 않는다
//   (이 클라이언트는 core 호출만 하고 파일 쓰기를 하지 않는다).

export type RemoteCoreClientOpts = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** 테스트용 송신 탭 (M6-4 계약 테스트가 송신 바이트 수집) */
  onSend?: (method: WireMethodName, bytes: number) => void;
  fetchImpl?: typeof fetch;
};

const READ_METHODS: ReadonlySet<WireMethodName> = new Set([
  "getSession",
  "getNode",
  "pfTree",
  "getEvents",
  "pfBuildProcedure",
]);

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function netError(detail: string): Error {
  return Object.assign(
    new Error(`core 연결 실패 (remote degraded): ${detail}`),
    { code: "io_error" },
  );
}

export function createRemoteCoreClient(opts: RemoteCoreClientOpts): CoreClient {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function call<M extends WireMethodName>(
    method: M,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const def = WireMethods[method];
    // M6.1-2: pfReport 원문은 wire 전에 메타+판정으로 변환 (유일한 원격 경로).
    let outgoing = body;
    if (method === "pfReport") {
      outgoing = await convertReportForRemote(body, async (sid, nid) => {
        const got = (await call("getNode", {
          sessionId: sid,
          nodeId: nid,
        })) as {
          constraints?: import("@procforge/shared/schema.js").Constraint[];
        };
        return got;
      });
    }
    // M6-4: 송신 전 egress 검사 (위반 차단·민감값 교정).
    const guarded = guardEgress(method, outgoing);
    const payload = JSON.stringify(guarded.body);
    opts.onSend?.(method, Buffer.byteLength(payload, "utf8"));
    const retryable = READ_METHODS.has(method);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r: Response;
      try {
        r = await doFetch(`${base}${def.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
            [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
          },
          body: payload,
          signal: ctrl.signal,
        });
      } catch (e) {
        // fetch 실패·타임아웃: 읽기는 재시도. 쓰기는 연결 단계 실패
        // (EACCES·ECONNREFUSED: 서버가 못 봄, 재시도 안전)만 재시도하고
        // 그 외(서버 처리 후 응답 손실 가능)는 즉시 degraded (정확히 1회).
        clearTimeout(timer);
        const code = (e as { cause?: { code?: string } })?.cause?.code;
        const unseen = code === "EACCES" || code === "ECONNREFUSED";
        if ((!retryable && !unseen) || attempt >= MAX_ATTEMPTS)
          throw netError(e instanceof Error ? e.message : String(e));
        await sleep(100 * attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (RETRYABLE_STATUS.has(r.status)) {
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(100 * attempt);
          continue;
        }
        throw netError(`HTTP ${r.status}`);
      }
      let env: { ok?: boolean; data?: unknown; error?: WireError };
      try {
        env = (await r.json()) as {
          ok?: boolean;
          data?: unknown;
          error?: WireError;
        };
      } catch {
        throw netError(`응답 파싱 실패 (HTTP ${r.status})`);
      }
      if (!env || env.ok !== true) {
        // 서버 판정(코드 보존): 재시도 없음. expectedRevision 충돌 판단은 호출자가.
        const e = env?.error;
        if (e && typeof e.code === "string") {
          throwWireError({
            code: e.code,
            message: String(e.message ?? ""),
            hint: typeof e.hint === "string" ? e.hint : undefined,
          });
        }
        throw netError(`이상 응답 (HTTP ${r.status})`);
      }
      const parsed = def.output.safeParse((env as { data?: unknown }).data);
      if (!parsed.success) throw netError(`응답 검증 실패: ${method}`);
      return parsed.data;
    }
    throw netError("재시도 소진");
  }

  return {
    pfStart: (i) => call("pfStart", i as Record<string, unknown>) as never,
    pfNext: (i) => call("pfNext", i as Record<string, unknown>) as never,
    pfReport: (i) => call("pfReport", i as Record<string, unknown>) as never,
    pfResolve: (i) => call("pfResolve", i as Record<string, unknown>) as never,
    pfAdvise: (i) => call("pfAdvise", i as Record<string, unknown>) as never,
    pfTree: (sid) => call("pfTree", { sessionId: sid }) as never,
    pfLock: (i) => call("pfLock", i as Record<string, unknown>) as never,
    pfReopen: (i) => call("pfReopen", i as Record<string, unknown>) as never,
    amendAttemptArtifacts: (i) =>
      call("amendAttemptArtifacts", i as Record<string, unknown>) as never,
    pfUpdateCatalog: (i) =>
      call("pfUpdateCatalog", i as Record<string, unknown>) as never,
    pfEditArgs: (i) =>
      call("pfEditArgs", i as Record<string, unknown>) as never,
    pfEditNode: (i) =>
      call("pfEditNode", i as Record<string, unknown>) as never,
    getEvents: (sid, since) =>
      call(
        "getEvents",
        since === undefined
          ? { sessionId: sid }
          : { sessionId: sid, sinceSeq: since },
      ) as never,
    getSession: (sid) => call("getSession", { sessionId: sid }) as never,
    getNode: (sid, nid) =>
      call("getNode", { sessionId: sid, nodeId: nid }) as never,
    pfBuildProcedure: (sid, name) =>
      call("pfBuildProcedure", { sessionId: sid, name }) as never,
    pfApprove: (i) => call("pfApprove", i as Record<string, unknown>) as never,
    pfImportProcedure: (i) =>
      call("pfImportProcedure", i as Record<string, unknown>) as never,
    pfWriteGolden: (i) =>
      call("pfWriteGolden", i as Record<string, unknown>) as never,
  } as CoreClient;
}
