import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectScripts, rewriteAutoFileExists } from "./procedureWriter.js";
import type { ProcedureDoc } from "@procforge/shared/procedure.js";

// M5.2-2: collectScripts 단위 테스트.

let root: string;
let buildDir: string;

function docWith(args: Record<string, unknown>): ProcedureDoc {
  return {
    format: "procforge-procedure", version: 1, name: "p", sourceSession: "s",
    createdAt: new Date().toISOString(), params: {}, toolCatalog: [],
    nodes: [{
      id: "1.1", parentId: "1", goal: "g", depth: 1, dependsOn: [], children: [],
      tool: { server: "host", name: "script", schemaHash: "script" },
      args: args as never, sideEffect: "none", constraints: [],
    }],
  } as unknown as ProcedureDoc;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-collect-"));
  buildDir = join(root, "build");
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "agg.py"), "print('{}')");
});

describe("rewriteAutoFileExists (M5.3.1-1)", () => {
  const FX = "fixtures/1.1/x/0-a.xlsx";
  function docWith(path: string): ProcedureDoc {
    return {
      format: "procforge-procedure", version: 1, name: "p", sourceSession: "s",
      createdAt: new Date().toISOString(), params: {}, toolCatalog: [],
      nodes: [{
        id: "1.1", parentId: "1", goal: "g", depth: 1, dependsOn: [], children: [],
        tool: { server: "host", name: "script", schemaHash: "s" },
        args: { f: { kind: "var", ref: "sales-${params.month}.xlsx", path: "in" } } as never,
        goldenArgs: { f: "sales-2026-09.xlsx" } as never,
        sideEffect: "none",
        constraints: [{ id: "auto-0", kind: "file_exists", spec: { path }, source: "auto" } as never],
      }],
    } as unknown as ProcedureDoc;
  }

  it("바인딩 입력 → 템플릿, 고정 → source rel", () => {
    const manifestFile = join(root, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify({ [FX]: "sales-2026-09.xlsx" }));
    const doc = docWith(FX);
    rewriteAutoFileExists(doc, manifestFile);
    const spec = (doc.nodes[0] as unknown as { constraints: { spec: { path: string } }[] }).constraints[0].spec;
    expect(spec.path).toBe("sales-${params.month}.xlsx");
  });

  it("매핑 없음 → bad_request", () => {
    const manifestFile = join(root, "manifest-empty.json");
    writeFileSync(manifestFile, JSON.stringify({}));
    expect(() => rewriteAutoFileExists(docWith(FX), manifestFile)).toThrowError(/시스템 fixture 경로 잔류/);
  });
});

describe("collectScripts", () => {
  it("수집·경로 재작성", () => {
    const files: string[] = [];
    const doc = docWith({ s: { kind: "script", file: "scripts/agg.py" } });
    collectScripts(doc, root, buildDir, files);
    expect(files).toEqual(["scripts/1_1.py"]);
    expect(existsSync(join(buildDir, "scripts", "1_1.py"))).toBe(true);
    expect(readFileSync(join(buildDir, "scripts", "1_1.py"), "utf8")).toContain("print");
    const spec = (doc.nodes[0] as unknown as { args: Record<string, { file: string }> }).args.s;
    expect(spec.file).toBe("scripts/1_1.py");
  });

  it("미존재·확장자 불가·노드당 2개는 bad_request", () => {
    expect(() => collectScripts(docWith({ s: { kind: "script", file: "scripts/nope.py" } }), root, buildDir, [])).toThrowError(/스크립트 없음/);
    expect(() => collectScripts(docWith({ s: { kind: "script", file: "scripts/agg.sh" } }), root, buildDir, [])).toThrowError(/볼 수 없음/);
    expect(() => collectScripts(docWith({
      a: { kind: "script", file: "scripts/agg.py" },
      b: { kind: "script", file: "scripts/agg.py" },
    }), root, buildDir, [])).toThrowError(/노드당 1개/);
  });
});
