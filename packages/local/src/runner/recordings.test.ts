import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeResponseForStore,
  restoreResponseForRun,
  loadCassette,
  saveRecording,
  fingerprintResponse,
  compareToolResponses,
} from "./recordings.js";
import { replacePathForms } from "./pathnorm.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pf-rec-"));
});

describe("recordings normalize/restore (M3.4-6/M3.4.1-2)", () => {
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

  it("JSON 이스케이프 형태도 정규화·복원", () => {
    const winFs = "C:\\w\\runs\\r1\\fs";
    const summary = JSON.stringify({ path: `${winFs}\\out.pptx` });
    expect(summary).toContain("\\\\");
    const stored = normalizeResponseForStore({ summary }, winFs);
    expect(stored.summary).toContain("{RUNFS}");
    expect(stored.summary).not.toContain("C:");
    const back = restoreResponseForRun(stored, "D:\\n\\runs\\r9\\fs");
    expect(back.summary).toContain("D:");
    expect(back.summary).toContain("out.pptx");
  });

  it("드라이브 대소문자 무시", () => {
    const out = replacePathForms("open c:\\w\\runs\\r1\\fs\\a", "C:\\w\\runs\\r1\\fs", "{RUNFS}");
    expect(out).toBe("open {RUNFS}\\a");
  });

  it("공백 포함 win32 경로 녹화→다른 runId replay 복원", () => {
    const fsA = "C:\\Users\\홍 길동\\p\\.procforge\\runs\\aaa\\fs";
    const fsB = "C:\\Users\\홍 길동\\p\\.procforge\\runs\\bbb\\fs";
    const resp = { summary: `saved ${fsA}\\out.pptx`, json: { p: `${fsA}/out.pptx` } };
    const stored = normalizeResponseForStore(resp, fsA);
    expect(stored.summary).not.toContain("홍 길동");
    const back = restoreResponseForRun(stored, fsB);
    expect(back.summary).toBe(`saved ${fsB}\\out.pptx`);
    expect((back.json as { p: string }).p).toBe(`${fsB}/out.pptx`);
  });

  it("v1 cassette는 로드 시 v2로 마이그레이션 저장", () => {
    const p = join(dir, "sessions", "s", "cassettes", "1.1.json");
    // 직접 기록 (v1 형식, version 없음)
    mkdirSync(join(dir, "sessions", "s", "cassettes"), { recursive: true });
    writeFileSync(p, JSON.stringify({ entries: [{ key: "k", server: "s", tool: "t", args: {}, response: { summary: "ok" }, at: "t" }] }));
    const entries = loadCassette(dir, "s", "1.1");
    expect(entries).toHaveLength(1);
    const saved = JSON.parse(readFileSync(p, "utf8")) as { version: number };
    expect(saved.version).toBe(2);
  });

  it("파싱 실패 → .corrupt 이동 + bad_request", () => {
    const cdir = join(dir, "sessions", "s2", "cassettes");
    mkdirSync(cdir, { recursive: true });
    const p = join(cdir, "9.9.json");
    writeFileSync(p, "{ broken json");
    try {
      loadCassette(dir, "s2", "9.9");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_request");
      expect((e as Error).message).toMatch(/cassette 손상/);
    }
    expect(existsSync(p)).toBe(false);
    const leftovers = readdirSync(cdir).filter((f) => f.startsWith("9.9.json.corrupt-"));
    expect(leftovers).toHaveLength(1);
  });

  it("saveRecording은 version 2 + runId/fsDir 기록", () => {    saveRecording(dir, "s3", "2.1", {
      key: "k", server: "sv", tool: "t", args: {}, response: { summary: "ok" }, at: "t",
    }, "/tmp/fs", "run-1");
    const saved = JSON.parse(readFileSync(join(dir, "sessions", "s3", "cassettes", "2.1.json"), "utf8")) as {
      version: number;
      entries: { runId: string; fsDir: string }[];
    };
    expect(saved.version).toBe(2);
    expect(saved.entries[0].runId).toBe("run-1");
    expect(saved.entries[0].fsDir).toBe("/tmp/fs");
  });
});

describe("M3.5.1-2 도구 응답 비교", () => {
  it("동일 응답은 equal", () => {
    const base = { summary: "out", json: { ok: true, n: 1 } };
    expect(compareToolResponses(base, { summary: "out", json: { ok: true, n: 1 } }).equal).toBe(true);
  });

  it("json 변경은 drift", () => {
    const d = compareToolResponses({ summary: "out", json: { ok: true } }, { summary: "out", json: { ok: false } });
    expect(d.equal).toBe(false);
  });

  it("params 값 차이는 마스킹되어 equal", () => {
    const d = compareToolResponses(
      { summary: "report-2026-09", json: undefined },
      { summary: "report-2026-10", json: undefined },
      { params: { month: "2026-10" } },
    );
    // expected 원문 vs actual 복원 — 값 자체가 다르면 drift
    expect(d.equal).toBe(false);
    const rebound = compareToolResponses(
      { summary: "report-2026-09", json: undefined },
      { summary: "report-2026-10", json: undefined },
      { params: { month: "2026-10" }, expectedParams: { month: "2026-09" } },
    );
    expect(rebound.equal).toBe(true);
  });

  it("바이너리는 sha/size 지문으로만 비교 (원문 유출 없음)", () => {
    expect(fingerprintResponse("plain")).toBe("plain");
    expect(fingerprintResponse("ab\0cd")).toMatch(/^bin:[0-9a-f]{64}:5$/);
    const same = compareToolResponses({ summary: "a\0b" }, { summary: "a\0b" });
    expect(same.equal).toBe(true);
    const diff = compareToolResponses({ summary: "a\0b" }, { summary: "a\0c" });
    expect(diff.equal).toBe(false);
    if (!diff.equal) {
      expect(diff.actualExcerpt).not.toContain("\0");
      expect(diff.actualExcerpt).toMatch(/bin:[0-9a-f]{64}:\d+/);
    }
  });
});
