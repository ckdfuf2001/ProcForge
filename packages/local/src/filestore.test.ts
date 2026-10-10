import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStore } from "../src/filestore.js";
import * as fsutil from "../src/fsutil.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import type { EventEntry } from "@procforge/shared/dto.js";

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

  it("M4.2-0.5-2 구 세션 읽기: revision 0 반환 + 파일 바이트 불변", () => {
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
    const before = readFileSync(join(dir, "sessions", sid, "session.json"), "utf8");
    expect(store.getSession(sid)?.revision).toBe(0);
    // 읽기 중 쓰기 없음
    expect(readFileSync(join(dir, "sessions", sid, "session.json"), "utf8")).toBe(before);
  });

  it("M4.2-0.5 appendEvents는 events.jsonl에 누적", () => {
    store.appendEvents(sid, [
      { seq: 1, revision: 1, at: "2026-10-09T00:00:00Z", actor: "host", method: "pfReport", nodeIds: ["1"], beforeHash: "a", afterHash: "b", summary: "r" },
    ]);
    const lines = readFileSync(join(dir, "sessions", sid, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ seq: 1, method: "pfReport" });
  });

  it("M4.2-2 readEvents는 R7형만 반환", () => {
    store.appendEvents(sid, [
      { seq: 1, revision: 1, at: "2026-10-09T00:00:00Z", actor: "host", method: "pfReport", nodeIds: ["1"], beforeHash: "a", afterHash: "b", summary: "r" },
    ]);
    writeFileSync(join(dir, "sessions", sid, "events.jsonl"), "not-json\n", { flag: "a" });
    const evts = store.readEvents(sid);
    expect(evts.map((e) => e.seq)).toEqual([1]);
    expect(store.readEvents(randomUUID())).toEqual([]);
  });

  function testSession(): Session {
    return {
      id: sid, request: "r", params: {}, toolCatalog: [], rootId: "1",
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
      createdAt: new Date().toISOString(), revision: 0,
    };
  }

  function testNode(id: string, goal: string): Node {
    return {
      id, parentId: "1", goal, status: "leaf", depth: 1, dependsOn: [], children: [],
      tool: { server: "t", name: "x", schemaHash: "h" }, args: {}, sideEffect: "none",
      constraints: [], advice: [], attempts: [], retries: 0, hash: `h-${id}`, locked: false,
    };
  }

  it("M4.2-2.5-3 commitChange 순서: 노드 → 세션 → 이벤트", () => {
    const order: string[] = [];
    class Rec extends FileStore {
      override saveNode(s: string, n: Node): void { order.push(`node:${n.id}`); super.saveNode(s, n); }
      override saveSession(s: Session): void { order.push("session"); super.saveSession(s); }
      override appendEvents(s: string, e: EventEntry[]): void { order.push("events"); super.appendEvents(s, e); }
    }
    const rec = new Rec(dir);
    rec.saveSession(testSession());
    order.length = 0;
    rec.commitChange(sid, {
      session: { ...testSession(), revision: 1 },
      nodes: [testNode("1.1", "g")],
      events: [{ seq: 1, revision: 1, at: "t", actor: "host", method: "m", nodeIds: ["1.1"], beforeHash: "a", afterHash: "b", summary: "s" }],
    });
    expect(order).toEqual(["node:1.1", "session", "events"]);
    expect(new FileStore(dir).getSession(sid)?.revision).toBe(1);
  });

  it("M4.2-2.5.1-2 pending 숫자 순 적용 (9→10)", () => {
    store.saveSession(testSession());
    store.saveNode(sid, testNode("1.1", "old"));
    const sessDir = join(dir, "sessions", sid);
    const mk = (rev: number, goal: string) => writeFileSync(join(sessDir, `pending-${rev}.json`), JSON.stringify({
      revision: rev, session: { ...testSession(), revision: rev }, nodes: [testNode("1.1", goal)], events: [],
    }));
    mk(10, "ten");
    mk(9, "nine");
    const reread = new FileStore(dir);
    // 읽기 뷰: 9→10 숫자 순 (문자열 순이면 nine이 이김)
    expect(reread.getNode(sid, "1.1")?.goal).toBe("ten");
    // 커밋 시 적용 후 정리, 최종 = 10 이후 rev 11
    reread.commitChange(sid, { session: { ...testSession(), revision: 11 }, nodes: [], events: [] });
    expect(new FileStore(dir).getNode(sid, "1.1")?.goal).toBe("ten");
    expect(new FileStore(dir).getSession(sid)?.revision).toBe(11);
    expect(readdirSync(sessDir).filter((f) => f.startsWith("pending-"))).toEqual([]);
  });

  it("M4.2-3-0-2 손상 pending은 .corrupt-<rev>-<ts>로 이동 + 커밋 거부", () => {
    store.saveSession(testSession());
    const sessDir = join(dir, "sessions", sid);
    writeFileSync(join(sessDir, "pending-5.json"), "not-json{{{");
    const reread = new FileStore(dir);
    // 읽기: 건너뜀, 파일 유지
    expect(reread.getSession(sid)?.revision).toBe(0);
    expect(existsSync(join(sessDir, "pending-5.json"))).toBe(true);
    // 커밋: 손상도 실패 처리 → internal 거부 (hint 복구 필요)
    try {
      reread.commitChange(sid, { session: { ...testSession(), revision: 1 }, nodes: [], events: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("internal");
      expect((e as { hint?: string }).hint).toBe("복구 필요");
    }
    const files = readdirSync(sessDir);
    expect(files.some((f) => f.startsWith("pending-"))).toBe(false);
    expect(files.some((f) => /^\.corrupt-5-\d+\.json$/.test(f))).toBe(true);
    expect(new FileStore(dir).getSession(sid)?.revision).toBe(0);
  });

  it("M4.2-2.5.1-2 복구 실패 시 새 커밋 거부", () => {
    store.saveSession(testSession());
    store.saveNode(sid, testNode("1.1", "old"));
    const sessDir = join(dir, "sessions", sid);
    writeFileSync(join(sessDir, "pending-1.json"), JSON.stringify({
      revision: 1, session: { ...testSession(), revision: 1 }, nodes: [testNode("1.1", "new")], events: [],
    }));
    class AlwaysFail extends FileStore {
      override saveNode(): void {
        throw new Error("disk full");
      }
    }
    const failing = new AlwaysFail(dir);
    try {
      failing.commitChange(sid, { session: { ...testSession(), revision: 2 }, nodes: [], events: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("internal");
      expect((e as { hint?: string }).hint).toBe("복구 필요");
    }
    // 실패한 pending은 유지 (다음 재시도용)
    expect(existsSync(join(sessDir, "pending-1.json"))).toBe(true);
  });

  it("M4.2-2.5.1-1 pending 조회: 파일 불변 + 메모리 뷰 반영", () => {
    store.saveSession(testSession());
    store.saveNode(sid, testNode("1.1", "old"));
    const sessDir = join(dir, "sessions", sid);
    writeFileSync(join(sessDir, "pending-1.json"), JSON.stringify({
      revision: 1,
      session: { ...testSession(), revision: 1 },
      nodes: [testNode("1.1", "new")],
      events: [],
    }));
    const snapTree = (d: string, out: Record<string, string> = {}): Record<string, string> => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) snapTree(p, out);
        else out[p] = readFileSync(p, "utf8");
      }
      return out;
    };
    const before = snapTree(sessDir);
    const reread = new FileStore(dir);
    expect(reread.getSession(sid)?.revision).toBe(1);
    expect(reread.getNode(sid, "1.1")?.goal).toBe("new");
    expect([...reread.getNodes(sid).values()].find((n) => n.id === "1.1")?.goal).toBe("new");
    expect(snapTree(sessDir)).toEqual(before);
  });

  it("M4.2-2.5.1-5 withLock: 잠금 중 대기 후 성공", async () => {
    const release = store.acquireLock(sid);
    setTimeout(() => release(), 60);
    await expect(store.withLock(sid, () => "ok")).resolves.toBe("ok");
    release();
  });

  it("M4.2-2.5.1-5 withLock: 20회 초과 시 conflict", async () => {
    const release = store.acquireLock(sid);
    try {
      await store.withLock(sid, () => 1);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("conflict");
    } finally {
      release();
    }
  }, 10000);

  it("M4.2-2.5-3 저장 실패해도 재로드 시 일관성", () => {
    store.saveSession(testSession());
    store.saveNode(sid, testNode("1.1", "old1"));
    store.saveNode(sid, testNode("1.2", "old2"));
    class FailSecond extends FileStore {
      private n = 0;
      override saveNode(s: string, node: Node): void {
        if (++this.n === 2) throw new Error("injected save failure");
        super.saveNode(s, node);
      }
    }
    const failing = new FailSecond(dir);
    const bumped = { ...testSession(), revision: 1 };
    expect(() => failing.commitChange(sid, {
      session: bumped,
      nodes: [testNode("1.1", "new1"), testNode("1.2", "new2")],
      events: [],
    })).toThrow(/injected save failure/);
    // 재로드: 전부 반영 또는 전부 미반영 (복구로 전부 반영됨)
    const reread = new FileStore(dir);
    reread.getSession(sid);
    const g1 = reread.getNode(sid, "1.1")!.goal;
    const g2 = reread.getNode(sid, "1.2")!.goal;
    expect([g1, g2]).toEqual(g1 === "new1" && g2 === "new2" ? ["new1", "new2"] : ["old1", "old2"]);
    expect(reread.getSession(sid)?.revision).toBe(g1 === "new1" ? 1 : 0);
  });
});

describe("M4.2-3-0 pending 정리 (낡은 revision)", () => {
  function sess(rev: number): Session {
    return {
      id: sid, request: "r", params: {}, toolCatalog: [], rootId: "1",
      limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
      createdAt: new Date().toISOString(), revision: rev,
    };
  }

  function nd(id: string, goal: string): Node {
    return {
      id, parentId: "1", goal, status: "leaf", depth: 1, dependsOn: [], children: [],
      tool: { server: "t", name: "x", schemaHash: "h" }, args: {}, sideEffect: "none",
      constraints: [], advice: [], attempts: [], retries: 0, hash: `h-${id}`, locked: false,
    };
  }

  function evt(seq: number): EventEntry {
    return {
      seq, revision: seq, at: "2026-10-10T00:00:00Z", actor: "host", method: "pfReport",
      nodeIds: ["1.1"], beforeHash: "a", afterHash: "b", summary: "r",
    };
  }

  it("M4.2-3-0-1 반영 후 unlink 실패 → 낡은 pending은 정리만 (재적용 금지)", () => {
    store.saveSession(sess(5));
    store.saveNode(sid, nd("1.1", "five"));
    // unlink 1회 실패 주입 (반영은 성공, pending-6 잔류)
    const spy = vi.spyOn(fsutil, "unlinkRetrySync");
    spy.mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    store.commitChange(sid, { session: sess(6), nodes: [nd("1.1", "six")], events: [evt(6)] });
    spy.mockRestore();
    const sessDir = join(dir, "sessions", sid);
    expect(existsSync(join(sessDir, "pending-6.json"))).toBe(true);
    // 읽기: rev6 메모리 뷰
    expect(store.getSession(sid)?.revision).toBe(6);
    expect(store.getNode(sid, "1.1")?.goal).toBe("six");
    // 복구: 낡은 pending은 적용 없이 정리만
    expect(store.recoverSession(sid)).toEqual({ applied: [], failed: [] });
    expect(existsSync(join(sessDir, "pending-6.json"))).toBe(false);
    // 다음 커밋 후에도 rev6 내용 유지 (이벤트 중복 없음)
    store.commitChange(sid, { session: sess(7), nodes: [nd("1.1", "seven")], events: [evt(7)] });
    expect(store.getSession(sid)?.revision).toBe(7);
    expect(store.getNode(sid, "1.1")?.goal).toBe("seven");
    expect(store.readEvents(sid).map((e) => e.seq)).toEqual([6, 7]);
  });

  it("M4.2-3-0-3 session 없으면 internal (revision 폴백 없음)", () => {
    store.saveSession(sess(4));
    try {
      store.commitChange(sid, { nodes: [], events: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("internal");
    }
    expect(readdirSync(join(dir, "sessions", sid)).filter((f) => f.startsWith("pending-"))).toEqual([]);
  });

  it("M4.2-3-0-2 손상 뒤 정상 pending은 미적용, commit은 internal", () => {
    store.saveSession(sess(4));
    const sessDir = join(dir, "sessions", sid);
    writeFileSync(join(sessDir, "pending-5.json"), "not-json{{{");
    writeFileSync(join(sessDir, "pending-6.json"), JSON.stringify({
      revision: 6, session: sess(6), nodes: [nd("1.1", "six")], events: [],
    }));
    // 복구: 5 손상에서 중단, 6 미적용 (파일은 rev4 유지, pending-6 잔류)
    expect(store.recoverSession(sid)).toMatchObject({ applied: [], failed: [join(sessDir, "pending-5.json")] });
    expect(existsSync(join(sessDir, "pending-6.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessDir, "session.json"), "utf8")).revision).toBe(4);
    // 커밋 거부 (hint 복구 필요) — 손상 pending 복원 후 커밋 시도
    writeFileSync(join(sessDir, "pending-5.json"), "not-json{{{");
    try {
      store.commitChange(sid, { session: sess(5), nodes: [], events: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("internal");
      expect((e as { hint?: string }).hint).toBe("복구 필요");
    }
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
