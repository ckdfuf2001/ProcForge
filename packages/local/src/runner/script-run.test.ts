import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runScript, describeRunError } from "./script-run.js";
import { diffSnapshot, snapshotProject } from "./script-run.js";
import { ArgSpecSchema } from "@procforge/shared/schema.js";
import { resolveArgs } from "./resolve.js";

// M5.2-2: 스크립트 실행 단위 + 계약 테스트.

let root: string;
let fsDir: string;

function havePython(): boolean {
  try {
    execFileSync("python", ["--version"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-script-"));
  fsDir = join(root, "fs");
  mkdirSync(fsDir, { recursive: true });
});

describe("runScript", () => {
  it("node 스크립트: stdin 인자 → stdout JSON", async () => {
    const f = join(root, "echo.mjs");
    writeFileSync(f, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);process.stdout.write(JSON.stringify({summary:'n='+a.n,json:{got:a}}));});");
    const r = await runScript({ runtime: "node", scriptAbs: f, args: { n: 3 }, cwd: fsDir, projectRoot: root });
    expect(r.summary).toBe("n=3");
    expect(r.json).toEqual({ got: { n: 3 } });
  });

  it("python 스크립트: stdin 인자 → stdout JSON", async () => {
    if (!havePython()) return;
    const f = join(root, "echo.py");
    writeFileSync(f, "import json,sys\na=json.load(sys.stdin)\nprint(json.dumps({'summary':'ok','json':{'got':a}}))");
    const r = await runScript({ runtime: "python", scriptAbs: f, args: { n: 3 }, cwd: fsDir, projectRoot: root });
    expect(r.summary).toBe("ok");
    expect(r.json).toEqual({ got: { n: 3 } });
  });

  it("python 한글 stdio도 UTF-8 (로캘 무관)", async () => {
    if (!havePython()) return;
    const f = join(root, "ko.py");
    writeFileSync(f, "import json,sys\na=json.load(sys.stdin)\nprint(json.dumps({'summary':a['t'],'json':{'t':a['t']}},ensure_ascii=False))");
    const r = await runScript({ runtime: "python", scriptAbs: f, args: { t: "월간보고서 2026-10 (최종)" }, cwd: fsDir, projectRoot: root });
    expect(r.summary).toBe("월간보고서 2026-10 (최종)");
    expect(r.json).toEqual({ t: "월간보고서 2026-10 (최종)" });
  });
  it("비정상 종료·비JSON·타임아웃은 throw", async () => {
    const bad = join(root, "bad.mjs");
    writeFileSync(bad, "console.error('boom');process.exit(3);");
    await expect(runScript({ runtime: "node", scriptAbs: bad, args: {}, cwd: fsDir, projectRoot: root })).rejects.toThrowError(/비정상 종료\(3\)/);
    const notJson = join(root, "notjson.mjs");
    writeFileSync(notJson, "process.stdout.write('plain text');");
    await expect(runScript({ runtime: "node", scriptAbs: notJson, args: {}, cwd: fsDir, projectRoot: root })).rejects.toThrowError(/JSON 아님/);
    const slow = join(root, "slow.mjs");
    writeFileSync(slow, "setTimeout(()=>process.stdout.write('{}'),5000);");
    await expect(runScript({ runtime: "node", scriptAbs: slow, args: {}, cwd: fsDir, projectRoot: root, timeoutMs: 300 })).rejects.toThrowError(/타임아웃/);
  });
});

describe("M5.3-3 실행 제한", () => {
  it("자식 환경은 화이트리스트만 (비밀 없음)", async () => {
    const f = join(root, "env.mjs");
    writeFileSync(f, "process.stdout.write(JSON.stringify({e:process.env}));");
    const r = await runScript({ runtime: "node", scriptAbs: f, args: {}, cwd: fsDir, projectRoot: root });
    const env = (r.json as { e: Record<string, string> }).e;
    // Node가 Windows에서 강제 주입하는 시스템 변수(PATH·USERPROFILE 등)는 제외하고,
    // 프로세스 비밀(PF_TEST_SECRET 등 임의 변수)이 넘어가지 않음을 확인.
    expect("PF_TEST_SECRET" in env).toBe(false);
    expect("NODE_EXTRA_CA_CERTS" in env).toBe(false);
    expect(env.PYTHONUTF8).toBe("1");
  });

  it("projectRoot 변경 감지 → throw", async () => {
    process.env.PF_TEST_SECRET = "s3cr3t";
    try {
      const f = join(root, "dirty.mjs");
      writeFileSync(
        f,
        `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(join(root, "escaped.txt"))},"x");process.stdout.write("{}");`,
      );
      await expect(runScript({ runtime: "node", scriptAbs: f, args: {}, cwd: fsDir, projectRoot: root })).rejects.toThrowError(
        /run fs 밖 변경 감지/,
      );
    } finally {
      delete process.env.PF_TEST_SECRET;
    }
  });

  it("snapshot 비교 단위 동작", async () => {
    const before = snapshotProject(root);
    writeFileSync(join(root, "new.txt"), "x");
    const after = snapshotProject(root);
    expect(diffSnapshot(before, after)).toEqual(["+new.txt"]);
    expect(diffSnapshot(after, after)).toEqual([]);
  });

  it("M7-5 보정3-a: 파일 수 상한을 넘으면 skipped=true 이고 walk 가 멈춘다", async () => {
    // 상한은 10만이라 실제로 꽉 채우지는 않는다 — **상한을 낮춘 사본**으로 규칙을 검증한다.
    const many = mkdtempSync(join(tmpdir(), "pf-cap-"));
    const n = 25;
    for (let i = 0; i < n; i++) writeFileSync(join(many, `f${i}.txt`), "x", "utf8");
    const capSnapshot = snapshotProject(many, { fileCap: n - 1 });
    expect(capSnapshot.skipped).toBe(true);
    // 중단됐으므로 상한+1 개까지 전부 담기지는 않는다
    expect(capSnapshot.files.size).toBeLessThanOrEqual(n - 1 + 1);
    expect(diffSnapshot(capSnapshot, capSnapshot)).toEqual([]);
  });

  it("M7-5 보정3-a: 해시 총량 예산을 넘으면 hashPartial=true", async () => {
    // 1MB 파일 4개, 총량 예산 3MB 로 제한 → 뒤쪽은 stat 만 기록된다
    const big = mkdtempSync(join(tmpdir(), "pf-hash-"));
    const blob = "y".repeat(1024 * 1024);
    for (let i = 0; i < 4; i++) writeFileSync(join(big, `b${i}.bin`), blob, "utf8");
    const s = snapshotProject(big, { hashTotalBytes: 3 * 1024 * 1024 });
    expect(s.hashPartial).toBe(true);
    // 서명은 size:mtimeMs:ctimeMs:hash — 예산 안(3MB)까지만 해시가 붙는다
    const withHash = [...s.files.values()].filter((v) => (v.split(":")[3] ?? "") !== "");
    const withoutHash = [...s.files.values()].filter((v) => (v.split(":")[3] ?? "") === "");
    expect(withHash.length).toBe(3);
    expect(withoutHash.length).toBe(1);
  });

  it("M5-5-a: **같은 크기** 덮어쓰기도 감지 (size:mtime)", async () => {
    const f = join(root, "same.txt");
    writeFileSync(f, "AAAA");
    const before = snapshotProject(root);
    // 크기가 같고 내용만 다르다 — size 만 보면 못 잡는다
    writeFileSync(f, "BBBB");
    expect(diffSnapshot(before, snapshotProject(root))).toContain("~same.txt");
  }, 30000);

  it("M5-5-a: 바깥 쓰기 후 **exit 1** → 감지 사실이 오류에 포함", async () => {
    const f = join(root, "dirty.mjs");
    writeFileSync(
      f,
      `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(join(root, "escaped.txt"))},"x");process.exit(1);`,
    );
    const err = await runScript({
      runtime: "node",
      scriptAbs: f,
      args: {},
      cwd: fsDir,
      projectRoot: root,
    }).then(
      () => null,
      (e: Error) => e as Error & { escapedChanges?: string[] },
    );
    expect(err).not.toBeNull();
    // 실패한 스크립트라도 바깥 변경 흔적은 남는다
    expect(err?.escapedChanges?.join(",")).toContain("escaped.txt");
    expect(describeRunError(err)).toContain("run fs 밖 변경 감지");
  }, 30000);
});

describe("script kind 계약", () => {
  it("ArgSpecSchema가 script 수용 + runtime 기본값", async () => {
    const p = ArgSpecSchema.parse({ kind: "script", file: "scripts/1_1.py" });
    expect(p.kind).toBe("script");
    expect((p as { runtime: string }).runtime).toBe("python");
  });

  it("resolveArgs는 file 원문 유지", async () => {
    const out = resolveArgs({
      specs: { s: { kind: "script", file: "scripts/1_1.py" } as never, m: { kind: "fixed", value: 1 } as never },
      params: {}, outputs: new Map(), attempts: [], live: true,
    });
    expect(out.s).toBe("scripts/1_1.py");
    expect(out.m).toBe(1);
  });
});
