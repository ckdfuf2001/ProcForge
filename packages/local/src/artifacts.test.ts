import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSafePath, ingestArtifacts, setupSandbox, isEscapeRel } from "../src/artifacts.js";

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-art-"));
  pfdir = join(root, ".procforge");
  writeFileSync(join(root, "report.txt"), "hello");
});

const ing = (paths: string[], extra: Record<string, unknown> = {}) =>
  ingestArtifacts({
    procforgeDir: pfdir,
    sessionId: "s1",
    nodeId: "1.1",
    attemptId: "a-1",
    baseDir: root,
    paths,
    ...extra,
  });

describe("artifacts", () => {
  it("루트 밖 경로 거부", () => {
    expect(() => assertSafePath(root, "../escape.txt")).toThrow();
    expect(() => assertSafePath(root, "/etc/hosts")).toThrow();
    expect(() => assertSafePath(root, "missing.txt")).toThrow();
  });

  it("isEscapeRel 경계: '..data.json' 허용, '..' 상위 거부", () => {
    expect(isEscapeRel("..data.json", "/")).toBe(false);
    expect(isEscapeRel("..", "/")).toBe(true);
    expect(isEscapeRel("../x", "/")).toBe(true);
    expect(isEscapeRel("a/../../x", "/")).toBe(true);
    expect(isEscapeRel("..\\x", "\\")).toBe(true);
    expect(isEscapeRel("..data.json", "\\")).toBe(false);
  });

  it("'..data.json' 파일은 허용", () => {
    writeFileSync(join(root, "..data.json"), "{}");
    expect(() => assertSafePath(root, "..data.json")).not.toThrow();
  });

  it("ingest → fixtures 복사 + 내용 반환", () => {
    const r = ing(["report.txt"]);
    expect(r.stored).toHaveLength(1);
    expect(r.stored[0]).toMatch(/^fixtures\/1\.1\/a-1\//);
    expect(r.contents[r.stored[0]]).toBe("hello");
    expect(existsSync(join(pfdir, "sessions", "s1", r.stored[0]))).toBe(true);
  });

  it("바이너리는 메타만 전달", () => {
    writeFileSync(join(root, "out.pptx"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    const r = ing(["out.pptx"]);
    const meta = JSON.parse(r.contents[r.stored[0]]) as { nonText: boolean; sha256: string; size: number; mime: string };
    expect(meta.nonText).toBe(true);
    expect(meta.size).toBe(4);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.mime).toContain("presentation");
  });

  it("크기 상한 초과 거부", () => {
    expect(() => ing(["report.txt"], { maxBytes: 2 })).toThrow(/too large/);
  });

  it("sandbox 복사", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "in.txt"), "x");
    const sb = setupSandbox({ procforgeDir: pfdir, sessionId: "s1", projectRoot: root, seedFiles: ["data/in.txt"] });
    expect(sb.copied).toEqual([join("data", "in.txt")]);
    expect(existsSync(join(pfdir, "sandbox", "s1", "data", "in.txt"))).toBe(true);
  });
});
