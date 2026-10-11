import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProcedureRef } from "./procedure-run.js";

// M5.6-a: .json 파일 / bare name·procedures/ 접두 / 디렉터리 3형식이
// 같은 {dir, file}로 수렴 (+ 파일 해시 동일).

function setup(): { pfdir: string; file: string } {
  const pfdir = join(mkdtempSync(join(tmpdir(), "pf-m56a-")), ".procforge");
  mkdirSync(join(pfdir, "procedures", "p1"), { recursive: true });
  const file = join(pfdir, "procedures", "p1", "procedure.json");
  writeFileSync(file, JSON.stringify({ name: "p1" }));
  return { pfdir, file };
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("M5.6-a ref 3형식 통일", () => {
  it("bare name·.json·디렉터리 → 같은 dir·해시", () => {
    const { pfdir, file } = setup();
    const byName = resolveProcedureRef(pfdir, "p1");
    const byFile = resolveProcedureRef(pfdir, file);
    const byDir = resolveProcedureRef(pfdir, join(pfdir, "procedures", "p1"));
    expect(byFile).toEqual(byName);
    expect(byDir).toEqual(byName);
    expect(sha(byFile.file)).toBe(sha(byName.file));
    // procedures/ 접두도 bare name과 동일.
    const byPrefixed = resolveProcedureRef(pfdir, "procedures/p1");
    expect(byPrefixed).toEqual(byName);
  });

  it("win32 역슬래시 정규화", () => {
    if (process.platform !== "win32") return;
    const { pfdir } = setup();
    const a = resolveProcedureRef(pfdir, "p1");
    const b = resolveProcedureRef(pfdir, "procedures\\p1");
    expect(b).toEqual(a);
  });

  it("없는 ref → not_found", () => {
    const { pfdir } = setup();
    expect(() => resolveProcedureRef(pfdir, "nope")).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
