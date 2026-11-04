import { describe, it, expect, beforeEach } from "vitest";
import {
  readEnvPair,
  resetEnvCompatWarnings,
  warnOnceEnv,
  stripProofEnvVars,
  bothNames,
} from "./env-compat.js";

// M9-1-1-a: PROOF_* 우선 + PROCFORGE_* 대체 (경고 1회).

function collector(): { msgs: string[]; warn: (m: string) => void } {
  const msgs: string[] = [];
  return { msgs, warn: (m: string) => void msgs.push(m) };
}

beforeEach(() => resetEnvCompatWarnings());

describe("readEnvPair", () => {
  it("PROOF_*만 있으면 경고 없이 신 값", () => {
    const c = collector();
    expect(
      readEnvPair({ PROOF_DIR: "/n", PROCFORGE_DIR: undefined }, "PROOF_DIR", "PROCFORGE_DIR", { warn: c.warn }),
    ).toBe("/n");
    expect(c.msgs).toEqual([]);
  });

  it("PROCFORGE_*만 있으면 옛 값 + 경고 1회", () => {
    const c = collector();
    const env = { PROCFORGE_DIR: "/o" };
    expect(readEnvPair(env, "PROOF_DIR", "PROCFORGE_DIR", { warn: c.warn })).toBe("/o");
    expect(c.msgs).toHaveLength(1);
    expect(c.msgs[0]).toContain("PROCFORGE_DIR");
    expect(c.msgs[0]).toContain("PROOF_DIR");
    // 1회 보장: 두 번째 호출은 경고 없음
    expect(readEnvPair(env, "PROOF_DIR", "PROCFORGE_DIR", { warn: c.warn })).toBe("/o");
    expect(c.msgs).toHaveLength(1);
  });

  it("둘 다 다르면 PROOF_* + 충돌 경고 (값 미포함)", () => {
    const c = collector();
    const out = readEnvPair(
      { PROOF_DIR: "/new", PROCFORGE_DIR: "/old" },
      "PROOF_DIR",
      "PROCFORGE_DIR",
      { warn: c.warn },
    );
    expect(out).toBe("/new");
    expect(c.msgs).toHaveLength(1);
    expect(c.msgs[0]).not.toContain("/new");
    expect(c.msgs[0]).not.toContain("/old");
  });

  it("경로 변수는 충돌 경고에 절대경로만", () => {
    const c = collector();
    readEnvPair(
      { PROOF_DIR: "rel", PROCFORGE_DIR: "other" },
      "PROOF_DIR",
      "PROCFORGE_DIR",
      { warn: c.warn, displayValue: "/abs/dir" },
    );
    expect(c.msgs).toHaveLength(1);
    expect(c.msgs[0]).toContain("/abs/dir");
    expect(c.msgs[0]).not.toContain("other");
  });

  it("비밀 변수는 경고에 키 값 없음", () => {
    const c = collector();
    readEnvPair(
      { PROOF_API_KEYS: "new-key", PROCFORGE_API_KEYS: "old-key" },
      "PROOF_API_KEYS",
      "PROCFORGE_API_KEYS",
      { warn: c.warn, secret: true },
    );
    expect(c.msgs).toHaveLength(1);
    expect(c.msgs[0]).not.toContain("new-key");
    expect(c.msgs[0]).not.toContain("old-key");
  });

  it("fail 정책: 불일치면 기동 오류 (값 미포함)", () => {
    const c = collector();
    expect(() =>
      readEnvPair(
        { PROOF_READ_ONLY: "1", PROCFORGE_READ_ONLY: "0" },
        "PROOF_READ_ONLY",
        "PROCFORGE_READ_ONLY",
        { warn: c.warn, onConflict: "fail" },
      ),
    ).toThrow(/PROOF_READ_ONLY.*PROCFORGE_READ_ONLY/);
    expect(() =>
      readEnvPair(
        { PROOF_READ_ONLY: "1", PROCFORGE_READ_ONLY: "0" },
        "PROOF_READ_ONLY",
        "PROCFORGE_READ_ONLY",
        { onConflict: "fail" },
      ),
    ).not.toThrow(/1/);
    expect(c.msgs).toEqual([]);
  });

  it("둘 다 같으면 경고 없이 신 값", () => {
    const c = collector();
    expect(
      readEnvPair({ PROOF_X: "v", PROCFORGE_X: "v" }, "PROOF_X", "PROCFORGE_X", { warn: c.warn }),
    ).toBe("v");
    expect(c.msgs).toEqual([]);
  });

  it("둘 다 없으면 undefined, 경고 없음", () => {
    const c = collector();
    expect(readEnvPair({}, "PROOF_X", "PROCFORGE_X", { warn: c.warn })).toBeUndefined();
    expect(c.msgs).toEqual([]);
  });
});

describe("warnOnceEnv", () => {
  it("같은 키는 1회, 리셋 후 다시", () => {
    const c = collector();
    warnOnceEnv("k", "m1", c.warn);
    warnOnceEnv("k", "m2", c.warn);
    expect(c.msgs).toEqual(["m1"]);
    resetEnvCompatWarnings();
    warnOnceEnv("k", "m3", c.warn);
    expect(c.msgs).toEqual(["m1", "m3"]);
  });
});

describe("stripProofEnvVars/bothNames", () => {
  it("두 접두어를 모두 지우고 확정값은 두 이름으로", () => {
    const env = stripProofEnvVars({
      PATH: "/bin",
      PROOF_DIR: "/evil",
      PROCFORGE_DIR: "/old",
      PROOF_READ_ONLY: "1",
      OTHER: "x",
    });
    expect(env).toEqual({ PATH: "/bin", OTHER: "x" });
    expect(bothNames("DIR", "/pf")).toEqual({
      PROOF_DIR: "/pf",
      PROCFORGE_DIR: "/pf",
    });
    const merged = { ...env, ...bothNames("DIR", "/pf") };
    expect(merged.PROOF_DIR).toBe("/pf");
    expect(merged.PROCFORGE_DIR).toBe("/pf");
    // 주입된 두 이름은 경고 없이 PROOF 값을 쓴다
    resetEnvCompatWarnings();
    const c = collector();
    expect(
      readEnvPair(merged, "PROOF_DIR", "PROCFORGE_DIR", { warn: c.warn }),
    ).toBe("/pf");
    expect(c.msgs).toEqual([]);
  });
});
