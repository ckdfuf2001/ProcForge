import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import { testStack, metaStore, serverSessionDir } from "./client-mode.js";

// M5.8.2 후속: R8 분리 (core 메타 + 로컬 파일 + 마이그레이션) + finalize bad_ref_field.

const CAT = [
  {
    server: "t",
    name: "u",
    inputSchema: {
      type: "object",
      properties: { input: {} },
      additionalProperties: true,
    },
    schemaHash: "h",
  },
] as never;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m582r-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m582rhome-"));
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

describe("M5.8.2 후속 R8 분리", () => {
  it("계약: core 저장 attempt ≤4KB + 메타 (실데이터 별도 파일)", async () => {
    const { client } = testStack(pfdir);
    const started = await client.pfStart({
      request: "r",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    const big = { pad: "x".repeat(100 * 1024) };
    await client.pfReport({
      sessionId: sid,
      nodeId: "1",
      tool: { server: "t", name: "u" },
      args: {},
      resultSummary: "ok",
      resultJson: big,
      selfVerdict: "pass",
      selfReason: "ok",
    });
    const raw = readFileSync(
      join(serverSessionDir(pfdir, sid), "nodes", "1.json"),
      "utf-8",
    );
    // 입력 크기와 무관하게 유계: 5000자 마커런 없음 + 메타 정확 + 미리보기 bounded.
    expect(raw).not.toContain("x".repeat(5000));
    const node = await client.getNode(sid, "1");
    const meta = (
      node.attempts[0] as {
        resultJsonMeta?: { sha256: string; size: number; preview: string };
      }
    ).resultJsonMeta;
    expect(meta?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta?.size).toBeGreaterThan(100 * 1024);
    expect(meta?.preview.length).toBeLessThanOrEqual(4096);
  }, 60000);

  it("app.report가 resultJson 파일을 쓴다", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: root,
    });
    const started = await client.pfStart({
      request: "r",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }],
    });
    await app.next({ sessionId: sid });
    const rep = await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "u" },
      args: {},
      resultSummary: "ok",
      resultJson: { raw: ["a"] },
      selfVerdict: "pass",
      selfReason: "ok",
    } as never);
    expect(rep.verdict).toBe("pass");
    const n = await client.getNode(sid, "1.1");
    const aid = n.attempts[n.attempts.length - 1].id;
    const fp = join(pfdir, "sessions", sid, "resultJson", `${aid}.json`);
    expect(existsSync(fp)).toBe(true);
    expect(JSON.parse(readFileSync(fp, "utf-8"))).toEqual({ raw: ["a"] });
  }, 60000);

  it("구형 inline resultJson 로드 시 1회 분리 마이그레이션", async () => {
    const { client } = testStack(pfdir);
    const started = await client.pfStart({
      request: "r",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    mkdirSync(join(pfdir, "sessions", sid, "nodes"), { recursive: true });
    const aid = "11111111-1111-1111-1111-111111111111";
    writeFileSync(
      join(pfdir, "sessions", sid, "nodes", "1.json"),
      JSON.stringify({
        id: "1",
        parentId: null,
        goal: "g",
        status: "probing",
        depth: 0,
        dependsOn: [],
        children: [],
        sideEffect: "none",
        constraints: [],
        advice: [],
        attempts: [
          {
            id: aid,
            at: "2026-10-13T00:00:00Z",
            tool: { server: "t", name: "u" },
            args: {},
            resultSummary: "ok",
            artifacts: [],
            verdict: "pass",
            failedConstraints: [],
            resultJson: { raw: ["a"] },
          },
        ],
        retries: 0,
        hash: "h",
        locked: false,
      }),
    );
    const store = new FileStore(pfdir);
    const n = store.getNode(sid, "1")!;
    const a = n.attempts[0] as {
      resultJson?: unknown;
      resultJsonMeta?: { sha256: string; size: number };
    };
    expect(a.resultJson).toBeUndefined();
    expect(a.resultJsonMeta?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      JSON.parse(
        readFileSync(
          join(pfdir, "sessions", sid, "resultJson", `${aid}.json`),
          "utf-8",
        ),
      ),
    ).toEqual({ raw: ["a"] });
    // 재로드 안정 (파일 유지, 재기록 없음).
    const n2 = store.getNode(sid, "1")!;
    expect(
      (n2.attempts[0] as { resultJsonMeta?: unknown }).resultJsonMeta,
    ).toBeDefined();
  }, 60000);

  it("finalize: 없는 필드 ref → bad_ref_field", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: root,
    });
    const started = await client.pfStart({
      request: "r",
      params: {},
      toolCatalog: CAT,
    });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    await app.next({ sessionId: sid });
    await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "u" },
      args: {},
      resultSummary: "ok",
      resultJson: { raw: ["a"] },
      selfVerdict: "pass",
      selfReason: "ok",
    } as never);
    await app.confirmLeaf({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "u" },
      argSpecs: {},
    } as never);
    await app.next({ sessionId: sid });
    await app.report({
      sessionId: sid,
      nodeId: "1.2",
      tool: { server: "t", name: "u" },
      args: {},
      resultSummary: "ok",
      resultJson: { n: 1 },
      selfVerdict: "pass",
      selfReason: "ok",
    } as never);
    await app.confirmLeaf({
      sessionId: sid,
      nodeId: "1.2",
      tool: { server: "t", name: "u" },
      argSpecs: { input: { kind: "var", ref: "$1.1.nonexistent" } },
    } as never);
    let code = "";
    try {
      await app.finalize({ sessionId: sid, name: "m582-badref" });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      expect(String(e instanceof Error ? e.message : e)).toMatch(/1\.2\.input/);
    }
    expect(code).toBe("bad_ref_field");
  }, 120000);
});
