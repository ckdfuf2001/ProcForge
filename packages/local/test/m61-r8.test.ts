import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { ProcForgeApp } from "../src/app/app.js";
import { withNetRetry } from "./net-retry.js";

// M6.1-1 (R8): 10KB 크롤링 본문을 report → 서버 수신 본문에 원문 0바이트.
// 메타+판정만 전송, 평가는 local, 원문은 로컬 attempt 파일에만.

const KEY = "r8-key";
const CAT = [
  { server: "fake", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let srv: { port: number; close: () => Promise<void> } | undefined;
let baseUrl = "";

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pf-m61srv-"));
  srv = await startServer({
    dataDir,
    apiKeys: parseApiKeys(`t1:${KEY}`),
    port: 0,
  });
  baseUrl = `http://127.0.0.1:${srv.port}`;
  for (let i = 0; i < 20; i++) {
    try {
      const h = await fetch(`${baseUrl}/healthz`);
      if (h.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

afterAll(async () => {
  await srv?.close();
});

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m61-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m61home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

describe("M6.1-1 egress R8", () => {
  it("10KB 본문 report → 송신 본문 원문 0바이트·서버는 메타만", async () => {
    const marker = `r8-${randomUUID().replace(/-/g, "")}`;
    const tail = `tail-${randomUUID().replace(/-/g, "")}`;
    const big = { body: `${marker}:` + "본문".repeat(4000) + `:${tail}` };
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeGreaterThan(
      10240,
    );
    const sentBodies: string[] = [];
    const spyFetch: typeof fetch = (async (url: never, init?: RequestInit) => {
      if (init?.body !== undefined) sentBodies.push(String(init.body));
      return fetch(url, init);
    }) as typeof fetch;
    const client = withNetRetry(
      createRemoteCoreClient({ baseUrl, apiKey: KEY, fetchImpl: spyFetch }),
    );
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: root,
    });
    const started = await client.pfStart({
      request: "m61",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "crawl" }],
    });
    await client.pfNext({ sessionId: sid });
    const rep = await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "fake", name: "echo" },
      args: {},
      resultSummary: "ok",
      resultJson: big,
      selfVerdict: "pass",
      selfReason: "ok",
    });
    expect((rep as { verdict?: string }).verdict).toBe("pass");
    // 송신된 모든 본문에 원문 꼬리(4KB 미리보기 밖) 없음.
    // 미리보기(≤4KB)는 R8 설계상 허용이라 head 마커는 검사 제외.
    expect(sentBodies.length).toBeGreaterThan(0);
    for (const b of sentBodies) expect(b).not.toContain(tail);
    // 서버 attempt에는 메타만.
    const un = (await client.getNode(sid, "1.1")) as {
      attempts: {
        resultJsonMeta?: { sha256: string; size: number; preview: string };
        resultJson?: unknown;
      }[];
    };
    const last = un.attempts[un.attempts.length - 1];
    expect(last.resultJson).toBeUndefined();
    expect(last.resultJsonMeta?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(last.resultJsonMeta?.size).toBeGreaterThan(10240);
    expect(last.resultJsonMeta?.preview.length).toBeLessThanOrEqual(4096);
    expect(last.resultJsonMeta?.preview).not.toContain(tail);
    // 로컬 attempt 파일에는 원문 전체.
    const rjDir = join(pfdir, "sessions", sid, "resultJson");
    const files = readdirSync(rjDir);
    expect(files.length).toBeGreaterThan(0);
    const stored = readFileSync(join(rjDir, files[0]), "utf8");
    expect(stored).toContain(marker);
    expect(stored).toContain(tail);
  }, 120000);

  it("원문 pfReport 직접 전송도 변환되어 메타만 서버에 (차단은 guard층)", async () => {
    const client = createRemoteCoreClient({ baseUrl, apiKey: KEY });
    const started = await client.pfStart({
      request: "m61b",
      params: {},
      toolCatalog: CAT,
    });
    await client.pfResolve({
      sessionId: started.session.id,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "d" }],
    });
    const out = (await client.pfReport({
      sessionId: started.session.id,
      nodeId: "1.1",
      tool: { server: "fake", name: "echo" },
      args: {},
      resultSummary: "x",
      resultJson: { raw: 1 },
      selfVerdict: "pass",
      selfReason: "ok",
    } as never)) as { verdict: string };
    expect(out.verdict).toBe("pass");
    const un = (await client.getNode(started.session.id, "1.1")) as {
      attempts: { resultJsonMeta?: unknown; resultJson?: unknown }[];
    };
    expect(un.attempts[un.attempts.length - 1].resultJsonMeta).toBeDefined();
    expect(un.attempts[un.attempts.length - 1].resultJson).toBeUndefined();
  }, 60000);
});
