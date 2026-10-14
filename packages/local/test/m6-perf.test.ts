import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, parseApiKeys } from "../../core-server/dist/server.js";
import { createRemoteCoreClient } from "../src/remote-client.js";

// M6-6: pf_* 왕복 p95 측정 (remote 모드 E2E). 목표값은 측정 후 DECISIONS.

const KEY = "perf-key";

function pct(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

describe("M6-6 remote p95", () => {
  it("왕복 측정·기록", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pf-m6p-"));
    const srv = await startServer({
      dataDir,
      apiKeys: parseApiKeys(`t1:${KEY}`),
      port: 0,
    });
    try {
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const client = createRemoteCoreClient({ baseUrl, apiKey: KEY });
      // M6.1-3: 재시도 없음. 단일 시도 시간 기록.
      const timed = async <T>(
        fn: () => Promise<T>,
      ): Promise<{ v: T; ms: number }> => {
        const t = performance.now();
        const v = await fn();
        return { v, ms: performance.now() - t };
      };
      const started = (
        await timed(() =>
          client.pfStart({ request: "p", params: {}, toolCatalog: [] }),
        )
      ).v;
      const sid = started.session.id;
      const times: Record<string, number[]> = {
        getSession: [],
        pfTree: [],
        getNode: [],
        pfNext: [],
      };
      for (let i = 0; i < 20; i++) {
        times.getSession.push((await timed(() => client.getSession(sid))).ms);
        times.pfTree.push((await timed(() => client.pfTree(sid))).ms);
      }
      await timed(() =>
        client.pfResolve({
          sessionId: sid,
          nodeId: "1",
          decision: "split",
          children: [{ goal: "a" }],
        }),
      );
      for (let i = 0; i < 10; i++) {
        times.getNode.push((await timed(() => client.getNode(sid, "1.1"))).ms);
      }
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        try {
          await client.pfNext({ sessionId: sid });
        } catch {
          // 상태 전이는 측정 대상 아님 (왕복 시간만 기록)
        }
        times.pfNext.push(performance.now() - t);
      }
      const rows = Object.entries(times).map(([k, v]) => {
        const avg = v.reduce((a, b) => a + b, 0) / v.length;
        return `${k}: n=${v.length} avg=${avg.toFixed(1)}ms p50=${pct(v, 50).toFixed(1)}ms p95=${pct(v, 95).toFixed(1)}ms max=${Math.max(...v).toFixed(1)}ms`;
      });
      console.log("PERF remote:\n" + rows.join("\n"));
      for (const v of Object.values(times)) {
        expect(pct(v, 95)).toBeLessThan(30000);
      }
    } finally {
      await srv.close();
    }
  }, 120000);
});
