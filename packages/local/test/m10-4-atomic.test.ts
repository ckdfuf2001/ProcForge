import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../src/services/procedureWriter.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-4-atomic-fix: rm 없는 rename 덮어쓰기 + 임시 잔재 0건.

describe("M10-atomic-fix", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmp("pf-atomic-");
  });

  it("기존 파일 덮어쓰기 후 tmp 잔재 없음", () => {
    const target = join(dir, "procedure.json");
    writeFileSync(target, JSON.stringify({ v: 1 }));
    writeFileAtomic(target, JSON.stringify({ v: 2 }));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 2 });
    // 같은 디렉터리에 tmp 잔재가 없다.
    const leftovers: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes(".tmp-")) leftovers.push(p);
      }
    };
    walk(dir);
    expect(leftovers).toEqual([]);
    // 없는 파일에도 그대로 쓴다 (부모 디렉터리는 호출자가 만든다).
    mkdirSync(join(dir, "sub"), { recursive: true });
    const fresh = join(dir, "sub", "new.json");
    writeFileAtomic(fresh, "{}");
    expect(readFileSync(fresh, "utf8")).toBe("{}");
  });
});
