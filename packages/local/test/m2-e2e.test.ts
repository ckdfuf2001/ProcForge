import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { validateTree } from "@procforge/shared/validator.js";
import { FileStore } from "../src/filestore.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

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
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function linked() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "e2e-host", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${(r.content as { text: string }[])[0].text}`);
    return r.structuredContent as Record<string, unknown>;
  };
  return { mcp, call, close: async () => { await mcp.close(); await server.close(); } };
}

async function doLeaf(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  opts: {
    sessionId: string;
    nodeId: string;
    tool: { server: string; name: string };
    args: Record<string, unknown>;
    resultSummary: string;
    resultJson?: unknown;
    artifactPaths?: string[];
    argSpecs: Record<string, unknown>;
  },
) {
  const r = await call("pf_report", {
    sessionId: opts.sessionId,
    nodeId: opts.nodeId,
    tool: opts.tool,
    args: opts.args,
    resultSummary: opts.resultSummary,
    resultJson: opts.resultJson,
    artifacts: opts.artifactPaths ?? [],
    selfVerdict: "pass",
    selfReason: "scripted host ok",
  });
  expect(r["verdict"]).toBe("pass");
  const done = await call("pf_confirm_leaf", {
    sessionId: opts.sessionId,
    nodeId: opts.nodeId,
    tool: opts.tool,
    argSpecs: opts.argSpecs,
  });
  expect((done["node"] as { status: string }).status).toBe("leaf");
}

describe("M2 E2E 월간보고서 (fake-ppt-mcp + scripted host, 신도구)", () => {
  it("split → probing → confirm_leaf → 전 노드 leaf, done", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", {
        request: "9월 월간보고서를 pptx로 만들어라",
        params: { month: "2026-09" },
      });
      const sid = started["sessionId"] as string;
      expect(started["instruction"] as string).toMatch(/sandbox/);

      const nxt = await call("pf_next", { sessionId: sid });
      expect((nxt["node"] as { id: string }).id).toBe("1");
      await call("pf_split", {
        sessionId: sid,
        nodeId: "1",
        children: [{ goal: "슬라이드 목록 읽기" }, { goal: "2번 슬라이드 읽기", dependsOn: ["1.1"] }, { goal: "템플릿 채우기", dependsOn: ["1.1", "1.2"] }],
      });

      await doLeaf(call, {
        sessionId: sid,
        nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        args: { file: "data/slides.pptx" },
        resultSummary: "슬라이드 3장 확인",
        resultJson: { slides: ["표지", "실적", "전망"] },
        argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" } },
      });
      await doLeaf(call, {
        sessionId: sid,
        nodeId: "1.2",
        tool: { server: "fake-ppt", name: "read_slide" },
        args: { file: "data/slides.pptx", index: 2 },
        resultSummary: "2번 슬라이드 읽기",
        resultJson: { title: "슬라이드2", body: "본문" },
        argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" }, index: { kind: "fixed", value: 2 } },
      });

      writeFileSync(join(root, "out", "report-2026-09.pptx"), "placeholder");
      // strict sandbox: artifacts는 sandbox/<sid>/ 하위에서 제출
      const sbOut = join(pfdir, "sandbox", sid, "out");
      mkdirSync(sbOut, { recursive: true });
      writeFileSync(join(sbOut, "report-2026-09.pptx"), "filled-report");
      await doLeaf(call, {
        sessionId: sid,
        nodeId: "1.3",
        tool: { server: "fake-ppt", name: "fill_template" },
        args: { template: "template.j2", month: "2026-09" },
        resultSummary: "템플릿 채우기 완료",
        resultJson: { output: "report-2026-09.pptx" },
        artifactPaths: ["out/report-2026-09.pptx"],
        argSpecs: { template: { kind: "fixed", value: "template.j2" }, month: { kind: "var", ref: "${params.month}" } },
      });

      expect(await call("pf_next", { sessionId: sid })).toMatchObject({ done: true });

      // .procforge 저장 검증 (서버와 별도 FileStore로 재읽기)
      expect(existsSync(join(pfdir, "sessions", sid, "session.json"))).toBe(true);
      for (const id of ["1", "1.1", "1.2", "1.3"]) {
        expect(existsSync(join(pfdir, "sessions", sid, "nodes", `${id}.json`))).toBe(true);
      }
      const reread = new FileStore(pfdir);
      const session = reread.getSession(sid)!;
      const nodes = [...reread.getNodes(sid).values()];
      const n13 = reread.getNode(sid, "1.3")!;
      expect(n13.status).toBe("leaf");
      expect(n13.golden?.fixtures.length).toBe(1);
      expect(readFileSync(join(pfdir, "sessions", sid, n13.golden!.fixtures[0]), "utf8")).toBe("filled-report");
      expect(validateTree(session, nodes)).toEqual([]);
    } finally {
      await close();
    }
  }, 30000);

  it("실패 경로: fail 2회 → needs_human → advise → open → pass", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "실패 경로", limits: { maxDepth: 3, maxRetries: 1, maxNodes: 10 } });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "읽기" }] });

      const fail = () =>
        call("pf_report", {
          sessionId: sid,
          nodeId: "1.1",
          tool: { server: "fake-ppt", name: "list_slides" },
          args: { file: "data/slides.pptx" },
          resultSummary: "깨짐",
          selfVerdict: "fail",
          selfReason: "결과가 비었음",
        });
      // maxRetries=1 → 총 2회 시도. 1회 실패는 probing
      const r1 = await fail();
      expect(r1["verdict"]).toBe("fail");
      let tree = (await call("pf_tree", { sessionId: sid, detail: "full" })) as {
        entries: { id: string; node: { status: string } }[];
      };
      expect(tree.entries.find((e) => e.id === "1.1")?.node.status).toBe("probing");
      await fail();
      tree = (await call("pf_tree", { sessionId: sid, detail: "full" })) as {
        entries: { id: string; node: { status: string } }[];
      };
      expect(tree.entries.find((e) => e.id === "1.1")?.node.status).toBe("needs_human");

      const adv = await call("pf_advise", { sessionId: sid, nodeId: "1.1", text: "슬라이드는 1개" });
      expect((adv["constraints"] as unknown[]).length).toBeGreaterThan(0);

      writeFileSync(join(root, "out", "report.md"), "placeholder");
      const sbOut2 = join(pfdir, "sandbox", sid, "out");
      mkdirSync(sbOut2, { recursive: true });
      writeFileSync(join(sbOut2, "report.md"), "# report");
      const r3 = await call("pf_report", {
        sessionId: sid,
        nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        args: { file: "data/slides.pptx" },
        resultSummary: "재시도 성공",
        resultJson: { items: ["표지"] },
        artifacts: ["out/report.md"],
        selfVerdict: "pass",
        selfReason: "파일 확인",
      });
      expect(r3["verdict"]).toBe("pass");
      const leaf = await call("pf_confirm_leaf", {
        sessionId: sid,
        nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data/slides.pptx" } },
      });
      expect((leaf["node"] as { status: string }).status).toBe("leaf");
    } finally {
      await close();
    }
  }, 30000);
});


