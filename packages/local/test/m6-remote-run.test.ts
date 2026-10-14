import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { withNetRetry } from "./net-retry.js";
import { ProcForgeApp } from "../src/app/app.js";
import { runSession } from "../src/runner/run.js";

// M6-5: remote core 분해 세션을 로컬 runner로 live 실행.

const KEY = "run-key";
const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const CAT = [
  { server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

let srv: { port: number; close: () => Promise<void> } | undefined;
let baseUrl = "";

// 소켓 고갈(EACCES) 방지: 파일당 서버 1개 공유 (세션 id는 uuid라 충돌 없음).
beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pf-m6rsrv-"));
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m6r-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m6rhome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({
      mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } },
    }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

describe("M6-5 remote 실행", () => {
  it("분해(remote) → runSession live(core 하이드레이트) → pass", async () => {
    const client = withNetRetry(
      createRemoteCoreClient({ baseUrl, apiKey: KEY }),
    );
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: root,
    });
    const started = await client.pfStart({
      request: "m65",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "echo" }],
    });
    await client.pfNext({ sessionId: sid });
    await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" },
      args: { note: "a" },
      resultSummary: "a",
      resultJson: { note: "a" },
      selfVerdict: "pass",
      selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "a" } },
    } as never);
    const rep = await runSession({
      procforgeDir: pfdir,
      projectRoot: root,
      sessionId: sid,
      mode: "live",
      core: client,
    });
    expect(rep.summary.fail).toBe(0);
    expect(rep.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
  }, 120000);

  it("remote + record → 명시 거부", async () => {
    const client = withNetRetry(
      createRemoteCoreClient({ baseUrl, apiKey: KEY }),
    );
    const started = await client.pfStart({
      request: "m65",
      params: {},
      toolCatalog: CAT,
    });
    let code = "";
    try {
      await runSession({
        procforgeDir: pfdir,
        projectRoot: root,
        sessionId: started.session.id,
        mode: "record",
        core: client,
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("bad_request");
  }, 120000);
});
