import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync, appendFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Store } from "@procforge/shared/store.js";
import type { CommitChange } from "@procforge/shared/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import { pfError } from "@procforge/shared/errors.js";
import type { EventEntry } from "@procforge/shared/dto.js";
import { EventEntrySchema } from "@procforge/shared/dto.js";
import { NodeIdSchema, NodeSchema, SessionIdSchema, SessionSchema } from "@procforge/shared/schema.js";
import { CommitChangeSchema } from "@procforge/shared/store.js";
import type { CommitChange } from "@procforge/shared/store.js";
import { logger } from "./logger.js";
import * as fsutil from "./fsutil.js";

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
    fsutil.writeAtomicFile(path, data);
  }

  // 동기 I/O + 싱글 스레드이므로 세션 단위 쓰기는 원자적.
  // (이벤트 루프 interleaving 없음. M6 멀티프로세스 시 파일락 필요 — DECISIONS 참조)

  getSession(id: string): Session | undefined {
    assertSessionId(id);
    const p = join(this.sessionDir(id), "session.json");
    if (!existsSync(p)) return undefined;
    // M4.2-0.5-2: 읽기는 순수 조회 (구 세션 revision 기본값은 파서가 적용).
    // M4.2-2.5.1-1: pending이 있으면 파일 쓰기 없이 메모리 뷰에 반영.
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    for (const change of this.readPendings(id)) {
      if (change.session) Object.assign(raw, change.session);
    }
    return SessionSchema.parse(raw);
  }

  saveSession(s: Session): void {
    assertSessionId(s.id);
    this.writeAtomic(join(this.sessionDir(s.id), "session.json"), JSON.stringify(s, null, 2));
  }

  getNodes(sessionId: string): Map<string, Node> {
    assertSessionId(sessionId);
    const dir = join(this.sessionDir(sessionId), "nodes");
    const out = new Map<string, Node>();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f === ".lock") continue;
        const n = NodeSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
        out.set(n.id, n);
      }
    }
    // M4.2-2.5.1-1: pending 반영 메모리 뷰 (쓰기 없음)
    for (const change of this.readPendings(sessionId)) {
      for (const n of change.nodes ?? []) out.set(n.id, n);
    }
    return out;
  }

  getNode(sessionId: string, nodeId: string): Node | undefined {
    assertSessionId(sessionId);
    assertNodeId(nodeId);
    const p = join(this.sessionDir(sessionId), "nodes", `${nodeId}.json`);
    let base: Node | undefined;
    if (existsSync(p)) base = NodeSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    // M4.2-2.5.1-1: pending 반영 메모리 뷰 (쓰기 없음)
    for (const change of this.readPendings(sessionId)) {
      const found = (change.nodes ?? []).find((n) => n.id === nodeId);
      if (found) base = found;
    }
    return base;
  }

  saveNode(sessionId: string, n: Node): void {
    assertSessionId(sessionId);
    assertNodeId(n.id);
    this.writeAtomic(join(this.sessionDir(sessionId), "nodes", `${n.id}.json`), JSON.stringify(n, null, 2));
  }

  /** 상태 이벤트 append (R6, 실패를 삼키지 않는다) */
  appendEvents(sessionId: string, events: EventEntry[]): void {
    assertSessionId(sessionId);
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** 상태 이벤트 조회 (R7 히스토리 원천, R7형만) */
  readEvents(sessionId: string): EventEntry[] {
    assertSessionId(sessionId);
    const out = this.readFileEvents(sessionId);
    // M4.2-2.5.1-1: pending 반영 메모리 뷰 (쓰기 없음, seq 중복 방지)
    const seen = new Set(out.map((e) => e.seq));
    for (const change of this.readPendings(sessionId)) {
      for (const e of change.events ?? []) {
        if (!seen.has(e.seq)) {
          seen.add(e.seq);
          out.push(e);
        }
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** events.jsonl 파일분만 읽기 (커밋 중복 제거 기준용) */
  private readFileEvents(sessionId: string): EventEntry[] {
    const p = join(this.sessionDir(sessionId), "events.jsonl");
    const out: EventEntry[] = [];
    if (!existsSync(p)) return out;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = EventEntrySchema.safeParse(JSON.parse(t));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // 손상 줄 무시
      }
    }
    return out;
  }

  private pendingFiles(sid: string): string[] {
    const dir = this.sessionDir(sid);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^pending-\d+\.json$/.test(f))
      .sort((a, b) => Number.parseInt(a.slice(8, -5), 10) - Number.parseInt(b.slice(8, -5), 10))
      .map((f) => join(dir, f));
  }

  /**
   * pending 파싱 (읽기 경로용, 쓰기 없음).
   * M4.2-3-0-1: zod 파싱 실패·낡은 revision(<= 파일 session.revision)은 제외.
   * 낡은 pending 정리는 recoverSession·commitChange 진입 시 수행.
   */
  private readPendings(sid: string): CommitChange[] {
    const out: CommitChange[] = [];
    const curRev = this.readSessionRaw(sid)?.revision;
    for (const f of this.pendingFiles(sid)) {
      try {
        const parsed = CommitChangeSchema.safeParse(JSON.parse(readFileSync(f, "utf8")));
        if (!parsed.success) continue;
        if (parsed.data.revision !== undefined && curRev !== undefined && parsed.data.revision <= curRev) continue;
        out.push(parsed.data);
      } catch {
        // 손상 pending은 읽기에서 건너뜀 (쓰기 경로에서 .corrupt로 이동)
      }
    }
    return out;
  }

  /**
   * 남은 pending 재반영 (M4.2-2.5-3, 2.5.1-2). 숫자 revision 순 적용.
   * M4.2-3-0-1: 낡은 revision(<= 파일 session.revision)은 적용 없이 정리만.
   * M4.2-3-0-2: 첫 실패·손상에서 중단, 손상도 failed (새 커밋 거부).
   * 손상 파일은 .corrupt-<rev>-<ts>로 이동 (삭제 금지). 삭제는 fsutil 재시도 사용.
   */
  recoverSession(sid: string): { applied: string[]; failed: string[] } {
    const applied: string[] = [];
    const failed: string[] = [];
    for (const f of this.pendingFiles(sid)) {
      const curRev = this.readSessionRaw(sid)?.revision;
      let change: CommitChange | undefined;
      try {
        const parsed = CommitChangeSchema.safeParse(JSON.parse(readFileSync(f, "utf8")));
        if (parsed.success) {
          if (parsed.data.revision !== undefined && curRev !== undefined && parsed.data.revision <= curRev) {
            try {
              fsutil.unlinkRetrySync(f);
            } catch {
              // 정리 실패 무시 (다음 진입 시 재시도)
            }
            continue;
          }
          change = parsed.data;
        }
      } catch {
        // 손상 pending은 아래에서 .corrupt로 이동
      }
      if (!change) {
        try {
          renameSync(f, join(this.sessionDir(sid), `.corrupt-${this.pendingRev(f)}-${Date.now()}.json`));
        } catch {
          // 무시
        }
        failed.push(f);
        break;
      }
      try {
        this.applyPending(sid, change);
        applied.push(f);
      } catch {
        failed.push(f);
        break;
      }
      try {
        fsutil.unlinkRetrySync(f);
      } catch {
        // 삭제 실패 무시 (다음 진입 시 재반영, 멱등)
      }
    }
    return { applied, failed };
  }

  /** pending-<rev>.json 파일명에서 rev 추출 (손상 파일명용, 실패 시 unknown) */
  private pendingRev(f: string): string {
    const m = /(?:^|[\\/])pending-(\d+)\.json$/.exec(f);
    return m ? m[1] : "unknown";
  }

  private applyPending(sid: string, c: CommitChange): void {
    for (const n of c.nodes ?? []) this.saveNode(sid, n);
    if (c.session) this.saveSession(c.session);
    // 파일 기준 중복 제거 (자기 pending은 미반영 취급)
    const fresh = (c.events ?? []).filter((e) => !this.readFileEvents(sid).some((x) => x.seq === e.seq));
    if (fresh.length > 0) this.appendEvents(sid, fresh);
  }

  /**
   * 원자 커밋 (M4.2-2.5-3): pending 원자 저장 → 노드 → 세션 → 이벤트 반영 →
   * pending 삭제. 시작 시 남은 pending부터 재반영.
   */
  commitChange(sid: string, c: CommitChange): void {
    assertSessionId(sid);
    // M4.2-2.5.1-2: 복구 실패 시 새 커밋 거부
    const rec = this.recoverSession(sid);
    if (rec.failed.length > 0) {
      throw pfError("internal", `복구 실패(${rec.failed.length}건), 수동 확인 필요`, "복구 필요");
    }
    const rev = c.session?.revision ?? this.readSessionRaw(sid)?.revision ?? 0;
    mkdirSync(this.sessionDir(sid), { recursive: true });
    this.writeAtomic(
      join(this.sessionDir(sid), `pending-${rev}.json`),
      JSON.stringify({ revision: rev, session: c.session ?? null, nodes: c.nodes ?? [], events: c.events ?? [] }),
    );
    this.applyPending(sid, c);
    try {
      fsutil.unlinkRetrySync(join(this.sessionDir(sid), `pending-${rev}.json`));
    } catch {
      // 삭제 실패 무시 (다음 진입 시 재반영, 멱등)
    }
  }

  private readSessionRaw(sid: string): Session | undefined {
    const p = join(this.sessionDir(sid), "session.json");
    if (!existsSync(p)) return undefined;
    return SessionSchema.parse(JSON.parse(readFileSync(p, "utf8")));
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

  // ---- 세션 TTL용 메타 (M2.5-6) ----

  private metaPath(sid: string): string {
    return join(this.sessionDir(sid), "meta.json");
  }

  touchSession(sid: string): void {
    assertSessionId(sid);
    this.writeAtomic(this.metaPath(sid), JSON.stringify({ lastUsedAt: new Date().toISOString() }));
  }

  /**
   * 세션 lockfile 안에서 실행 (M4.2-2.5, core change 트랜잭션용).
   * M4.2-2.5.1-5: 잠금 중이면 25ms 간격 최대 20회 재시도 후 conflict.
   */
  async withLock<T>(sid: string, fn: () => T | Promise<T>): Promise<T> {
    for (let i = 0; i < 20; i++) {
      let release: (() => void) | undefined;
      try {
        release = this.acquireLock(sid);
      } catch (e) {
        if ((e as { code?: string }).code !== "conflict" || i === 19) throw e;
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    }
    throw Object.assign(new Error(`session locked: ${sid}`), { code: "conflict" });
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
