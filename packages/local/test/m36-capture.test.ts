import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { FileStore } from "../src/filestore.js";
import { fixtureFileExists } from "../src/artifacts.js";
import { runSession } from "../src/runner/index.js";

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

const serverMjs = resolve(__dirname, "fixtures/fake-ppt-mcp/server.mjs");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m36-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m36home-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  writeFileSync(join(root, "data.pptx"), "PPTX-DATA");
  writeFileSync(join(root, "template.j2"), "template {{month}}");
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", serverMjs] } } }));
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

async function linked() {
  const { client } = createLocalStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  const server = buildServer({ app, procforgeDir: pfdir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "m36-host", version: "0.0.0" });
  await server.connect(st);
  await mcp.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${(r.content as { text: string }[])[0].text}`);
    return r.structuredContent as Record<string, unknown>;
  };
  return { call, close: async () => { await mcp.close(); await server.close(); } };
}

const slidesSummary = JSON.stringify({ slides: ["표지", "실적", "전망"] });
const slide1Summary = JSON.stringify({ title: "슬라이드1", body: "본문" });

describe("M3.6-2 입력 자동 캡처", () => {
  it("in/inout 인자 자동 ingest → allowProjectRead=false passthrough 통과", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", {
        request: "월간보고서", params: { month: "2026-09" }, seedFiles: ["data.pptx", "template.j2"],
      });
      const sid = started["sessionId"] as string;
      await call("pf_split", {
        sessionId: sid, nodeId: "1",
        children: [{ goal: "목록" }, { goal: "읽기", dependsOn: ["1.1"] }, { goal: "채우기", dependsOn: ["1.1", "1.2"] }],
      });
      const store = new FileStore(pfdir);
      // 1.1: artifacts 제출 없이 보고 → data.pptx 자동 캡처
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "data.pptx" },
        resultSummary: slidesSummary, resultJson: JSON.parse(slidesSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      const n11 = store.getNode(sid, "1.1")!;
      expect(n11.attempts[0].artifacts.length).toBe(1);
      expect(readFileSync(join(pfdir, "sessions", sid, n11.attempts[0].artifacts[0]), "utf8")).toBe("PPTX-DATA");
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" } },
      });
      // 1.2
      await call("pf_report", {
        sessionId: sid, nodeId: "1.2",
        tool: { server: "fake-ppt", name: "read_slide" }, args: { file: "data.pptx", index: 1 },
        resultSummary: slide1Summary, resultJson: JSON.parse(slide1Summary),
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.2",
        tool: { server: "fake-ppt", name: "read_slide" },
        argSpecs: { file: { kind: "fixed", value: "data.pptx" }, index: { kind: "fixed", value: 1 } },
      });
      // 1.3: template.j2 자동 캡처 (sandbox 시드)
      const outSummary = JSON.stringify({ output: "output/report.pptx", month: "2026-09" });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.3",
        tool: { server: "fake-ppt", name: "fill_template" },
        args: { template: "template.j2", month: "2026-09", output: "output/report.pptx" },
        resultSummary: outSummary, resultJson: JSON.parse(outSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.3",
        tool: { server: "fake-ppt", name: "fill_template" },
        argSpecs: {
          template: { kind: "fixed", value: "template.j2" },
          month: { kind: "var", ref: "${params.month}" },
          output: { kind: "fixed", value: "output/report.pptx", path: "out" },
        },
        ignore: ["output"],
      });
      expect(new FileStore(pfdir).getNode(sid, "1.3")!.golden?.fixtures.length).toBe(1);
      // 프로젝트 폴백 없이 passthrough 전부 통과
      const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: false, sessionId: sid, mode: "passthrough" });
      expect(rep.summary.fail).toBe(0);
      expect(rep.summary.pass).toBe(3);
    } finally {
      await close();
    }
  }, 60000);

  it("확정 시 추캡처: 보고 때 없던 파일도 명시 in이면 수집", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", { request: "늦은 파일" });
      const sid = started["sessionId"] as string;
      await call("pf_split", { sessionId: sid, nodeId: "1", children: [{ goal: "a" }] });
      await call("pf_report", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" }, args: { file: "late.pptx" },
        resultSummary: slidesSummary, resultJson: JSON.parse(slidesSummary),
        selfVerdict: "pass", selfReason: "ok",
      });
      expect(new FileStore(pfdir).getNode(sid, "1.1")!.attempts[0].artifacts.length).toBe(0);
      // 도구 실행 후 생긴 파일 (보고 이후)
      mkdirSync(join(pfdir, "sandbox", sid), { recursive: true });
      writeFileSync(join(pfdir, "sandbox", sid, "late.pptx"), "LATE");
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1.1",
        tool: { server: "fake-ppt", name: "list_slides" },
        argSpecs: { file: { kind: "fixed", value: "late.pptx", path: "in" } },
      });
      const n = new FileStore(pfdir).getNode(sid, "1.1")!;
      expect(n.status).toBe("leaf");
      expect(n.golden?.fixtures.length).toBe(1);
      expect(readFileSync(join(pfdir, "sessions", sid, n.golden!.fixtures[0]), "utf8")).toBe("LATE");
    } finally {
      await close();
    }
  }, 30000);
});

describe("M3.6-3 출력 자동 캡처", () => {
  it("out 인자 + 응답 JSON 파일 자동 ingest, file_exists 부착", async () => {
    const { call, close } = await linked();
    try {
      const started = await call("pf_start", {
        request: "출력 캡처", params: { month: "2026-09" }, seedFiles: ["template.j2"],
      });
      const sid = started["sessionId"] as string;
      // 호스트가 도구를 실행해 sandbox에 산출물을 만든 상태
      mkdirSync(join(pfdir, "sandbox", sid, "out"), { recursive: true });
      writeFileSync(join(pfdir, "sandbox", sid, "out", "report.pptx"), "PPTX-OUT-BYTES");
      await call("pf_report", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "fill_template" },
        args: { template: "template.j2", month: "2026-09", output: "out/report.pptx" },
        resultSummary: JSON.stringify({ output: "out/report.pptx", month: "2026-09" }),
        resultJson: { output: "out/report.pptx", month: "2026-09" },
        selfVerdict: "pass", selfReason: "ok",
      });
      const store = new FileStore(pfdir);
      const n = store.getNode(sid, "1")!;
      // in(template) + out(output, 응답 JSON 중복은 제거) = 2개
      expect(n.attempts[0].artifacts.length).toBe(2);
      const bodies = n.attempts[0].artifacts.map((fx) => readFileSync(join(pfdir, "sessions", sid, fx), "utf8")).sort();
      expect(bodies).toEqual(["PPTX-OUT-BYTES", "template {{month}}"]);
      // auto file_exists 부착 (첫 pass, 산출물마다)
      expect(n.constraints.filter((c) => c.kind === "file_exists").length).toBe(2);
      await call("pf_confirm_leaf", {
        sessionId: sid, nodeId: "1",
        tool: { server: "fake-ppt", name: "fill_template" },
        argSpecs: {
          template: { kind: "fixed", value: "template.j2" },
          month: { kind: "var", ref: "${params.month}" },
          output: { kind: "fixed", value: "out/report.pptx", path: "out" },
        },
        ignore: ["output"],
      });
      // record 후 replay: 폴백 없이 통과 (file_exists는 존재+크기로 판정)
      await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: true, sessionId: sid, mode: "record" });
      const rep = await runSession({ procforgeDir: pfdir, projectRoot: root, allowProjectRead: false, sessionId: sid, mode: "replay" });
      expect(rep.summary.fail).toBe(0);
      expect(rep.summary.pass).toBe(1);
    } finally {
      await close();
    }
  }, 60000);

  it("fixtureFileExists: 바이너리는 존재+크기>0", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-m36fx-"));
    writeFileSync(join(dir, "a.pptx"), "x");
    writeFileSync(join(dir, "empty.pptx"), "");
    writeFileSync(join(dir, "empty.txt"), "");
    expect(fixtureFileExists(join(dir, "a.pptx"))).toBe(true);
    expect(fixtureFileExists(join(dir, "empty.pptx"))).toBe(false);
    expect(fixtureFileExists(join(dir, "empty.txt"))).toBe(true);
    expect(fixtureFileExists(join(dir, "missing.pptx"))).toBe(false);
  });
});


