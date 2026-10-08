import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { collectCatalog } from "../src/catalog.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { ingestArtifacts } from "../src/artifacts.js";
import { validateTree } from "../src/validator.js";
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
  root = mkdtempSync(join(tmpdir(), "pf-e2e-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "data", "slides.pptx"), "fake-pptx-bytes");
  writeFileSync(join(root, "template.j2"), "template {{month}}");
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }),
  );
  client = createLocalStack(pfdir).client;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function doLeaf(opts: {
  sessionId: string;
  nodeId: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  resultSummary: string;
  resultJson?: unknown;
  artifactPaths?: string[];
  argSpecs: Record<string, { kind: "fixed"; value: unknown } | { kind: "var"; ref: string }>;
}) {
  const attemptId = `a-${randomBytes(4).toString("hex")}`;
  let stored: string[] = [];
  let contents: Record<string, string> = {};
  if (opts.artifactPaths?.length) {
    const ing = ingestArtifacts({
      procforgeDir: pfdir,
      sessionId: opts.sessionId,
      nodeId: opts.nodeId,
      attemptId,
      projectRoot: root,
      paths: opts.artifactPaths,
    });
    stored = ing.stored;
    contents = ing.contents;
  }
  const r = await client.pfReport({
    sessionId: opts.sessionId,
    nodeId: opts.nodeId,
    tool: opts.tool,
    args: opts.args,
    resultSummary: opts.resultSummary,
    resultJson: opts.resultJson,
    artifacts: stored,
    artifactContents: contents,
    selfVerdict: "pass",
    selfReason: "scripted host ok",
    attemptId,
  });
  expect(r.verdict).toBe("pass");
  const done = await client.pfResolve({
    sessionId: opts.sessionId,
    nodeId: opts.nodeId,
    decision: "leaf",
    tool: opts.tool,
    argSpecs: opts.argSpecs as never,
  });
  expect(done.node.status).toBe("leaf");
}

describe("M2 E2E 월간보고서 (fake-ppt-mcp + scripted host)", () => {
  it("split → probing → resolve(leaf) → 전 노드 leaf, done", async () => {
    const collected = await collectCatalog(root);
    expect(collected.entries.some((e) => e.server === "fake-ppt" && e.name === "list_slides")).toBe(true);

    const started = await client.pfStart({
      request: "9월 월간보고서를 pptx로 만들어라",
      params: { month: "2026-09" },
      toolCatalog: collected.entries,
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 20 },
    });
    const sid = started.session.id;
    expect(started.instruction).toMatch(/sandbox/);

    let nxt = await client.pfNext(sid);
    if (nxt.done) throw new Error("expected root node");
    expect(nxt.node.id).toBe("1");
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "슬라이드 목록 읽기" }, { goal: "2번 슬라이드 읽기", dependsOn: ["1.1"] }, { goal: "템플릿 채우기", dependsOn: ["1.1", "1.2"] }],
    });

    await doLeaf({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "fake-ppt", name: "list_slides" },
      args: { file: "data/slides.pptx" },
      resultSummary: "슬라이드 3장 확인",
      resultJson: { slides: ["표지", "실적", "전망"] },
      argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" } },
    });
    await doLeaf({
      sessionId: sid,
      nodeId: "1.2",
      tool: { server: "fake-ppt", name: "read_slide" },
      args: { file: "data/slides.pptx", index: 2 },
      resultSummary: "2번 슬라이드 읽기",
      resultJson: { title: "슬라이드2", body: "본문" },
      argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" }, index: { kind: "fixed", value: 2 } },
    });

    writeFileSync(join(root, "out", "report-2026-09.pptx"), "filled-report");
    await doLeaf({
      sessionId: sid,
      nodeId: "1.3",
      tool: { server: "fake-ppt", name: "fill_template" },
      args: { template: "template.j2", month: "2026-09" },
      resultSummary: "템플릿 채우기 완료",
      resultJson: { output: "report-2026-09.pptx" },
      artifactPaths: ["out/report-2026-09.pptx"],
      argSpecs: { template: { kind: "fixed", value: "template.j2" }, month: { kind: "var", ref: "${params.month}" } },
    });

    expect(await client.pfNext(sid)).toEqual({ done: true });

    // .procforge 저장 검증
    expect(existsSync(join(pfdir, "sessions", sid, "session.json"))).toBe(true);
    for (const id of ["1", "1.1", "1.2", "1.3"]) {
      expect(existsSync(join(pfdir, "sessions", sid, "nodes", `${id}.json`))).toBe(true);
    }
    const reread = new FileStore(pfdir);
    const n13 = reread.getNode(sid, "1.3")!;
    expect(n13.status).toBe("leaf");
    expect(n13.golden?.fixtures.length).toBe(1);
    const fixtureAbs = join(pfdir, "sessions", sid, n13.golden!.fixtures[0]);
    expect(readFileSync(fixtureAbs, "utf8")).toBe("filled-report");

    // validator 통과
    const { session, nodes } = await client.pfTree(sid);
    expect(validateTree(session, nodes)).toEqual([]);
  }, 30000);

  it("실패 경로: fail 2회 → needs_human → advise → open → pass", async () => {
    const collected = await collectCatalog(root);
    const started = await client.pfStart({
      request: "실패 경로",
      toolCatalog: collected.entries,
      limits: { maxDepth: 3, maxRetries: 1, maxNodes: 10 },
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "읽기" }] });

    const fail = () =>
      client.pfReport({
        sessionId: sid,
        nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        args: { file: "data/slides.pptx" },
        resultSummary: "깨짐",
        selfVerdict: "fail",
        selfReason: "결과가 비었음",
      });
    const r1 = await fail();
    expect(r1.verdict).toBe("fail");
    let tree = await client.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("probing");
    const r2 = await fail();
    expect(r2.verdict).toBe("fail");
    tree = await client.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("needs_human");

    const adv = await client.pfAdvise(sid, "1.1", "슬라이드는 1개");
    expect(adv.constraints.length).toBeGreaterThan(0);
    tree = await client.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("open");

    writeFileSync(join(root, "out", "report.md"), "# report");
    const attemptId = "a-retry1";
    const ing = ingestArtifacts({
      procforgeDir: pfdir,
      sessionId: sid,
      nodeId: "1.1",
      attemptId,
      projectRoot: root,
      paths: ["out/report.md"],
    });
    const r3 = await client.pfReport({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "fake-ppt", name: "list_slides" },
      args: { file: "data/slides.pptx" },
      resultSummary: "재시도 성공",
      resultJson: { items: ["표지"] },
      artifacts: ing.stored,
      artifactContents: ing.contents,
      selfVerdict: "pass",
      selfReason: "파일 확인",
      attemptId,
    });
    expect(r3.verdict).toBe("pass");
    const leaf = await client.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "fake-ppt", name: "list_slides" },
      argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" } } as never,
    });
    expect(leaf.node.status).toBe("leaf");
  }, 30000);
});
