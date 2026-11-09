import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-sidecar: 재finalize 시 history/ + lessons.md 보존 (바이트 동일).

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;
const TOOL = { server: "t", name: "echo" } as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  root = makeTmp("pf-m11sc-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  writeFileSync(join(root, "beacon.py"), "print('{\"ok\": true}')\n", "utf8");
});

describe("M11 sidecar preserve", () => {
  it("재finalize 후 history/와 lessons.md가 바이트 단위로 같다", async () => {
    const s = await app.start({ request: "보존", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({ sessionId: sid, nodeId: "1", reason: "M11 테스트용 분해 사유입니다.", children: [{ goal: "x" }] } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL, args: {},
      resultSummary: "ok", resultJson: {}, selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { script: { kind: "script", file: "beacon.py", runtime: "python" } } as never,
    });
    await app.finalize({ sessionId: sid, name: "m11-sc" });
    const dir = join(pfdir, "procedures", "m11-sc");
    mkdirSync(join(dir, "history"), { recursive: true });
    writeFileSync(join(dir, "history", "h1.json"), '{"v":1}');
    writeFileSync(join(dir, "lessons.md"), "# 교훈\n- 밤 집계를 먼저 한다.\n");
    const beforeHist = readFileSync(join(dir, "history", "h1.json"), "utf8");
    const beforeLessons = readFileSync(join(dir, "lessons.md"), "utf8");
    await app.finalize({ sessionId: sid, name: "m11-sc", force: true } as never);
    expect(readFileSync(join(dir, "history", "h1.json"), "utf8")).toBe(beforeHist);
    expect(readFileSync(join(dir, "lessons.md"), "utf8")).toBe(beforeLessons);
  }, 120000);
});
