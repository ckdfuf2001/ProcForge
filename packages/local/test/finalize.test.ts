import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { collectCatalog } from "../src/catalog.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { finalizeSession, importProcedure, ProcedureDocSchema } from "../src/procedure.js";
import { runProcedureTest, loadProcedureDoc } from "../src/runner/procedure-run.js";
import { runSession } from "../src/runner/run.js";
import { FileStore } from "../src/filestore.js";
import type { CoreClient } from "@procforge/shared/core-client.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;
let client: CoreClient;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-fin-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-finhome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeOpencodeConfig(["node", serverMjs]);
  client = createLocalStack(pfdir).client;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

function writeOpencodeConfig(cmd: string[]) {
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: cmd } } }));
}

async function scripted(): Promise<string> {
  writeFileSync(join(root, "data.pptx"), "x");
  const collected = await collectCatalog(root);
  const started = await client.pfStart({
    request: "보고서",
    params: { month: "2026-09" },
    toolCatalog: collected.entries,
    limits: { maxDepth: 3, maxRetries: 2, maxNodes: 20 },
  });
  const sid = started.session.id;
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "목록" }, { goal: "읽기", dependsOn: ["1.1"] }] });
  const leaf = async (id: string, tool: string, args: Record<string, unknown>, rj: unknown, specs: Record<string, never>) => {
    await client.pfReport({
      sessionId: sid, nodeId: id, tool: { server: "fake-ppt", name: tool }, args,
      resultSummary: JSON.stringify(rj), resultJson: rj, selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({ sessionId: sid, nodeId: id, decision: "leaf", tool: { server: "fake-ppt", name: tool }, argSpecs: specs as never });
  };
  await leaf("1.1", "list_slides", { file: "data.pptx" }, { slides: ["a"] }, { file: { kind: "fixed", value: "data.pptx" } });
  await leaf("1.2", "read_slide", { file: "data.pptx", index: 1 }, { title: "t" }, {
    file: { kind: "fixed", value: "2026-09" },
    index: { kind: "fixed", value: 1 },
  });
  return sid;
}

describe("pf_finalize", () => {
  it("완료 세션 → 산출물 + procedure.json만으로 replay 통과", async () => {
    const sid = await scripted();
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    const out = finalizeSession(pfdir, sid, "monthly-test");
    expect(out.warnings.some((w) => w.includes("2026-09"))).toBe(true);
    for (const f of ["procedure.json", "PROCEDURE.md", "SKILL.md", ".opencode/command/command.md"]) {
      expect(existsSync(join(out.dir, f)), f).toBe(true);
    }
    const doc = ProcedureDocSchema.parse(JSON.parse(readFileSync(join(out.dir, "procedure.json"), "utf8")));
    expect(doc.version).toBe(1);
    expect(doc.nodes.length).toBe(3);
    const md = readFileSync(join(out.dir, "PROCEDURE.md"), "utf8");
    expect(md).toContain("## 단계");
    // procedure.json만으로 replay (fake 서버 차단, 입력은 프로젝트 폴백 허용)
    writeOpencodeConfig(["nonexistent-procforge-tool-xyz"]);
    const { report } = await runProcedureTest(pfdir, root, "monthly-test", { procforgeDir: pfdir, projectRoot: root, mode: "replay", allowProjectRead: true });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(2);
  }, 30000);

  it("미해결 세션은 bad_request + 목록", async () => {
    const sid = await scripted();
    // 1.2를 reopen하여 미해결 상태로
    await client.pfReopen(sid, "1.2", "test");
    expect(() => finalizeSession(pfdir, sid, "bad")).toThrow(/미해결 노드: 1\.2/);
  }, 30000);

  it("params 재바인딩: --param month=2026-10", async () => {
    const sid = await scripted();
    finalizeSession(pfdir, sid, "rebind-test");
    const { doc } = loadProcedureDoc(pfdir, "rebind-test");
    expect(doc.params["month"].default).toBe("2026-09");
    const { sessionId } = importProcedure(pfdir, doc, { month: "2026-10" });
    const store = new FileStore(pfdir);
    expect(store.getSession(sessionId)!.params["month"]).toBe("2026-10");
  }, 30000);
});
