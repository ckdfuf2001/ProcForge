import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { savePairing, getPairing, loadPairings } from "./pairings.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "../../test/tmp-hooks.js";

// M9-tmp2: tmp 정리는 등록 역순으로 가장 나중에 돈다.
useTmpCleanup();


// M7-1: 짝짓기 latest-wins + 이력.

describe("pairings", () => {
  let pfdir: string;
  beforeEach(() => {
    pfdir = join(makeTmp("pf-pair-"), ".procforge");
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
