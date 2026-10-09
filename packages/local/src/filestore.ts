import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Store } from "@procforge/shared/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import { NodeIdSchema, NodeSchema, SessionIdSchema, SessionSchema } from "@procforge/shared/schema.js";
import { logger } from "./logger.js";
import { writeAtomicFile } from "./fsutil.js";

/** ID 이중 검증 (M2.6-2). 서버 zod에 더해 저장소 진입부에서도 검사. */
export function assertSessionId(sid: string): void {
  if (!SessionIdSchema.safeParse(sid).success) throw Object.assign(new Error(`bad session id: ${sid}`), { code: "bad_request" });
}

export function assertNodeId(nid: string): void {
  if (!NodeIdSchema.safeParse(nid).success) throw Object.assign(new Error(`bad node id: ${nid}`), { code: "bad_request" });
}

// NOTE: local 전용. core 패키지는 이 파일을 모른다. 합성은 core-inprocess.ts에서만.
export class FileStore implements Store {
  constructor(private root: string) {}

  private sessionDir(sid: string): string {
    return join(this.root, "sessions", sid);
  }

  private writeAtomic(path: string, data: string): void {
    writeAtomicFile(path, data);
  }

  // 동기 I/O + 싱글 스레드이므로 세션 단위 쓰기는 원자적.
  // (이벤트 루프 interleaving 없음. M6 멀티프로세스 시 파일락 필요 — DECISIONS 참조)

  getSession(id: string): Session | undefined {
    assertSessionId(id);
    const p = join(this.sessionDir(id), "session.json");
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const parsed = SessionSchema.parse(raw);
    if (typeof raw["revision"] !== "number") {
      // M4.2-0: 구 세션 로드 시 revision 0으로 마이그레이션
      try {
        this.writeAtomic(p, JSON.stringify({ ...raw, revision: 0 }, null, 2));
      } catch {
        // 마이그레이션 실패 무시 (읽기는 성공분 반환)
      }
    }
    return parsed;
  }

  saveSession(s: Session): void {
    assertSessionId(s.id);
    this.writeAtomic(join(this.sessionDir(s.id), "session.json"), JSON.stringify(s, null, 2));
  }

  getNodes(sessionId: string): Map<string, Node> {
    assertSessionId(sessionId);
    const dir = join(this.sessionDir(sessionId), "nodes");
    const out = new Map<string, Node>();
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === ".lock") continue;
      const n = NodeSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      out.set(n.id, n);
    }
    return out;
  }

  getNode(sessionId: string, nodeId: string): Node | undefined {
    assertSessionId(sessionId);
    assertNodeId(nodeId);
    const p = join(this.sessionDir(sessionId), "nodes", `${nodeId}.json`);
    if (!existsSync(p)) return undefined;
    return NodeSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  }

  saveNode(sessionId: string, n: Node): void {
    assertSessionId(sessionId);
    assertNodeId(n.id);
    this.writeAtomic(join(this.sessionDir(sessionId), "nodes", `${n.id}.json`), JSON.stringify(n, null, 2));
  }

  // ---- 세션 lockfile (M2.6-7, 프로세스 간 advisory lock) ----

  private lockPath(sid: string): string {
    return join(this.sessionDir(sid), ".lock");
  }

  /**
   * 락 획득. fresh 락이 있으면 conflict. 오래된 락(staleMs 경과)은 정리 후 획득.
   * release()를 반드시 호출. 동기는 유지하되 프로세스 간 보호용.
   */
  acquireLock(sid: string, staleMs = 30000): () => void {
    assertSessionId(sid);
    const p = this.lockPath(sid);
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p)) {
      let stale = true;
      try {
        const at = statSync(p).mtimeMs;
        stale = Date.now() - at > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) throw Object.assign(new Error(`session locked: ${sid}`), { code: "conflict" });
      try {
        unlinkSync(p);
      } catch {
        // 경합 시 상대가 이미 정리 — 계속 진행
      }
      logger.warn("stale session lock cleaned", { sessionId: sid });
    }
    writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(p);
      } catch {
        // 이미 없음 — 무시
      }
    };
  }

  // ---- 세션 TTL용 메타 (M2.5-6, Store 인터페이스 외 local 확장) ----

  private metaPath(sid: string): string {
    return join(this.sessionDir(sid), "meta.json");
  }

  touch(sid: string): void {
    assertSessionId(sid);
    this.writeAtomic(this.metaPath(sid), JSON.stringify({ lastUsedAt: new Date().toISOString() }));
  }

  getLastUsed(sid: string): number | undefined {
    assertSessionId(sid);
    const p = this.metaPath(sid);
    if (!existsSync(p)) return undefined;
    try {
      const t = Date.parse((JSON.parse(readFileSync(p, "utf8")) as { lastUsedAt: string }).lastUsedAt);
      return Number.isNaN(t) ? undefined : t;
    } catch {
      return undefined;
    }
  }
}
