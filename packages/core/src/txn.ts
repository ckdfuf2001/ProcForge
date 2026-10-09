import type { Store } from "@procforge/shared/store.js";
import type { EventEntry } from "@procforge/shared/dto.js";
import type { Node, Session } from "@procforge/shared/schema.js";

// R6 트랜잭션 오버레이 (M4.2-0.5). 메서드 호출 동안 쓰기를 버퍼링하고
// commit 시에만 base에 반영한다. 순서는 appendEvents → 상태 저장.
// NOTE: CoreService 메서드 본문은 await 없이 동기로 실행되므로 호출당
// 단일 tx 스코프가 안전하다. await를 넣기 전 이 가정을 재검토하라.
export class TxStore implements Store {
  private sessions = new Map<string, Session>();
  private nodes = new Map<string, Map<string, Node>>();
  private bufferedEvents: { sessionId: string; events: EventEntry[] }[] = [];
  private touchedSessions = new Set<string>();
  private touchedNodes = new Map<string, Set<string>>();

  constructor(private base: Store) {}

  getSession(id: string): Session | undefined {
    return this.sessions.get(id) ?? this.base.getSession(id);
  }

  saveSession(s: Session): void {
    this.sessions.set(s.id, s);
    this.touchedSessions.add(s.id);
  }

  getNodes(sessionId: string): Map<string, Node> {
    const over = this.nodes.get(sessionId);
    if (!over || over.size === 0) return this.base.getNodes(sessionId);
    return new Map([...this.base.getNodes(sessionId), ...over]);
  }

  getNode(sessionId: string, nodeId: string): Node | undefined {
    return this.nodes.get(sessionId)?.get(nodeId) ?? this.base.getNode(sessionId, nodeId);
  }

  saveNode(sessionId: string, n: Node): void {
    let m = this.nodes.get(sessionId);
    if (!m) {
      m = new Map();
      this.nodes.set(sessionId, m);
    }
    m.set(n.id, n);
    let s = this.touchedNodes.get(sessionId);
    if (!s) {
      s = new Set();
      this.touchedNodes.set(sessionId, s);
    }
    s.add(n.id);
  }

  /** 버퍼링만 한다. base에는 commit 시 전달 */
  appendEvents(sessionId: string, events: EventEntry[]): void {
    this.bufferedEvents.push({ sessionId, events: [...events] });
  }

  writtenNodeIds(sessionId: string): string[] {
    return [...(this.touchedNodes.get(sessionId) ?? [])];
  }

  sessionWritten(sessionId: string): boolean {
    return this.touchedSessions.has(sessionId);
  }

  hasWrites(): boolean {
    return this.touchedSessions.size > 0 || this.touchedNodes.size > 0 || this.bufferedEvents.length > 0;
  }

  /** R6 순서: 이벤트 기록 → 저장. append 실패 시 저장 생략 (부분 저장 금지) */
  commit(): void {
    for (const { sessionId, events } of this.bufferedEvents) this.base.appendEvents(sessionId, events);
    for (const [, s] of this.sessions) this.base.saveSession(s);
    for (const [sid, m] of this.nodes) for (const [, n] of m) this.base.saveNode(sid, n);
  }
}
