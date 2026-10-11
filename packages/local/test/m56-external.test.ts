import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M5.6-e: MCP 경로 external 생성 (split/confirm sideEffect + ask_human→approve 강제).

const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m56e-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m56ehome-"));
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

describe("M5.6-e external 승인 흐름", () => {
  it("split external → 보고 차단 → ask_human 계획 → approve → 확정 → finalize", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "send", params: {}, toolCatalog: ECHO_CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "외부 발송", sideEffect: "external" }],
    });
    // 보고 차단 (실행 금지).
    const blocked = await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
      args: { note: "hi" }, resultSummary: "try", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    expect(blocked.verdict).toBe("fail");
    // 미승인 확정 거부.
    await expect(client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    })).rejects.toThrow();
    // dry-run 계획 → 승인 → 확정.
    await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "ask_human",
      tool: { server: "fake-ppt", name: "echo" },
      plan: { tool: { server: "fake-ppt", name: "echo" }, args: { note: "hi" } } as never,
      note: "external 발송 계획 승인 요청",
    });
    await client.pfApprove({ sessionId: sid, nodeId: "1.1", approved: true });
    const c = await client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
    expect((c.node as { status?: string }).status).toBe("leaf");
    // finalize: 승인 external leaf는 leaf_not_confirmed 면제.
    const fin = await app.finalize({ sessionId: sid, name: "m56-ext" });
    expect(fin.warnings.filter((w) => w.includes("leaf_not_confirmed"))).toEqual([]);
  }, 60000);
});
