import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import {
  procRunLockPath,
  acquireProcRunLock,
} from "../src/services/run-lock.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-entry-mcp: MCP pf_finalize + run 잠금.
// 잠금을 잡은 상태에서 호출하면 conflict, 해제 후에는 성공하고 state.json이 보존된다.

const CAT = [{ server: "t", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;
const TOOL = { server: "t", name: "echo" } as never;

let root: string;
let pfdir: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = makeTmp("pf-m10mcp-");
  pfdir = join(root, ".procforge");
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function linked(app: ProcForgeApp) {
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  return { mcp, close: async () => { await mcp.close(); await server.close(); } };
}

describe("M10-entry-mcp finalize lock", () => {
  it("잠금 중 pf_finalize는 conflict, 해제 후 성공+state.json 보존", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const s = await app.start({ request: "mcp 잠금 테스트", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid, nodeId: "1",
      reason: "M10-entry-mcp 테스트용 분해 사유입니다.",
      children: [{ goal: "x" }],
      expectedRevision: 0,
    } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      args: { note: "hi" }, resultSummary: "ok", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
    // sidecar 선행 배치 (보존 확인용 — 재finalize 시 절차서 폴더에서 읽는다).
    const procDir = join(pfdir, "procedures", "mcp-proc");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(join(procDir, "state.json"), JSON.stringify({ lastId: "a1" }));
    const { mcp, close } = await linked(app);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        return r;
      };
      // run 잠금을 직접 잡는다 (실행 중인 것과 같은 상태).
      const releaseLock = acquireProcRunLock(
        new FileStore(pfdir),
        pfdir,
        "mcp-proc",
        "test run locked: mcp-proc",
        60000,
      );
      try {
        const blocked = await call("pf_finalize", { sessionId: sid, name: "mcp-proc" });
        expect(blocked.isError).toBe(true);
        const text = JSON.stringify(blocked.content);
        expect(text).toMatch(/conflict/);
      } finally {
        releaseLock();
      }
      // 해제 후에는 성공하고 state.json이 그대로 들어간다.
      const ok = await call("pf_finalize", { sessionId: sid, name: "mcp-proc", force: true });
      expect(ok.isError ?? false).toBe(false);
      expect(existsSync(join(pfdir, "procedures", "mcp-proc", "procedure.json"))).toBe(true);
      expect(readFileSync(join(pfdir, "procedures", "mcp-proc", "state.json"), "utf8")).toBe(
        JSON.stringify({ lastId: "a1" }),
      );
      // 새 위치 잠금 잔재 없음.
      expect(existsSync(procRunLockPath(pfdir, "mcp-proc"))).toBe(false);
    } finally {
      await close();
    }
  }, 60000);
});
