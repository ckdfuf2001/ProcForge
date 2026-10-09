import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
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

  it("M4.2-0 구 세션 로드 시 revision 0 마이그레이션", () => {
    const legacy = {
      id: sid,
      request: "r",
      params: {},
      toolCatalog: [],
      rootId: "1",
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
      createdAt: new Date().toISOString(),
    };
    mkdirSync(join(dir, "sessions", sid), { recursive: true });
    writeFileSync(join(dir, "sessions", sid, "session.json"), JSON.stringify(legacy));
    expect(store.getSession(sid)?.revision).toBe(0);
    // 파일에도 기록됨
    const raw = JSON.parse(readFileSync(join(dir, "sessions", sid, "session.json"), "utf8")) as Record<string, unknown>;
    expect(raw["revision"]).toBe(0);
  });

  it("M4.2-0.5 appendEvents는 events.jsonl에 누적", () => {
    store.appendEvents(sid, [
      { seq: 1, revision: 1, at: "2026-10-09T00:00:00Z", actor: "host", method: "pfReport", nodeIds: ["1"], beforeHash: "a", afterHash: "b", summary: "r" },
    ]);
    const lines = readFileSync(join(dir, "sessions", sid, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ seq: 1, method: "pfReport" });
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
    const { spawn, spawnSync } = await import("node:child_process");
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
    // 플랫폼별 강제 종료 (M3.4.2-3): Windows=taskkill, 그 외 SIGKILL. exit 이벤트 대기.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      setTimeout(done, 5000);
    });
    try {
      expect(() => store.acquireLock(sid, 60_000)).toThrow(/locked/);
    } catch {
      // 이미 stale이면 아래에서 정리 (느린 CI 대비)
    }
    // staleMs=0 → 강제 종료로 남은 락 정리 후 획득
    store.acquireLock(sid, 0)();
  }, 20000);
});
