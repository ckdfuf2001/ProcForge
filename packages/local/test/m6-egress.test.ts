import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";
import { withNetRetry } from "./net-retry.js";
import { ProcForgeApp } from "../src/app/app.js";

// M6-4 계약: 전체 E2E를 remote 모드로 돌리면서 송신 바이트를 수집해
// 구조 위반(resultJson 실데이터·절대경로) 0건 단언.

const KEY = "e2e-key";
const CAT = [
  { server: "fake", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m6e-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m6ehome-"));
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

describe("M6-4 egress 계약", () => {
  it("remote E2E 송신 위반 0건", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pf-m6esrv-"));
    const srv = await startServer({
      dataDir,
      apiKeys: parseApiKeys(`t1:${KEY}`),
      port: 0,
    });
    const sent: { method: string; bytes: number }[] = [];
    try {
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      // 바인드 경합 대비 healthz 대기.
      for (let i = 0; i < 20; i++) {
        try {
          const h = await fetch(`${baseUrl}/healthz`);
          if (h.ok) break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const client = withNetRetry(
        createRemoteCoreClient({
          baseUrl,
          apiKey: KEY,
          onSend: (m, b) => sent.push({ method: m, bytes: b }),
        }),
      );
      const app = new ProcForgeApp({
        core: client,
        procforgeDir: pfdir,
        projectRoot: root,
      });
      const started = await client.pfStart({
        request: "m64",
        params: { day: "d1" },
        toolCatalog: CAT,
      });
      const sid = started.session.id;
      await client.pfResolve({
        sessionId: sid,
        nodeId: "1",
        decision: "split",
        children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
      });
      await client.pfNext({ sessionId: sid });
      await client.pfReport({
        sessionId: sid,
        nodeId: "1.1",
        tool: { server: "fake", name: "echo" },
        args: { v: "a" },
        resultSummary: "a",
        resultJson: { v: "a" },
        selfVerdict: "pass",
        selfReason: "ok",
      });
      await client.pfResolve({
        sessionId: sid,
        nodeId: "1.1",
        decision: "leaf",
        tool: { server: "fake", name: "echo" },
        argSpecs: { v: { kind: "fixed", value: "a" } } as never,
      });
      await client.pfNext({ sessionId: sid });
      await client.pfReport({
        sessionId: sid,
        nodeId: "1.2",
        tool: { server: "fake", name: "echo" },
        args: { w: "b" },
        resultSummary: "b",
        resultJson: { w: "b" },
        selfVerdict: "pass",
        selfReason: "ok",
      });
      await client.pfResolve({
        sessionId: sid,
        nodeId: "1.2",
        decision: "leaf",
        tool: { server: "fake", name: "echo" },
        argSpecs: { w: { kind: "fixed", value: "b" } } as never,
      });
      const fin = await app.finalize({ sessionId: sid, name: "m64-egress" });
      expect(fin.warnings.filter((w) => w.includes("bad_"))).toEqual([]);
      // E2E가 guard 위반 없이 완주 + 송신 발생.
      expect(sent.length).toBeGreaterThan(10);
      expect(sent.every((s) => s.bytes > 0)).toBe(true);
      const total = sent.reduce((n, s) => n + s.bytes, 0);
      expect(total).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  }, 120000);
});
