import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { CoreService } from "@procforge/core";
import { FileStore, resetLockStats, lockStats } from "../src/filestore.js";
import { checkerEvaluate } from "../src/checker.js";
import { wrapClient } from "./client-mode.js";

// M3.5.2-2: 8 자식 프로세스 × 50회 동시 커밋.
// events seq 중복 0, revision 연속, 실패는 conflict만.

let root: string;
let pfdir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-lockstress-"));
  pfdir = join(root, ".procforge");
});

describe("M3.5.2 lockfile 부하", () => {
  it("8×50 동시 보고: seq 중복 0·revision 연속", async () => {
    resetLockStats();
    const store = new FileStore(pfdir);
    const core = wrapClient(new CoreService(store, checkerEvaluate));
    const toolCatalog = [{ server: "t", name: "x", inputSchema: {}, schemaHash: "h" }];
    const started = await core.pfStart({ request: "stress", toolCatalog: toolCatalog as never });
    const sid = started.session.id;
    const kids = Array.from({ length: 8 }, (_, i) => ({ goal: `n${i}` }));
    await core.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: kids });
    const here = dirname(fileURLToPath(import.meta.url));
    const coreDist = pathToFileURL(join(here, "..", "..", "core", "dist", "service.js")).href;
    const storeDist = pathToFileURL(join(here, "..", "dist", "filestore.js")).href;
    const childCode = [
      `import { CoreService } from ${JSON.stringify(coreDist)};`,
      `import { FileStore } from ${JSON.stringify(storeDist)};`,
      `const [pfdir, sid, nid, count] = process.argv.slice(2);`,
      `const svc = new CoreService(new FileStore(pfdir), () => ({ verdict: "pass", failedConstraints: [] }));`,
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
      `for (let i = 0; i < Number(count); i++) {`,
      `  let ok = false;`,
      `  for (let t = 0; t < 500 && !ok; t++) {`,
      `    try {`,
      `      await svc.pfReport({ sessionId: sid, nodeId: nid, tool: { server: "t", name: "x" }, args: {}, resultSummary: "s" + i, selfVerdict: "pass", selfReason: "ok" });`,
      `      ok = true;`,
      `    } catch (e) {`,
      `      if (e?.code !== "conflict") { console.error("NON-CONFLICT: " + (e?.message ?? e)); process.exit(1); }`,
      `      await sleep(20);`,
      `    }`,
      `  }`,
      `  if (!ok) { console.error("RETRY-EXHAUSTED"); process.exit(1); }`,
      `}`,
    ].join("\n");
    const childPath = join(root, "child-stress.mjs");
    writeFileSync(childPath, childCode);
    const nodeIds = Array.from({ length: 8 }, (_, i) => `1.${i + 1}`);
    const procs = nodeIds.map(
      (nid) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [childPath, pfdir, sid, nid, "50"], { stdio: "ignore" });
          child.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`child ${nid} exit ${c}`))));
          child.on("error", reject);
        }),
    );
    await Promise.all(procs);
    // 검증: split 1 + 보고 400 = revision 401, seq 1..401 중복·결번 없음
    expect((await core.getSession(sid)).revision).toBe(401);
    const seqs = (await core.getEvents(sid)).map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toHaveLength(401);
    expect(seqs).toEqual(Array.from({ length: 401 }, (_, i) => i + 1));
    // M5.1-A3: 전원 생존 부하에서 회수 0회
    expect(lockStats.reclaims).toBe(0);
  }, 240000);
});
