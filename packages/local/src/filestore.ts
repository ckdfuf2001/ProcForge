import { mkdirSync, renameSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Store } from "@procforge/shared/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import { NodeSchema, SessionSchema } from "@procforge/shared/schema.js";
import { logger } from "./logger.js";

const WARN_BYTES = 1_000_000;

// NOTE: local 전용. core 패키지는 이 파일을 모른다. 합성은 core-inprocess.ts에서만.
export class FileStore implements Store {
  constructor(private root: string) {}

  private sessionDir(sid: string): string {
    return join(this.root, "sessions", sid);
  }

  private writeAtomic(path: string, data: string): void {
    if (data.length > WARN_BYTES) logger.warn(`large session file: ${path} (${data.length} bytes)`);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  // 동기 I/O + 싱글 스레드이므로 세션 단위 쓰기는 원자적.
  // (이벤트 루프 interleaving 없음. M6 멀티프로세스 시 파일락 필요 — DECISIONS 참조)

  getSession(id: string): Session | undefined {
    const p = join(this.sessionDir(id), "session.json");
    if (!existsSync(p)) return undefined;
    return SessionSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  }

  saveSession(s: Session): void {
    this.writeAtomic(join(this.sessionDir(s.id), "session.json"), JSON.stringify(s, null, 2));
  }

  getNodes(sessionId: string): Map<string, Node> {
    const dir = join(this.sessionDir(sessionId), "nodes");
    const out = new Map<string, Node>();
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const n = NodeSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      out.set(n.id, n);
    }
    return out;
  }

  getNode(sessionId: string, nodeId: string): Node | undefined {
    const p = join(this.sessionDir(sessionId), "nodes", `${nodeId}.json`);
    if (!existsSync(p)) return undefined;
    return NodeSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  }

  saveNode(sessionId: string, n: Node): void {
    this.writeAtomic(join(this.sessionDir(sessionId), "nodes", `${n.id}.json`), JSON.stringify(n, null, 2));
  }

  // ---- 세션 TTL용 메타 (M2.5-6, Store 인터페이스 외 local 확장) ----

  private metaPath(sid: string): string {
    return join(this.sessionDir(sid), "meta.json");
  }

  touch(sid: string): void {
    this.writeAtomic(this.metaPath(sid), JSON.stringify({ lastUsedAt: new Date().toISOString() }));
  }

  getLastUsed(sid: string): number | undefined {
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
