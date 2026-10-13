import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { swapDir, writeProcedure } from "../src/services/procedureWriter.js";

// M5.8.1-3: finalize/export 경로 무명 예외 금지.
// E2E 4회 internal 원인 확정: 보고 경로가 fixtures-manifest.json을 만들고
// fixtures/가 없으면 tests/ 미생성 상태로 manifest 복사 → ENOENT (M5.8.1-2 수정).

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m581f-"));
});

function minDoc(name: string) {
  return {
    format: "procforge-procedure", version: 1, name,
    sourceSession: "s", createdAt: "2026-10-12T00:00:00Z",
    params: {}, toolCatalog: [], nodes: [],
  } as never;
}

describe("M5.8.1-3 export 계약", () => {
  it("swapDir 실패 → bad_request (raw ENOENT 금지)", () => {
    const tmp = join(root, "t");
    mkdirSync(tmp, { recursive: true });
    let code = "";
    try {
      swapDir(tmp, join(root, "no-such-parent", "final"));
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("bad_request");
  });

  it("writeProcedure hostile fs → bad_request (internal 금지)", () => {
    const fileAsDir = join(root, "file");
    writeFileSync(fileAsDir, "x");
    let code = "";
    let msg = "";
    try {
      writeProcedure({ procforgeDir: fileAsDir, projectRoot: root, sessionId: "s", doc: minDoc("m581x") });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(code).toBe("bad_request");
    expect(msg).toMatch(/export 실패/);
  });

  it("M5.8.1-2 manifest 있으면 tests/ 생성 후 복사 (E2E internal 회귀)", () => {
    const pfdir = join(root, ".procforge");
    mkdirSync(join(pfdir, "sessions", "s"), { recursive: true });
    writeFileSync(join(pfdir, "sessions", "s", "fixtures-manifest.json"), "{}");
    const out = writeProcedure({ procforgeDir: pfdir, projectRoot: root, sessionId: "s", doc: minDoc("m581m") });
    expect(out.files).toContain("tests/fixtures-manifest.json");
  });
});
