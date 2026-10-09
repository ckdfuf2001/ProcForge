import { describe, it, expect } from "vitest";
import { normalizeResponseForStore, restoreResponseForRun } from "./recordings.js";

describe("recordings normalize/restore (M3.4-6)", () => {
  it("runFs 절대경로 왕복 (posix + windows)", () => {
    const fsDir = "/tmp/x/runs/r1/fs";
    const resp = { summary: `wrote ${fsDir}/a.txt`, json: { p: `${fsDir}/b.txt` } };
    const stored = normalizeResponseForStore(resp, fsDir);
    expect(stored.summary).toBe("wrote {RUNFS}/a.txt");
    expect((stored.json as { p: string }).p).toBe("{RUNFS}/b.txt");
    const back = restoreResponseForRun(stored, "/tmp/y/runs/r2/fs");
    expect(back.summary).toBe("wrote /tmp/y/runs/r2/fs/a.txt");

    const winFs = "C:\\t\\runs\\r1\\fs";
    const wresp = { summary: `wrote ${winFs}\\a.txt and ${winFs}/b.txt`, json: undefined };
    const wstored = normalizeResponseForStore(wresp, winFs);
    expect(wstored.summary).not.toContain("C:");
    const wback = restoreResponseForRun(wstored, "D:\\n\\runs\\r9\\fs");
    expect(wback.summary).toContain("D:\\n\\runs\\r9\\fs");
  });

  it("옛 runs/<id>/fs 패턴 마이그레이션", () => {
    const old = {
      summary: 'out /tmp/old/runs/abc123/fs/data.json and C:\\w\\runs\\z9\\fs\\x.txt',
      json: undefined,
    };
    const back = restoreResponseForRun(old, "/tmp/new/runs/r2/fs");
    expect(back.summary).toContain("/tmp/new/runs/r2/fs/data.json");
    expect(back.summary).toContain("/tmp/new/runs/r2/fs");
    expect(back.summary).not.toContain("abc123");
  });
});
