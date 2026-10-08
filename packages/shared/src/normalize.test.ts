import { describe, it, expect } from "vitest";
import { normalizeOutputText, compareNormalized } from "../src/normalize.js";

describe("normalize", () => {
  it("RUNFS/UUID/TIME 플레이스홀더", () => {
    const out = normalizeOutputText(
      "wrote /tmp/x/runs/r1/fs/a.txt at 2026-10-08T12:00:00Z id 123e4567-e89b-42d3-a456-426614174000",
      "/tmp/x/runs/r1/fs",
    );
    expect(out).toBe("wrote {RUNFS}/a.txt at {TIME} id {UUID}");
  });

  it("JSON 구조 비교 + ignore 경로", () => {
    const e = JSON.stringify({ output: "a", rev: "r1", n: 1 });
    const a = JSON.stringify({ output: "a", rev: "r2", n: 1 });
    expect(compareNormalized(e, a, ["rev"]).equal).toBe(true);
    const d = compareNormalized(e, a, []);
    expect(d.equal).toBe(false);
    if (!d.equal) expect(d.path).toBe("rev");
    // 시각 차이는 정규화로 흡수
    const t1 = JSON.stringify({ at: "2026-01-01T00:00:00Z" });
    const t2 = JSON.stringify({ at: "2026-05-05T00:00:00Z" });
    expect(compareNormalized(t1, t2, []).equal).toBe(true);
  });

  it("diff는 첫 불일치 경로 + 200자 excerpt", () => {
    const e = JSON.stringify({ slides: ["a", "b", "c"] });
    const a = JSON.stringify({ slides: ["a", "B", "c"] });
    const d = compareNormalized(e, a, []);
    expect(d.equal).toBe(false);
    if (!d.equal) {
      expect(d.path).toBe("slides[1]");
      expect(d.actualExcerpt.length).toBeLessThanOrEqual(400);
    }
  });

  it("텍스트 비교", () => {
    expect(compareNormalized("hello", "hello").equal).toBe(true);
    const d = compareNormalized("hello world", "hello WORLD");
    expect(d.equal).toBe(false);
    if (!d.equal) expect(d.path).toBe("(char 6)");
  });
});
