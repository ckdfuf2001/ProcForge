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
  it("규칙 테이블", () => {
    expect(inferPathRole("output")).toBe("out");
    expect(inferPathRole("outputPath")).toBe("out");
    expect(inferPathRole("dest")).toBe("out");
    expect(inferPathRole("path")).toBe("in");
    expect(inferPathRole("file")).toBe("in");
    expect(inferPathRole("template")).toBe("in");
    expect(inferPathRole("configFile")).toBe("in");
    expect(inferPathRole("month")).toBeUndefined();
    expect(inferPathRole("index")).toBeUndefined();
    expect(inferPathRole("data", { type: "object", properties: { data: { format: "file" } } })).toBe("in");
  });
});

describe("rewritePaths", () => {
  it("in은 존재 필수, out은 매핑만", () => {
    const r = rewritePaths({ a: "in.txt", o: "output/x.pptx", m: "2026-09" }, { a: "in", o: "out", m: undefined }, fsDir);
    expect(r["a"]).toBe(join(fsDir, "in.txt"));
    expect(r["o"]).toBe(join(fsDir, "output", "x.pptx"));
    expect(r["m"]).toBe("2026-09");
  });

  it("in 부재·탈출·fs밖 out 거부", () => {
    expect(() => rewritePaths({ a: "nope.txt" }, { a: "in" }, fsDir)).toThrow(/입력 없음/);
    expect(() => rewritePaths({ a: "../x" }, { a: "in" }, fsDir)).toThrow(/탈출/);
    const absOut = process.platform === "win32" ? "C:\\Windows\\x.pptx" : "/etc/x.pptx";
    expect(() => rewritePaths({ o: absOut }, { o: "out" }, fsDir)).toThrow(/run fs 밖/);
  });
});
