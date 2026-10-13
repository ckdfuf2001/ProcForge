import { describe, it, expect } from "vitest";
import { resolveDateParams, formatDayUTC, formatDayLocal } from "./date-params.js";

// M6-0: 시계 주입으로 경계 검증.

describe("date-params", () => {
  // 2026-10-14T00:30:00Z: UTC는 14일, KST(+9) 로컬은 14일 09:30.
  const NOW = new Date("2026-10-14T00:30:00Z");
  it("UTC/로컬/어제", () => {
    expect(formatDayUTC(NOW)).toBe("2026-10-14");
    const r = resolveDateParams({ a: "@today:utc", b: "@today:local", c: "@yesterday:utc", d: "x" }, NOW);
    expect(r.params).toEqual({ a: "2026-10-14", b: formatDayLocal(NOW), c: "2026-10-13", d: "x" });
    expect(r.resolved).toEqual({ a: "2026-10-14", b: formatDayLocal(NOW), c: "2026-10-13" });
  });
  it("자정 경계: UTC 00:30에 어제는 13일", () => {
    const r = resolveDateParams({ c: "@yesterday:utc" }, new Date("2026-10-14T00:00:01Z"));
    expect(r.params.c).toBe("2026-10-13");
  });
  it("@ 아닌 값은 그대로", () => {
    const r = resolveDateParams({ d: "2026-10-13", e: "@unknown" }, NOW);
    expect(r.params).toEqual({ d: "2026-10-13", e: "@unknown" });
    expect(r.resolved).toEqual({});
  });
});
