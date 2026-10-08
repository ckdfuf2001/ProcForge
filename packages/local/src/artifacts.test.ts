import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSafePath, ingestArtifacts, setupSandbox } from "../src/artifacts.js";

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-art-"));
  pfdir = join(root, ".procforge");
  writeFileSync(join(root, "report.txt"), "hello");
});

describe("artifacts", () => {
  it("루트 밖 경로 거부", () => {
    expect(() => assertSafePath(root, "../escape.txt")).toThrow();
    expect(() => assertSafePath(root, "/etc/hosts")).toThrow();
    expect(() => assertSafePath(root, "missing.txt")).toThrow();
  });

  it("ingest → fixtures 복사 + 내용 반환", () => {
    const r = ingestArtifacts({
      procforgeDir: pfdir,
      sessionId: "s1",
      nodeId: "1.1",
      attemptId: "a-1",
      projectRoot: root,
      paths: ["report.txt"],
    });
    expect(r.stored).toHaveLength(1);
    expect(r.stored[0]).toMatch(/^fixtures\/1\.1\/a-1\//);
    expect(r.contents[r.stored[0]]).toBe("hello");
    expect(existsSync(join(pfdir, "sessions", "s1", r.stored[0]))).toBe(true);
  });

  it("sandbox 복사", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "in.txt"), "x");
    const sb = setupSandbox({ procforgeDir: pfdir, sessionId: "s1", projectRoot: root, seedFiles: ["data/in.txt"] });
    expect(sb.copied).toEqual([join("data", "in.txt")]);
    expect(existsSync(join(pfdir, "sandbox", "s1", "data", "in.txt"))).toBe(true);
  });
});
