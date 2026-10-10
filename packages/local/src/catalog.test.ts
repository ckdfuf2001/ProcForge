import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_BY_MAJOR,
  BUILTIN_TOOLS,
  builtinMajor,
  builtinToolsFor,
  collectCatalog,
  DEFAULT_CATALOG_TIMEOUT_MS,
  detectOpencodeVersion,
} from "../src/catalog.js";
import { ConnectionPool } from "../src/runner/connections.js";
import { FileStore } from "../src/filestore.js";

describe("M3.6-7 카탈로그 버전", () => {
  it("현행 major 스키마: read에 offset/limit", () => {
    expect(Object.keys(BUILTIN_BY_MAJOR)).toContain("1");
    const { entries, warnings } = builtinToolsFor("1.2.3");
    expect(warnings).toEqual([]);
    const read = entries.find((e) => e.name === "read")!;
    const props = (read.inputSchema as Record<string, Record<string, unknown>>)["properties"]!;
    expect(props["offset"]).toBeDefined();
    expect(props["limit"]).toBeDefined();
    expect((read.inputSchema as Record<string, unknown>)["additionalProperties"]).toBeUndefined();
  });

  it("모르는 버전은 허용 + 경고", () => {
    for (const v of ["9.9.9", "unknown", undefined]) {
      const r = builtinToolsFor(v);
      expect(r.warnings.join()).toMatch(/모르는 opencode 버전/);
      const read = r.entries.find((e) => e.name === "read")!;
      expect((read.inputSchema as Record<string, unknown>)["additionalProperties"]).toBe(true);
    }
    expect(builtinMajor("1.2.3")).toBe("1");
    expect(builtinMajor("unknown")).toBeUndefined();
  });

  it("BUILTIN_TOOLS 호환 (기존 import 유지)", () => {
    expect(BUILTIN_TOOLS.map((e) => e.name)).toEqual(["read", "write", "edit", "bash", "glob", "grep"]);
  });

  it("detectOpencodeVersion 파싱/폴백", () => {
    expect(detectOpencodeVersion(() => ({ stdout: "opencode version 1.2.3 (abc)\n" }))).toBe("1.2.3");
    expect(detectOpencodeVersion(() => ({ stdout: "1.0.0" }))).toBe("1.0.0");
    expect(detectOpencodeVersion(() => { throw new Error("nope"); })).toBe("unknown");
    expect(detectOpencodeVersion(() => ({ stdout: "bin executable does not exist" }))).toBe("unknown");
  });

  it("세션 버전 FileStore 왕복", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-catstore-"));
    const store = new FileStore(dir);
    const id = randomUUID();
    store.saveSession({
      id, request: "r", params: {}, toolCatalog: [], rootId: "1",
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
      createdAt: new Date().toISOString(), opencodeVersion: "1.2.3",
    });
    expect(store.getSession(id)?.opencodeVersion).toBe("1.2.3");
  });
  it("runner read offset/limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-cat-"));
    writeFileSync(join(dir, "a.txt"), "l0\nl1\nl2\nl3");
    const pool = new ConnectionPool(dir, dir);
    try {
      const full = await pool.call("opencode", "read", { path: "a.txt" });
      expect(full.resultText).toBe("l0\nl1\nl2\nl3");
      const part = await pool.call("opencode", "read", { path: "a.txt", offset: 1, limit: 2 });
      expect(part.resultText).toBe("l1\nl2");
      await expect(pool.call("opencode", "read", { path: "a.txt", offset: -1 })).rejects.toThrow();
    } finally {
      await pool.close();
    }
  });
});

describe("M3.5.1-4 카탈로그 타임아웃·재시도", () => {
  it("기본 타임아웃 15s", () => {
    expect(DEFAULT_CATALOG_TIMEOUT_MS).toBe(15000);
  });

  it("첫 실패 서버는 1회 재시도 후 수집", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-catflaky-"));
    const here = dirname(fileURLToPath(import.meta.url));
    const flag = join(dir, "flag");
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({
        mcp: {
          flaky: {
            type: "local",
            command: [process.execPath, resolve(here, "../test/fixtures/flaky-mcp-server.mjs")],
            environment: { FLAG_PATH: flag },
          },
        },
      }),
    );
    const c = await collectCatalog(dir, { timeoutMs: 20000 });
    expect(c.entries.some((e) => e.server === "flaky" && e.name === "ping")).toBe(true);
    expect(c.warnings.filter((w) => w.startsWith("flaky:"))).toEqual([]);
  }, 60000);

  it("계속 실패 서버는 경고 + 내장 항목 유지", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-catbad-"));
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { bad: { type: "local", command: ["nonexistent-procforge-bin-xyz"] } } }),
    );
    const c = await collectCatalog(dir, { timeoutMs: 10000 });
    expect(c.warnings.some((w) => w.startsWith("bad:"))).toBe(true);
    expect(c.entries.some((e) => e.server === "opencode" && e.name === "read")).toBe(true);
  }, 60000);
});
