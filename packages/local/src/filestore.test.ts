import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStore } from "../src/filestore.js";

let dir: string;
let store: FileStore;
let sid: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pf-fs-"));
  store = new FileStore(dir);
  sid = randomUUID();
});

describe("FileStore ID 이중 검증 (M2.6-2)", () => {
  it("'../' 노드 id 거부", () => {
    expect(() => store.getNode(sid, "../../x")).toThrow(/bad node id/);
    expect(() => store.getNode("not-a-uuid", "1")).toThrow(/bad session id/);
    expect(() => store.getNodes("../escape")).toThrow();
  });
});

describe("세션 lockfile (M2.6-7)", () => {
  it("acquire → release 왕복", () => {
    const release = store.acquireLock(sid);
    expect(existsSync(join(dir, "sessions", sid, ".lock"))).toBe(true);
    expect(() => store.acquireLock(sid)).toThrow(/locked/);
    release();
    expect(existsSync(join(dir, "sessions", sid, ".lock"))).toBe(false);
    // 재획득 가능
    store.acquireLock(sid)();
  });

  it("오래된 잠금은 정리 후 획득", () => {
    const release = store.acquireLock(sid, 1);
    expect(() => store.acquireLock(sid, 60_000)).toThrow(/locked/);
    release();
    // staleMs=0이면 무조건 오래된 것으로 간주
    const r2 = store.acquireLock(sid, 0);
    r2();
  });

  it("외부 프로세스가 잡은 락은 conflict, 강제 종료 후 stale 정리", async () => {
    const { spawn } = await import("node:child_process");
    const holder = join(dir, "holder.mjs");
    const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "filestore.js");
    writeFileSync(
      holder,
      `import { pathToFileURL } from "node:url";
       const { FileStore } = await import(pathToFileURL(${JSON.stringify(distPath)}).href);
       const s = new FileStore(${JSON.stringify(dir)});
       const release = s.acquireLock(${JSON.stringify(sid)});
       setTimeout(() => release(), 3000);`,
    );
    const child = spawn(process.execPath, [holder], { stdio: "ignore" });
    // 자식 기동 대기: lock 파일 폴링 (최대 10초)
    const lockFile = join(dir, "sessions", sid, ".lock");
    const t0 = Date.now();
    while (!existsSync(lockFile) && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(lockFile), "child did not acquire lock").toBe(true);
    try {
      expect(() => store.acquireLock(sid, 60_000)).toThrow(/locked/);
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
    }
    // staleMs=0 → SIGKILL로 남은 락 정리 후 획득
    store.acquireLock(sid, 0)();
  }, 15000);
});
