import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M5.8.1-6: 호출 주체 기록. InMemoryTransport clientInfo가
// calls.jsonl 각 행(actor 포함)과 세션 meta에 기록된다.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m581c-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m581chome-"));
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

async function startViaMcp(clientName: string, clientVersion: string) {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
  await server.connect(st);
  await mcp.connect(ct);
  try {
    const r = await mcp.callTool({ name: "pf_start", arguments: { request: "m581" } });
    const text = (r.content as { type: string; text?: string }[])[0]?.text ?? "{}";
    return JSON.parse(text) as { sessionId: string; opencodeVersion?: string; warnings?: string[] };
  } finally {
    await mcp.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("M5.8.1-6 호출 주체 기록", () => {
  it("calls.jsonl 행에 actor+clientInfo, meta에 clientInfo", async () => {
    const out = await startViaMcp("m581-caller", "0.0.1");
    expect(out.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const callsPath = join(pfdir, "sessions", out.sessionId, "calls.jsonl");
    expect(existsSync(callsPath)).toBe(true);
    const row = JSON.parse(readFileSync(callsPath, "utf-8").split("\n")[0]) as {
      tool: string; actor: string; clientName: string; clientVersion: string;
    };
    expect(row.tool).toBe("pf_start");
    expect(row.actor).toBe("host");
    expect(row.clientName).toBe("m581-caller");
    expect(row.clientVersion).toBe("0.0.1");
    const meta = JSON.parse(readFileSync(join(pfdir, "sessions", out.sessionId, "meta.json"), "utf-8")) as {
      clientName: string; clientVersion: string;
    };
    expect(meta.clientName).toBe("m581-caller");
    expect(meta.clientVersion).toBe("0.0.1");
  }, 60000);

  it("opencode client면 그 버전을 opencodeVersion으로 (unknown 해소)", async () => {
    const out = await startViaMcp("opencode", "1.2.3");
    expect(out.opencodeVersion).toBe("1.2.3");
    expect((out.warnings ?? []).some((w) => w.includes("모르는 opencode 버전"))).toBe(false);
  }, 60000);
});
