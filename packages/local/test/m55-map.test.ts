import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcForgeApp } from "../src/app/app.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.5-1 map 노드 E2E (fake echo).
// 1.1: {snapshot:{items}} 제공. 2: map(over $1.1..., as item) + 템플릿 2.1(echo).

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");
const ECHO_CAT = [{ server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" }] as never;

type Item = { id: string; v: number };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m55-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m55home-"));
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

async function buildMap(
  items: Item[],
  mapSpec: Record<string, unknown>,
  countSpec: Record<string, unknown>,
  withDownstream = false,
): Promise<void> {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const started = await client.pfStart({ request: "map", params: {}, toolCatalog: ECHO_CAT });
  const sid = started.session.id;
  const kids: { goal: string; dependsOn?: string[] }[] = [{ goal: "목록" }, { goal: "항목 처리", dependsOn: ["1.1"] }];
  if (withDownstream) kids.push({ goal: "후속", dependsOn: ["1.2"] });
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: kids });
  const data = { snapshot: { items } };
  await client.pfReport({
    sessionId: sid, nodeId: "1.1", tool: { server: "fake-ppt", name: "echo" },
    args: { snapshot: data.snapshot }, resultSummary: `${items.length} items`, resultJson: data,
    selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfResolve({
    sessionId: sid, nodeId: "1.1", decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: { snapshot: { kind: "fixed", value: data.snapshot } } as never,
  });
  // map 1.2: probe 2건 보고 → map 지정(인라인 템플릿) + 집계 제약 → 확정
  const templateSpecs = {
    snapshot: { kind: "var", ref: "${item}" },
    title: { kind: "var", ref: "${item.id}" },
  } as never;
  const probe = items.slice(0, 2).map((it) => ({ item: it, v: it.v }));
  await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
    args: { snapshot: items[0], title: items[0].id }, resultSummary: `map probe ${probe.length}`,
    resultJson: probe, selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfEditNode({
    sessionId: sid, nodeId: "1.2",
    addConstraints: [{ id: "c-n", kind: "count", spec: countSpec, source: "human" }],
    map: {
      ...mapSpec,
      template: {
        tool: { server: "fake-ppt", name: "echo" },
        args: templateSpecs,
        constraints: [{ id: "c-v", kind: "numeric_match", spec: { path: "snapshot.v", min: 0 }, source: "human" }],
      },
    } as never,
  });
  const r2 = await client.pfReport({
    sessionId: sid, nodeId: "1.2", tool: { server: "fake-ppt", name: "echo" },
    args: { snapshot: items[0], title: items[0].id }, resultSummary: `map probe ${probe.length}`,
    resultJson: probe, selfVerdict: "pass", selfReason: "ok",
  });
  expect(r2.verdict).toBe("pass");
  const c2 = await client.pfResolve({
    sessionId: sid, nodeId: "1.2", decision: "leaf",
    tool: { server: "fake-ppt", name: "echo" },
    argSpecs: {
      snapshot: { kind: "var", ref: "${item}" },
      title: { kind: "var", ref: "${item.id}" },
    } as never,
  });
  expect((c2.node as { kind?: string }).kind).toBe("map");
  if (withDownstream) {
    const dn = "1.3";
    await client.pfReport({
      sessionId: sid, nodeId: dn, tool: { server: "fake-ppt", name: "echo" },
      args: { note: "done" }, resultSummary: "done", resultJson: { note: "done" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await client.pfResolve({
      sessionId: sid, nodeId: dn, decision: "leaf",
      tool: { server: "fake-ppt", name: "echo" },
      argSpecs: { note: { kind: "fixed", value: "done" } } as never,
    });
  }
  const fin = await app.finalize({ sessionId: sid, name: "m55-map" });
  expect(fin.warnings.filter((w) => w.includes("bad_map") || w.includes("bad_ref"))).toEqual([]);
}

async function runMap(params: Record<string, string> = {}) {
  return runProcedureTest(pfdir, root, "m55-map", {
    procforgeDir: pfdir, projectRoot: root, mode: "live", params,
  });
}

describe("M5.5-1 map 실행", () => {
  it("threshold 0.5: 2/3 통과 + failedItems [1]", async () => {
    await buildMap(
      [{ id: "a", v: 10 }, { id: "b", v: -5 }, { id: "c", v: 7 }],
      { over: "$1.1.output.snapshot.items", as: "item", maxItems: 10, policy: { kind: "threshold", ratio: 0.5 } },
      { min: 1 },
    );
    const { report } = await runMap();
    expect(report.summary.fail).toBe(0);
    const n2 = report.results.find((r) => r.nodeId === "1.2")!;
    expect(n2.status).toBe("pass");
    expect(n2.failedItems).toEqual([1]);
  }, 120000);

  it("all: 1건 실패 → policy fail + 하류 blocked", async () => {
    await buildMap(
      [{ id: "a", v: 10 }, { id: "b", v: -5 }, { id: "c", v: 7 }],
      { over: "$1.1.output.snapshot.items", as: "item", policy: { kind: "all" } },
      { min: 1 },
      true,
    );
    const { report } = await runMap();
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    const byId = new Map(report.results.map((r) => [r.nodeId, r]));
    expect(byId.get("1.2")?.status).toBe("fail");
    expect(byId.get("1.2")?.failedConstraints).toContain("policy");
    expect(byId.get("1.2")?.failedItems).toEqual([1]);
    expect(byId.get("1.3")?.status).toBe("blocked");
  }, 120000);

  it("maxItems 2 + count exact 2 (상한 증명)", async () => {
    await buildMap(
      [{ id: "a", v: 10 }, { id: "c", v: 7 }, { id: "d", v: 9 }],
      { over: "$1.1.output.snapshot.items", as: "item", maxItems: 2, policy: { kind: "all" } },
      { exact: 2 },
    );
    const { report } = await runMap();
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(2);
  }, 120000);

  it("any: 1건만 통과해도 pass", async () => {
    await buildMap(
      [{ id: "a", v: -1 }, { id: "b", v: 5 }],
      { over: "$1.1.output.snapshot.items", as: "item", policy: { kind: "any" } },
      { min: 1 },
    );
    const { report } = await runMap();
    expect(report.summary.fail).toBe(0);
    expect(report.results.find((r) => r.nodeId === "1.2")?.failedItems).toEqual([0]);
  }, 120000);
});
