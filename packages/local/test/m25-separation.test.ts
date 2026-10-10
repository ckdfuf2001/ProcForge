import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoreService, createMemoryStore } from "@procforge/core";
import { FileStore } from "../src/filestore.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { wrapClient } from "./client-mode.js";
import { checkerEvaluate } from "../src/checker.js";

// M4.2-2.5 완료 기준: FileStore 없는 별도 MemoryStore core로 MCP 계약 흐름 통과.
// App의 로컬 파일 작업(sandbox/fixtures/절차서)은 별도 임시 폴더.
// M6 분리가 설정 변경 수준임을 실증. pf_test/pf_finalize의 runner 세션 파일
// 의존은 별도 과제 (runner가 FileStore 세션을 직접 읽음).

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const READ = { server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m25-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m25home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "data.pptx"), "PPTX-DATA");
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

describe("M4.2-2.5 core/파일 저장소 분리 실증", () => {
  it("MemoryStore core + 임시 폴더 App으로 전체 MCP 흐름 통과", async () => {
    const core = wrapClient(new CoreService(createMemoryStore(), checkerEvaluate));
    const app = new ProcForgeApp({ core, procforgeDir: pfdir, projectRoot: root });
    const server = buildServer({ app, procforgeDir: pfdir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "m25-host", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        expect(r.isError, `${name} should succeed`).toBeFalsy();
        return r.structuredContent as Record<string, unknown>;
      };
      const started = await call("pf_start", { request: "분리", toolCatalog: [READ], seedFiles: ["data.pptx"] });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }] });
      const nxt = await call("pf_next", { sessionId: sid });
      expect((nxt["node"] as { id: string }).id).toBe("1.1");
      const slides = JSON.stringify({ slides: ["a"] });
      const rep = await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" }, args: { file: "data.pptx" },
        resultSummary: slides, resultJson: JSON.parse(slides),
        selfVerdict: "pass", selfReason: "ok",
      });
      expect(rep["revision"]).toBeGreaterThan(0);
      // 1.1 해시 변경 → 하류 1.2 stale 전파로 함께 기록
      expect(rep["changedNodeIds"]).toEqual(["1.1", "1.2"]);
      const done = await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "opencode", name: "read" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      expect((done["node"] as { status: string }).status).toBe("leaf");
      // 세션 파일 없이도 동작 (상태는 메모리, 파일은 임시 폴더)
      expect(existsSync(join(pfdir, "sessions", sid, "session.json"))).toBe(false);
      // 산출물은 임시 폴더에 기록됨
      const tree = await call("pf_tree", { sessionId: sid });
      expect((tree["counts"] as Record<string, number>)["leaf"]).toBe(1);
      const edited = await call("pf_edit_args", {
        sessionId: sid, nodeId: "1.1", patch: { set: { file: { kind: "fixed", value: "b.pptx" } } },
      });
      expect((edited["node"] as { status: string }).status).toBe("open");
      const adv = await call("pf_advise", { sessionId: sid, nodeId: "1.2", text: "다듬어라" });
      expect((adv["node"] as { id: string }).id).toBe("1.2");
      // 카탈로그 수집도 임시 폴더 기준 동작
      const cat = await call("pf_refresh_catalog", {});
      expect((cat["entries"] as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);

  it("M4.2-2.5.1-1 두 프로세스 동시 커밋·조회: seq 중복 0", async () => {
    // FileStore 기반 core + 세션 준비 (자식과 같은 폴더 공유)
    const store = new FileStore(pfdir);
    const core = wrapClient(new CoreService(store, checkerEvaluate));
    const toolCatalog = [{ server: "t", name: "x", inputSchema: {}, schemaHash: "h" }];
    const started = await core.pfStart({ request: "conc", toolCatalog: toolCatalog as never });
    const sid = started.session.id;
    await core.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }],
    });
    // 자식 프로세스: 1.2에 5회 보고 (conflict 시 재시도)
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
      `  for (let t = 0; t < 200; t++) {`,
      `    try {`,
      `      await svc.pfReport({ sessionId: sid, nodeId: nid, tool: { server: "t", name: "x" }, args: {}, resultSummary: "c" + i, selfVerdict: "pass", selfReason: "ok" });`,
      `      break;`,
      `    } catch (e) {`,
      `      if (e?.code !== "conflict" || t === 199) { console.error(e?.message ?? e); process.exit(1); }`,
      `      await sleep(10);`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n");
    const childPath = join(root, "child-report.mjs");
    writeFileSync(childPath, childCode);
    const child = spawn(process.execPath, [childPath, pfdir, sid, "1.2", "5"], { stdio: "ignore" });
    const childDone = new Promise<void>((resolve, reject) => {
      child.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`child exit ${c}`))));
      child.on("error", reject);
    });
    // 부모: 1.1에 5회 보고 (창을 넓히려고 사이마다 대기)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 5; i++) {
      for (let t = 0; t < 200; t++) {
        try {
          await core.pfReport({
            sessionId: sid, nodeId: "1.1",
            tool: { server: "t", name: "x" }, args: {},
            resultSummary: `p${i}`, selfVerdict: "pass", selfReason: "ok",
          });
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== "conflict" || t === 199) throw e;
          await sleep(10);
        }
      }
      await sleep(50);
    }
    await childDone;
    // 검증: split 1 + 보고 10 = revision 11, seq 1..11 중복 없음
    expect((await core.getSession(sid)).revision).toBe(11);
    const seqs = (await core.getEvents(sid)).map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  }, 60000);
});
