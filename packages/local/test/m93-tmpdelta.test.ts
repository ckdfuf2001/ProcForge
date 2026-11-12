import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync, ExecFileSyncException } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-tmp-watch-fix2: TEMP_TOTAL 개수 delta == after - before.
// (L3에서 before=1913 after=1959 delta=1 이라는 보고가 있었으나,
//  통제 실험에서는 재현되지 않음 — 회귀 방지용.)

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "tmp-delta.mjs");

let root: string;
let tmp: string;

function run(args: string[]): { stdout: string; status: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      env: { ...process.env, TEMP: tmp, TMP: tmp },
      encoding: "utf8",
    });
    return { stdout: out, status: 0 };
  } catch (e) {
    const err = e as ExecFileSyncException & { stdout?: string; status?: number | null };
    return { stdout: typeof err.stdout === "string" ? err.stdout : "", status: err.status ?? 1 };
  }
}

beforeEach(() => {
  root = makeTmp("pf-m93td-");
  tmp = join(root, "t");
  mkdirSync(tmp, { recursive: true });
});

describe("M11-tmp-watch TEMP_TOTAL", () => {
  it("개수 delta가 after-before와 같다", () => {
    const snap = join(root, "s.json");
    let r = run(["snap", snap]);
    expect(r.status).toBe(0);
    writeFileSync(join(tmp, "a.txt"), "a", "utf8");
    writeFileSync(join(tmp, "b.txt"), "bb", "utf8");
    writeFileSync(join(tmp, "c.txt"), "ccc", "utf8");
    r = run(["diff", snap]);
    expect(r.status).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("TEMP_TOTAL "));
    expect(line).toBeDefined();
    const m = /^TEMP_TOTAL before=(\d+)\/\S+ after=(\d+)\/\S+ delta=(-?\d+)\/\S+$/.exec(line!.trim());
    expect(m).not.toBeNull();
    const [, before, after, delta] = m!;
    expect(Number(delta)).toBe(Number(after) - Number(before));
  });
});
