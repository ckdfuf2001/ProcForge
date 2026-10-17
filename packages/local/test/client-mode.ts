import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createLocalStack } from "../src/core-inprocess.js";
import { FileStore } from "../src/filestore.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { inspectEgress } from "../src/services/egress.js";
import { createLoopbackClient } from "@procforge/shared";
import type { CoreClient } from "@procforge/shared/core-client.js";
import type { ProcedureDoc } from "@procforge/shared/procedure.js";
import { importProcedure, copyImportFiles } from "../src/procedure.js";
import { runSession } from "../src/runner/run.js";
import type { RunOptions, RunReport } from "../src/runner/types.js";

// 테스트 클라이언트 모드 (M4.2-4-4).
// PROCFORGE_CLIENT=inprocess (기본) | loopback (JSON 왕복+zod 검증)
//   | remote (실제 HTTP core-server, 파일당 1대).
// store는 파일 assertions용으로 그대로 반환한다.
// remote에서는 세션·노드 메타 읽기가 서버 저장소를 본다
// (fixture/resultJson 등 로컬 파일은 pfdir 그대로).

export function clientMode(): "inprocess" | "loopback" | "remote" {
  const m = process.env.PROCFORGE_CLIENT;
  if (m === "loopback") return "loopback";
  if (m === "remote") return "remote";
  return "inprocess";
}

export function wrapClient(client: CoreClient): CoreClient {
  return clientMode() === "loopback" ? createLoopbackClient(client) : client;
}

// M6.1-2: 파일당 1대 (vitest isolate 기본값 기준 모듈 상태).
// dataDir·tenant·키는 동기 확정, listen만 비동기라 client 호출이 대기한다.
const REMOTE_TID = "t1";
const REMOTE_KEY = randomUUID().replace(/-/g, "");
const REMOTE_DATA_DIR = mkdtempSync(join(tmpdir(), "pf-remote-suite-"));
const remoteReadyMap = new Map<number | undefined, Promise<string>>();

function ensureRemoteServer(sessionTtlMs?: number): Promise<string> {
  const hit = remoteReadyMap.get(sessionTtlMs);
  if (hit) return hit;
  const p = (async () => {
    const s = await startServer({
      dataDir: REMOTE_DATA_DIR,
      apiKeys: parseApiKeys(`${REMOTE_TID}:${REMOTE_KEY}`),
      port: 0,
      sessionTtlMs,
    });
    const base = `http://127.0.0.1:${s.port}`;
    // M6.1-3: 대기는 healthz 1회가 아니라 listen 전제. 할당 포트면 수신 가능.
    // createLocalStack 직접 사용자(MCP 등)도 같은 서버를 보게 환경 전파.
    // resolve 전에 설정해야 레이스가 없다.
    process.env.PROCFORGE_CORE_URL = base;
    process.env.PROCFORGE_CORE_API_KEY = REMOTE_KEY;
    return base;
  })();
  remoteReadyMap.set(sessionTtlMs, p);
  return p;
}

/** 송신 수집 (M6.1-2. 스위트 끝 egress 위반 단언용. path에서 메서드 복원) */
export type SentRequest = { path: string; body: string };
const sentRequests: SentRequest[] = [];
function capturingFetch(input: never, init?: RequestInit): Promise<Response> {
  if (init?.body !== undefined) {
    try {
      const url = String(input);
      sentRequests.push({
        path: new URL(url).pathname,
        body: String(init.body),
      });
    } catch {
      // 무시
    }
  }
  return fetch(input, init);
}

export function drainSentRequests(): SentRequest[] {
  return sentRequests.splice(0, sentRequests.length);
}

/** 지연 baseUrl remote client (첫 호출이 서버 listen을 기다린다) */
function deferredRemoteClient(basePromise: Promise<string>): CoreClient {
  let inner: CoreClient | undefined;
  const invoke = async (
    name: keyof CoreClient,
    args: unknown[],
  ): Promise<unknown> => {
    if (!inner) {
      const base = await basePromise;
      inner = createRemoteCoreClient({
        baseUrl: base,
        apiKey: REMOTE_KEY,
        fetchImpl: capturingFetch as typeof fetch,
      });
    }
    return (inner[name] as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return {
    pfStart: (i) => invoke("pfStart", [i]) as never,
    pfNext: (i) => invoke("pfNext", [i]) as never,
    pfReport: (i) => invoke("pfReport", [i]) as never,
    pfResolve: (i) => invoke("pfResolve", [i]) as never,
    pfAdvise: (i) => invoke("pfAdvise", [i]) as never,
    pfTree: (sid) => invoke("pfTree", [sid]) as never,
    pfLock: (i) => invoke("pfLock", [i]) as never,
    pfReopen: (i) => invoke("pfReopen", [i]) as never,
    amendAttemptArtifacts: (i) => invoke("amendAttemptArtifacts", [i]) as never,
    pfUpdateCatalog: (i) => invoke("pfUpdateCatalog", [i]) as never,
    pfEditArgs: (i) => invoke("pfEditArgs", [i]) as never,
    pfEditNode: (i) => invoke("pfEditNode", [i]) as never,
    getEvents: (sid, since) => invoke("getEvents", [sid, since]) as never,
    getSession: (sid) => invoke("getSession", [sid]) as never,
    getNode: (sid, nid) => invoke("getNode", [sid, nid]) as never,
    getSessions: () => invoke("getSessions", []) as never,
    getEventsPage: (i) => invoke("getEventsPage", [i]) as never,
    getBlocked: (i) => invoke("getBlocked", [i]) as never,
    pfBuildProcedure: (sid, name) =>
      invoke("pfBuildProcedure", [sid, name]) as never,
    pfApprove: (i) => invoke("pfApprove", [i]) as never,
    pfImportProcedure: (i) => invoke("pfImportProcedure", [i]) as never,
    pfWriteGolden: (i) => invoke("pfWriteGolden", [i]) as never,
  } as CoreClient;
}

export function testStack(
  pfdir: string,
  opts: { sessionTtlMs?: number } = {},
): { client: CoreClient; store: FileStore } {
  if (clientMode() === "remote") {
    const basePromise = ensureRemoteServer(opts.sessionTtlMs);
    const client = deferredRemoteClient(basePromise);
    lastRemoteClient = client;
    return {
      client,
      store: new FileStore(join(REMOTE_DATA_DIR, "tenants", REMOTE_TID)),
    };
  }
  const { client, store } = createLocalStack(pfdir, opts);
  return { client: wrapClient(client), store };
}

/**
 * CLI 서브프로세스 실행 (M6.1-2).
 * spawnSync는 워커 루프를 막아 인프로세스 서버가 얼어붙으므로 비동기로
 * 실행해 루프를 펌프한다 (remote 모드 CLI 테스트용).
 */
export function spawnCli(
  cliPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * 세션·노드 메타 저장소 (M6.1-2).
 * remote에서는 서버 저장소, 그 외는 로컬 pfdir.
 * fixture/resultJson 등 로컬 파일 읽기는 readFileSync(join(pfdir,...)) 그대로.
 */
export function metaStore(pfdir: string): FileStore {
  if (clientMode() === "remote") {
    void ensureRemoteServer();
    return new FileStore(join(REMOTE_DATA_DIR, "tenants", REMOTE_TID));
  }
  return new FileStore(pfdir);
}

/** 절차서 import (M6.1-2. remote는 wire, 그 외는 로컬 직접 저장) */
export async function importProc(
  client: CoreClient,
  pfdir: string,
  doc: ProcedureDoc,
  params: Record<string, string> = {},
): Promise<{ sessionId: string }> {
  if (clientMode() === "remote") {
    const out = await client.pfImportProcedure({ doc: doc as never, params });
    copyImportFiles(pfdir, (doc as { name: string }).name, out.sessionId);
    return out;
  }
  return importProcedure(pfdir, doc, params);
}

/** 서버 세션 루트 (M6.1-2. remote에서만 의미 있음) */
export function serverSessionDir(pfdir: string, sessionId: string): string {
  if (clientMode() === "remote") {
    void ensureRemoteServer();
    return join(REMOTE_DATA_DIR, "tenants", REMOTE_TID, "sessions", sessionId);
  }
  return join(pfdir, "sessions", sessionId);
}

let lastRemoteClient: CoreClient | undefined;

/**
 * runSession 테스트 래퍼 (M6.1-2).
 * remote에서는 파일 client로 하이드레이트 후 실행 (inprocess는 그대로).
 */
export function runTestSession(opts: RunOptions): Promise<RunReport> {
  if (clientMode() === "remote" && !opts.core && lastRemoteClient) {
    return runSession({ ...opts, core: lastRemoteClient });
  }
  return runSession(opts);
}
