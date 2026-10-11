import { describe, it, expect } from "vitest";
import { normalizeCliPath, parseCliArgs } from "./cli-args.js";

// M5.5-4.2-4: approve 대상 판별 전 정규화 (win32 역슬래시 허용).

describe("normalizeCliPath", () => {
  it("역슬래시 → 슬래시", () => {
    expect(normalizeCliPath("procedures\\m55-unatt")).toBe("procedures/m55-unatt");
    expect(normalizeCliPath("procedures/m55-unatt")).toBe("procedures/m55-unatt");
    expect(normalizeCliPath(undefined)).toBe("");
    expect(normalizeCliPath("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("판별식과 결합: 역슬래시 절차서 ref 감지", () => {
    const t = normalizeCliPath("procedures\\daily-crawl");
    expect(t.startsWith("procedures/")).toBe(true);
  });

  it("--allow-wildcard 다중 파싱", () => {
    const { values } = parseCliArgs(["approve", "procedures/x", "--node", "1.1", "--allow-wildcard", "a", "--allow-wildcard", "b"]);
    expect(values.node).toBe("1.1");
    expect(values["allow-wildcard"]).toEqual(["a", "b"]);
  });
});
