import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { swapDir, writeProcedure } from "../src/services/procedureWriter.js";

// M5.8.1-3: finalize/export 경로 무명 예외 금지.
// E2E 잔재(.tmp-* 4개, 완성 파일 있음, 교체 안 됨)와 일치하는 실패 구간
// (빌드~교체 사이 fs 실패)은 coded 에러여야 한다.

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
});
