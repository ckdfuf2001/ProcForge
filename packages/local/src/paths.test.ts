import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferPathRole, rewritePaths } from "./runner/paths.js";

let fsDir: string;
beforeEach(() => {
  fsDir = mkdtempSync(join(tmpdir(), "pf-paths-"));
  writeFileSync(join(fsDir, "in.txt"), "x");
});

describe("inferPathRole", () => {
  it("규칙 테이블 (이름 규칙 in은 weakIn)", () => {
    expect(inferPathRole("output")).toBe("out");
    expect(inferPathRole("outputPath")).toBe("out");
    expect(inferPathRole("dest")).toBe("out");
    expect(inferPathRole("path")).toBe("weakIn");
    expect(inferPathRole("file")).toBe("weakIn");
    expect(inferPathRole("file_path")).toBe("weakIn");
    expect(inferPathRole("template")).toBe("weakIn");
    expect(inferPathRole("configFile")).toBe("weakIn");
    expect(inferPathRole("month")).toBeUndefined();
    expect(inferPathRole("index")).toBeUndefined();
    expect(inferPathRole("data", { type: "object", properties: { data: { format: "file" } } })).toBe("in");
  });
});

describe("rewritePaths", () => {
  const o = (extra: Record<string, unknown> = {}) => ({ fsDir, ...extra });
  it("확정 역할만 재작성 (in/out)", () => {
    const r = rewritePaths({ a: "in.txt", o: "output/x.pptx", m: "2026-09" }, { a: "in", o: "out", m: undefined }, o());
    expect(r["a"]).toBe(join(fsDir, "in.txt"));
    expect(r["o"]).toBe(join(fsDir, "output", "x.pptx"));
    expect(r["m"]).toBe("2026-09");
  });

  it("weakIn: 존재→in, 미존재+비readOnly→out", () => {
    const r = rewritePaths({ a: "in.txt", b: "new/out.txt" }, { a: "weakIn", b: "weakIn" }, o());
    expect(r["a"]).toBe(join(fsDir, "in.txt"));
    expect(r["b"]).toBe(join(fsDir, "new", "out.txt"));
  });

  it("미확정 역할은 경고만, 값 유지 (URL 항상 제외)", () => {
    const r = rewritePaths(
      { u: "https://a.b/c", t: "1/2분기", n: "보고서.v2", m: "2026-09" },
      { u: undefined, t: undefined, n: undefined, m: undefined },
      o(),
    );
    expect(r).toEqual({ u: "https://a.b/c", t: "1/2분기", n: "보고서.v2", m: "2026-09" });
  });

  it("in 부재·탈출·fs밖 out 거부", () => {
    expect(() => rewritePaths({ a: "nope.txt" }, { a: "in" }, o())).toThrow(/입력 없음|fixture 없음/);
    expect(() => rewritePaths({ a: "../x" }, { a: "in" }, o())).toThrow(/탈출/);
    const absOut = process.platform === "win32" ? "C:\\Windows\\x.pptx" : "/etc/x.pptx";
    expect(() => rewritePaths({ o: absOut }, { o: "out" }, o())).toThrow(/run fs 밖/);
  });

  it("in 절대경로 + 폴백 off → fixture 에러", () => {
    const abs = join(fsDir, "..", "outside.txt");
    expect(() => rewritePaths({ a: abs }, { a: "in" }, o({ projectRoot: fsDir }))).toThrow(/fixture 없음/);
  });

  it("inout 미존재 → fixture 에러", () => {
    expect(() => rewritePaths({ p: "nope.txt" }, { p: "inout" }, o())).toThrow(/fixture 없음/);
    const r = rewritePaths({ p: "in.txt" }, { p: "inout" }, o());
    expect(r["p"]).toBe(join(fsDir, "in.txt"));
  });

  it("projectRoot 폴백은 allowProjectRead 때만 (확정 in)", () => {
    expect(() => rewritePaths({ a: "in.txt" }, { a: "in" }, { fsDir: join(fsDir, "empty"), projectRoot: fsDir })).toThrow(/fixture 없음/);
    const r = rewritePaths({ a: "in.txt" }, { a: "in" }, { fsDir: join(fsDir, "empty"), projectRoot: fsDir, allowProjectRead: true });
    expect(r["a"]).toBe(join(fsDir, "in.txt"));
  });

  it("readOnly면 미지정 역할도 in", () => {
    expect(() => rewritePaths({ m: "new-file.txt" }, { m: undefined }, { fsDir, toolReadOnly: true })).toThrow();
  });
});
