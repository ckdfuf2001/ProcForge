import { describe, it, expect } from "vitest";
import { inspectEgress, guardEgress } from "./egress.js";

// M6-4: 전송 감사 규칙 단위 테스트.

describe("egress", () => {
  it("절대경로 차단 (URL·산문 제외)", () => {
    const bad = inspectEgress("pfResolve", { argSpecs: { p: { kind: "fixed", value: "C:\\x\\y" } } });
    expect(bad.violations.length).toBeGreaterThan(0);
    const posix = inspectEgress("pfResolve", { argSpecs: { p: { kind: "fixed", value: "/etc/passwd" } } });
    expect(posix.violations.length).toBeGreaterThan(0);
    const url = inspectEgress("pfResolve", { argSpecs: { u: { kind: "fixed", value: "https://a.com/x" } } });
    expect(url.violations).toEqual([]);
    const prose = inspectEgress("pfAdvise", { text: "C:\\에 저장해줘" });
    expect(prose.violations).toEqual([]);
    const rel = inspectEgress("pfResolve", { argSpecs: { p: { kind: "fixed", value: "output/x.csv" } } });
    expect(rel.violations).toEqual([]);
  });

  it("resultJson 실데이터: pfReport만 허용", () => {
    const data = { raw: [1] };
    const other = inspectEgress("pfNext", { resultJson: data });
    expect(other.violations.length).toBeGreaterThan(0);
    const rep = inspectEgress("pfReport", { resultJson: data });
    expect(rep.violations).toEqual([]);
    const meta = { sha256: "a".repeat(64), size: 3, preview: "{}" };
    const m = inspectEgress("pfNext", { resultJson: meta });
    expect(m.violations).toEqual([]);
  });

  it("토큰·이메일 교정 (데이터·산문 규칙)", () => {
    const t = inspectEgress("pfAdvise", { text: "key sk-abcdefghijklmnopqrstuvwx please" });
    expect(t.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(t.body)).not.toContain("sk-abcdef");
    const e = inspectEgress("pfAdvise", { text: "mail me at a@b.com" });
    expect(e.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(e.body)).toContain("***");
    // resultJson 안의 이메일은 평가 무결성상 유지.
    const d = inspectEgress("pfReport", { resultJson: { mail: "a@b.com" } });
    expect(JSON.stringify(d.body)).toContain("a@b.com");
  });

  it("위반이면 전송 차단", () => {
    expect(() => guardEgress("pfResolve", { argSpecs: { p: { kind: "fixed", value: "/x" } } })).toThrow(/egress 위반/);
    const ok = guardEgress("pfResolve", { argSpecs: { p: { kind: "fixed", value: "x" } } });
    expect(ok.redactions).toBe(0);
  });
});
