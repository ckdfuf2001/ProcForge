import { EventEntrySchema } from "@procforge/shared/dto.js";
import { z } from "zod";

// M7-ui2: UI 서버 SSE (App.getEventsPage 폴러 1개를 구독자들에 나눠 준다).
// 이벤트는 core에서만 읽는다 (로컬 파일 tail 금지 — 원격 모드에서 서버에 있다).

export const SseEventSchema = z.object({
  revision: z.number().int().min(0),
  nodeIds: z.array(z.string()),
  method: z.string(),
  actor: z.string(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;

export type SseDeps = {
  /** core 이벤트 페이지 (CoreClient.getEventsPage) */
  fetchEvents: (input: {
    sessionId: string;
    afterRevision: number;
    limit: number;
  }) => Promise<{ events: z.infer<typeof EventEntrySchema>[]; lastRevision: number }>;
  /** 폴러 주기 (ms) */
  pollMs?: number;
  /** heartbeat 주석 주기 (ms) */
  heartbeatMs?: number;
};

type Sub = {
  id: number;
  write: (chunk: string) => void;
  close: () => void;
  lastSent: number;
};

const MAX_SUBS_PER_SESSION = 8;

export { MAX_SUBS_PER_SESSION };

export type SubHandle = { ok: true; id: number } | { ok: false; code: number; message: string };

export class SessionEventHub {
  private subs = new Map<string, Set<Sub>>();
  private cursors = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private nextId = 1;

  constructor(private deps: SseDeps) {}

  /** 구독 수 (테스트·정리 확인) */
  count(sid: string): number {
    return this.subs.get(sid)?.size ?? 0;
  }

  /** 상한 도달 여부 (헤더를 쓰기 전에 판정용) */
  atCapacity(sid: string): boolean {
    return (this.subs.get(sid)?.size ?? 0) >= MAX_SUBS_PER_SESSION;
  }

  /** sessionId별 폴러 1개. 구독자 0이면 정지. */
  subscribe(
    sid: string,
    startRevision: number,
    write: (chunk: string) => void,
    close: () => void,
  ): SubHandle {
    let set = this.subs.get(sid);
    if (!set) {
      set = new Set();
      this.subs.set(sid, set);
    }
    if (set.size >= MAX_SUBS_PER_SESSION) {
      return {
        ok: false,
        code: 429,
        message: `구독자 초과 (세션당 ${MAX_SUBS_PER_SESSION}명)`,
      };
    }
    const sub: Sub = { id: this.nextId++, write, close, lastSent: startRevision };
    set.add(sub);
    this.ensurePoller(sid);
    // 새 구독자용 즉시 1회 (놓친 이벤트 복회).
    void this.poll(sid);
    return { ok: true, id: sub.id };
  }

  unsubscribe(sid: string, id: number): void {
    const set = this.subs.get(sid);
    if (!set) return;
    for (const s of set) if (s.id === id) set.delete(s);
    if (set.size === 0) {
      this.subs.delete(sid);
      this.cursors.delete(sid);
      const t = this.timers.get(sid);
      if (t) clearInterval(t);
      this.timers.delete(sid);
    }
  }

  /** 테스트·종료용: 모든 폴러 정지 */
  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    for (const set of this.subs.values()) for (const s of set) s.close();
    this.subs.clear();
    this.cursors.clear();
  }

  /**
   * 폴러 1회. 가장 뒤처진 구독자 커서 뒤부터 읽고, 각 구독자는 자기
   * 커서보다 큰 이벤트만 받는다 (늦게 붙은 구독자도 복회받음).
   */
  async poll(sid: string): Promise<void> {
    const set = this.subs.get(sid);
    if (!set || set.size === 0) return;
    const after = Math.min(...[...set].map((s) => s.lastSent));
    try {
      const page = await this.deps.fetchEvents({
        sessionId: sid,
        afterRevision: after,
        limit: 200,
      });
      for (const e of page.events) {
        const payload: SseEvent = {
          revision: e.revision,
          nodeIds: e.nodeIds,
          method: e.method,
          actor: e.actor,
        };
        const chunk = `id: ${e.revision}\nevent: change\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const s of set) {
          if (e.revision <= s.lastSent) continue;
          s.lastSent = e.revision;
          s.write(chunk);
        }
      }
      this.cursors.set(sid, Math.max(page.lastRevision, after));
    } catch (e) {
      // M7-ui2-c: session_not_found 등 영구 오류는 종료 (재시도 무의미).
      // 일시 오류(네트워크·5xx)는 다음 주기에 재시도한다.
      const code = (e as { code?: unknown }).code;
      if (code === "session_not_found" || code === "not_found") {
        const msg =
          typeof e === "object" && e && "message" in e
            ? String((e as { message?: unknown }).message)
            : "세션 없음";
        for (const s of set) {
          s.write(
            `event: error\ndata: ${JSON.stringify({ code, message: msg })}\n\n`,
          );
          s.close();
        }
        const t = this.timers.get(sid);
        if (t) clearInterval(t);
        this.timers.delete(sid);
        this.subs.delete(sid);
        this.cursors.delete(sid);
      }
    }
  }

  private ensurePoller(sid: string): void {
    if (this.timers.has(sid)) return;
    const pollMs = this.deps.pollMs ?? 1000;
    const hbMs = this.deps.heartbeatMs ?? 15000;
    let lastBeat = Date.now();
    this.timers.set(
      sid,
      setInterval(() => {
        void this.poll(sid);
        const set = this.subs.get(sid);
        if (!set || set.size === 0) return;
        if (Date.now() - lastBeat >= hbMs) {
          lastBeat = Date.now();
          for (const s of set) s.write(": hb\n\n");
        }
      }, pollMs),
    );
    void this.poll(sid);
  }
}