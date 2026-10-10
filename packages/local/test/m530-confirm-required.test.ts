import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { testStack } from "./client-mode.js";

// M5.3-0-2: BC 실사용 세션(05017105, 1.2 가짜 leaf) 회귀.
// redacted export(export-bc.zip)를 fixture로 보관하고, 동일 형상
// (opencode/bash + required command 누락 argSpecs)의 confirm이
// "missing required: command"로 거부됨을 확인한다.

const FIXTURE_ZIP = resolve(__dirname, "fixtures/bc-guide-session/export-bc.zip");

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m530-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m530home-"));
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

const BASH_CAT = [
  {
    server: "opencode", name: "bash",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    schemaHash: "b1",
  },
] as never;

describe("M5.3-0-2 필수 인자 없는 leaf confirm 거부", () => {
  it("fixture 존재 + 동일 형상 거부", async () => {
    expect(existsSync(FIXTURE_ZIP)).toBe(true);
    const { client } = testStack(pfdir);
    const started = await client.pfStart({ request: "BC 가이드", params: {}, toolCatalog: BASH_CAT });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "GUIDE.md 작성" }] });
    const attemptId = randomUUID();
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "opencode", name: "bash" },
      args: { lang: "ko", lines: 45, path: "GUIDE.md" },
      resultSummary: "GUIDE.md 작성 완료", resultJson: { ok: true },
      artifacts: [], artifactContents: {},
      selfVerdict: "pass", selfReason: "작성 확인", attemptId,
    });
    await expect(client.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "opencode", name: "bash" },
      argSpecs: {
        lang: { kind: "fixed", value: "ko" },
        lines: { kind: "fixed", value: 45 },
        path: { kind: "fixed", value: "GUIDE.md", path: "out" },
      } as never,
    })).rejects.toThrow(/missing required: command/);
  }, 60000);
});
