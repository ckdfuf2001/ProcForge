import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.5-2 until 노드 E2E (fake page: "" → [a,b]/p2 → [c]/null).
// 2: until(본문 2.1 page, cursor var $self) + count 집계.

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const PAGE_CAT = [{ server: "fake-ppt", name: "page", inputSchema: {}, schemaHash: "h" }] as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m552-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m552home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function buildUntil(maxIterations: number): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "pages", params: {}, toolCatalog: PAGE_CAT });
  const sid = started.session.id;
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "페이지 순회" }] });
  const page0 = { items: ["a", "b"], nextCursor: "p2" };
  const templateSpecs = {
    cursor: { kind: "var", ref: "$self" },
  } as never;
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "page" },
    args: { cursor: "" }, resultSummary: "page 2 items", resultJson: page0,
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.1",
    addConstraints: [{ id: "c-n", kind: "count", spec: { min: 1 }, source: "human" }],
    until: {
      until: { id: "c-done", kind: "equals", spec: { path: "nextCursor", expected: null }, source: "human" },
      maxIterations,
      carry: "$self.nextCursor",
      template: {
        tool: { server: "fake-ppt", name: "page" },
        args: templateSpecs,
        constraints: [],
      },
    } as never,
  });
  const r = await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "page" },
    args: { cursor: "" }, resultSummary: "probe 1 page", resultJson: [page0],
    selfVerdict: "pass", selfReason: "ok",
  });
  expect(r.verdict).toBe("pass");
  const c = await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "page" },
    argSpecs: { cursor: { kind: "var", ref: "$self" } } as never,
  });
  expect((c.node as { kind?: string }).kind).toBe("until");
  const fin = await app.finalize({ sessionId: sid, name: "m55-until" });
  expect(fin.warnings.filter((w) => w.includes("bad_until") || w.includes("bad_ref"))).toEqual([]);
}

describe("M5.5-2 until 실행", () => {
  it("2페이지 순회 후 종료", async () => {
    await buildUntil(5);
    const { report } = await runProcedureTest(pfdir, root, "m55-until", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.fail).toBe(0);
    expect(report.results.find((r) => r.nodeId === "1.1")?.status).toBe("pass");
  }, 120000);

  it("maxIterations 도달 시 fail", async () => {
    await buildUntil(1);
    const { report } = await runProcedureTest(pfdir, root, "m55-until", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    const n = report.results.find((r) => r.nodeId === "1.1")!;
    expect(n.status).toBe("fail");
    expect(n.failedConstraints).toContain("maxIterations");
  }, 120000);
});
