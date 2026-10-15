import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savePairing, getPairing, loadPairings } from "./pairings.js";

// M7-1: 짝짓기 latest-wins + 이력.

describe("pairings", () => {
  let pfdir: string;
  beforeEach(() => {
    pfdir = join(mkdtempSync(join(tmpdir(), "pf-pair-")), ".procforge");
  });

  it("없으면 빈 대응표", () => {
    expect(loadPairings(pfdir)).toEqual({ pairs: {}, history: [] });
    expect(getPairing(pfdir, "ses_x")).toBeUndefined();
  });

  it("latest-wins + 이력 보존", () => {
    savePairing(pfdir, "ses_a", "pf-1");
    savePairing(pfdir, "ses_a", "pf-2");
    savePairing(pfdir, "ses_b", "pf-3");
    expect(getPairing(pfdir, "ses_a")?.pfSessionId).toBe("pf-2");
    expect(getPairing(pfdir, "ses_b")?.pfSessionId).toBe("pf-3");
    const loaded = loadPairings(pfdir);
    expect(loaded.history.map((h) => h.pfSessionId)).toEqual([
      "pf-1",
      "pf-2",
      "pf-3",
    ]);
  });
});
