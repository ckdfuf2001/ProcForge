import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, TOOL_NAMES } from "../src/server.js";
import { createLocalStack } from "../src/core-inprocess.js";

const MENTIONS = /pf_[a-z_]+/g;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-follow-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-followhome-"));
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

describe("M2.6-1 instruction 도구명 일치", () => {
  it("core instruction 언급 도구는 전부 tools/list에 존재 (pf_resolve 금지)", () => {
    const src = readFileSync(resolve(__dirname, "../../core/src/service.ts"), "utf8");
    expect(src).not.toContain("pf_resolve");
    const mentions = new Set(src.match(MENTIONS) ?? []);
    expect(mentions.size).toBeGreaterThan(0);
    for (const m of mentions) {
      expect((TOOL_NAMES as readonly string[]), m).toContain(m);
    }
  });

  it("서버 description 언급 도구는 전부 등록 도구", () => {
    const src = readFileSync(resolve(__dirname, "../src/server.ts"), "utf8");
    // description 블록만 대략 추출 (registerTool 이전의 title/description 영역은 전체 파일 검사로 대체)
    const mentions = new Set(src.match(MENTIONS) ?? []);
    for (const m of mentions) {
      expect((TOOL_NAMES as readonly string[]), m).toContain(m);
    }
  });
});

describe("instruction-following host E2E", () => {
  it("instruction 첫 언급 도구만 호출해 단일 세션 완료", async () => {
    const { client, store } = createLocalStack(pfdir);
    const server = buildServer({ client, store, procforgeDir: pfdir, projectRoot: root });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "follow-host", version: "0.0.0" });
    await server.connect(st);
    await mcp.connect(ct);
    const seen: string[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        if (r.isError) throw new Error(`${name}: ${(r.content as { text: string }[])[0].text}`);
        return r.structuredContent as Record<string, unknown>;
      };
      const firstOf = (instr: string) => {
        seen.push(instr);
        const m = instr.match(MENTIONS) ?? [];
        if (m.length === 0) throw new Error("no tool mentioned in instruction");
        return m[0];
      };

      const started = await call("pf_start", { request: "x 파일 읽기" });
      const sid = started["sessionId"] as string;
      let action = firstOf(started["instruction"] as string);
      let guard = 0;
      for (;;) {
        if (guard++ > 20) throw new Error("loop guard");
        if (action === "pf_next") {
          const r = await call("pf_next", { sessionId: sid });
          if ((r as { done: boolean }).done) break;
          action = firstOf((r as { instruction: string }).instruction);
        } else if (action === "pf_report") {
          const r = await call("pf_report", {
            sessionId: sid,
            nodeId: ((await call("pf_next", { sessionId: sid }))["node"] as { id: string }).id,
            tool: { server: "opencode", name: "read" },
            args: { path: "x" },
            resultSummary: "done",
            resultJson: { ok: true },
            selfVerdict: "pass",
            selfReason: "follow",
          });
          action = firstOf((r as { instruction: string }).instruction);
        } else if (action === "pf_confirm_leaf") {
          const tree = (await call("pf_tree", { sessionId: sid, detail: "full" })) as {
            entries: { id: string; node: { status: string } }[];
          };
          const target = tree.entries.find((e) => e.node.status === "probing")!.id;
          const r = await call("pf_confirm_leaf", {
            sessionId: sid,
            nodeId: target,
            tool: { server: "opencode", name: "read" },
            argSpecs: { path: { kind: "fixed", value: "x" } },
          });
          action = firstOf((r as { instruction: string }).instruction);
        } else if (action === "pf_split") {
          const tree = (await call("pf_tree", { sessionId: sid, detail: "full" })) as {
            entries: { id: string; node: { status: string } }[];
          };
          const target = tree.entries.find((e) => e.node.status === "open")!.id;
          const r = await call("pf_split", { sessionId: sid, nodeId: target, children: [{ goal: "a" }, { goal: "b" }] });
          action = firstOf((r as { instruction: string }).instruction);
        } else {
          throw new Error(`instruction이 다음 행동이 아닌 도구를 지목: ${action}`);
        }
      }
      // 모든 instruction의 언급 도구가 등록 목록 안
      for (const instr of seen) {
        for (const m of instr.match(MENTIONS) ?? []) {
          expect((TOOL_NAMES as readonly string[]).includes(m), m).toBe(true);
        }
      }
      // 전부 leaf
      const tree = (await call("pf_tree", { sessionId: sid, detail: "full" })) as {
        entries: { node: { status: string } }[];
      };
      expect(tree.entries.length).toBeGreaterThan(0);
      expect(tree.entries.every((e) => e.node.status === "leaf")).toBe(true);
    } finally {
      await mcp.close();
      await server.close();
    }
  }, 30000);
});
