import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M3.5.1-1: reopen·retry·edit_args 후 재보고가 file_exists pin 없이 통과.
// (관찰 6의 3사례)

const CATALOG = [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }];

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m351-"));
  pfdir = join(root, ".procforge");
});

async function reportedSession() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "pin", toolCatalog: CATALOG as never });
  const sid = started.session.id;
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }] });
  mkdirSync(join(pfdir, "sandbox", sid), { recursive: true });
  writeFileSync(join(pfdir, "sandbox", sid, "x.txt"), "v1");
  const rep = {
    sessionId: sid, nodeId: "1.1",
    tool: { server: "opencode", name: "read" }, args: { path: "x.txt" },
    resultSummary: "ok", resultJson: { ok: true }, selfVerdict: "pass" as const, selfReason: "ok",
  };
  await app.report(rep);
  return { client, app, sid, rep };
}

async function leafSession() {
  const st = await reportedSession();
  await st.app.confirmLeaf({
    sessionId: st.sid, nodeId: "1.1",
    tool: { server: "opencode", name: "read" },
    argSpecs: { path: { kind: "fixed", value: "x.txt" } },
  });
  return st;
}

async function expectRereportPass(app: ProcForgeApp, rep: Record<string, unknown>) {
  const out = await app.report(rep as never);
  expect((out as { verdict: string }).verdict).toBe("pass");
}

describe("M3.5.1-1 재보고 pin 해소", () => {
  it("reopen 후 재보고 통과 + auto 논리 경로", async () => {
    const { client, app, sid, rep } = await leafSession();
    await client.pfReopen({ sessionId: sid, nodeId: "1.1", reason: "t" });
    await expectRereportPass(app, rep);
    const n = await client.getNode(sid, "1.1");
    expect(n.constraints.filter((c) => c.kind === "file_exists").map((c) => c.spec)).toEqual([{ path: "x.txt" }]);
  });

  it("retry 후 재보고 통과", async () => {
    const { app, rep } = await reportedSession();
    // probing 상태에서 fail → retry 소진 없이 probing 유지
    await app.report({ ...rep, selfVerdict: "fail", selfReason: "oops" } as never);
    await expectRereportPass(app, rep);
  });

  it("edit_args 후 재보고 통과", async () => {
    const { app, sid, rep } = await leafSession();
    await app.editArgs({ sessionId: sid, nodeId: "1.1", patch: { set: { path: { kind: "fixed", value: "x.txt" } } } });
    await expectRereportPass(app, rep);
  });
});
