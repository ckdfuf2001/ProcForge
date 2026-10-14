import { describe, it, expect } from "vitest";
import { inspectEgress, guardEgress } from "./egress.js";

// M6.1-1 (R8): 전송 감사 규칙 단위 테스트.

describe("egress", () => {
  it("절대경로 차단 (URL·산문·정의 입력 제외)", () => {
    const bad = inspectEgress("pfResolve", {
      argSpecs: { p: { kind: "fixed", value: "C:\\x\\y" } },
    });
    expect(bad.violations.length).toBeGreaterThan(0);
    const posix = inspectEgress("pfResolve", {
      argSpecs: { p: { kind: "fixed", value: "/etc/passwd" } },
    });
    expect(posix.violations.length).toBeGreaterThan(0);
    const url = inspectEgress("pfResolve", {
      argSpecs: { u: { kind: "fixed", value: "https://a.com/x" } },
    });
    expect(url.violations).toEqual([]);
    const prose = inspectEgress("pfAdvise", { text: "C:\\에 저장해줘" });
    expect(prose.violations).toEqual([]);
    const rel = inspectEgress("pfResolve", {
      argSpecs: { p: { kind: "fixed", value: "output/x.csv" } },
    });
    expect(rel.violations).toEqual([]);
    // 정의 입력(params/args)은 절대경로 허용 (--param 정상 사용).
    const params = inspectEgress("pfStart", {
      request: "r",
      params: { feed: "D:\\data\\feed.json" },
    });
    expect(params.violations).toEqual([]);
    const args = inspectEgress("pfReport", { args: { path: "/tmp/x.json" } });
    expect(args.violations).toEqual([]);
  });

  it("resultJson 실데이터: pfReport 포함 전부 차단 (메타만 허용)", () => {
    const data = { raw: [1] };
    const other = inspectEgress("pfNext", { resultJson: data });
    expect(other.violations.length).toBeGreaterThan(0);
    const rep = inspectEgress("pfReport", { resultJson: data });
    expect(rep.violations.length).toBeGreaterThan(0);
    const meta = { sha256: "a".repeat(64), size: 3, preview: "{}" };
    const m = inspectEgress("pfNext", { resultJson: meta });
    expect(m.violations).toEqual([]);
    const m2 = inspectEgress("pfReport", { resultJson: meta });
    expect(m2.violations).toEqual([]);
  });

  it("토큰·이메일 교정 (정의 입력 포함, 예외 없음)", () => {
    const t = inspectEgress("pfAdvise", {
      text: "key sk-abcdefghijklmnopqrstuvwx please",
    });
    expect(t.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(t.body)).not.toContain("sk-abcdef");
    const e = inspectEgress("pfAdvise", { text: "mail me at a@b.com" });
    expect(e.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(e.body)).toContain("***");
    // params/args도 교정 (원문 유지하되 민감값만).
    const d = inspectEgress("pfReport", {
      args: { key: "sk-abcdefghijklmnopqrstuvwx" },
    });
    expect(JSON.stringify(d.body)).not.toContain("sk-abcdef");
    expect(d.violations).toEqual([]);
  });

  it("resultSummary·rubricReasons 4KB 상한+교정", () => {
    const big = "x".repeat(5000);
    const s = inspectEgress("pfReport", { resultSummary: big });
    expect(s.violations).toEqual([]);
    expect((s.body as { resultSummary: string }).resultSummary.length).toBe(
      4096,
    );
    const r = inspectEgress("pfReport", {
      resultSummary: "ok",
      rubricReasons: { c1: "y".repeat(5000), c2: "a@b.com" },
    });
    const rb = (r.body as { rubricReasons: Record<string, string> })
      .rubricReasons;
    expect(rb.c1.length).toBe(4096);
    expect(rb.c2).toBe("***");
    expect(r.violations).toEqual([]);
  });

  it("위반이면 전송 차단", () => {
    expect(() =>
      guardEgress("pfResolve", {
        argSpecs: { p: { kind: "fixed", value: "/x" } },
      }),
    ).toThrow(/egress 위반/);
    expect(() => guardEgress("pfReport", { resultJson: { raw: 1 } })).toThrow(
      /egress 위반/,
    );
    const ok = guardEgress("pfResolve", {
      argSpecs: { p: { kind: "fixed", value: "x" } },
    });
    expect(ok.redactions).toBe(0);
  });
});
