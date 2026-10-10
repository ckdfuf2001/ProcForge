import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runScript } from "./script-run.js";
import { ArgSpecSchema } from "@procforge/shared/schema.js";
import { resolveArgs } from "./resolve.js";

// M5.2-2: 스크립트 실행 단위 + 계약 테스트.

let root: string;
let fsDir: string;

function havePython(): boolean {
  try {
    execFileSync("python", ["--version"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-script-"));
  fsDir = join(root, "fs");
  mkdirSync(fsDir, { recursive: true });
});

describe("runScript", () => {
  it("node 스크립트: stdin 인자 → stdout JSON", () => {
    const f = join(root, "echo.mjs");
    writeFileSync(f, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);process.stdout.write(JSON.stringify({summary:'n='+a.n,json:{got:a}}));});");
    const r = runScript({ runtime: "node", scriptAbs: f, args: { n: 3 }, cwd: fsDir });
    expect(r.summary).toBe("n=3");
    expect(r.json).toEqual({ got: { n: 3 } });
  });

  it("python 스크립트: stdin 인자 → stdout JSON", () => {
    if (!havePython()) return;
    const f = join(root, "echo.py");
    writeFileSync(f, "import json,sys\na=json.load(sys.stdin)\nprint(json.dumps({'summary':'ok','json':{'got':a}}))");
    const r = runScript({ runtime: "python", scriptAbs: f, args: { n: 3 }, cwd: fsDir });
    expect(r.summary).toBe("ok");
    expect(r.json).toEqual({ got: { n: 3 } });
  });

  it("python 한글 stdio도 UTF-8 (로캘 무관)", () => {
    if (!havePython()) return;
    const f = join(root, "ko.py");
    writeFileSync(f, "import json,sys\na=json.load(sys.stdin)\nprint(json.dumps({'summary':a['t'],'json':{'t':a['t']}},ensure_ascii=False))");
    const r = runScript({ runtime: "python", scriptAbs: f, args: { t: "월간보고서 2026-10 (최종)" }, cwd: fsDir });
    expect(r.summary).toBe("월간보고서 2026-10 (최종)");
    expect(r.json).toEqual({ t: "월간보고서 2026-10 (최종)" });
  });
  it("비정상 종료·비JSON·타임아웃은 throw", () => {
    const bad = join(root, "bad.mjs");
    writeFileSync(bad, "console.error('boom');process.exit(3);");
    expect(() => runScript({ runtime: "node", scriptAbs: bad, args: {}, cwd: fsDir })).toThrowError(/비정상 종료\(3\)/);
    const notJson = join(root, "notjson.mjs");
    writeFileSync(notJson, "process.stdout.write('plain text');");
    expect(() => runScript({ runtime: "node", scriptAbs: notJson, args: {}, cwd: fsDir })).toThrowError(/JSON 아님/);
    const slow = join(root, "slow.mjs");
    writeFileSync(slow, "setTimeout(()=>process.stdout.write('{}'),5000);");
    expect(() => runScript({ runtime: "node", scriptAbs: slow, args: {}, cwd: fsDir, timeoutMs: 300 })).toThrowError(/타임아웃/);
  });
});

describe("script kind 계약", () => {
  it("ArgSpecSchema가 script 수용 + runtime 기본값", () => {
    const p = ArgSpecSchema.parse({ kind: "script", file: "scripts/1_1.py" });
    expect(p.kind).toBe("script");
    expect((p as { runtime: string }).runtime).toBe("python");
  });

  it("resolveArgs는 file 원문 유지", () => {
    const out = resolveArgs({
      specs: { s: { kind: "script", file: "scripts/1_1.py" } as never, m: { kind: "fixed", value: 1 } as never },
      params: {}, outputs: new Map(), attempts: [], live: true,
    });
    expect(out.s).toBe("scripts/1_1.py");
    expect(out.m).toBe(1);
  });
});
